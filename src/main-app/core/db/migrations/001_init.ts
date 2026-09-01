/**
 * FMB built-in migrations registry.
 * Each entry must include:
 *   - name: unique id (prefixed with 3-digit zero-padded number)
 *   - up:   synchronous SQL string (better-sqlite3 is synchronous)
 *
 * Why a TS registry instead of .sql files?
 *   - electron-vite only emits compiled JS to out/main; plain .sql files are not copied.
 *   - Keeping migrations as strings makes the main bundle self-contained.
 *   - TS strings benefit from strict-mode tsc and refactoring safety.
 */
export interface Migration {
  name: string;
  up: string;
}

const _001_init = /* sql */ `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS plugins (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('atomic','app','extension')),
  description        TEXT DEFAULT '',
  current_version    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed','enabled','disabled')),
  permissions_json   TEXT NOT NULL DEFAULT '[]',
  dependencies_json  TEXT NOT NULL DEFAULT '{}',
  manifest_json      TEXT NOT NULL DEFAULT '{}',
  installed_at       INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id    TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  directory    TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  UNIQUE(plugin_id, version)
);
CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions(plugin_id);

CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  definition_json TEXT NOT NULL,
  vars_json       TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL CHECK (trigger IN ('manual','schedule','api','cli','event')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','success','failed','cancelled')),
  input_json     TEXT NOT NULL DEFAULT '{}',
  output_json    TEXT,
  started_at     INTEGER,
  finished_at    INTEGER,
  created_at     INTEGER NOT NULL,
  duration_ms    INTEGER,
  error_stack    TEXT,
  trace_id       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  node_type     TEXT NOT NULL CHECK (node_type IN ('atomic','condition','loop','subflow','delay')),
  status        TEXT NOT NULL CHECK (status IN ('pending','running','success','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  input_json    TEXT,
  output_json   TEXT,
  error_stack   TEXT,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_run ON workflow_nodes(run_id);

CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cron_expr       TEXT,
  one_shot_at     INTEGER,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  input_json      TEXT NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  misfire_policy  TEXT NOT NULL DEFAULT 'skip' CHECK (misfire_policy IN ('run_now','skip','last_missed')),
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  last_fired_at   INTEGER,
  next_fired_at   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled, next_fired_at);

CREATE TABLE IF NOT EXISTS job_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL CHECK (type IN ('workflow_run','atomic_call','system')),
  payload_json   TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','dead')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  retry_backoff  TEXT NOT NULL DEFAULT 'exponential' CHECK (retry_backoff IN ('fixed','exponential')),
  started_at     INTEGER,
  finished_at    INTEGER,
  last_error     TEXT,
  worker_id      TEXT,
  run_after      INTEGER NOT NULL DEFAULT 0,
  trace_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(status, priority DESC, id ASC, run_after ASC);

CREATE TABLE IF NOT EXISTS error_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  level         TEXT NOT NULL CHECK (level IN ('error','warn','info')),
  source        TEXT NOT NULL,
  message       TEXT NOT NULL,
  stack         TEXT,
  metadata_json TEXT,
  trace_id      TEXT,
  resolved      INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  ignored       INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0,1)),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_logs_day ON error_logs(created_at, level);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action       TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'system',
  source       TEXT NOT NULL CHECK (source IN ('ui','cli','http','system','plugin')),
  payload_json TEXT,
  trace_id     TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS extension_point_bindings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  extension_point TEXT NOT NULL,
  plugin_id       TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  handler_name    TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  registered_at   INTEGER NOT NULL,
  UNIQUE(extension_point, plugin_id, handler_name)
);

CREATE TABLE IF NOT EXISTS secrets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT UNIQUE NOT NULL,
  value_enc    TEXT NOT NULL,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Ordered, append-only registry. NEVER REORDER existing entries. */
export const MIGRATIONS: Migration[] = [
  { name: '001_init.sql', up: _001_init },
  {
    name: '002_workflows_owner_plugin_id.sql',
    up: /* sql */ `
-- Step 1: Add nullable column with a sentinel default. (SQLite ALTER TABLE
-- only supports single-column additions, so we perform the upgrade in three
-- separate statements executed as a script.)
ALTER TABLE workflows ADD COLUMN owner_plugin_id TEXT NOT NULL DEFAULT '__PENDING_MIGRATE__';

-- Step 2: Ensure a builtin "host" app plugin exists. Any legacy workflows
-- that existed before this migration get assigned to the host plugin.
INSERT OR IGNORE INTO plugins (id, name, type, description, current_version, status, permissions_json, dependencies_json, manifest_json, installed_at, updated_at)
VALUES (
  'com.fmb.host',
  '内置宿主插件',
  'app',
  'Built-in owner plugin for legacy workflows and host-side bootstrapping.',
  '0.1.0',
  'installed',
  '[]',
  '{}',
  '{"id":"com.fmb.host","name":"内置宿主插件","version":"0.1.0","type":"app","description":"Built-in owner plugin.","permissions":[],"dependencies":{},"main":"index.js","extensionPoints":[]}',
  CAST((julianday('now') - 2440587.5)*86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5)*86400000 AS INTEGER)
);

-- Step 3: Backfill all __PENDING_MIGRATE__ rows to either the earliest
-- installed app plugin or, if none exists, the builtin host plugin.
UPDATE workflows
SET owner_plugin_id = COALESCE(
  (SELECT id FROM plugins WHERE type = 'app' ORDER BY installed_at ASC, id ASC LIMIT 1),
  'com.fmb.host'
)
WHERE owner_plugin_id = '__PENDING_MIGRATE__';

-- Step 4: SQLite can't enforce FK constraints via ALTER ADD COLUMN, so we
-- use triggers to guarantee owner_plugin_id always points to an app plugin.
DROP TRIGGER IF EXISTS trg_workflows_owner_app_insert;
DROP TRIGGER IF EXISTS trg_workflows_owner_app_update;
CREATE TRIGGER trg_workflows_owner_app_insert
BEFORE INSERT ON workflows
FOR EACH ROW WHEN (
  COALESCE((SELECT type FROM plugins WHERE id = NEW.owner_plugin_id), '') != 'app'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_plugin_id must reference a plugin with type=app');
END;
CREATE TRIGGER trg_workflows_owner_app_update
BEFORE UPDATE OF owner_plugin_id, id ON workflows
FOR EACH ROW WHEN (
  COALESCE((SELECT type FROM plugins WHERE id = NEW.owner_plugin_id), '') != 'app'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_plugin_id must reference a plugin with type=app');
END;

-- Step 5: Index for owner-based listing.
CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(owner_plugin_id);
`,
  },
];
