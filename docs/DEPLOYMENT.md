# Deployment

For a first test server and connecting the first physical charger, start with `SERVER_SETUP.md`. This page is the production setup.

## Layout

| Piece | Where | Why |
|---|---|---|
| Dashboard (`frontend/`) | Vercel | Static Vite build |
| Server (`backend/`) | One always-on host: a VPS, Fly.io, Railway or Render | Holds charger WebSockets for days and may need to accept plain `ws://` on a custom port |
| Database | Managed PostgreSQL | Backups and restore handled by the provider |

The server is a single process by design. Do not run two copies against the same database: each would hold different chargers and its own working state.

Use one site for both, for example `app.example.com` (Vercel) and `api.example.com` (server). Sign-in uses an httpOnly cookie; with two unrelated domains some browsers block it.

## Server

1. Node.js 22.13 or newer.
2. Environment (see `backend/.env.example`):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `PORT` | e.g. `4000` |
   | `HOST` | `127.0.0.1` when a reverse proxy runs on the same machine |
   | `DATABASE_URL` | `postgres://user:password@host:5432/efalcon` (add `?sslmode=require` if the provider needs TLS) |
   | `JWT_SECRET` | 48+ random bytes. The server refuses to start without it |
   | `CORS_ORIGINS` | `https://app.example.com` |
   | `COOKIE_SAMESITE` | `lax` |
   | `OCPP_REQUIRE_AUTH` | leave unset (defaults to required in production) |
   | `TRUST_PROXY` | `1` behind a reverse proxy |

3. `npm install --omit=dev` (commit the `package-lock.json` this creates, then use `npm ci --omit=dev` on later deploys), then `npm run migrate`, then `npm run create-admin -- --email you@example.com`. There is no default account. Do not run `npm run seed` in production (it refuses).
4. `npm start` under a supervisor that restarts it (systemd, the platform's own, or pm2).
5. Reverse proxy (Caddy or nginx) terminating TLS and forwarding to the port, with WebSocket upgrade enabled for `/ocpp/` and `/socket.io/`, and an idle timeout longer than the heartbeat interval (default 60 s; set the proxy to 5 minutes).

### If the charger firmware cannot do TLS

The photographed unit is currently configured with a plain `ws://` URL on port 9988, so this is a real possibility. Then expose a second, plain listener for `/ocpp/` only (a proxy rule on another port forwarding to the same server), restrict it by firewall to the chargers' SIM or site IP ranges if you can, and prefer a private APN or VPN. Over plain `ws://` the authorisation key and all session data travel unencrypted. Never expose `/api` or `/socket.io` without TLS.

## Dashboard on Vercel

Import the repository, set **Root Directory** to `frontend`, and add the environment variable `VITE_API_URL=https://api.example.com`. `frontend/vercel.json` covers the build and the single-page-app rewrite. Without `VITE_API_URL` the deployment is the demo mode.

## Database

- Grant the application role `INSERT` and `SELECT` only on `audit_logs`:
  `REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM efalcon_app;`
  The application never updates or deletes audit rows, so nothing else changes.
- Backups: daily automated backups with point-in-time recovery if the provider offers it, and a restore rehearsal before go-live.
- `meter_values` grows fastest (one row per sample per charging connector). Plan a retention job once volumes are known.

## Before go-live

- [ ] `npm test` passes in `backend/` and `frontend/` with real packages installed.
- [ ] Sign-in, live updates and a simulated charger work against the PostgreSQL deployment (PostgreSQL was not exercised during development).
- [ ] `docs/HARDWARE_VERIFICATION.md` completed on one physical unit, capabilities recorded.
- [ ] Every charger has its own authorisation key; the key visible in the earlier photo is not in use anywhere.
- [ ] Operational limit set to the intended number (the default is 100).
- [ ] Tariff integration decided: left at "None", or the manufacturer's format implemented and read back on the touchscreen.
- [ ] Backups verified by restoring one.
