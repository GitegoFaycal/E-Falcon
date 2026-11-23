// Formatting helpers. Pure functions, no state.

export function fmtNumber(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(n, currency = 'RWF') {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${currency} ${fmtNumber(Math.round(n))}`;
}

export const fmtKwh = (n, digits = 1) => (n === null || n === undefined ? '—' : `${fmtNumber(n, digits)} kWh`);
export const fmtKw = (n) => (n === null || n === undefined ? '—' : `${fmtNumber(n, 1)} kW`);

export function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTimeFull(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${Math.floor(ms / 1000)} s`;
}

// Local-time calendar key, e.g. "2026-11-23".
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shortDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Value for <input type="datetime-local"> in local time.
export function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
