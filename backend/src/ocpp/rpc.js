// OCPP-J message framing (the "JSON over WebSocket" layer shared by OCPP 1.6J and 2.0.1):
//   CALL        [2, uniqueId, action, payload]
//   CALLRESULT  [3, uniqueId, payload]
//   CALLERROR   [4, uniqueId, errorCode, errorDescription, errorDetails]
// Used by the gateway (central system side) and by the development charger simulator.
// Version-specific meaning of the actions lives outside this file.
import crypto from 'node:crypto';

export class RpcError extends Error {
  constructor(code, message = '', details = {}) { super(message || code); this.code = code; this.details = details; }
}

export class RpcPeer {
  constructor(ws, { onCall, log = () => {} }) {
    this.ws = ws;
    this.onCall = onCall;
    this.log = log;
    this.pending = new Map();
    this.chain = Promise.resolve(); // OCPP-J allows one outstanding CALL per direction
    this.closed = false;
    ws.on('message', (data, isBinary) => { if (!isBinary) this.receive(data.toString()); });
    ws.on('close', () => this.close());
    ws.on('error', (e) => this.log('socket error', e.message));
  }

  send(frame) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  // Sends a CALL and resolves with the CALLRESULT payload.
  // Rejects with RpcError: TIMEOUT, DISCONNECTED, or the error code the other side returned.
  call(action, payload = {}, timeoutMs = 30000) {
    const run = () => new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== 1) return reject(new RpcError('DISCONNECTED', 'Connection is closed'));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError('TIMEOUT', `No reply to ${action} within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send([2, id, action, payload]);
    });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  receive(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return this.log('dropped a message that is not JSON'); }
    if (!Array.isArray(frame) || typeof frame[1] !== 'string') return this.log('dropped a malformed frame');
    const [type, id] = frame;
    if (type === 2) {
      const [, , action, payload] = frame;
      if (typeof action !== 'string') return this.send([4, id, 'FormationViolation', 'Action must be a string', {}]);
      Promise.resolve()
        .then(() => this.onCall(action, payload ?? {}))
        .then((result) => this.send([3, id, result ?? {}]))
        .catch((e) => {
          if (!(e instanceof RpcError) && !e.code) this.log(`handler for ${action} failed`, e);
          this.send([4, id, typeof e.code === 'string' ? e.code : 'InternalError', e.code ? e.message : 'Internal error', {}]);
        });
    } else if (type === 3 || type === 4) {
      const waiting = this.pending.get(id);
      if (!waiting) return; // late reply to a call that already timed out
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      if (type === 3) waiting.resolve(frame[2] ?? {});
      else waiting.reject(new RpcError(String(frame[2] || 'GenericError'), String(frame[3] || ''), frame[4] || {}));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new RpcError('DISCONNECTED', 'Connection closed before a reply arrived')); }
    this.pending.clear();
  }
}
