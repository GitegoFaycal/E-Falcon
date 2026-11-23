// Real-time hub: pushes every persisted change to signed-in dashboards over Socket.IO.
// One event, "patch": { rows: { table: [row, ...] }, removed: { table: [id, ...] }, settings }.
// Each user only receives the tables they are allowed to see.
import { Server } from 'socket.io';
import { canSee, publicRow } from '../core/index.js';

export function createHub({ httpServer, core, auth, config }) {
  const io = new Server(httpServer, { cors: { origin: config.corsOrigins, credentials: true }, destroyUpgrade: false, serveClient: false });

  io.use((socket, next) => {
    const user = auth.verifyAccess(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    return next();
  });

  core.onPatch((patch) => {
    for (const socket of io.sockets.sockets.values()) {
      const user = core.findUser(socket.data.userId);
      if (!user || !user.active) { socket.disconnect(true); continue; }
      const out = { rows: {}, removed: {}, settings: patch.settings };
      for (const [key, rows] of Object.entries(patch.rows)) {
        if (canSee(core.state.settings, user, key)) out.rows[key] = rows;
        else if (key === 'users') { const mine = rows.filter((r) => r.id === user.id); if (mine.length) out.rows.users = mine.map((r) => publicRow('users', r)); }
      }
      for (const [key, ids] of Object.entries(patch.removed)) if (canSee(core.state.settings, user, key)) out.removed[key] = ids;
      // Permission changes alter what a user may see: have clients reload their snapshot.
      if (patch.settings) socket.emit('resync');
      if (Object.keys(out.rows).length || Object.keys(out.removed).length || out.settings) socket.emit('patch', out);
    }
  });

  return { io, close: () => io.close() };
}
