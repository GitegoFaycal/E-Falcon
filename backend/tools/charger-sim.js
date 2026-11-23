// DEVELOPMENT TOOL: a simulated dual-gun DC charger that speaks real OCPP 1.6J over a real
// WebSocket to the E-Falcon server. It replaces the in-browser simulator of the first build:
// the server cannot tell it from hardware, so it exercises the same code paths a physical
// charger will. It is NOT a model of any particular manufacturer's firmware.
//
//   npm run charger-sim -- --url ws://localhost:4000/ocpp --ids EF-SIM-001,EF-SIM-002 --auto
//   options: --key <ocpp key>   --connectors 2   --power 120   --meter-interval 5   --auto
import { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { RpcPeer, RpcError } from '../src/ocpp/rpc.js';

export function createSimCharger({
  url, identity, key = null, connectors = 2, powerKw = 120, meterIntervalMs = 5000, reconnectMs = 3000,
  tariffVendorId = 'EFalconSim', unsupported = [], vendor = 'SimVendor', model = 'SIM-DC-DUAL', firmware = 'sim-1.0.0', log = () => {},
}) {
  const guns = Array.from({ length: connectors }, (_, i) => ({ id: i + 1, status: 'Available', operative: true, scheduledInoperative: false, tx: null, meterWh: Math.round(1e6 + i * 2.5e5), powerKw: 0 }));
  const sim = { identity, guns, connected: false, silent: false, tariff: null, heartbeatMs: 60000, stopped: false, received: [] };
  let ws = null;
  let rpc = null;
  let heartbeat = null;
  let meter = null;
  let lastMeter = Date.now();

  const call = (action, payload) => (rpc ? rpc.call(action, payload, 15000).catch((e) => { log(`${identity}: ${action} failed: ${e.code}`); return null; }) : Promise.resolve(null));
  const gun = (id) => guns.find((g) => g.id === id);
  const notify = (g, errorCode = 'NoError') => call('StatusNotification', { connectorId: g.id, status: g.status, errorCode, timestamp: new Date().toISOString() });
  const setStatus = (g, status, errorCode) => { g.status = status; return notify(g, errorCode); };

  async function start(g, idTag) {
    if (g.tx || !g.operative || g.status !== 'Available') return false;
    await setStatus(g, 'Preparing');
    const auth = await call('Authorize', { idTag });
    if (!auth || auth.idTagInfo.status !== 'Accepted') { await setStatus(g, 'Available'); return false; }
    const res = await call('StartTransaction', { connectorId: g.id, idTag, meterStart: Math.round(g.meterWh), timestamp: new Date().toISOString() });
    if (!res) { await setStatus(g, 'Available'); return false; }
    g.tx = { id: res.transactionId, idTag };
    g.powerKw = Math.round(powerKw * (0.55 + Math.random() * 0.35) * 10) / 10;
    await setStatus(g, 'Charging');
    return true;
  }

  async function stop(g, reason = 'Local') {
    if (!g.tx) return false;
    const tx = g.tx;
    g.tx = null;
    g.powerKw = 0;
    await call('StopTransaction', { transactionId: tx.id, idTag: tx.idTag, meterStop: Math.round(g.meterWh), timestamp: new Date().toISOString(), reason });
    await setStatus(g, 'Finishing');
    if (g.scheduledInoperative) { g.scheduledInoperative = false; g.operative = false; }
    await setStatus(g, g.operative ? 'Available' : 'Unavailable');
    return true;
  }

  function sampleMeters() {
    const dt = (Date.now() - lastMeter) / 1000;
    lastMeter = Date.now();
    for (const g of guns) {
      if (!g.tx) continue;
      g.meterWh += (g.powerKw * 1000 * dt) / 3600;
      call('MeterValues', {
        connectorId: g.id, transactionId: g.tx.id,
        meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [
          { value: String(Math.round(g.meterWh)), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: 'Sample.Periodic' },
          { value: String(Math.round(g.powerKw * 1000)), measurand: 'Power.Active.Import', unit: 'W', context: 'Sample.Periodic' },
        ] }],
      });
    }
  }

  const handlers = {
    ChangeAvailability({ connectorId, type }) {
      const targets = connectorId === 0 ? guns : [gun(connectorId)].filter(Boolean);
      if (!targets.length) return { status: 'Rejected' };
      let scheduled = false;
      for (const g of targets) {
        if (type === 'Inoperative' && g.tx) { g.scheduledInoperative = true; scheduled = true; continue; }
        g.operative = type === 'Operative';
        g.scheduledInoperative = false;
        if (!g.tx && g.status !== 'Faulted') setTimeout(() => setStatus(g, g.operative ? 'Available' : 'Unavailable'), 50);
      }
      return { status: scheduled ? 'Scheduled' : 'Accepted' };
    },
    RemoteStartTransaction({ connectorId, idTag }) {
      const g = connectorId ? gun(connectorId) : guns.find((x) => x.operative && x.status === 'Available');
      if (!g || !g.operative || g.status !== 'Available') return { status: 'Rejected' };
      setTimeout(() => start(g, idTag), 100);
      return { status: 'Accepted' };
    },
    RemoteStopTransaction({ transactionId }) {
      const g = guns.find((x) => x.tx && x.tx.id === transactionId);
      if (!g) return { status: 'Rejected' };
      setTimeout(() => stop(g, 'Remote'), 100);
      return { status: 'Accepted' };
    },
    Reset() {
      setTimeout(async () => { for (const g of guns) await stop(g, 'SoftReset'); if (ws) ws.close(1000, 'reset'); }, 100);
      return { status: 'Accepted' };
    },
    GetConfiguration() {
      return { configurationKey: [
        { key: 'HeartbeatInterval', readonly: false, value: String(sim.heartbeatMs / 1000) },
        { key: 'MeterValueSampleInterval', readonly: false, value: String(meterIntervalMs / 1000) },
        { key: 'NumberOfConnectors', readonly: true, value: String(guns.length) },
        { key: 'SupportedFeatureProfiles', readonly: true, value: 'Core' },
      ] };
    },
    DataTransfer({ vendorId, data }) {
      if (vendorId !== tariffVendorId) return { status: 'UnknownVendorId' };
      try { sim.tariff = JSON.parse(data); } catch { return { status: 'Rejected' }; }
      return { status: 'Accepted' };
    },
  };

  function connect() {
    if (sim.stopped) return;
    const headers = key ? { Authorization: `Basic ${Buffer.from(`${identity}:${key}`).toString('base64')}` } : {};
    ws = new WebSocket(`${url.replace(/\/$/, '')}/${encodeURIComponent(identity)}`, ['ocpp1.6'], { headers });
    ws.on('unexpected-response', (_req, res) => { log(`${identity}: server refused the connection (HTTP ${res.statusCode})`); sim.refused = res.statusCode; });
    ws.on('error', (e) => log(`${identity}: ${e.message}`));
    ws.on('open', async () => {
      sim.connected = true;
      rpc = new RpcPeer(ws, {
        onCall: (action, payload) => {
          sim.received.push(action);
          if (sim.silent) return new Promise(() => {}); // simulates a reply lost on the way
          if (!handlers[action] || unsupported.includes(action)) throw new RpcError('NotImplemented', `${action} is not implemented by this simulator`);
          return handlers[action](payload);
        },
      });
      const boot = await call('BootNotification', { chargePointVendor: vendor, chargePointModel: model, chargePointSerialNumber: `SIM-${identity}`, firmwareVersion: firmware });
      if (boot && boot.interval) sim.heartbeatMs = boot.interval * 1000;
      await call('StatusNotification', { connectorId: 0, status: 'Available', errorCode: 'NoError', timestamp: new Date().toISOString() });
      for (const g of guns) await notify(g);
      clearInterval(heartbeat); heartbeat = setInterval(() => call('Heartbeat', {}), sim.heartbeatMs);
      lastMeter = Date.now();
      clearInterval(meter); meter = setInterval(sampleMeters, meterIntervalMs);
      sim.ready = true;
      log(`${identity}: connected and booted`);
    });
    ws.on('close', () => {
      sim.connected = false; sim.ready = false; rpc = null;
      clearInterval(heartbeat); clearInterval(meter);
      if (!sim.stopped && reconnectMs > 0) setTimeout(connect, reconnectMs);
    });
  }

  Object.assign(sim, {
    connect,
    plug: (connectorId, idTag = `SIMTAG${1000 + Math.floor(Math.random() * 9000)}`) => start(gun(connectorId), idTag),
    unplug: (connectorId) => stop(gun(connectorId), 'EVDisconnected'),
    sampleMeters,
    fault: (connectorId, errorCode = 'GroundFailure') => setStatus(gun(connectorId), 'Faulted', errorCode),
    clearFault: (connectorId) => { const g = gun(connectorId); return setStatus(g, g.tx ? 'Charging' : g.operative ? 'Available' : 'Unavailable'); },
    drop: () => { if (ws) ws.terminate(); },
    stop: () => { sim.stopped = true; clearInterval(heartbeat); clearInterval(meter); if (ws) ws.close(1000, 'simulator stopped'); },
  });
  return sim;
}

/* ------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const url = opt('url', 'ws://localhost:4000/ocpp');
  const ids = String(opt('ids', 'EF-SIM-001')).split(',').map((s) => s.trim()).filter(Boolean);
  const auto = args.includes('--auto');
  const sims = ids.map((identity) => {
    const sim = createSimCharger({ url, identity, key: opt('key', null), connectors: Number(opt('connectors', 2)), powerKw: Number(opt('power', 120)), meterIntervalMs: Number(opt('meter-interval', 5)) * 1000, log: console.log });
    sim.connect();
    return sim;
  });
  console.log(`Simulating ${ids.length} charger(s) against ${url}${auto ? ', with random sessions' : ''}. Ctrl+C to stop.`);
  if (auto) {
    setInterval(() => {
      for (const sim of sims) {
        if (!sim.ready) continue;
        for (const g of sim.guns) {
          if (g.tx && Math.random() < 0.04) sim.unplug(g.id);
          else if (!g.tx && g.operative && g.status === 'Available' && Math.random() < 0.08) sim.plug(g.id);
        }
      }
    }, 5000);
  }
  process.on('SIGINT', () => { sims.forEach((s) => s.stop()); setTimeout(() => process.exit(0), 300); });
}
