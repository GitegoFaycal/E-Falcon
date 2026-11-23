// Shared presentational building blocks. No data access in this file.
import { Component, useEffect, useState } from 'react';
import { Loader2, X, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';
import { STATES, COMMAND_STATUS, CAPABILITY, DEPLOY_STAGE, SEVERITY } from '../lib/status.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');

const BTN = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 border-transparent',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300',
  danger: 'bg-red-600 text-white hover:bg-red-700 border-transparent',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent',
};

export function Button({ variant = 'secondary', size = 'md', icon: Icon, busy = false, disabled, className, children, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'ghost' && 'shadow-none',
        BTN[variant], className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> : null}
      {children}
    </button>
  );
}

export function Card({ className, children }) {
  return <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>{children}</section>;
}

export function CardHeader({ title, subtitle, action }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Pill({ className, children, title }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ state }) {
  const s = STATES[state] || STATES.offline;
  return <Pill className={s.badge}><span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />{s.label}</Pill>;
}

export function CommandBadge({ status }) {
  const s = COMMAND_STATUS[status] || COMMAND_STATUS.pending;
  return <Pill className={s.badge}>{['pending', 'sent', 'acknowledged'].includes(status) ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{s.label}</Pill>;
}

export function CapabilityBadge({ value }) {
  const s = CAPABILITY[value] || CAPABILITY.unverified;
  return <Pill className={s.badge}>{s.label}</Pill>;
}

export function StageBadge({ stage }) {
  const s = DEPLOY_STAGE[stage] || DEPLOY_STAGE.stored;
  return <Pill className={s.badge}>{s.label}</Pill>;
}

export function SeverityBadge({ severity }) {
  const s = SEVERITY[severity] || SEVERITY.info;
  return <Pill className={s.badge}>{s.label}</Pill>;
}

export function Tone({ tone = 'gray', children }) {
  const map = {
    gray: 'bg-slate-100 text-slate-700 ring-slate-500/20',
    green: 'bg-green-50 text-green-800 ring-green-600/20',
    blue: 'bg-blue-50 text-blue-800 ring-blue-600/20',
    amber: 'bg-amber-50 text-amber-900 ring-amber-600/30',
    red: 'bg-red-50 text-red-800 ring-red-600/20',
  };
  return <Pill className={map[tone]}>{children}</Pill>;
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'text-slate-400' }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {Icon ? <Icon className={cx('h-4 w-4 shrink-0', tone)} /> : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {sub ? <p className="mt-1 text-xs text-slate-500">{sub}</p> : null}
    </Card>
  );
}

export function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon ? <Icon className="h-8 w-8 text-slate-300" /> : null}
      <p className="mt-3 text-sm font-medium text-slate-900">{title}</p>
      {text ? <p className="mt-1 max-w-md text-sm text-slate-500">{text}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({ tone = 'amber', icon: Icon = AlertTriangle, title, children, action }) {
  const map = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-900',
    blue: 'border-blue-200 bg-blue-50 text-blue-900',
    gray: 'border-slate-200 bg-slate-50 text-slate-700',
  };
  return (
    <div className={cx('flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3 text-sm', map[tone])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={title ? 'mt-0.5' : ''}>{children}</div>
      </div>
      {action}
    </div>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Select({ value, onChange, options, className, ...rest }) {
  return (
    <select className={cx('input', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Modal({ open, onClose, title, subtitle, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('flex max-h-[92vh] w-full flex-col rounded-t-xl bg-white shadow-xl sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3 sm:rounded-b-xl">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', danger = false, busy = false }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>{confirmLabel}</Button>
        </>
      )}
    >
      <div className="space-y-3 text-sm text-slate-700">{children}</div>
    </Modal>
  );
}

export function usePaged(items, pageSize = 12) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return { page: current, pages, setPage, total: items.length, rows: items.slice((current - 1) * pageSize, current * pageSize) };
}

export function Pagination({ page, pages, total, setPage, noun = 'rows' }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
      <span>{total} {noun}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page" />
        <span>Page {page} of {pages}</span>
        <Button size="sm" variant="ghost" icon={ChevronRight} disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}
        >
          {t.label}{t.count !== undefined ? <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TableWrap({ children }) {
  return <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-100">{children}</table></div>;
}

export function Checkbox({ checked, onChange, label, disabled }) {
  return (
    <input type="checkbox" aria-label={label} disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
  );
}

export function KeyValue({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="mt-0.5 break-words text-sm text-slate-900">{v === null || v === undefined || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ui]', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-6">
        <Notice tone="red" title="This page failed to render">
          <p>{String(this.state.error.message || this.state.error)}</p>
          <button type="button" className="mt-2 font-medium underline" onClick={() => this.setState({ error: null })}>Try again</button>
        </Notice>
      </div>
    );
  }
}
