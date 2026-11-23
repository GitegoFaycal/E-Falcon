// Database access. Two interchangeable adapters behind one small interface:
//   query(sql, params) -> rows      exec(sql)      tx(fn)      close()
// SQL is written with "?" placeholders and quoted identifiers; the PostgreSQL adapter rewrites
// placeholders to $1, $2, ... SQLite (built into Node) is for development and tests;
// PostgreSQL is for production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  const bind = (params) => params.map((v) => (v === true ? 1 : v === false ? 0 : v === undefined ? null : v));
  const db = {
    dialect: 'sqlite',
    async query(sql, params = []) {
      const stmt = raw.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) return stmt.all(...bind(params));
      stmt.run(...bind(params));
      return [];
    },
    async exec(sql) { raw.exec(sql); },
    // One connection, so a transaction is simply BEGIN ... COMMIT. Callers serialise their own transactions.
    async tx(fn) {
      raw.exec('BEGIN');
      try { const out = await fn(db); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    async close() { raw.close(); },
  };
  return db;
}

async function openPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, Number); // BIGINT (epoch ms) as a JS number
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: true } : undefined });
  const rewrite = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const wrap = (runner) => ({
    dialect: 'postgres',
    async query(sql, params = []) { return (await runner.query(rewrite(sql), params)).rows; },
    async exec(sql) { await runner.query(sql); },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

export async function openDatabase({ databaseUrl, sqliteFile }) {
  return databaseUrl ? openPostgres(databaseUrl) : openSqlite(sqliteFile);
}

// Applies every migrations/NNN_*.sql that has not run yet, each in its own transaction.
export async function migrate(db, log = () => {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" TEXT PRIMARY KEY, "applied_at" BIGINT NOT NULL)');
  const done = new Set((await db.query('SELECT "name" FROM "schema_migrations"')).map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO "schema_migrations" ("name", "applied_at") VALUES (?, ?)', [file, Date.now()]);
    });
    log(`migration applied: ${file}`);
  }
  return files.length;
}
