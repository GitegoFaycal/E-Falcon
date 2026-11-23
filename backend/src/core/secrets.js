// Password and key hashing. Node's built-in scrypt for user passwords (slow by design);
// SHA-256 for charger keys and refresh tokens, which are long random values.
import crypto from 'node:crypto';

const N = 16384;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [scheme, n, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return resolve(false);
    const expected = Buffer.from(hash, 'base64');
    crypto.scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(n) }, (err, actual) => {
      resolve(!err && actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
    });
  });
}

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

export function verifyKey(key, storedHash) {
  const a = Buffer.from(hashKey(key));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
