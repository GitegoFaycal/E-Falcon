// REST API tests: the real server (src/server.js) on a free port, called with fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { createAdmin } from '../src/setup.js';
import { createSimCharger } from '../tools/charger-sim.js';
import { until } from './helpers.js';

const PASSWORD = 'a-long-test-password';

async function server() {
  const app = await start({ NODE_ENV: 'test', PORT: '0', SQLITE_FILE: ':memory:', JWT_SECRET: 'test-secret-test-secret-test-secret-1234', CORS_ORIGINS: 'http://localhost:5173' });
  await createAdmin(app.core, { name: 'Admin', email: 'admin@test.example', password: PASSWORD });
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  let token = null;
  let cookie = '';
  const http = async (method, path, body, extra = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'efalcon', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) cookie = set[set.length - 1].split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, base, http, login: async (email = 'admin@test.example', password = PASSWORD) => { const r = await http('POST', '/api/auth/login', { email, password }); token = r.body && r.body.accessToken; return r; }, setToken: (t) => { token = t; }, getCookie: () => cookie };
}

test('authentication: login, protected routes, refresh rotation, logout', async () => {
  const s = await server();
  try {
    assert.equal((await s.http('GET', '/api/snapshot')).status, 401);
    assert.equal((await s.login('admin@test.example', 'wrong-password')).status, 401);
    assert.equal((await s.login('nobody@test.example', PASSWORD)).status, 401);
    const ok = await s.login();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, 'admin@test.example');
    assert.equal(ok.body.user.passwordHash, undefined);
    const snap = await s.http('GET', '/api/snapshot');
    assert.equal(snap.status, 200);
    assert.equal(snap.body.me.role, 'admin');
    assert.ok(snap.body.audit.some((a) => a.action === 'auth.login'));

    const first = s.getCookie();
    s.setToken(null);
    const refreshed = await s.http('POST', '/api/auth/refresh');
    assert.equal(refreshed.status, 200);
    assert.notEqual(s.getCookie(), first, 'refresh token is rotated');
    assert.equal((await s.http('POST', '/api/auth/refresh', undefined, { Cookie: first })).status, 401, 'a used refresh token is dead');
    assert.equal((await s.http('POST', '/api/auth/refresh', undefined, { 'X-Requested-With': '' })).status, 400);
    s.setToken('garbage');
    assert.equal((await s.http('GET', '/api/snapshot')).status, 401);
    s.setToken(refreshed.body.accessToken);
    assert.equal((await s.http('POST', '/api/auth/logout')).status, 200);
    s.setToken(null);
    assert.equal((await s.http('POST', '/api/auth/refresh')).status, 401);
  } finally { await s.app.stop(); }
});

test('REST routes drive the engine; errors map to status codes; roles are enforced', async () => {
  const s = await server();
  try {
    await s.login();
    const loc = await s.http('POST', '/api/locations', { name: 'Test Site', city: 'Kigali' });
    assert.equal(loc.status, 200);
    assert.equal((await s.http('POST', '/api/locations', { name: '' })).status, 400);
    assert.equal((await s.http('POST', '/api/locations', [1, 2])).status, 400);
    assert.equal((await s.http('GET', '/api/nope')).status, 404);
    const ch = await s.http('POST', '/api/chargers', { name: 'Unit 1', ocppId: 'EF-HTTP-001', locationId: loc.body.id, connectorCount: 2, ratedPowerKw: 120 });
    assert.equal(ch.status, 200);
    assert.equal((await s.http('POST', '/api/chargers', { name: 'Dup', ocppId: 'EF-HTTP-001', locationId: loc.body.id })).status, 400);
    assert.equal((await s.http('PUT', '/api/chargers/NOPE', { name: 'x', ocppId: 'abc', locationId: loc.body.id })).status, 404);
    const key = await s.http('POST', `/api/chargers/${ch.body.id}/auth-key`);
    assert.ok(key.body.key.length >= 20);

    const rule = await s.http('POST', '/api/pricing/rules', { name: 'Day', periods: [{ start: '00:00', energyPrice: 400, servicePrice: 50, kind: 'standard' }], flatFee: 0, hourPrice: 0, preauthAmount: 0 });
    assert.equal(rule.status, 200);
    assert.equal((await s.http('POST', '/api/pricing/assignments', { ruleId: rule.body.rule.id, scope: 'global' })).status, 200);
    assert.equal((await s.http('PUT', '/api/operational-limit', { maxEnabledConnectors: 1, policy: 'block' })).status, 200);

    // A charger connects over OCPP with its key and is controlled through the REST API.
    const sim = createSimCharger({ url: `${s.base.replace('http', 'ws')}/ocpp`, identity: 'EF-HTTP-001', key: key.body.key, reconnectMs: 0, meterIntervalMs: 60000 });
    sim.connect();
    await until(() => sim.ready, 3000, 'charger boot');
    const state = s.app.core.state;
    await until(() => state.connectors.every((c) => c.enabled));
    const ids = state.connectors.map((c) => c.id);
    const restrict = await s.http('POST', '/api/availability', { connectorIds: ids, action: 'restrict', reason: 'via REST' });
    assert.deepEqual(restrict.body.results.map((r) => r.outcome), ['submitted', 'submitted']);
    await until(() => state.connectors.every((c) => !c.enabled && c.status === 'Unavailable'));
    const enable = await s.http('POST', '/api/availability', { connectorIds: ids, action: 'enable' });
    assert.deepEqual(enable.body.results.map((r) => r.outcome), ['submitted', 'blocked_limit']);

    assert.equal((await s.http('POST', '/api/users', { name: 'Viewer', email: 'v@test.example', role: 'viewer', password: 'viewer-password-1' })).status, 200);
    await s.login('v@test.example', 'viewer-password-1');
    assert.equal((await s.http('POST', '/api/availability', { connectorIds: ids, action: 'restrict' })).status, 403);
    assert.equal((await s.http('GET', '/api/history/audit')).status, 403);
    const snap = await s.http('GET', '/api/snapshot');
    assert.equal(snap.body.audit.length, 0);
    assert.equal(snap.body.users.length, 1);
    assert.equal(snap.body.chargers[0].authKeyHash, undefined);
    assert.equal(snap.body.chargers[0].hasAuthKey, true);
    await s.login();
    assert.ok((await s.http('GET', '/api/history/audit')).body.length > 5);
    sim.stop();
  } finally { await s.app.stop(); }
});
