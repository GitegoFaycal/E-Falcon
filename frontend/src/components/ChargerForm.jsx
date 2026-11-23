import { useState } from 'react';
import { api } from '../services/api.js';
import { useStore, useAction } from '../context/store.jsx';
import { Button, Modal, Field, Select, Notice } from './ui.jsx';
import { CAPABILITY_KEYS } from '../lib/status.js';

const CAP_OPTIONS = [
  { value: 'unverified', label: 'Not verified' },
  { value: 'verified', label: 'Verified on hardware' },
  { value: 'unsupported', label: 'Not supported' },
];

const blank = (state) => ({
  name: '', ocppId: '', serial: '', model: '', manufacturer: '', locationId: (state.locations[0] || {}).id || '',
  connectorCount: 2, ratedPowerKw: '', notes: '',
});

const fromCharger = (charger) => ({
  name: charger.name, ocppId: charger.ocppId, serial: charger.serial, model: charger.model, manufacturer: charger.manufacturer,
  locationId: charger.locationId, capabilities: { ...charger.capabilities },
  hardware: { ...charger.hardware, ratedPowerKw: charger.hardware.ratedPowerKw ?? '' },
});

// Register (charger = null) or edit a charger. Editing also documents what the hardware can do.
// The form is mounted only while open, so it always starts from the charger's current values.
export function ChargerFormModal(props) {
  if (!props.open) return null;
  return <ChargerForm key={props.charger ? props.charger.id : 'new'} {...props} />;
}

function ChargerForm({ open, onClose, charger, onSaved }) {
  const state = useStore();
  const [run, busy] = useAction();
  const [f, setF] = useState(() => (charger ? fromCharger(charger) : blank(state)));

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? e.target.value : e }));
  const setHw = (k) => (e) => setF((x) => ({ ...x, hardware: { ...x.hardware, [k]: e && e.target ? e.target.value : e } }));
  const setCap = (k) => (v) => setF((x) => ({ ...x, capabilities: { ...x.capabilities, [k]: v } }));

  const submit = async (e) => {
    e.preventDefault();
    const saved = await run(() => (charger ? api.updateCharger(charger.id, f) : api.createCharger(f)), { success: charger ? 'Charger updated.' : 'Charger registered.' });
    if (saved) { onClose(); if (onSaved) onSaved(saved); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={charger ? `Edit ${charger.name}` : 'Register charger'}
      subtitle={charger ? 'Identity, hardware notes and verified capabilities' : 'The charger appears offline until it connects with this OCPP identity'}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="charger-form" busy={busy}>{charger ? 'Save changes' : 'Register'}</Button>
        </>
      )}
    >
      <form id="charger-form" onSubmit={submit} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name"><input className="input" value={f.name} onChange={set('name')} required maxLength={60} /></Field>
          <Field label="OCPP identity (charge point ID)" hint="Must match the “CP Identification” set on the charger screen."><input className="input font-mono" value={f.ocppId} onChange={set('ocppId')} required maxLength={40} /></Field>
          <Field label="Serial number"><input className="input" value={f.serial} onChange={set('serial')} maxLength={60} /></Field>
          <Field label="Location"><Select value={f.locationId} onChange={set('locationId')} options={state.locations.map((l) => ({ value: l.id, label: l.name }))} /></Field>
          <Field label="Manufacturer"><input className="input" value={f.manufacturer} onChange={set('manufacturer')} maxLength={60} /></Field>
          <Field label="Model"><input className="input" value={f.model} onChange={set('model')} maxLength={60} /></Field>
          {!charger ? (
            <>
              <Field label="Number of connectors"><input type="number" min={1} max={4} className="input" value={f.connectorCount} onChange={set('connectorCount')} /></Field>
              <Field label="Rated power (kW)" hint="Leave empty if not yet known."><input type="number" min={0} className="input" value={f.ratedPowerKw} onChange={set('ratedPowerKw')} /></Field>
            </>
          ) : null}
        </div>

        {!charger ? (
          <Notice tone="gray">New connectors start <strong>restricted</strong> and every capability starts as <strong>not verified</strong>. Enable connectors and record capabilities once the unit has connected and been tested.</Notice>
        ) : (
          <>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Hardware characteristics</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Rated power (kW)"><input type="number" min={0} className="input" value={f.hardware.ratedPowerKw} onChange={setHw('ratedPowerKw')} /></Field>
                <Field label="Power between guns" hint="Do both guns have their own power modules?">
                  <Select value={f.hardware.powerSharing} onChange={setHw('powerSharing')} options={[{ value: 'unknown', label: 'Unknown' }, { value: 'shared', label: 'Shared between guns' }, { value: 'independent', label: 'Independent per gun' }]} />
                </Field>
                <Field label="Tariff periods the unit accepts"><input type="number" min={1} max={48} className="input" value={f.hardware.maxTariffPeriods} onChange={setHw('maxTariffPeriods')} /></Field>
              </div>
              <Field label="Notes" className="mt-3"><textarea className="input" rows={2} value={f.hardware.notes} onChange={setHw('notes')} maxLength={500} placeholder="Controller model, firmware observations, test results…" /></Field>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-slate-900">Capabilities</h3>
              <p className="mb-2 text-xs text-slate-500">Record what has actually been tested. “Not supported” stops the CMS from sending that command at all.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {CAPABILITY_KEYS.map((c) => (
                  <Field key={c.key} label={c.label} hint={c.hint}>
                    <Select value={f.capabilities[c.key]} onChange={setCap(c.key)} options={CAP_OPTIONS} />
                  </Field>
                ))}
              </div>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
