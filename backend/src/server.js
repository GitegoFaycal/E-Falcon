// Process entry point: database, engine, REST API, real-time hub, OCPP gateway, scheduler.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase, migrate } from './db/index.js';
import { createCore } from './core/index.js';
import { createGateway, createTransport } from './ocpp/gateway.js';
import { createAuth } from './http/auth.js';
import { createApp } from './http/app.js';
import { createHub } from './realtime/hub.js';
import { createAdmin } from './setup.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

export async function start(env = process.env) {
  const config = loadConfig(env);
  const db = await openDatabase(config);
  await migrate(db, log);
  const transport = createTransport();
  const core = await createCore({ db, transport, log });
  // First-run bootstrap for hosts without a shell (e.g. Render's free plan): if the database has
  // no users and ADMIN_EMAIL + ADMIN_PASSWORD are set, create that administrator once.
  if (!core.state.users.length && env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    const admin = await createAdmin(core, { name: env.ADMIN_NAME || 'Administrator', email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
    log(`First administrator created from ADMIN_EMAIL: ${admin.email}. Remove ADMIN_PASSWORD from the environment now.`);
  }
  const gateway = createGateway({ core, transport, requireAuth: config.ocppRequireAuth, log });
  const auth = createAuth({ core, db, config });
  const app = createApp({ core, auth, config, gateway, log });
  const httpServer = http.createServer(app);
  const hub = createHub({ httpServer, core, auth, config });

  // Chargers connect at /ocpp/<identity>; Socket.IO owns /socket.io; anything else is refused.
  httpServer.on('upgrade', (req, socket, head) => {
    if (gateway.handleUpgrade(req, socket, head)) return;
    if (!String(req.url).startsWith('/socket.io')) socket.destroy();
  });

  const scheduler = setInterval(() => core.tick().catch((e) => log('scheduler failed', e)), 5000);
  const purge = setInterval(() => auth.purgeExpired().catch(() => {}), 3600000);
  await auth.purgeExpired();

  await new Promise((resolve) => httpServer.listen(config.port, config.host, resolve));
  log(`E-Falcon server listening on ${config.host}:${config.port} (${config.production ? 'production' : 'development'}, ${db.dialect})`);
  log(`OCPP endpoint: ws://<host>:${config.port}/ocpp/<charge point identity>   charger authentication ${config.ocppRequireAuth ? 'required' : 'NOT required (development)'}`);
  if (config.ephemeralSecret) log('JWT_SECRET is not set: using a temporary secret, sign-ins will end when the server restarts.');
  if (!core.state.users.length) log('No users exist yet. Create the first administrator with:  npm run create-admin');

  async function stop() {
    clearInterval(scheduler); clearInterval(purge);
    gateway.close(); hub.close();
    await new Promise((resolve) => setTimeout(resolve, 150)); // let charger disconnects be recorded
    await new Promise((resolve) => httpServer.close(resolve));
    await core.flush();
    await db.close();
  }
  return { config, core, db, httpServer, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(({ stop }) => {
    const shutdown = () => { log('shutting down'); stop().then(() => process.exit(0), () => process.exit(1)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((e) => { console.error(e.message || e); process.exit(1); });
}
