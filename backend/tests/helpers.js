import http from 'node:http';
import { openDatabase, migrate } from '../src/db/index.js';
import { createCore } from '../src/core/index.js';
import { createGateway, createTransport } from '../src/ocpp/gateway.js';
import { createAdmin, seedDemo } from '../src/setup.js';
import { createSimCharger } from '../tools/charger-sim.js';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 3000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(15); }
  throw new Error(`Timed out waiting for ${label}`);
}

// A complete server without HTTP routes: database, engine, OCPP gateway on a free port.
export async function boot({ sqliteFile = ':memory:', requireAuth = false, seed = true } = {}) {
  const db = await openDatabase({ sqliteFile });
  await migrate(db);
  const transport = createTransport();
  const core = await createCore({ db, transport });
  const gateway = createGateway({ core, transport, requireAuth });
  const server = http.createServer((_, res) => { res.statusCode = 404; res.end(); });
  server.on('upgrade', (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/ocpp`;
  let admin = core.state.users.find((u) => u.role === 'admin');
  if (!admin) admin = await createAdmin(core, { name: 'Test Admin', email: 'admin@test.example', password: 'correct-horse-battery' });
  if (seed) await seedDemo(core, admin);
  const sims = [];
  return {
    db, core, transport, gateway, url, admin, state: core.state,
    call: (name, ...args) => core.call(admin, name, args),
    as: (user) => (name, ...args) => core.call(user, name, args),
    charger: (i) => core.state.chargers[i],
    conn: (i, k) => core.state.connectors.find((c) => c.chargerId === core.state.chargers[i].id && c.connectorId === k),
    cmd: (id) => core.state.commands.find((c) => c.id === id),
    async sim(identity, opts = {}) {
      const sim = createSimCharger({ url, identity, meterIntervalMs: 60000, reconnectMs: 0, ...opts });
      sims.push(sim);
      sim.connect();
      if (opts.expectRefusal) { await until(() => sim.refused, 3000, 'refusal'); return sim; }
      await until(() => sim.ready, 3000, `${identity} to boot`);
      return sim;
    },
    async close({ keepDb = false } = {}) {
      sims.forEach((s) => s.stop());
      gateway.close();
      await wait(40);
      await core.flush();
      await new Promise((r) => server.close(r));
      if (!keepDb) await db.close();
    },
  };
}
