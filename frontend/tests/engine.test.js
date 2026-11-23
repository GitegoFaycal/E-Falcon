// Behaviour tests for the rules that must survive the move to the real backend.
// Run with: npm test   (plain Node, no extra packages)
import test from 'node:test';
import assert from 'node:assert/strict';
import { actions, getState, simConfig } from '../src/sim/engine.js';
import { limitSnapshot, currentDeployment, byId } from '../src/lib/selectors.js';
import { rateAt, validateRule } from '../src/lib/tariff.js';

simConfig.timeScale = 0.002; // run simulated delays ~500x faster
simConfig.autoEvents = false;
simConfig.random = () => 0.5; // deterministic; also means the "flaky" charger never drops a reply (0.5 < 0.6 drops)

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(120);
const user = (role) => getState().users.find((u) => u.role === role).id;
const loginAs = (role) => actions.login(user(role));
const fresh = () => { loginAs('admin'); actions.resetDemo(); };
const cmd = (id) => byId(getState().commands, id);
const conn = (chargerIdx, k) => getState().connectors.find((c) => c.chargerId === getState().chargers[chargerIdx].id && c.connectorId === k);

test('tariff: periods run from their start time to the next start, wrapping midnight', () => {
  const rule = { periods: [{ id: 'a', start: '06:00', energyPrice: 400, servicePrice: 50 }, { id: 'b', start: '18:00', energyPrice: 500, servicePrice: 50 }], weekendPeriods: null };
  const at = (h) => rateAt(rule, new Date(2026, 10, 24, h, 30)).total; // a Tuesday
  assert.equal(at(7), 450);
  assert.equal(at(19), 550);
  assert.equal(at(2), 550, 'before the first start the last period of the previous day applies');
});

test('tariff: validation rejects duplicate starts and negative prices', () => {
  const errors = validateRule({ name: 'x', periods: [{ start: '06:00', energyPrice: -1, servicePrice: 0 }, { start: '06:00', energyPrice: 1, servicePrice: 0 }], flatFee: 0, hourPrice: 0, preauthAmount: 0 });
  assert.ok(errors.length >= 2);
});

test('limit: enabling beyond the operational limit is blocked by the engine, not the UI', async () => {
  fresh();
  const before = limitSnapshot(getState());
  assert.equal(before.enabled, 16);
  assert.equal(before.max, 17);
  const ids = [conn(4, 2).id, conn(9, 2).id]; // two restricted connectors, only one slot left
  const { results } = actions.requestAvailability({ connectorIds: ids, action: 'enable' });
  assert.deepEqual(results.map((r) => r.outcome), ['submitted', 'blocked_limit']);
  await settle();
  assert.equal(cmd(results[0].commandId).status, 'successful');
  assert.equal(limitSnapshot(getState()).enabled, 17);
});

test('limit: pending enable commands count against the limit', () => {
  fresh();
  const a = actions.requestAvailability({ connectorIds: [conn(4, 2).id], action: 'enable' });
  assert.equal(a.results[0].outcome, 'submitted');
  const b = actions.requestAvailability({ connectorIds: [conn(9, 2).id], action: 'enable' }); // first one is still pending
  assert.equal(b.results[0].outcome, 'blocked_limit');
});

test('limit: lowering the limit never stops sessions; it raises an alert and blocks new enables', async () => {
  fresh();
  const active = getState().sessions.filter((s) => s.status === 'active').length;
  actions.setOperationalLimit({ maxEnabledConnectors: 10, policy: 'block' });
  await settle();
  assert.equal(getState().sessions.filter((s) => s.status === 'active').length, active);
  assert.equal(limitSnapshot(getState()).over, 6);
  assert.ok(getState().alerts.some((a) => a.type === 'limit_violation' && a.status === 'open'));
  assert.equal(actions.requestAvailability({ connectorIds: [conn(4, 2).id], action: 'enable' }).results[0].outcome, 'blocked_limit');
});

test('availability: restricting a charging connector is "Scheduled" and applies after the session', async () => {
  fresh();
  const c = conn(0, 1);
  assert.ok(c.sessionId);
  const { results } = actions.requestAvailability({ connectorIds: [c.id], action: 'restrict' });
  await settle();
  assert.equal(cmd(results[0].commandId).response.status, 'Scheduled');
  assert.equal(c.enabled, true, 'still enabled while the session runs');
  assert.ok(c.sessionId, 'session was not stopped');
  actions.simPlug(c.id); // vehicle unplugs
  assert.equal(c.enabled, false);
  assert.equal(c.status, 'Unavailable');
});

test('commands: offline charger -> not sent; unsupported capability -> not sent', async () => {
  fresh();
  const offline = actions.requestAvailability({ connectorIds: [conn(5, 1).id], action: 'restrict' });
  const ch = getState().chargers[0];
  actions.updateCharger(ch.id, { ...ch, capabilities: { ...ch.capabilities, changeAvailability: 'unsupported' } });
  const unsupported = actions.requestAvailability({ connectorIds: [conn(0, 2).id], action: 'restrict' });
  await settle();
  const a = cmd(offline.results[0].commandId);
  const b = cmd(unsupported.results[0].commandId);
  assert.equal(a.resultCode, 'offline');
  assert.equal(a.sentAt, null);
  assert.equal(b.resultCode, 'not_supported');
  assert.equal(conn(5, 1).enabled, true, 'state unchanged without confirmation');
});

test('commands: no reply -> idempotent command is retried, then times out; state unchanged', async () => {
  fresh();
  simConfig.random = () => 0.1; // the flaky charger now drops every reply
  const c = conn(9, 1);
  const { results } = actions.requestAvailability({ connectorIds: [c.id], action: 'restrict' });
  await wait(200);
  simConfig.random = () => 0.5;
  const k = cmd(results[0].commandId);
  assert.equal(k.status, 'timed_out');
  assert.equal(k.attempts, 2);
  assert.equal(c.enabled, true);
});

test('pricing: stored -> sent -> confirmed only with a reply; CMS-only and offline are reported as such', async () => {
  fresh();
  const s = getState();
  const { rule } = actions.saveRule({ name: 'Test', periods: [{ start: '00:00', energyPrice: 300, servicePrice: 50 }], flatFee: 0, hourPrice: 0, preauthAmount: 0 });
  const { deployments } = actions.assignPricing({ ruleId: rule.id, scope: 'global' });
  assert.equal(deployments.length, 10 - 1, 'Musanze keeps its location tariff, so it is not redeployed');
  assert.ok(deployments.filter((d) => d.commandId).every((d) => d.stage === 'stored'), 'nothing is confirmed at submission time');
  await settle();
  const stage = (i) => currentDeployment(s, s.chargers[i].id).stage;
  assert.equal(stage(0), 'confirmed');
  assert.equal(stage(5), 'offline');
  assert.equal(stage(8), 'cms_only');
  assert.equal(currentDeployment(s, s.chargers[9].id).ruleName, 'Highway Stopover');
});

test('pricing: a tariff the charger cannot hold is not sent', async () => {
  fresh();
  const s = getState();
  const weekend = s.pricingRules.find((r) => r.name === 'Weekend Saver');
  const { deployments } = actions.assignPricing({ ruleId: weekend.id, scope: 'charger', targetIds: [s.chargers[0].id] });
  assert.equal(deployments[0].stage, 'not_supported');
  assert.equal(deployments[0].commandId, null);
});

test('pricing: scheduled assignment can be cancelled and does nothing until due', () => {
  fresh();
  const s = getState();
  const { assignments, deployments } = actions.assignPricing({ ruleId: s.pricingRules[1].id, scope: 'location', targetIds: [s.locations[0].id], effectiveAt: Date.now() + 3600000 });
  assert.equal(assignments[0].status, 'scheduled');
  assert.equal(deployments.length, 0);
  actions.cancelAssignment(assignments[0].id);
  assert.equal(assignments[0].status, 'cancelled');
});

test('permissions: viewer cannot change anything; operator cannot change the limit', () => {
  fresh();
  loginAs('viewer');
  assert.throws(() => actions.requestAvailability({ connectorIds: [conn(0, 2).id], action: 'restrict' }), /Permission denied/);
  assert.throws(() => actions.saveRule({ name: 'x', periods: [{ start: '00:00', energyPrice: 1, servicePrice: 0 }] }), /Permission denied/);
  loginAs('operator');
  assert.throws(() => actions.setOperationalLimit({ maxEnabledConnectors: 20, policy: 'block' }), /Permission denied/);
  assert.throws(() => actions.deleteCharger(getState().chargers[0].id), /Permission denied/);
});

test('safety: reset is refused while a session is in progress; remote start is never auto-retried', async () => {
  fresh();
  assert.throws(() => actions.sendCommand({ chargerId: getState().chargers[0].id, type: 'Reset' }), /interrupt a session/);
  const k = actions.sendCommand({ chargerId: getState().chargers[1].id, connectorId: conn(1, 2).id, type: 'RemoteStartTransaction' });
  assert.equal(k.maxAttempts, 1);
  await settle();
  assert.equal(k.status, 'successful');
  assert.ok(conn(1, 2).sessionId || conn(1, 2).status === 'Preparing');
});

test('audit: changes are recorded with before/after', () => {
  fresh();
  actions.setOperationalLimit({ maxEnabledConnectors: 18, policy: 'warn' });
  const entry = getState().audit[0];
  assert.equal(entry.action, 'limit.update');
  assert.equal(entry.before.maxEnabledConnectors, 17);
  assert.equal(entry.after.maxEnabledConnectors, 18);
});

test.after(async () => { const { stopSimulation } = await import('../src/sim/engine.js'); stopSimulation(); });
