// Authentication: short-lived JWT access tokens (kept in browser memory) and a rotating refresh
// token in an httpOnly cookie. Only a hash of each refresh token is stored.
import jwt from 'jsonwebtoken';
import { verifyPassword, hashPassword, hashKey, randomToken } from '../core/secrets.js';
import { AppError } from '../core/engine.js';
import { publicRow } from '../core/index.js';

const COOKIE = 'ef_refresh';
const DUMMY_HASH = hashPassword('not-a-real-password'); // keeps login timing the same for unknown emails

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function createAuth({ core, db, config }) {
  const cookieOptions = () => ({ httpOnly: true, secure: config.production || config.cookieSameSite === 'none', sameSite: config.cookieSameSite, path: '/api/auth', maxAge: config.refreshTokenTtlMs });
  const signAccess = (user) => jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { algorithm: 'HS256', expiresIn: config.accessTokenTtlSec });

  function verifyAccess(token) {
    try {
      const payload = jwt.verify(String(token || ''), config.jwtSecret, { algorithms: ['HS256'] });
      const user = core.findUser(payload.sub);
      return user && user.active ? user : null;
    } catch { return null; }
  }

  async function issueRefresh(res, user) {
    const token = randomToken(48);
    await db.query('INSERT INTO "refresh_tokens" ("id", "user_id", "token_hash", "expires_at", "created_at") VALUES (?, ?, ?, ?, ?)', [randomToken(12), user.id, hashKey(token), Date.now() + config.refreshTokenTtlMs, Date.now()]);
    res.cookie(COOKIE, token, cookieOptions());
  }
  const session = (user) => ({ accessToken: signAccess(user), expiresIn: config.accessTokenTtlSec, user: publicRow('users', user) });

  return {
    verifyAccess,
    revokeUser: (userId) => db.query('DELETE FROM "refresh_tokens" WHERE "user_id" = ?', [userId]),
    purgeExpired: () => db.query('DELETE FROM "refresh_tokens" WHERE "expires_at" < ?', [Date.now()]),

    // Express middleware: requires a valid access token and attaches req.user.
    required(req, _res, next) {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const user = m ? verifyAccess(m[1]) : null;
      if (!user) return next(new AppError('Your session has expired. Sign in again.', 401));
      req.user = user;
      return next();
    },

    async login(req, res) {
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) throw new AppError('Email and password are required.');
      const user = core.findUserByEmail(email);
      const ok = await verifyPassword(password, user && user.passwordHash ? user.passwordHash : DUMMY_HASH);
      if (!user || !ok || !user.active) throw new AppError('Wrong email or password.', 401);
      await core.call(user, 'recordLogin');
      await issueRefresh(res, user);
      res.json(session(user));
    },

    // Exchanges the refresh cookie for a new access token and a new refresh cookie (rotation).
    async refresh(req, res) {
      const token = readCookie(req, COOKIE);
      const rows = token ? await db.query('SELECT "id", "user_id", "expires_at" FROM "refresh_tokens" WHERE "token_hash" = ?', [hashKey(token)]) : [];
      const row = rows[0];
      if (row) await db.query('DELETE FROM "refresh_tokens" WHERE "id" = ?', [row.id]);
      const user = row && row.expires_at > Date.now() ? core.findUser(row.user_id) : null;
      if (!user || !user.active) {
        res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
        throw new AppError('Not signed in.', 401);
      }
      await issueRefresh(res, user);
      res.json(session(user));
    },

    async logout(req, res) {
      const token = readCookie(req, COOKIE);
      if (token) {
        const rows = await db.query('SELECT "user_id" FROM "refresh_tokens" WHERE "token_hash" = ?', [hashKey(token)]);
        await db.query('DELETE FROM "refresh_tokens" WHERE "token_hash" = ?', [hashKey(token)]);
        const user = rows[0] ? core.findUser(rows[0].user_id) : null;
        if (user) await core.call(user, 'recordLogout');
      }
      res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
      res.json({ ok: true });
    },
  };
}
