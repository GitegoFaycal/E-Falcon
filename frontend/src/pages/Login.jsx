import { useState } from 'react';
import { Zap, FlaskConical, ChevronRight } from 'lucide-react';
import { api, LIVE } from '../services/api.js';
import { useStore, useAction } from '../context/store.jsx';
import { Button, Field } from '../components/ui.jsx';

const ROLE_NOTE = {
  admin: 'Full access, including users, limits, settings and audit log',
  operator: 'Monitoring, availability, pricing and remote commands',
  viewer: 'Read-only monitoring and reports',
};

function PasswordForm() {
  const [run, busy] = useAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = (e) => { e.preventDefault(); run(() => api.login(email, password)); };
  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <Field label="Email"><input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></Field>
      <Field label="Password"><input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
      <Button variant="primary" type="submit" busy={busy} className="w-full">Sign in</Button>
      <p className="text-xs text-slate-500">Accounts are created by an administrator. There is no self-registration and no default account.</p>
    </form>
  );
}

function DemoAccounts() {
  const state = useStore();
  const [run, busy] = useAction();
  return (
    <>
      <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
        <p><strong>Demo mode.</strong> This build is not connected to a server, so there are no passwords: choose a demo account to explore with that role. Set <code>VITE_API_URL</code> to use the real server with real sign-in.</p>
      </div>
      <ul className="mt-4 space-y-2">
        {state.users.filter((u) => u.active).map((u) => (
          <li key={u.id}>
            <button type="button" disabled={busy} onClick={() => run(() => api.login(u.id))} className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3 text-left hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50">
              <span>
                <span className="block text-sm font-medium text-slate-900">{u.name} <span className="ml-1 text-xs font-normal uppercase tracking-wide text-slate-500">{u.role}</span></span>
                <span className="block text-xs text-slate-500">{ROLE_NOTE[u.role]}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function Login() {
  const state = useStore();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600"><Zap className="h-5 w-5 text-white" /></span>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{state.settings.orgName} CMS</h1>
            <p className="text-sm text-slate-500">EV charging management</p>
          </div>
        </div>
        {LIVE ? <PasswordForm /> : <DemoAccounts />}
      </div>
    </div>
  );
}
