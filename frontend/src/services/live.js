// LIVE MODE: the dashboard against the real E-Falcon server.
//   - REST calls with Axios (short-lived access token in memory, refresh token in an httpOnly cookie)
//   - one snapshot on sign-in, then row-level "patch" events over Socket.IO
// The store has the same shape as the simulator's, so pages do not know which one they use.
import axios from 'axios';
import { io } from 'socket.io-client';

const BASE = String(import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const NEWEST_FIRST = ['pricingAssignments', 'pricingDeployments', 'sessions', 'commands', 'events', 'alerts', 'audit', 'scheduledOps'];
const LISTS = ['users', 'locations', 'groups', 'chargers', 'connectors', 'pricingRules', ...NEWEST_FIRST];

const empty = () => ({
  settings: { orgName: 'E-Falcon', currency: 'RWF', timezone: 'Africa/Kigali', commandTimeoutSec: 30, heartbeatIntervalSec: 60, operationalLimit: { maxEnabledConnectors: 0, policy: 'block' }, rolePermissions: { admin: [], operator: [], viewer: [] }, tariffIntegration: { method: 'none', vendorId: '', messageId: 'SetTariff' } },
  ...Object.fromEntries(LISTS.map((k) => [k, []])),
});

let state = empty();
let me = null;
let token = null;
let version = 0;
let status = 'loading'; // loading | signed_out | ready
let connection = 'offline'; // live | reconnecting | offline
let socket = null;
let refreshing = null;
let timers = [];
const listeners = new Set();
const eventListeners = new Set();

export const getState = () => state;
export const getVersion = () => version;
export const getCurrentUser = () => me;
export const getStatus = () => status;
export const getConnection = () => connection;
export const ocppEndpoint = (ocppId) => `${BASE.replace(/^http/, 'ws')}/ocpp/${encodeURIComponent(ocppId)}`;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); }
const commit = () => { version += 1; listeners.forEach((fn) => fn()); };

const http = axios.create({ baseURL: `${BASE}/api`, withCredentials: true, timeout: 20000, headers: { 'X-Requested-With': 'efalcon' } });
http.interceptors.request.use((config) => { if (token) config.headers.Authorization = `Bearer ${token}`; return config; });

const message = (err) => (err.response && err.response.data && err.response.data.error)
  || (err.response ? `The server answered ${err.response.status}.` : 'Cannot reach the server. Check your connection and try again.');

function refresh() {
  if (!refreshing) {
    refreshing = http.post('/auth/refresh', null, { skipAuthRetry: true })
      .then((res) => { token = res.data.accessToken; me = res.data.user; return true; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// An expired access token is renewed once, transparently; anything else becomes a readable Error.
http.interceptors.response.use((res) => res, async (err) => {
  const original = err.config || {};
  if (err.response && err.response.status === 401 && !original.skipAuthRetry && !original.retried) {
    try { await refresh(); } catch { signedOut(); throw new Error('Your session has expired. Sign in again.'); }
    return http({ ...original, retried: true });
  }
  throw new Error(message(err));
});

function signedOut() {
  token = null; me = null; state = empty(); status = 'signed_out'; connection = 'offline';
  timers.forEach(clearInterval); timers = [];
  if (socket) { socket.disconnect(); socket = null; }
  commit();
}

async function loadSnapshot() {
  const { data } = await http.get('/snapshot');
  me = data.me;
  const next = empty();
  next.settings = data.settings;
  for (const k of LISTS) next[k] = data[k] || [];
  state = next;
  commit();
}

function applyPatch(patch) {
  for (const [key, rows] of Object.entries(patch.rows || {})) {
    if (!state[key]) continue;
    for (const row of rows) {
      const i = state[key].findIndex((x) => x.id === row.id);
      if (i >= 0) state[key][i] = row;
      else if (NEWEST_FIRST.includes(key)) state[key].unshift(row); else state[key].push(row);
      if (key === 'users' && me && row.id === me.id) me = row;
      if (key === 'alerts' && i < 0 && row.status === 'open') eventListeners.forEach((fn) => fn({ type: 'alert', payload: row, at: Date.now() }));
    }
  }
  for (const [key, ids] of Object.entries(patch.removed || {})) if (state[key]) state[key] = state[key].filter((x) => !ids.includes(x.id));
  if (patch.settings) state.settings = patch.settings;
  commit();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io(BASE, { withCredentials: true, auth: (cb) => cb({ token }) });
  socket.on('connect', () => { connection = 'live'; loadSnapshot().catch(() => {}); });
  socket.on('disconnect', () => { connection = 'reconnecting'; commit(); });
  socket.on('connect_error', () => { connection = 'reconnecting'; commit(); refresh().catch(() => signedOut()); });
  socket.on('patch', applyPatch);
  socket.on('resync', () => loadSnapshot().catch(() => {}));
}

async function enter() {
  await loadSnapshot();
  status = 'ready';
  connectSocket();
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => refresh().catch(() => signedOut()), 10 * 60000), // keep the access token fresh
    setInterval(() => { if (connection !== 'live') loadSnapshot().catch(() => {}); }, 15000), // fallback while the socket is down
  ];
  commit();
}

// Called once at start-up: resume the previous sign-in if the refresh cookie is still valid.
export async function boot() {
  try { await refresh(); await enter(); } catch { status = 'signed_out'; commit(); }
}

const id = encodeURIComponent;
const data = (p) => p.then((res) => res.data);

export const api = {
  async login(email, password) {
    const res = await http.post('/auth/login', { email, password }, { skipAuthRetry: true });
    token = res.data.accessToken; me = res.data.user;
    await enter();
    return me;
  },
  async logout() { try { await http.post('/auth/logout', null, { skipAuthRetry: true }); } finally { signedOut(); } },
  createCharger: (input) => data(http.post('/chargers', input)),
  updateCharger: (chargerId, input) => data(http.put(`/chargers/${id(chargerId)}`, input)),
  deleteCharger: (chargerId) => data(http.delete(`/chargers/${id(chargerId)}`)),
  setChargerAuthKey: (chargerId) => data(http.post(`/chargers/${id(chargerId)}/auth-key`)),
  updateConnector: (connectorId, input) => data(http.put(`/connectors/${id(connectorId)}`, input)),
  bulkAssignLocation: (chargerIds, locationId) => data(http.post('/bulk/location', { chargerIds, locationId })),
  bulkAssignGroup: (chargerIds, groupId) => data(http.post('/bulk/group', { chargerIds, groupId })),
  saveLocation: (input) => data(input.id ? http.put(`/locations/${id(input.id)}`, input) : http.post('/locations', input)),
  deleteLocation: (locationId) => data(http.delete(`/locations/${id(locationId)}`)),
  saveGroup: (input) => data(input.id ? http.put(`/groups/${id(input.id)}`, input) : http.post('/groups', input)),
  deleteGroup: (groupId) => data(http.delete(`/groups/${id(groupId)}`)),
  requestAvailability: (input) => data(http.post('/availability', input)),
  setOperationalLimit: (input) => data(http.put('/operational-limit', input)),
  scheduleAvailability: (input) => data(http.post('/scheduled-operations', input)),
  cancelScheduledOp: (opId) => data(http.delete(`/scheduled-operations/${id(opId)}`)),
  sendCommand: (input) => data(http.post('/commands', input)),
  retryCommand: (commandId) => data(http.post(`/commands/${id(commandId)}/retry`)),
  cancelCommand: (commandId) => data(http.post(`/commands/${id(commandId)}/cancel`)),
  saveRule: (input) => data(input.id ? http.put(`/pricing/rules/${id(input.id)}`, input) : http.post('/pricing/rules', input)),
  deleteRule: (ruleId) => data(http.delete(`/pricing/rules/${id(ruleId)}`)),
  assignPricing: (input) => data(http.post('/pricing/assignments', input)),
  cancelAssignment: (assignmentId) => data(http.delete(`/pricing/assignments/${id(assignmentId)}`)),
  acknowledgeAlert: (alertId) => data(http.post(`/alerts/${id(alertId)}/acknowledge`)),
  resolveAlert: (alertId, note) => data(http.post(`/alerts/${id(alertId)}/resolve`, { note })),
  saveUser: (input) => data(input.id ? http.put(`/users/${id(input.id)}`, input) : http.post('/users', input)),
  setRolePermissions: (role, permissions) => data(http.put(`/roles/${id(role)}/permissions`, { permissions })),
  updateSettings: (input) => data(http.put('/settings', input)),
};
