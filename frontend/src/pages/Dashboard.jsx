import { Link } from 'react-router-dom';
import { Zap, PlugZap, Wifi, WifiOff, CheckCircle2, BatteryCharging, AlertTriangle, Ban, Activity, Gauge, CircleDollarSign, BarChart3 } from 'lucide-react';
import { useStore } from '../context/store.jsx';
import { Card, CardHeader, PageHeader, StatCard, SeverityBadge, SimTag, EmptyState } from '../components/ui.jsx';
import { DailyChart, HorizontalBars, StatusDistribution } from '../components/charts.jsx';
import { networkSummary, dailySeries, utilisationByCharger, byId } from '../lib/selectors.js';
import { STATE_ORDER } from '../lib/status.js';
import { fmtKwh, fmtMoney, fmtNumber, timeAgo, fmtTime } from '../lib/format.js';

export default function Dashboard() {
  const state = useStore();
  const s = networkSummary(state);
  const cur = state.settings.currency;
  const series = dailySeries(state.sessions, 14);
  const util = utilisationByCharger(state, 7);
  const avgUtil = util.length ? util.reduce((n, u) => n + u.utilisation, 0) / util.length : 0;
  const restricted = s.unavailable + s.maintenance;

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Network overview" actions={<SimTag />} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Stations" value={s.stations} sub={`${s.total} connectors`} icon={Zap} />
        <StatCard label="Online" value={s.online} sub={`of ${s.stations} chargers`} icon={Wifi} tone="text-green-600" />
        <StatCard label="Offline" value={s.offlineChargers} sub={`${s.offline} connectors unreachable`} icon={WifiOff} tone={s.offlineChargers ? 'text-red-600' : 'text-slate-400'} />
        <StatCard label="Available" value={s.available} sub="connectors ready" icon={CheckCircle2} tone="text-green-600" />
        <StatCard label="Charging" value={s.charging} sub={`${s.activeSessions} active sessions`} icon={BatteryCharging} tone="text-blue-600" />
        <StatCard label="Faulted" value={s.faulted} sub="connectors" icon={AlertTriangle} tone={s.faulted ? 'text-red-600' : 'text-slate-400'} />
        <StatCard label="Restricted" value={restricted} sub={`${s.maintenance} in maintenance`} icon={Ban} tone="text-amber-600" />
        <StatCard label="Enabled / limit" value={`${s.enabled} / ${s.max}`} sub={s.over ? `${s.over} over the limit` : `${Math.max(0, s.headroom)} more may be enabled`} icon={Gauge} tone={s.over ? 'text-red-600' : 'text-slate-400'} />
        <StatCard label="Active sessions" value={s.activeSessions} sub="right now" icon={Activity} tone="text-blue-600" />
        <StatCard label="Energy today" value={fmtKwh(s.energyToday, 0)} sub="sessions started today" icon={PlugZap} />
        <StatCard label="Revenue today" value={fmtMoney(s.revenueToday, cur)} sub="CMS-calculated, not payment data" icon={CircleDollarSign} />
        <StatCard label="Utilisation (7 d)" value={`${fmtNumber(avgUtil, 1)}%`} sub="time connectors spent in a session" icon={BarChart3} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Energy delivered" subtitle="kWh per day, last 14 days" />
          <div className="p-4"><DailyChart data={series} dataKey="energy" unit="kWh" kind="area" height={230} /></div>
        </Card>
        <Card>
          <CardHeader title="Connector status" subtitle={`${s.total} connectors`} />
          <div className="p-4"><StatusDistribution counts={s} order={STATE_ORDER} /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Charging sessions" subtitle="Sessions started per day" />
          <div className="p-4"><DailyChart data={series} dataKey="sessions" unit="sessions" /></div>
        </Card>
        <Card>
          <CardHeader title="Revenue" subtitle={`${cur} per day, CMS-calculated`} />
          <div className="p-4"><DailyChart data={series} dataKey="revenue" unit={cur} /></div>
        </Card>
        <Card>
          <CardHeader title="Utilisation by charger" subtitle="Share of the last 7 days in a session" />
          <div className="p-4"><HorizontalBars data={util} dataKey="utilisation" unit="%" /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent activity" subtitle="Charger events as they arrive" action={<Link to="/commands" className="text-xs font-medium text-brand-700 hover:underline">Commands</Link>} />
          {state.events.length ? (
            <ul className="divide-y divide-slate-100">
              {state.events.slice(0, 8).map((e) => {
                const ch = byId(state.chargers, e.chargerId);
                return (
                  <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      {ch ? <Link to={`/chargers/${ch.id}`} className="font-medium text-slate-900 hover:underline">{ch.name}</Link> : <span className="font-medium text-slate-900">{e.chargerId}</span>}
                      <p className="truncate text-xs text-slate-500">{e.message}</p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500" title={fmtTime(e.at)}>{timeAgo(e.at)}</span>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyState title="No activity yet" />}
        </Card>
        <Card>
          <CardHeader title="Recent alerts" subtitle={`${s.openAlerts} open`} action={<Link to="/alerts" className="text-xs font-medium text-brand-700 hover:underline">All alerts</Link>} />
          {state.alerts.length ? (
            <ul className="divide-y divide-slate-100">
              {state.alerts.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="text-slate-900">{a.message}</p>
                    <p className="text-xs text-slate-500">{timeAgo(a.createdAt)} · {a.status}</p>
                  </div>
                  <SeverityBadge severity={a.severity} />
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No alerts" />}
        </Card>
      </div>
    </div>
  );
}
