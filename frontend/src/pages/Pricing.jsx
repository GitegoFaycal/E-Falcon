import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, Tag, X, CalendarClock, Info } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAuth, useAction, useToast } from '../context/store.jsx';
import { Button, Card, CardHeader, PageHeader, Modal, Field, Select, EmptyState, ConfirmDialog, Tabs, TableWrap, Tone, StageBadge, Notice, Checkbox, Pagination, usePaged, SimTag } from '../components/ui.jsx';
import { AssignPricingDialog } from '../components/ops.jsx';
import { PriceTrack, priceTrack } from '../components/PriceTrack.jsx';
import { byId, resolvePricing, connectorLabel } from '../lib/selectors.js';
import { sortedPeriods, periodEnd, PERIOD_KINDS, priceRange, rateAt, validateRule } from '../lib/tariff.js';
import { fmtMoney, fmtDateTime } from '../lib/format.js';

let tempId = 0;
const newPeriod = (start = '00:00') => { tempId += 1; return { id: `new-${tempId}`, start, energyPrice: 0, servicePrice: 0, kind: 'standard' }; };

function PeriodEditor({ periods, onChange, currency }) {
  const update = (id, k, v) => onChange(periods.map((p) => (p.id === id ? { ...p, [k]: v } : p)));
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="pb-1 pr-2 font-semibold">Starts at</th>
              <th className="pb-1 pr-2 font-semibold">Runs until</th>
              <th className="pb-1 pr-2 font-semibold">Type</th>
              <th className="pb-1 pr-2 font-semibold">Energy / kWh ({currency})</th>
              <th className="pb-1 pr-2 font-semibold">Service / kWh ({currency})</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id}>
                <td className="py-1 pr-2"><input type="time" className="input" value={p.start} onChange={(e) => update(p.id, 'start', e.target.value)} required aria-label="Period start" /></td>
                <td className="py-1 pr-2 text-slate-500">{periods.length > 1 ? periodEnd(periods, p) : 'all day'}</td>
                <td className="min-w-[8rem] py-1 pr-2"><Select value={p.kind} onChange={(v) => update(p.id, 'kind', v)} options={PERIOD_KINDS} aria-label="Period type" /></td>
                <td className="py-1 pr-2"><input type="number" min={0} step="any" className="input" value={p.energyPrice} onChange={(e) => update(p.id, 'energyPrice', e.target.value)} required aria-label="Energy price" /></td>
                <td className="py-1 pr-2"><input type="number" min={0} step="any" className="input" value={p.servicePrice} onChange={(e) => update(p.id, 'servicePrice', e.target.value)} required aria-label="Service price" /></td>
                <td className="py-1"><Button size="sm" variant="ghost" icon={X} disabled={periods.length === 1} onClick={() => onChange(periods.filter((x) => x.id !== p.id))} aria-label="Remove period" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" icon={Plus} className="mt-2" onClick={() => onChange([...periods, newPeriod('12:00')])}>Add period</Button>
    </div>
  );
}

function RuleModal({ open, onClose, rule, onSaved }) {
  const state = useStore();
  const [run, busy] = useAction();
  const toast = useToast();
  const cur = state.settings.currency;
  const [f, setF] = useState(null);

  useEffect(() => {
    if (!open) return;
    setF(rule
      ? { id: rule.id, name: rule.name, description: rule.description, periods: rule.periods.map((p) => ({ ...p })), weekend: Boolean(rule.weekendPeriods), weekendPeriods: (rule.weekendPeriods || [newPeriod()]).map((p) => ({ ...p })), flatFee: rule.flatFee, hourPrice: rule.hourPrice, preauthAmount: rule.preauthAmount }
      : { name: '', description: '', periods: [newPeriod('00:00'), newPeriod('06:00'), newPeriod('12:00'), newPeriod('18:00')], weekend: false, weekendPeriods: [newPeriod()], flatFee: 0, hourPrice: 0, preauthAmount: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule && rule.id]);

  if (!open || !f) return null;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? e.target.value : e }));
  const inUse = rule ? state.chargers.filter((ch) => { const r = resolvePricing(state, ch); return r && r.rule.id === rule.id; }).length : 0;
  const maxPeriods = Math.min(...state.chargers.map((c) => c.hardware.maxTariffPeriods), 99);

  const submit = async (e) => {
    e.preventDefault();
    const num = (list) => list.map((p) => ({ ...p, id: String(p.id).startsWith('new-') ? undefined : p.id, energyPrice: Number(p.energyPrice), servicePrice: Number(p.servicePrice) }));
    const payload = { id: f.id, name: f.name, description: f.description, periods: num(f.periods), weekendPeriods: f.weekend ? num(f.weekendPeriods) : null, flatFee: Number(f.flatFee), hourPrice: Number(f.hourPrice), preauthAmount: Number(f.preauthAmount) };
    const errors = validateRule(payload);
    if (errors.length) { toast.error(errors[0]); return; }
    const out = await run(() => api.saveRule(payload), { success: (r) => (r.deployments.length ? `Tariff saved as v${r.rule.version}. Sending it to ${r.deployments.length} charger${r.deployments.length === 1 ? '' : 's'}; see Charger status.` : 'Tariff saved in the CMS.') });
    if (out) { onClose(); if (onSaved) onSaved(out); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={rule ? `Edit ${rule.name}` : 'New tariff'}
      subtitle="Each period runs from its start time until the next one starts, so the whole day is always covered."
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="rule-form" busy={busy}>Save tariff</Button>
        </>
      )}
    >
      <form id="rule-form" onSubmit={submit} className="space-y-5">
        {inUse ? <Notice tone="amber">{inUse} charger{inUse === 1 ? '' : 's'} currently use this tariff. Saving creates version {rule.version + 1} and starts a new push to each of them. Sessions already running keep accruing at the new rates from that moment.</Notice> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tariff name"><input className="input" value={f.name} onChange={set('name')} required maxLength={60} /></Field>
          <Field label="Description"><input className="input" value={f.description} onChange={set('description')} maxLength={160} /></Field>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Price periods</h3>
          <PeriodEditor periods={f.periods} onChange={set('periods')} currency={cur} />
          {f.periods.length > maxPeriods ? <p className="mt-2 text-xs text-amber-800">At least one charger accepts only {maxPeriods} periods. This tariff will not be sent to it (CMS billing still uses it).</p> : null}
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Checkbox checked={f.weekend} onChange={set('weekend')} label="Weekend schedule" />Different prices on Saturday and Sunday</label>
          {f.weekend ? (
            <div className="mt-2">
              <p className="mb-2 text-xs text-amber-800">The charger&apos;s own tariff screen holds one schedule. A tariff with a weekend schedule is used for CMS billing and is not pushed to the unit.</p>
              <PeriodEditor periods={f.weekendPeriods} onChange={set('weekendPeriods')} currency={cur} />
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Flat fee per session (${cur})`}><input type="number" min={0} step="any" className="input" value={f.flatFee} onChange={set('flatFee')} /></Field>
          <Field label={`Time fee per hour (${cur})`}><input type="number" min={0} step="any" className="input" value={f.hourPrice} onChange={set('hourPrice')} /></Field>
          <Field label={`Pre-authorisation (${cur})`} hint="Stored for the payment integration; not charged by the CMS."><input type="number" min={0} step="any" className="input" value={f.preauthAmount} onChange={set('preauthAmount')} /></Field>
        </div>
      </form>
    </Modal>
  );
}

const SCOPE_LABEL = { global: 'Whole network', location: 'Location', group: 'Group', charger: 'Charger', connector: 'Connector' };

function targetName(state, a) {
  if (a.scope === 'global') return 'All chargers';
  if (a.scope === 'connector') return connectorLabel(state, a.targetId);
  const list = { location: state.locations, group: state.groups, charger: state.chargers }[a.scope];
  return (byId(list, a.targetId) || {}).name || `${a.targetId} (deleted)`;
}

export default function Pricing() {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [tab, setTab] = useState('tariffs');
  const [ruleModal, setRuleModal] = useState(null);
  const [assign, setAssign] = useState(null);
  const [del, setDel] = useState(null);
  const [cancel, setCancel] = useState(null);
  const manage = can('pricing.manage');
  const cur = state.settings.currency;

  const active = state.pricingAssignments.filter((a) => a.status === 'active');
  const scheduled = state.pricingAssignments.filter((a) => a.status === 'scheduled').sort((a, b) => a.effectiveAt - b.effectiveAt);
  const tracks = state.chargers.map((ch) => ({ ch, track: priceTrack(state, ch) }));
  const unconfirmed = tracks.filter((t) => t.track && t.track.stage !== 'confirmed').length;
  const history = usePaged(state.pricingDeployments, 12);
  const pastAssignments = state.pricingAssignments.filter((a) => !['active', 'scheduled'].includes(a.status));

  return (
    <div>
      <PageHeader
        title="Pricing"
        subtitle={`Currency ${cur} · ${state.pricingRules.length} tariffs · ${unconfirmed} charger${unconfirmed === 1 ? '' : 's'} without a confirmed tariff`}
        actions={manage ? (
          <>
            <Button icon={Tag} onClick={() => setAssign({})}>Assign tariff</Button>
            <Button variant="primary" icon={Plus} onClick={() => setRuleModal({})}>New tariff</Button>
          </>
        ) : null}
      />

      <div className="mb-4">
        <Notice tone="blue" icon={Info} title="A price saved here is not automatically the price on the charger">
          Standard OCPP 1.6 has no command for setting a customer tariff. The CMS stores the price, attempts a vendor-specific push where the charger is marked as having a tariff interface, and reports each step separately. Until the hardware interface is verified, treat the CMS price as the basis for backend billing only.
        </Notice>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'tariffs', label: 'Tariffs', count: state.pricingRules.length },
          { value: 'assignments', label: 'Assignments', count: active.length },
          { value: 'scheduled', label: 'Scheduled changes', count: scheduled.length },
          { value: 'status', label: 'Charger status', count: state.chargers.length },
          { value: 'history', label: 'History', count: state.pricingDeployments.length },
        ]}
      />

      {tab === 'tariffs' ? (
        state.pricingRules.length === 0 ? <Card><EmptyState icon={Tag} title="No tariffs yet" text="Create a tariff, then assign it to the network, a location, a group or a charger." /></Card> : (
          <div className="grid gap-4 lg:grid-cols-2">
            {state.pricingRules.map((r) => {
              const range = priceRange(r);
              const now = rateAt(r, new Date());
              const uses = state.chargers.filter((ch) => { const p = resolvePricing(state, ch); return p && p.rule.id === r.id; }).length;
              return (
                <Card key={r.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-slate-900">{r.name} <span className="ml-1 text-xs font-normal text-slate-500">v{r.version}</span></h2>
                      <p className="text-xs text-slate-500">{r.description || 'No description'}</p>
                    </div>
                    {manage ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" icon={Tag} onClick={() => setAssign({ ruleId: r.id })} aria-label={`Assign ${r.name}`} />
                        <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRuleModal(r)} aria-label={`Edit ${r.name}`} />
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDel(r)} aria-label={`Delete ${r.name}`} />
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Tone tone="blue">Now: {fmtMoney(now.total, cur)}/kWh</Tone>
                    <Tone>{range.min === range.max ? 'Single price' : `${fmtMoney(range.min, cur)} – ${fmtMoney(range.max, cur)}`}</Tone>
                    <Tone>{uses} charger{uses === 1 ? '' : 's'}</Tone>
                    {r.weekendPeriods ? <Tone tone="amber">Weekend schedule</Tone> : null}
                  </div>
                  <table className="mt-3 w-full text-sm">
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="pb-1 font-semibold">Period</th><th className="pb-1 text-right font-semibold">Energy</th><th className="pb-1 text-right font-semibold">Service</th><th className="pb-1 text-right font-semibold">Total / kWh</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {sortedPeriods(r.periods).map((p) => (
                        <tr key={p.id} className={now.period && now.period.id === p.id ? 'bg-blue-50/60' : ''}>
                          <td className="py-1.5">{r.periods.length > 1 ? `${p.start}–${periodEnd(r.periods, p)}` : 'All day'} <span className="text-xs text-slate-500">{(PERIOD_KINDS.find((k) => k.value === p.kind) || {}).label}</span></td>
                          <td className="py-1.5 text-right">{fmtMoney(p.energyPrice, cur)}</td>
                          <td className="py-1.5 text-right">{fmtMoney(p.servicePrice, cur)}</td>
                          <td className="py-1.5 text-right font-medium">{fmtMoney(p.energyPrice + p.servicePrice, cur)}</td>
                        </tr>
                      ))}
                      {(r.weekendPeriods || []).map((p) => (
                        <tr key={p.id} className={now.period && now.period.id === p.id ? 'bg-blue-50/60' : ''}>
                          <td className="py-1.5">Weekend {r.weekendPeriods.length > 1 ? `${p.start}–${periodEnd(r.weekendPeriods, p)}` : 'all day'}</td>
                          <td className="py-1.5 text-right">{fmtMoney(p.energyPrice, cur)}</td>
                          <td className="py-1.5 text-right">{fmtMoney(p.servicePrice, cur)}</td>
                          <td className="py-1.5 text-right font-medium">{fmtMoney(p.energyPrice + p.servicePrice, cur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-slate-500">Flat fee {fmtMoney(r.flatFee, cur)} · time fee {fmtMoney(r.hourPrice, cur)}/h · pre-authorisation {fmtMoney(r.preauthAmount, cur)}</p>
                </Card>
              );
            })}
          </div>
        )
      ) : null}

      {tab === 'assignments' ? (
        <Card>
          <CardHeader title="Active assignments" subtitle="The most specific assignment wins: connector, charger, group, location, then network" />
          <TableWrap>
            <thead className="bg-slate-50"><tr><th className="th">Tariff</th><th className="th">Level</th><th className="th">Target</th><th className="th">Active since</th><th className="th">By</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {active.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="td font-medium text-slate-900">{(byId(state.pricingRules, a.ruleId) || {}).name}</td>
                  <td className="td"><Tone>{SCOPE_LABEL[a.scope]}</Tone></td>
                  <td className="td">{targetName(state, a)}{a.scope === 'connector' ? <p className="text-xs text-slate-500">CMS billing only</p> : null}</td>
                  <td className="td">{fmtDateTime(a.activatedAt)}</td>
                  <td className="td">{a.createdBy}</td>
                  <td className="td text-right">{manage && a.scope !== 'global' ? <Button size="sm" onClick={() => setCancel(a)}>Remove</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      ) : null}

      {tab === 'scheduled' ? (
        <Card>
          <CardHeader title="Scheduled price changes" subtitle="Nothing is sent to a charger until the change takes effect" />
          {scheduled.length ? (
            <TableWrap>
              <thead className="bg-slate-50"><tr><th className="th">Takes effect</th><th className="th">Tariff</th><th className="th">Level</th><th className="th">Target</th><th className="th">Scheduled by</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {scheduled.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td font-medium text-slate-900">{fmtDateTime(a.effectiveAt)}</td>
                    <td className="td">{(byId(state.pricingRules, a.ruleId) || {}).name}</td>
                    <td className="td"><Tone>{SCOPE_LABEL[a.scope]}</Tone></td>
                    <td className="td">{targetName(state, a)}</td>
                    <td className="td">{a.createdBy}</td>
                    <td className="td text-right">{manage ? <Button size="sm" onClick={() => setCancel(a)}>Cancel</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          ) : <EmptyState icon={CalendarClock} title="No scheduled price changes" text="Use Assign tariff and choose “Schedule for later”." />}
        </Card>
      ) : null}

      {tab === 'status' ? (
        <Card>
          <CardHeader title="Tariff on each charger" subtitle="Stored, sent, confirmed and applied are tracked separately" action={<SimTag />} />
          <TableWrap>
            <thead className="bg-slate-50"><tr><th className="th">Charger</th><th className="th">Tariff (CMS)</th><th className="th">Price now</th><th className="th">Status</th><th className="th">Detail</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {tracks.map(({ ch, track }) => (
                <tr key={ch.id} className="hover:bg-slate-50">
                  <td className="td"><Link className="font-medium text-slate-900 hover:underline" to={`/chargers/${ch.id}`}>{ch.name}</Link><p className="text-xs text-slate-500">Tariff interface: {ch.capabilities.tariffSync === 'verified' ? 'verified' : ch.capabilities.tariffSync === 'unverified' ? 'not verified' : 'none'}</p></td>
                  <td className="td">{track ? `${track.rule.name} v${track.rule.version}` : 'None'}</td>
                  <td className="td">{track ? `${fmtMoney(rateAt(track.rule, new Date()).total, cur)}/kWh` : '—'}</td>
                  <td className="td">{track ? <StageBadge stage={track.stage} /> : '—'}</td>
                  <td className="td min-w-[18rem]"><PriceTrack charger={ch} compact />{track && track.dep && track.stage !== 'confirmed' ? <p className="mt-1 text-xs text-slate-500">{track.dep.detail}</p> : null}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      ) : null}

      {tab === 'history' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Price change history" subtitle="Every attempt to put a tariff on a charger, newest first" />
            <TableWrap>
              <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Charger</th><th className="th">Tariff</th><th className="th">Result</th><th className="th">Requested by</th><th className="th">Command</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {history.rows.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="td">{fmtDateTime(d.createdAt)}</td>
                    <td className="td">{(byId(state.chargers, d.chargerId) || {}).name || `${d.chargerId} (deleted)`}</td>
                    <td className="td">{d.ruleName} v{d.ruleVersion}{d.current ? <span className="ml-2 text-xs text-slate-500">current</span> : null}</td>
                    <td className="td"><StageBadge stage={d.stage} /><p className="mt-0.5 max-w-sm text-xs text-slate-500">{d.detail}</p></td>
                    <td className="td">{d.requestedBy}</td>
                    <td className="td font-mono text-xs">{d.commandId || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination {...history} noun="deployments" />
          </Card>
          {pastAssignments.length ? (
            <Card>
              <CardHeader title="Ended assignments" />
              <ul className="divide-y divide-slate-100">
                {pastAssignments.slice(0, 20).map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span>{(byId(state.pricingRules, a.ruleId) || {}).name || 'Deleted tariff'} → {targetName(state, a)} <span className="text-xs text-slate-500">({SCOPE_LABEL[a.scope]})</span></span>
                    <span className="flex items-center gap-2 text-xs text-slate-500"><Tone>{a.status}</Tone>{fmtDateTime(a.endedAt || a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      <RuleModal open={Boolean(ruleModal)} onClose={() => setRuleModal(null)} rule={ruleModal && ruleModal.id ? ruleModal : null} onSaved={(out) => { if (out.deployments.length) setTab('status'); }} />
      <AssignPricingDialog open={Boolean(assign)} onClose={() => setAssign(null)} preset={assign || undefined} />
      <ConfirmDialog
        open={Boolean(del)}
        onClose={() => setDel(null)}
        busy={busy}
        danger
        title={del ? `Delete tariff ${del.name}?` : ''}
        confirmLabel="Delete tariff"
        onConfirm={async () => { const ok = await run(() => api.deleteRule(del.id), { success: 'Tariff deleted.' }); if (ok) setDel(null); }}
      >
        <p>A tariff that is assigned or scheduled cannot be deleted. Past sessions keep the tariff name and price they were calculated with.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(cancel)}
        onClose={() => setCancel(null)}
        busy={busy}
        title={cancel && cancel.status === 'scheduled' ? 'Cancel this scheduled change?' : 'Remove this assignment?'}
        confirmLabel={cancel && cancel.status === 'scheduled' ? 'Cancel change' : 'Remove assignment'}
        onConfirm={async () => { const ok = await run(() => api.cancelAssignment(cancel.id), { success: cancel.status === 'scheduled' ? 'Scheduled change cancelled.' : 'Assignment removed.' }); if (ok) setCancel(null); }}
      >
        {cancel ? <p>{(byId(state.pricingRules, cancel.ruleId) || {}).name} → {targetName(state, cancel)}</p> : null}
        {cancel && cancel.status === 'active' ? <p>Affected chargers fall back to the next applicable tariff, and a new push is started for each of them.</p> : <p>Nothing has been sent to any charger for this change.</p>}
      </ConfirmDialog>
    </div>
  );
}
