import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { useAuth } from './context/store.jsx';
import { AppLayout } from './components/layout.jsx';
import { EmptyState } from './components/ui.jsx';
import { ShieldCheck } from 'lucide-react';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Chargers from './pages/Chargers.jsx';
import ChargerDetail from './pages/ChargerDetail.jsx';
import Connectors from './pages/Connectors.jsx';
import Locations from './pages/Locations.jsx';
import Groups from './pages/Groups.jsx';
import Pricing from './pages/Pricing.jsx';
import Limits from './pages/Limits.jsx';
import Commands from './pages/Commands.jsx';
import Sessions from './pages/Sessions.jsx';
import Alerts from './pages/Alerts.jsx';
import Reports from './pages/Reports.jsx';
import UsersPage from './pages/Users.jsx';
import AuditLog from './pages/AuditLog.jsx';
import SettingsPage from './pages/Settings.jsx';

function Guard({ perm, children }) {
  const { can } = useAuth();
  if (can(perm)) return children;
  return <EmptyState icon={ShieldCheck} title="You do not have access to this page" text={`Your role is missing the "${perm}" permission. An admin can change this under Users.`} />;
}

function NotFound() {
  return <EmptyState title="Page not found" text="That address does not exist." action={<Link className="text-sm font-medium text-brand-700 hover:underline" to="/">Back to dashboard</Link>} />;
}

export default function App() {
  const { user, status } = useAuth();
  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-slate-900 text-sm text-slate-300" role="status">Connecting to the E-Falcon server…</div>;
  }
  if (status === 'unconfigured') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 p-6">
        <div className="max-w-md rounded-xl bg-white p-6 text-sm text-slate-700 shadow-xl">
          <h1 className="text-base font-semibold text-slate-900">Server address not configured</h1>
          <p className="mt-2">This dashboard was built without <code>VITE_API_URL</code>, so it does not know where the E-Falcon server is. Set that variable to the server&apos;s address and build again.</p>
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="chargers" element={<Chargers />} />
        <Route path="chargers/:id" element={<ChargerDetail />} />
        <Route path="connectors" element={<Connectors />} />
        <Route path="locations" element={<Locations />} />
        <Route path="groups" element={<Groups />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="limits" element={<Limits />} />
        <Route path="commands" element={<Commands />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="reports" element={<Guard perm="reports.view"><Reports /></Guard>} />
        <Route path="users" element={<Guard perm="users.manage"><UsersPage /></Guard>} />
        <Route path="audit" element={<Guard perm="audit.view"><AuditLog /></Guard>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
