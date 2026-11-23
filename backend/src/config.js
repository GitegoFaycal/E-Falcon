// Environment configuration. Development has safe conveniences; production refuses to start
// if anything security-relevant is missing.
import crypto from 'node:crypto';

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const problems = [];
  let jwtSecret = env.JWT_SECRET || '';
  if (production && jwtSecret.length < 32) problems.push('JWT_SECRET must be set to at least 32 random characters.');
  if (!jwtSecret) jwtSecret = crypto.randomBytes(48).toString('base64url'); // development only: sign-ins end when the server restarts
  if (production && !env.DATABASE_URL) problems.push('DATABASE_URL (PostgreSQL) must be set.');
  const corsOrigins = String(env.CORS_ORIGINS || (production ? '' : 'http://localhost:5173')).split(',').map((s) => s.trim()).filter(Boolean);
  if (production && !corsOrigins.length) problems.push('CORS_ORIGINS must list the dashboard origin(s).');
  const sameSite = (env.COOKIE_SAMESITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) problems.push('COOKIE_SAMESITE must be lax, strict or none.');
  if (problems.length) throw new Error(`Configuration error:\n - ${problems.join('\n - ')}`);
  return {
    production,
    port: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 4000,
    // Interface to listen on. 127.0.0.1 keeps the server private behind a reverse proxy or SSH tunnel.
    host: env.HOST || '0.0.0.0',
    databaseUrl: env.DATABASE_URL || '',
    sqliteFile: env.SQLITE_FILE || './data/efalcon.sqlite',
    jwtSecret,
    ephemeralSecret: !env.JWT_SECRET,
    corsOrigins,
    cookieSameSite: sameSite,
    // Chargers must authenticate in production unless this is explicitly turned off.
    ocppRequireAuth: env.OCPP_REQUIRE_AUTH ? env.OCPP_REQUIRE_AUTH === 'true' : production,
    trustProxy: Number(env.TRUST_PROXY) || 0,
    accessTokenTtlSec: 15 * 60,
    refreshTokenTtlMs: 14 * 86400000,
  };
}
