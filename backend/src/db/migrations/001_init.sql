-- E-Falcon schema, version 1.
-- Written in the subset of SQL that PostgreSQL and SQLite both accept, so development can run
-- on a local SQLite file and production on PostgreSQL from the same migration.
-- Conventions: text primary keys, timestamps as epoch milliseconds (BIGINT), structured
-- values as JSON text. Every identifier is quoted so no column name can collide with a keyword.

CREATE TABLE "system_settings" (
  "key"   TEXT PRIMARY KEY,
  "value" TEXT NOT NULL
);

CREATE TABLE "users" (
  "id"            TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "email"         TEXT NOT NULL UNIQUE,
  "role"          TEXT NOT NULL CHECK ("role" IN ('admin', 'operator', 'viewer')),
  "active"        BOOLEAN NOT NULL DEFAULT TRUE,
  "password_hash" TEXT,
  "created_at"    BIGINT NOT NULL,
  "last_login_at" BIGINT
);

CREATE TABLE "refresh_tokens" (
  "id"         TEXT PRIMARY KEY,
  "user_id"    TEXT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL
);
CREATE INDEX "refresh_tokens_user" ON "refresh_tokens" ("user_id");

CREATE TABLE "locations" (
  "id"      TEXT PRIMARY KEY,
  "name"    TEXT NOT NULL,
  "address" TEXT NOT NULL DEFAULT '',
  "city"    TEXT NOT NULL DEFAULT '',
  "notes"   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "charger_groups" (
  "id"                  TEXT PRIMARY KEY,
  "name"                TEXT NOT NULL,
  "description"         TEXT NOT NULL DEFAULT '',
  "location_id"         TEXT REFERENCES "locations" ("id") ON DELETE SET NULL,
  "availability_policy" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "chargers" (
  "id"             TEXT PRIMARY KEY,
  "ocpp_id"        TEXT NOT NULL UNIQUE,
  "name"           TEXT NOT NULL,
  "serial"         TEXT NOT NULL DEFAULT '',
  "model"          TEXT NOT NULL DEFAULT '',
  "manufacturer"   TEXT NOT NULL DEFAULT '',
  "firmware"       TEXT NOT NULL DEFAULT '',
  "ocpp_version"   TEXT NOT NULL DEFAULT '1.6J',
  "location_id"    TEXT NOT NULL REFERENCES "locations" ("id"),
  "online"         BOOLEAN NOT NULL DEFAULT FALSE,
  "ever_connected" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_heartbeat" BIGINT,
  "booted_at"      BIGINT,
  "capabilities"   TEXT NOT NULL,
  "hardware"       TEXT NOT NULL,
  "reported"       TEXT,
  "auth_key_hash"  TEXT,
  "created_at"     BIGINT NOT NULL
);
CREATE INDEX "chargers_location" ON "chargers" ("location_id");

CREATE TABLE "charger_group_members" (
  "group_id"   TEXT NOT NULL REFERENCES "charger_groups" ("id") ON DELETE CASCADE,
  "charger_id" TEXT NOT NULL REFERENCES "chargers" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("group_id", "charger_id")
);
CREATE INDEX "charger_group_members_charger" ON "charger_group_members" ("charger_id");

CREATE TABLE "connectors" (
  "id"                  TEXT PRIMARY KEY,
  "charger_id"          TEXT NOT NULL REFERENCES "chargers" ("id") ON DELETE CASCADE,
  "connector_id"        INTEGER NOT NULL CHECK ("connector_id" > 0),
  "label"               TEXT NOT NULL,
  "type"                TEXT NOT NULL DEFAULT '',
  "max_power_kw"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "enabled"             BOOLEAN NOT NULL DEFAULT FALSE,
  "admin_confirmed"     BOOLEAN NOT NULL DEFAULT FALSE,
  "maintenance"         BOOLEAN NOT NULL DEFAULT FALSE,
  "status"              TEXT NOT NULL DEFAULT 'Unavailable',
  "error_code"          TEXT NOT NULL DEFAULT 'NoError',
  "error_info"          TEXT NOT NULL DEFAULT '',
  "power_kw"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "meter_wh"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "session_id"          TEXT,
  "pending_inoperative" BOOLEAN NOT NULL DEFAULT FALSE,
  "pending_maintenance" BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE ("charger_id", "connector_id")
);

CREATE TABLE "pricing_rules" (
  "id"             TEXT PRIMARY KEY,
  "name"           TEXT NOT NULL UNIQUE,
  "description"    TEXT NOT NULL DEFAULT '',
  "version"        INTEGER NOT NULL DEFAULT 1,
  "flat_fee"       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK ("flat_fee" >= 0),
  "hour_price"     DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK ("hour_price" >= 0),
  "preauth_amount" DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK ("preauth_amount" >= 0),
  "created_at"     BIGINT NOT NULL,
  "updated_at"     BIGINT NOT NULL
);

CREATE TABLE "pricing_periods" (
  "id"            TEXT PRIMARY KEY,
  "rule_id"       TEXT NOT NULL REFERENCES "pricing_rules" ("id") ON DELETE CASCADE,
  "weekend"       BOOLEAN NOT NULL DEFAULT FALSE,
  "start"         TEXT NOT NULL,
  "energy_price"  DOUBLE PRECISION NOT NULL CHECK ("energy_price" >= 0),
  "service_price" DOUBLE PRECISION NOT NULL CHECK ("service_price" >= 0),
  "kind"          TEXT NOT NULL DEFAULT 'standard',
  UNIQUE ("rule_id", "weekend", "start")
);

CREATE TABLE "pricing_assignments" (
  "id"           TEXT PRIMARY KEY,
  "rule_id"      TEXT NOT NULL,
  "scope"        TEXT NOT NULL CHECK ("scope" IN ('global', 'location', 'group', 'charger', 'connector')),
  "target_id"    TEXT,
  "status"       TEXT NOT NULL,
  "effective_at" BIGINT NOT NULL,
  "activated_at" BIGINT,
  "ended_at"     BIGINT,
  "created_at"   BIGINT NOT NULL,
  "created_by"   TEXT NOT NULL
);
CREATE INDEX "pricing_assignments_status" ON "pricing_assignments" ("status", "effective_at");

-- One row per attempt to put a tariff on a charger: the price change history.
CREATE TABLE "pricing_deployments" (
  "id"           TEXT PRIMARY KEY,
  "charger_id"   TEXT NOT NULL,
  "rule_id"      TEXT NOT NULL,
  "rule_name"    TEXT NOT NULL,
  "rule_version" INTEGER NOT NULL,
  "current"      BOOLEAN NOT NULL DEFAULT TRUE,
  "stage"        TEXT NOT NULL,
  "command_id"   TEXT,
  "requested_by" TEXT NOT NULL,
  "detail"       TEXT NOT NULL DEFAULT '',
  "created_at"   BIGINT NOT NULL,
  "updated_at"   BIGINT NOT NULL
);
CREATE INDEX "pricing_deployments_charger" ON "pricing_deployments" ("charger_id", "created_at");

-- History tables keep the charger id as plain text (no foreign key) so that records survive
-- the deletion of a charger.
CREATE TABLE "charging_sessions" (
  "id"             TEXT PRIMARY KEY,
  "transaction_id" INTEGER NOT NULL UNIQUE,
  "charger_id"     TEXT NOT NULL,
  "connector_id"   TEXT NOT NULL,
  "id_tag"         TEXT,
  "started_at"     BIGINT NOT NULL,
  "ended_at"       BIGINT,
  "meter_start_wh" DOUBLE PRECISION,
  "meter_stop_wh"  DOUBLE PRECISION,
  "energy_kwh"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status"         TEXT NOT NULL CHECK ("status" IN ('active', 'completed', 'failed')),
  "stop_reason"    TEXT,
  "rule_id"        TEXT,
  "rule_name"      TEXT,
  "rule_version"   INTEGER,
  "price_at_start" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "fees"           TEXT NOT NULL,
  "energy_cost"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cost"           DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cost_source"    TEXT NOT NULL DEFAULT 'cms_calculated'
);
CREATE INDEX "charging_sessions_started" ON "charging_sessions" ("started_at");
CREATE INDEX "charging_sessions_charger" ON "charging_sessions" ("charger_id", "started_at");
CREATE INDEX "charging_sessions_status" ON "charging_sessions" ("status");

CREATE TABLE "meter_values" (
  "id"           TEXT PRIMARY KEY,
  "charger_id"   TEXT NOT NULL,
  "connector_id" TEXT NOT NULL,
  "session_id"   TEXT,
  "at"           BIGINT NOT NULL,
  "energy_wh"    DOUBLE PRECISION,
  "power_kw"     DOUBLE PRECISION
);
CREATE INDEX "meter_values_connector" ON "meter_values" ("connector_id", "at");
CREATE INDEX "meter_values_session" ON "meter_values" ("session_id");

CREATE TABLE "charger_commands" (
  "id"              TEXT PRIMARY KEY,
  "charger_id"      TEXT NOT NULL,
  "connector_id"    TEXT,
  "type"            TEXT NOT NULL,
  "payload"         TEXT NOT NULL,
  "meta"            TEXT NOT NULL,
  "requested_by"    TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "requested_at"    BIGINT NOT NULL,
  "status"          TEXT NOT NULL CHECK ("status" IN ('pending', 'sent', 'acknowledged', 'successful', 'failed', 'timed_out', 'cancelled')),
  "sent_at"         BIGINT,
  "completed_at"    BIGINT,
  "response"        TEXT,
  "error"           TEXT,
  "result_code"     TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "max_attempts"    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "charger_commands_charger" ON "charger_commands" ("charger_id", "requested_at");
CREATE INDEX "charger_commands_status" ON "charger_commands" ("status");

CREATE TABLE "charger_events" (
  "id"           TEXT PRIMARY KEY,
  "charger_id"   TEXT,
  "connector_id" TEXT,
  "type"         TEXT NOT NULL,
  "message"      TEXT NOT NULL,
  "at"           BIGINT NOT NULL
);
CREATE INDEX "charger_events_charger" ON "charger_events" ("charger_id", "at");

CREATE TABLE "alerts" (
  "id"              TEXT PRIMARY KEY,
  "type"            TEXT NOT NULL,
  "severity"        TEXT NOT NULL CHECK ("severity" IN ('critical', 'warning', 'info')),
  "charger_id"      TEXT,
  "connector_id"    TEXT,
  "message"         TEXT NOT NULL,
  "created_at"      BIGINT NOT NULL,
  "status"          TEXT NOT NULL CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
  "acknowledged_by" TEXT,
  "acknowledged_at" BIGINT,
  "resolved_at"     BIGINT,
  "resolution_note" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX "alerts_status" ON "alerts" ("status", "created_at");

-- Append-only. In production the application's database role should be granted INSERT and
-- SELECT on this table and nothing else (see docs/DEPLOYMENT.md).
CREATE TABLE "audit_logs" (
  "id"           TEXT PRIMARY KEY,
  "user_id"      TEXT NOT NULL,
  "user_name"    TEXT NOT NULL,
  "action"       TEXT NOT NULL,
  "entity_type"  TEXT NOT NULL,
  "entity_id"    TEXT,
  "entity_label" TEXT,
  "before"       TEXT,
  "after"        TEXT,
  "details"      TEXT NOT NULL DEFAULT '',
  "at"           BIGINT NOT NULL
);
CREATE INDEX "audit_logs_at" ON "audit_logs" ("at");
CREATE INDEX "audit_logs_action" ON "audit_logs" ("action");

CREATE TABLE "scheduled_operations" (
  "id"            TEXT PRIMARY KEY,
  "type"          TEXT NOT NULL,
  "run_at"        BIGINT NOT NULL,
  "payload"       TEXT NOT NULL,
  "status"        TEXT NOT NULL CHECK ("status" IN ('scheduled', 'executed', 'cancelled', 'failed')),
  "created_by"    TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at"    BIGINT NOT NULL,
  "executed_at"   BIGINT,
  "result"        TEXT,
  "error"         TEXT
);
CREATE INDEX "scheduled_operations_due" ON "scheduled_operations" ("status", "run_at");
