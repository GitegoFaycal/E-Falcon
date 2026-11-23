import { useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { api, LIVE } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { Button, Card, CardHeader, PageHeader, Modal, Field, Select, TableWrap, Tone, Checkbox, Notice } from '../components/ui.jsx';
import { PERMISSIONS, ROLES, hasPerm } from '../lib/permissions.js';
import { fmtDateTime } from '../lib/format.js';

function UserModal({ open, onClose, user }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', email: '', role: 'viewer', active: true, password: '' });
  useEffect(() => { if (open) setF(user ? { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, password: '' } : { name: '', email: '', role: 'viewer', active: true, password: '' }); }, [open, user]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? e.target.value : e }));
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.saveUser(f), { success: user ? 'User updated.' : 'User created.' });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'New user'}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" busy={busy}>Save</Button>
        </>
      )}
    >
      <form id="user-form" onSubmit={submit} className="space-y-3">
        <Field label="Full name"><input className="input" value={f.name} onChange={set('name')} required maxLength={80} /></Field>
        <Field label="Email"><input type="email" className="input" value={f.email} onChange={set('email')} required maxLength={120} /></Field>
        <Field label="Role"><Select value={f.role} onChange={set('role')} options={ROLES.map((r) => ({ value: r.key, label: r.label }))} /></Field>
        {user ? <label className="flex items-center gap-2 text-sm text-slate-700"><Checkbox checked={f.active} onChange={set('active')} label="Active" />Account is active (deactivated users cannot sign in)</label> : null}
        {LIVE ? (
          <Field label={user ? 'New password (leave empty to keep the current one)' : 'Initial password'} hint="At least 10 characters. Only a salted hash is stored. Setting a new password signs the user out everywhere.">
            <input type="password" className="input" value={f.password} onChange={set('password')} autoComplete="new-password" minLength={10} required={!user} />
          </Field>
        ) : <Notice tone="gray">Demo mode has no passwords. With the server connected, an administrator sets each user&apos;s initial password here.</Notice>}
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const state = useStore();
  const { user: me } = useAuth();
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const rp = state.settings.rolePermissions;
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))];

  const togglePerm = (role, key, on) => {
    const next = on ? [...rp[role], key] : rp[role].filter((k) => k !== key);
    run(() => api.setRolePermissions(role, next));
  };

  return (
    <div>
      <PageHeader title="Users and permissions" subtitle={`${state.users.length} users`} actions={<Button variant="primary" icon={Plus} onClick={() => setModal({})}>New user</Button>} />

      <Card>
        <TableWrap>
          <thead className="bg-slate-50"><tr><th className="th">User</th><th className="th">Role</th><th className="th">Status</th><th className="th">Last sign-in</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {state.users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50">
                <td className="td"><span className="font-medium text-slate-900">{u.name}</span>{u.id === me.id ? <span className="ml-2 text-xs text-slate-500">(you)</span> : null}<p className="text-xs text-slate-500">{u.email}</p></td>
                <td className="td"><Tone tone={u.role === 'admin' ? 'blue' : 'gray'}>{u.role}</Tone></td>
                <td className="td"><Tone tone={u.active ? 'green' : 'gray'}>{u.active ? 'Active' : 'Deactivated'}</Tone></td>
                <td className="td">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
                <td className="td text-right"><Button size="sm" icon={Pencil} onClick={() => setModal(u)}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>

      <Card className="mt-4">
        <CardHeader title="Role permissions" subtitle="Admin always has every permission. Changes apply immediately and are audited." />
        <TableWrap>
          <thead className="bg-slate-50"><tr><th className="th">Permission</th>{ROLES.map((r) => <th key={r.key} className="th text-center">{r.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map((g) => [
              <tr key={g} className="bg-slate-50/60"><td className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500" colSpan={ROLES.length + 1}>{g}</td></tr>,
              ...PERMISSIONS.filter((p) => p.group === g).map((p) => (
                <tr key={p.key}>
                  <td className="td">{p.label}<span className="ml-2 font-mono text-xs text-slate-400">{p.key}</span></td>
                  {ROLES.map((r) => (
                    <td key={r.key} className="td text-center">
                      <Checkbox label={`${r.label}: ${p.label}`} checked={hasPerm(rp, r.key, p.key)} disabled={r.key === 'admin' || busy} onChange={(on) => togglePerm(r.key, p.key, on)} />
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </TableWrap>
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">Everyone who can sign in can view chargers, connectors, sessions, commands and alerts. The permissions above control what they can change.</p>
      </Card>

      <UserModal open={Boolean(modal)} onClose={() => setModal(null)} user={modal && modal.id ? modal : null} />
    </div>
  );
}
