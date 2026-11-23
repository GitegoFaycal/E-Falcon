import { useState } from 'react';
import { Download } from 'lucide-react';
import { useStore } from '../context/store.jsx';
import { DATA_SOURCE } from '../services/api.js';
import { Button, Card, PageHeader, Select, Field, StatCard } from '../components/ui.jsx';
import { SessionTable } from '../components/tables.jsx';
import { byId, connectorsOf } from '../lib/selectors.js';
import { dayKey, downloadCsv, fmtKwh, fmtMoney } from '../lib/format.js';

export default function Sessions() {
  const state = useStore();
  const cur = state.settings.currency;
  const [from, setFrom] = useState(dayKey(Date.now() - 6 * 86400000));
  const [to, setTo] = useState(dayKey(Date.now()));
  const [charger, setCharger] = useState('');
  const [location, setLocation] = useState('');
  const [connector, setConnector] = useState('');
  const [status, setStatus] = useState('');

  const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
  const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
  const rows = state.sessions.filter((s) => {
    const ch = byId(state.chargers, s.chargerId);
    return s.startedAt >= fromTs && s.startedAt <= toTs
      && (!charger || s.chargerId === charger)
      && (!location || (ch && ch.locationId === location))
      && (!connector || s.connectorId === connector)
      && (!status || s.status === status);
  });
  const energy = rows.reduce((n, s) => n + s.energyKwh, 0);
  const revenue = rows.reduce((n, s) => n + (s.cost || 0), 0);
  const connectorOptions = charger ? connectorsOf(state, charger).map((c) => ({ value: c.id, label: c.label })) : [];

  const exportCsv = () => downloadCsv(`sessions-${from}-to-${to}.csv`, [
    ['Session', 'Transaction', 'Charger', 'Connector', 'Identifier', 'Start', 'End', 'Energy kWh', 'Status', 'Stop reason', 'Tariff', `Price at start (${cur}/kWh)`, `Cost (${cur})`, 'Cost source', 'Data source'],
    ...rows.map((s) => [s.id, s.transactionId, (byId(state.chargers, s.chargerId) || {}).name || s.chargerId, (byId(state.connectors, s.connectorId) || {}).label || '', s.idTag, new Date(s.startedAt).toISOString(), s.endedAt ? new Date(s.endedAt).toISOString() : '', s.energyKwh.toFixed(3), s.status, s.stopReason || '', s.ruleName || '', s.priceAtStart, s.cost, s.costSource, DATA_SOURCE]),
  ]);

  return (
    <div>
      <PageHeader title="Charging sessions" subtitle="Live and completed sessions" actions={<><Button icon={Download} onClick={exportCsv} disabled={!rows.length}>Export CSV</Button></>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sessions" value={rows.length} sub="in this selection" />
        <StatCard label="Active now" value={rows.filter((s) => s.status === 'active').length} />
        <StatCard label="Energy" value={fmtKwh(energy, 0)} />
        <StatCard label="Cost total" value={fmtMoney(revenue, cur)} sub="CMS-calculated, not payment data" />
      </div>

      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Location"><Select value={location} onChange={setLocation} options={[{ value: '', label: 'All' }, ...state.locations.map((l) => ({ value: l.id, label: l.name }))]} /></Field>
          <Field label="Charger"><Select value={charger} onChange={(v) => { setCharger(v); setConnector(''); }} options={[{ value: '', label: 'All' }, ...state.chargers.filter((c) => !location || c.locationId === location).map((c) => ({ value: c.id, label: c.name }))]} /></Field>
          <Field label="Connector"><Select value={connector} onChange={setConnector} disabled={!charger} options={[{ value: '', label: charger ? 'All' : 'Choose a charger' }, ...connectorOptions]} /></Field>
          <Field label="Status"><Select value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'active', label: 'Charging' }, { value: 'completed', label: 'Completed' }, { value: 'failed', label: 'Failed' }]} /></Field>
        </div>
        <SessionTable sessions={rows} pageSize={15} />
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">Identifiers are the tag IDs reported by the charger. No customer or payment data exists in this system. Cost is energy × the CMS tariff plus fees; it is not a payment record.</p>
      </Card>
    </div>
  );
}
