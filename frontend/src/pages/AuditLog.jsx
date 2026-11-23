import { useState } from 'react';
import { Download, Lock, Search } from 'lucide-react';
import { useStore } from '../context/store.jsx';
import { Button, Card, PageHeader, Select, TableWrap, Tone, EmptyState, Pagination, usePaged, Modal, KeyValue } from '../components/ui.jsx';
import { fmtDateTimeFull, fmtDateTime, downloadCsv, dayKey } from '../lib/format.js';

const AREAS = [
  { value: '', label: 'All activity' },
  { value: 'auth.', label: 'Sign-in / sign-out' },
  { value: 'charger.', label: 'Chargers' },
  { value: 'pricing.', label: 'Pricing' },
  { value: 'availability.', label: 'Availability' },
  { value: 'limit.', label: 'Operational limit' },
  { value: 'command.', label: 'Commands' },
  { value: 'user.', label: 'Users' },
  { value: 'permission.', label: 'Permissions' },
  { value: 'settings.', label: 'Settings' },
  { value: 'group.', label: 'Groups' },
  { value: 'location.', label: 'Locations' },
];

const json = (v) => (v === null || v === undefined ? '—' : JSON.stringify(v, null, 2));

export default function AuditLog() {
  const state = useStore();
  const [area, setArea] = useState('');
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const term = q.trim().toLowerCase();
  const users = [...new Set(state.audit.map((a) => a.userName))];
  const rows = state.audit.filter((a) => (!area || a.action.startsWith(area)) && (!user || a.userName === user)
    && (!term || [a.action, a.entityLabel, a.details, a.entityId].some((v) => String(v || '').toLowerCase().includes(term))));
  const paged = usePaged(rows, 15);

  const exportCsv = () => downloadCsv(`audit-${dayKey(Date.now())}.csv`, [
    ['Time', 'User', 'Action', 'Entity type', 'Entity', 'Previous value', 'New value', 'Details'],
    ...rows.map((a) => [new Date(a.at).toISOString(), a.userName, a.action, a.entityType, a.entityLabel, a.before ? JSON.stringify(a.before) : '', a.after ? JSON.stringify(a.after) : '', a.details]),
  ]);

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Who did what, and when" actions={<Button icon={Download} onClick={exportCsv} disabled={!rows.length}>Export CSV</Button>} />
      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-8" placeholder="Search action, entity or details" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit log" />
          </div>
          <Select value={area} onChange={setArea} aria-label="Filter by area" options={AREAS} />
          <Select value={user} onChange={setUser} aria-label="Filter by user" options={[{ value: '', label: 'All users' }, ...users.map((u) => ({ value: u, label: u }))]} />
        </div>
        {rows.length ? (
          <>
            <TableWrap>
              <thead className="bg-slate-50"><tr><th className="th">Time</th><th className="th">User</th><th className="th">Action</th><th className="th">Entity</th><th className="th">Details</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td whitespace-nowrap">{fmtDateTime(a.at)}</td>
                    <td className="td">{a.userName}</td>
                    <td className="td"><Tone>{a.action}</Tone></td>
                    <td className="td">{a.entityLabel}<p className="text-xs text-slate-500">{a.entityType}</p></td>
                    <td className="td max-w-xs truncate text-xs text-slate-600">{a.details || '—'}</td>
                    <td className="td text-right">{a.before || a.after ? <Button size="sm" variant="ghost" onClick={() => setOpen(a)}>View change</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination {...paged} noun="entries" />
          </>
        ) : <EmptyState title="No audit entries match" text="Change the filters to see more." />}
        <p className="flex items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500"><Lock className="h-3.5 w-3.5" />Read-only. The application has no way to edit or delete audit entries. In production the database role used by the API is also denied UPDATE and DELETE on this table.</p>
      </Card>

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} wide title={open ? open.action : ''} subtitle={open ? `${open.userName} · ${fmtDateTimeFull(open.at)}` : ''} footer={<Button variant="primary" onClick={() => setOpen(null)}>Close</Button>}>
        {open ? (
          <div className="space-y-4">
            <KeyValue items={[['Entity', open.entityLabel], ['Entity type', open.entityType], ['Entity ID', open.entityId], ['Details', open.details]]} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Previous value</p><pre className="max-h-72 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{json(open.before)}</pre></div>
              <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">New value</p><pre className="max-h-72 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{json(open.after)}</pre></div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
