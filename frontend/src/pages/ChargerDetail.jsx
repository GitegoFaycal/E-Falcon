import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, RefreshCw, Settings, Wifi, WifiOff, FlaskConical, Tag, Power, PowerOff, Lock } from 'lucide-react';
import { api, LIVE, ocppEndpoint } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, CardHeader, PageHeader, StatusBadge, KeyValue, CapabilityBadge, Tabs, EmptyState, ConfirmDialog, Notice, Tone, Modal } from '../components/ui.jsx';
import { ConnectorCard, AvailabilityDialog, AssignPricingDialog } from '../components/ops.jsx';
import { ChargerFormModal } from '../components/ChargerForm.jsx';
import { PriceTrack } from '../components/PriceTrack.jsx';
import { CommandTable, SessionTable, AlertList } from '../components/tables.jsx';
import { connectorsOf, byId, resolvePricing } from '../lib/selectors.js';
import { chargerState, CAPABILITY_KEYS } from '../lib/status.js';
import { sortedPeriods, periodEnd, PERIOD_KINDS } from '../lib/tariff.js';
import { fmtDateTimeFull, timeAgo, fmtMoney, fmtKwh, fmtTime } from '../lib/format.js';

const SHARING = { unknown: 'Unknown (not yet verified)', shared: 'Shared between guns', independent: 'Independent per gun' };

// Live mode: what to enter on the charger's OCPP screen, and issuing its authorisation key.
function OcppAccess({ charger }) {
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState(null);
  const issue = async () => {
    const out = await run(() => api.setChargerAuthKey(charger.id));
    if (out) { setConfirm(false); setIssued(out.key); }
  };
  return (
    <Card className="mt-4">
      <CardHeader title={<span className="flex items-center gap-2"><Lock className="h-4 w-4 text-slate-500" />Connecting this charger</span>} subtitle="Enter these on the charger's OCPP settings screen" action={can('chargers.manage') ? <Button size="sm" onClick={() => setConfirm(true)}>{charger.hasAuthKey ? 'Issue a new key' : 'Issue authorisation key'}</Button> : null} />
      <div className="space-y-3 p-4">
        <KeyValue items={[
          ['Connection URL', <span key="u" className="break-all font-mono text-xs">{ocppEndpoint(charger.ocppId)}</span>],
          ['CP identification', <span key="i" className="font-mono">{charger.ocppId}</span>],
          ['Protocol', 'OCPP 1.6J (WebSocket subprotocol ocpp1.6)'],
          ['Authorisation key', charger.hasAuthKey ? 'Issued (only a hash is stored)' : 'Not issued yet'],
        ]}
        />
        <p className="text-xs text-slate-500">Some chargers take the URL without the identity at the end and append it themselves. Use <code>wss://</code> if the firmware supports TLS; over plain <code>ws://</code> the key travels unencrypted.</p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={issue} busy={busy} title="Issue a new authorisation key?" confirmLabel="Issue key">
        <p>A new random key is generated for {charger.name} and shown once.</p>
        {charger.hasAuthKey ? <p className="text-amber-800">The current key stops working immediately. The charger cannot reconnect until the new key is entered on its screen.</p> : null}
      </ConfirmDialog>
      <Modal open={Boolean(issued)} onClose={() => setIssued(null)} title="Authorisation key" subtitle="Shown once. It cannot be displayed again." footer={<Button variant="primary" onClick={() => setIssued(null)}>I have saved it</Button>}>
        <p className="select-all break-all rounded-md bg-slate-900 p-3 font-mono text-sm text-slate-100">{issued}</p>
        <p className="mt-3 text-sm text-slate-600">Enter it as the authorisation key (HTTP Basic password) on the charger. Keep it out of photos and chat messages.</p>
      </Modal>
    </Card>
  );
}

export default function ChargerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const state = useStore();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [tab, setTab] = useState('sessions');
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [dialog, setDialog] = useState(null);

  const ch = byId(state.chargers, id);
  if (!ch) {
    return <EmptyState title="Charger not found" text="It may have been deleted." action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/chargers">Back to chargers</Link>} />;
  }
  const conns = connectorsOf(state, ch.id);
  const loc = byId(state.locations, ch.locationId);
  const groups = ch.groupIds.map((g) => byId(state.groups, g)).filter(Boolean);
  const pricing = resolvePricing(state, ch);
  const cur = state.settings.currency;
  const sessions = state.sessions.filter((s) => s.chargerId === ch.id);
  const commands = state.commands.filter((c) => c.chargerId === ch.id);
  const alerts = state.alerts.filter((a) => a.chargerId === ch.id);
  const events = state.events.filter((e) => e.chargerId === ch.id);
  const active = sessions.filter((s) => s.status === 'active');
  const energyToday = sessions.filter((s) => s.startedAt >= new Date().setHours(0, 0, 0, 0)).reduce((n, s) => n + s.energyKwh, 0);

  const doConfirm = async () => {
    if (confirm === 'delete') {
      const ok = await run(() => api.deleteCharger(ch.id), { success: 'Charger deleted.' });
      if (ok) navigate('/chargers');
      return;
    }
    const ok = await run(() => api.sendCommand({ chargerId: ch.id, type: confirm }), { success: `${confirm} submitted.` });
    if (ok) { setConfirm(null); setTab('commands'); }
  };

  return (
    <div>
      <Link to="/chargers" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Chargers</Link>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{ch.name}<StatusBadge state={chargerState(ch, conns)} /></span>}
        subtitle={<span className="font-mono">{ch.ocppId}</span>}
        actions={(
          <>
            {can('availability.manage') ? (
              <>
                <Button icon={Power} onClick={() => setDialog('enable')}>Enable all</Button>
                <Button icon={PowerOff} onClick={() => setDialog('restrict')}>Restrict all</Button>
              </>
            ) : null}
            {can('pricing.manage') ? <Button icon={Tag} onClick={() => setDialog('pricing')}>Assign tariff</Button> : null}
            {can('commands.remote') && ch.capabilities.configuration !== 'unsupported' ? <Button icon={Settings} onClick={() => setConfirm('GetConfiguration')}>Get configuration</Button> : null}
            {can('commands.remote') && ch.capabilities.reset !== 'unsupported' ? <Button icon={RefreshCw} onClick={() => setConfirm('Reset')}>Reset</Button> : null}
            {can('chargers.manage') ? <Button icon={Pencil} onClick={() => setEdit(true)}>Edit</Button> : null}
            {can('chargers.delete') ? <Button variant="danger" icon={Trash2} onClick={() => setConfirm('delete')}>Delete</Button> : null}
          </>
        )}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Identity and connection" />
          <div className="p-4">
            <KeyValue items={[
              ['OCPP identity', <span key="o" className="font-mono">{ch.ocppId}</span>],
              ['Serial number', ch.serial],
              ['Manufacturer', ch.manufacturer],
              ['Model', ch.model],
              ['Firmware', ch.firmware || 'Not reported yet'],
              ['OCPP version', ch.ocppVersion],
              ['Location', loc ? `${loc.name}${loc.address ? `, ${loc.address}` : ''}` : null],
              ['Groups', groups.length ? groups.map((g) => g.name).join(', ') : 'None'],
              ['OCPP connection', <span key="c" className="inline-flex items-center gap-1.5">{ch.online ? <Wifi className="h-4 w-4 text-green-600" /> : <WifiOff className="h-4 w-4 text-slate-400" />}{ch.online ? 'Connected' : ch.everConnected ? 'Disconnected' : 'Never connected'}</span>],
              ['Last heartbeat', ch.lastHeartbeat ? `${timeAgo(ch.lastHeartbeat)} (${fmtDateTimeFull(ch.lastHeartbeat)})` : 'Never'],
              ['Last boot', fmtDateTimeFull(ch.bootedAt)],
              ['Energy today', fmtKwh(energyToday, 1)],
            ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Hardware and capabilities" subtitle="What has been verified on this unit" />
          <div className="space-y-3 p-4">
            <KeyValue items={[
              ['Rated power', ch.hardware.ratedPowerKw ? `${ch.hardware.ratedPowerKw} kW` : 'Not documented'],
              ['Power between guns', SHARING[ch.hardware.powerSharing]],
              ['Tariff periods accepted', ch.hardware.maxTariffPeriods],
              ['Notes', ch.hardware.notes],
            ]}
            />
            <ul className="space-y-1.5 border-t border-slate-100 pt-3">
              {CAPABILITY_KEYS.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-2 text-sm" title={c.hint}>
                  <span className="text-slate-700">{c.label}</span>
                  <CapabilityBadge value={ch.capabilities[c.key]} />
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-slate-900">Connectors</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {conns.map((c) => <ConnectorCard key={c.id} connector={c} charger={ch} />)}
      </div>

      <Card className="mt-4">
        <CardHeader title="Configured pricing" subtitle={pricing ? `${pricing.rule.name} · assigned at ${pricing.assignment.scope} level` : 'No tariff assigned'} action={<Link to="/pricing" className="text-xs font-medium text-brand-700 hover:underline">Pricing</Link>} />
        {pricing ? (
          <div className="grid gap-6 p-4 lg:grid-cols-2">
            <div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="pb-1 font-semibold">Period</th><th className="pb-1 text-right font-semibold">Energy</th><th className="pb-1 text-right font-semibold">Service</th><th className="pb-1 text-right font-semibold">Total / kWh</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedPeriods(pricing.rule.periods).map((p) => (
                    <tr key={p.id}>
                      <td className="py-1.5">{p.start}–{periodEnd(pricing.rule.periods, p)} <span className="text-xs text-slate-500">{(PERIOD_KINDS.find((k) => k.value === p.kind) || {}).label}</span></td>
                      <td className="py-1.5 text-right">{fmtMoney(p.energyPrice, cur)}</td>
                      <td className="py-1.5 text-right">{fmtMoney(p.servicePrice, cur)}</td>
                      <td className="py-1.5 text-right font-medium">{fmtMoney(p.energyPrice + p.servicePrice, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">Flat fee {fmtMoney(pricing.rule.flatFee, cur)} · time fee {fmtMoney(pricing.rule.hourPrice, cur)}/h · pre-authorisation {fmtMoney(pricing.rule.preauthAmount, cur)}{pricing.rule.weekendPeriods ? ' · separate weekend schedule (CMS-side)' : ''}</p>
            </div>
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">What is known about this price on the unit</p>
              <PriceTrack charger={ch} />
            </div>
          </div>
        ) : <EmptyState title="No tariff assigned" text="Assign a tariff under Pricing." />}
      </Card>

      <Card className="mt-4">
        <div className="px-4 pt-3">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'sessions', label: 'Sessions', count: active.length ? `${active.length} active` : sessions.length },
              { value: 'commands', label: 'Command history', count: commands.length },
              { value: 'events', label: 'Events', count: events.length },
              { value: 'alerts', label: 'Alerts', count: alerts.filter((a) => a.status === 'open').length },
            ]}
          />
        </div>
        {tab === 'sessions' ? <SessionTable sessions={sessions} showCharger={false} pageSize={8} /> : null}
        {tab === 'commands' ? <CommandTable commands={commands} showCharger={false} pageSize={8} /> : null}
        {tab === 'alerts' ? <AlertList alerts={alerts} pageSize={6} /> : null}
        {tab === 'events' ? (
          events.length ? (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {events.slice(0, 100).map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0"><Tone>{e.type}</Tone> <span className="text-slate-700">{e.message}</span>{e.connectorId ? <span className="text-xs text-slate-500"> · {(byId(state.connectors, e.connectorId) || {}).label}</span> : null}</span>
                  <span className="shrink-0 text-xs text-slate-500">{fmtTime(e.at)} · {timeAgo(e.at)}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No events recorded" />
        ) : null}
      </Card>

      {LIVE ? <OcppAccess charger={ch} /> : (
      <Card className="mt-4 border-amber-200">
        <CardHeader title={<span className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-amber-700" />Simulator controls</span>} subtitle="Development only. These act on the simulated charger, not on the CMS, and do not exist in production." />
        <div className="flex flex-wrap gap-2 p-4">
          <Button size="sm" busy={busy} onClick={() => run(() => api.simSetOnline(ch.id, !ch.online))}>{ch.online ? 'Drop connection' : 'Connect charger'}</Button>
          {conns.map((c) => (
            <span key={c.id} className="flex flex-wrap gap-2">
              <Button size="sm" busy={busy} disabled={!ch.online} onClick={() => run(() => api.simPlug(c.id))}>{c.label}: {c.sessionId ? 'unplug vehicle' : 'plug in vehicle'}</Button>
              <Button size="sm" busy={busy} disabled={!ch.online} onClick={() => run(() => api.simFault(c.id, c.status !== 'Faulted'))}>{c.label}: {c.status === 'Faulted' ? 'clear fault' : 'trigger fault'}</Button>
            </span>
          ))}
        </div>
      </Card>
      )}

      <ChargerFormModal open={edit} onClose={() => setEdit(false)} charger={ch} />
      <AvailabilityDialog open={dialog === 'enable' || dialog === 'restrict'} onClose={() => setDialog(null)} connectorIds={conns.map((c) => c.id)} action={dialog === 'enable' ? 'enable' : 'restrict'} />
      <AssignPricingDialog open={dialog === 'pricing'} onClose={() => setDialog(null)} preset={{ scope: 'charger', targetIds: [ch.id] }} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        onConfirm={doConfirm}
        busy={busy}
        danger={confirm === 'delete' || confirm === 'Reset'}
        title={confirm === 'delete' ? `Delete ${ch.name}?` : confirm === 'Reset' ? `Reset ${ch.name}?` : 'Read configuration from charger?'}
        confirmLabel={confirm === 'delete' ? 'Delete charger' : 'Send command'}
      >
        {confirm === 'delete' ? <p>The charger and its {conns.length} connectors are removed from the CMS. Session history is kept. This cannot be undone.</p> : null}
        {confirm === 'Reset' ? <><p>A soft reset restarts the charger controller. The charger will be offline for a short time.</p><p>The CMS refuses a reset while a session is in progress, and never retries it automatically.</p></> : null}
        {confirm === 'GetConfiguration' ? <p>Sends GetConfiguration. Open the command in Command history to read the keys the charger reports; this is how vendor-specific tariff keys are discovered.</p> : null}
        {confirm && confirm !== 'delete' && ch.capabilities[confirm === 'Reset' ? 'reset' : 'configuration'] === 'unverified' ? <Notice tone="amber">This command has not been verified on this charger model.</Notice> : null}
      </ConfirmDialog>
    </div>
  );
}
