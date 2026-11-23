// Data-access layer. Pages call `api.<action>(...)` and read state through `useStore()`;
// everything comes from the E-Falcon server (REST + Socket.IO, see live.js). There is no
// simulated data in the dashboard: if the server cannot be reached, it says so.
import * as live from './live.js';

export const API_URL = live.BASE;
export const DATA_SOURCE = 'server';
export const api = live.api;
export const subscribe = live.subscribe;
export const getVersion = live.getVersion;
export const getState = live.getState;
export const getCurrentUser = live.getCurrentUser;
export const onEvent = live.onEvent;
export const getStatus = live.getStatus;
export const getConnection = live.getConnection;
export const ocppEndpoint = live.ocppEndpoint;
export const startDataSource = live.boot;
