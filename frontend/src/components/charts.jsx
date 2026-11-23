// Chart wrappers so every chart shares one look: single hue per series, recessive grid,
// tooltip on hover, no dual axes.
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { STATES } from '../lib/status.js';
import { shortDay, fmtNumber } from '../lib/format.js';

const SERIES = '#2a78d6';
const GRID = '#e1e0d9';
const AXIS = { fontSize: 11, fill: '#898781' };
const tooltipStyle = { borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, boxShadow: '0 4px 12px rgba(15,23,42,0.08)' };

export function DailyChart({ data, dataKey, unit, kind = 'bar', height = 200 }) {
  const fmt = (v) => `${fmtNumber(v, dataKey === 'energy' ? 1 : 0)}${unit ? ` ${unit}` : ''}`;
  const common = { data, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const axes = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS} tickLine={false} axisLine={{ stroke: '#c3c2b7' }} minTickGap={24} />
      <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => (v >= 1000 ? `${fmtNumber(v / 1000, v >= 10000 ? 0 : 1)}k` : v)} />
      <Tooltip formatter={(v) => [fmt(v), unit || dataKey]} labelFormatter={shortDay} contentStyle={tooltipStyle} cursor={{ fill: 'rgba(42,120,214,0.06)', stroke: '#c3c2b7' }} />
    </>
  );
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {kind === 'area' ? (
          <AreaChart {...common}>
            {axes}
            <Area type="monotone" dataKey={dataKey} stroke={SERIES} strokeWidth={2} fill={SERIES} fillOpacity={0.12} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </AreaChart>
        ) : (
          <BarChart {...common}>
            {axes}
            <Bar dataKey={dataKey} fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export function HorizontalBars({ data, dataKey, nameKey = 'name', unit = '', height }) {
  return (
    <div style={{ height: height || Math.max(160, data.length * 30 + 30) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={{ stroke: '#c3c2b7' }} tickFormatter={(v) => `${v}${unit}`} />
          <YAxis type="category" dataKey={nameKey} tick={{ ...AXIS, fill: '#52514e' }} tickLine={false} axisLine={false} width={110} />
          <Tooltip formatter={(v) => [`${fmtNumber(v, 1)}${unit}`, 'Value']} contentStyle={tooltipStyle} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
          <Bar dataKey={dataKey} fill={SERIES} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Status mix as one segmented bar with a labelled legend (state is never shown by colour alone).
export function StatusDistribution({ counts, order }) {
  const total = order.reduce((n, k) => n + (counts[k] || 0), 0);
  const present = order.filter((k) => counts[k] > 0);
  return (
    <div>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label="Connector status distribution">
        {present.map((k) => <div key={k} title={`${STATES[k].label}: ${counts[k]}`} style={{ width: `${(counts[k] / total) * 100}%`, backgroundColor: STATES[k].hex }} />)}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2">
        {order.map((k) => (
          <li key={k} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 text-slate-600"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: STATES[k].hex }} />{STATES[k].label}</span>
            <span className="font-medium text-slate-900">{counts[k] || 0}<span className="ml-1 text-xs font-normal text-slate-500">{total ? `${Math.round(((counts[k] || 0) / total) * 100)}%` : ''}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
