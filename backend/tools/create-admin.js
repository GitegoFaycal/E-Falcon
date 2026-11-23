// Creates an administrator. There is no default account.
//   npm run create-admin -- --email you@example.com --name "Your Name"
// The password is read from ADMIN_PASSWORD if set; otherwise a strong one is generated and
// printed once. Stop the server first when using SQLite.
import { loadConfig } from '../src/config.js';
import { openDatabase, migrate } from '../src/db/index.js';
import { createCore } from '../src/core/index.js';
import { createTransport } from '../src/ocpp/gateway.js';
import { createAdmin } from '../src/setup.js';
import { randomToken } from '../src/core/secrets.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const email = opt('email');
if (!email) { console.error('Usage: npm run create-admin -- --email you@example.com [--name "Your Name"]'); process.exit(1); }

const db = await openDatabase(loadConfig());
await migrate(db);
const core = await createCore({ db, transport: createTransport() });
const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD || randomToken(15);
try {
  const user = await createAdmin(core, { name: opt('name') || 'Administrator', email, password });
  console.log(`Administrator created: ${user.email}`);
  if (generated) console.log(`Password (shown once, store it safely): ${password}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
await db.close();
