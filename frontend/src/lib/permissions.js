// Permission catalogue. Roles map to permission lists stored in system settings, so the
// mapping is configurable (Users > Role permissions) and new permissions can be added here.
// The server enforces this catalogue; the check in the dashboard only decides what to show.

export const PERMISSIONS = [
  { key: 'chargers.manage', label: 'Register and edit chargers', group: 'Network' },
  { key: 'chargers.delete', label: 'Delete chargers', group: 'Network' },
  { key: 'locations.manage', label: 'Manage locations', group: 'Network' },
  { key: 'groups.manage', label: 'Manage charger groups', group: 'Network' },
  { key: 'availability.manage', label: 'Enable / restrict connectors', group: 'Operations' },
  { key: 'commands.remote', label: 'Remote start / stop / reset', group: 'Operations' },
  { key: 'pricing.manage', label: 'Change pricing', group: 'Operations' },
  { key: 'limits.manage', label: 'Change the operational limit', group: 'Operations' },
  { key: 'limits.override', label: 'Override the limit (warn policy only)', group: 'Operations' },
  { key: 'bulk.execute', label: 'Execute bulk operations', group: 'Operations' },
  { key: 'alerts.manage', label: 'Acknowledge / resolve alerts', group: 'Monitoring' },
  { key: 'reports.view', label: 'View reports', group: 'Monitoring' },
  { key: 'users.manage', label: 'Manage users and permissions', group: 'Administration' },
  { key: 'audit.view', label: 'View audit log', group: 'Administration' },
  { key: 'settings.manage', label: 'Manage system settings', group: 'Administration' },
];

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);

export const ROLES = [
  { key: 'admin', label: 'Admin' },
  { key: 'operator', label: 'Operator' },
  { key: 'viewer', label: 'Viewer' },
];

export const DEFAULT_ROLE_PERMISSIONS = {
  admin: [...ALL_PERMISSIONS],
  operator: ['availability.manage', 'commands.remote', 'pricing.manage', 'bulk.execute', 'alerts.manage', 'reports.view'],
  viewer: ['reports.view'],
};

// Admin always has every permission; this cannot be edited away.
export function hasPerm(rolePermissions, role, perm) {
  if (role === 'admin') return true;
  return Boolean(rolePermissions && rolePermissions[role] && rolePermissions[role].includes(perm));
}
