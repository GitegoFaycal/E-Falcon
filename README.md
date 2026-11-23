# E-Falcon CMS

EV charging management system for DC charging stations: live monitoring, availability control, an enforced operational limit, pricing, commands with tracked results, alerts, reports, users and an audit trail. Chargers connect to it over OCPP 1.6J.

| Part | What it is |
|---|---|
| `frontend/` | React dashboard (Vite, Tailwind, React Router, Recharts, Axios, Socket.IO client) |
| `backend/` | Node.js server: REST API (Express), real-time hub (Socket.IO), OCPP 1.6J gateway (WebSocket), database (SQLite for development, PostgreSQL for production) |
| `backend/tools/charger-sim.js` | Optional developer tool: a pretend charger that connects to the server over OCPP. It only runs if you start it, and is not part of the dashboard |
| `docs/` | Architecture, deployment, hardware verification checklist, status checklist |

**No physical charger has been connected to this system yet.** Everything about real hardware (OCPP version, which commands the firmware accepts, whether a tariff can be set remotely) is still to be verified; see `docs/HARDWARE_VERIFICATION.md`. Read "What was and was not tested" at the end before relying on it.

## Run it locally

Requires Node.js 22.13 or newer.

```bash
# 1. Server (development uses a local SQLite file; nothing else to install)
cd backend
npm install
cp .env.example .env
npm run create-admin -- --email you@example.com --name "Your Name"   # prints a generated password once
npm run seed          # optional demo records: 2 locations, 2 tariffs, 3 chargers EF-SIM-001..003
npm run dev           # http://localhost:4000

# 2. Simulated chargers (second terminal) - they connect over OCPP like real ones
cd backend
npm run charger-sim -- --ids EF-SIM-001,EF-SIM-002,EF-SIM-003 --auto

# 3. Dashboard (third terminal)
cd frontend
npm install
npm run dev           # http://localhost:5173, sign in with the admin account from step 1
                      # (uses the server at http://localhost:4000 automatically; no .env needed locally)
```

Tests:

```bash
cd backend && npm test     # 13 tests: REST API, engine, database, OCPP with a simulated charger
```

The dashboard shows only what the server holds. There is no demo or simulated data in it: if it cannot reach the server it says so.

## Connecting a real charger

1. Dashboard → Chargers → **Register charger**. The OCPP identity must match what you will enter on the charger.
2. Open the charger's page → **Connecting this charger** → **Issue authorisation key**. The key is shown once.
3. On the charger's OCPP screen enter the connection URL, the CP identification and the key shown on that page.
4. Work through `docs/HARDWARE_VERIFICATION.md` and record the results on the charger's **Edit** screen (capabilities, hardware notes). A capability marked "Not supported" is never sent.

The connection is refused if the identity is not registered, the charger does not offer the `ocpp1.6` subprotocol, or (when authentication is required) the key is missing or wrong. Each refusal appears as an alert, which is the first place to look if a charger will not connect.

## Things to try with the simulated chargers

| Goal | Steps | What you should see |
|---|---|---|
| Live updates | Leave a charger page open while `--auto` runs | Sessions start, energy and cost climb, without reloading |
| Limit is enforced | Operational limit → set maximum to 3 → Save | "N over the limit" banner and alert, no session stopped; new enables are blocked |
| Sessions are never stopped by a restriction | Restrict a gun that is charging | "Successful: charger answered Scheduled"; it becomes Restricted when the session ends |
| Offline is reported, not assumed | Stop the simulator, then restrict a connector | "Offline: the command was not sent"; state unchanged |
| Price stages | Pricing → Charger status | "CMS billing only" until a tariff integration is configured |
| Tariff push | Settings → Tariff integration → DataTransfer, vendor ID `EFalconSim` → assign a tariff | Stored → Sent → Confirmed for connected simulators; Offline for the rest |
| Roles | Users → create an operator and a viewer, sign in as each | Fewer menu items and buttons; the server refuses anything not permitted |

## How it fits together

- All rules live in `backend/src/core/engine.js` (permissions, limit, command lifecycle, pricing precedence, session costing, what each OCPP message changes). REST routes and the OCPP gateway are thin layers over it.
- A connector, price or command is marked as changed only after the charger replies. Reported connector status only ever comes from the charger's own StatusNotification.
- The server keeps operational state in memory and writes every change to the database in a transaction before it answers. On restart it reloads from the database; commands that were in flight are marked failed and are never re-sent.
- `frontend/src/lib/` holds the rule files shared by both sides (tariff maths, status derivation, pricing precedence, limit snapshot, permission catalogue). `backend/src/shared/` is a copy kept identical by `npm run sync-shared`; a test fails if they differ.

More detail: `docs/ARCHITECTURE.md`. First test server and first charger: `docs/SERVER_SETUP.md`. Production setup: `docs/DEPLOYMENT.md`.

## What was and was not tested

The environment this was written in had no access to the npm registry, so packages could not be installed there.

**Run for real:** the engine, the database layer on SQLite, the migrations, and the OCPP gateway with simulated chargers connecting over actual WebSockets (`ws` was available). Authentication, refusals, sessions, metering, costing, the limit, lost replies, the tariff push, permissions and restart recovery are covered by `backend` tests and all pass.

**Run against stand-ins:** Express, Socket.IO, jsonwebtoken, helmet, cors and express-rate-limit on the server, and React Router, Recharts, lucide-react, Axios and the Socket.IO client in the browser, were replaced by small local substitutes with the same interface. With those, the REST tests pass and the full flow was driven in Chrome: sign-in, chargers online, a session appearing live, restrict, key issue, tariff push, user creation, reload, role change, offline alert. This shows the application code is right; it does not prove every call into the real packages is.

**Not run at all:** PostgreSQL (the adapter and the migration on Postgres), the Tailwind 3 build, the real charts, and any physical charger.

So the first `npm install && npm test` in `backend/` on your machine is a real test, not a formality. If something fails there, it will be in the glue files: `backend/src/http/app.js`, `http/auth.js`, `realtime/hub.js`, `db/index.js` (Postgres part), `frontend/src/services/live.js` or `components/charts.jsx`.

## Not built

- SetChargingProfile / power limits (the capability can be recorded, no command is sent).
- A manufacturer-specific tariff format. The DataTransfer integration sends E-Falcon's own JSON; a real charger needs the manufacturer's format.
- Local authorisation list, reservations, firmware update commands. Every ID tag is accepted.
- Email / SMS notifications (alerts appear in the dashboard and as toasts).
- Self-service password change (an administrator sets and resets passwords).
- Reports beyond the live window: the dashboard holds the most recent 5,000 sessions. Older data is in the database and available from `GET /api/history/sessions`.
- More than one server process. One process holds the charger connections and the working state.
