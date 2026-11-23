import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, MapPin } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, PageHeader, Modal, Field, EmptyState, ConfirmDialog, StatusBadge } from '../components/ui.jsx';
import { connectorsOf, resolvePricing } from '../lib/selectors.js';
import { chargerState } from '../lib/status.js';

function LocationModal({ open, onClose, location }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', address: '', city: '', notes: '' });
  useEffect(() => { if (open) setF(location ? { ...location } : { name: '', address: '', city: '', notes: '' }); }, [open, location]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.saveLocation(f), { success: 'Location saved.' });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={location ? 'Edit location' : 'New location'}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="location-form" busy={busy}>Save</Button>
        </>
      )}
    >
      <form id="location-form" onSubmit={submit} className="space-y-3">
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} required maxLength={80} /></Field>
        <Field label="Address"><input className="input" value={f.address} onChange={set('address')} maxLength={160} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set('city')} maxLength={80} /></Field>
        <Field label="Notes"><textarea className="input" rows={2} value={f.notes} onChange={set('notes')} maxLength={300} /></Field>
      </form>
    </Modal>
  );
}

export default function Locations() {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const manage = can('locations.manage');

  return (
    <div>
      <PageHeader title="Locations" subtitle={`${state.locations.length} sites`} actions={manage ? <Button variant="primary" icon={Plus} onClick={() => setModal({})}>New location</Button> : null} />
      {state.locations.length === 0 ? <Card><EmptyState icon={MapPin} title="No locations yet" text="Create a location before registering chargers." /></Card> : (
        <div className="grid gap-4 md:grid-cols-2">
          {state.locations.map((loc) => {
            const chargers = state.chargers.filter((c) => c.locationId === loc.id);
            const conns = state.connectors.filter((c) => chargers.some((ch) => ch.id === c.chargerId));
            const tariffs = [...new Set(chargers.map((ch) => (resolvePricing(state, ch) || { rule: {} }).rule.name).filter(Boolean))];
            return (
              <Card key={loc.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-slate-900">{loc.name}</h2>
                    <p className="text-xs text-slate-500">{[loc.address, loc.city].filter(Boolean).join(' · ') || 'No address'}</p>
                  </div>
                  {manage ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setModal(loc)} aria-label={`Edit ${loc.name}`} />
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDel(loc)} aria-label={`Delete ${loc.name}`} />
                    </div>
                  ) : null}
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-slate-500">Chargers</dt><dd className="font-semibold text-slate-900">{chargers.length}</dd></div>
                  <div><dt className="text-xs text-slate-500">Connectors</dt><dd className="font-semibold text-slate-900">{conns.length}</dd></div>
                  <div><dt className="text-xs text-slate-500">Enabled</dt><dd className="font-semibold text-slate-900">{conns.filter((c) => c.enabled).length}</dd></div>
                </dl>
                <p className="mt-2 text-xs text-slate-500">Tariff{tariffs.length === 1 ? '' : 's'} in use: {tariffs.join(', ') || 'none'}</p>
                {chargers.length ? (
                  <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
                    {chargers.map((ch) => (
                      <li key={ch.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                        <Link className="text-slate-800 hover:text-brand-700 hover:underline" to={`/chargers/${ch.id}`}>{ch.name}</Link>
                        <StatusBadge state={chargerState(ch, connectorsOf(state, ch.id))} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {loc.notes ? <p className="mt-2 text-xs text-slate-500">{loc.notes}</p> : null}
              </Card>
            );
          })}
        </div>
      )}
      <LocationModal open={Boolean(modal)} onClose={() => setModal(null)} location={modal && modal.id ? modal : null} />
      <ConfirmDialog
        open={Boolean(del)}
        onClose={() => setDel(null)}
        busy={busy}
        danger
        title={del ? `Delete ${del.name}?` : ''}
        confirmLabel="Delete location"
        onConfirm={async () => { const ok = await run(() => api.deleteLocation(del.id), { success: 'Location deleted.' }); if (ok) setDel(null); }}
      >
        <p>A location can only be deleted when no chargers are assigned to it.</p>
      </ConfirmDialog>
    </div>
  );
}
