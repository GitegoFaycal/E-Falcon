// The domain engine: every rule of the CMS in one place, independent of HTTP, sockets and SQL.
//
//   actions.*   what operators can do (called by the REST layer with an authenticated actor)
//   ocpp.*      what chargers tell us (called by the OCPP gateway)
//   tick()      the scheduler (scheduled price and availability changes)
//
// State is held in memory and written through to the database after every call (db/store.js).
// All state changes here are synchronous, so checks such as the operational limit cannot be
// interleaved with another request. Talking to a charger is the only asynchronous step, and a
// connector, price or command is only ever marked as changed after the charger has replied.
import crypto from 'node:crypto';
import { rateAt, validateRule } from '../shared/tariff.js';
import { hasPerm, ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../shared/permissions.js';
import { ACTIVE_COMMAND_STATUSES } from '../shared/status.js';
import { byId, resolvePricing, limitSnapshot, hasActiveCommand, connectorsOf } from '../shared/selectors.js';
import { hashPassword, hashKey, verifyKey } from './secrets.js';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export class OcppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message, status = 400) => { throw new AppError(message, status); };

const PREFIX = { cmd: 'CMD', ses: 'S', alr: 'ALR', evt: 'EVT', aud: 'AUD', dep: 'DEP', asg: 'ASG', rule: 'TAR', op: 'OP', chg: 'CH', loc: 'LOC', grp: 'GRP', usr: 'USR', per: 'P' };
const SYSTEM = { id: 'system', name: 'System (scheduler)', role: 'admin', active: true };
const CHARGER = { id: 'charger', name: 'Charger', role: 'admin', active: true };
const DEFAULT_CAPABILITIES = { changeAvailability: 'unverified', remoteStartStop: 'unverified', configuration: 'unverified', reset: 'unverified', smartCharging: 'unverified', tariffSync: 'unverified' };

export const DEFAULT_SETTINGS = {
  orgName: 'E-Falcon', currency: 'RWF', timezone: 'Africa/Kigali', commandTimeoutSec: 30, heartbeatIntervalSec: 60,
  operationalLimit: { maxEnabledConnectors: 100, policy: 'block', stopSessionsOnReduce: false },
  rolePermissions: DEFAULT_ROLE_PERMISSIONS,
  // How a tariff reaches a charger. OCPP 1.6 has no standard tariff message, so the default is
  // "none": the CMS price is used for billing calculation and nothing is sent to the unit.
  tariffIntegration: { method: 'none', vendorId: '', messageId: 'SetTariff' },
};

const CAPABILITY_FOR = { ChangeAvailability: 'changeAvailability', RemoteStartTransaction: 'remoteStartStop', RemoteStopTransaction: 'remoteStartStop', GetConfiguration: 'configuration', Reset: 'reset', SetTariff: 'tariffSync' };
// Only commands that are safe to repeat are retried automatically after a timeout.
const AUTO_RETRY = { ChangeAvailability: 2, GetConfiguration: 2, SetTariff: 2 };
const FAILED_STOP_REASONS = ['EmergencyStop', 'PowerLoss', 'Other', 'Reboot', 'HardReset', 'SoftReset'];
const OCCUPYING = ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];

export function createEngine({ state, transport, now = () => Date.now(), onDirty = () => {}, appendRow = () => {}, log = () => {} }) {
  let actor = null;

  /* ------------------------------------------------------------ helpers */

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (state.settings[k] === undefined) state.settings[k] = JSON.parse(JSON.stringify(v));
  state.seq = state.seq || {};

  function makeId(kind) {
    state.seq[kind] = (state.seq[kind] || 0) + 1;
    return `${PREFIX[kind]}-${String(state.seq[kind]).padStart(kind === 'ses' || kind === 'cmd' ? 6 : 4, '0')}`;
  }
  const cap = (list, n) => { if (list.length > n) list.length = n; };
  const clean = (s) => String(s ?? '').trim();
  const me = () => actor || fail('You are not signed in.', 401);
  function need(perm, who = me()) {
    if (who.active === false) fail('This account is deactivated.', 401);
    if (!hasPerm(state.settings.rolePermissions, who.role, perm)) fail(`Permission denied (${perm}).`, 403);
  }
  const getCharger = (id) => byId(state.chargers, id) || fail('Charger not found.', 404);
  const getConnector = (id) => byId(state.connectors, id) || fail('Connector not found.', 404);
  // A Date whose local fields are the wall-clock time in the configured time zone, for tariff periods.
  function zoned(ts) {
    try { return new Date(new Date(ts).toLocaleString('en-US', { timeZone: state.settings.timezone })); } catch { return new Date(ts); }
  }

  function audit(who, action, entityType, entityId, entityLabel, before = null, after = null, details = '') {
    state.audit.unshift({ id: makeId('aud'), userId: who.id, userName: who.name, action, entityType, entityId, entityLabel, before, after, details, at: now() });
    cap(state.audit, 2000);
  }
  function addEvent(chargerId, connectorId, type, message) {
    state.events.unshift({ id: makeId('evt'), chargerId, connectorId, type, message, at: now() });
    cap(state.events, 800);
  }
  function raiseAlert({ type, severity, chargerId = null, connectorId = null, message }) {
    const dup = state.alerts.find((a) => a.status === 'open' && a.type === type && a.chargerId === chargerId && a.connectorId === connectorId);
    if (dup && ['charger_offline', 'connector_fault', 'limit_violation', 'state_mismatch', 'unknown_charger', 'abnormal_energy'].includes(type)) { dup.message = message; return dup; }
    const alert = { id: makeId('alr'), type, severity, chargerId, connectorId, message, createdAt: now(), status: 'open', acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, resolutionNote: '' };
    state.alerts.unshift(alert);
    cap(state.alerts, 1000);
    return alert;
  }
  function autoResolve(type, chargerId, connectorId, note) {
    state.alerts.filter((a) => a.status !== 'resolved' && a.type === type && a.chargerId === chargerId && (connectorId === undefined || a.connectorId === connectorId))
      .forEach((a) => { a.status = 'resolved'; a.resolvedAt = now(); a.resolutionNote = note; });
  }
  function scopeLabel(scope, targetId) {
    if (scope === 'global') return 'Whole network';
    const src = { location: state.locations, group: state.groups, charger: state.chargers }[scope];
    if (src) return (byId(src, targetId) || {}).name || targetId;
    const c = byId(state.connectors, targetId);
    return c ? `${(byId(state.chargers, c.chargerId) || {}).name} · ${c.label}` : targetId;
  }
  function refreshLimitAlert() {
    const snap = limitSnapshot(state);
    if (snap.over > 0) raiseAlert({ type: 'limit_violation', severity: 'warning', message: `${snap.enabled} connectors are enabled but the operational limit is ${snap.max}. Restrict ${snap.over} more; active sessions are not stopped.` });
    else autoResolve('limit_violation', null, undefined, 'Enabled connectors are back within the limit.');
  }

  /* ----------------------------------------------------------- sessions */

  const sessionCost = (s, at) => Math.round(s.energyCost + s.fees.flatFee + s.fees.hourPrice * (Math.max(0, at - s.startedAt) / 3600000));

  // Adds newly metered energy to a session at the tariff in force at that moment.
  function accrue(s, energyKwh, at) {
    if (energyKwh > s.energyKwh) {
      const ch = byId(state.chargers, s.chargerId);
      const c = byId(state.connectors, s.connectorId);
      const res = ch ? resolvePricing(state, ch, c) : null;
      s.energyCost += (energyKwh - s.energyKwh) * rateAt(res ? res.rule : null, zoned(at)).total;
      s.energyKwh = energyKwh;
    }
    s.cost = sessionCost(s, at);
  }

  /* ------------------------------------------------------- connectivity */

  function setOnline(ch, online, cause) {
    if (ch.online === online) return;
    ch.online = online;
    if (online) {
      ch.everConnected = true;
      ch.lastHeartbeat = now();
      addEvent(ch.id, null, 'connect', `OCPP connection opened (${cause})`);
      autoResolve('charger_offline', ch.id, undefined, 'Connection recovered.');
      if (state.alerts.some((a) => a.type === 'charger_offline' && a.chargerId === ch.id)) raiseAlert({ type: 'connection_recovered', severity: 'info', chargerId: ch.id, message: `${ch.name} is back online.` });
    } else {
      for (const c of connectorsOf(state, ch.id)) c.powerKw = 0;
      addEvent(ch.id, null, 'disconnect', `OCPP connection closed (${cause})`);
      raiseAlert({ type: 'charger_offline', severity: 'critical', chargerId: ch.id, message: `${ch.name} went offline (${cause}).` });
    }
  }

  /* ----------------------------------------------------------- commands */

  function createCommand(who, { chargerId, connectorId = null, type, payload = {}, meta = {} }) {
    const cmd = {
      id: makeId('cmd'), chargerId, connectorId, type, payload, meta, requestedBy: who.name, requestedById: who.id, requestedAt: now(),
      status: 'pending', sentAt: null, completedAt: null, response: null, error: null, resultCode: null, attempts: 0, maxAttempts: AUTO_RETRY[type] || 1,
    };
    state.commands.unshift(cmd);
    cap(state.commands, 2000);
    // Sent after the current call has been persisted, so a command row always exists before any reply.
    setImmediate(() => { dispatch(cmd).catch((e) => log('dispatch error', e)); });
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
      if (status === 'successful') { dep.stage = 'confirmed'; dep.detail = 'The charger replied "Accepted" to the tariff message. Check the price on the touchscreen before treating the integration as verified.'; }
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
  }

  // Translates a CMS command into the OCPP 1.6 message that carries it.
  function toOcpp(cmd) {
    const p = cmd.payload;
    switch (cmd.type) {
      case 'ChangeAvailability': return ['ChangeAvailability', { connectorId: p.connectorId, type: p.type }];
      case 'RemoteStartTransaction': return ['RemoteStartTransaction', { connectorId: p.connectorId, idTag: p.idTag }];
      case 'RemoteStopTransaction': return ['RemoteStopTransaction', { transactionId: p.transactionId }];
      case 'Reset': return ['Reset', { type: p.type }];
      case 'GetConfiguration': return ['GetConfiguration', {}];
      case 'SetTariff': {
        const t = state.settings.tariffIntegration;
        return ['DataTransfer', { vendorId: t.vendorId, messageId: t.messageId, data: JSON.stringify(p) }];
      }
      default: return fail(`Unknown command type ${cmd.type}.`);
    }
  }

  async function dispatch(cmd) {
    if (cmd.status !== 'pending') return;
    const ch = byId(state.chargers, cmd.chargerId);
    try {
      if (!ch) { finish(cmd, 'failed', { error: 'Charger no longer exists.', resultCode: 'rejected' }); return; }
      const capKey = CAPABILITY_FOR[cmd.type];
      if (ch.capabilities[capKey] === 'unsupported') { finish(cmd, 'failed', { resultCode: 'not_supported', error: `${cmd.type} is marked "not supported" for this charger. Nothing was sent.` }); return; }
      if (!transport.isConnected(ch.ocppId)) { finish(cmd, 'failed', { resultCode: 'offline', error: 'Charger is offline. The command was not sent.' }); return; }
      const [action, payload] = toOcpp(cmd);
      cmd.status = 'sent';
      cmd.sentAt = now();
      cmd.attempts += 1;
      onDirty();
      let reply;
      try {
        reply = await transport.call(ch.ocppId, action, payload, state.settings.commandTimeoutSec * 1000);
      } catch (e) {
        if (cmd.status !== 'sent') return;
        if (e.code === 'TIMEOUT' || e.code === 'DISCONNECTED') {
          if (cmd.attempts < cmd.maxAttempts && transport.isConnected(ch.ocppId)) {
            cmd.status = 'pending';
            addEvent(ch.id, cmd.connectorId, 'command', `${cmd.type} got no reply, retrying (attempt ${cmd.attempts + 1}/${cmd.maxAttempts})`);
            onDirty();
            return dispatch(cmd);
          }
          finish(cmd, 'timed_out', { resultCode: 'timeout', error: e.code === 'DISCONNECTED' ? 'The connection closed before the charger replied.' : `No response within ${state.settings.commandTimeoutSec}s.` });
        } else if (e.code === 'NotImplemented' || e.code === 'NotSupported') {
          // The charger itself says it does not implement this message: record that as a fact.
          ch.capabilities[capKey] = 'unsupported';
          addEvent(ch.id, null, 'capability', `${action} answered ${e.code}; capability recorded as not supported`);
          finish(cmd, 'failed', { resultCode: 'not_supported', error: `The charger answered ${e.code} to ${action}.` });
        } else {
          finish(cmd, 'failed', { resultCode: 'rejected', error: `Charger returned an error: ${e.code || ''} ${e.message || ''}`.trim() });
        }
        return;
      }
      if (cmd.status !== 'sent') return;
      cmd.status = 'acknowledged';
      cmd.response = reply && typeof reply === 'object' ? reply : { value: reply };
      const status = cmd.type === 'GetConfiguration' ? 'Accepted' : cmd.response.status;
      if (['Accepted', 'Scheduled'].includes(status)) {
        applyEffects(cmd, ch);
        finish(cmd, 'successful');
      } else {
        const unsupported = ['NotSupported', 'UnknownVendorId', 'UnknownMessageId'].includes(status);
        finish(cmd, 'failed', { resultCode: unsupported ? 'not_supported' : 'rejected', error: `Charger answered "${status}".` });
      }
    } finally {
      onDirty();
    }
  }

  // What a confirmed reply changes in the CMS. Reported connector status is NOT touched here:
  // it only ever comes from the charger's own StatusNotification.
  function applyEffects(cmd) {
    const c = cmd.connectorId ? byId(state.connectors, cmd.connectorId) : null;
    if (cmd.type !== 'ChangeAvailability' || !c) return;
    c.adminConfirmed = true;
    if (cmd.payload.type === 'Operative') {
      c.enabled = true; c.maintenance = false; c.pendingInoperative = false; c.pendingMaintenance = false;
      autoResolve('state_mismatch', c.chargerId, c.id, 'Connector enabled by the CMS.');
    } else if (cmd.response.status === 'Scheduled') {
      c.pendingInoperative = true;
      c.pendingMaintenance = Boolean(cmd.payload.maintenance);
    } else {
      c.enabled = false;
      c.maintenance = Boolean(cmd.payload.maintenance);
    }
    refreshLimitAlert();
  }

  /* ------------------------------------------------------------ pricing */

  function deployToCharger(ch, who) {
    const res = resolvePricing(state, ch, null);
    if (!res) return null;
    const { rule } = res;
    const prev = state.pricingDeployments.find((d) => d.chargerId === ch.id && d.current);
    if (prev && prev.ruleId === rule.id && prev.ruleVersion === rule.version && ['confirmed', 'sent', 'stored', 'cms_only'].includes(prev.stage)) return prev;
    if (prev) prev.current = false;
    const dep = { id: makeId('dep'), chargerId: ch.id, ruleId: rule.id, ruleName: rule.name, ruleVersion: rule.version, current: true, stage: 'stored', commandId: null, requestedBy: who.name, detail: 'Saved in the CMS. Waiting to be sent.', createdAt: now(), updatedAt: now() };
    state.pricingDeployments.unshift(dep);
    cap(state.pricingDeployments, 2000);
    const integration = state.settings.tariffIntegration;
    if (integration.method === 'none' || !integration.vendorId) {
      dep.stage = 'cms_only';
      dep.detail = 'No tariff integration is configured, so nothing is sent to the unit. The price is used for CMS billing calculation; the tariff on the charger itself is unchanged.';
    } else if (ch.capabilities.tariffSync === 'unsupported') {
      dep.stage = 'cms_only';
      dep.detail = 'This charger is recorded as having no tariff interface. The price is used for CMS billing calculation only; the tariff on the unit itself is unchanged.';
    } else if (rule.weekendPeriods && rule.weekendPeriods.length) {
      dep.stage = 'not_supported';
      dep.detail = 'This tariff has a separate weekend schedule, which the charger tariff screen cannot hold. Not sent; CMS billing uses it.';
    } else if (rule.periods.length > ch.hardware.maxTariffPeriods) {
      dep.stage = 'not_supported';
      dep.detail = `Tariff has ${rule.periods.length} periods but this charger accepts ${ch.hardware.maxTariffPeriods}. Not sent.`;
    } else {
      const cmd = createCommand(who, {
        chargerId: ch.id, type: 'SetTariff', meta: { deploymentId: dep.id },
        payload: { ruleName: rule.name, version: rule.version, currency: state.settings.currency, periods: rule.periods.map(({ start, energyPrice, servicePrice }) => ({ start, energyPrice, servicePrice })), flatFee: rule.flatFee, hourPrice: rule.hourPrice, preauthAmount: rule.preauthAmount },
      });
      dep.commandId = cmd.id;
    }
    return dep;
  }
  // Deploy to each charger and return only the deployments that are new.
  function redeploy(chargers, who) {
    const out = [];
    for (const ch of chargers) {
      const before = state.pricingDeployments.find((d) => d.chargerId === ch.id && d.current);
      const dep = deployToCharger(ch, who);
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
  function activateAssignment(a, who) {
    state.pricingAssignments.filter((x) => x.id !== a.id && x.status === 'active' && x.scope === a.scope && x.targetId === a.targetId)
      .forEach((x) => { x.status = 'superseded'; x.endedAt = now(); });
    a.status = 'active';
    a.activatedAt = now();
    return redeploy(affectedChargers(a), who);
  }
  function ruleFromInput(input) {
    const num = (v) => Number(v);
    const periods = (list) => (list || []).map((p) => ({ id: p.id || makeId('per'), start: p.start, energyPrice: num(p.energyPrice), servicePrice: num(p.servicePrice), kind: p.kind || 'standard' }));
    const rule = {
      name: clean(input.name), description: clean(input.description), periods: periods(input.periods),
      weekendPeriods: input.weekendPeriods && input.weekendPeriods.length ? periods(input.weekendPeriods) : null,
      flatFee: num(input.flatFee || 0), hourPrice: num(input.hourPrice || 0), preauthAmount: num(input.preauthAmount || 0),
    };
    const errors = validateRule(rule);
    if (errors.length) fail(errors.join(' '));
    return rule;
  }

  /* ------------------------------------------------------- availability */

  function requestAvailabilityAs(who, { connectorIds, action, reason = '', maintenance = false, override = false }) {
    need('availability.manage', who);
    if (!['enable', 'restrict'].includes(action)) fail('Unknown availability action.');
    const ids = [...new Set(Array.isArray(connectorIds) ? connectorIds : [])];
    if (!ids.length) fail('Select at least one connector.');
    if (ids.length > 1) need('bulk.execute', who);
    const { policy } = state.settings.operationalLimit;
    const canOverride = Boolean(override) && policy === 'warn' && hasPerm(state.settings.rolePermissions, who.role, 'limits.override');
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
        const cmd = createCommand(who, { chargerId: c.chargerId, connectorId: c.id, type: 'ChangeAvailability', payload: { connectorId: c.connectorId, type: 'Operative', reason: clean(reason) } });
        return { ...base, outcome: 'submitted', commandId: cmd.id };
      }
      if (!c.enabled) {
        if (c.maintenance !== Boolean(maintenance)) { c.maintenance = Boolean(maintenance); return { ...base, outcome: 'updated', message: maintenance ? 'Marked as maintenance (already restricted).' : 'Maintenance flag cleared (still restricted).' }; }
        return { ...base, outcome: 'noop', message: 'Already restricted.' };
      }
      const cmd = createCommand(who, { chargerId: c.chargerId, connectorId: c.id, type: 'ChangeAvailability', payload: { connectorId: c.connectorId, type: 'Inoperative', maintenance: Boolean(maintenance), reason: clean(reason) } });
      return { ...base, outcome: 'submitted', commandId: cmd.id };
    });
    audit(who, action === 'enable' ? 'availability.enable' : 'availability.restrict', 'connector', ids.length === 1 ? ids[0] : `${ids.length} connectors`,
      ids.length === 1 ? scopeLabel('connector', ids[0]) : `${ids.length} connectors`, null,
      { action, maintenance: Boolean(maintenance), submitted: results.filter((r) => r.outcome === 'submitted').length, blockedByLimit: results.filter((r) => r.outcome === 'blocked_limit').length, override: canOverride },
      clean(reason) || (canOverride ? 'Limit override used' : ''));
    return { results };
  }

  function chargerFields(input, existing) {
    const name = clean(input.name);
    const ocppId = clean(input.ocppId);
    if (!name) fail('Charger name is required.');
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(ocppId)) fail('OCPP identity must be 3-40 characters: letters, digits, dot, dash or underscore.');
    if (state.chargers.some((c) => c.ocppId.toLowerCase() === ocppId.toLowerCase() && (!existing || c.id !== existing.id))) fail(`OCPP identity "${ocppId}" is already registered.`);
    if (!byId(state.locations, input.locationId)) fail('Choose a location.');
    return { name, ocppId, serial: clean(input.serial), model: clean(input.model), manufacturer: clean(input.manufacturer), locationId: input.locationId };
  }

  /* ------------------------------------------------------------ actions */

  const actions = {
    requirePermission(perm) { need(perm); },
    recordLogin() { const u = me(); u.lastLoginAt = now(); audit(u, 'auth.login', 'user', u.id, u.name); },
    recordLogout() { const u = me(); audit(u, 'auth.logout', 'user', u.id, u.name); },

    createCharger(input = {}) {
      const who = me(); need('chargers.manage');
      const fields = chargerFields(input, null);
      const count = Math.max(1, Math.min(4, Number(input.connectorCount) || 2));
      const kw = Number(input.ratedPowerKw) > 0 ? Number(input.ratedPowerKw) : null;
      const id = makeId('chg');
      const ch = {
        id, ...fields, firmware: '', ocppVersion: '1.6J', groupIds: [], online: false, everConnected: false, lastHeartbeat: null, bootedAt: null,
        capabilities: { ...DEFAULT_CAPABILITIES }, hardware: { ratedPowerKw: kw, powerSharing: 'unknown', maxTariffPeriods: 4, notes: clean(input.notes) },
        reported: null, authKeyHash: null, createdAt: now(),
      };
      state.chargers.push(ch);
      for (let k = 1; k <= count; k += 1) {
        state.connectors.push({
          id: `${id}-${k}`, chargerId: id, connectorId: k, label: `${String.fromCharCode(64 + k)} GUN`, type: 'CCS2', maxPowerKw: kw || 0,
          // Unknown until the charger reports it. Not counted against the limit before then.
          enabled: false, adminConfirmed: false, maintenance: false, status: 'Unavailable', errorCode: 'NoError', errorInfo: '', powerKw: 0, meterWh: 0, sessionId: null, pendingInoperative: false, pendingMaintenance: false,
        });
      }
      audit(who, 'charger.create', 'charger', id, ch.name, null, { ocppId: ch.ocppId, connectors: count });
      redeploy([ch], who);
      return ch;
    },
    updateCharger(id, input = {}) {
      const who = me(); need('chargers.manage');
      const ch = getCharger(id);
      const snap = () => ({ name: ch.name, ocppId: ch.ocppId, serial: ch.serial, model: ch.model, manufacturer: ch.manufacturer, locationId: ch.locationId, capabilities: { ...ch.capabilities }, hardware: { ...ch.hardware } });
      const before = snap();
      const fields = chargerFields(input, ch);
      if (fields.ocppId !== ch.ocppId && transport.isConnected(ch.ocppId)) fail('Disconnect the charger before changing its OCPP identity.');
      Object.assign(ch, fields);
      if (input.capabilities) for (const k of Object.keys(DEFAULT_CAPABILITIES)) if (['verified', 'unverified', 'unsupported'].includes(input.capabilities[k])) ch.capabilities[k] = input.capabilities[k];
      if (input.hardware) {
        const h = input.hardware;
        ch.hardware = {
          ratedPowerKw: Number(h.ratedPowerKw) > 0 ? Number(h.ratedPowerKw) : null,
          powerSharing: ['unknown', 'shared', 'independent'].includes(h.powerSharing) ? h.powerSharing : 'unknown',
          maxTariffPeriods: Math.max(1, Math.min(48, Number(h.maxTariffPeriods) || 4)),
          notes: clean(h.notes),
        };
      }
      audit(who, 'charger.update', 'charger', id, ch.name, before, snap());
      if (before.locationId !== ch.locationId) redeploy([ch], who);
      return ch;
    },
    deleteCharger(id) {
      const who = me(); need('chargers.delete');
      const ch = getCharger(id);
      if (state.connectors.some((c) => c.chargerId === id && c.sessionId)) fail('This charger has a session in progress and cannot be deleted.');
      state.chargers = state.chargers.filter((c) => c.id !== id);
      state.connectors = state.connectors.filter((c) => c.chargerId !== id);
      state.pricingAssignments.filter((a) => ['active', 'scheduled'].includes(a.status) && ((a.scope === 'charger' && a.targetId === id) || (a.scope === 'connector' && String(a.targetId).startsWith(`${id}-`)))).forEach((a) => { a.status = 'removed'; a.endedAt = now(); });
      state.pricingDeployments.filter((d) => d.chargerId === id && d.current).forEach((d) => { d.current = false; });
      transport.disconnect(ch.ocppId, 'charger deleted');
      audit(who, 'charger.delete', 'charger', id, ch.name, { ocppId: ch.ocppId, serial: ch.serial }, null);
      refreshLimitAlert();
    },
    // Issues a new OCPP password for a charger. Only its hash is stored; the key is returned once.
    setChargerAuthKey(id) {
      const who = me(); need('chargers.manage');
      const ch = getCharger(id);
      // 24 characters, letters and digits only, without look-alikes (0/O, 1/l/I): it is typed on a touchscreen.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const key = Array.from({ length: 24 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
      ch.authKeyHash = hashKey(key);
      audit(who, 'charger.auth_key', 'charger', id, ch.name, null, null, 'New OCPP authorisation key issued');
      return { key, ocppId: ch.ocppId };
    },
    updateConnector(id, input = {}) {
      const who = me(); need('chargers.manage');
      const c = getConnector(id);
      const before = { label: c.label, type: c.type, maxPowerKw: c.maxPowerKw };
      if (!clean(input.label)) fail('Connector label is required.');
      c.label = clean(input.label);
      c.type = clean(input.type) || c.type;
      c.maxPowerKw = Number(input.maxPowerKw) >= 0 ? Number(input.maxPowerKw) : c.maxPowerKw;
      audit(who, 'connector.update', 'connector', id, scopeLabel('connector', id), before, { label: c.label, type: c.type, maxPowerKw: c.maxPowerKw });
    },
    bulkAssignLocation(chargerIds = [], locationId) {
      const who = me(); need('chargers.manage'); need('bulk.execute');
      const loc = byId(state.locations, locationId) || fail('Choose a location.');
      const moved = [];
      const results = chargerIds.map((id) => {
        const ch = byId(state.chargers, id);
        if (!ch) return { chargerId: id, outcome: 'failed', message: 'Charger not found.' };
        if (ch.locationId === locationId) return { chargerId: id, outcome: 'noop', message: 'Already at this location.' };
        ch.locationId = locationId; moved.push(ch);
        return { chargerId: id, outcome: 'done', message: `Moved to ${loc.name}.` };
      });
      audit(who, 'charger.bulk_location', 'location', locationId, loc.name, null, { chargers: chargerIds.length });
      redeploy(moved, who);
      return { results };
    },
    bulkAssignGroup(chargerIds = [], groupId) {
      const who = me(); need('groups.manage'); need('bulk.execute');
      const g = byId(state.groups, groupId) || fail('Choose a group.');
      const added = [];
      const results = chargerIds.map((id) => {
        const ch = byId(state.chargers, id);
        if (!ch) return { chargerId: id, outcome: 'failed', message: 'Charger not found.' };
        if (ch.groupIds.includes(groupId)) return { chargerId: id, outcome: 'noop', message: 'Already in this group.' };
        ch.groupIds = [...ch.groupIds, groupId]; added.push(ch);
        return { chargerId: id, outcome: 'done', message: `Added to ${g.name}.` };
      });
      audit(who, 'group.bulk_add', 'group', groupId, g.name, null, { chargers: chargerIds.length });
      redeploy(added, who);
      return { results };
    },

    saveLocation(input = {}) {
      const who = me(); need('locations.manage');
      if (!clean(input.name)) fail('Location name is required.');
      const data = { name: clean(input.name), address: clean(input.address), city: clean(input.city), notes: clean(input.notes) };
      if (input.id) {
        const loc = byId(state.locations, input.id) || fail('Location not found.', 404);
        const before = { ...loc };
        Object.assign(loc, data);
        audit(who, 'location.update', 'location', loc.id, loc.name, before, { ...loc });
        return loc;
      }
      const loc = { id: makeId('loc'), ...data };
      state.locations.push(loc);
      audit(who, 'location.create', 'location', loc.id, loc.name, null, data);
      return loc;
    },
    deleteLocation(id) {
      const who = me(); need('locations.manage');
      const loc = byId(state.locations, id) || fail('Location not found.', 404);
      if (state.chargers.some((c) => c.locationId === id)) fail('Move or delete the chargers at this location first.');
      state.locations = state.locations.filter((l) => l.id !== id);
      state.groups.forEach((g) => { if (g.locationId === id) g.locationId = null; });
      state.pricingAssignments.filter((a) => a.scope === 'location' && a.targetId === id && ['active', 'scheduled'].includes(a.status)).forEach((a) => { a.status = 'removed'; a.endedAt = now(); });
      audit(who, 'location.delete', 'location', id, loc.name, { ...loc }, null);
    },

    saveGroup(input = {}) {
      const who = me(); need('groups.manage');
      if (!clean(input.name)) fail('Group name is required.');
      const data = { name: clean(input.name), description: clean(input.description), locationId: byId(state.locations, input.locationId) ? input.locationId : null, availabilityPolicy: clean(input.availabilityPolicy) };
      let g;
      if (input.id) { g = byId(state.groups, input.id) || fail('Group not found.', 404); Object.assign(g, data); } else { g = { id: makeId('grp'), ...data }; state.groups.push(g); }
      const changed = [];
      if (Array.isArray(input.chargerIds)) {
        for (const ch of state.chargers) {
          const want = input.chargerIds.includes(ch.id);
          const has = ch.groupIds.includes(g.id);
          if (want && !has) { ch.groupIds = [...ch.groupIds, g.id]; changed.push(ch); }
          if (!want && has) { ch.groupIds = ch.groupIds.filter((x) => x !== g.id); changed.push(ch); }
        }
      }
      audit(who, input.id ? 'group.update' : 'group.create', 'group', g.id, g.name, null, { ...data, chargers: (input.chargerIds || []).length });
      redeploy(changed, who);
      return g;
    },
    deleteGroup(id) {
      const who = me(); need('groups.manage');
      const g = byId(state.groups, id) || fail('Group not found.', 404);
      const members = state.chargers.filter((ch) => ch.groupIds.includes(id));
      state.groups = state.groups.filter((x) => x.id !== id);
      members.forEach((ch) => { ch.groupIds = ch.groupIds.filter((x) => x !== id); });
      state.pricingAssignments.filter((a) => a.scope === 'group' && a.targetId === id && ['active', 'scheduled'].includes(a.status)).forEach((a) => { a.status = 'removed'; a.endedAt = now(); });
      audit(who, 'group.delete', 'group', id, g.name, { ...g }, null);
      redeploy(members, who);
    },

    requestAvailability(args = {}) { return requestAvailabilityAs(me(), args); },
    setOperationalLimit({ maxEnabledConnectors, policy } = {}) {
      const who = me(); need('limits.manage');
      const max = Number(maxEnabledConnectors);
      if (!Number.isInteger(max) || max < 0) fail('The limit must be a whole number, zero or higher.');
      if (!['block', 'warn'].includes(policy)) fail('Unknown policy.');
      const before = { ...state.settings.operationalLimit };
      state.settings.operationalLimit = { ...before, maxEnabledConnectors: max, policy };
      audit(who, 'limit.update', 'settings', 'operationalLimit', 'Operational limit', before, { ...state.settings.operationalLimit });
      refreshLimitAlert();
      return limitSnapshot(state);
    },
    scheduleAvailability({ connectorIds, action, runAt, reason = '', maintenance = false } = {}) {
      const who = me(); need('availability.manage');
      if (!Array.isArray(connectorIds) || !connectorIds.length) fail('Select at least one connector.');
      if (connectorIds.length > 1) need('bulk.execute');
      if (!['enable', 'restrict'].includes(action)) fail('Unknown availability action.');
      if (!(Number(runAt) > now())) fail('Choose a time in the future.');
      const op = { id: makeId('op'), type: 'availability', runAt: Number(runAt), payload: { connectorIds: [...connectorIds], action, reason: clean(reason), maintenance: Boolean(maintenance) }, status: 'scheduled', createdBy: who.name, createdById: who.id, createdAt: now(), executedAt: null, result: null, error: null };
      state.scheduledOps.unshift(op);
      audit(who, 'availability.schedule', 'scheduled_operation', op.id, `${action} ${connectorIds.length} connector(s)`, null, { runAt: op.runAt, action, connectors: connectorIds.length }, clean(reason));
      return op;
    },
    cancelScheduledOp(id) {
      const who = me(); need('availability.manage');
      const op = byId(state.scheduledOps, id);
      if (!op || op.status !== 'scheduled') fail('Only operations that have not run yet can be cancelled.');
      op.status = 'cancelled';
      audit(who, 'availability.schedule_cancel', 'scheduled_operation', id, `${op.payload.action} ${op.payload.connectorIds.length} connector(s)`);
    },

    sendCommand({ chargerId, connectorId = null, type } = {}) {
      const who = me(); need('commands.remote');
      const ch = getCharger(chargerId);
      const c = connectorId ? getConnector(connectorId) : null;
      if (c && c.chargerId !== ch.id) fail('That connector belongs to a different charger.');
      if (!['RemoteStartTransaction', 'RemoteStopTransaction', 'Reset', 'GetConfiguration'].includes(type)) fail('Unknown command type.');
      let payload = {};
      if (type === 'RemoteStartTransaction') {
        if (!c) fail('Choose a connector.');
        if (!c.enabled) fail('This connector is restricted. Enable it before starting a session.');
        payload = { connectorId: c.connectorId, idTag: `CMS-${who.id}`.slice(0, 20) };
      } else if (type === 'RemoteStopTransaction') {
        const s = c && c.sessionId ? byId(state.sessions, c.sessionId) : null;
        if (!s) fail('There is no session to stop on this connector.');
        payload = { transactionId: s.transactionId };
      } else if (type === 'Reset') {
        if (connectorsOf(state, ch.id).some((x) => x.sessionId)) fail('A reset would interrupt a session in progress. Wait for it to end or stop it first.');
        payload = { type: 'Soft' };
      }
      const cmd = createCommand(who, { chargerId: ch.id, connectorId: c ? c.id : null, type, payload });
      audit(who, 'command.submit', 'command', cmd.id, `${type} → ${ch.name}${c ? ` · ${c.label}` : ''}`, null, payload);
      return cmd;
    },
    retryCommand(id) {
      const who = me();
      const old = byId(state.commands, id) || fail('Command not found.', 404);
      if (!['failed', 'timed_out', 'cancelled'].includes(old.status)) fail('Only failed, timed-out or cancelled commands can be retried.');
      need({ ChangeAvailability: 'availability.manage', SetTariff: 'pricing.manage' }[old.type] || 'commands.remote');
      if (old.type === 'ChangeAvailability') {
        const c = getConnector(old.connectorId);
        const r = requestAvailabilityAs(who, { connectorIds: [c.id], action: old.payload.type === 'Operative' ? 'enable' : 'restrict', maintenance: old.payload.maintenance, reason: `Retry of ${old.id}` }).results[0];
        if (r.outcome !== 'submitted') fail(r.message);
        return byId(state.commands, r.commandId);
      }
      if (old.type === 'SetTariff') {
        const dep = deployToCharger(getCharger(old.chargerId), who);
        if (dep && dep.commandId === old.id) {
          dep.stage = 'stored';
          dep.commandId = createCommand(who, { chargerId: old.chargerId, type: 'SetTariff', payload: old.payload, meta: { deploymentId: dep.id } }).id;
        }
        audit(who, 'command.retry', 'command', old.id, `SetTariff → ${getCharger(old.chargerId).name}`);
        return dep;
      }
      return actions.sendCommand({ chargerId: old.chargerId, connectorId: old.connectorId, type: old.type });
    },
    cancelCommand(id) {
      const who = me();
      const cmd = byId(state.commands, id) || fail('Command not found.', 404);
      need({ ChangeAvailability: 'availability.manage', SetTariff: 'pricing.manage' }[cmd.type] || 'commands.remote');
      if (cmd.status !== 'pending') fail('Only commands that have not been sent yet can be cancelled.');
      finish(cmd, 'cancelled', { error: `Cancelled by ${who.name}.` });
      audit(who, 'command.cancel', 'command', id, cmd.type);
    },

    saveRule(input = {}) {
      const who = me(); need('pricing.manage');
      const data = ruleFromInput(input);
      if (state.pricingRules.some((r) => r.name.toLowerCase() === data.name.toLowerCase() && r.id !== input.id)) fail(`A tariff named "${data.name}" already exists.`);
      if (!input.id) {
        const rule = { id: makeId('rule'), version: 1, ...data, createdAt: now(), updatedAt: now() };
        state.pricingRules.push(rule);
        audit(who, 'pricing.rule_create', 'pricing_rule', rule.id, rule.name, null, data);
        return { rule, deployments: [] };
      }
      const rule = byId(state.pricingRules, input.id) || fail('Tariff not found.', 404);
      const before = { name: rule.name, periods: rule.periods, weekendPeriods: rule.weekendPeriods, flatFee: rule.flatFee, hourPrice: rule.hourPrice, preauthAmount: rule.preauthAmount };
      Object.assign(rule, data, { version: rule.version + 1, updatedAt: now() });
      audit(who, 'pricing.rule_update', 'pricing_rule', rule.id, rule.name, before, data, `Version ${rule.version}`);
      const deployments = redeploy(state.chargers.filter((ch) => { const r = resolvePricing(state, ch, null); return r && r.rule.id === rule.id; }), who);
      return { rule, deployments };
    },
    deleteRule(id) {
      const who = me(); need('pricing.manage');
      const rule = byId(state.pricingRules, id) || fail('Tariff not found.', 404);
      if (state.pricingAssignments.some((a) => a.ruleId === id && ['active', 'scheduled'].includes(a.status))) fail('This tariff is assigned or scheduled. Remove those assignments first.');
      state.pricingRules = state.pricingRules.filter((r) => r.id !== id);
      audit(who, 'pricing.rule_delete', 'pricing_rule', id, rule.name, { name: rule.name }, null);
    },
    assignPricing({ ruleId, scope, targetIds = [], effectiveAt = null } = {}) {
      const who = me(); need('pricing.manage');
      const rule = byId(state.pricingRules, ruleId) || fail('Choose a tariff.');
      if (!['global', 'location', 'group', 'charger', 'connector'].includes(scope)) fail('Unknown scope.');
      const source = { location: state.locations, group: state.groups, charger: state.chargers, connector: state.connectors }[scope];
      const targets = scope === 'global' ? [null] : [...new Set(Array.isArray(targetIds) ? targetIds : [])];
      if (!targets.length) fail('Choose at least one target.');
      if (source && targets.some((t) => !byId(source, t))) fail('One of the selected targets no longer exists.');
      if (targets.length > 1) need('bulk.execute');
      const future = Boolean(effectiveAt) && Number(effectiveAt) > now() + 1000;
      const assignments = [];
      const deployments = [];
      for (const targetId of targets) {
        const a = { id: makeId('asg'), ruleId, scope, targetId, status: future ? 'scheduled' : 'active', effectiveAt: future ? Number(effectiveAt) : now(), activatedAt: null, endedAt: null, createdAt: now(), createdBy: who.name };
        state.pricingAssignments.unshift(a);
        assignments.push(a);
        if (!future) activateAssignment(a, who).forEach((d) => { if (!deployments.includes(d)) deployments.push(d); });
      }
      audit(who, future ? 'pricing.schedule' : (targets.length > 1 ? 'pricing.bulk_assign' : 'pricing.assign'), 'pricing_assignment', assignments.length === 1 ? assignments[0].id : `${assignments.length} assignments`,
        `${rule.name} → ${targets.length === 1 ? scopeLabel(scope, targets[0]) : `${targets.length} ${scope}s`}`, null, { rule: rule.name, scope, targets: targets.length, effectiveAt: future ? Number(effectiveAt) : 'now' });
      return { assignments, deployments };
    },
    cancelAssignment(id) {
      const who = me(); need('pricing.manage');
      const a = byId(state.pricingAssignments, id) || fail('Assignment not found.', 404);
      if (a.scope === 'global' && a.status === 'active') fail('The network default cannot be removed. Assign a different tariff to the whole network instead.');
      if (!['active', 'scheduled'].includes(a.status)) fail('This assignment is no longer active.');
      const wasActive = a.status === 'active';
      const chargers = wasActive ? affectedChargers(a) : [];
      a.status = wasActive ? 'removed' : 'cancelled';
      a.endedAt = now();
      const deployments = redeploy(chargers, who);
      audit(who, wasActive ? 'pricing.unassign' : 'pricing.schedule_cancel', 'pricing_assignment', id, `${(byId(state.pricingRules, a.ruleId) || {}).name} → ${scopeLabel(a.scope, a.targetId)}`);
      return { deployments };
    },

    acknowledgeAlert(id) {
      const who = me(); need('alerts.manage');
      const a = byId(state.alerts, id);
      if (!a || a.status !== 'open') fail('Only open alerts can be acknowledged.');
      a.status = 'acknowledged'; a.acknowledgedBy = who.name; a.acknowledgedAt = now();
    },
    resolveAlert(id, note) {
      const who = me(); need('alerts.manage');
      const a = byId(state.alerts, id);
      if (!a || a.status === 'resolved') fail('This alert is already resolved.');
      if (!a.acknowledgedBy) { a.acknowledgedBy = who.name; a.acknowledgedAt = now(); }
      a.status = 'resolved'; a.resolvedAt = now(); a.resolutionNote = clean(note).slice(0, 500) || `Resolved by ${who.name}.`;
    },

    saveUser(input = {}) {
      const who = me(); need('users.manage');
      const name = clean(input.name);
      const email = clean(input.email).toLowerCase();
      if (!name) fail('Name is required.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Enter a valid email address.');
      if (!['admin', 'operator', 'viewer'].includes(input.role)) fail('Choose a role.');
      if (state.users.some((u) => u.email === email && u.id !== input.id)) fail('A user with this email already exists.');
      const password = input.password ? String(input.password) : '';
      if (password && password.length < 10) fail('Passwords must be at least 10 characters.');
      if (input.id) {
        const u = byId(state.users, input.id) || fail('User not found.', 404);
        const before = { name: u.name, email: u.email, role: u.role, active: u.active };
        const active = input.active !== false;
        const losingAdmin = u.role === 'admin' && u.active && (input.role !== 'admin' || !active);
        if (losingAdmin && state.users.filter((x) => x.role === 'admin' && x.active).length <= 1) fail('At least one active admin is required.');
        Object.assign(u, { name, email, role: input.role, active });
        if (password) u.passwordHash = hashPassword(password);
        audit(who, before.role !== u.role ? 'user.role_change' : 'user.update', 'user', u.id, u.name, before, { name, email, role: u.role, active }, password ? 'Password reset by an administrator' : '');
        return { id: u.id, sessionsRevoked: Boolean(password) || !active };
      }
      if (!password) fail('Set an initial password for the new user.');
      const u = { id: makeId('usr'), name, email, role: input.role, active: true, passwordHash: hashPassword(password), createdAt: now(), lastLoginAt: null };
      state.users.push(u);
      audit(who, 'user.create', 'user', u.id, u.name, null, { name, email, role: u.role });
      return { id: u.id };
    },
    setRolePermissions(role, perms = []) {
      const who = me(); need('users.manage');
      if (!['operator', 'viewer'].includes(role)) fail('Admin permissions are fixed. Only operator and viewer can be changed.');
      const next = ALL_PERMISSIONS.filter((p) => perms.includes(p));
      const before = [...state.settings.rolePermissions[role]];
      state.settings.rolePermissions = { ...state.settings.rolePermissions, [role]: next };
      audit(who, 'permission.update', 'role', role, role, before, next);
    },
    updateSettings(input = {}) {
      const who = me(); need('settings.manage');
      const s = state.settings;
      const pick = () => ({ orgName: s.orgName, currency: s.currency, timezone: s.timezone, commandTimeoutSec: s.commandTimeoutSec, heartbeatIntervalSec: s.heartbeatIntervalSec, tariffIntegration: { ...s.tariffIntegration } });
      const before = pick();
      const currency = clean(input.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) fail('Currency must be a 3-letter code, e.g. RWF.');
      const timeout = Number(input.commandTimeoutSec);
      const hb = Number(input.heartbeatIntervalSec);
      if (!(timeout >= 3 && timeout <= 300)) fail('Command timeout must be between 3 and 300 seconds.');
      if (!(hb >= 5 && hb <= 3600)) fail('Heartbeat interval must be between 5 and 3600 seconds.');
      if (!clean(input.orgName)) fail('Organisation name is required.');
      const timezone = clean(input.timezone) || s.timezone;
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail(`"${timezone}" is not a valid time zone name (example: Africa/Kigali).`); }
      Object.assign(s, { orgName: clean(input.orgName), currency, timezone, commandTimeoutSec: timeout, heartbeatIntervalSec: hb });
      if (input.tariffIntegration) {
        const t = input.tariffIntegration;
        if (!['none', 'datatransfer'].includes(t.method)) fail('Unknown tariff integration method.');
        if (t.method === 'datatransfer' && !clean(t.vendorId)) fail('A vendor ID is required for the DataTransfer tariff integration.');
        s.tariffIntegration = { method: t.method, vendorId: clean(t.vendorId).slice(0, 255), messageId: clean(t.messageId).slice(0, 50) || 'SetTariff' };
      }
      audit(who, 'settings.update', 'settings', 'system', 'System settings', before, pick());
    },
  };

  /* ------------------------------------------------- messages from chargers */

  const iso = () => new Date(now()).toISOString();
  const parseTime = (t) => { const ms = Date.parse(t); return Number.isFinite(ms) && Math.abs(ms - now()) < 7 * 86400000 ? ms : now(); };
  const chargerByIdentity = (identity) => state.chargers.find((c) => c.ocppId === identity) || null;

  function connectorFor(ch, number, create = true) {
    let c = state.connectors.find((x) => x.chargerId === ch.id && x.connectorId === number);
    if (!c && create && Number.isInteger(number) && number > 0 && number <= 16) {
      c = { id: `${ch.id}-${number}`, chargerId: ch.id, connectorId: number, label: `${String.fromCharCode(64 + number)} GUN`, type: '', maxPowerKw: ch.hardware.ratedPowerKw || 0, enabled: false, adminConfirmed: false, maintenance: false, status: 'Unavailable', errorCode: 'NoError', errorInfo: '', powerKw: 0, meterWh: 0, sessionId: null, pendingInoperative: false, pendingMaintenance: false };
      state.connectors.push(c);
      addEvent(ch.id, c.id, 'status', `Connector ${number} was reported by the charger and added to the CMS`);
    }
    return c;
  }

  const handlers = {
    BootNotification(ch, p) {
      ch.reported = { vendor: p.chargePointVendor || '', model: p.chargePointModel || '', serial: p.chargePointSerialNumber || p.chargeBoxSerialNumber || '', firmware: p.firmwareVersion || '' };
      ch.firmware = ch.reported.firmware;
      if (!ch.manufacturer) ch.manufacturer = ch.reported.vendor;
      if (!ch.model) ch.model = ch.reported.model;
      if (!ch.serial) ch.serial = ch.reported.serial;
      ch.bootedAt = now();
      addEvent(ch.id, null, 'boot', `BootNotification: ${ch.reported.vendor} ${ch.reported.model}, firmware ${ch.reported.firmware || 'not reported'}`);
      return { status: 'Accepted', currentTime: iso(), interval: state.settings.heartbeatIntervalSec };
    },
    Heartbeat() { return { currentTime: iso() }; },
    StatusNotification(ch, p) {
      if (p.connectorId === 0) {
        addEvent(ch.id, null, p.status === 'Faulted' ? 'fault' : 'status', `Charger status: ${p.status}${p.errorCode && p.errorCode !== 'NoError' ? ` (${p.errorCode})` : ''}`);
        if (p.status === 'Faulted') raiseAlert({ type: 'connector_fault', severity: 'critical', chargerId: ch.id, message: `${ch.name} reported a charger-level fault: ${p.errorCode}.` });
        else autoResolve('connector_fault', ch.id, null, 'Charger reported the fault cleared.');
        return {};
      }
      const c = connectorFor(ch, p.connectorId) || (() => { throw new OcppError('PropertyConstraintViolation', 'Invalid connectorId'); })();
      const prev = c.status;
      c.status = String(p.status);
      c.errorCode = p.errorCode || 'NoError';
      c.errorInfo = [p.info, p.vendorErrorCode].filter(Boolean).join(' · ');
      if (!OCCUPYING.includes(c.status) && !c.sessionId) c.powerKw = 0;
      if (c.pendingInoperative && c.status === 'Unavailable') {
        // The restriction the charger answered "Scheduled" to has now taken effect.
        c.enabled = false; c.maintenance = c.pendingMaintenance; c.pendingInoperative = false; c.pendingMaintenance = false;
      } else if (!c.adminConfirmed) {
        // The CMS has never commanded this connector: take the charger's word for its state.
        c.enabled = c.status !== 'Unavailable';
      } else if (!c.enabled && c.status !== 'Unavailable' && c.status !== 'Faulted' && !hasActiveCommand(state, c.id)) {
        raiseAlert({ type: 'state_mismatch', severity: 'warning', chargerId: ch.id, connectorId: c.id, message: `${ch.name} · ${c.label} reports ${c.status} although the CMS restricted it. The restriction may not have survived a restart; restrict it again or check the unit.` });
      }
      if (c.status === 'Faulted' && prev !== 'Faulted') raiseAlert({ type: 'connector_fault', severity: 'critical', chargerId: ch.id, connectorId: c.id, message: `${ch.name} · ${c.label} reported ${c.errorCode}.` });
      if (prev === 'Faulted' && c.status !== 'Faulted') autoResolve('connector_fault', ch.id, c.id, 'Charger reported the fault cleared.');
      if (prev !== c.status) addEvent(ch.id, c.id, c.status === 'Faulted' ? 'fault' : 'status', `StatusNotification: ${c.status}${c.errorCode !== 'NoError' ? ` (${c.errorCode})` : ''}`);
      refreshLimitAlert();
      return {};
    },
    // No local authorisation list yet: every tag is accepted and recorded with the session.
    Authorize() { return { idTagInfo: { status: 'Accepted' } }; },
    StartTransaction(ch, p) {
      const c = connectorFor(ch, p.connectorId) || (() => { throw new OcppError('PropertyConstraintViolation', 'Invalid connectorId'); })();
      const startedAt = parseTime(p.timestamp);
      const meterStart = Number(p.meterStart) || 0;
      // Chargers repeat StartTransaction until it is answered; the same one must get the same id.
      const again = state.sessions.find((s) => s.connectorId === c.id && s.status === 'active' && s.meterStartWh === meterStart && Math.abs(s.startedAt - startedAt) < 2000);
      if (again) return { transactionId: again.transactionId, idTagInfo: { status: 'Accepted' } };
      if (c.sessionId) { const old = byId(state.sessions, c.sessionId); if (old && old.status === 'active') { old.status = 'failed'; old.endedAt = now(); old.stopReason = 'Superseded by a new transaction'; old.cost = sessionCost(old, old.endedAt); } }
      const res = resolvePricing(state, ch, c);
      const rule = res ? res.rule : null;
      const id = makeId('ses');
      const s = {
        id, transactionId: state.seq.ses, chargerId: ch.id, connectorId: c.id, idTag: String(p.idTag || '').slice(0, 20), startedAt, endedAt: null,
        meterStartWh: meterStart, meterStopWh: null, energyKwh: 0, status: 'active', stopReason: null,
        ruleId: rule ? rule.id : null, ruleName: rule ? rule.name : null, ruleVersion: rule ? rule.version : null,
        priceAtStart: rateAt(rule, zoned(startedAt)).total, fees: { flatFee: rule ? rule.flatFee : 0, hourPrice: rule ? rule.hourPrice : 0 },
        energyCost: 0, cost: rule ? rule.flatFee : 0, costSource: rule ? 'cms_calculated' : 'none',
      };
      state.sessions.unshift(s);
      cap(state.sessions, 5000);
      c.sessionId = id;
      addEvent(ch.id, c.id, 'session_start', `StartTransaction on ${c.label}, tag ${s.idTag || 'none'}`);
      if (c.adminConfirmed && !c.enabled) raiseAlert({ type: 'state_mismatch', severity: 'warning', chargerId: ch.id, connectorId: c.id, message: `${ch.name} · ${c.label} started a session although the CMS restricted it.` });
      return { transactionId: s.transactionId, idTagInfo: { status: 'Accepted' } };
    },
    StopTransaction(ch, p) {
      const s = state.sessions.find((x) => x.transactionId === p.transactionId);
      if (!s) { addEvent(ch.id, null, 'session_stop', `StopTransaction for unknown transaction ${p.transactionId}`); return { idTagInfo: { status: 'Accepted' } }; }
      if (s.status !== 'active') return { idTagInfo: { status: 'Accepted' } }; // repeated message
      const endedAt = Math.max(parseTime(p.timestamp), s.startedAt);
      const meterStop = Number(p.meterStop);
      if (Number.isFinite(meterStop) && meterStop >= s.meterStartWh) { s.meterStopWh = meterStop; accrue(s, (meterStop - s.meterStartWh) / 1000, endedAt); } else accrue(s, s.energyKwh, endedAt);
      s.endedAt = endedAt;
      s.stopReason = p.reason || 'Local';
      s.status = FAILED_STOP_REASONS.includes(s.stopReason) ? 'failed' : 'completed';
      s.cost = sessionCost(s, endedAt);
      const c = byId(state.connectors, s.connectorId);
      if (c) { if (c.sessionId === s.id) c.sessionId = null; c.powerKw = 0; if (s.meterStopWh !== null) c.meterWh = s.meterStopWh; }
      addEvent(ch.id, s.connectorId, 'session_stop', `StopTransaction (${s.stopReason}), ${s.energyKwh.toFixed(2)} kWh`);
      if (s.status === 'failed') raiseAlert({ type: 'session_failed', severity: 'warning', chargerId: ch.id, connectorId: s.connectorId, message: `Session ${s.id} on ${ch.name} ended abnormally (${s.stopReason}).` });
      return { idTagInfo: { status: 'Accepted' } };
    },
    MeterValues(ch, p) {
      const c = connectorFor(ch, p.connectorId, false);
      if (!c) return {};
      const s = (p.transactionId !== undefined && state.sessions.find((x) => x.transactionId === p.transactionId && x.status === 'active')) || (c.sessionId ? byId(state.sessions, c.sessionId) : null);
      for (const mv of Array.isArray(p.meterValue) ? p.meterValue : []) {
        const at = parseTime(mv.timestamp);
        let energyWh = null;
        let powerKw = null;
        for (const sv of Array.isArray(mv.sampledValue) ? mv.sampledValue : []) {
          const value = Number(sv.value);
          if (!Number.isFinite(value) || (sv.phase !== undefined && sv.phase !== null)) continue;
          const measurand = sv.measurand || 'Energy.Active.Import.Register';
          if (measurand === 'Energy.Active.Import.Register') energyWh = sv.unit === 'kWh' ? value * 1000 : value;
          else if (measurand === 'Power.Active.Import') powerKw = sv.unit === 'kW' ? value : value / 1000;
        }
        if (powerKw !== null) c.powerKw = Math.round(powerKw * 10) / 10;
        if (energyWh !== null) {
          if (energyWh < c.meterWh - 1 && c.meterWh > 0 && !(s && energyWh >= s.meterStartWh)) {
            raiseAlert({ type: 'abnormal_energy', severity: 'warning', chargerId: ch.id, connectorId: c.id, message: `${ch.name} · ${c.label} meter register went backwards (${Math.round(c.meterWh)} Wh → ${Math.round(energyWh)} Wh).` });
          }
          c.meterWh = energyWh;
          if (s && s.status === 'active' && energyWh >= s.meterStartWh) accrue(s, (energyWh - s.meterStartWh) / 1000, at);
        }
        if (energyWh !== null || powerKw !== null) appendRow('meter_values', { id: crypto.randomUUID(), chargerId: ch.id, connectorId: c.id, sessionId: s ? s.id : null, at, energyWh, powerKw });
      }
      return {};
    },
    DataTransfer(ch, p) { addEvent(ch.id, null, 'data_transfer', `DataTransfer from charger: vendor ${p.vendorId || '?'}, message ${p.messageId || '-'}`); return { status: 'UnknownVendorId' }; },
    FirmwareStatusNotification(ch, p) { addEvent(ch.id, null, 'firmware', `Firmware status: ${p.status}`); return {}; },
    DiagnosticsStatusNotification(ch, p) { addEvent(ch.id, null, 'diagnostics', `Diagnostics status: ${p.status}`); return {}; },
  };

  const ocpp = {
    lookup: chargerByIdentity,
    // Returns true when the presented key matches. A charger without a key passes only if auth is not required.
    checkKey(identity, key, required) {
      const ch = chargerByIdentity(identity);
      if (!ch) return false;
      if (!ch.authKeyHash) return !required;
      return Boolean(key) && verifyKey(key, ch.authKeyHash);
    },
    rejected(identity, reason, remote) {
      const ch = chargerByIdentity(identity);
      if (ch) addEvent(ch.id, null, 'auth', `Connection refused: ${reason}`);
      raiseAlert({ type: ch ? 'ocpp_comm_failure' : 'unknown_charger', severity: 'warning', chargerId: ch ? ch.id : null, message: ch ? `${ch.name}: connection refused (${reason}).` : `An unregistered charger identity "${String(identity).slice(0, 40)}" tried to connect from ${remote || 'unknown address'}. Register it under Chargers if it is yours.` });
    },
    connected(identity, cause = 'charger connected') { const ch = chargerByIdentity(identity); if (ch) setOnline(ch, true, cause); },
    disconnected(identity, cause = 'socket closed') { const ch = chargerByIdentity(identity); if (ch) setOnline(ch, false, cause); },
    // Handles one CALL from a charger and returns the CALLRESULT payload.
    handle(identity, action, payload) {
      const ch = chargerByIdentity(identity) || (() => { throw new OcppError('SecurityError', 'Unknown charge point'); })();
      const fn = handlers[action] || (() => { throw new OcppError('NotImplemented', `${action} is not implemented by this central system`); });
      if (!payload || typeof payload !== 'object') throw new OcppError('FormationViolation', 'Payload must be an object');
      ch.lastHeartbeat = now();
      actor = CHARGER;
      try { return fn(ch, payload); } finally { actor = null; }
    },
  };

  /* ------------------------------------------------------------ scheduler */

  function tick() {
    const t = now();
    for (const a of state.pricingAssignments) {
      if (a.status !== 'scheduled' || a.effectiveAt > t) continue;
      if (!byId(state.pricingRules, a.ruleId)) { a.status = 'cancelled'; a.endedAt = t; continue; }
      activateAssignment(a, SYSTEM);
      audit(SYSTEM, 'pricing.scheduled_activated', 'pricing_assignment', a.id, `${byId(state.pricingRules, a.ruleId).name} → ${scopeLabel(a.scope, a.targetId)}`, null, null, `Scheduled by ${a.createdBy}`);
    }
    for (const op of state.scheduledOps) {
      if (op.status !== 'scheduled' || op.runAt > t) continue;
      try {
        // Runs with the permissions the scheduling user has NOW, and the limit is checked again.
        const who = byId(state.users, op.createdById);
        if (!who || !who.active) fail('The user who scheduled this operation no longer has an active account.');
        op.result = requestAvailabilityAs({ ...who, name: `${who.name} (scheduled)` }, op.payload).results;
        op.status = 'executed';
      } catch (e) {
        op.status = 'failed';
        op.error = e.message;
      }
      op.executedAt = t;
    }
  }

  // After a restart nothing can be waiting for a reply any more, and no command is re-sent blindly.
  function recover() {
    for (const cmd of state.commands) {
      if (ACTIVE_COMMAND_STATUSES.includes(cmd.status)) finish(cmd, cmd.status === 'pending' ? 'cancelled' : 'failed', { resultCode: 'restart', error: 'The server restarted before this command completed. It was not re-sent.' });
    }
    for (const ch of state.chargers) {
      if (ch.online) { ch.online = false; for (const c of connectorsOf(state, ch.id)) c.powerKw = 0; }
    }
  }

  return {
    state, ocpp, tick, recover,
    // Runs one action as `who`. Synchronous: the caller persists afterwards.
    run(who, name, args = []) {
      if (!Object.prototype.hasOwnProperty.call(actions, name)) fail(`Unknown action ${name}.`, 404);
      actor = who;
      try { return actions[name](...args); } finally { actor = null; }
    },
  };
}
