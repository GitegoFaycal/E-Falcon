# Status checklist

`[x]` built and exercised, `[~]` built with a stated gap, `[ ]` not built.

## Built

- [x] Dashboard, chargers, charger detail, connectors, locations, groups, pricing, operational limit, commands, sessions, alerts, reports, users, audit log, settings
- [x] Demo mode on an in-browser simulator, clearly labelled, for use without a server
- [x] Server: REST API, authentication (scrypt, JWT access token, rotating refresh cookie), role permissions enforced in the engine
- [x] Database schema with migrations; SQLite for development and tests
- [x] OCPP 1.6J gateway: identity check, subprotocol check, per-charger keys, keep-alive, reconnect handling
- [x] BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction, StopTransaction, MeterValues
- [x] ChangeAvailability, RemoteStart / RemoteStop, Reset, GetConfiguration, with command tracking, timeouts and safe retry rules
- [x] Operational limit enforced server-side on single, bulk, scheduled and retried enables; never stops sessions
- [x] Tariffs with start-time periods, weekend schedule and fees; assignment by network / location / group / charger / connector; scheduling; per-charger deployment status; CMS-side session costing in the configured time zone
- [x] Bulk operations with per-item results
- [x] Alerts: offline, recovery, connector fault, session failure, communication failure, failed command, pricing failure, limit exceeded, meter going backwards, unregistered charger, charger state differs from CMS
- [x] Audit log with before / after, append-only in the application
- [x] Live updates: every persisted change pushed to dashboards as row patches; polling fallback when the socket drops
- [x] Charger simulator speaking real OCPP, for development
- [x] Tests: 13 backend (REST, engine, database, OCPP end to end), 14 frontend (simulator rules)

## Built, with a gap to close before production

- [~] **PostgreSQL**: adapter and migration written, never run against a real PostgreSQL server
- [~] **Express, Socket.IO, jsonwebtoken, helmet, cors, rate limiting, Axios, Socket.IO client, React Router, Recharts, icons**: code written against their documented interfaces and exercised with local stand-ins, not with the real packages
- [~] **Tariff push**: mechanism and tracking built; the message format is a placeholder until the manufacturer's is known
- [~] **Capabilities**: recorded and enforced; all "not verified" until tested on hardware
- [~] **Reports**: cover the live window (latest 5,000 sessions); older data via `GET /api/history/sessions`

## Needs the hardware or the manufacturer

- [ ] HARDWARE_VERIFICATION.md section A answered by the manufacturer
- [ ] First physical charger connected; sections C and D recorded
- [ ] Whether the firmware accepts a third-party OCPP backend, and whether it supports TLS

## Not built

- [ ] SetChargingProfile / power limits, ChangeConfiguration, TriggerMessage, UnlockConnector
- [ ] Local authorisation list, reservations, firmware management
- [ ] Email / SMS / webhook notifications
- [ ] Self-service password change and password reset by email
- [ ] Per-location operational limits; the separately authorised "stop sessions to meet the limit" policy
- [ ] Meter value retention job; load testing; multi-process operation
