// Read-side helpers over the store. Pure functions of state.
import { connectorState } from './status.js';
import { ACTIVE_COMMAND_STATUSES } from './status.js';
import { dayKey, startOfDay } from './format.js';

export const byId = (list, id) => list.find((x) => x.id === id);

export function connectorsOf(state, chargerId) {
  return state.connectors.filter((c) => c.chargerId === chargerId).sort((a, b) => a.connectorId - b.connectorId);
}

// Pricing precedence: connector > charger > group > location > global.
// Pass connector = null to resolve the charger-level tariff (what would be pushed to the unit).
export function resolvePricing(state, charger, connector = null) {
  if (!charger) return null;
  const active = state.pricingAssignments.filter((a) => a.status === 'active');
  const pick = (scope, ids) =>
    active
      .filter((a) => a.scope === scope && ids.includes(a.targetId))
      .sort((a, b) => b.activatedAt - a.activatedAt)[0];
  const a =
    (connector && pick('connector', [connector.id])) ||
    pick('charger', [charger.id]) ||
    pick('group', charger.groupIds || []) ||
    pick('location', [charger.locationId]) ||
    active.find((x) => x.scope === 'global');
  if (!a) return null;
  const rule = byId(state.pricingRules, a.ruleId);
  return rule ? { assignment: a, rule } : null;
}

export function currentDeployment(state, chargerId) {
  return state.pricingDeployments.find((d) => d.chargerId === chargerId && d.current) || null;
}

export function hasActiveCommand(state, connectorId) {
  return state.commands.some((c) => c.connectorId === connectorId && ACTIVE_COMMAND_STATUSES.includes(c.status));
}

export function limitSnapshot(state) {
  const chargers = new Map(state.chargers.map((c) => [c.id, c]));
  const snap = {
    total: state.connectors.length, enabled: 0, pendingEnable: 0, charging: 0, available: 0,
    occupied: 0, reserved: 0, offline: 0, faulted: 0, maintenance: 0, unavailable: 0,
    max: state.settings.operationalLimit.maxEnabledConnectors,
  };
  for (const c of state.connectors) {
    if (c.enabled) snap.enabled += 1;
    snap[connectorState(c, chargers.get(c.chargerId))] += 1;
  }
  snap.pendingEnable = state.commands.filter(
    (c) => c.type === 'ChangeAvailability' && c.payload.type === 'Operative' && ACTIVE_COMMAND_STATUSES.includes(c.status)
      && !(byId(state.connectors, c.connectorId) || {}).enabled,
  ).length;
  snap.headroom = snap.max - snap.enabled - snap.pendingEnable;
  snap.over = Math.max(0, snap.enabled - snap.max);
  return snap;
}

export function networkSummary(state) {
  const snap = limitSnapshot(state);
  const today = startOfDay();
  let energyToday = 0;
  let revenueToday = 0;
  let active = 0;
  for (const s of state.sessions) {
    if (s.status === 'active') active += 1;
    if (s.startedAt >= today) {
      energyToday += s.energyKwh;
      revenueToday += s.cost || 0;
    }
  }
  return {
    ...snap,
    stations: state.chargers.length,
    online: state.chargers.filter((c) => c.online).length,
    offlineChargers: state.chargers.filter((c) => !c.online).length,
    activeSessions: active,
    energyToday,
    revenueToday,
    openAlerts: state.alerts.filter((a) => a.status === 'open').length,
  };
}

// Daily totals for the last `days` days (oldest first), bucketed by session start.
export function dailySeries(sessions, days = 14, now = Date.now()) {
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    buckets.set(dayKey(startOfDay(now) - i * 86400000 + 43200000), { energy: 0, sessions: 0, revenue: 0 });
  }
  for (const s of sessions) {
    const b = buckets.get(dayKey(s.startedAt));
    if (!b) continue;
    b.energy += s.energyKwh;
    b.sessions += 1;
    b.revenue += s.cost || 0;
  }
  return [...buckets.entries()].map(([day, v]) => ({
    day, energy: Math.round(v.energy * 10) / 10, sessions: v.sessions, revenue: Math.round(v.revenue),
  }));
}

// Share of the window each charger's connectors spent in a session (0-100).
export function utilisationByCharger(state, days = 7, now = Date.now()) {
  const from = now - days * 86400000;
  const busy = new Map();
  for (const s of state.sessions) {
    const end = s.endedAt || now;
    if (end < from) continue;
    const overlap = Math.max(0, end - Math.max(s.startedAt, from));
    busy.set(s.chargerId, (busy.get(s.chargerId) || 0) + overlap);
  }
  return state.chargers.map((ch) => {
    const n = state.connectors.filter((c) => c.chargerId === ch.id).length || 1;
    return { id: ch.id, name: ch.name, utilisation: Math.round(((busy.get(ch.id) || 0) / (n * days * 86400000)) * 1000) / 10 };
  });
}

export function connectorLabel(state, connectorId) {
  const c = byId(state.connectors, connectorId);
  if (!c) return connectorId || '—';
  const ch = byId(state.chargers, c.chargerId);
  return `${ch ? ch.name : c.chargerId} · ${c.label}`;
}
