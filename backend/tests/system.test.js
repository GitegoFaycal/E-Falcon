// End-to-end tests: real database (SQLite in memory), real engine, real OCPP gateway, and a
// simulated charger connecting over a real WebSocket. Only the HTTP routes are not exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, wait, until } from './helpers.js';
import { limitSnapshot, currentDeployment } from '../src/shared/selectors.js';
import { verifyPassword } from '../src/core/secrets.js';

test('shared rule files are identical to the frontend copies', () => {
  for (const f of ['tariff', 'permissions', 'status', 'selectors', 'format']) {
    assert.equal(fs.readFileSync(new URL(`../src/shared/${f}.js`, import.meta.url), 'utf8'), fs.readFileSync(new URL(`../../frontend/src/lib/${f}.js`, import.meta.url), 'utf8'), `${f}.js differs: run npm run sync-shared`);
  }
});

test('gateway refuses unregistered identities, wrong keys and missing keys', async () => {
  const s = await boot({ requireAuth: true });
  try {
    assert.equal((await s.sim('NOT-REGISTERED', { expectRefusal: true })).refused, 404);
    assert.ok(s.state.alerts.some((a) => a.type === 'unknown_charger'));
    assert.equal((await s.sim('EF-SIM-001', { expectRefusal: true })).refused, 401, 'no key has been issued yet and auth is required');
    const { key } = await s.call('setChargerAuthKey', s.charger(0).id);
    assert.match(key, /^[A-HJ-NP-Za-km-z2-9]{24}$/, 'easy to type on a touchscreen');
    assert.equal((await s.sim('EF-SIM-001', { key: 'wrong', expectRefusal: true })).refused, 401);
    await s.sim('EF-SIM-001', { key });
    assert.equal(s.charger(0).online, true);
    assert.equal(s.core.snapshot(s.admin).chargers[0].authKeyHash, undefined, 'key hash never leaves the server');
    assert.equal(s.core.snapshot(s.admin).users[0].passwordHash, undefined);
  } finally { await s.close(); }
});

test('a charger boots, reports its connectors, and goes offline when the link drops', async () => {
  const s = await boot();
  try {
    assert.equal(s.conn(0, 1).enabled, false, 'state unknown before the charger reports it');
    const sim = await s.sim('EF-SIM-001');
    await until(() => s.conn(0, 2).status === 'Available');
    assert.equal(s.charger(0).online, true);
    assert.equal(s.charger(0).firmware, 'sim-1.0.0');
    assert.equal(s.charger(0).manufacturer, 'SimVendor');
    assert.equal(s.conn(0, 1).enabled, true, 'taken from the charger report');
    sim.drop();
    await until(() => !s.charger(0).online);
    assert.ok(s.state.alerts.some((a) => a.type === 'charger_offline' && a.status === 'open'));
    const { results } = await s.call('requestAvailability', { connectorIds: [s.conn(0, 1).id], action: 'restrict' });
    await until(() => s.cmd(results[0].commandId).status === 'failed');
    assert.equal(s.cmd(results[0].commandId).resultCode, 'offline');
    assert.equal(s.cmd(results[0].commandId).sentAt, null);
    assert.equal(s.conn(0, 1).enabled, true, 'nothing changes without a reply');
  } finally { await s.close(); }
});

test('ChangeAvailability round trip, and the operational limit', async () => {
  const s = await boot();
  try {
    await s.sim('EF-SIM-001'); await s.sim('EF-SIM-002'); await s.sim('EF-SIM-003');
    await until(() => limitSnapshot(s.state).enabled === 6);
    assert.equal(limitSnapshot(s.state).max, 5);
    assert.ok(s.state.alerts.some((a) => a.type === 'limit_violation' && a.status === 'open'), 'six physically operative connectors against a limit of five');

    const r = (await s.call('requestAvailability', { connectorIds: [s.conn(0, 1).id, s.conn(0, 2).id], action: 'restrict', reason: 'test' })).results;
    await until(() => r.every((x) => s.cmd(x.commandId).status === 'successful'));
    await until(() => s.conn(0, 1).status === 'Unavailable');
    assert.equal(s.conn(0, 1).enabled, false);
    assert.equal(limitSnapshot(s.state).enabled, 4);
    assert.ok(!s.state.alerts.some((a) => a.type === 'limit_violation' && a.status !== 'resolved'));

    const e = (await s.call('requestAvailability', { connectorIds: [s.conn(0, 1).id, s.conn(0, 2).id], action: 'enable' })).results;
    assert.deepEqual(e.map((x) => x.outcome), ['submitted', 'blocked_limit']);
    await until(() => s.conn(0, 1).enabled && s.conn(0, 1).status === 'Available');
    assert.equal((await s.call('requestAvailability', { connectorIds: [s.conn(0, 2).id], action: 'enable' })).results[0].outcome, 'blocked_limit');
    assert.equal(s.state.audit.filter((a) => a.action.startsWith('availability.')).length, 3);
  } finally { await s.close(); }
});

test('a session is metered and priced; restricting mid-session is scheduled, never a stop', async () => {
  const s = await boot();
  try {
    const sim = await s.sim('EF-SIM-001');
    const c = s.conn(0, 1);
    await sim.plug(1, 'TAG-1');
    const session = await until(() => s.state.sessions.find((x) => x.status === 'active'));
    await until(() => c.status === 'Charging');
    assert.equal(session.idTag, 'TAG-1');
    assert.equal(session.ruleName, 'Standard');
    sim.guns[0].meterWh += 20000; // 20 kWh delivered
    sim.guns[0].powerKw = 90;
    sim.sampleMeters();
    await until(() => session.energyKwh > 19.9);
    assert.ok(Math.abs(session.energyCost - session.energyKwh * session.priceAtStart) < 1, 'energy x tariff');
    assert.equal(c.powerKw, 90);

    const { results } = await s.call('requestAvailability', { connectorIds: [c.id], action: 'restrict', maintenance: true });
    await until(() => s.cmd(results[0].commandId).status === 'successful');
    assert.equal(s.cmd(results[0].commandId).response.status, 'Scheduled');
    assert.equal(session.status, 'active');
    assert.equal(c.enabled, true);
    assert.equal(c.pendingInoperative, true);

    await sim.unplug(1);
    await until(() => session.status === 'completed' && c.status === 'Unavailable');
    assert.equal(session.stopReason, 'EVDisconnected');
    assert.ok(session.cost > 0);
    assert.equal(c.enabled, false);
    assert.equal(c.maintenance, true);
    assert.equal(c.sessionId, null);
    await s.core.flush();
    const stored = await s.db.query('SELECT "status", "energy_kwh", "cost" FROM "charging_sessions" WHERE "id" = ?', [session.id]);
    assert.equal(stored[0].status, 'completed');
    assert.ok((await s.db.query('SELECT COUNT(*) AS n FROM "meter_values"'))[0].n >= 1);
  } finally { await s.close(); }
});

test('remote start and stop; reset refused during a session', async () => {
  const s = await boot();
  try {
    await s.sim('EF-SIM-001');
    await until(() => s.conn(0, 1).status === 'Available');
    const start = await s.call('sendCommand', { chargerId: s.charger(0).id, connectorId: s.conn(0, 1).id, type: 'RemoteStartTransaction' });
    assert.equal(start.maxAttempts, 1, 'never retried automatically');
    await until(() => s.conn(0, 1).sessionId && s.conn(0, 1).status === 'Charging');
    await assert.rejects(s.call('sendCommand', { chargerId: s.charger(0).id, type: 'Reset' }), /interrupt a session/);
    await s.call('sendCommand', { chargerId: s.charger(0).id, connectorId: s.conn(0, 1).id, type: 'RemoteStopTransaction' });
    await until(() => !s.conn(0, 1).sessionId);
    assert.equal(s.state.sessions[0].stopReason, 'Remote');
    const cfg = await s.call('sendCommand', { chargerId: s.charger(0).id, type: 'GetConfiguration' });
    await until(() => cfg.status === 'successful');
    assert.ok(cfg.response.configurationKey.some((k) => k.key === 'NumberOfConnectors'));
  } finally { await s.close(); }
});

test('a lost reply: idempotent command retried once, then timed out, state unchanged', async () => {
  const s = await boot();
  try {
    const sim = await s.sim('EF-SIM-001');
    await until(() => s.conn(0, 1).enabled);
    s.state.settings.commandTimeoutSec = 0.15;
    sim.silent = true;
    const { results } = await s.call('requestAvailability', { connectorIds: [s.conn(0, 1).id], action: 'restrict' });
    await until(() => s.cmd(results[0].commandId).status === 'timed_out');
    assert.equal(s.cmd(results[0].commandId).attempts, 2);
    assert.equal(s.conn(0, 1).enabled, true);
    assert.ok(s.state.alerts.some((a) => a.type === 'ocpp_comm_failure'));
  } finally { await s.close(); }
});

test('pricing: CMS-only by default; DataTransfer integration confirmed only by the charger reply', async () => {
  const s = await boot();
  try {
    const sim = await s.sim('EF-SIM-001');
    assert.equal(currentDeployment(s.state, s.charger(0).id).stage, 'cms_only');
    assert.equal(sim.tariff, null);
    const base = { orgName: 'E-Falcon', currency: 'RWF', timezone: 'Africa/Kigali', commandTimeoutSec: 30, heartbeatIntervalSec: 60 };
    await s.call('updateSettings', { ...base, tariffIntegration: { method: 'datatransfer', vendorId: 'EFalconSim', messageId: 'SetTariff' } });
    const flat = s.state.pricingRules.find((r) => r.name === 'Flat');
    const { deployments } = await s.call('assignPricing', { ruleId: flat.id, scope: 'charger', targetIds: [s.charger(0).id, s.charger(1).id] });
    assert.deepEqual(deployments.map((d) => d.stage), ['stored', 'stored'], 'nothing is confirmed at submission time');
    await until(() => deployments[0].stage === 'confirmed' && deployments[1].stage === 'offline');
    assert.equal(sim.tariff.ruleName, 'Flat');
    assert.equal(sim.tariff.periods[0].energyPrice, 450);

    await s.call('updateSettings', { ...base, tariffIntegration: { method: 'datatransfer', vendorId: 'SomeOtherVendor', messageId: 'SetTariff' } });
    const standard = s.state.pricingRules.find((r) => r.name === 'Standard');
    const again = (await s.call('assignPricing', { ruleId: standard.id, scope: 'charger', targetIds: [s.charger(0).id] })).deployments[0];
    await until(() => again.stage === 'not_supported');
    assert.equal(sim.tariff.ruleName, 'Flat', 'charger still holds the old tariff, and the CMS says so');

    const sched = await s.call('assignPricing', { ruleId: flat.id, scope: 'location', targetIds: [s.state.locations[1].id], effectiveAt: Date.now() + 3600000 });
    assert.equal(sched.assignments[0].status, 'scheduled');
    assert.equal(sched.deployments.length, 0);
    await s.call('cancelAssignment', sched.assignments[0].id);
    assert.equal(sched.assignments[0].status, 'cancelled');
  } finally { await s.close(); }
});

test('a charger that answers NotImplemented is recorded as not supporting the command', async () => {
  const s = await boot();
  try {
    await s.sim('EF-SIM-001', { unsupported: ['Reset'] });
    const cfg = await s.call('sendCommand', { chargerId: s.charger(0).id, type: 'GetConfiguration' });
    await until(() => cfg.status === 'successful');
    assert.equal(s.charger(0).capabilities.configuration, 'unverified', 'an Accepted reply alone does not mark a capability verified');
    const reset = await s.call('sendCommand', { chargerId: s.charger(0).id, type: 'Reset' });
    await until(() => reset.status === 'failed');
    assert.equal(reset.resultCode, 'not_supported');
    assert.equal(s.charger(0).capabilities.reset, 'unsupported');
    const second = await s.call('sendCommand', { chargerId: s.charger(0).id, type: 'Reset' });
    await until(() => second.status === 'failed');
    assert.equal(second.sentAt, null, 'not sent again once recorded as unsupported');
  } finally { await s.close(); }
});

test('permissions are enforced by the engine, and scheduled operations re-check the limit', async () => {
  const s = await boot();
  try {
    await s.sim('EF-SIM-001');
    await until(() => s.conn(0, 2).enabled);
    await s.call('saveUser', { name: 'Op', email: 'op@test.example', role: 'operator', password: 'operator-pass-1' });
    await s.call('saveUser', { name: 'View', email: 'view@test.example', role: 'viewer', password: 'viewer-pass-12' });
    const op = s.core.findUserByEmail('op@test.example');
    const viewer = s.core.findUserByEmail('view@test.example');
    assert.equal(await verifyPassword('operator-pass-1', op.passwordHash), true);
    assert.equal(await verifyPassword('nope', op.passwordHash), false);
    await assert.rejects(s.as(viewer)('requestAvailability', { connectorIds: [s.conn(0, 1).id], action: 'restrict' }), (e) => e.status === 403);
    await assert.rejects(s.as(op)('setOperationalLimit', { maxEnabledConnectors: 50, policy: 'block' }), (e) => e.status === 403);
    await assert.rejects(s.as(op)('deleteCharger', s.charger(0).id), (e) => e.status === 403);
    await assert.rejects(s.call('saveUser', { name: 'x', email: 'x@test.example', role: 'viewer', password: 'short' }), /at least 10/);
    assert.equal(s.core.snapshot(viewer).audit.length, 0);
    assert.equal(s.core.snapshot(viewer).users.length, 1);

    const sched = await s.as(op)('scheduleAvailability', { connectorIds: [s.conn(0, 1).id], action: 'restrict', runAt: Date.now() + 60 });
    await wait(80);
    await s.core.tick();
    assert.equal(sched.status, 'executed');
    await until(() => !s.conn(0, 1).enabled);
  } finally { await s.close(); }
});

test('everything survives a restart; in-flight commands are failed, not re-sent', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'efalcon-')), 'test.sqlite');
  let s = await boot({ sqliteFile: file });
  const sim = await s.sim('EF-SIM-001');
  await sim.plug(2, 'TAG-9');
  await until(() => s.conn(0, 2).status === 'Charging');
  await s.call('saveGroup', { name: 'Hotel Chargers', description: '', chargerIds: [s.charger(0).id, s.charger(2).id] });
  s.state.settings.commandTimeoutSec = 5;
  sim.silent = true;
  const { results } = await s.call('requestAvailability', { connectorIds: [s.conn(0, 1).id], action: 'restrict' });
  await until(() => s.cmd(results[0].commandId).status === 'sent');
  await s.core.flush();
  const before = JSON.parse(JSON.stringify({ rules: s.state.pricingRules, chargers: s.state.chargers.map((c) => ({ id: c.id, groupIds: c.groupIds, capabilities: c.capabilities })), sessions: s.state.sessions.length, audit: s.state.audit.length, limit: s.state.settings.operationalLimit }));
  const pendingId = results[0].commandId;
  const crashed = s; // simulate a crash: the old process never gets to tidy up

  s = await boot({ sqliteFile: file, seed: false });
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(s.state.pricingRules)), before.rules, 'tariffs and their periods');
    assert.deepEqual(s.state.chargers.map((c) => ({ id: c.id, groupIds: c.groupIds, capabilities: c.capabilities })), before.chargers, 'chargers, group membership, capabilities');
    assert.equal(s.state.sessions.length, before.sessions);
    assert.ok(s.state.audit.length >= before.audit);
    assert.deepEqual(s.state.settings.operationalLimit, before.limit);
    assert.equal(s.cmd(pendingId).status, 'failed');
    assert.equal(s.cmd(pendingId).resultCode, 'restart');
    assert.equal(s.charger(0).online, false, 'nobody is connected right after a restart');
    assert.equal(s.state.sessions.find((x) => x.idTag === 'TAG-9').status, 'active', 'the session is still open; the charger will report its end');
    assert.ok(s.state.seq.cmd >= 1, 'id counters continue');
  } finally { await s.close(); await crashed.close(); }
});
