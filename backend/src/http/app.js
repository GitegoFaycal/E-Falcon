// REST API. Thin on purpose: authentication, input shape, rate limits and error mapping live
// here; every rule (permissions included) lives in core/engine.js and is checked there.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { AppError } from '../core/engine.js';

const body = (req) => {
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AppError('The request body must be a JSON object.');
  return req.body;
};

// method, path, engine action, how to build the action's arguments from the request.
const ROUTES = [
  ['post', '/chargers', 'createCharger', (r) => [body(r)]],
  ['put', '/chargers/:id', 'updateCharger', (r) => [r.params.id, body(r)]],
  ['delete', '/chargers/:id', 'deleteCharger', (r) => [r.params.id]],
  ['post', '/chargers/:id/auth-key', 'setChargerAuthKey', (r) => [r.params.id]],
  ['post', '/bulk/location', 'bulkAssignLocation', (r) => [body(r).chargerIds, body(r).locationId]],
  ['post', '/bulk/group', 'bulkAssignGroup', (r) => [body(r).chargerIds, body(r).groupId]],
  ['put', '/connectors/:id', 'updateConnector', (r) => [r.params.id, body(r)]],
  ['post', '/locations', 'saveLocation', (r) => [{ ...body(r), id: undefined }]],
  ['put', '/locations/:id', 'saveLocation', (r) => [{ ...body(r), id: r.params.id }]],
  ['delete', '/locations/:id', 'deleteLocation', (r) => [r.params.id]],
  ['post', '/groups', 'saveGroup', (r) => [{ ...body(r), id: undefined }]],
  ['put', '/groups/:id', 'saveGroup', (r) => [{ ...body(r), id: r.params.id }]],
  ['delete', '/groups/:id', 'deleteGroup', (r) => [r.params.id]],
  ['post', '/availability', 'requestAvailability', (r) => [body(r)]],
  ['put', '/operational-limit', 'setOperationalLimit', (r) => [body(r)]],
  ['post', '/scheduled-operations', 'scheduleAvailability', (r) => [body(r)]],
  ['delete', '/scheduled-operations/:id', 'cancelScheduledOp', (r) => [r.params.id]],
  ['post', '/commands', 'sendCommand', (r) => [body(r)]],
  ['post', '/commands/:id/retry', 'retryCommand', (r) => [r.params.id]],
  ['post', '/commands/:id/cancel', 'cancelCommand', (r) => [r.params.id]],
  ['post', '/pricing/rules', 'saveRule', (r) => [{ ...body(r), id: undefined }]],
  ['put', '/pricing/rules/:id', 'saveRule', (r) => [{ ...body(r), id: r.params.id }]],
  ['delete', '/pricing/rules/:id', 'deleteRule', (r) => [r.params.id]],
  ['post', '/pricing/assignments', 'assignPricing', (r) => [body(r)]],
  ['delete', '/pricing/assignments/:id', 'cancelAssignment', (r) => [r.params.id]],
  ['post', '/alerts/:id/acknowledge', 'acknowledgeAlert', (r) => [r.params.id]],
  ['post', '/alerts/:id/resolve', 'resolveAlert', (r) => [r.params.id, body(r).note]],
  ['post', '/users', 'saveUser', (r) => [{ ...body(r), id: undefined }]],
  ['put', '/users/:id', 'saveUser', (r) => [{ ...body(r), id: r.params.id }]],
  ['put', '/roles/:role/permissions', 'setRolePermissions', (r) => [r.params.role, body(r).permissions]],
  ['put', '/settings', 'updateSettings', (r) => [body(r)]],
];

const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function createApp({ core, auth, config, gateway, log = console.error }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'] }));
  app.use(express.json({ limit: '200kb' }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 600, standardHeaders: true, legacyHeaders: false }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, chargersConnected: gateway.connectedCount(), time: new Date().toISOString() }));

  // Cookie-based endpoints additionally require a custom header, which a cross-site form cannot send.
  const sameOriginOnly = (req, _res, next) => (req.get('X-Requested-With') === 'efalcon' ? next() : next(new AppError('Missing X-Requested-With header.', 400)));
  const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in a few minutes.' } });
  app.post('/api/auth/login', loginLimit, sameOriginOnly, wrap(auth.login));
  app.post('/api/auth/refresh', sameOriginOnly, wrap(auth.refresh));
  app.post('/api/auth/logout', sameOriginOnly, wrap(auth.logout));

  app.get('/api/snapshot', auth.required, (req, res) => res.json(core.snapshot(req.user)));

  for (const [method, path, action, args] of ROUTES) {
    app[method](`/api${path}`, auth.required, wrap(async (req, res) => {
      const result = await core.call(req.user, action, args(req));
      // A password reset or deactivation ends that user's existing sign-ins.
      if (action === 'saveUser' && result && result.sessionsRevoked) await auth.revokeUser(result.id);
      res.json(result === undefined ? { ok: true } : result);
    }));
  }

  // History beyond the window the dashboard keeps live (for exports and long-range reports).
  const range = (req) => {
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || Date.now();
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 10000);
    return { from, to, limit };
  };
  const history = (perm, sql) => wrap(async (req, res) => {
    if (perm) await core.call(req.user, 'requirePermission', [perm]);
    const { from, to, limit } = range(req);
    res.json((await core.store.rows(sql, [from, to, limit])).map(core.store.camelRow));
  });
  app.get('/api/history/sessions', auth.required, history('reports.view', 'SELECT * FROM "charging_sessions" WHERE "started_at" BETWEEN ? AND ? ORDER BY "started_at" DESC LIMIT ?'));
  app.get('/api/history/audit', auth.required, history('audit.view', 'SELECT * FROM "audit_logs" WHERE "at" BETWEEN ? AND ? ORDER BY "at" DESC LIMIT ?'));
  app.get('/api/history/meter-values', auth.required, history('reports.view', 'SELECT * FROM "meter_values" WHERE "at" BETWEEN ? AND ? ORDER BY "at" DESC LIMIT ?'));

  app.use('/api', (_req, _res, next) => next(new AppError('Not found.', 404)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    log('unhandled error', err);
    return res.status(500).json({ error: 'Something went wrong on the server. The error has been logged.' });
  });
  return app;
}
