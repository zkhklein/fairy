/**
 * FMB Database Service.
 * - Uses `sqlite` package (prebuilt better-sqlite3 bindings) for synchronous local execution.
 * - Query layer: Kysely SqliteDialect with a custom sync-compatible driver wrapper.
 * - Custom tiny migrator reads `migrations/*.sql` and tracks applied rows in __migrations.
 * - Database path: `app.getPath('userData')/fmb.db` — never hardcode platform separators.
 */
import { app } from 'electron';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import {
  Kysely,
  SqliteDialect,
  type SqliteDialectConfig,
} from 'kysely';
import type {
  AuditLog,
  ErrorLog,
  ExtensionPointBinding,
  JobQueue,
  KvStoreRow,
  Plugin,
  PluginVersion,
  Schedule,
  Secret,
  Workflow,
  WorkflowNode,
  WorkflowRun,
} from './types';
import { MIGRATIONS } from './migrations/001_init';
import { createLogger } from '../logger';

export interface FMBTables {
  plugins: Plugin;
  plugin_versions: PluginVersion;
  workflows: Workflow;
  workflow_runs: WorkflowRun;
  workflow_nodes: WorkflowNode;
  schedules: Schedule;
  job_queue: JobQueue;
  error_logs: ErrorLog;
  audit_logs: AuditLog;
  extension_point_bindings: ExtensionPointBinding;
  secrets: Secret;
  kv_store: KvStoreRow;
  __migrations: { name: string; applied_at: number };
}

const logger = createLogger('db');

let databaseInstance: Database.Database | null = null;
let kyselyInstance: Kysely<FMBTables> | null = null;
let initialized = false;

function resolveDbPath(): string {
  if (app.isPackaged) {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    return path.join(userData, 'fmb.db');
  }
  // In dev: app.getAppPath() returns the project root (where package.json lives)
  const projectRoot = app.getAppPath();
  const dir = path.join(projectRoot, '.data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'fmb.db');
}

function runMigrations(db: Database.Database): string[] {
  const applied = new Set(
    db
      .prepare("SELECT name FROM __migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const newlyApplied: string[] = [];
  const insert = db.prepare("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)");

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.up);
      insert.run(migration.name, Date.now());
    });
    tx();
    logger.info({ migration: migration.name }, 'migration applied');
    newlyApplied.push(migration.name);
  }
  return newlyApplied;
}

export function getRawDb(): Database.Database {
  if (!databaseInstance) throw new Error('Database not initialized, call initDatabase() first');
  return databaseInstance;
}

export function getDb(): Kysely<FMBTables> {
  if (!kyselyInstance) throw new Error('Database not initialized, call initDatabase() first');
  return kyselyInstance;
}

export function initDatabase(): { path: string; migrationsApplied: string[] } {
  if (initialized) {
    return {
      path: databaseInstance ? (databaseInstance as unknown as { name: string }).name : '',
      migrationsApplied: [],
    };
  }
  const dbPath = resolveDbPath();
  logger.info({ dbPath }, 'initializing sqlite database');

  // Enable WAL + foreign keys for performance & integrity
  databaseInstance = new Database(dbPath);
  databaseInstance.pragma('journal_mode = WAL');
  databaseInstance.pragma('foreign_keys = ON');
  databaseInstance.pragma('synchronous = NORMAL');

  // Ensure __migrations table exists BEFORE runMigrations() (the .sql file also contains it but
  // reading that table would fail otherwise)
  databaseInstance.exec(
    "CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const migrationsApplied = runMigrations(databaseInstance);

  // Build Kysely on top of the same raw connection (sqlite package = better-sqlite3 compatible API)
  const dialectConfig: SqliteDialectConfig = {
    database: databaseInstance as unknown as SqliteDialectConfig['database'],
  };
  kyselyInstance = new Kysely<FMBTables>({
    dialect: new SqliteDialect(dialectConfig),
  });

  initialized = true;
  logger.info({ migrationsApplied }, 'database ready');
  return { path: dbPath, migrationsApplied };
}

export function closeDatabase(): void {
  if (kyselyInstance) {
    void kyselyInstance.destroy().catch((err) => {
      logger.warn({ err: String(err) }, 'kysely destroy error');
    });
  }
  databaseInstance?.close();
  databaseInstance = null;
  kyselyInstance = null;
  initialized = false;
}
