import { useState } from 'react';
import { PlugZap } from 'lucide-react';
import { useStore } from '../context/store.jsx';
import { Card, PageHeader, Select, EmptyState, Pagination, usePaged, SimTag } from '../components/ui.jsx';
import { ConnectorCard } from '../components/ops.jsx';
import { byId, limitSnapshot } from '../lib/selectors.js';
import { connectorState, STATES, STATE_ORDER } from '../lib/status.js';

export default function Connectors() {
  const state = useStore();
  const [status, setStatus] = useState('');
  const [location, setLocation] = useState('');
  const [admin, setAdmin] = useState('');
  const snap = limitSnapshot(state);

  const rows = state.connectors
    .map((c) => {
      const ch = byId(state.chargers, c.chargerId);
      return { c, ch, st: connectorState(c, ch) };
    })
    .filter(({ c, ch, st }) => ch
      && (!status || st === status)
      && (!location || ch.locationId === location)
      && (!admin || (admin === 'enabled') === c.enabled))
    .sort((a, b) => a.ch.name.localeCompare(b.ch.name) || a.c.connectorId - b.c.connectorId);
  const paged = usePaged(rows, 12);

  return (
    <div>
      <PageHeader title="Connectors" subtitle={`${snap.total} connectors · ${snap.enabled} enabled of ${snap.max} allowed`} actions={<SimTag />} />

      <div className="mb-4 flex flex-wrap gap-2">
        {STATE_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setStatus(status === k ? '' : k)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${status === k ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
            aria-pressed={status === k}
          >
            <span className={`h-2 w-2 rounded-full ${STATES[k].dot}`} />
            <span className="text-slate-600">{STATES[k].label}</span>
            <span className="font-semibold text-slate-900">{snap[k]}</span>
          </button>
        ))}
      </div>

      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-3">
          <Select value={status} onChange={setStatus} aria-label="Filter by status" options={[{ value: '', label: 'All statuses' }, ...STATE_ORDER.map((k) => ({ value: k, label: STATES[k].label }))]} />
          <Select value={location} onChange={setLocation} aria-label="Filter by location" options={[{ value: '', label: 'All locations' }, ...state.locations.map((l) => ({ value: l.id, label: l.name }))]} />
          <Select value={admin} onChange={setAdmin} aria-label="Filter by administrative state" options={[{ value: '', label: 'Enabled and restricted' }, { value: 'enabled', label: 'Enabled only' }, { value: 'restricted', label: 'Restricted only' }]} />
        </div>
        {rows.length ? (
          <>
            <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
              {paged.rows.map(({ c, ch }) => <ConnectorCard key={c.id} connector={c} charger={ch} showCharger />)}
            </div>
            <Pagination {...paged} noun="connectors" />
          </>
        ) : <EmptyState icon={PlugZap} title="No connectors match these filters" text="Change the filters to see more." />}
      </Card>
    </div>
  );
}
