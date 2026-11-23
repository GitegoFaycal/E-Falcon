// Operational dialogs shared by several pages: availability changes, pricing assignment,
// and the per-item result list that every bulk operation ends with.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Square, Power, PowerOff, Wrench, Zap } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Modal, Field, Select, Tone, Notice, Checkbox, StatusBadge, ConfirmDialog } from './ui.jsx';
import { byId, limitSnapshot, resolvePricing, connectorLabel } from '../lib/selectors.js';
import { connectorState, COMMAND_STATUS, DEPLOY_STAGE } from '../lib/status.js';
import { rateAt } from '../lib/tariff.js';
import { fmtKw, fmtKwh, fmtMoney, fmtDateTime, fmtDuration, toLocalInput } from '../lib/format.js';

/* ------------------------------------------------------------ result list */

// Turns a submission result into what we actually know right now. A submitted command is
// "Pending" until the charger answers.
export function resolveOutcome(state, r) {
  if (r.commandId) {
    const c = byId(state.commands, r.commandId);
    if (!c) return { label: 'Pending', tone: 'blue', note: '' };
    if (c.status === 'successful') {
      return { label: 'Successful', tone: 'green', note: c.response && c.response.status === 'Scheduled' ? 'Charger answered "Scheduled": it applies when the current session ends. The session is not stopped.' : 'Confirmed by the charger.' };
    }
    if (c.resultCode === 'offline') return { label: 'Offline', tone: 'gray', note: c.error };
    if (c.resultCode === 'not_supported') return { label: 'Not supported', tone: 'amber', note: c.error };
    if (['failed', 'timed_out', 'cancelled'].includes(c.status)) return { label: 'Failed', tone: 'red', note: c.error };
    return { label: 'Pending', tone: 'blue', note: `${COMMAND_STATUS[c.status].label}${c.attempts > 1 ? ` (attempt ${c.attempts})` : ''}` };
  }
  if (r.deploymentId) {
    const d = byId(state.pricingDeployments, r.deploymentId);
    if (!d) return { label: 'Pending', tone: 'blue', note: '' };
    const map = { confirmed: ['Successful', 'green'], failed: ['Failed', 'red'], offline: ['Offline', 'gray'], not_supported: ['Not supported', 'amber'], cms_only: ['CMS billing only', 'amber'] };
    const [label, tone] = map[d.stage] || ['Pending', 'blue'];
    return { label, tone, note: map[d.stage] ? d.detail : DEPLOY_STAGE[d.stage].label };
  }
  const map = {
    blocked_limit: ['Blocked by limit', 'amber'], noop: ['No change', 'gray'], skipped: ['Skipped', 'gray'],
    updated: ['Successful', 'green'], done: ['Successful', 'green'], failed: ['Failed', 'red'],
  };
  const [label, tone] = map[r.outcome] || ['Pending', 'blue'];
  return { label, tone, note: r.message || '' };
}

export function ResultList({ rows }) {
  const state = useStore();
  const resolved = rows.map((r) => ({ ...r, o: resolveOutcome(state, r) }));
  const counts = {};
  resolved.forEach((r) => { counts[r.o.label] = (counts[r.o.label] || 0) + 1; });
  const tones = Object.fromEntries(resolved.map((r) => [r.o.label, r.o.tone]));
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {Object.entries(counts).map(([label, n]) => <Tone key={label} tone={tones[label]}>{n} {label}</Tone>)}
      </div>
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {resolved.map((r, i) => (
          <li key={r.key || i} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">{r.label}</p>
              {r.o.note ? <p className="text-xs text-slate-500">{r.o.note}</p> : null}
            </div>
            <Tone tone={r.o.tone}>{r.o.label}</Tone>
          </li>
        ))}
      </ul>
      {counts.Pending ? <p className="mt-2 text-xs text-slate-500">Pending items update here as each charger answers. You can close this window; results stay in Commands.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------ availability */

export function AvailabilityDialog({ open, onClose, connectorIds, action }) {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [reason, setReason] = useState('');
  const [maintenance, setMaintenance] = useState(false);
  const [when, setWhen] = useState('now');
  const [runAt, setRunAt] = useState('');
  const [override, setOverride] = useState(false);
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (open) { setReason(''); setMaintenance(false); setWhen('now'); setOverride(false); setResults(null); setRunAt(toLocalInput(Date.now() + 3600000)); }
  }, [open]);

  if (!open) return null;
  const enable = action === 'enable';
  const conns = connectorIds.map((id) => byId(state.connectors, id)).filter(Boolean);
  const chargers = new Set(conns.map((c) => c.chargerId));
  const stateOf = (c) => connectorState(c, byId(state.chargers, c.chargerId));
  const charging = conns.filter((c) => c.sessionId).length;
  const offline = conns.filter((c) => stateOf(c) === 'offline').length;
  const changing = conns.filter((c) => (enable ? !c.enabled : c.enabled));
  const snap = limitSnapshot(state);
  const blocked = enable ? Math.max(0, changing.length - Math.max(0, snap.headroom)) : 0;
  const policy = state.settings.operationalLimit.policy;

  const submit = async () => {
    if (when === 'later') {
      const ok = await run(() => api.scheduleAvailability({ connectorIds, action, reason, maintenance, runAt: new Date(runAt).getTime() }), { success: 'Operation scheduled.' });
      if (ok) onClose();
      return;
    }
    const out = await run(() => api.requestAvailability({ connectorIds, action, reason, maintenance, override }));
    if (out) setResults(out.results.map((r) => ({ ...r, key: r.connectorId, label: connectorLabel(state, r.connectorId) })));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={results ? 'Results' : `${enable ? 'Enable' : 'Restrict'} ${conns.length} connector${conns.length === 1 ? '' : 's'}`}
      subtitle={results ? 'Per-connector outcome' : `${chargers.size} charger${chargers.size === 1 ? '' : 's'} affected`}
      footer={results
        ? <Button variant="primary" onClick={onClose}>Close</Button>
        : (
          <>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant={enable ? 'primary' : 'danger'} onClick={submit} busy={busy}>{when === 'later' ? 'Schedule' : enable ? 'Send enable commands' : 'Send restrict commands'}</Button>
          </>
        )}
    >
      {results ? <ResultList rows={results} /> : (
        <div className="space-y-4 text-sm text-slate-700">
          <ul className="space-y-1">
            <li><strong>{changing.length}</strong> of {conns.length} will receive a ChangeAvailability command; {conns.length - changing.length} already {enable ? 'enabled' : 'restricted'}.</li>
            {charging && !enable ? <li><strong>{charging}</strong> currently charging: the session is <strong>not stopped</strong>. The charger schedules the change for when the session ends.</li> : null}
            {offline ? <li><strong>{offline}</strong> on offline chargers: the command cannot be sent and will be reported as Offline.</li> : null}
          </ul>
          {enable ? (
            <Notice tone={blocked ? 'amber' : 'gray'}>
              Operational limit: {snap.enabled} enabled{snap.pendingEnable ? ` + ${snap.pendingEnable} pending` : ''} of {snap.max} allowed.
              {blocked ? ` ${blocked} of these will be blocked by the limit.` : ' This request fits within the limit.'}
            </Notice>
          ) : null}
          {enable && blocked > 0 && policy === 'warn' && can('limits.override') ? (
            <label className="flex items-center gap-2"><Checkbox checked={override} onChange={setOverride} label="Override limit" />Override the limit for this request (recorded in the audit log)</label>
          ) : null}
          {!enable ? (
            <label className="flex items-center gap-2"><Checkbox checked={maintenance} onChange={setMaintenance} label="Maintenance" />Mark as maintenance (shown separately from an operational restriction)</label>
          ) : null}
          <Field label="Reason (recorded in the audit log)">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" maxLength={200} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="When">
              <Select value={when} onChange={setWhen} options={[{ value: 'now', label: 'Now' }, { value: 'later', label: 'Schedule for later' }]} />
            </Field>
            {when === 'later' ? <Field label="Run at (local time)"><input type="datetime-local" className="input" value={runAt} onChange={(e) => setRunAt(e.target.value)} /></Field> : null}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------- pricing */

const SCOPES = [
  { value: 'global', label: 'Whole network (default)' },
  { value: 'location', label: 'Locations' },
  { value: 'group', label: 'Charger groups' },
  { value: 'charger', label: 'Individual chargers' },
  { value: 'connector', label: 'Individual connectors (CMS billing only)' },
];

export function AssignPricingDialog({ open, onClose, preset }) {
  const state = useStore();
  const [run, busy] = useAction();
  const [ruleId, setRuleId] = useState('');
  const [scope, setScope] = useState('charger');
  const [targets, setTargets] = useState([]);
  const [when, setWhen] = useState('now');
  const [effectiveAt, setEffectiveAt] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (!open) return;
    setRuleId((preset && preset.ruleId) || (state.pricingRules[0] || {}).id || '');
    setScope((preset && preset.scope) || 'charger');
    setTargets((preset && preset.targetIds) || []);
    setWhen('now');
    setEffectiveAt(toLocalInput(Date.now() + 3600000));
    setResults(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const options = {
    global: [],
    location: state.locations.map((l) => ({ id: l.id, label: l.name })),
    group: state.groups.map((g) => ({ id: g.id, label: g.name })),
    charger: state.chargers.map((c) => ({ id: c.id, label: c.name })),
    connector: state.connectors.map((c) => ({ id: c.id, label: connectorLabel(state, c.id) })),
  }[scope];
  const affected = state.chargers.filter((ch) => {
    if (scope === 'global') return true;
    if (scope === 'location') return targets.includes(ch.locationId);
    if (scope === 'group') return ch.groupIds.some((g) => targets.includes(g));
    if (scope === 'charger') return targets.includes(ch.id);
    return targets.some((t) => t.startsWith(`${ch.id}-`));
  });
  const noPush = affected.filter((c) => c.capabilities.tariffSync === 'unsupported').length;
  const unverified = affected.filter((c) => c.capabilities.tariffSync === 'unverified').length;
  const offline = affected.filter((c) => !c.online).length;
  const toggle = (id) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const submit = async () => {
    const out = await run(() => api.assignPricing({ ruleId, scope, targetIds: targets, effectiveAt: when === 'later' ? new Date(effectiveAt).getTime() : null }));
    if (!out) return;
    if (when === 'later') {
      setResults([{ key: 's', label: `${out.assignments.length} assignment${out.assignments.length === 1 ? '' : 's'} scheduled`, outcome: 'done', message: `Takes effect ${fmtDateTime(out.assignments[0].effectiveAt)}. Nothing has been sent to any charger yet.` }]);
    } else if (!out.deployments.length) {
      setResults([{ key: 'n', label: 'Assignment saved', outcome: 'noop', message: scope === 'connector' ? 'Connector-level prices are used for CMS billing only; nothing is pushed to the unit.' : 'No charger tariff changed (a more specific assignment takes precedence, or the tariff is already in place).' }]);
    } else {
      setResults(out.deployments.map((d) => ({ key: d.id, deploymentId: d.id, label: (byId(state.chargers, d.chargerId) || {}).name || d.chargerId })));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={results ? 'Results' : 'Assign tariff'}
      subtitle={results ? 'What each charger has confirmed so far' : 'Saving stores the price in the CMS. Reaching the charger is a separate, tracked step.'}
      footer={results
        ? <Button variant="primary" onClick={onClose}>Close</Button>
        : (
          <>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={submit} busy={busy} disabled={!ruleId || (scope !== 'global' && !targets.length)}>{when === 'later' ? 'Schedule change' : `Apply to ${affected.length} charger${affected.length === 1 ? '' : 's'}`}</Button>
          </>
        )}
    >
      {results ? <ResultList rows={results} /> : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tariff"><Select value={ruleId} onChange={setRuleId} options={state.pricingRules.map((r) => ({ value: r.id, label: r.name }))} /></Field>
            <Field label="Apply to"><Select value={scope} onChange={(v) => { setScope(v); setTargets([]); }} options={SCOPES} /></Field>
          </div>
          {scope !== 'global' ? (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-700">
                <span>Targets ({targets.length} selected)</span>
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setTargets(targets.length === options.length ? [] : options.map((o) => o.id))}>{targets.length === options.length ? 'Clear' : 'Select all'}</button>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200 p-2">
                {options.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                    <Checkbox checked={targets.includes(o.id)} onChange={() => toggle(o.id)} label={o.label} />{o.label}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Effective"><Select value={when} onChange={setWhen} options={[{ value: 'now', label: 'Immediately' }, { value: 'later', label: 'Schedule for later' }]} /></Field>
            {when === 'later' ? <Field label="Effective at (local time)"><input type="datetime-local" className="input" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} /></Field> : null}
          </div>
          <Notice tone="gray" title={`${affected.length} charger${affected.length === 1 ? '' : 's'} in scope`}>
            <ul className="list-disc pl-4">
              <li>More specific assignments win: connector, then charger, group, location, network.</li>
              {unverified ? <li>{unverified} with an unverified tariff interface: a push is attempted and reported honestly.</li> : null}
              {noPush ? <li>{noPush} without a tariff interface: CMS billing only, the unit&apos;s own tariff stays as it is.</li> : null}
              {offline ? <li>{offline} offline: stored in the CMS, not sent.</li> : null}
            </ul>
          </Notice>
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- connector */

export function ConnectorCard({ connector, charger, showCharger = false }) {
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const st = connectorState(connector, charger);
  const session = connector.sessionId ? byId(state.sessions, connector.sessionId) : null;
  const pricing = resolvePricing(state, charger, connector);
  const rate = pricing ? rateAt(pricing.rule, new Date()) : null;
  const cur = state.settings.currency;
  const remoteOk = charger.capabilities.remoteStartStop !== 'unsupported';

  const send = async () => {
    const type = confirm;
    const ok = await run(() => api.sendCommand({ chargerId: charger.id, connectorId: connector.id, type }), { success: `${type} submitted. Track the result in Commands.` });
    if (ok) setConfirm(null);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {showCharger ? <Link to={`/chargers/${charger.id}`} className="block truncate text-xs font-medium text-brand-700 hover:underline">{charger.name}</Link> : null}
          <p className="text-sm font-semibold text-slate-900">{connector.label}</p>
          <p className="text-xs text-slate-500">Connector {connector.connectorId} · {connector.type} · {connector.maxPowerKw ? `${connector.maxPowerKw} kW max` : 'power not documented'}</p>
        </div>
        <StatusBadge state={st} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-xs text-slate-500">Power</dt><dd className="font-medium text-slate-900">{st === 'offline' ? '—' : fmtKw(connector.powerKw)}</dd></div>
        <div><dt className="text-xs text-slate-500">Meter register</dt><dd className="font-medium text-slate-900">{fmtKwh(connector.meterWh / 1000, 1)}</dd></div>
        <div><dt className="text-xs text-slate-500">Administrative state</dt><dd className="font-medium text-slate-900">{connector.enabled ? 'Enabled' : connector.maintenance ? 'Maintenance' : 'Restricted'}{connector.pendingInoperative ? ' (restriction scheduled)' : ''}</dd></div>
        <div><dt className="text-xs text-slate-500">Price now</dt><dd className="font-medium text-slate-900">{rate ? `${fmtMoney(rate.total, cur)}/kWh` : 'No tariff'}</dd></div>
      </dl>
      {pricing ? <p className="mt-1 text-xs text-slate-500">Tariff: {pricing.rule.name} (CMS price; see Pricing for what the unit has confirmed)</p> : null}

      {connector.status === 'Faulted' ? <p className="mt-3 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">Fault: {connector.errorCode}{connector.errorInfo ? ` · ${connector.errorInfo}` : ''}</p> : null}

      {session ? (
        <div className="mt-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <p className="flex items-center gap-1 font-semibold"><Zap className="h-3.5 w-3.5" />Session {session.id}</p>
          <p className="mt-0.5">{fmtKwh(session.energyKwh, 2)} · {fmtDuration(Date.now() - session.startedAt)} · {fmtMoney(session.cost, cur)} (CMS estimate)</p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {can('availability.manage') ? (
          connector.enabled
            ? (
              <>
                <Button size="sm" icon={PowerOff} onClick={() => setDialog('restrict')}>Restrict</Button>
              </>
            )
            : <Button size="sm" icon={Power} onClick={() => setDialog('enable')}>Enable</Button>
        ) : null}
        {can('availability.manage') && !connector.enabled && !connector.maintenance ? <Button size="sm" icon={Wrench} onClick={() => setDialog('restrict')}>Maintenance…</Button> : null}
        {can('commands.remote') && remoteOk && st === 'available' ? <Button size="sm" icon={Play} onClick={() => setConfirm('RemoteStartTransaction')}>Remote start</Button> : null}
        {can('commands.remote') && remoteOk && session && st !== 'offline' ? <Button size="sm" icon={Square} onClick={() => setConfirm('RemoteStopTransaction')}>Remote stop</Button> : null}
      </div>

      <AvailabilityDialog open={Boolean(dialog)} onClose={() => setDialog(null)} connectorIds={[connector.id]} action={dialog || 'restrict'} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        onConfirm={send}
        busy={busy}
        danger={confirm === 'RemoteStopTransaction'}
        title={confirm === 'RemoteStopTransaction' ? 'Stop this session remotely?' : 'Start a session remotely?'}
        confirmLabel="Send command"
      >
        <p>{charger.name} · {connector.label}</p>
        <p>{confirm === 'RemoteStopTransaction' ? 'This ends the driver\'s charging session.' : 'The charger will try to start charging on this connector.'} This command is never retried automatically.</p>
        {charger.capabilities.remoteStartStop === 'unverified' ? <p className="text-amber-800">Remote start/stop has not been verified on this charger model.</p> : null}
      </ConfirmDialog>
    </div>
  );
}
