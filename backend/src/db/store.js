// Persistence for the domain state.
//
// The server holds the operational state in memory (see core/engine.js) and this module
// writes every change through to the database: load() builds the state at start-up, flush()
// compares the state with what was last written and upserts or deletes exactly the rows that
// changed, in one transaction. The same list of changed rows is returned so the real-time
// hub can push it to browsers.
//
// "live" tables are fully held in memory and mirrored exactly (including deletions).
// "history" tables only keep a recent window in memory; rows are inserted and updated but
// never deleted from the database when they leave the window.

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const q = (name) => `"${name}"`;

export const TABLES = {
  users: { table: 'users', cols: ['id', 'name', 'email', 'role', 'active', 'passwordHash', 'createdAt', 'lastLoginAt'], bool: ['active'], order: 'created_at' },
  locations: { table: 'locations', cols: ['id', 'name', 'address', 'city', 'notes'], order: 'id' },
  groups: { table: 'charger_groups', cols: ['id', 'name', 'description', 'locationId', 'availabilityPolicy'], order: 'id' },
  chargers: {
    table: 'chargers', order: 'created_at',
    cols: ['id', 'ocppId', 'name', 'serial', 'model', 'manufacturer', 'firmware', 'ocppVersion', 'locationId', 'online', 'everConnected', 'lastHeartbeat', 'bootedAt', 'capabilities', 'hardware', 'reported', 'authKeyHash', 'createdAt'],
    bool: ['online', 'everConnected'], json: ['capabilities', 'hardware', 'reported'],
  },
  connectors: {
    table: 'connectors', order: 'id',
    cols: ['id', 'chargerId', 'connectorId', 'label', 'type', 'maxPowerKw', 'enabled', 'adminConfirmed', 'maintenance', 'status', 'errorCode', 'errorInfo', 'powerKw', 'meterWh', 'sessionId', 'pendingInoperative', 'pendingMaintenance'],
    bool: ['enabled', 'adminConfirmed', 'maintenance', 'pendingInoperative', 'pendingMaintenance'],
  },
  pricingRules: { table: 'pricing_rules', cols: ['id', 'name', 'description', 'version', 'flatFee', 'hourPrice', 'preauthAmount', 'createdAt', 'updatedAt'], order: 'created_at' },
  pricingAssignments: {
    table: 'pricing_assignments', cols: ['id', 'ruleId', 'scope', 'targetId', 'status', 'effectiveAt', 'activatedAt', 'endedAt', 'createdAt', 'createdBy'],
    history: { by: 'created_at', keep: 2000, open: (r) => ['active', 'scheduled'].includes(r.status) },
  },
  pricingDeployments: {
    table: 'pricing_deployments', cols: ['id', 'chargerId', 'ruleId', 'ruleName', 'ruleVersion', 'current', 'stage', 'commandId', 'requestedBy', 'detail', 'createdAt', 'updatedAt'], bool: ['current'],
    history: { by: 'created_at', keep: 2000, open: (r) => r.current },
  },
  sessions: {
    table: 'charging_sessions', json: ['fees'],
    cols: ['id', 'transactionId', 'chargerId', 'connectorId', 'idTag', 'startedAt', 'endedAt', 'meterStartWh', 'meterStopWh', 'energyKwh', 'status', 'stopReason', 'ruleId', 'ruleName', 'ruleVersion', 'priceAtStart', 'fees', 'energyCost', 'cost', 'costSource'],
    history: { by: 'started_at', keep: 5000, open: (r) => !r.endedAt },
  },
  commands: {
    table: 'charger_commands', json: ['payload', 'meta', 'response'],
    cols: ['id', 'chargerId', 'connectorId', 'type', 'payload', 'meta', 'requestedBy', 'requestedById', 'requestedAt', 'status', 'sentAt', 'completedAt', 'response', 'error', 'resultCode', 'attempts', 'maxAttempts'],
    history: { by: 'requested_at', keep: 2000, open: (r) => ['pending', 'sent', 'acknowledged'].includes(r.status) },
  },
  events: { table: 'charger_events', cols: ['id', 'chargerId', 'connectorId', 'type', 'message', 'at'], history: { by: 'at', keep: 800, open: () => false } },
  alerts: {
    table: 'alerts', cols: ['id', 'type', 'severity', 'chargerId', 'connectorId', 'message', 'createdAt', 'status', 'acknowledgedBy', 'acknowledgedAt', 'resolvedAt', 'resolutionNote'],
    history: { by: 'created_at', keep: 1000, open: (r) => r.status !== 'resolved' },
  },
  audit: {
    table: 'audit_logs', json: ['before', 'after'], cols: ['id', 'userId', 'userName', 'action', 'entityType', 'entityId', 'entityLabel', 'before', 'after', 'details', 'at'],
    history: { by: 'at', keep: 2000, open: () => false },
  },
  scheduledOps: {
    table: 'scheduled_operations', json: ['payload', 'result'], cols: ['id', 'type', 'runAt', 'payload', 'status', 'createdBy', 'createdById', 'createdAt', 'executedAt', 'result', 'error'],
    history: { by: 'created_at', keep: 500, open: (r) => r.status === 'scheduled' },
  },
};

// Dependency order for inserts; deletions run in reverse.
const WRITE_ORDER = ['users', 'locations', 'groups', 'chargers', 'connectors', 'pricingRules', 'pricingAssignments', 'pricingDeployments', 'sessions', 'commands', 'events', 'alerts', 'audit', 'scheduledOps'];

function toRow(def, obj) {
  return def.cols.map((c) => {
    const v = obj[c];
    if (v === undefined || v === null) return null;
    if ((def.json || []).includes(c)) return JSON.stringify(v);
    return v;
  });
}

function fromRow(def, row) {
  const obj = {};
  for (const c of def.cols) {
    let v = row[snake(c)];
    if (v === undefined) v = null;
    if (v !== null && (def.bool || []).includes(c)) v = v === true || v === 1 || v === '1';
    if (v !== null && (def.json || []).includes(c)) v = JSON.parse(v);
    obj[c] = v;
  }
  return obj;
}

const upsertSql = (def) => {
  const cols = def.cols.map(snake);
  return `INSERT INTO ${q(def.table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) `
    + `ON CONFLICT ("id") DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`;
};

// What is compared to detect a change. Chargers and tariffs carry child rows.
const fingerprint = (key, obj) => JSON.stringify(obj);

export function createStore(db) {
  const known = Object.fromEntries(Object.keys(TABLES).map((k) => [k, new Map()]));
  const watching = Object.fromEntries(Object.keys(TABLES).map((k) => [k, new Set()]));
  let knownSettings = new Map();
  let queue = Promise.resolve();
  const appendQueue = [];

  async function load() {
    const state = { settings: {}, seq: {} };
    for (const row of await db.query('SELECT "key", "value" FROM "system_settings"')) {
      const value = JSON.parse(row.value);
      if (row.key === 'seq') state.seq = value; else state.settings[row.key] = value;
      knownSettings.set(row.key, row.value);
    }
    for (const key of WRITE_ORDER) {
      const def = TABLES[key];
      const sql = def.history
        ? `SELECT * FROM ${q(def.table)} ORDER BY ${q(def.history.by)} DESC LIMIT ${def.history.keep}`
        : `SELECT * FROM ${q(def.table)} ORDER BY ${q(def.order)}`;
      state[key] = (await db.query(sql)).map((r) => fromRow(def, r));
    }
    // Child rows.
    const members = await db.query('SELECT "group_id", "charger_id" FROM "charger_group_members"');
    for (const ch of state.chargers) ch.groupIds = members.filter((m) => m.charger_id === ch.id).map((m) => m.group_id);
    const periods = await db.query('SELECT * FROM "pricing_periods" ORDER BY "start"');
    for (const rule of state.pricingRules) {
      const mine = periods.filter((p) => p.rule_id === rule.id).map((p) => ({ id: p.id, start: p.start, energyPrice: p.energy_price, servicePrice: p.service_price, kind: p.kind, weekend: p.weekend === true || p.weekend === 1 }));
      const strip = ({ weekend, ...rest }) => rest;
      rule.periods = mine.filter((p) => !p.weekend).map(strip);
      const weekend = mine.filter((p) => p.weekend).map(strip);
      rule.weekendPeriods = weekend.length ? weekend : null;
    }
    for (const key of WRITE_ORDER) {
      const def = TABLES[key];
      for (const obj of state[key]) {
        known[key].set(obj.id, fingerprint(key, obj));
        if (def.history && def.history.open(obj)) watching[key].add(obj.id);
      }
    }
    return state;
  }

  async function writeChildren(t, key, obj) {
    if (key === 'chargers') {
      await t.query('DELETE FROM "charger_group_members" WHERE "charger_id" = ?', [obj.id]);
      for (const g of obj.groupIds || []) await t.query('INSERT INTO "charger_group_members" ("group_id", "charger_id") VALUES (?, ?)', [g, obj.id]);
    } else if (key === 'pricingRules') {
      await t.query('DELETE FROM "pricing_periods" WHERE "rule_id" = ?', [obj.id]);
      const all = [...(obj.periods || []).map((p) => [p, false]), ...(obj.weekendPeriods || []).map((p) => [p, true])];
      for (const [p, weekend] of all) {
        await t.query('INSERT INTO "pricing_periods" ("id", "rule_id", "weekend", "start", "energy_price", "service_price", "kind") VALUES (?, ?, ?, ?, ?, ?, ?)', [p.id, obj.id, weekend, p.start, p.energyPrice, p.servicePrice, p.kind || 'standard']);
      }
    }
  }

  // Finds what changed since the last flush. Pure bookkeeping, no I/O.
  function diff(state) {
    const changes = { upserts: [], deletes: [], settings: [] };
    for (const key of WRITE_ORDER) {
      const def = TABLES[key];
      const seen = def.history ? null : new Set();
      for (const obj of state[key]) {
        if (seen) seen.add(obj.id);
        const prev = known[key].get(obj.id);
        if (def.history && prev !== undefined && !watching[key].has(obj.id)) continue; // closed history rows never change
        const fp = fingerprint(key, obj);
        if (fp !== prev) {
          known[key].set(obj.id, fp);
          changes.upserts.push({ key, obj });
        }
        if (def.history) {
          if (def.history.open(obj)) watching[key].add(obj.id); else watching[key].delete(obj.id);
        }
      }
      if (seen) {
        for (const id of [...known[key].keys()]) {
          if (!seen.has(id)) { known[key].delete(id); changes.deletes.push({ key, id }); }
        }
      }
    }
    const settings = { ...state.settings, seq: state.seq };
    for (const [k, v] of Object.entries(settings)) {
      const json = JSON.stringify(v);
      if (knownSettings.get(k) !== json) { knownSettings.set(k, json); changes.settings.push({ key: k, json }); }
    }
    return changes;
  }

  async function write(changes, appends) {
    if (!changes.upserts.length && !changes.deletes.length && !changes.settings.length && !appends.length) return;
    await db.tx(async (t) => {
      for (const { key, json } of changes.settings) {
        await t.query('INSERT INTO "system_settings" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"', [key, json]);
      }
      for (const { key, obj } of changes.upserts) {
        await t.query(upsertSql(TABLES[key]), toRow(TABLES[key], obj));
        await writeChildren(t, key, obj);
      }
      for (const { key, id } of [...changes.deletes].reverse()) {
        await t.query(`DELETE FROM ${q(TABLES[key].table)} WHERE "id" = ?`, [id]);
      }
      for (const { table, row } of appends) {
        const cols = Object.keys(row);
        await t.query(`INSERT INTO ${q(table)} (${cols.map((c) => q(snake(c))).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
      }
    });
  }

  return {
    load,
    // Insert-only rows that are not part of the in-memory state (meter values).
    append(table, row) { appendQueue.push({ table, row }); },
    // Serialised: flushes never overlap, and each one sees the state as it is when it runs.
    flush(state) {
      const run = queue.then(async () => {
        const changes = diff(state);
        const appends = appendQueue.splice(0);
        try {
          await write(changes, appends);
        } catch (e) {
          // Nothing was committed: forget the fingerprints so the next flush retries these rows.
          for (const { key, obj } of changes.upserts) known[key].delete(obj.id);
          for (const { key, id } of changes.deletes) known[key].set(id, '');
          for (const { key } of changes.settings) knownSettings.delete(key);
          appendQueue.unshift(...appends);
          throw e;
        }
        return changes;
      });
      queue = run.catch(() => {});
      return run;
    },
    // Read-side helpers for data that lives only in the database.
    async rows(sql, params) { return db.query(sql, params); },
    camelRow: (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])),
  };
}
