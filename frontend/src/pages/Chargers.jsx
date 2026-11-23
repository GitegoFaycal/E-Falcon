import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Power, PowerOff, Tag, MapPin, Layers, Download, Zap, X } from 'lucide-react';
import { api, DATA_SOURCE } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, PageHeader, StatusBadge, Select, TableWrap, Checkbox, Pagination, usePaged, EmptyState, Modal, Field } from '../components/ui.jsx';
import { AvailabilityDialog, AssignPricingDialog, ResultList } from '../components/ops.jsx';
import { ChargerFormModal } from '../components/ChargerForm.jsx';
import { connectorsOf, byId, resolvePricing } from '../lib/selectors.js';
import { connectorState, chargerState, STATES } from '../lib/status.js';
import { timeAgo, downloadCsv, dayKey } from '../lib/format.js';

function AssignDialog({ kind, chargerIds, onClose }) {
  const state = useStore();
  const [run, busy] = useAction();
  const options = (kind === 'location' ? state.locations : state.groups).map((x) => ({ value: x.id, label: x.name }));
  const [target, setTarget] = useState(options[0] ? options[0].value : '');
  const [results, setResults] = useState(null);
  const submit = async () => {
    const out = await run(() => (kind === 'location' ? api.bulkAssignLocation(chargerIds, target) : api.bulkAssignGroup(chargerIds, target)));
    if (out) setResults(out.results.map((r) => ({ ...r, key: r.chargerId, label: (byId(state.chargers, r.chargerId) || {}).name || r.chargerId })));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={results ? 'Results' : kind === 'location' ? 'Assign location' : 'Add to group'}
      subtitle={`${chargerIds.length} charger${chargerIds.length === 1 ? '' : 's'} selected`}
      footer={results ? <Button variant="primary" onClick={onClose}>Close</Button> : (
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!target}>Apply to {chargerIds.length}</Button>
        </>
      )}
    >
      {results ? <ResultList rows={results} /> : (
        <Field label={kind === 'location' ? 'Location' : 'Group'} hint="This is a CMS record change; nothing is sent to the chargers.">
          <Select value={target} onChange={setTarget} options={options} />
        </Field>
      )}
    </Modal>
  );
}

export default function Chargers() {
  const state = useStore();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [location, setLocation] = useState('');
  const [model, setModel] = useState('');
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [formOpen, setFormOpen] = useState(false);

  const term = q.trim().toLowerCase();
  const rows = state.chargers
    .map((ch) => {
      const conns = connectorsOf(state, ch.id);
      return { ch, conns, st: chargerState(ch, conns), loc: byId(state.locations, ch.locationId) };
    })
    .filter(({ ch, st }) => (
      (!term || [ch.name, ch.ocppId, ch.serial, ch.model].some((v) => String(v).toLowerCase().includes(term)))
      && (!status || st === status)
      && (!location || ch.locationId === location)
      && (!model || ch.model === model)
      && (!link || (link === 'online') === ch.online)
    ));
  const paged = usePaged(rows, 10);
  const models = [...new Set(state.chargers.map((c) => c.model).filter(Boolean))];
  const visibleIds = rows.map((r) => r.ch.id);
  const picked = selected.filter((id) => visibleIds.includes(id));
  const allPicked = visibleIds.length > 0 && picked.length === visibleIds.length;
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const pickedConnectors = state.connectors.filter((c) => picked.includes(c.chargerId)).map((c) => c.id);
  const filtersOn = term || status || location || model || link;

  const exportCsv = (ids) => {
    const list = state.chargers.filter((c) => ids.includes(c.id));
    downloadCsv(`chargers-${dayKey(Date.now())}.csv`, [
      ['Name', 'OCPP ID', 'Serial', 'Manufacturer', 'Model', 'Firmware', 'Location', 'Online', 'Last heartbeat', 'Connectors', 'Enabled connectors', 'Tariff (CMS)', 'Data source'],
      ...list.map((ch) => {
        const conns = connectorsOf(state, ch.id);
        const p = resolvePricing(state, ch);
        return [ch.name, ch.ocppId, ch.serial, ch.manufacturer, ch.model, ch.firmware, (byId(state.locations, ch.locationId) || {}).name, ch.online ? 'yes' : 'no', ch.lastHeartbeat ? new Date(ch.lastHeartbeat).toISOString() : '', conns.length, conns.filter((c) => c.enabled).length, p ? p.rule.name : '', DATA_SOURCE];
      }),
    ]);
  };

  return (
    <div>
      <PageHeader
        title="Chargers"
        subtitle={`${state.chargers.length} stations · ${state.chargers.filter((c) => c.online).length} online`}
        actions={(
          <>
            <Button icon={Download} onClick={() => exportCsv(visibleIds)}>Export CSV</Button>
            {can('chargers.manage') ? <Button variant="primary" icon={Plus} onClick={() => setFormOpen(true)}>Register charger</Button> : null}
          </>
        )}
      />

      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-8" placeholder="Search name, OCPP ID, serial" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chargers" />
          </div>
          <Select value={status} onChange={setStatus} aria-label="Filter by status" options={[{ value: '', label: 'All statuses' }, ...Object.entries(STATES).map(([k, v]) => ({ value: k, label: v.label }))]} />
          <Select value={location} onChange={setLocation} aria-label="Filter by location" options={[{ value: '', label: 'All locations' }, ...state.locations.map((l) => ({ value: l.id, label: l.name }))]} />
          <Select value={model} onChange={setModel} aria-label="Filter by model" options={[{ value: '', label: 'All models' }, ...models.map((m) => ({ value: m, label: m }))]} />
          <Select value={link} onChange={setLink} aria-label="Filter by connectivity" options={[{ value: '', label: 'Online and offline' }, { value: 'online', label: 'Online only' }, { value: 'offline', label: 'Offline only' }]} />
        </div>

        {picked.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-brand-100 bg-brand-50 px-3 py-2">
            <span className="mr-1 text-sm font-medium text-brand-900">{picked.length} selected · {pickedConnectors.length} connectors</span>
            {can('availability.manage') && can('bulk.execute') ? (
              <>
                <Button size="sm" icon={Power} onClick={() => setDialog('enable')}>Enable</Button>
                <Button size="sm" icon={PowerOff} onClick={() => setDialog('restrict')}>Restrict</Button>
              </>
            ) : null}
            {can('pricing.manage') && can('bulk.execute') ? <Button size="sm" icon={Tag} onClick={() => setDialog('pricing')}>Change pricing</Button> : null}
            {can('chargers.manage') && can('bulk.execute') ? <Button size="sm" icon={MapPin} onClick={() => setDialog('location')}>Assign location</Button> : null}
            {can('groups.manage') && can('bulk.execute') ? <Button size="sm" icon={Layers} onClick={() => setDialog('group')}>Add to group</Button> : null}
            <Button size="sm" icon={Download} onClick={() => exportCsv(picked)}>Export</Button>
            <Button size="sm" variant="ghost" icon={X} onClick={() => setSelected([])}>Clear</Button>
            <span className="text-xs text-brand-900/70">Enable and Restrict can also be scheduled in the next step.</span>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            icon={Zap}
            title={filtersOn ? 'No chargers match these filters' : 'No chargers registered yet'}
            text={filtersOn ? 'Change or clear the filters to see more.' : 'Register a charger to start monitoring it.'}
            action={filtersOn ? <Button onClick={() => { setQ(''); setStatus(''); setLocation(''); setModel(''); setLink(''); }}>Clear filters</Button> : null}
          />
        ) : (
          <>
            <TableWrap>
              <thead className="bg-slate-50">
                <tr>
                  <th className="th w-10"><Checkbox label="Select all" checked={allPicked} onChange={(v) => setSelected(v ? visibleIds : [])} /></th>
                  <th className="th">Charger</th>
                  <th className="th">Status</th>
                  <th className="th">Connectors</th>
                  <th className="th">Location</th>
                  <th className="th">Model</th>
                  <th className="th">Last communication</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map(({ ch, conns, st, loc }) => (
                  <tr key={ch.id} className={picked.includes(ch.id) ? 'bg-brand-50/40' : 'hover:bg-slate-50'}>
                    <td className="td"><Checkbox label={`Select ${ch.name}`} checked={picked.includes(ch.id)} onChange={() => toggle(ch.id)} /></td>
                    <td className="td">
                      <Link to={`/chargers/${ch.id}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">{ch.name}</Link>
                      <p className="font-mono text-xs text-slate-500">{ch.ocppId}</p>
                    </td>
                    <td className="td"><StatusBadge state={st} /></td>
                    <td className="td">
                      <div className="flex flex-col gap-1">
                        {conns.map((c) => (
                          <span key={c.id} className="flex items-center gap-2 text-xs text-slate-600">
                            <span className="w-12 font-medium text-slate-800">{c.label}</span>
                            <StatusBadge state={connectorState(c, ch)} />
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="td">{loc ? loc.name : '—'}</td>
                    <td className="td">{ch.model || '—'}<p className="text-xs text-slate-500">{ch.firmware ? `fw ${ch.firmware}` : 'firmware unknown'}</p></td>
                    <td className="td">{ch.everConnected ? timeAgo(ch.lastHeartbeat) : 'Never connected'}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination {...paged} noun="chargers" />
          </>
        )}
      </Card>

      <ChargerFormModal open={formOpen} onClose={() => setFormOpen(false)} charger={null} />
      <AvailabilityDialog open={dialog === 'enable' || dialog === 'restrict'} onClose={() => setDialog(null)} connectorIds={pickedConnectors} action={dialog === 'enable' ? 'enable' : 'restrict'} />
      <AssignPricingDialog open={dialog === 'pricing'} onClose={() => setDialog(null)} preset={{ scope: 'charger', targetIds: picked }} />
      {dialog === 'location' || dialog === 'group' ? <AssignDialog kind={dialog} chargerIds={picked} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
