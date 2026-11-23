// DEVELOPMENT ONLY: adds demo locations, tariffs and three chargers (EF-SIM-001..003) that the
// charger simulator can connect as. Refuses to run in production. Requires an existing admin.
import { loadConfig } from '../src/config.js';
import { openDatabase, migrate } from '../src/db/index.js';
import { createCore } from '../src/core/index.js';
import { createTransport } from '../src/ocpp/gateway.js';
import { seedDemo } from '../src/setup.js';

const config = loadConfig();
if (config.production) { console.error('Refusing to seed demo data in production.'); process.exit(1); }
const db = await openDatabase(config);
await migrate(db);
const core = await createCore({ db, transport: createTransport() });
const admin = core.state.users.find((u) => u.role === 'admin' && u.active);
if (!admin) { console.error('Create an administrator first:  npm run create-admin -- --email you@example.com'); process.exitCode = 1; } else {
  const done = await seedDemo(core, admin);
  console.log(done ? 'Demo data added: 2 locations, 2 tariffs, 3 chargers (EF-SIM-001..003), 1 group.' : 'Skipped: this database already has locations.');
}
await db.close();
