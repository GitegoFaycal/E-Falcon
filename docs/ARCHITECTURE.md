# E-Falcon CMS: Architecture

Status: frontend, backend, database layer and OCPP gateway are built. No physical charger has been connected yet. See README "What was and was not tested".

## 1. What the photographs tell us

These observations come from the four photos supplied on 23 Nov 2026. Each one is something to confirm on site, not a fact about the firmware.

| Observation | What it suggests | Still unverified |
|---|---|---|
| OCPP screen has fields for connection URL, CP identification, an authorisation key and a security profile | The unit speaks OCPP-J over WebSocket and the backend address can be changed on the touchscreen | OCPP version (1.6J or other), whether a third-party backend is accepted, which commands are implemented |
| The URL currently set is `ws://ocpp.thaisen.cn:9988/thaisen` | The unit is pointed at the manufacturer's own platform (Thaisen), over plain `ws://` on a custom port | Whether the firmware supports `wss://` (TLS) and which certificate authorities it trusts |
| Tariff screen shows status "offline" | The unit is not currently connected to any backend | |
| Tariff screen: four periods starting 00:00, 06:00, 12:00, 16:00, each with a kWh price and a service price, plus an hour price, a flat fee and a pre-processing amount | The local tariff model is "start times, energy price + service price, time fee, flat fee, pre-authorisation". The E-Falcon tariff model copies this shape exactly | Whether these values can be written remotely at all, and by what mechanism |
| Cabinet contains a main DC charging controller, a module labelled TH-TCU-003 and an RNL module | RNL Technology makes EVCC/SECC charging-communication converters (ISO 15118, DIN 70121, CHAdeMO) and its site does not mention OCPP, so the RNL box is most likely the vehicle-side communication unit. OCPP therefore lives in the Thaisen controller/TCU | Which board runs the OCPP client and its firmware version |

**Security note:** the authorisation key is readable in one of the photos. Treat it as exposed: do not reuse it, and set a new key when the unit is pointed at E-Falcon.

Consequences for the design:

1. Every charger has a **capability record** (verified / not verified / not supported per command). The CMS never sends a command marked "not supported", and labels anything "not verified".
2. Tariff push is modelled as a **vendor-specific integration**, separate from OCPP, because standard OCPP 1.6 has no tariff message.
3. The OCPP endpoint must be able to accept **plain `ws://` on a non-443 port** in case the firmware has no TLS. That rules out a serverless-only deployment for the charger-facing part (see DEPLOYMENT.md).

`docs/HARDWARE_VERIFICATION.md` is the on-site checklist that turns these unknowns into recorded facts.

## 2. Components

```
  Operators (browser)
        │  REST over HTTPS (JWT)          │  Socket.IO (JWT)
┌───────▼─────────────────────────────────▼────────────────────────────┐
│  E-Falcon server (one Node.js process)                                │
│                                                                       │
│  http/app.js      REST routes, auth, rate limits, error mapping       │
│  realtime/hub.js  pushes each persisted change to dashboards          │
│        │                     ▲                                        │
│        ▼                     │ patches (changed rows)                 │
│  core/engine.js   ALL rules: permissions, operational limit, command  │
│                   lifecycle, pricing, sessions, alerts, audit,        │
│                   scheduler, meaning of every OCPP message            │
│        │                     ▲                                        │
│        ▼ write-through       │ load at start                          │
│  db/store.js ── db/index.js ── SQLite (dev) / PostgreSQL (prod)       │
│                                                                       │
│  ocpp/gateway.js  accepts chargers at /ocpp/<identity>, authenticates │
│  ocpp/rpc.js      OCPP-J framing (CALL / CALLRESULT / CALLERROR)      │
└───────▲───────────────────────────────────────────────────────────────┘
        │  OCPP 1.6J over WebSocket (the charger dials in)
   DC chargers (A GUN / B GUN)        tools/charger-sim.js in development
```

| Brief component | Where it lives |
|---|---|
| Frontend dashboard | `frontend/` |
| Backend REST API | `backend/src/http/` |
| OCPP communication server | `backend/src/ocpp/` |
| Real-time monitoring service | `backend/src/realtime/hub.js` + `frontend/src/services/live.js` |
| Command management | `createCommand`, `dispatch`, `finish` in `core/engine.js` |
| Pricing management | tariffs, assignments, deployments in `core/engine.js`; maths in `shared/tariff.js` |
| Reporting and analytics | computed in the dashboard from the live window; `GET /api/history/*` for older data |

## 3. Design decisions

**One process, state in memory, written through.** The engine holds the operational state (chargers, connectors, tariffs, open sessions, recent history) in memory. Every action runs synchronously against it, so a check such as "enabled + pending ≤ limit" cannot interleave with another request, and then `db/store.js` writes exactly the rows that changed in one transaction before the response is sent. On start the state is loaded back. The cost is that the server cannot be scaled to several processes without a redesign; the benefit is that the limit and command rules are simple and provably race-free. Suitable for hundreds of chargers; revisit beyond a few thousand connectors.

**Live tables and history tables.** Chargers, connectors, locations, groups, tariffs and users are mirrored exactly. Sessions, commands, events, alerts, audit entries and deployments keep a recent window in memory (5,000 sessions, 2,000 commands, 2,000 audit entries…) while the database keeps everything.

**Nothing is done until the charger says so.** `connector.enabled` changes only on an Accepted ChangeAvailability (or, before the CMS has ever commanded that connector, from the charger's own report). Reported status comes only from StatusNotification. A tariff has a deployment row per charger: stored → sent → confirmed, or CMS-only / not supported / offline / failed. If a charger reports itself available after the CMS restricted it, a "state differs" alert is raised instead of silently trusting either side.

**The limit is enforced where commands are created.** Every enable path (single, bulk, scheduled, retry) goes through one function. Lowering the limit never stops a session: it blocks new enables, raises an alert, and the dashboard proposes idle connectors to restrict. Because a physical charger is operative until told otherwise, connecting new hardware can put the network over the limit; that is reported, not hidden.

**Commands.** Pending → Sent → Acknowledged → Successful / Failed / Timed out / Cancelled, all persisted. ChangeAvailability, GetConfiguration and the tariff push are safe to repeat and are retried once after a timeout. RemoteStart, RemoteStop and Reset are never retried automatically, and Reset is refused while a session is running. One CALL is outstanding per charger at a time, as OCPP-J requires. After a server restart, in-flight commands are marked failed and never re-sent.

**Capabilities.** Each charger records verified / not verified / not supported per command family. "Not supported" is never sent. If a charger answers NotImplemented or NotSupported, the capability is recorded as not supported automatically. An Accepted reply does not mark anything verified: that takes a person observing the hardware.

**Pricing integration.** OCPP 1.6 has no tariff message. Settings → Tariff integration selects the method: *None* (default; price used for CMS billing only) or *DataTransfer* with a vendor ID. The DataTransfer body is E-Falcon's own JSON and is a placeholder for whatever the manufacturer specifies; `toOcpp()` in the engine is the single place to change. Session cost is always calculated by the CMS from metered energy at the tariff in force when each sample arrives, in the configured time zone.

## 4. OCPP

**Library decision.** The brief asked for a maintained OCPP library. The candidate, `ocpp-rpc`, covers exactly one thing, the OCPP-J message framing, and its maintenance is rated inactive by Snyk. Framing is about 80 lines, so it is implemented in `ocpp/rpc.js` on top of `ws`, which is actively maintained, and was tested here against a simulated charger over real sockets. What this gives up is `ocpp-rpc`'s JSON-schema validation of every payload; the handlers validate the fields they use. Swapping the library in later only touches `rpc.js` and `gateway.js`.

| Message | Direction | Handling |
|---|---|---|
| BootNotification | charger → CMS | Records vendor, model, serial, firmware; replies Accepted with the heartbeat interval |
| Heartbeat | charger → CMS | Updates last communication |
| StatusNotification | charger → CMS | Connector status and fault; creates a connector the charger reports but the CMS did not know; fault alerts |
| Authorize | charger → CMS | Accepts every tag (no local list yet) |
| StartTransaction / StopTransaction | charger → CMS | Opens and closes sessions; repeated messages get the same answer |
| MeterValues | charger → CMS | Energy register and power; accrues session energy and cost; stores samples; flags a register going backwards |
| ChangeAvailability | CMS → charger | Enable / restrict; "Scheduled" handled |
| RemoteStartTransaction / RemoteStopTransaction | CMS → charger | Never auto-retried |
| Reset (Soft), GetConfiguration | CMS → charger | |
| DataTransfer | CMS → charger | Only for the optional tariff integration |
| anything else from a charger | | CALLERROR NotImplemented |

Not implemented: ChangeConfiguration, SetChargingProfile, TriggerMessage, UnlockConnector, reservations, local list, firmware and diagnostics commands.

**Connection rules.** `/ocpp/<identity>`; identity must be a registered charger; subprotocol `ocpp1.6`; HTTP Basic with the charger's key when authentication is required (always in production unless switched off). Keys are random, shown once, stored as a hash. A second connection for the same identity replaces the first. Dead links are detected with WebSocket pings.

**Adding OCPP 2.0.1.** Accept the `ocpp2.0.1` subprotocol in the gateway and add a second handler table in the engine that maps its messages onto the same domain operations. The framing is already shared.

## 5. Security

Passwords: scrypt with a per-user salt. Access token: JWT, 15 minutes, kept in browser memory. Refresh token: random, rotated on every use, httpOnly cookie, only its hash stored, revoked when an administrator resets the password or deactivates the user. Cookie endpoints require a custom header. Every permission is checked in the engine, not in the routes or the UI. Secrets (password hashes, charger key hashes) are stripped before anything leaves the server, and users only receive the tables they may see. Rate limits on the API and on sign-in. Production refuses to start without `JWT_SECRET`, `DATABASE_URL` and `CORS_ORIGINS`. No default accounts. The audit log is append-only in the application; DEPLOYMENT.md shows how to enforce that in the database.

## 6. Database

`backend/src/db/migrations/001_init.sql` creates: `system_settings`, `users`, `refresh_tokens`, `locations`, `charger_groups`, `charger_group_members`, `chargers`, `connectors`, `pricing_rules`, `pricing_periods`, `pricing_assignments`, `pricing_deployments` (the price change history), `charging_sessions`, `meter_values`, `charger_commands`, `charger_events`, `alerts`, `audit_logs`, `scheduled_operations`.

Differences from the list in the brief: role permissions are stored in `system_settings` rather than separate `roles` / `permissions` tables (three fixed roles, an editable permission list each); capabilities and hardware notes are JSON on the charger row. History tables hold the charger id without a foreign key so that records survive deleting a charger. The migration is written in the SQL subset PostgreSQL and SQLite share, and a small runner (`npm run migrate`, also run at start) applies numbered files once. This replaces the Knex proposal from the earlier draft: one less dependency, and it could be tested here.

## 7. Project structure

```
e-falcon/
├── README.md
├── docs/            ARCHITECTURE, DEPLOYMENT, HARDWARE_VERIFICATION, CHECKLIST
├── frontend/
│   ├── tests/engine.test.js
│   └── src/
│       ├── services/api.js     chooses live server or demo simulator
│       ├── services/live.js    Axios + Socket.IO client, store fed by snapshot + patches
│       ├── sim/                in-browser simulator (demo mode only)
│       ├── lib/                rule files shared with the backend
│       ├── context/, components/, pages/
└── backend/
    ├── .env.example
    ├── tests/                  system.test.js (engine + DB + OCPP), http.test.js (REST)
    ├── tools/                  charger-sim, create-admin, seed, migrate, sync-shared
    └── src/
        ├── server.js, config.js, setup.js
        ├── core/               engine.js, index.js (persistence + patches + snapshot), secrets.js
        ├── db/                 index.js (adapters, migrations), store.js, migrations/
        ├── http/               app.js (routes), auth.js
        ├── ocpp/               gateway.js, rpc.js
        ├── realtime/           hub.js
        └── shared/             copy of frontend/src/lib (kept identical by a test)
```
