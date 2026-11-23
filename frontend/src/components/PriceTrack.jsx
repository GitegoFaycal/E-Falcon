// The four things we can know about a price, kept strictly apart:
//   1. stored in the CMS   2. sent to the charger   3. confirmed by the charger   4. applied to a session
import { Check, Minus, Loader2, X } from 'lucide-react';
import { useStore } from '../context/store.jsx';
import { byId, resolvePricing, currentDeployment } from '../lib/selectors.js';
import { fmtDateTime } from '../lib/format.js';

export function priceTrack(state, charger) {
  const res = resolvePricing(state, charger, null);
  if (!res) return null;
  const { rule } = res;
  const dep = currentDeployment(state, charger.id);
  const fresh = dep && dep.ruleId === rule.id && dep.ruleVersion === rule.version;
  const cmd = fresh && dep.commandId ? byId(state.commands, dep.commandId) : null;
  const session = state.sessions.find((s) => s.chargerId === charger.id && s.ruleId === rule.id && s.ruleVersion === rule.version);
  const stage = fresh ? dep.stage : 'stored';

  const sent = cmd && cmd.sentAt
    ? { state: 'yes', text: fmtDateTime(cmd.sentAt) }
    : stage === 'confirmed' ? { state: 'yes', text: fmtDateTime(dep.updatedAt) }
      : stage === 'stored' && cmd ? { state: 'wait', text: 'Queued' }
        : { state: 'no', text: { cms_only: 'No tariff interface', not_supported: 'Tariff not accepted by this unit', offline: 'Charger offline' }[stage] || 'Not sent' };
  const confirmed = stage === 'confirmed'
    ? { state: 'yes', text: fmtDateTime(dep.updatedAt) }
    : stage === 'sent' || (stage === 'stored' && cmd) ? { state: 'wait', text: 'Waiting for reply' }
      : stage === 'failed' ? { state: 'fail', text: 'No confirmation' }
        : { state: 'no', text: 'Not confirmed' };

  return {
    rule, dep: fresh ? dep : null, stage,
    steps: [
      { key: 'stored', label: 'Stored in CMS', state: 'yes', text: `${rule.name} v${rule.version}` },
      { key: 'sent', label: 'Sent to charger', ...sent },
      { key: 'confirmed', label: 'Confirmed by charger', ...confirmed },
      { key: 'applied', label: 'Applied to a session', state: session ? 'yes' : 'no', text: session ? `${session.id} (CMS-calculated)` : 'No session yet' },
    ],
  };
}

const ICON = {
  yes: { icon: Check, cls: 'bg-green-600 text-white' },
  wait: { icon: Loader2, cls: 'bg-blue-100 text-blue-700', spin: true },
  fail: { icon: X, cls: 'bg-red-600 text-white' },
  no: { icon: Minus, cls: 'bg-slate-200 text-slate-500' },
};

export function PriceTrack({ charger, compact = false }) {
  const state = useStore();
  const track = priceTrack(state, charger);
  if (!track) return <p className="text-sm text-slate-500">No tariff assigned.</p>;
  return (
    <div>
      <ol className={compact ? 'flex flex-wrap gap-x-4 gap-y-1' : 'grid gap-3 sm:grid-cols-4'}>
        {track.steps.map((s) => {
          const I = ICON[s.state];
          return (
            <li key={s.key} className="flex items-start gap-2" title={`${s.label}: ${s.text}`}>
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${I.cls}`}><I.icon className={`h-3 w-3 ${I.spin ? 'animate-spin' : ''}`} /></span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-slate-900">{s.label}</span>
                {!compact ? <span className="block text-xs text-slate-500">{s.text}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {!compact && track.dep && track.dep.detail ? <p className="mt-3 text-xs text-slate-500">{track.dep.detail}</p> : null}
    </div>
  );
}
