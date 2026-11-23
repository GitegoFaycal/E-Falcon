import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { api, API_URL } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, CardHeader, PageHeader, Field, Select, KeyValue, Notice } from '../components/ui.jsx';

const pick = (s) => ({
  orgName: s.orgName, currency: s.currency, timezone: s.timezone, commandTimeoutSec: s.commandTimeoutSec, heartbeatIntervalSec: s.heartbeatIntervalSec,
  tariffIntegration: { method: 'none', vendorId: '', messageId: 'SetTariff', ...(s.tariffIntegration || {}) },
});

export default function SettingsPage() {
  const state = useStore();
  const { can, connection } = useAuth();
  const [run, busy] = useAction();
  const s = state.settings;
  const [f, setF] = useState(() => pick(s));
  const key = JSON.stringify(pick(s));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setF(pick(s)); }, [key]);
  const editable = can('settings.manage');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setTariff = (k) => (e) => setF((x) => ({ ...x, tariffIntegration: { ...x.tariffIntegration, [k]: e && e.target ? e.target.value : e } }));
  const submit = (e) => {
    e.preventDefault();
    run(() => api.updateSettings(f), { success: 'Settings saved.' });
  };
  const online = state.chargers.filter((c) => c.online).length;

  return (
    <div>
      <PageHeader title="Settings" subtitle="System configuration" />
      {!editable ? <div className="mb-4"><Notice tone="gray">You can view these settings. Changing them needs the “Manage system settings” permission.</Notice></div> : null}

      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="General" />
          <div className="space-y-3 p-4">
            <Field label="Organisation name"><input className="input" value={f.orgName} onChange={set('orgName')} disabled={!editable} maxLength={60} required /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Currency" hint="3-letter code. Changing it relabels prices; it does not convert them."><input className="input uppercase" value={f.currency} onChange={set('currency')} disabled={!editable} maxLength={3} required /></Field>
              <Field label="Time zone" hint="Tariff periods are evaluated in this time zone on the server."><input className="input" value={f.timezone} onChange={set('timezone')} disabled={!editable} maxLength={60} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Command timeout (seconds)" hint="How long to wait for a charger's reply."><input type="number" min={3} max={300} className="input" value={f.commandTimeoutSec} onChange={set('commandTimeoutSec')} disabled={!editable} /></Field>
              <Field label="Heartbeat interval (seconds)" hint="Sent to chargers in the BootNotification response; applies from their next boot."><input type="number" min={5} max={3600} className="input" value={f.heartbeatIntervalSec} onChange={set('heartbeatIntervalSec')} disabled={!editable} /></Field>
            </div>
            {editable ? <div className="flex justify-end pt-1"><Button variant="primary" type="submit" busy={busy}>Save settings</Button></div> : null}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Tariff integration" subtitle="How a price saved in the CMS reaches a charger" />
              <div className="space-y-3 p-4">
                <Field label="Method">
                  <Select value={f.tariffIntegration.method} onChange={setTariff('method')} disabled={!editable} options={[{ value: 'none', label: 'None: CMS billing only (nothing is sent to chargers)' }, { value: 'datatransfer', label: 'OCPP DataTransfer (vendor-specific)' }]} />
                </Field>
                {f.tariffIntegration.method === 'datatransfer' ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Vendor ID" hint="Exactly as the manufacturer specifies."><input className="input font-mono" value={f.tariffIntegration.vendorId} onChange={setTariff('vendorId')} disabled={!editable} maxLength={255} /></Field>
                      <Field label="Message ID"><input className="input font-mono" value={f.tariffIntegration.messageId} onChange={setTariff('messageId')} disabled={!editable} maxLength={50} /></Field>
                    </div>
                    <Notice tone="amber">The message body is E-Falcon&apos;s own JSON (periods with start time, energy and service price, fees). A real charger will only understand it if the manufacturer&apos;s format matches; until that is confirmed on the touchscreen, an “Accepted” reply does not prove the price changed. The format is defined in <code>backend/src/core/engine.js</code> (<code>toOcpp</code>).</Notice>
                  </>
                ) : (
                  <Notice tone="blue" icon={Info}>Standard OCPP 1.6 has no tariff message. With no integration, prices are used to calculate session cost in the CMS and every charger shows “CMS billing only” under Pricing.</Notice>
                )}
                {editable ? <div className="flex justify-end"><Button variant="primary" type="submit" busy={busy}>Save settings</Button></div> : null}
              </div>
          </Card>

          <Card>
            <CardHeader title="Data source" subtitle="Where the numbers on every page come from" />
            <div className="space-y-3 p-4">
              <KeyValue items={[
                ['Server', API_URL],
                ['Live updates', connection === 'live' ? 'Connected' : 'Reconnecting'],
                ['Chargers connected over OCPP', `${online} of ${state.chargers.length}`],
              ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Operational limit" subtitle="Managed on its own page" />
            <div className="p-4 text-sm text-slate-700">Maximum enabled connectors: <strong>{s.operationalLimit.maxEnabledConnectors}</strong> · policy: <strong>{s.operationalLimit.policy === 'block' ? 'hard block' : 'block with authorised override'}</strong></div>
          </Card>
        </div>
      </form>

    </div>
  );
}
