// DEMO-MODE SIMULATOR. Used only when VITE_API_URL is not set.
//
// An in-memory stand-in for the E-Falcon server AND for the chargers, so the dashboard can be
// shown without any backend. It mirrors the server's engine (backend/src/core/engine.js):
// `actions` validate, check permissions, audit and enforce the operational limit the same way,
// and `simulateChargerResponse` is the only part that pretends to be hardware.
// No function in this file talks to a server or a physical charger.
import { buildSeed, makeId } from './seed.js';
import { rateAt, validateRule } from '../lib/tariff.js';
import { hasPerm, ALL_PERMISSIONS } from '../lib/permissions.js';
import { ACTIVE_COMMAND_STATUSES } from '../lib/status.js';
import { byId, resolvePricing, limitSnapshot, hasActiveCommand, connectorsOf } from '../lib/selectors.js';

export const simConfig = { timeScale: 1, autoEvents: true, random: Math.random };

let state = buildSeed();
let version = 0;
let currentUserId = null;
const listeners = new Set();
const eventListeners = new Set();
const timers = new Set();
let tickHandle = null;

export const getState = () => state;
export const getVersion = () => version;
export const getCurrentUser = () => byId(state.users, currentUserId) || null;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); }

function commit() { version += 1; listeners.forEach((fn) => fn()); }
function emit(type, payload) { eventListeners.forEach((fn) => fn({ type, payload, at: Date.now() })); }
function later(ms, fn) {
  const t = setTimeout(() => {
    timers.delete(t);
    try { fn(); } catch (e) { console.error('[sim]', e); }
    commit();
  }, ms * simConfig.timeScale);
  timers.add(t);
}

const SYSTEM = { id: 'system', name: 'System (scheduler)', role: 'admin' };
const now = () => Date.now();
const cap = (list, n) => { if (list.length > n) list.length = n; };

function need(perm, actor) {
  if (!actor) throw new Error('You are not signed in.');
  if (actor.active === false) throw new Error('This account is deactivated.');
  if (!hasPerm(state.settings.rolePermissions, actor.role, perm)) throw new Error(`Permission denied (${perm}).`);
}
function me() {
  const u = getCurrentUser();
  if (!u) throw new Error('You are not signed in.');
  return u;
}
function getCharger(id) { const c = byId(state.chargers, id); if (!c) throw new Error('Charger not found.'); return c; }
function getConnector(id) { const c = byId(state.connectors, id); if (!c) throw new Error('Connector not found.'); return c; }
const clean = (s) => String(s ?? '').trim();

function audit(actor, action, entityType, entityId, entityLabel, before = null, after = null, details = '') {
  state.audit.unshift({ id: makeId(state, 'aud'), userId: actor.id, userName: actor.name, action, entityType, entityId, entityLabel, before, after, details, at: now() });
  cap(state.audit, 2000);
}
function addEvent(chargerId, connectorId, type, message) {
  const ev = { id: makeId(state, 'evt'), chargerId, connectorId, type, message, at: now() };
  state.events.unshift(ev);
  cap(state.events, 800);
  emit(`charger:${type}`, ev);
}
function raiseAlert({ type, severity, chargerId = null, connectorId = null, message }) {
  const dup = state.alerts.find((a) => a.status === 'open' && a.type === type && a.chargerId === chargerId && a.connectorId === connectorId);
  if (dup && ['charger_offline', 'connector_fault', 'limit_violation'].includes(type)) { dup.message = message; return dup; }
  const alert = { id: makeId(state, 'alr'), type, severity, chargerId, connectorId, message, createdAt: now(), status: 'open', acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, resolutionNote: '' };
  state.alerts.unshift(alert);
  cap(state.alerts, 1000);
  emit('alert', alert);
  return alert;
}
function autoResolve(type, chargerId, connectorId, note) {
  state.alerts.filter((a) => a.status !== 'resolved' && a.type === type && a.chargerId === chargerId && (connectorId === undefined || a.connectorId === connectorId))
    .forEach((a) => { a.status = 'resolved'; a.resolvedAt = now(); a.resolutionNote = note; });
}

/* ---------------------------------------------------------------- sessions */

function startSession(c, idTag, source) {
  const ch = getCharger(c.chargerId);
  const res = resolvePricing(state, ch, c);
  const rule = res ? res.rule : null;
  const rate = rateAt(rule, new Date());
  const id = makeId(state, 'ses');
  const session = {
    id, transactionId: state.seq.ses, chargerId: ch.id, connectorId: c.id, idTag, startedAt: now(), endedAt: null,
    meterStartWh: c.meterWh, energyKwh: 0, targetKwh: 8 + simConfig.random() * 45, status: 'active', stopReason: null,
    ruleId: rule ? rule.id : null, ruleName: rule ? rule.name : null, ruleVersion: rule ? rule.version : null,
    priceAtStart: rate.total, fees: { flatFee: rule ? rule.flatFee : 0, hourPrice: rule ? rule.hourPrice : 0 },
    energyCost: 0, cost: rule ? rule.flatFee : 0, costSource: rule ? 'cms_calculated' : 'none', simulated: true,
  };
  state.sessions.unshift(session);
  c.status = 'Charging';
  c.sessionId = id;
  c.powerKw = Math.round(c.maxPowerKw * (0.5 + simConfig.random() * 0.35) * 10) / 10;
  addEvent(ch.id, c.id, 'session_start', `StartTransaction on ${c.label} (${source})`);
  return session;
}

function sessionCost(s, at) {
  return Math.round(s.energyCost + s.fees.flatFee + s.fees.hourPrice * ((at - s.startedAt) / 3600000));
}

function endSession(c, reason, failed = false) {
  const s = byId(state.sessions, c.sessionId);
  c.sessionId = null;
  c.powerKw = 0;
  if (s) {
    s.endedAt = now();
    s.status = failed ? 'failed' : 'completed';
    s.stopReason = reason;
    s.cost = sessionCost(s, s.endedAt);
    addEvent(c.chargerId, c.id, 'session_stop', `StopTransaction on ${c.label} (${reason}), ${s.energyKwh.toFixed(2)} kWh`);
    if (failed) raiseAlert({ type: 'session_failed', severity: 'warning', chargerId: c.chargerId, connectorId: c.id, message: `Session ${s.id} on ${getCharger(c.chargerId).name} · ${c.label} ended abnormally (${reason}).` });
  }
  if (c.status !== 'Faulted') {
    if (c.pendingInoperative) {
      // A ChangeAvailability(Inoperative) answered "Scheduled" takes effect now that the session is over.
      c.enabled = false;
      c.status = 'Unavailable';
      c.maintenance = c.pendingMaintenance;
      addEvent(c.chargerId, c.id, 'status', `StatusNotification: Unavailable (scheduled restriction applied)`);
      refreshLimitAlert();
    } else {
      c.status = c.enabled ? 'Available' : 'Unavailable';
    }
  }
  c.pendingInoperative = false;
  c.pendingMaintenance = false;
}

/* ------------------------------------------------------------ connectivity */

function setOnline(ch, online, cause) {
  if (ch.online === online) return;
  ch.online = online;
  if (online) {
    ch.everConnected = true;
    ch.lastHeartbeat = now();
    ch.bootedAt = now();
    addEvent(ch.id, null, 'connect', `BootNotification accepted (${cause})`);
    autoResolve('charger_offline', ch.id, undefined, 'Connection recovered.');
    raiseAlert({ type: 'connection_recovered', severity: 'info', chargerId: ch.id, message: `${ch.name} is back online.` });
  } else {
    addEvent(ch.id, null, 'disconnect', `WebSocket connection closed (${cause})`);
    raiseAlert({ type: 'charger_offline', severity: 'critical', chargerId: ch.id, message: `${ch.name} went offline (${cause}).` });
  }
}

function setFault(c, errorCode) {
  const ch = getCharger(c.chargerId);
  c.status = 'Faulted';
  c.errorCode = errorCode;
  c.errorInfo = 'Simulated fault';
  addEvent(ch.id, c.id, 'fault', `StatusNotification: Faulted (${errorCode})`);
  raiseAlert({ type: 'connector_fault', severity: 'critical', chargerId: ch.id, connectorId: c.id, message: `${ch.name} · ${c.label} reported ${errorCode}.` });
  if (c.sessionId) endSession(c, 'Fault', true);
}

function clearFault(c) {
  if (c.status !== 'Faulted') return;
  c.errorCode = 'NoError';
  c.errorInfo = '';
  c.status = c.enabled ? 'Available' : 'Unavailable';
  addEvent(c.chargerId, c.id, 'status', `StatusNotification: ${c.status} (fault cleared)`);
  autoResolve('connector_fault', c.chargerId, c.id, 'Charger reported the fault cleared.');
}

/* ---------------------------------------------------------------- commands */

const CAPABILITY_FOR = {
  ChangeAvailability: 'changeAvailability', RemoteStartTransaction: 'remoteStartStop', RemoteStopTransaction: 'remoteStartStop',
  GetConfiguration: 'configuration', Reset: 'reset', SetTariff: 'tariffSync',
};
// Only commands that are safe to repeat are retried automatically after a timeout.
const AUTO_RETRY = { ChangeAvailability: 2, GetConfiguration: 2, SetTariff: 2 };

function createCommand(actor, { chargerId, connectorId = null, type, payload = {}, meta = {} }) {
  const cmd = {
    id: makeId(state, 'cmd'), chargerId, connectorId, type, payload, meta,
    requestedBy: actor.name, requestedById: actor.id, requestedAt: now(), status: 'pending',
    sentAt: null, completedAt: null, response: null, error: null, resultCode: null,
    attempts: 0, maxAttempts: AUTO_RETRY[type] || 1, simulated: true,
  };
  state.commands.unshift(cmd);
  cap(state.commands, 2000);
  emit('command:created', cmd);
  dispatch(cmd);
  return cmd;
}

function finish(cmd, status, { response = null, error = null, resultCode = null } = {}) {
  cmd.status = status;
  cmd.completedAt = now();
  if (response) cmd.response = response;
  cmd.error = error;
  cmd.resultCode = resultCode;
  const ch = byId(state.chargers, cmd.chargerId);
  const dep = cmd.meta.deploymentId ? byId(state.pricingDeployments, cmd.meta.deploymentId) : null;
  if (dep) {
    dep.updatedAt = now();
    if (status === 'successful') { dep.stage = 'confirmed'; dep.detail = 'Tariff accepted by the simulated charger.'; }
    else if (resultCode === 'offline') { dep.stage = 'offline'; dep.detail = 'Charger offline. Tariff is stored in the CMS but was not sent.'; }
    else if (resultCode === 'not_supported') { dep.stage = 'not_supported'; dep.detail = error; }
    else if (status !== 'cancelled') { dep.stage = 'failed'; dep.detail = error || 'The charger did not confirm the tariff.'; }
  }
  if (status === 'failed' || status === 'timed_out') {
    const name = ch ? ch.name : cmd.chargerId;
    if (cmd.type === 'SetTariff') raiseAlert({ type: 'pricing_update_failed', severity: 'warning', chargerId: cmd.chargerId, message: `Tariff push to ${name} failed: ${error}` });
    else if (status === 'timed_out') raiseAlert({ type: 'ocpp_comm_failure', severity: 'warning', chargerId: cmd.chargerId, connectorId: cmd.connectorId, message: `${cmd.type} to ${name} got no response (${cmd.attempts} attempt${cmd.attempts === 1 ? '' : 's'}).` });
    else if (resultCode !== 'offline') raiseAlert({ type: 'command_failed', severity: 'warning', chargerId: cmd.chargerId, connectorId: cmd.connectorId, message: `${cmd.type} to ${name} failed: ${error}` });
  }
  emit(`command:${status}`, cmd);
}

function dispatch(cmd) {
  later(250, () => {
    if (cmd.status !== 'pending') return;
    const ch = byId(state.chargers, cmd.chargerId);
    if (!ch) return finish(cmd, 'failed', { error: 'Charger no longer exists.', resultCode: 'rejected' });
    if (ch.capabilities[CAPABILITY_FOR[cmd.type]] === 'unsupported') {
      return finish(cmd, 'failed', { resultCode: 'not_supported', error: `${cmd.type} is marked "not supported" for this charger. Nothing was sent.` });
    }
    if (!ch.online) return finish(cmd, 'failed', { resultCode: 'offline', error: 'Charger is offline. The command was not sent.' });
    cmd.status = 'sent';
    cmd.sentAt = now();
    cmd.attempts += 1;
    const attempt = cmd.attempts;
    emit('command:sent', cmd);

    later(450 + simConfig.random() * 800, () => {
      if (cmd.status !== 'sent' || cmd.attempts !== attempt) return;
      if (!ch.online) return; // no reply; the timeout below handles it
      if (ch.sim.flaky && simConfig.random() < 0.6) return; // simulated lost message
      cmd.status = 'acknowledged';
      cmd.response = simulateChargerResponse(cmd, ch);
      emit('command:acknowledged', cmd);
      later(200, () => {
        if (cmd.status !== 'acknowledged') return;
        const ok = ['Accepted', 'Scheduled'].includes(cmd.response.status);
        if (ok) applyEffects(cmd, ch);
        finish(cmd, ok ? 'successful' : 'failed', ok ? {} : { resultCode: 'rejected', error: cmd.response.reason || `Charger answered "${cmd.response.status}".` });
      });
    });

    later(state.settings.commandTimeoutSec * 1000, () => {
      if (cmd.status !== 'sent' || cmd.attempts !== attempt) return;
      if (cmd.attempts < cmd.maxAttempts) {
        cmd.status = 'pending';
        addEvent(ch.id, cmd.connectorId, 'command', `${cmd.type} timed out, retrying (attempt ${cmd.attempts + 1}/${cmd.maxAttempts})`);
        dispatch(cmd);
      } else {
        finish(cmd, 'timed_out', { resultCode: 'timeout', error: `No response within ${state.settings.commandTimeoutSec}s.` });
      }
    });
  });
}

// The ONLY place that plays the role of charger firmware.
function simulateChargerResponse(cmd, ch) {
  const c = cmd.connectorId ? byId(state.connectors, cmd.connectorId) : null;
  switch (cmd.type) {
    case 'ChangeAvailability':
      if (!c) return { status: 'Rejected', reason: 'Unknown connector.' };
      // OCPP 1.6: a change requested during a transaction is answered "Scheduled" and applied afterwards.
      if (cmd.payload.type === 'Inoperative' && c.sessionId) return { status: 'Scheduled' };
      return { status: 'Accepted' };
    case 'RemoteStartTransaction':
      if (!c || c.status !== 'Available' || !c.enabled) return { status: 'Rejected', reason: 'Connector is not available for a new session.' };
      return { status: 'Accepted' };
    case 'RemoteStopTransaction':
      if (!c || !c.sessionId) return { status: 'Rejected', reason: 'No transaction in progress on this connector.' };
      return { status: 'Accepted' };
    case 'Reset':
      return { status: 'Accepted' };
    case 'GetConfiguration':
      return {
        status: 'Accepted',
        configurationKey: [
          { key: 'HeartbeatInterval', readonly: false, value: String(state.settings.heartbeatIntervalSec) },
          { key: 'MeterValueSampleInterval', readonly: false, value: '30' },
          { key: 'NumberOfConnectors', readonly: true, value: String(connectorsOf(state, ch.id).length) },
          { key: 'SupportedFeatureProfiles', readonly: true, value: 'Core,RemoteTrigger' },
        ],
      };
    case 'SetTariff':
      if ((cmd.payload.periods || []).length > ch.hardware.maxTariffPeriods) return { status: 'Rejected', reason: 'Too many tariff periods.' };
      return { status: 'Accepted' };
    default:
      return { status: 'NotSupported', reason: `Unknown command ${cmd.type}.` };
  }
}

function applyEffects(cmd, ch) {
  const c = cmd.connectorId ? byId(state.connectors, cmd.connectorId) : null;
  if (cmd.type === 'ChangeAvailability' && c) {
    if (cmd.payload.type === 'Operative') {
      c.enabled = true;
      c.maintenance = false;
      c.pendingInoperative = false;
      c.pendingMaintenance = false;
      if (c.status === 'Unavailable') c.status = 'Available';
      addEvent(ch.id, c.id, 'status', `StatusNotification: ${c.status}`);
    } else if (cmd.response.status === 'Scheduled') {
      c.pendingInoperative = true;
      c.pendingMaintenance = Boolean(cmd.payload.maintenance);
    } else {
      c.enabled = false;
      c.maintenance = Boolean(cmd.payload.maintenance);
      if (c.status !== 'Faulted') c.status = 'Unavailable';
      addEvent(ch.id, c.id, 'status', 'StatusNotification: Unavailable');
    }
    refreshLimitAlert();
  } else if (cmd.type === 'RemoteStartTransaction' && c) {
    c.status = 'Preparing';
    later(1500, () => { if (c.status === 'Preparing' && ch.online) startSession(c, cmd.payload.idTag, 'remote start'); });
  } else if (cmd.type === 'RemoteStopTransaction' && c) {
    endSession(c, 'Remote');
  } else if (cmd.type === 'Reset') {
    setOnline(ch, false, 'reset requested');
    later(8000, () => setOnline(ch, true, 'reboot after reset'));
  }
}

/* ----------------------------------------------------------------- pricing */

function deployToCharger(ch, actor) {
  const res = resolvePricing(state, ch, null);
  if (!res) return null;
  const { rule } = res;
  const prev = state.pricingDeployments.find((d) => d.chargerId === ch.id && d.current);
  if (prev && prev.ruleId === rule.id && prev.ruleVersion === rule.version && ['confirmed', 'sent', 'stored', 'cms_only'].includes(prev.stage)) return prev;
  if (prev) prev.current = false;
  const dep = {
    id: makeId(state, 'dep'), chargerId: ch.id, ruleId: rule.id, ruleName: rule.name, ruleVersion: rule.version, current: true,
    stage: 'stored', commandId: null, requestedBy: actor.name, detail: 'Saved in the CMS. Waiting to be sent.', createdAt: now(), updatedAt: now(),
  };
  state.pricingDeployments.unshift(dep);
  cap(state.pricingDeployments, 2000);
  if (ch.capabilities.tariffSync === 'unsupported') {
    dep.stage = 'cms_only';
    dep.detail = 'This charger has no tariff interface. The price is used for CMS billing calculation only; the tariff on the unit itself is unchanged.';
  } else if (rule.weekendPeriods && rule.weekendPeriods.length) {
    dep.stage = 'not_supported';
    dep.detail = 'This tariff has a separate weekend schedule, which the charger tariff screen cannot hold. Not sent; CMS billing uses it.';
  } else if (rule.periods.length > ch.hardware.maxTariffPeriods) {
    dep.stage = 'not_supported';
    dep.detail = `Tariff has ${rule.periods.length} periods but this charger accepts ${ch.hardware.maxTariffPeriods}. Not sent.`;
  } else {
    const cmd = createCommand(actor, {
      chargerId: ch.id, type: 'SetTariff', meta: { deploymentId: dep.id },
      payload: { ruleId: rule.id, ruleName: rule.name, version: rule.version, periods: rule.periods.map(({ start, energyPrice, servicePrice }) => ({ start, energyPrice, servicePrice })), flatFee: rule.flatFee, hourPrice: rule.hourPrice, preauthAmount: rule.preauthAmount },
    });
    dep.commandId = cmd.id;
  }
  return dep;
}

// Deploy to each charger and return only the deployments that are new (unchanged tariffs are skipped).
function redeploy(chargers, actor) {
  const out = [];
  for (const ch of chargers) {
    const before = state.pricingDeployments.find((d) => d.chargerId === ch.id && d.current);
    const dep = deployToCharger(ch, actor);
    if (dep && dep !== before) out.push(dep);
  }
  return out;
}

function affectedChargers(a) {
  if (a.scope === 'global') return state.chargers;
  if (a.scope === 'location') return state.chargers.filter((c) => c.locationId === a.targetId);
  if (a.scope === 'group') return state.chargers.filter((c) => c.groupIds.includes(a.targetId));
  if (a.scope === 'charger') return state.chargers.filter((c) => c.id === a.targetId);
  const conn = byId(state.connectors, a.targetId);
  return conn ? state.chargers.filter((c) => c.id === conn.chargerId) : [];
}

function activateAssignment(a, actor) {
  state.pricingAssignments
    .filter((x) => x.id !== a.id && x.status === 'active' && x.scope === a.scope && x.targetId === a.targetId)
    .forEach((x) => { x.status = 'superseded'; x.endedAt = now(); });
  a.status = 'active';
  a.activatedAt = now();
  return redeploy(affectedChargers(a), actor);
}

function scopeLabel(scope, targetId) {
  if (scope === 'global') return 'Whole network';
  const src = { location: state.locations, group: state.groups, charger: state.chargers }[scope];
  if (src) return (byId(src, targetId) || {}).name || targetId;
  const c = byId(state.connectors, targetId);
  return c ? `${(byId(state.chargers, c.chargerId) || {}).name} · ${c.label}` : targetId;
}

/* ------------------------------------------------------------ availability */

function refreshLimitAlert() {
  const snap = limitSnapshot(state);
  if (snap.over > 0) {
    raiseAlert({ type: 'limit_violation', severity: 'warning', message: `${snap.enabled} connectors are enabled but the operational limit is ${snap.max}. Restrict ${snap.over} more; active sessions are not stopped.` });
  } else {
    autoResolve('limit_violation', null, undefined, 'Enabled connectors are back within the limit.');
  }
}

function requestAvailabilityAs(actor, { connectorIds, action, reason = '', maintenance = false, override = false }) {
  need('availability.manage', actor);
  if (!['enable', 'restrict'].includes(action)) throw new Error('Unknown availability action.');
  const ids = [...new Set(connectorIds || [])];
  if (!ids.length) throw new Error('Select at least one connector.');
  if (ids.length > 1) need('bulk.execute', actor);
  const { policy } = state.settings.operationalLimit;
  const canOverride = override && policy === 'warn' && hasPerm(state.settings.rolePermissions, actor.role, 'limits.override');
  let headroom = limitSnapshot(state).headroom;
  const results = ids.map((id) => {
    const c = byId(state.connectors, id);
    if (!c) return { connectorId: id, chargerId: null, outcome: 'failed', message: 'Connector not found.' };
    const base = { connectorId: c.id, chargerId: c.chargerId };
    if (hasActiveCommand(state, c.id)) return { ...base, outcome: 'skipped', message: 'Another command is still pending for this connector.' };
    if (action === 'enable') {
      if (c.enabled && !c.pendingInoperative) return { ...base, outcome: 'noop', message: 'Already enabled.' };
      if (!c.enabled) {
        if (headroom <= 0 && !canOverride) return { ...base, outcome: 'blocked_limit', message: `Operational limit of ${state.settings.operationalLimit.maxEnabledConnectors} enabled connectors reached.` };
        headroom -= 1;
      }
      const cmd = createCommand(actor, { chargerId: c.chargerId, connectorId: c.id, type: 'ChangeAvailability', payload: { connectorId: c.connectorId, type: 'Operative', reason } });
      return { ...base, outcome: 'submitted', commandId: cmd.id };
    }
    if (!c.enabled) {
      if (c.maintenance !== maintenance) { c.maintenance = maintenance; return { ...base, outcome: 'updated', message: maintenance ? 'Marked as maintenance (already restricted).' : 'Maintenance flag cleared (still restricted).' }; }
      return { ...base, outcome: 'noop', message: 'Already restricted.' };
    }
    const cmd = createCommand(actor, { chargerId: c.chargerId, connectorId: c.id, type: 'ChangeAvailability', payload: { connectorId: c.connectorId, type: 'Inoperative', maintenance, reason } });
    return { ...base, outcome: 'submitted', commandId: cmd.id };
  });
  const submitted = results.filter((r) => r.outcome === 'submitted').length;
  audit(actor, action === 'enable' ? 'availability.enable' : 'availability.restrict', 'connector', ids.length === 1 ? ids[0] : `${ids.length} connectors`,
    ids.length === 1 ? scopeLabel('connector', ids[0]) : `${ids.length} connectors`, null,
    { action, maintenance, submitted, blockedByLimit: results.filter((r) => r.outcome === 'blocked_limit').length, override: canOverride },
    reason || (canOverride ? 'Limit override used' : ''));
  return { results };
}

/* --------------------------------------------------------------------- tick */

const FAULT_CODES = ['GroundFailure', 'OverCurrentFailure', 'HighTemperature', 'EVCommunicationError', 'PowerSwitchFailure'];

function tick(dtSec) {
  const t = now();
  const rnd = simConfig.random;
  for (const ch of state.chargers) {
    if (!ch.online) continue;
    if (t - ch.lastHeartbeat >= state.settings.heartbeatIntervalSec * 1000) { ch.lastHeartbeat = t; emit('charger:heartbeat', { chargerId: ch.id }); }
    if (simConfig.autoEvents && rnd() < 0.0006) {
      setOnline(ch, false, 'simulated network drop');
      later(25000, () => setOnline(ch, true, 'reconnected'));
    }
  }
  for (const c of state.connectors) {
    const ch = byId(state.chargers, c.chargerId);
    if (!ch || !ch.online) continue;
    if (c.sessionId) {
      const s = byId(state.sessions, c.sessionId);
      if (!s) { c.sessionId = null; continue; }
      c.powerKw = Math.max(5, Math.min(c.maxPowerKw, Math.round((c.powerKw + (rnd() - 0.5) * 3) * 10) / 10));
      const dKwh = (c.powerKw * dtSec) / 3600;
      c.meterWh += dKwh * 1000;
      s.energyKwh += dKwh;
      const res = resolvePricing(state, ch, c);
      s.energyCost += dKwh * rateAt(res ? res.rule : null, new Date(t)).total;
      s.cost = sessionCost(s, t);
      ch.lastHeartbeat = t; // MeterValues also prove the link is alive
      if (s.energyKwh >= s.targetKwh) endSession(c, 'Local');
    } else if (simConfig.autoEvents) {
      if (c.status === 'Available' && c.enabled && rnd() < 0.01) startSession(c, `SIM-TAG-${1000 + Math.floor(rnd() * 9000)}`, 'local authorisation');
      else if (c.status === 'Available' && rnd() < 0.0004) { setFault(c, FAULT_CODES[Math.floor(rnd() * FAULT_CODES.length)]); later(30000, () => clearFault(c)); }
    }
  }
  for (const a of state.pricingAssignments) {
    if (a.status === 'scheduled' && a.effectiveAt <= t) {
      activateAssignment(a, SYSTEM);
      audit(SYSTEM, 'pricing.scheduled_activated', 'pricing_assignment', a.id, `${(byId(state.pricingRules, a.ruleId) || {}).name} → ${scopeLabel(a.scope, a.targetId)}`, null, null, `Scheduled by ${a.createdBy}`);
    }
  }
  for (const op of state.scheduledOps) {
    if (op.status !== 'scheduled' || op.runAt > t) continue;
    try {
      const actor = byId(state.users, op.createdById) || SYSTEM;
      op.result = requestAvailabilityAs({ ...actor, name: `${actor.name} (scheduled)` }, op.payload).results;
      op.status = 'executed';
    } catch (e) {
      op.status = 'failed';
      op.error = e.message;
    }
    op.executedAt = t;
  }
  commit();
}

export function startSimulation(intervalMs = 2000) {
  if (tickHandle) return;
  tickHandle = setInterval(() => tick(intervalMs / 1000), intervalMs);
}
export function stopSimulation() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
}
export const _tickForTests = tick;

/* ------------------------------------------------------------------ actions */

function ruleFromInput(input) {
  const num = (v) => Number(v);
  const periods = (list) => (list || []).map((p) => ({ id: p.id || makeId(state, 'per'), start: p.start, energyPrice: num(p.energyPrice), servicePrice: num(p.servicePrice), kind: p.kind || 'standard' }));
  const rule = {
    name: clean(input.name), description: clean(input.description), periods: periods(input.periods),
    weekendPeriods: input.weekendPeriods && input.weekendPeriods.length ? periods(input.weekendPeriods) : null,
    flatFee: num(input.flatFee || 0), hourPrice: num(input.hourPrice || 0), preauthAmount: num(input.preauthAmount || 0),
  };
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join(' '));
  return rule;
}

function chargerFields(input, existing) {
  const out = {};
  const name = clean(input.name);
  const ocppId = clean(input.ocppId);
  if (!name) throw new Error('Charger name is required.');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(ocppId)) throw new Error('OCPP identity must be 3-40 characters: letters, digits, dot, dash or underscore.');
  if (state.chargers.some((c) => c.ocppId.toLowerCase() === ocppId.toLowerCase() && (!existing || c.id !== existing.id))) throw new Error(`OCPP identity "${ocppId}" is already registered.`);
  if (!byId(state.locations, input.locationId)) throw new Error('Choose a location.');
  Object.assign(out, { name, ocppId, serial: clean(input.serial), model: clean(input.model), manufacturer: clean(input.manufacturer), locationId: input.locationId });
  return out;
}

export const actions = {
  /* auth (demo mode has no credentials) */
  login(userId) {
    const u = byId(state.users, userId);
    if (!u) throw new Error('Unknown user.');
    if (!u.active) throw new Error('This account is deactivated.');
    currentUserId = u.id;
    u.lastLoginAt = now();
    audit(u, 'auth.login', 'user', u.id, u.name, null, null, 'Simulated sign-in');
    commit();
    return u;
  },
  logout() {
    const u = getCurrentUser();
    if (u) audit(u, 'auth.logout', 'user', u.id, u.name);
    currentUserId = null;
    commit();
  },

  /* chargers */
  createCharger(input) {
    const actor = me(); need('chargers.manage', actor);
    const fields = chargerFields(input, null);
    const count = Math.max(1, Math.min(4, Number(input.connectorCount) || 2));
    const kw = Number(input.ratedPowerKw) > 0 ? Number(input.ratedPowerKw) : null;
    const id = makeId(state, 'chg');
    const ch = {
      id, ...fields, firmware: '', ocppVersion: '1.6J', groupIds: [], online: false, everConnected: false, lastHeartbeat: null, bootedAt: null,
      capabilities: { changeAvailability: 'unverified', remoteStartStop: 'unverified', configuration: 'unverified', reset: 'unverified', smartCharging: 'unverified', tariffSync: 'unverified' },
      hardware: { ratedPowerKw: kw, powerSharing: 'unknown', maxTariffPeriods: 4, notes: clean(input.notes) },
      sim: { flaky: false }, simulated: true, createdAt: now(),
    };
    state.chargers.push(ch);
    for (let k = 1; k <= count; k += 1) {
      state.connectors.push({
        id: `${id}-${k}`, chargerId: id, connectorId: k, label: `${String.fromCharCode(64 + k)} GUN`, type: 'CCS2', maxPowerKw: kw || 0,
        // New connectors start restricted so registering a charger can never breach the operational limit.
        enabled: false, maintenance: false, status: 'Unavailable', errorCode: 'NoError', errorInfo: '', powerKw: 0, meterWh: 0, sessionId: null,
        pendingInoperative: false, pendingMaintenance: false, simulated: true,
      });
    }
    audit(actor, 'charger.create', 'charger', id, ch.name, null, { ocppId: ch.ocppId, connectors: count });
    commit();
    return ch;
  },
  updateCharger(id, input) {
    const actor = me(); need('chargers.manage', actor);
    const ch = getCharger(id);
    const before = { name: ch.name, ocppId: ch.ocppId, serial: ch.serial, model: ch.model, manufacturer: ch.manufacturer, locationId: ch.locationId, capabilities: { ...ch.capabilities }, hardware: { ...ch.hardware } };
    Object.assign(ch, chargerFields(input, ch));
    if (input.capabilities) for (const k of Object.keys(ch.capabilities)) if (['verified', 'unverified', 'unsupported'].includes(input.capabilities[k])) ch.capabilities[k] = input.capabilities[k];
    if (input.hardware) {
      const h = input.hardware;
      ch.hardware = {
        ratedPowerKw: Number(h.ratedPowerKw) > 0 ? Number(h.ratedPowerKw) : null,
        powerSharing: ['unknown', 'shared', 'independent'].includes(h.powerSharing) ? h.powerSharing : 'unknown',
        maxTariffPeriods: Math.max(1, Math.min(48, Number(h.maxTariffPeriods) || 4)),
        notes: clean(h.notes),
      };
    }
    audit(actor, 'charger.update', 'charger', id, ch.name, before, { name: ch.name, ocppId: ch.ocppId, serial: ch.serial, model: ch.model, manufacturer: ch.manufacturer, locationId: ch.locationId, capabilities: { ...ch.capabilities }, hardware: { ...ch.hardware } });
    commit();
    return ch;
  },
  deleteCharger(id) {
    const actor = me(); need('chargers.delete', actor);
    const ch = getCharger(id);
    if (state.connectors.some((c) => c.chargerId === id && c.sessionId)) throw new Error('This charger has a session in progress and cannot be deleted.');
    state.chargers = state.chargers.filter((c) => c.id !== id);
    state.connectors = state.connectors.filter((c) => c.chargerId !== id);
    state.pricingAssignments.filter((a) => a.status !== 'superseded' && ((a.scope === 'charger' && a.targetId === id) || (a.scope === 'connector' && String(a.targetId).startsWith(`${id}-`)))).forEach((a) => { a.status = 'removed'; a.endedAt = now(); });
    audit(actor, 'charger.delete', 'charger', id, ch.name, { ocppId: ch.ocppId, serial: ch.serial }, null);
    refreshLimitAlert();
    commit();
  },
  updateConnector(id, input) {
    const actor = me(); need('chargers.manage', actor);
    const c = getConnector(id);
    const before = { label: c.label, type: c.type, maxPowerKw: c.maxPowerKw };
    if (!clean(input.label)) throw new Error('Connector label is required.');
    c.label = clean(input.label);
    c.type = clean(input.type) || c.type;
    c.maxPowerKw = Number(input.maxPowerKw) >= 0 ? Number(input.maxPowerKw) : c.maxPowerKw;
    audit(actor, 'connector.update', 'connector', id, scopeLabel('connector', id), before, { label: c.label, type: c.type, maxPowerKw: c.maxPowerKw });
    commit();
  },
  bulkAssignLocation(chargerIds, locationId) {
    const actor = me(); need('chargers.manage', actor); need('bulk.execute', actor);
    const loc = byId(state.locations, locationId);
    if (!loc) throw new Error('Choose a location.');
    const results = chargerIds.map((id) => {
      const ch = byId(state.chargers, id);
      if (!ch) return { chargerId: id, outcome: 'failed', message: 'Charger not found.' };
      if (ch.locationId === locationId) return { chargerId: id, outcome: 'noop', message: 'Already at this location.' };
      ch.locationId = locationId;
      return { chargerId: id, outcome: 'done', message: `Moved to ${loc.name}.` };
    });
    audit(actor, 'charger.bulk_location', 'location', locationId, loc.name, null, { chargers: chargerIds.length });
    commit();
    return { results };
  },
  bulkAssignGroup(chargerIds, groupId) {
    const actor = me(); need('groups.manage', actor); need('bulk.execute', actor);
    const g = byId(state.groups, groupId);
    if (!g) throw new Error('Choose a group.');
    const results = chargerIds.map((id) => {
      const ch = byId(state.chargers, id);
      if (!ch) return { chargerId: id, outcome: 'failed', message: 'Charger not found.' };
      if (ch.groupIds.includes(groupId)) return { chargerId: id, outcome: 'noop', message: 'Already in this group.' };
      ch.groupIds.push(groupId);
      return { chargerId: id, outcome: 'done', message: `Added to ${g.name}.` };
    });
    audit(actor, 'group.bulk_add', 'group', groupId, g.name, null, { chargers: chargerIds.length });
    commit();
    return { results };
  },

  /* locations */
  saveLocation(input) {
    const actor = me(); need('locations.manage', actor);
    if (!clean(input.name)) throw new Error('Location name is required.');
    const data = { name: clean(input.name), address: clean(input.address), city: clean(input.city), notes: clean(input.notes) };
    if (input.id) {
      const loc = byId(state.locations, input.id);
      if (!loc) throw new Error('Location not found.');
      const before = { ...loc };
      Object.assign(loc, data);
      audit(actor, 'location.update', 'location', loc.id, loc.name, before, { ...loc });
    } else {
      const loc = { id: makeId(state, 'loc'), ...data };
      state.locations.push(loc);
      audit(actor, 'location.create', 'location', loc.id, loc.name, null, data);
    }
    commit();
  },
  deleteLocation(id) {
    const actor = me(); need('locations.manage', actor);
    const loc = byId(state.locations, id);
    if (!loc) throw new Error('Location not found.');
    if (state.chargers.some((c) => c.locationId === id)) throw new Error('Move or delete the chargers at this location first.');
    state.locations = state.locations.filter((l) => l.id !== id);
    audit(actor, 'location.delete', 'location', id, loc.name, { ...loc }, null);
    commit();
  },

  /* groups */
  saveGroup(input) {
    const actor = me(); need('groups.manage', actor);
    if (!clean(input.name)) throw new Error('Group name is required.');
    const data = { name: clean(input.name), description: clean(input.description), locationId: input.locationId || null, availabilityPolicy: clean(input.availabilityPolicy) };
    let g;
    if (input.id) {
      g = byId(state.groups, input.id);
      if (!g) throw new Error('Group not found.');
      Object.assign(g, data);
    } else {
      g = { id: makeId(state, 'grp'), ...data };
      state.groups.push(g);
    }
    if (Array.isArray(input.chargerIds)) {
      for (const ch of state.chargers) {
        const want = input.chargerIds.includes(ch.id);
        const has = ch.groupIds.includes(g.id);
        if (want && !has) ch.groupIds.push(g.id);
        if (!want && has) ch.groupIds = ch.groupIds.filter((x) => x !== g.id);
      }
    }
    audit(actor, input.id ? 'group.update' : 'group.create', 'group', g.id, g.name, null, { ...data, chargers: (input.chargerIds || []).length });
    commit();
    return g;
  },
  deleteGroup(id) {
    const actor = me(); need('groups.manage', actor);
    const g = byId(state.groups, id);
    if (!g) throw new Error('Group not found.');
    const members = state.chargers.filter((ch) => ch.groupIds.includes(id));
    state.groups = state.groups.filter((x) => x.id !== id);
    members.forEach((ch) => { ch.groupIds = ch.groupIds.filter((x) => x !== id); });
    const touched = state.pricingAssignments.filter((a) => a.scope === 'group' && a.targetId === id && ['active', 'scheduled'].includes(a.status));
    touched.forEach((a) => { a.status = 'removed'; a.endedAt = now(); });
    if (touched.length) redeploy(members, actor); // members fall back to their location / network tariff
    audit(actor, 'group.delete', 'group', id, g.name, { ...g }, null);
    commit();
  },

  /* availability + operational limit */
  requestAvailability(args) {
    const out = requestAvailabilityAs(me(), args);
    commit();
    return out;
  },
  setOperationalLimit({ maxEnabledConnectors, policy }) {
    const actor = me(); need('limits.manage', actor);
    const max = Number(maxEnabledConnectors);
    if (!Number.isInteger(max) || max < 0) throw new Error('The limit must be a whole number, zero or higher.');
    if (!['block', 'warn'].includes(policy)) throw new Error('Unknown policy.');
    const before = { ...state.settings.operationalLimit };
    state.settings.operationalLimit = { ...before, maxEnabledConnectors: max, policy };
    audit(actor, 'limit.update', 'settings', 'operationalLimit', 'Operational limit', before, { ...state.settings.operationalLimit });
    refreshLimitAlert();
    commit();
    return limitSnapshot(state);
  },
  scheduleAvailability({ connectorIds, action, runAt, reason = '', maintenance = false }) {
    const actor = me(); need('availability.manage', actor);
    if (!connectorIds || !connectorIds.length) throw new Error('Select at least one connector.');
    if (!(Number(runAt) > now())) throw new Error('Choose a time in the future.');
    const op = { id: makeId(state, 'op'), type: 'availability', runAt: Number(runAt), payload: { connectorIds: [...connectorIds], action, reason, maintenance }, status: 'scheduled', createdBy: actor.name, createdById: actor.id, createdAt: now(), executedAt: null, result: null, error: null };
    state.scheduledOps.unshift(op);
    audit(actor, 'availability.schedule', 'scheduled_operation', op.id, `${action} ${connectorIds.length} connector(s)`, null, { runAt: op.runAt, action, connectors: connectorIds.length }, reason);
    commit();
    return op;
  },
  cancelScheduledOp(id) {
    const actor = me(); need('availability.manage', actor);
    const op = byId(state.scheduledOps, id);
    if (!op || op.status !== 'scheduled') throw new Error('Only operations that have not run yet can be cancelled.');
    op.status = 'cancelled';
    audit(actor, 'availability.schedule_cancel', 'scheduled_operation', id, `${op.payload.action} ${op.payload.connectorIds.length} connector(s)`);
    commit();
  },

  /* commands */
  sendCommand({ chargerId, connectorId = null, type }) {
    const actor = me(); need('commands.remote', actor);
    const ch = getCharger(chargerId);
    const c = connectorId ? getConnector(connectorId) : null;
    if (!['RemoteStartTransaction', 'RemoteStopTransaction', 'Reset', 'GetConfiguration'].includes(type)) throw new Error('Unknown command type.');
    let payload = {};
    if (type === 'RemoteStartTransaction') {
      if (!c) throw new Error('Choose a connector.');
      payload = { connectorId: c.connectorId, idTag: `CMS-${actor.id}` };
    } else if (type === 'RemoteStopTransaction') {
      if (!c || !c.sessionId) throw new Error('There is no session to stop on this connector.');
      payload = { transactionId: byId(state.sessions, c.sessionId).transactionId };
    } else if (type === 'Reset') {
      if (connectorsOf(state, ch.id).some((x) => x.sessionId)) throw new Error('A reset would interrupt a session in progress. Wait for it to end or stop it first.');
      payload = { type: 'Soft' };
    }
    const cmd = createCommand(actor, { chargerId: ch.id, connectorId: c ? c.id : null, type, payload });
    audit(actor, 'command.submit', 'command', cmd.id, `${type} → ${ch.name}${c ? ` · ${c.label}` : ''}`, null, payload);
    commit();
    return cmd;
  },
  retryCommand(id) {
    const actor = me();
    const old = byId(state.commands, id);
    if (!old) throw new Error('Command not found.');
    if (!['failed', 'timed_out', 'cancelled'].includes(old.status)) throw new Error('Only failed, timed-out or cancelled commands can be retried.');
    need({ ChangeAvailability: 'availability.manage', SetTariff: 'pricing.manage' }[old.type] || 'commands.remote', actor);
    if (old.type === 'ChangeAvailability') {
      const c = getConnector(old.connectorId);
      const out = requestAvailabilityAs(actor, { connectorIds: [c.id], action: old.payload.type === 'Operative' ? 'enable' : 'restrict', maintenance: old.payload.maintenance, reason: `Retry of ${old.id}` });
      commit();
      const r = out.results[0];
      if (r.outcome !== 'submitted') throw new Error(r.message);
      return byId(state.commands, r.commandId);
    }
    if (old.type === 'SetTariff') {
      const dep = deployToCharger(getCharger(old.chargerId), actor);
      // Force a fresh push even if the deployment record is unchanged.
      if (dep && dep.commandId === old.id) {
        dep.stage = 'stored';
        const cmd = createCommand(actor, { chargerId: old.chargerId, type: 'SetTariff', payload: old.payload, meta: { deploymentId: dep.id } });
        dep.commandId = cmd.id;
      }
      audit(actor, 'command.retry', 'command', old.id, `SetTariff → ${getCharger(old.chargerId).name}`);
      commit();
      return dep;
    }
    return actions.sendCommand({ chargerId: old.chargerId, connectorId: old.connectorId, type: old.type });
  },
  cancelCommand(id) {
    const actor = me();
    const cmd = byId(state.commands, id);
    if (!cmd) throw new Error('Command not found.');
    need({ ChangeAvailability: 'availability.manage', SetTariff: 'pricing.manage' }[cmd.type] || 'commands.remote', actor);
    if (cmd.status !== 'pending') throw new Error('Only commands that have not been sent yet can be cancelled.');
    finish(cmd, 'cancelled', { error: `Cancelled by ${actor.name}.` });
    audit(actor, 'command.cancel', 'command', id, cmd.type);
    commit();
  },

  /* pricing */
  saveRule(input) {
    const actor = me(); need('pricing.manage', actor);
    const data = ruleFromInput(input);
    if (state.pricingRules.some((r) => r.name.toLowerCase() === data.name.toLowerCase() && r.id !== input.id)) throw new Error(`A tariff named "${data.name}" already exists.`);
    if (!input.id) {
      const rule = { id: makeId(state, 'rule'), version: 1, ...data, createdAt: now(), updatedAt: now() };
      state.pricingRules.push(rule);
      audit(actor, 'pricing.rule_create', 'pricing_rule', rule.id, rule.name, null, data);
      commit();
      return { rule, deployments: [] };
    }
    const rule = byId(state.pricingRules, input.id);
    if (!rule) throw new Error('Tariff not found.');
    const before = { name: rule.name, periods: rule.periods, weekendPeriods: rule.weekendPeriods, flatFee: rule.flatFee, hourPrice: rule.hourPrice, preauthAmount: rule.preauthAmount };
    Object.assign(rule, data, { version: rule.version + 1, updatedAt: now() });
    audit(actor, 'pricing.rule_update', 'pricing_rule', rule.id, rule.name, before, data, `Version ${rule.version}`);
    // Every charger currently using this tariff needs the new version pushed (where it can be).
    const deployments = redeploy(state.chargers.filter((ch) => { const r = resolvePricing(state, ch, null); return r && r.rule.id === rule.id; }), actor);
    commit();
    return { rule, deployments };
  },
  deleteRule(id) {
    const actor = me(); need('pricing.manage', actor);
    const rule = byId(state.pricingRules, id);
    if (!rule) throw new Error('Tariff not found.');
    if (state.pricingAssignments.some((a) => a.ruleId === id && ['active', 'scheduled'].includes(a.status))) throw new Error('This tariff is assigned or scheduled. Remove those assignments first.');
    state.pricingRules = state.pricingRules.filter((r) => r.id !== id);
    audit(actor, 'pricing.rule_delete', 'pricing_rule', id, rule.name, { name: rule.name }, null);
    commit();
  },
  assignPricing({ ruleId, scope, targetIds = [], effectiveAt = null }) {
    const actor = me(); need('pricing.manage', actor);
    const rule = byId(state.pricingRules, ruleId);
    if (!rule) throw new Error('Choose a tariff.');
    if (!['global', 'location', 'group', 'charger', 'connector'].includes(scope)) throw new Error('Unknown scope.');
    const targets = scope === 'global' ? [null] : [...new Set(targetIds)];
    if (!targets.length) throw new Error('Choose at least one target.');
    if (targets.length > 1) need('bulk.execute', actor);
    const future = effectiveAt && Number(effectiveAt) > now() + 1000;
    const assignments = [];
    const deployments = [];
    for (const targetId of targets) {
      const a = { id: makeId(state, 'asg'), ruleId, scope, targetId, status: future ? 'scheduled' : 'active', effectiveAt: future ? Number(effectiveAt) : now(), activatedAt: null, createdAt: now(), createdBy: actor.name };
      state.pricingAssignments.unshift(a);
      assignments.push(a);
      if (!future) activateAssignment(a, actor).forEach((d) => { if (!deployments.includes(d)) deployments.push(d); });
    }
    audit(actor, future ? 'pricing.schedule' : (targets.length > 1 ? 'pricing.bulk_assign' : 'pricing.assign'), 'pricing_assignment', assignments.length === 1 ? assignments[0].id : `${assignments.length} assignments`,
      `${rule.name} → ${targets.length === 1 ? scopeLabel(scope, targets[0]) : `${targets.length} ${scope}s`}`, null, { rule: rule.name, scope, targets: targets.length, effectiveAt: future ? Number(effectiveAt) : 'now' });
    commit();
    return { assignments, deployments };
  },
  cancelAssignment(id) {
    const actor = me(); need('pricing.manage', actor);
    const a = byId(state.pricingAssignments, id);
    if (!a) throw new Error('Assignment not found.');
    if (a.scope === 'global' && a.status === 'active') throw new Error('The network default cannot be removed. Assign a different tariff to the whole network instead.');
    if (!['active', 'scheduled'].includes(a.status)) throw new Error('This assignment is no longer active.');
    const wasActive = a.status === 'active';
    const chargers = wasActive ? affectedChargers(a) : [];
    a.status = wasActive ? 'removed' : 'cancelled';
    a.endedAt = now();
    const deployments = redeploy(chargers, actor);
    audit(actor, wasActive ? 'pricing.unassign' : 'pricing.schedule_cancel', 'pricing_assignment', id, `${(byId(state.pricingRules, a.ruleId) || {}).name} → ${scopeLabel(a.scope, a.targetId)}`);
    commit();
    return { deployments };
  },

  /* alerts */
  acknowledgeAlert(id) {
    const actor = me(); need('alerts.manage', actor);
    const a = byId(state.alerts, id);
    if (!a || a.status !== 'open') throw new Error('Only open alerts can be acknowledged.');
    a.status = 'acknowledged'; a.acknowledgedBy = actor.name; a.acknowledgedAt = now();
    commit();
  },
  resolveAlert(id, note) {
    const actor = me(); need('alerts.manage', actor);
    const a = byId(state.alerts, id);
    if (!a || a.status === 'resolved') throw new Error('This alert is already resolved.');
    if (!a.acknowledgedBy) { a.acknowledgedBy = actor.name; a.acknowledgedAt = now(); }
    a.status = 'resolved'; a.resolvedAt = now(); a.resolutionNote = clean(note) || `Resolved by ${actor.name}.`;
    commit();
  },

  /* users + settings */
  saveUser(input) {
    const actor = me(); need('users.manage', actor);
    const name = clean(input.name);
    const email = clean(input.email).toLowerCase();
    if (!name) throw new Error('Name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
    if (!['admin', 'operator', 'viewer'].includes(input.role)) throw new Error('Choose a role.');
    if (state.users.some((u) => u.email === email && u.id !== input.id)) throw new Error('A user with this email already exists.');
    if (input.id) {
      const u = byId(state.users, input.id);
      if (!u) throw new Error('User not found.');
      const before = { name: u.name, email: u.email, role: u.role, active: u.active };
      const active = input.active !== false;
      const losingAdmin = u.role === 'admin' && u.active && (input.role !== 'admin' || !active);
      if (losingAdmin && state.users.filter((x) => x.role === 'admin' && x.active).length <= 1) throw new Error('At least one active admin is required.');
      Object.assign(u, { name, email, role: input.role, active });
      audit(actor, before.role !== u.role ? 'user.role_change' : 'user.update', 'user', u.id, u.name, before, { name, email, role: u.role, active });
    } else {
      const u = { id: makeId(state, 'usr'), name, email, role: input.role, active: true, createdAt: now(), lastLoginAt: null };
      state.users.push(u);
      audit(actor, 'user.create', 'user', u.id, u.name, null, { name, email, role: u.role });
    }
    commit();
  },
  setRolePermissions(role, perms) {
    const actor = me(); need('users.manage', actor);
    if (!['operator', 'viewer'].includes(role)) throw new Error('Admin permissions are fixed. Only operator and viewer can be changed.');
    const next = ALL_PERMISSIONS.filter((p) => perms.includes(p));
    const before = [...state.settings.rolePermissions[role]];
    state.settings.rolePermissions[role] = next;
    audit(actor, 'permission.update', 'role', role, role, before, next);
    commit();
  },
  updateSettings(input) {
    const actor = me(); need('settings.manage', actor);
    const s = state.settings;
    const before = { orgName: s.orgName, currency: s.currency, timezone: s.timezone, commandTimeoutSec: s.commandTimeoutSec, heartbeatIntervalSec: s.heartbeatIntervalSec };
    const currency = clean(input.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a 3-letter code, e.g. RWF.');
    const timeout = Number(input.commandTimeoutSec);
    const hb = Number(input.heartbeatIntervalSec);
    if (!(timeout >= 3 && timeout <= 300)) throw new Error('Command timeout must be between 3 and 300 seconds.');
    if (!(hb >= 5 && hb <= 3600)) throw new Error('Heartbeat interval must be between 5 and 3600 seconds.');
    if (!clean(input.orgName)) throw new Error('Organisation name is required.');
    Object.assign(s, { orgName: clean(input.orgName), currency, timezone: clean(input.timezone) || s.timezone, commandTimeoutSec: timeout, heartbeatIntervalSec: hb });
    audit(actor, 'settings.update', 'settings', 'system', 'System settings', before, { orgName: s.orgName, currency, timezone: s.timezone, commandTimeoutSec: timeout, heartbeatIntervalSec: hb });
    commit();
  },

  /* simulator controls (development only; these do not exist in the real API) */
  simSetOnline(chargerId, online) {
    me();
    setOnline(getCharger(chargerId), online, 'simulator control');
    commit();
  },
  simFault(connectorId, on) {
    me();
    const c = getConnector(connectorId);
    if (on) setFault(c, 'OtherError'); else clearFault(c);
    commit();
  },
  simPlug(connectorId) {
    me();
    const c = getConnector(connectorId);
    const ch = getCharger(c.chargerId);
    if (!ch.online) throw new Error('Simulated charger is offline.');
    if (c.sessionId) endSession(c, 'EVDisconnected');
    else if (c.status === 'Available' && c.enabled) startSession(c, `SIM-TAG-${1000 + Math.floor(simConfig.random() * 9000)}`, 'simulator control');
    else throw new Error('Connector is not available, so a vehicle cannot start charging.');
    commit();
  },
  resetDemo() {
    const actor = me(); need('settings.manage', actor);
    const role = actor.role;
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    state = buildSeed();
    currentUserId = (state.users.find((u) => u.role === role) || state.users[0]).id;
    commit();
  },
};
