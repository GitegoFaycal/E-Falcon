import { loadConfig } from '../src/config.js';
import { openDatabase, migrate } from '../src/db/index.js';

const db = await openDatabase(loadConfig());
await migrate(db, console.log);
console.log('Database is up to date.');
await db.close();
