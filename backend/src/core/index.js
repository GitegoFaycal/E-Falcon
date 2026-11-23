// Wires the engine to persistence and to listeners. Everything outside the core (REST, sockets,
// OCPP gateway, scheduler) goes through the object returned here.
import { createStore } from '../db/store.js';
import { createEngine, AppError } from './engine.js';
import { hasPerm } from '../shared/permissions.js';

const HIDDEN = { users: ['passwordHash'], chargers: ['authKeyHash'] };

// Removes secrets before anything leaves the server.
export function publicRow(key, row) {
  if (!HIDDEN[key]) return row;
  const out = { ...row };
  for (const f of HIDDEN[key]) delete out[f];
  if (key === 'chargers') out.hasAuthKey = Boolean(row.authKeyHash);
  return out;
}

// Which tables a user may see at all.
export function canSee(settings, user, key) {
  if (key === 'audit') return hasPerm(settings.rolePermissions, user.role, 'audit.view');
  if (key === 'users') return hasPerm(settings.rolePermissions, user.role, 'users.manage');
  return true;
}

const LISTS = ['users', 'locations', 'groups', 'chargers', 'connectors', 'pricingRules', 'pricingAssignments', 'pricingDeployments', 'sessions', 'commands', 'events', 'alerts', 'audit', 'scheduledOps'];

export async function createCore({ db, transport, log = () => {}, now }) {
  const store = createStore(db);
  const state = await store.load();
  const listeners = new Set();
  let flushTimer = null;

  async function flush() {
    const changes = await store.flush(state);
    if (!changes.upserts.length && !changes.deletes.length && !changes.settings.length) return;
    const patch = { rows: {}, removed: {}, settings: null };
    for (const { key, obj } of changes.upserts) (patch.rows[key] ||= []).push(publicRow(key, obj));
    for (const { key, id } of changes.deletes) (patch.removed[key] ||= []).push(id);
    if (changes.settings.some((s) => s.key !== 'seq')) patch.settings = state.settings;
    listeners.forEach((fn) => { try { fn(patch); } catch (e) { log('patch listener failed', e); } });
  }
  // For changes that happen outside a request (charger replies): persist shortly, coalesced.
  function flushSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush().catch((e) => log('flush failed', e)); }, 20);
  }

  const engine = createEngine({ state, transport, now, onDirty: flushSoon, appendRow: store.append, log });
  engine.recover();
  await flush();

  return {
    state,
    AppError,
    flush,
    onPatch(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Runs an action as `actor` and persists before returning, so a response always reflects stored state.
    async call(actor, name, args = []) {
      let result;
      try { result = engine.run(actor, name, args); } finally { await flush(); }
      return result;
    },
    ocpp: {
      lookup: engine.ocpp.lookup,
      checkKey: engine.ocpp.checkKey,
      async rejected(...a) { engine.ocpp.rejected(...a); await flush(); },
      async connected(...a) { engine.ocpp.connected(...a); await flush(); },
      async disconnected(...a) { engine.ocpp.disconnected(...a); await flush(); },
      // The reply is only sent to the charger after the change has been written.
      async handle(identity, action, payload) {
        let result;
        try { result = engine.ocpp.handle(identity, action, payload); } finally { await flush(); }
        return result;
      },
    },
    async tick() { engine.tick(); await flush(); },
    findUser: (id) => state.users.find((u) => u.id === id) || null,
    findUserByEmail: (email) => state.users.find((u) => u.email === String(email || '').trim().toLowerCase()) || null,
    // Everything the dashboard needs for `user`, in the shape the frontend store uses.
    snapshot(user) {
      const out = { settings: state.settings, me: publicRow('users', user) };
      for (const key of LISTS) out[key] = canSee(state.settings, user, key) ? state[key].map((r) => publicRow(key, r)) : [];
      if (!canSee(state.settings, user, 'users')) out.users = [publicRow('users', user)];
      return out;
    },
    store,
  };
}
