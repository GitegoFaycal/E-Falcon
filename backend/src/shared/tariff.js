// Tariff model and calculation. The same file runs in the dashboard and on the server.
//
// The model follows the tariff screen photographed on the physical charger:
//   - a list of time periods, each defined by a START time and running until the next start
//     (so the day is always fully covered, with no gaps or overlaps),
//   - each period has an energy price and a service price per kWh,
//   - plus a time fee per hour, a flat fee per session and a pre-authorisation amount.
// "weekendPeriods" is a CMS-side extension: the charger screen shows a single schedule only.

export const PERIOD_KINDS = [
  { value: 'standard', label: 'Standard' },
  { value: 'peak', label: 'Peak' },
  { value: 'offpeak', label: 'Off-peak' },
];

export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

export function sortedPeriods(periods = []) {
  return [...periods].sort((a, b) => toMin(a.start) - toMin(b.start));
}

export function isWeekend(date) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

export function periodsFor(rule, date) {
  return isWeekend(date) && rule.weekendPeriods && rule.weekendPeriods.length ? rule.weekendPeriods : rule.periods;
}

export function activePeriod(rule, date = new Date()) {
  const ps = sortedPeriods(periodsFor(rule, date));
  if (!ps.length) return null;
  const now = date.getHours() * 60 + date.getMinutes();
  let current = ps[ps.length - 1]; // before the first start, the last period of the previous day still runs
  for (const p of ps) if (toMin(p.start) <= now) current = p;
  return current;
}

export function rateAt(rule, date = new Date()) {
  const p = rule ? activePeriod(rule, date) : null;
  if (!p) return { energy: 0, service: 0, total: 0, period: null };
  return { energy: p.energyPrice, service: p.servicePrice, total: p.energyPrice + p.servicePrice, period: p };
}

// End time label for a period within its (sorted) list.
export function periodEnd(periods, period) {
  const ps = sortedPeriods(periods);
  const i = ps.findIndex((p) => p.id === period.id);
  const next = ps[(i + 1) % ps.length];
  if (ps.length === 1) return period.start;
  return i === ps.length - 1 ? (toMin(ps[0].start) === 0 ? '24:00' : next.start) : next.start;
}

export function priceRange(rule) {
  const all = [...(rule.periods || []), ...(rule.weekendPeriods || [])].map((p) => p.energyPrice + p.servicePrice);
  if (!all.length) return { min: 0, max: 0 };
  return { min: Math.min(...all), max: Math.max(...all) };
}

function validatePeriodList(list, name, errors) {
  if (!Array.isArray(list) || list.length === 0) {
    errors.push(`${name}: at least one period is required.`);
    return;
  }
  const seen = new Set();
  for (const p of list) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.start || '')) errors.push(`${name}: "${p.start}" is not a valid start time (HH:MM).`);
    if (seen.has(p.start)) errors.push(`${name}: two periods start at ${p.start}.`);
    seen.add(p.start);
    for (const k of ['energyPrice', 'servicePrice']) {
      if (typeof p[k] !== 'number' || Number.isNaN(p[k]) || p[k] < 0) errors.push(`${name}: prices must be zero or positive numbers.`);
    }
  }
}

export function validateRule(rule) {
  const errors = [];
  if (!rule.name || !rule.name.trim()) errors.push('Tariff name is required.');
  validatePeriodList(rule.periods, 'Schedule', errors);
  if (rule.weekendPeriods && rule.weekendPeriods.length) validatePeriodList(rule.weekendPeriods, 'Weekend schedule', errors);
  for (const k of ['flatFee', 'hourPrice', 'preauthAmount']) {
    if (typeof rule[k] !== 'number' || Number.isNaN(rule[k]) || rule[k] < 0) errors.push(`${k} must be zero or a positive number.`);
  }
  return [...new Set(errors)];
}
