// OCPP gateway: accepts charger WebSocket connections at /ocpp/<charge point identity>.
//
// A connection is accepted only if the identity is a registered charger, the charger offers
// the "ocpp1.6" subprotocol, and (when required) it presents its key with HTTP Basic auth.
// Unknown chargers are never registered automatically.
//
// Adding OCPP 2.0.1 later means: accept the "ocpp2.0.1" subprotocol here and route its
// messages to a second set of handlers in the engine. The framing in rpc.js is already shared.
import { WebSocketServer } from 'ws';
import { RpcPeer, RpcError } from './rpc.js';

const PROTOCOL = 'ocpp1.6';

// What the engine uses to reach chargers. Created first; the gateway fills in the peers.
export function createTransport() {
  const peers = new Map();
  return {
    peers,
    isConnected: (identity) => peers.has(identity),
    call(identity, action, payload, timeoutMs) {
      const peer = peers.get(identity);
      if (!peer) return Promise.reject(new RpcError('DISCONNECTED', 'Charger is not connected'));
      return peer.rpc.call(action, payload, timeoutMs);
    },
    disconnect(identity, reason = 'closed by central system') {
      const peer = peers.get(identity);
      if (peer) peer.ws.close(1000, reason.slice(0, 100));
    },
  };
}

function refuse(socket, status, text, extra = '') {
  socket.write(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function basicPassword(header, identity) {
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0 || decoded.slice(0, i) !== identity) return null;
  return decoded.slice(i + 1);
}

export function createGateway({ core, transport, requireAuth, pathPrefix = '/ocpp/', pingIntervalMs = 30000, log = () => {} }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });
  const lastRefusal = new Map();

  async function noteRefusal(identity, reason, remote) {
    const key = `${identity}|${reason}`;
    if (Date.now() - (lastRefusal.get(key) || 0) < 10 * 60000) return; // at most one alert per 10 minutes
    lastRefusal.set(key, Date.now());
    if (lastRefusal.size > 500) lastRefusal.clear();
    await core.ocpp.rejected(identity, reason, remote).catch((e) => log('could not record refusal', e));
  }

  // Returns false when the request is not for this gateway, so other upgrade handlers can take it.
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(pathPrefix)) return false;
    let identity;
    try { identity = decodeURIComponent(url.pathname.slice(pathPrefix.length)); } catch { identity = ''; }
    const remote = req.socket.remoteAddress;
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());

    if (!identity || identity.includes('/') || !core.ocpp.lookup(identity)) {
      noteRefusal(identity || '(empty)', 'identity is not registered', remote);
      refuse(socket, 404, 'Not Found');
    } else if (!offered.includes(PROTOCOL)) {
      noteRefusal(identity, `charger offered subprotocol "${offered.join(', ') || 'none'}", this server speaks ${PROTOCOL}`, remote);
      refuse(socket, 400, 'Bad Request');
    } else if (!core.ocpp.checkKey(identity, basicPassword(req.headers.authorization, identity), requireAuth)) {
      noteRefusal(identity, 'missing or wrong authorisation key', remote);
      refuse(socket, 401, 'Unauthorized', 'WWW-Authenticate: Basic realm="ocpp"\r\n');
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, identity));
    }
    return true;
  }

  function accept(ws, identity) {
    const previous = transport.peers.get(identity);
    const peer = { ws, alive: true, rpc: null };
    peer.rpc = new RpcPeer(ws, { log: (...a) => log(`[${identity}]`, ...a), onCall: (action, payload) => core.ocpp.handle(identity, action, payload) });
    transport.peers.set(identity, peer);
    if (previous) previous.ws.close(1000, 'replaced by a new connection');
    ws.on('pong', () => { peer.alive = true; });
    ws.on('close', () => {
      if (transport.peers.get(identity) !== peer) return; // an older socket closing after being replaced
      transport.peers.delete(identity);
      core.ocpp.disconnected(identity).catch((e) => log('disconnect not recorded', e));
    });
    core.ocpp.connected(identity, previous ? 'reconnected' : 'charger connected').catch((e) => log('connect not recorded', e));
  }

  // Detects dead links that never sent a close frame (power cut, lost SIM signal).
  const pinger = setInterval(() => {
    for (const peer of transport.peers.values()) {
      if (!peer.alive) { peer.ws.terminate(); continue; }
      peer.alive = false;
      try { peer.ws.ping(); } catch { /* socket already gone */ }
    }
  }, pingIntervalMs);
  pinger.unref();

  return {
    handleUpgrade,
    connectedCount: () => transport.peers.size,
    close() {
      clearInterval(pinger);
      for (const peer of transport.peers.values()) peer.ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
