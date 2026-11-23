import { useState } from 'react';
import { useStore } from '../context/store.jsx';
import { Card, PageHeader, Select, SimTag, Tone } from '../components/ui.jsx';
import { CommandTable } from '../components/tables.jsx';
import { COMMAND_STATUS, ACTIVE_COMMAND_STATUSES } from '../lib/status.js';

export default function Commands() {
  const state = useStore();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [charger, setCharger] = useState('');
  const types = [...new Set(state.commands.map((c) => c.type))];
  const rows = state.commands.filter((c) => (!status || c.status === status) && (!type || c.type === type) && (!charger || c.chargerId === charger));
  const inFlight = state.commands.filter((c) => ACTIVE_COMMAND_STATUSES.includes(c.status)).length;
  const failed = state.commands.filter((c) => ['failed', 'timed_out'].includes(c.status)).length;

  return (
    <div>
      <PageHeader
        title="Commands"
        subtitle="Every remote operation, with what the charger answered"
        actions={(
          <>
            <Tone tone="blue">{inFlight} in progress</Tone>
            <Tone tone={failed ? 'red' : 'gray'}>{failed} failed or timed out</Tone>
            <SimTag />
          </>
        )}
      />
      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-3">
          <Select value={status} onChange={setStatus} aria-label="Filter by status" options={[{ value: '', label: 'All statuses' }, ...Object.entries(COMMAND_STATUS).map(([k, v]) => ({ value: k, label: v.label }))]} />
          <Select value={type} onChange={setType} aria-label="Filter by type" options={[{ value: '', label: 'All command types' }, ...types.map((t) => ({ value: t, label: t }))]} />
          <Select value={charger} onChange={setCharger} aria-label="Filter by charger" options={[{ value: '', label: 'All chargers' }, ...state.chargers.map((c) => ({ value: c.id, label: c.name }))]} />
        </div>
        <CommandTable commands={rows} />
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
          Timeout {state.settings.commandTimeoutSec}s. ChangeAvailability, GetConfiguration and tariff pushes are safe to repeat and are retried once automatically after a timeout. Remote start, remote stop and reset are never retried automatically. “SetTariff” is a placeholder for a vendor-specific tariff interface, not a standard OCPP message.
        </p>
      </Card>
    </div>
  );
}
