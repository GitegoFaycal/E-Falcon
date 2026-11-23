import { useState } from 'react';
import { useStore } from '../context/store.jsx';
import { Card, PageHeader, Select, Tone } from '../components/ui.jsx';
import { AlertList } from '../components/tables.jsx';
import { ALERT_TYPES, SEVERITY } from '../lib/status.js';

export default function Alerts() {
  const state = useStore();
  const [status, setStatus] = useState('unresolved');
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [charger, setCharger] = useState('');
  const rows = state.alerts.filter((a) => (
    (!status || (status === 'unresolved' ? a.status !== 'resolved' : a.status === status))
    && (!severity || a.severity === severity)
    && (!type || a.type === type)
    && (!charger || a.chargerId === charger)
  ));
  const count = (s) => state.alerts.filter((a) => a.status === s).length;

  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle="Faults, connectivity and failed operations"
        actions={(
          <>
            <Tone tone={count('open') ? 'red' : 'gray'}>{count('open')} open</Tone>
            <Tone tone="amber">{count('acknowledged')} acknowledged</Tone>
            <Tone tone="green">{count('resolved')} resolved</Tone>
          </>
        )}
      />
      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={status} onChange={setStatus} aria-label="Filter by status" options={[{ value: 'unresolved', label: 'Open and acknowledged' }, { value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'resolved', label: 'Resolved' }, { value: '', label: 'All alerts' }]} />
          <Select value={severity} onChange={setSeverity} aria-label="Filter by severity" options={[{ value: '', label: 'All severities' }, ...Object.entries(SEVERITY).map(([k, v]) => ({ value: k, label: v.label }))]} />
          <Select value={type} onChange={setType} aria-label="Filter by type" options={[{ value: '', label: 'All types' }, ...Object.entries(ALERT_TYPES).map(([k, v]) => ({ value: k, label: v }))]} />
          <Select value={charger} onChange={setCharger} aria-label="Filter by charger" options={[{ value: '', label: 'All chargers' }, ...state.chargers.map((c) => ({ value: c.id, label: c.name }))]} />
        </div>
        <AlertList alerts={rows} pageSize={12} />
      </Card>
    </div>
  );
}
