import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gauge, Power, PowerOff, CalendarClock, ShieldCheck } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, CardHeader, PageHeader, Field, Select, EmptyState, TableWrap, Tone, StatusBadge, Notice, Checkbox, Pagination, usePaged, Tabs, ConfirmDialog, SimTag } from '../components/ui.jsx';
import { AvailabilityDialog } from '../components/ops.jsx';
import { byId, limitSnapshot, hasActiveCommand } from '../lib/selectors.js';
import { connectorState, STATES } from '../lib/status.js';
import { fmtDateTime } from '../lib/format.js';

function LimitForm() {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const limit = state.settings.operationalLimit;
  const [max, setMax] = useState(limit.maxEnabledConnectors);
  const [policy, setPolicy] = useState(limit.policy);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setMax(limit.maxEnabledConnectors); setPolicy(limit.policy); }, [limit.maxEnabledConnectors, limit.policy]);
  const snap = limitSnapshot(state);
  const next = Number(max);
  const overAfter = Math.max(0, snap.enabled - next);
  const dirty = next !== limit.maxEnabledConnectors || policy !== limit.policy;
  const editable = can('limits.manage');

  const save = async () => {
    const ok = await run(() => api.setOperationalLimit({ maxEnabledConnectors: next, policy }), { success: 'Operational limit updated.' });
    if (ok) setConfirm(false);
  };

  return (
    <Card>
      <CardHeader title="Limit configuration" subtitle="Enforced by the backend on every enable request, including bulk and scheduled ones" />
      <div className="space-y-4 p-4">
        <Field label="Maximum enabled connectors" hint={`Network has ${snap.total} connectors.`}>
          <input type="number" min={0} max={snap.total} className="input" value={max} onChange={(e) => setMax(e.target.value)} disabled={!editable} />
        </Field>
        <Field label="When the limit is reached" hint={policy === 'block' ? 'Nobody can enable beyond the limit.' : 'Users with the override permission may exceed it; each override is audited.'}>
          <Select value={policy} onChange={setPolicy} disabled={!editable} options={[{ value: 'block', label: 'Block (hard limit)' }, { value: 'warn', label: 'Block, allow authorised override' }]} />
        </Field>
        <Field label="When the limit is lowered" hint="Stopping sessions to meet a limit needs a separately authorised policy, which is not configured.">
          <input className="input" value="Never stop active sessions" disabled readOnly />
        </Field>
      </div>
      {editable ? (
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-500">{dirty && overAfter > 0 ? `${overAfter} connector${overAfter === 1 ? '' : 's'} would be over the new limit. They stay enabled until you restrict them.` : 'Changes are recorded in the audit log.'}</p>
          <Button variant="primary" disabled={!dirty || !Number.isInteger(next) || next < 0} onClick={() => setConfirm(true)}>Save limit</Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500"><ShieldCheck className="h-4 w-4" />Only users with the “Change the operational limit” permission can edit this.</p>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={save} busy={busy} title="Change the operational limit?" confirmLabel="Save limit">
        <p>Maximum enabled connectors: <strong>{limit.maxEnabledConnectors}</strong> → <strong>{next}</strong>. Currently enabled: {snap.enabled}.</p>
        {overAfter > 0 ? <p className="text-amber-800">{overAfter} enabled connector{overAfter === 1 ? '' : 's'} will exceed the new limit. No session is stopped and nothing is restricted automatically; an alert stays open until you restrict {overAfter} connector{overAfter === 1 ? '' : 's'}.</p> : <p>No connector is affected immediately.</p>}
      </ConfirmDialog>
    </Card>
  );
}

function Meter({ snap }) {
  const scale = Math.max(snap.total, snap.max, 1);
  const pct = (n) => `${Math.min(100, (n / scale) * 100)}%`;
  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-3xl font-semibold tracking-tight text-slate-900">{snap.enabled}<span className="text-lg font-normal text-slate-500"> / {snap.max} enabled</span></p>
        <Tone tone={snap.over ? 'red' : snap.headroom <= 0 ? 'amber' : 'green'}>{snap.over ? `${snap.over} over limit` : snap.headroom <= 0 ? 'At limit' : `${snap.headroom} more may be enabled`}</Tone>
      </div>
      <div className="relative mt-3 h-3 rounded-full bg-slate-100" role="img" aria-label={`${snap.enabled} enabled of ${snap.max} allowed, ${snap.total} total`}>
        <div className={`h-3 rounded-full ${snap.over ? 'bg-red-600' : 'bg-brand-500'}`} style={{ width: pct(snap.enabled) }} />
        {snap.pendingEnable ? <div className="absolute top-0 h-3 bg-violet-400" style={{ left: pct(snap.enabled), width: pct(snap.pendingEnable) }} /> : null}
        <div className="absolute -top-1 h-5 w-0.5 bg-slate-900" style={{ left: pct(snap.max) }} title={`Limit: ${snap.max}`} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-500"><span>0</span><span>limit {snap.max}{snap.pendingEnable ? ` · ${snap.pendingEnable} enable command(s) pending` : ''}</span><span>{snap.total} total</span></div>
    </div>
  );
}

export default function Limits() {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [tab, setTab] = useState('connectors');
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [filter, setFilter] = useState('');
  const snap = limitSnapshot(state);
  const manage = can('availability.manage');

  const rows = state.connectors
    .map((c) => { const ch = byId(state.chargers, c.chargerId); return { c, ch, st: connectorState(c, ch) }; })
    .filter(({ c, ch, st }) => ch && (!filter || (filter === 'enabled' ? c.enabled : filter === 'restricted' ? !c.enabled : st === filter)))
    .sort((a, b) => a.ch.name.localeCompare(b.ch.name) || a.c.connectorId - b.c.connectorId);
  const paged = usePaged(rows, 12);
  const visible = rows.map((r) => r.c.id);
  const picked = selected.filter((id) => visible.includes(id));
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Suggest which connectors to restrict to get back under the limit: never ones with a session.
  const suggestion = snap.over > 0
    ? state.connectors
      .filter((c) => c.enabled && !c.sessionId && !hasActiveCommand(state, c.id))
      .map((c) => ({ c, st: connectorState(c, byId(state.chargers, c.chargerId)) }))
      .sort((a, b) => ['faulted', 'offline', 'available'].indexOf(a.st) - ['faulted', 'offline', 'available'].indexOf(b.st))
      .slice(0, snap.over)
      .map((x) => x.c.id)
    : [];

  const history = state.audit.filter((a) => a.action.startsWith('availability.') || a.action.startsWith('limit.'));
  const histPaged = usePaged(history, 10);
  const scheduled = state.scheduledOps;

  return (
    <div>
      <PageHeader title="Operational limit" subtitle="Control how many connectors may be enabled for charging" actions={<SimTag />} />

      {snap.over > 0 ? (
        <div className="mb-4">
          <Notice
            tone="red"
            title={`${snap.over} connector${snap.over === 1 ? '' : 's'} over the operational limit`}
            action={manage && suggestion.length ? <Button size="sm" onClick={() => { setFilter(''); setSelected(suggestion); setDialog('restrict'); }}>Review {suggestion.length} idle connector{suggestion.length === 1 ? '' : 's'} to restrict</Button> : null}
          >
            {snap.enabled} are enabled; the limit is {snap.max}. Active sessions are not stopped. New enable requests are blocked until enabled connectors are back within the limit.
            {suggestion.length < snap.over ? ` Only ${suggestion.length} enabled connector${suggestion.length === 1 ? ' is' : 's are'} idle right now; the rest are charging.` : ''}
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <Meter snap={snap} />
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['Charging', snap.charging, 'charging'], ['Available', snap.available, 'available'], ['Occupied', snap.occupied, 'occupied'], ['Reserved', snap.reserved, 'reserved'], ['Restricted', snap.unavailable, 'unavailable'], ['Maintenance', snap.maintenance, 'maintenance'], ['Faulted', snap.faulted, 'faulted'], ['Offline', snap.offline, 'offline']].map(([label, n, key]) => (
              <div key={key} className="rounded-md border border-slate-100 px-3 py-2">
                <dt className="flex items-center gap-1.5 text-xs text-slate-500"><span className={`h-2 w-2 rounded-full ${STATES[key].dot}`} />{label}</dt>
                <dd className="text-lg font-semibold text-slate-900">{n}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500">“Enabled” is the administrative state confirmed by the charger and is what the limit counts. A connector can be enabled and still be offline or faulted. Pending enable commands also count, so two operators cannot both take the last slot.</p>
        </Card>
        <LimitForm />
      </div>

      <Card className="mt-4">
        <div className="px-4 pt-3">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'connectors', label: 'Connectors', count: state.connectors.length }, { value: 'scheduled', label: 'Scheduled', count: scheduled.filter((o) => o.status === 'scheduled').length }, { value: 'history', label: 'History', count: history.length }]} />
        </div>

        {tab === 'connectors' ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 pb-3">
              <div className="w-56"><Select value={filter} onChange={setFilter} aria-label="Filter connectors" options={[{ value: '', label: 'All connectors' }, { value: 'enabled', label: 'Enabled' }, { value: 'restricted', label: 'Restricted (incl. maintenance)' }, ...Object.entries(STATES).map(([k, v]) => ({ value: k, label: `Status: ${v.label}` }))]} /></div>
              {manage ? (
                <>
                  <Button size="sm" icon={Power} disabled={!picked.length} onClick={() => setDialog('enable')}>Enable {picked.length || ''}</Button>
                  <Button size="sm" icon={PowerOff} disabled={!picked.length} onClick={() => setDialog('restrict')}>Restrict {picked.length || ''}</Button>
                  <span className="text-xs text-slate-500">{picked.length ? `${picked.length} selected. Scheduling is offered in the next step.` : 'Select connectors to enable, restrict or schedule.'}</span>
                </>
              ) : null}
            </div>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr>
                  <th className="th w-10"><Checkbox label="Select all" checked={visible.length > 0 && picked.length === visible.length} onChange={(v) => setSelected(v ? visible : [])} disabled={!manage} /></th>
                  <th className="th">Connector</th><th className="th">Administrative state</th><th className="th">Reported status</th><th className="th">Session</th><th className="th">Pending</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map(({ c, ch, st }) => (
                  <tr key={c.id} className={picked.includes(c.id) ? 'bg-brand-50/40' : 'hover:bg-slate-50'}>
                    <td className="td"><Checkbox label={`Select ${ch.name} ${c.label}`} checked={picked.includes(c.id)} onChange={() => toggle(c.id)} disabled={!manage} /></td>
                    <td className="td"><Link className="font-medium text-slate-900 hover:underline" to={`/chargers/${ch.id}`}>{ch.name}</Link> · {c.label}</td>
                    <td className="td"><Tone tone={c.enabled ? 'green' : c.maintenance ? 'amber' : 'gray'}>{c.enabled ? 'Enabled' : c.maintenance ? 'Maintenance' : 'Restricted'}</Tone></td>
                    <td className="td"><StatusBadge state={st} /></td>
                    <td className="td">{c.sessionId || '—'}</td>
                    <td className="td text-xs text-slate-600">{hasActiveCommand(state, c.id) ? 'Command in progress' : c.pendingInoperative ? 'Restriction applies after session' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination {...paged} noun="connectors" />
          </>
        ) : null}

        {tab === 'scheduled' ? (
          scheduled.length ? (
            <TableWrap>
              <thead className="bg-slate-50"><tr><th className="th">Run at</th><th className="th">Operation</th><th className="th">Status</th><th className="th">Scheduled by</th><th className="th">Outcome</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {scheduled.map((op) => (
                  <tr key={op.id} className="hover:bg-slate-50">
                    <td className="td font-medium text-slate-900">{fmtDateTime(op.runAt)}</td>
                    <td className="td">{op.payload.action === 'enable' ? 'Enable' : 'Restrict'} {op.payload.connectorIds.length} connector{op.payload.connectorIds.length === 1 ? '' : 's'}{op.payload.reason ? <p className="text-xs text-slate-500">{op.payload.reason}</p> : null}</td>
                    <td className="td"><Tone tone={{ scheduled: 'blue', executed: 'green', cancelled: 'gray', failed: 'red' }[op.status]}>{op.status}</Tone></td>
                    <td className="td">{op.createdBy}</td>
                    <td className="td text-xs text-slate-600">{op.result ? `${op.result.filter((r) => r.outcome === 'submitted').length} submitted, ${op.result.filter((r) => r.outcome === 'blocked_limit').length} blocked by limit, ${op.result.filter((r) => !['submitted', 'blocked_limit'].includes(r.outcome)).length} other. See Commands for per-charger results.` : op.error || '—'}</td>
                    <td className="td text-right">{op.status === 'scheduled' && manage ? <Button size="sm" busy={busy} onClick={() => run(() => api.cancelScheduledOp(op.id), { success: 'Scheduled operation cancelled.' })}>Cancel</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          ) : <EmptyState icon={CalendarClock} title="Nothing scheduled" text="Select connectors, choose Enable or Restrict, then “Schedule for later”. The limit is checked again when the operation runs." />
        ) : null}

        {tab === 'history' ? (
          history.length ? (
            <>
              <ul className="divide-y divide-slate-100">
                {histPaged.rows.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="text-slate-900"><Tone>{a.action}</Tone> {a.entityLabel}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {a.action === 'limit.update' && a.before && a.after ? `Limit ${a.before.maxEnabledConnectors} → ${a.after.maxEnabledConnectors}, policy ${a.after.policy || a.before.policy || 'block'}` : a.after ? Object.entries(a.after).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}
                        {a.details ? ` · ${a.details}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500">{a.userName} · {fmtDateTime(a.at)}</span>
                  </li>
                ))}
              </ul>
              <Pagination {...histPaged} noun="changes" />
            </>
          ) : <EmptyState icon={Gauge} title="No availability changes yet" />
        ) : null}
      </Card>

      <AvailabilityDialog open={Boolean(dialog)} onClose={() => setDialog(null)} connectorIds={picked} action={dialog || 'restrict'} />
    </div>
  );
}
