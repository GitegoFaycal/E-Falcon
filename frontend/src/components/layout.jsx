import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard, Zap, PlugZap, MapPin, Layers, Tag, Gauge, Terminal, History, Bell, BarChart3,
  Users, ScrollText, Settings, Search, Menu, X, LogOut, FlaskConical,
} from 'lucide-react';
import { api, LIVE } from '../services/api.js';
import { useStore, useAuth, useAction } from '../context/store.jsx';
import { ErrorBoundary } from './ui.jsx';

const NAV = [
  { section: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    section: 'Network',
    items: [
      { to: '/chargers', label: 'Chargers', icon: Zap },
      { to: '/connectors', label: 'Connectors', icon: PlugZap },
      { to: '/locations', label: 'Locations', icon: MapPin },
      { to: '/groups', label: 'Groups', icon: Layers },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/pricing', label: 'Pricing', icon: Tag },
      { to: '/limits', label: 'Operational limit', icon: Gauge },
      { to: '/commands', label: 'Commands', icon: Terminal },
    ],
  },
  {
    section: 'Monitoring',
    items: [
      { to: '/sessions', label: 'Sessions', icon: History },
      { to: '/alerts', label: 'Alerts', icon: Bell, badge: 'alerts' },
      { to: '/reports', label: 'Reports', icon: BarChart3, perm: 'reports.view' },
    ],
  },
  {
    section: 'Administration',
    items: [
      { to: '/users', label: 'Users', icon: Users, perm: 'users.manage' },
      { to: '/audit', label: 'Audit log', icon: ScrollText, perm: 'audit.view' },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

function Sidebar({ onNavigate }) {
  const state = useStore();
  const { can } = useAuth();
  const openAlerts = state.alerts.filter((a) => a.status === 'open').length;
  return (
    <div className="flex h-full w-64 flex-col bg-slate-900 text-slate-300">
      <div className="flex h-14 items-center gap-2.5 border-b border-slate-800 px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600"><Zap className="h-4 w-4 text-white" /></span>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">{state.settings.orgName}</p>
          <p className="text-[11px] text-slate-400">Charging management</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <div key={group.section} className="mb-4">
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{group.section}</p>
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) => `flex items-center gap-2.5 rounded-md px-2 py-2 text-sm ${isActive ? 'bg-slate-800 font-medium text-white' : 'hover:bg-slate-800/60 hover:text-white'}`}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {item.badge === 'alerts' && openAlerts > 0 ? <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">{openAlerts}</span> : null}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-slate-800 px-4 py-3 text-[11px] text-slate-500">{LIVE ? `${state.chargers.filter((c) => c.online).length} of ${state.chargers.length} chargers connected` : 'Demo mode · simulated data'}</div>
    </div>
  );
}

function GlobalSearch() {
  const state = useStore();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const hits = term
    ? state.chargers.filter((c) => [c.name, c.ocppId, c.serial].some((v) => String(v).toLowerCase().includes(term))).slice(0, 6)
    : [];
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
      <input
        className="input pl-8"
        placeholder="Find a charger by name, OCPP ID or serial"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { navigate(`/chargers/${hits[0].id}`); setQ(''); } if (e.key === 'Escape') setQ(''); }}
        aria-label="Search chargers"
      />
      {term ? (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
          {hits.length ? hits.map((c) => (
            <button key={c.id} type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { navigate(`/chargers/${c.id}`); setQ(''); }}>
              <span className="font-medium text-slate-900">{c.name}</span>
              <span className="text-xs text-slate-500">{c.ocppId}</span>
            </button>
          )) : <p className="px-3 py-2 text-sm text-slate-500">No charger matches “{q}”.</p>}
        </div>
      ) : null}
    </div>
  );
}

export function AppLayout() {
  const state = useStore();
  const { user, connection } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [run] = useAction();
  const openAlerts = state.alerts.filter((a) => a.status === 'open').length;

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden lg:block"><Sidebar /></aside>
      {menuOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <Sidebar onNavigate={() => setMenuOpen(false)} />
          <button type="button" className="flex-1 bg-slate-900/50" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X className="absolute right-4 top-4 h-6 w-6 text-white" /></button>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <button type="button" className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="hidden flex-1 sm:block"><GlobalSearch /></div>
          <div className="flex flex-1 items-center justify-end gap-3 sm:flex-none">
            <span className="hidden items-center gap-1.5 text-xs text-slate-500 md:flex" title="Updates arrive as events, not by polling">
              {connection === 'live'
                ? <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-green-600" /></span>
                : <span className="h-2 w-2 rounded-full bg-amber-500" />}
              {connection === 'live' ? 'Live' : 'Reconnecting'}
            </span>
            <Link to="/alerts" className="relative rounded p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`${openAlerts} open alerts`}>
              <Bell className="h-5 w-5" />
              {openAlerts > 0 ? <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{openAlerts}</span> : null}
            </Link>
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium text-slate-900">{user.name}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{user.role}</p>
            </div>
            <button type="button" className="rounded p-1.5 text-slate-600 hover:bg-slate-100" onClick={() => run(() => api.logout())} aria-label="Sign out" title="Sign out"><LogOut className="h-5 w-5" /></button>
          </div>
        </header>

        {!LIVE ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
            <FlaskConical className="h-3.5 w-3.5 shrink-0" />
            <span><strong>Demo mode: simulated data.</strong> No server and no physical charger is connected. Everything on every page comes from the built-in simulator.</span>
          </div>
        ) : connection !== 'live' ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900" role="status">
            <span><strong>Live updates interrupted.</strong> Reconnecting to the server; the page refreshes every 15 seconds meanwhile, so what you see may be slightly behind.</span>
          </div>
        ) : null}

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
            <ErrorBoundary key={location.pathname}><Outlet /></ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
