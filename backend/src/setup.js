// First-run helpers: creating the first administrator and (development only) demo records.
import { hashPassword } from './core/secrets.js';

// Creates an admin account directly. Used by tools/create-admin.js and tools/seed.js; there is
// no default account and no default password anywhere in the system.
export async function createAdmin(core, { name, email, password }) {
  const address = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('A valid email address is required.');
  if (String(password || '').length < 10) throw new Error('The password must be at least 10 characters.');
  if (core.findUserByEmail(address)) throw new Error(`A user with email ${address} already exists.`);
  const state = core.state;
  state.seq.usr = (state.seq.usr || 0) + 1;
  const user = { id: `USR-${String(state.seq.usr).padStart(4, '0')}`, name: String(name || 'Administrator').trim(), email: address, role: 'admin', active: true, passwordHash: hashPassword(password), createdAt: Date.now(), lastLoginAt: null };
  state.users.push(user);
  await core.flush();
  return user;
}

// Development records so the dashboard is not empty: locations, groups, tariffs and three
// registered chargers whose identities match the charger simulator (EF-SIM-001..003).
export async function seedDemo(core, admin) {
  if (core.state.locations.length) return false;
  const call = (name, ...args) => core.call(admin, name, args);
  const hub = await call('saveLocation', { name: 'Kigali CBD Hub', address: 'KN 4 Ave', city: 'Kigali' });
  const plaza = await call('saveLocation', { name: 'Kimihurura Plaza', address: 'KG 28 Ave', city: 'Kigali' });
  const period = (start, energyPrice, servicePrice, kind) => ({ start, energyPrice, servicePrice, kind });
  const { rule: standard } = await call('saveRule', { name: 'Standard', description: 'Network default tariff', periods: [period('00:00', 380, 60, 'offpeak'), period('06:00', 420, 60, 'standard'), period('12:00', 420, 60, 'standard'), period('16:00', 480, 60, 'peak')], flatFee: 0, hourPrice: 0, preauthAmount: 5000 });
  await call('saveRule', { name: 'Flat', description: 'Single price all day', periods: [period('00:00', 450, 80, 'standard')], flatFee: 500, hourPrice: 0, preauthAmount: 5000 });
  await call('assignPricing', { ruleId: standard.id, scope: 'global' });
  const ids = [];
  for (const [ocppId, name, loc] of [['EF-SIM-001', 'CBD Hub 01', hub], ['EF-SIM-002', 'CBD Hub 02', hub], ['EF-SIM-003', 'Kimihurura 01', plaza]]) {
    ids.push((await call('createCharger', { name, ocppId, locationId: loc.id, manufacturer: '', model: '', serial: '', connectorCount: 2, ratedPowerKw: 120 })).id);
  }
  await call('saveGroup', { name: 'Kigali City', description: 'All chargers inside Kigali', chargerIds: ids });
  await call('setOperationalLimit', { maxEnabledConnectors: 5, policy: 'block' });
  return true;
}
