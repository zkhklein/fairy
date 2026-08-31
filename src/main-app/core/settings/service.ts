/**
 * Settings service — manages global FMB settings via the existing `kv_store` table.
 *
 * Settings used by Task 11 / Task 13 / Task 15:
 *   queue.concurrency       int     default 4      — how many jobs a worker drains in parallel
 *   http.port               int     default 8765   — localhost HTTP API bind port (Task15)
 *   http.token              string  default ''     — bearer token; empty = auto-generate on first use
 *   log.level               string  default 'info' — runtime pino/console log level
 *   system.autoStart        int     0|1 default 0  — launch at OS login (Task13)
 *   system.closeBehavior    string  'tray'|'quit' default 'tray' — main window × button
 *   ui.compact              int     0|1 default 0  — AntD compact mode preference
 *   ui.collapsed            int     0|1 default 0  — sider collapsed by default
 *
 * Every write appends an audit_log row so settings changes are traceable.
 */
import { getRawDb } from '../db';
import { getEventBus } from '../event-bus';
import { createLogger } from '../logger';
import type { Logger } from 'pino';

const log = createLogger('settings');

export type LogLevel = Logger['level'] | 'silent';

export interface FmbSettings {
  'queue.concurrency': number;
  'http.port': number;
  'http.token': string;
  'log.level': LogLevel;
  'system.autoStart': 0 | 1;
  'system.closeBehavior': 'tray' | 'quit';
  'ui.compact': 0 | 1;
  'ui.collapsed': 0 | 1;
}

const DEFAULTS: FmbSettings = {
  'queue.concurrency': 4,
  'http.port': 8765,
  'http.token': '',
  'log.level': 'info',
  'system.autoStart': 0,
  'system.closeBehavior': 'tray',
  'ui.compact': 0,
  'ui.collapsed': 0,
};

const KEYS: readonly (keyof FmbSettings)[] = [
  'queue.concurrency', 'http.port', 'http.token', 'log.level',
  'system.autoStart', 'system.closeBehavior', 'ui.compact', 'ui.collapsed',
] as const;

function cast<V extends keyof FmbSettings>(key: V, raw: string | undefined | null): FmbSettings[V] {
  const d = DEFAULTS[key] as FmbSettings[V];
  if (raw === undefined || raw === null) return d;
  switch (key) {
    case 'queue.concurrency':
    case 'http.port':
    case 'system.autoStart':
    case 'ui.compact':
    case 'ui.collapsed': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return d;
      return n as FmbSettings[V];
    }
    case 'log.level': {
      const lvl = raw as LogLevel;
      if (['fatal','error','warn','info','debug','trace','silent'].includes(lvl)) return lvl as FmbSettings[V];
      return d;
    }
    case 'system.closeBehavior':
      if (raw === 'tray' || raw === 'quit') return raw as FmbSettings[V];
      return d;
    case 'http.token':
      return raw as FmbSettings[V];
    default:
      return d;
  }
}

let singleton: SettingsService | null = null;

export class SettingsService {
  /**
   * Idempotent setup. Called from getSettingsService() so the very first
   * `getAll()` / `applyPatch()` call is guaranteed a backing table.
   */
  private _initialized = false;
  init(): void {
    if (this._initialized) return;
    const db = getRawDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT NOT NULL PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kv_store_updated_at ON kv_store(updated_at);
    `);
    // Seed defaults (only if key not already present; preserves user edits)
    const now = Date.now();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)`,
    );
    for (const k of KEYS) {
      const raw = DEFAULTS[k as keyof FmbSettings];
      insert.run(k, typeof raw === 'string' ? raw : JSON.stringify(raw), now);
    }
    this._initialized = true;
  }
  constructor() { this.init(); }

  /** Full in-memory copy. Re-reads every `getAll` so DB remains source of truth. */
  getAll(): FmbSettings {
    if (!this._initialized) this.init();
    const db = getRawDb();
    const rows = db.prepare(`SELECT key, value FROM kv_store WHERE key IN (${KEYS.map(() => '?').join(',')})`)
      .all(...KEYS) as { key: string; value: string }[];
    const by = new Map(rows.map((r) => [r.key, r.value]));
    const out = {} as FmbSettings;
    for (const k of KEYS) {
      (out as Record<typeof k, unknown>)[k] = cast(k, by.get(k));
    }
    // Validate http.port sane range; concurrency >=1
    if (out['queue.concurrency'] < 1) out['queue.concurrency'] = DEFAULTS['queue.concurrency'];
    if (out['http.port'] < 1024 || out['http.port'] > 65535) out['http.port'] = DEFAULTS['http.port'];
    return out;
  }

  get<K extends keyof FmbSettings>(key: K): FmbSettings[K] { return this.getAll()[key]; }

  /**
   * Apply a partial patch. Returns final settings object after patch.
   * For every changed key: writes kv_store + emits audit_log.
   * For side-effect keys: applies them immediately (e.g. queue.concurrency → setConcurrency()).
   */
  applyPatch(patch: Partial<FmbSettings & Record<string, unknown>>): FmbSettings {
    if (!this._initialized) this.init();
    const db = getRawDb();
    const before = this.getAll();
    const now = Date.now();
    const bus = getEventBus();
    // Validate each key against allowed set
    const allowedKeys = new Set<string>(KEYS as readonly string[]);
    const finalPatch: Partial<FmbSettings> = {};
    for (const k of Object.keys(patch)) {
      if (!allowedKeys.has(k)) {
        log.warn({ key: k }, 'settings.patch: ignoring unknown key');
        continue;
      }
      const v = (patch as any)[k];
      const raw = (typeof v === 'string') ? v : (v === undefined || v === null ? undefined : JSON.stringify(v));
      const casted = cast(k as keyof FmbSettings, raw as string | undefined | null);
      (finalPatch as any)[k] = casted;
    }
    // Insert into kv_store (UPSERT: sqlite3 supports ON CONFLICT DO UPDATE since 3.24)
    const upsert = db.prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    );
    for (const [k, v] of Object.entries(finalPatch)) {
      const str = (typeof v === 'string') ? v : JSON.stringify(v);
      upsert.run(k, str, now);
    }
    const after = this.getAll();
    // Audit log + event
    for (const k of Object.keys(finalPatch)) {
      const beforeVal = JSON.stringify((before as any)[k]);
      const afterVal = JSON.stringify((after as any)[k]);
      if (beforeVal === afterVal) continue;
      try {
        db.prepare(`INSERT INTO audit_logs (action, source, details_json, created_at, user_id, trace_id)
                    VALUES ('settings.change', 'settings', ?, ?, 'system', ?)`)
          .run(JSON.stringify({ key: k, before: (before as any)[k], after: (after as any)[k] }), now, `set-${k}-${now}`);
      } catch (e) { log.warn({ key: k, msg: (e as Error).message }, 'settings audit insert failed'); }
      void bus.safeEmit('settings.changed', {
        key: k as keyof FmbSettings,
        before: (before as any)[k],
        after: (after as any)[k],
      } satisfies { key: keyof FmbSettings; before: unknown; after: unknown },
      { source: 'settings', traceId: `set-${k}-${now}` });
    }
    return after;
  }
}

export function initSettingsService(): SettingsService {
  if (!singleton) singleton = new SettingsService();
  return singleton;
}
export function getSettingsService(): SettingsService {
  if (!singleton) return initSettingsService();
  return singleton;
}
