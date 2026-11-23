import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, Layers, Power, PowerOff, Tag } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, PageHeader, Modal, Field, Select, EmptyState, ConfirmDialog, Checkbox, Tone } from '../components/ui.jsx';
import { AvailabilityDialog, AssignPricingDialog } from '../components/ops.jsx';
import { byId } from '../lib/selectors.js';

function GroupModal({ open, onClose, group }) {
  const state = useStore();
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', description: '', locationId: '', availabilityPolicy: '', chargerIds: [] });
  useEffect(() => {
    if (!open) return;
    setF(group
      ? { ...group, locationId: group.locationId || '', chargerIds: state.chargers.filter((c) => c.groupIds.includes(group.id)).map((c) => c.id) }
      : { name: '', description: '', locationId: '', availabilityPolicy: '', chargerIds: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group && group.id]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? e.target.value : e }));
  const toggle = (id) => setF((x) => ({ ...x, chargerIds: x.chargerIds.includes(id) ? x.chargerIds.filter((c) => c !== id) : [...x.chargerIds, id] }));
  const candidates = state.chargers.filter((c) => !f.locationId || c.locationId === f.locationId || f.chargerIds.includes(c.id));
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.saveGroup(f), { success: 'Group saved.' });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={group ? `Edit ${group.name}` : 'New group'}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="group-form" busy={busy}>Save group</Button>
        </>
      )}
    >
      <form id="group-form" onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Group name"><input className="input" value={f.name} onChange={set('name')} required maxLength={60} /></Field>
          <Field label="Location (optional)" hint="Narrows the charger list below."><Select value={f.locationId} onChange={set('locationId')} options={[{ value: '', label: 'Any location' }, ...state.locations.map((l) => ({ value: l.id, label: l.name }))]} /></Field>
        </div>
        <Field label="Description"><input className="input" value={f.description} onChange={set('description')} maxLength={160} /></Field>
        <Field label="Availability policy note" hint="Free text for operators, e.g. “Restrict overnight 22:00–05:00”. Scheduling itself is done from the group card."><input className="input" value={f.availabilityPolicy} onChange={set('availabilityPolicy')} maxLength={160} /></Field>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-700">Chargers ({f.chargerIds.length} selected)</p>
          <div className="max-h-56 overflow-y-auto rounded-md border border-slate-200 p-2">
            {candidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                <Checkbox checked={f.chargerIds.includes(c.id)} onChange={() => toggle(c.id)} label={c.name} />
                <span className="flex-1">{c.name}</span>
                <span className="text-xs text-slate-500">{(byId(state.locations, c.locationId) || {}).name}</span>
              </label>
            ))}
            {!candidates.length ? <p className="px-2 py-1 text-sm text-slate-500">No chargers at this location.</p> : null}
          </div>
        </div>
      </form>
    </Modal>
  );
}

export default function Groups() {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const [op, setOp] = useState(null);
  const manage = can('groups.manage');

  return (
    <div>
      <PageHeader title="Charger groups" subtitle="Group chargers to apply pricing and availability in one step" actions={manage ? <Button variant="primary" icon={Plus} onClick={() => setModal({})}>New group</Button> : null} />
      {state.groups.length === 0 ? <Card><EmptyState icon={Layers} title="No groups yet" text="Create a group, add chargers, then run bulk operations on it." /></Card> : (
        <div className="grid gap-4 md:grid-cols-2">
          {state.groups.map((g) => {
            const chargers = state.chargers.filter((c) => c.groupIds.includes(g.id));
            const conns = state.connectors.filter((c) => chargers.some((ch) => ch.id === c.chargerId));
            const assignment = state.pricingAssignments.find((a) => a.status === 'active' && a.scope === 'group' && a.targetId === g.id);
            const rule = assignment ? byId(state.pricingRules, assignment.ruleId) : null;
            const loc = g.locationId ? byId(state.locations, g.locationId) : null;
            return (
              <Card key={g.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-slate-900">{g.name}</h2>
                    <p className="text-xs text-slate-500">{g.description || 'No description'}{loc ? ` · ${loc.name}` : ''}</p>
                  </div>
                  {manage ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setModal(g)} aria-label={`Edit ${g.name}`} />
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDel(g)} aria-label={`Delete ${g.name}`} />
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Tone>{chargers.length} chargers</Tone>
                  <Tone>{conns.filter((c) => c.enabled).length} of {conns.length} connectors enabled</Tone>
                  <Tone tone={rule ? 'blue' : 'gray'}>{rule ? `Group tariff: ${rule.name}` : 'No group tariff'}</Tone>
                </div>
                {g.availabilityPolicy ? <p className="mt-2 text-xs text-slate-600">Policy: {g.availabilityPolicy}</p> : null}
                <p className="mt-3 flex-1 text-sm text-slate-600">
                  {chargers.length ? chargers.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<Link className="hover:text-brand-700 hover:underline" to={`/chargers/${c.id}`}>{c.name}</Link></span>) : 'No chargers in this group.'}
                </p>
                {chargers.length ? (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    {can('availability.manage') && can('bulk.execute') ? (
                      <>
                        <Button size="sm" icon={Power} onClick={() => setOp({ kind: 'enable', ids: conns.map((c) => c.id) })}>Enable all</Button>
                        <Button size="sm" icon={PowerOff} onClick={() => setOp({ kind: 'restrict', ids: conns.map((c) => c.id) })}>Restrict all</Button>
                      </>
                    ) : null}
                    {can('pricing.manage') ? <Button size="sm" icon={Tag} onClick={() => setOp({ kind: 'pricing', groupId: g.id })}>Set group tariff</Button> : null}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
      <GroupModal open={Boolean(modal)} onClose={() => setModal(null)} group={modal && modal.id ? modal : null} />
      <AvailabilityDialog open={Boolean(op) && op.kind !== 'pricing'} onClose={() => setOp(null)} connectorIds={op && op.ids ? op.ids : []} action={op && op.kind === 'enable' ? 'enable' : 'restrict'} />
      <AssignPricingDialog open={Boolean(op) && op.kind === 'pricing'} onClose={() => setOp(null)} preset={{ scope: 'group', targetIds: op && op.groupId ? [op.groupId] : [] }} />
      <ConfirmDialog
        open={Boolean(del)}
        onClose={() => setDel(null)}
        busy={busy}
        danger
        title={del ? `Delete ${del.name}?` : ''}
        confirmLabel="Delete group"
        onConfirm={async () => { const ok = await run(() => api.deleteGroup(del.id), { success: 'Group deleted.' }); if (ok) setDel(null); }}
      >
        <p>Chargers stay registered; only the grouping is removed. Any tariff assigned to this group stops applying, and affected chargers fall back to their location or network tariff.</p>
      </ConfirmDialog>
    </div>
  );
}
