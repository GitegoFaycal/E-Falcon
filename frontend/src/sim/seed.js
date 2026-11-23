// SIMULATED DATA. Everything produced here is fictional demo data for development without
// hardware. Nothing in this file describes a real charger, customer, payment or price.
// Used only in demo mode (no VITE_API_URL).
import { rateAt } from '../lib/tariff.js';
import { DEFAULT_ROLE_PERMISSIONS } from '../lib/permissions.js';

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIX = { cmd: 'CMD', ses: 'S', alr: 'ALR', evt: 'EVT', aud: 'AUD', dep: 'DEP', asg: 'ASG', rule: 'TAR', op: 'OP', chg: 'CH', loc: 'LOC', grp: 'GRP', usr: 'USR', per: 'P' };

export function makeId(state, kind) {
  state.seq[kind] = (state.seq[kind] || 0) + 1;
  return `${PREFIX[kind]}-${String(state.seq[kind]).padStart(kind === 'ses' || kind === 'cmd' ? 6 : 4, '0')}`;
}

const FULL = { changeAvailability: 'verified', remoteStartStop: 'verified', configuration: 'verified', reset: 'verified', smartCharging: 'unverified', tariffSync: 'verified' };

const CHARGER_DEFS = [
  // ocppId, name, location, model kW, capability overrides, simulation flags
  ['EF-KGL-001', 'CBD Hub 01', 0, 120, {}, {}],
  ['EF-KGL-002', 'CBD Hub 02', 0, 120, {}, {}],
  ['EF-KGL-003', 'CBD Hub 03', 0, 120, {}, {}],
  ['EF-KGL-004', 'CBD Hub 04', 0, 60, {}, {}],
  ['EF-KMH-001', 'Kimihurura 01', 1, 120, {}, {}],
  ['EF-KMH-002', 'Kimihurura 02', 1, 120, {}, { startOffline: true }],
  ['EF-KMH-003', 'Kimihurura 03', 1, 60, { tariffSync: 'unverified' }, {}],
  ['EF-RMR-001', 'Remera 01', 2, 120, { tariffSync: 'unverified', remoteStartStop: 'unverified' }, {}],
  ['EF-RMR-002', 'Remera 02', 2, 60, { tariffSync: 'unsupported', smartCharging: 'unsupported' }, {}],
  ['EF-MSZ-001', 'Musanze 01', 3, 60, { changeAvailability: 'unverified' }, { flaky: true }],
];

export function buildSeed(now = Date.now()) {
  const rng = mulberry32(20261123);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const state = {
    seq: {},
    settings: {
      orgName: 'E-Falcon',
      currency: 'RWF',
      timezone: 'Africa/Kigali',
      commandTimeoutSec: 10,
      heartbeatIntervalSec: 30,
      operationalLimit: { maxEnabledConnectors: 17, policy: 'block', stopSessionsOnReduce: false },
      rolePermissions: JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMISSIONS)),
    },
    users: [], locations: [], groups: [], chargers: [], connectors: [],
    pricingRules: [], pricingAssignments: [], pricingDeployments: [],
    sessions: [], commands: [], alerts: [], events: [], audit: [], scheduledOps: [],
  };

  // Demo users (demo mode has no passwords).
  [['Demo Admin', 'admin@example.com', 'admin'], ['Demo Operator', 'operator@example.com', 'operator'], ['Demo Viewer', 'viewer@example.com', 'viewer']]
    .forEach(([name, email, role]) => state.users.push({ id: makeId(state, 'usr'), name, email, role, active: true, createdAt: now - 60 * 86400000, lastLoginAt: null }));

  [['Kigali CBD Hub', 'KN 4 Ave, Kigali', 'Kigali'], ['Kimihurura Plaza', 'KG 28 Ave, Kigali', 'Kigali'], ['Remera Station', 'KG 11 Ave, Kigali', 'Kigali'], ['Musanze Stopover', 'NR 4, Musanze', 'Musanze']]
    .forEach(([name, address, city]) => state.locations.push({ id: makeId(state, 'loc'), name, address, city, notes: '' }));

  [['Kigali City', 'All chargers inside Kigali', null], ['Fast Chargers', '120 kW units', null], ['Public Chargers', 'Open to the public', null], ['Maintenance Group', 'Units under scheduled maintenance', null]]
    .forEach(([name, description, locationId]) => state.groups.push({ id: makeId(state, 'grp'), name, description, locationId, availabilityPolicy: '' }));

  // Tariffs. Period layout mirrors the charger's tariff screen (4 start times, energy + service price).
  const period = (start, energyPrice, servicePrice, kind) => ({ id: makeId(state, 'per'), start, energyPrice, servicePrice, kind });
  const rule = (name, description, periods, extra = {}) => {
    const r = { id: makeId(state, 'rule'), name, description, version: 1, periods, weekendPeriods: null, flatFee: 0, hourPrice: 0, preauthAmount: 5000, createdAt: now - 30 * 86400000, updatedAt: now - 30 * 86400000, ...extra };
    state.pricingRules.push(r);
    return r;
  };
  const standard = rule('Standard', 'Network default tariff', [period('00:00', 380, 60, 'offpeak'), period('06:00', 420, 60, 'standard'), period('12:00', 420, 60, 'standard'), period('16:00', 480, 60, 'peak')]);
  const stopover = rule('Highway Stopover', 'Flat tariff for the Musanze site', [period('00:00', 450, 80, 'standard')], { flatFee: 500 });
  rule('Weekend Saver', 'Cheaper weekends (weekend schedule is CMS-side only)', [period('00:00', 380, 60, 'offpeak'), period('06:00', 420, 60, 'standard'), period('16:00', 480, 60, 'peak')], { weekendPeriods: [period('00:00', 360, 60, 'offpeak')] });

  const assign = (ruleId, scope, targetId) => state.pricingAssignments.push({
    id: makeId(state, 'asg'), ruleId, scope, targetId, status: 'active', effectiveAt: now - 30 * 86400000,
    activatedAt: now - 30 * 86400000, createdAt: now - 30 * 86400000, createdBy: 'Demo Admin',
  });
  assign(standard.id, 'global', null);
  assign(stopover.id, 'location', state.locations[3].id);

  // Chargers and connectors.
  CHARGER_DEFS.forEach(([ocppId, name, locIdx, kw, caps, sim], i) => {
    const id = makeId(state, 'chg');
    const groupIds = [];
    if (locIdx < 3) groupIds.push(state.groups[0].id);
    if (kw === 120) groupIds.push(state.groups[1].id);
    groupIds.push(state.groups[2].id);
    const online = !sim.startOffline;
    state.chargers.push({
      id, ocppId, name,
      serial: `SIM${String(2600100 + i * 37)}`,
      model: `DC Dual-Gun ${kw} kW`,
      manufacturer: 'Simulated',
      firmware: kw === 120 ? 'sim-2.4.1' : 'sim-2.3.0',
      ocppVersion: '1.6J',
      locationId: state.locations[locIdx].id,
      groupIds,
      online,
      everConnected: true,
      lastHeartbeat: online ? now - Math.floor(rng() * 20000) : now - 47 * 60000,
      bootedAt: now - (2 + Math.floor(rng() * 9)) * 86400000,
      capabilities: { ...FULL, ...caps },
      hardware: { ratedPowerKw: kw, powerSharing: 'unknown', maxTariffPeriods: 4, notes: '' },
      sim: { flaky: Boolean(sim.flaky) },
      simulated: true,
      createdAt: now - 45 * 86400000,
    });
    ['A GUN', 'B GUN'].forEach((label, k) => {
      state.connectors.push({
        id: `${id}-${k + 1}`, chargerId: id, connectorId: k + 1, label, type: 'CCS2', maxPowerKw: kw,
        enabled: true, maintenance: false, status: 'Available', errorCode: 'NoError', errorInfo: '',
        powerKw: 0, meterWh: Math.round((1.2 + rng() * 7.5) * 1e6), sessionId: null,
        pendingInoperative: false, pendingMaintenance: false, simulated: true,
      });
    });
  });

  const conn = (chargerIdx, k) => state.connectors[chargerIdx * 2 + k];
  const restrict = (c, maintenance) => { c.enabled = false; c.status = 'Unavailable'; c.maintenance = maintenance; };
  restrict(conn(4, 1), false);
  restrict(conn(7, 0), true);
  restrict(conn(7, 1), true);
  restrict(conn(9, 1), false);
  state.chargers[7].groupIds.push(state.groups[3].id);
  conn(2, 1).status = 'Faulted';
  conn(2, 1).errorCode = 'GroundFailure';
  conn(2, 1).errorInfo = 'Simulated fault';

  // Session history: 14 days.
  const chargerOf = (c) => state.chargers.find((x) => x.id === c.chargerId);
  const ruleFor = (c) => (chargerOf(c).locationId === state.locations[3].id ? stopover : standard);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const history = [];
  for (let d = 13; d >= 0; d -= 1) {
    for (const c of state.connectors) {
      if (!c.enabled && d < 3) continue;
      const n = 1 + Math.floor(rng() * 3);
      const hours = [7, 9, 11, 13, 15, 17, 19, 21].filter(() => rng() < n / 8 + 0.12).slice(0, 3);
      for (const h of hours) {
        const startedAt = dayStart.getTime() - d * 86400000 + h * 3600000 + Math.floor(rng() * 50) * 60000;
        const durMin = 20 + Math.floor(rng() * 55);
        const endedAt = startedAt + durMin * 60000;
        if (endedAt > now - 45 * 60000) continue;
        const energyKwh = Math.round(c.maxPowerKw * (0.35 + rng() * 0.4) * (durMin / 60) * 10) / 10;
        const r = ruleFor(c);
        const rate = rateAt(r, new Date(startedAt));
        const failed = rng() < 0.03;
        history.push({
          chargerId: c.chargerId, connectorId: c.id, idTag: `SIM-TAG-${String(1000 + Math.floor(rng() * 9000))}`,
          startedAt, endedAt, energyKwh: failed ? Math.round(energyKwh * 2) / 10 : energyKwh,
          status: failed ? 'failed' : 'completed', stopReason: failed ? 'Fault' : pick(['Local', 'Local', 'EVDisconnected', 'Remote']),
          ruleId: r.id, ruleName: r.name, ruleVersion: 1, priceAtStart: rate.total,
          fees: { flatFee: r.flatFee, hourPrice: r.hourPrice },
        });
      }
    }
  }
  history.sort((a, b) => a.startedAt - b.startedAt);
  for (const h of history) {
    const energyCost = h.energyKwh * h.priceAtStart;
    state.sessions.push({
      id: makeId(state, 'ses'), transactionId: state.seq.ses, ...h, meterStartWh: null, targetKwh: null,
      energyCost, cost: Math.round(energyCost + h.fees.flatFee + h.fees.hourPrice * ((h.endedAt - h.startedAt) / 3600000)),
      costSource: 'cms_calculated', simulated: true,
    });
  }

  // Sessions in progress.
  [[0, 0], [0, 1], [1, 0], [3, 1], [4, 0], [6, 0], [8, 1]].forEach(([ci, k]) => {
    const c = conn(ci, k);
    const r = ruleFor(c);
    const startedAt = now - (4 + Math.floor(rng() * 35)) * 60000;
    const power = Math.round(c.maxPowerKw * (0.45 + rng() * 0.4) * 10) / 10;
    const energyKwh = Math.round(power * ((now - startedAt) / 3600000) * 0.9 * 100) / 100;
    const rate = rateAt(r, new Date(startedAt));
    const id = makeId(state, 'ses');
    state.sessions.push({
      id, transactionId: state.seq.ses, chargerId: c.chargerId, connectorId: c.id,
      idTag: `SIM-TAG-${String(1000 + Math.floor(rng() * 9000))}`, startedAt, endedAt: null,
      meterStartWh: c.meterWh - energyKwh * 1000, energyKwh, targetKwh: energyKwh + 6 + rng() * 40,
      status: 'active', stopReason: null, ruleId: r.id, ruleName: r.name, ruleVersion: 1, priceAtStart: rate.total,
      fees: { flatFee: r.flatFee, hourPrice: r.hourPrice }, energyCost: energyKwh * rate.total,
      cost: Math.round(energyKwh * rate.total + r.flatFee), costSource: 'cms_calculated', simulated: true,
    });
    c.status = 'Charging'; c.sessionId = id; c.powerKw = power;
  });
  state.sessions.reverse(); // newest first

  // Initial tariff deployments (one per charger) so the sync table has a history.
  state.chargers.forEach((ch) => {
    const r = ch.locationId === state.locations[3].id ? stopover : standard;
    const cap = ch.capabilities.tariffSync;
    state.pricingDeployments.push({
      id: makeId(state, 'dep'), chargerId: ch.id, ruleId: r.id, ruleName: r.name, ruleVersion: 1, current: true,
      stage: cap === 'unsupported' ? 'cms_only' : 'confirmed', commandId: null, requestedBy: 'Demo Admin',
      detail: cap === 'unsupported'
        ? 'This charger has no tariff interface. The price is used for CMS billing calculation only; the tariff on the unit itself is unchanged.'
        : 'Tariff accepted by the simulated charger.',
      createdAt: now - 30 * 86400000, updatedAt: now - 30 * 86400000,
    });
  });

  const off = state.chargers[5];
  state.alerts.push(
    { id: makeId(state, 'alr'), type: 'charger_offline', severity: 'critical', chargerId: off.id, connectorId: null, message: `${off.name} stopped responding (no heartbeat).`, createdAt: now - 46 * 60000, status: 'open', acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, resolutionNote: '' },
    { id: makeId(state, 'alr'), type: 'connector_fault', severity: 'critical', chargerId: state.chargers[2].id, connectorId: conn(2, 1).id, message: `${state.chargers[2].name} · B GUN reported GroundFailure.`, createdAt: now - 18 * 60000, status: 'open', acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, resolutionNote: '' },
    { id: makeId(state, 'alr'), type: 'command_failed', severity: 'warning', chargerId: state.chargers[9].id, connectorId: null, message: `ChangeAvailability to ${state.chargers[9].name} timed out.`, createdAt: now - 26 * 3600000, status: 'resolved', acknowledgedBy: 'Demo Operator', acknowledgedAt: now - 25.5 * 3600000, resolvedAt: now - 24 * 3600000, resolutionNote: 'Retried after connection recovered.' },
  );
  state.alerts.sort((a, b) => b.createdAt - a.createdAt);

  state.events.push(
    { id: makeId(state, 'evt'), chargerId: state.chargers[2].id, connectorId: conn(2, 1).id, type: 'fault', message: 'StatusNotification: Faulted (GroundFailure)', at: now - 18 * 60000 },
    { id: makeId(state, 'evt'), chargerId: off.id, connectorId: null, type: 'disconnect', message: 'WebSocket connection closed', at: now - 47 * 60000 },
  );
  state.events.sort((a, b) => b.at - a.at);

  state.audit.push(
    { id: makeId(state, 'aud'), userId: state.users[0].id, userName: 'Demo Admin', action: 'limit.update', entityType: 'settings', entityId: 'operationalLimit', entityLabel: 'Operational limit', before: { maxEnabledConnectors: 20 }, after: { maxEnabledConnectors: 17 }, details: 'Seeded example entry', at: now - 3 * 86400000 },
    { id: makeId(state, 'aud'), userId: state.users[0].id, userName: 'Demo Admin', action: 'pricing.assign', entityType: 'pricing_assignment', entityId: state.pricingAssignments[1].id, entityLabel: 'Highway Stopover → Musanze Stopover', before: null, after: { rule: 'Highway Stopover', scope: 'location' }, details: 'Seeded example entry', at: now - 30 * 86400000 },
  );

  return state;
}
