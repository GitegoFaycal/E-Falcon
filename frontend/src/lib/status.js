// Status vocabulary and derivation. One place decides what a connector "is" for display,
// so every page and every counter agrees.
//
// Two independent facts are tracked per connector:
//   enabled  - the administrative state this CMS has had CONFIRMED by the charger
//              (counts against the operational limit)
//   status   - the last OCPP StatusNotification value reported by the charger
// The display state below is derived from those plus charger connectivity.

export const STATES = {
  available: { label: 'Available', dot: 'bg-green-600', badge: 'bg-green-50 text-green-800 ring-green-600/20', hex: '#0ca30c' },
  charging: { label: 'Charging', dot: 'bg-blue-600', badge: 'bg-blue-50 text-blue-800 ring-blue-600/20', hex: '#2a78d6' },
  occupied: { label: 'Occupied', dot: 'bg-violet-600', badge: 'bg-violet-50 text-violet-800 ring-violet-600/20', hex: '#6250d6' },
  reserved: { label: 'Reserved', dot: 'bg-pink-500', badge: 'bg-pink-50 text-pink-800 ring-pink-600/20', hex: '#e87ba4' },
  unavailable: { label: 'Restricted', dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-900 ring-amber-600/30', hex: '#eda100' },
  maintenance: { label: 'Maintenance', dot: 'bg-orange-600', badge: 'bg-orange-50 text-orange-900 ring-orange-600/30', hex: '#eb6834' },
  faulted: { label: 'Faulted', dot: 'bg-red-600', badge: 'bg-red-50 text-red-800 ring-red-600/20', hex: '#d03b3b' },
  offline: { label: 'Offline', dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20', hex: '#898781' },
};

export const STATE_ORDER = ['charging', 'available', 'occupied', 'reserved', 'unavailable', 'maintenance', 'faulted', 'offline'];

const OCCUPIED = ['Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];

export function connectorState(connector, charger) {
  if (!charger || !charger.online) return 'offline';
  if (connector.status === 'Faulted') return 'faulted';
  if (connector.status === 'Charging') return 'charging';
  if (OCCUPIED.includes(connector.status)) return 'occupied';
  if (connector.maintenance) return 'maintenance';
  if (connector.status === 'Reserved') return 'reserved';
  if (connector.status === 'Unavailable' || !connector.enabled) return 'unavailable';
  return 'available';
}

export function chargerState(charger, connectors) {
  if (!charger.online) return 'offline';
  const states = connectors.map((c) => connectorState(c, charger));
  if (states.includes('faulted')) return 'faulted';
  if (states.includes('charging')) return 'charging';
  if (states.includes('available')) return 'available';
  if (states.includes('occupied')) return 'occupied';
  if (states.length && states.every((s) => s === 'maintenance')) return 'maintenance';
  return 'unavailable';
}

export const COMMAND_STATUS = {
  pending: { label: 'Pending', badge: 'bg-violet-50 text-violet-800 ring-violet-600/20' },
  sent: { label: 'Sent', badge: 'bg-blue-50 text-blue-800 ring-blue-600/20' },
  acknowledged: { label: 'Acknowledged', badge: 'bg-blue-50 text-blue-800 ring-blue-600/20' },
  successful: { label: 'Successful', badge: 'bg-green-50 text-green-800 ring-green-600/20' },
  failed: { label: 'Failed', badge: 'bg-red-50 text-red-800 ring-red-600/20' },
  timed_out: { label: 'Timed out', badge: 'bg-red-50 text-red-800 ring-red-600/20' },
  cancelled: { label: 'Cancelled', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
};

export const ACTIVE_COMMAND_STATUSES = ['pending', 'sent', 'acknowledged'];

export const CAPABILITY = {
  verified: { label: 'Verified', badge: 'bg-green-50 text-green-800 ring-green-600/20' },
  unverified: { label: 'Not verified', badge: 'bg-amber-50 text-amber-900 ring-amber-600/30' },
  unsupported: { label: 'Not supported', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
};

export const CAPABILITY_KEYS = [
  { key: 'changeAvailability', label: 'ChangeAvailability', hint: 'Enable / restrict connectors (OCPP 1.6 Core)' },
  { key: 'remoteStartStop', label: 'RemoteStart / RemoteStop', hint: 'Remote session control (OCPP 1.6 Core)' },
  { key: 'configuration', label: 'Get / ChangeConfiguration', hint: 'Read and write configuration keys (OCPP 1.6 Core)' },
  { key: 'reset', label: 'Reset', hint: 'Soft reset (OCPP 1.6 Core)' },
  { key: 'smartCharging', label: 'SetChargingProfile', hint: 'Power limits (OCPP 1.6 Smart Charging profile, optional)' },
  { key: 'tariffSync', label: 'Tariff push', hint: 'Vendor-specific. Not part of standard OCPP 1.6.' },
];

// Pricing deployment stages: what we actually know about a tariff on a charger.
export const DEPLOY_STAGE = {
  stored: { label: 'Stored in CMS', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
  sent: { label: 'Sent to charger', badge: 'bg-blue-50 text-blue-800 ring-blue-600/20' },
  confirmed: { label: 'Confirmed by charger', badge: 'bg-green-50 text-green-800 ring-green-600/20' },
  failed: { label: 'Push failed', badge: 'bg-red-50 text-red-800 ring-red-600/20' },
  offline: { label: 'Not sent (offline)', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
  not_supported: { label: 'Not supported', badge: 'bg-amber-50 text-amber-900 ring-amber-600/30' },
  cms_only: { label: 'CMS billing only', badge: 'bg-amber-50 text-amber-900 ring-amber-600/30' },
};

export const ALERT_TYPES = {
  charger_offline: 'Charger offline',
  connection_recovered: 'Connection recovered',
  connector_fault: 'Connector fault',
  session_failed: 'Session failure',
  ocpp_comm_failure: 'OCPP communication failure',
  command_failed: 'Remote command failed',
  pricing_update_failed: 'Pricing update failed',
  limit_violation: 'Operational limit exceeded',
  abnormal_energy: 'Abnormal energy reading',
  state_mismatch: 'Charger state differs from CMS',
  unknown_charger: 'Unregistered charger tried to connect',
};

export const SEVERITY = {
  critical: { label: 'Critical', badge: 'bg-red-50 text-red-800 ring-red-600/20' },
  warning: { label: 'Warning', badge: 'bg-amber-50 text-amber-900 ring-amber-600/30' },
  info: { label: 'Info', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
};
