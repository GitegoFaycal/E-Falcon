import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { subscribe, getVersion, getState, getCurrentUser, onEvent, getStatus, getConnection } from '../services/api.js';
import { hasPerm } from '../lib/permissions.js';

// Live view of the store. The data layer updates state and bumps a version number;
// subscribing to the version re-renders the caller on every change.
export function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getState();
}

export function useAuth() {
  const state = useStore();
  const user = getCurrentUser();
  const can = (perm) => Boolean(user) && hasPerm(state.settings.rolePermissions, user.role, perm);
  return { user, can, status: getStatus(), connection: getConnection() };
}

/* ------------------------------------------------------------------ toasts */

const ToastContext = createContext(null);

const TOAST_STYLE = {
  success: { icon: CheckCircle2, cls: 'text-green-700' },
  error: { icon: XCircle, cls: 'text-red-700' },
  info: { icon: Info, cls: 'text-slate-600' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind, message) => {
    seq.current += 1;
    const id = seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4500);
  }, [dismiss]);
  const toast = useMemo(() => ({
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  }), [push]);

  // Real-time notifications: critical alerts surface as toasts wherever the operator is.
  useEffect(() => onEvent((ev) => {
    if (ev.type === 'alert' && ev.payload.severity === 'critical') push('error', ev.payload.message);
  }), [push]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => {
          const S = TOAST_STYLE[t.kind];
          return (
            <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
              <S.icon className={`mt-0.5 h-5 w-5 shrink-0 ${S.cls}`} />
              <p className="flex-1 text-sm text-slate-800">{t.message}</p>
              <button type="button" onClick={() => dismiss(t.id)} className="text-slate-400 hover:text-slate-600" aria-label="Dismiss">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

// Runs an API call with a busy flag and turns failures into an error toast.
// Returns undefined when the call failed, so callers can `if (!result) return;`.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { success } = {}) => {
    setBusy(true);
    try {
      const result = await fn();
      if (success) toast.success(typeof success === 'function' ? success(result) : success);
      return result === undefined ? true : result;
    } catch (e) {
      toast.error(e && e.message ? e.message : 'The operation failed.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}
