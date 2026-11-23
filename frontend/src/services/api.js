// Data-access layer: the one place that decides where data comes from.
//
//   VITE_API_URL set    -> LIVE: the E-Falcon server (REST + Socket.IO), see live.js
//   VITE_API_URL unset  -> DEMO: the in-browser simulator in src/sim (no server needed)
//
// Pages call `api.<action>(...)` and read state through `useStore()`; both sources expose the
// same actions, the same store shape and the same errors, so no page knows which one is active.
import * as sim from '../sim/engine.js';
import * as live from './live.js';

export const LIVE = Boolean(import.meta.env.VITE_API_URL);
export const DATA_SOURCE = LIVE ? 'live' : 'simulated';

const latency = () => new Promise((resolve) => setTimeout(resolve, 120));
const simApi = new Proxy({}, {
  get: (_, name) => async (...args) => {
    await latency();
    if (typeof sim.actions[name] !== 'function') throw new Error(`Unknown API action: ${String(name)}`);
    return sim.actions[name](...args);
  },
});

const source = LIVE ? live : sim;
export const api = LIVE ? live.api : simApi;
export const subscribe = source.subscribe;
export const getVersion = source.getVersion;
export const getState = () => source.getState();
export const getCurrentUser = () => source.getCurrentUser();
export const onEvent = source.onEvent;
export const getStatus = () => (LIVE ? live.getStatus() : 'ready');
export const getConnection = () => (LIVE ? live.getConnection() : 'live');
export const ocppEndpoint = (ocppId) => (LIVE ? live.ocppEndpoint(ocppId) : `wss://your-server.example/ocpp/${ocppId}`);

export function startDataSource() {
  if (LIVE) live.boot(); else sim.startSimulation();
}
