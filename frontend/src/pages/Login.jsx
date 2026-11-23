import { useState } from 'react';
import { Zap } from 'lucide-react';
import { api } from '../services/api.js';
import { useStore, useAction } from '../context/store.jsx';
import { Button, Field } from '../components/ui.jsx';

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
        <PasswordForm />
      </div>
    </div>
  );
}
