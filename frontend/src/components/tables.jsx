// Tables reused on several pages (charger detail embeds the same lists as the full pages).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RotateCcw, Ban, Terminal, History, Bell, Check, CheckCircle2 } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, TableWrap, CommandBadge, SeverityBadge, Tone, EmptyState, Modal, KeyValue, Pagination, usePaged, SimTag, Field } from './ui.jsx';
import { byId, connectorLabel } from '../lib/selectors.js';
import { ALERT_TYPES } from '../lib/status.js';
import { fmtDateTime, fmtDateTimeFull, fmtDuration, fmtKwh, fmtMoney, timeAgo } from '../lib/format.js';

const PERM_FOR = { ChangeAvailability: 'availability.manage', SetTariff: 'pricing.manage' };

export function CommandTable({ commands, showCharger = true, pageSize = 12 }) {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [openId, setOpenId] = useState(null);
  const paged = usePaged(commands, pageSize);
  const open = openId ? byId(state.commands, openId) : null;
  if (!commands.length) return <EmptyState icon={Terminal} title="No commands" text="Remote operations appear here with their execution result." />;
  const allowed = (c) => can(PERM_FOR[c.type] || 'commands.remote');
  return (
    <>
      <TableWrap>
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Command</th>
            {showCharger ? <th className="th">Target</th> : <th className="th">Connector</th>}
            <th className="th">Status</th>
            <th className="th">Requested</th>
            <th className="th">Result</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {paged.rows.map((c) => {
            const ch = byId(state.chargers, c.chargerId);
            const conn = c.connectorId ? byId(state.connectors, c.connectorId) : null;
            return (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="td">
                  <button type="button" className="font-medium text-slate-900 hover:text-brand-700 hover:underline" onClick={() => setOpenId(c.id)}>{c.type}</button>
                  <p className="font-mono text-xs text-slate-500">{c.id}{c.payload.type ? ` · ${c.payload.type}` : ''}</p>
                </td>
                <td className="td">
                  {showCharger ? (ch ? <Link className="hover:underline" to={`/chargers/${ch.id}`}>{ch.name}</Link> : c.chargerId) : null}
                  {showCharger && conn ? ' · ' : ''}{conn ? conn.label : showCharger ? '' : 'Whole charger'}
                </td>
                <td className="td"><CommandBadge status={c.status} /></td>
                <td className="td">{c.requestedBy}<p className="text-xs text-slate-500">{fmtDateTime(c.requestedAt)}</p></td>
                <td className="td max-w-xs text-xs text-slate-600">{c.error || (c.response ? `Charger answered "${c.response.status}"` : '—')}{c.attempts > 1 ? ` · ${c.attempts} attempts` : ''}</td>
                <td className="td text-right">
                  {c.status === 'pending' && allowed(c) ? <Button size="sm" icon={Ban} busy={busy} onClick={() => run(() => api.cancelCommand(c.id), { success: 'Command cancelled.' })}>Cancel</Button> : null}
                  {['failed', 'timed_out', 'cancelled'].includes(c.status) && allowed(c) && ch ? <Button size="sm" icon={RotateCcw} busy={busy} onClick={() => run(() => api.retryCommand(c.id), { success: 'Submitted again as a new command.' })}>Retry</Button> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      <Pagination {...paged} noun="commands" />
      <Modal open={Boolean(open)} onClose={() => setOpenId(null)} wide title={open ? `${open.type} · ${open.id}` : ''} footer={<Button variant="primary" onClick={() => setOpenId(null)}>Close</Button>}>
        {open ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2"><CommandBadge status={open.status} /><SimTag /></div>
            <KeyValue items={[
              ['Charger', (byId(state.chargers, open.chargerId) || {}).name || open.chargerId],
              ['Connector', open.connectorId ? connectorLabel(state, open.connectorId) : 'Whole charger'],
              ['Requested by', open.requestedBy],
              ['Requested', fmtDateTimeFull(open.requestedAt)],
              ['Sent', open.sentAt ? fmtDateTimeFull(open.sentAt) : 'Not sent'],
              ['Completed', fmtDateTimeFull(open.completedAt)],
              ['Attempts', `${open.attempts} of ${open.maxAttempts} allowed${open.maxAttempts === 1 ? ' (never retried automatically)' : ''}`],
              ['Error', open.error],
            ]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Request payload</p><pre className="max-h-56 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(open.payload, null, 2)}</pre></div>
              <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Charger response</p><pre className="max-h-56 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{open.response ? JSON.stringify(open.response, null, 2) : 'No response received'}</pre></div>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

const SESSION_TONE = { active: 'blue', completed: 'green', failed: 'red' };

export function SessionTable({ sessions, showCharger = true, pageSize = 12 }) {
  const state = useStore();
  const cur = state.settings.currency;
  const paged = usePaged(sessions, pageSize);
  if (!sessions.length) return <EmptyState icon={History} title="No sessions" text="No charging sessions match." />;
  return (
    <>
      <TableWrap>
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Session</th>
            <th className="th">{showCharger ? 'Charger · connector' : 'Connector'}</th>
            <th className="th">Identifier</th>
            <th className="th">Start</th>
            <th className="th">End</th>
            <th className="th">Duration</th>
            <th className="th text-right">Energy</th>
            <th className="th">Status</th>
            <th className="th text-right">Price at start</th>
            <th className="th text-right">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {paged.rows.map((s) => {
            const ch = byId(state.chargers, s.chargerId);
            const conn = byId(state.connectors, s.connectorId);
            return (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="td font-mono text-xs">{s.id}</td>
                <td className="td">{showCharger ? (ch ? <Link className="font-medium text-slate-900 hover:underline" to={`/chargers/${ch.id}`}>{ch.name}</Link> : <span className="text-slate-500">{s.chargerId} (deleted)</span>) : null}{showCharger ? ' · ' : ''}{conn ? conn.label : '—'}</td>
                <td className="td font-mono text-xs">{s.idTag || '—'}</td>
                <td className="td">{fmtDateTime(s.startedAt)}</td>
                <td className="td">{s.endedAt ? fmtDateTime(s.endedAt) : '—'}</td>
                <td className="td">{fmtDuration((s.endedAt || Date.now()) - s.startedAt)}</td>
                <td className="td text-right">{fmtKwh(s.energyKwh, 2)}</td>
                <td className="td"><Tone tone={SESSION_TONE[s.status]}>{s.status === 'active' ? 'Charging' : s.status === 'completed' ? 'Completed' : 'Failed'}</Tone>{s.stopReason ? <p className="mt-0.5 text-xs text-slate-500">{s.stopReason}</p> : null}</td>
                <td className="td text-right">{s.ruleName ? `${fmtMoney(s.priceAtStart, cur)}/kWh` : '—'}<p className="text-xs text-slate-500">{s.ruleName || 'No tariff'}</p></td>
                <td className="td text-right">{s.costSource === 'none' ? '—' : fmtMoney(s.cost, cur)}<p className="text-xs text-slate-500">{s.costSource === 'none' ? 'no tariff' : s.status === 'active' ? 'CMS estimate' : 'CMS-calculated'}</p></td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      <Pagination {...paged} noun="sessions" />
    </>
  );
}

export function AlertList({ alerts, pageSize = 10 }) {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [resolving, setResolving] = useState(null);
  const [note, setNote] = useState('');
  const paged = usePaged(alerts, pageSize);
  if (!alerts.length) return <EmptyState icon={Bell} title="No alerts" text="Nothing matches. Faults, offline chargers and failed commands appear here." />;
  const doResolve = async () => {
    const ok = await run(() => api.resolveAlert(resolving, note), { success: 'Alert resolved.' });
    if (ok) setResolving(null);
  };
  return (
    <>
      <ul className="divide-y divide-slate-100">
        {paged.rows.map((a) => {
          const ch = a.chargerId ? byId(state.chargers, a.chargerId) : null;
          return (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{ALERT_TYPES[a.type] || a.type}</span>
                  <Tone tone={a.status === 'open' ? 'red' : a.status === 'acknowledged' ? 'amber' : 'green'}>{a.status}</Tone>
                </div>
                <p className="mt-1 text-sm text-slate-900">{a.message}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {fmtDateTime(a.createdAt)} ({timeAgo(a.createdAt)})
                  {ch ? <> · <Link className="hover:underline" to={`/chargers/${ch.id}`}>{ch.name}</Link></> : null}
                  {a.acknowledgedBy ? ` · acknowledged by ${a.acknowledgedBy}` : ''}
                  {a.status === 'resolved' ? ` · resolved ${fmtDateTime(a.resolvedAt)}: ${a.resolutionNote}` : ''}
                </p>
              </div>
              {can('alerts.manage') && a.status !== 'resolved' ? (
                <div className="flex gap-2">
                  {a.status === 'open' ? <Button size="sm" icon={Check} busy={busy} onClick={() => run(() => api.acknowledgeAlert(a.id))}>Acknowledge</Button> : null}
                  <Button size="sm" icon={CheckCircle2} onClick={() => { setNote(''); setResolving(a.id); }}>Resolve</Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Pagination {...paged} noun="alerts" />
      <Modal
        open={Boolean(resolving)}
        onClose={() => setResolving(null)}
        title="Resolve alert"
        footer={(
          <>
            <Button onClick={() => setResolving(null)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={doResolve} busy={busy}>Mark resolved</Button>
          </>
        )}
      >
        <Field label="Resolution note" hint="What was found and done. Kept with the alert.">
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </Modal>
    </>
  );
}
