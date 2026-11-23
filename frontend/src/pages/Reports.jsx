import { useState } from 'react';
import { Download, BarChart3 } from 'lucide-react';
import { useStore } from '../context/store.jsx';
import { DATA_SOURCE } from '../services/api.js';
import { Button, Card, CardHeader, PageHeader, Select, Field, StatCard, TableWrap, EmptyState } from '../components/ui.jsx';
import { DailyChart, HorizontalBars } from '../components/charts.jsx';
import { byId, dailySeries } from '../lib/selectors.js';
import { dayKey, shortDay, downloadCsv, fmtKwh, fmtMoney, fmtNumber, fmtDuration } from '../lib/format.js';

const METRICS = [
  { value: 'energy', label: 'Energy (kWh)', unit: 'kWh' },
  { value: 'sessions', label: 'Sessions', unit: 'sessions' },
  { value: 'revenue', label: 'Revenue (CMS-calculated)', unit: '' },
];

export default function Reports() {
  const state = useStore();
  const cur = state.settings.currency;
  const [from, setFrom] = useState(dayKey(Date.now() - 13 * 86400000));
  const [to, setTo] = useState(dayKey(Date.now()));
  const [groupBy, setGroupBy] = useState('charger');
  const [metric, setMetric] = useState('energy');
  const [location, setLocation] = useState('');

  const fromTs = new Date(`${from}T00:00:00`).getTime();
  const toTs = new Date(`${to}T23:59:59.999`).getTime();
  const valid = Number.isFinite(fromTs) && Number.isFinite(toTs) && fromTs <= toTs;
  const days = valid ? Math.round((toTs - fromTs) / 86400000) : 0;
  const sessions = valid ? state.sessions.filter((s) => {
    const ch = byId(state.chargers, s.chargerId);
    return s.startedAt >= fromTs && s.startedAt <= toTs && (!location || (ch && ch.locationId === location));
  }) : [];

  const keyOf = (s) => {
    if (groupBy === 'day') return dayKey(s.startedAt);
    if (groupBy === 'charger') return s.chargerId;
    if (groupBy === 'tariff') return s.ruleName || 'No tariff';
    const ch = byId(state.chargers, s.chargerId);
    return ch ? ch.locationId : 'unknown';
  };
  const nameOf = (k) => {
    if (groupBy === 'day') return shortDay(k);
    if (groupBy === 'charger') return (byId(state.chargers, k) || {}).name || `${k} (deleted)`;
    if (groupBy === 'tariff') return k;
    return (byId(state.locations, k) || {}).name || 'Unknown location';
  };
  const groups = new Map();
  for (const s of sessions) {
    const k = keyOf(s);
    const g = groups.get(k) || { key: k, sessions: 0, energy: 0, revenue: 0, failed: 0, duration: 0 };
    g.sessions += 1;
    g.energy += s.energyKwh;
    g.revenue += s.cost || 0;
    g.failed += s.status === 'failed' ? 1 : 0;
    g.duration += (s.endedAt || Date.now()) - s.startedAt;
    groups.set(k, g);
  }
  const rows = [...groups.values()].map((g) => ({ ...g, name: nameOf(g.key), energy: Math.round(g.energy * 10) / 10, revenue: Math.round(g.revenue) }))
    .sort((a, b) => (groupBy === 'day' ? a.key.localeCompare(b.key) : b[metric] - a[metric]));
  const total = rows.reduce((t, r) => ({ sessions: t.sessions + r.sessions, energy: t.energy + r.energy, revenue: t.revenue + r.revenue, failed: t.failed + r.failed, duration: t.duration + r.duration }), { sessions: 0, energy: 0, revenue: 0, failed: 0, duration: 0 });
  const m = METRICS.find((x) => x.value === metric);
  const unit = metric === 'revenue' ? cur : m.unit;

  const exportCsv = () => downloadCsv(`report-${groupBy}-${from}-to-${to}.csv`, [
    [groupBy, 'Sessions', 'Failed sessions', 'Energy kWh', `Revenue ${cur} (CMS-calculated)`, 'Total session time (min)', 'Avg kWh per session', 'Data source'],
    ...rows.map((r) => [r.name, r.sessions, r.failed, r.energy, r.revenue, Math.round(r.duration / 60000), r.sessions ? (r.energy / r.sessions).toFixed(1) : 0, DATA_SOURCE]),
  ]);

  return (
    <div>
      <PageHeader title="Reports" subtitle="Energy, sessions and revenue for any period" actions={<><Button icon={Download} onClick={exportCsv} disabled={!rows.length}>Export CSV</Button></>} />

      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Location"><Select value={location} onChange={setLocation} options={[{ value: '', label: 'All locations' }, ...state.locations.map((l) => ({ value: l.id, label: l.name }))]} /></Field>
          <Field label="Group by"><Select value={groupBy} onChange={setGroupBy} options={[{ value: 'charger', label: 'Charger' }, { value: 'location', label: 'Location' }, { value: 'day', label: 'Day' }, { value: 'tariff', label: 'Tariff' }]} /></Field>
          <Field label="Chart metric"><Select value={metric} onChange={setMetric} options={METRICS} /></Field>
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Sessions" value={fmtNumber(total.sessions)} sub={`${total.failed} failed`} />
        <StatCard label="Energy" value={fmtKwh(total.energy, 0)} />
        <StatCard label="Revenue" value={fmtMoney(total.revenue, cur)} sub="CMS-calculated" />
        <StatCard label="Avg per session" value={total.sessions ? fmtKwh(total.energy / total.sessions, 1) : '—'} sub={total.sessions ? fmtDuration(total.duration / total.sessions) : ''} />
        <StatCard label="Avg revenue / kWh" value={total.energy ? fmtMoney(total.revenue / total.energy, cur) : '—'} sub="incl. fees" />
      </div>

      {!valid ? <Card><EmptyState icon={BarChart3} title="Choose a valid date range" text="“From” must be on or before “To”." /></Card> : rows.length === 0 ? <Card><EmptyState icon={BarChart3} title="No sessions in this period" text="Widen the date range or clear the location filter." /></Card> : (
        <>
          <Card className="mb-4">
            <CardHeader title={`${m.label.replace(' (CMS-calculated)', '')} by ${groupBy}`} subtitle={`${shortDay(from)} – ${shortDay(to)}${metric === 'revenue' ? ` · ${cur}, CMS-calculated` : ''}`} />
            <div className="p-4">
              {groupBy === 'day'
                ? <DailyChart data={dailySeries(sessions, days, toTs)} dataKey={metric} unit={unit} kind={metric === 'energy' ? 'area' : 'bar'} height={260} />
                : <HorizontalBars data={rows.slice(0, 15)} dataKey={metric} unit="" />}
            </div>
          </Card>
          <Card>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr><th className="th capitalize">{groupBy}</th><th className="th text-right">Sessions</th><th className="th text-right">Failed</th><th className="th text-right">Energy</th><th className="th text-right">Revenue</th><th className="th text-right">Avg / session</th><th className="th text-right">Session time</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.key} className="hover:bg-slate-50">
                    <td className="td font-medium text-slate-900">{r.name}</td>
                    <td className="td text-right">{r.sessions}</td>
                    <td className="td text-right">{r.failed}</td>
                    <td className="td text-right">{fmtKwh(r.energy, 1)}</td>
                    <td className="td text-right">{fmtMoney(r.revenue, cur)}</td>
                    <td className="td text-right">{fmtKwh(r.energy / r.sessions, 1)}</td>
                    <td className="td text-right">{fmtDuration(r.duration)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-semibold">
                  <td className="td text-slate-900">Total</td>
                  <td className="td text-right">{total.sessions}</td>
                  <td className="td text-right">{total.failed}</td>
                  <td className="td text-right">{fmtKwh(total.energy, 1)}</td>
                  <td className="td text-right">{fmtMoney(total.revenue, cur)}</td>
                  <td className="td text-right">{fmtKwh(total.energy / total.sessions, 1)}</td>
                  <td className="td text-right">{fmtDuration(total.duration)}</td>
                </tr>
              </tbody>
            </TableWrap>
          </Card>
        </>
      )}
    </div>
  );
}
