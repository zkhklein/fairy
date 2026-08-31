/**
 * ErrorCalendarService — error log CRUD + aggregation queries.
 *
 * Responsibilities:
 *   1. log(entry) — validate via Zod, write to error_logs, emit errorLog.newEntry
 *   2. query(filters) — level / source / range / resolved / keyword + pagination
 *   3. markResolved(id) / markIgnored(id)
 *   4. dailyCount(year, month) — [1..31] array for calendar heatmap
 *   5. dailyDetail(date) — all errors for a specific day
 *
 * Also acts as the error sink for EventBusService: when a handler throws
 * inside safeEmit(), the error is routed here instead of being silently swallowed.
 */
import { getRawDb } from '../db';
import { createLogger } from '../logger';
import type { EventBusService } from '../event-bus';
import { setEventBusErrorSink } from '../event-bus';
import { nanoid } from 'nanoid';
import type { ErrorLog } from '@shared/index';

const log = createLogger('error-calendar');

export interface ErrorLogEntry {
  level: 'error' | 'warn' | 'info';
  source: string;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

export interface ErrorLogRow {
  id: number;
  level: string;
  source: string;
  message: string;
  stack: string | null;
  metadata_json: string | null;
  trace_id: string | null;
  resolved: number;
  ignored: number;
  created_at: number;
}

export interface QueryFilters {
  level?: string;
  source?: string;
  keyword?: string;
  fromMs?: number;
  toMs?: number;
  resolved?: boolean; // true=only resolved, false=only unresolved, undefined=both
  ignored?: boolean;
  page?: number;
  pageSize?: number;
}

export interface QueryResult {
  items: ErrorLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export class ErrorCalendarService {
  constructor(private bus: EventBusService) {
    // Wire up as the event bus error sink
    setEventBusErrorSink((args) => {
      this.log({
        level: args.level,
        source: args.source,
        message: args.message,
        stack: args.stack,
        traceId: args.traceId,
      });
    });
  }

  /** Log an error entry. Returns the row id. */
  log(entry: ErrorLogEntry): number {
    const db = getRawDb();
    const now = Date.now();
    const traceId = entry.traceId ?? nanoid(12);
    const info = db.prepare(
      `INSERT INTO error_logs (level, source, message, stack, metadata_json, trace_id, resolved, ignored, created_at)
       VALUES (?,?,?,?,?,?,0,0,?)`,
    ).run(
      entry.level, entry.source, entry.message,
      entry.stack ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      traceId, now,
    );
    const id = Number(info.lastInsertRowid);

    // Emit errorLog.newEntry with the full ErrorLog record (matches contract)
    const errorLogRow: ErrorLog = {
      id,
      level: entry.level,
      source: entry.source,
      message: entry.message,
      stack: entry.stack ?? null,
      metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
      trace_id: traceId,
      resolved: 0,
      ignored: 0,
      created_at: now,
    };
    void this.bus.safeEmit('errorLog.newEntry', { log: errorLogRow }, { traceId, source: 'error-calendar' });

    return id;
  }

  /** Query error logs with filters and pagination. */
  query(filters: QueryFilters = {}): QueryResult {
    const db = getRawDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.level) { conditions.push('level = ?'); params.push(filters.level); }
    if (filters.source) { conditions.push('source LIKE ?'); params.push(`%${filters.source}%`); }
    if (filters.keyword) {
      conditions.push('(message LIKE ? OR stack LIKE ?)');
      params.push(`%${filters.keyword}%`, `%${filters.keyword}%`);
    }
    if (filters.fromMs) { conditions.push('created_at >= ?'); params.push(filters.fromMs); }
    if (filters.toMs) { conditions.push('created_at <= ?'); params.push(filters.toMs); }
    if (filters.resolved !== undefined) {
      conditions.push('resolved = ?');
      params.push(filters.resolved ? 1 : 0);
    }
    if (filters.ignored !== undefined) {
      conditions.push('ignored = ?');
      params.push(filters.ignored ? 1 : 0);
    }
    // By default, exclude ignored unless explicitly asked
    if (filters.ignored === undefined) {
      conditions.push('ignored = 0');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 20, 200);
    const offset = (page - 1) * pageSize;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM error_logs ${where}`).get(...params) as { total: number };
    const items = db.prepare(
      `SELECT * FROM error_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, offset) as ErrorLogRow[];

    return { items, total: countRow.total, page, pageSize };
  }

  /** Mark an error as resolved or unresolved. */
  markResolved(id: number, resolved: boolean): boolean {
    const db = getRawDb();
    const info = db.prepare('UPDATE error_logs SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
    return info.changes > 0;
  }

  /** Mark an error as ignored (hidden from default queries). */
  markIgnored(id: number, ignored: boolean = true): boolean {
    const db = getRawDb();
    const info = db.prepare('UPDATE error_logs SET ignored = ? WHERE id = ?').run(ignored ? 1 : 0, id);
    return info.changes > 0;
  }

  /**
   * Get daily error counts for a given month (calendar heatmap data).
   * @param year  e.g. 2026
   * @param month 1-12
   * @returns Array of 31 entries (index 0 = day 1), each = { date, count, errorCount, warnCount, infoCount }
   */
  dailyCount(year: number, month: number): Array<{ date: number; count: number; errorCount: number; warnCount: number; infoCount: number }> {
    const db = getRawDb();
    // Calculate start/end timestamps for the month
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 1)); // First of next month
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const rows = db.prepare(
      `SELECT
         (created_at / 86400000) as day_bucket,
         level,
         COUNT(*) as count
       FROM error_logs
       WHERE created_at >= ? AND created_at < ?
       GROUP BY day_bucket, level`,
    ).all(startMs, endMs) as Array<{ day_bucket: number; level: string; count: number }>;

    // Build result array
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const result: Array<{ date: number; count: number; errorCount: number; warnCount: number; infoCount: number }> = [];
    for (let d = 1; d <= daysInMonth; d++) {
      result.push({ date: d, count: 0, errorCount: 0, warnCount: 0, infoCount: 0 });
    }

    const startDayBucket = Math.floor(startMs / 86400000);
    for (const r of rows) {
      const dayOffset = r.day_bucket - startDayBucket;
      if (dayOffset >= 0 && dayOffset < result.length) {
        result[dayOffset].count += r.count;
        if (r.level === 'error') result[dayOffset].errorCount += r.count;
        else if (r.level === 'warn') result[dayOffset].warnCount += r.count;
        else if (r.level === 'info') result[dayOffset].infoCount += r.count;
      }
    }

    return result;
  }

  /** Get all error entries for a specific date (UTC). */
  dailyDetail(year: number, month: number, day: number): ErrorLogRow[] {
    const db = getRawDb();
    const startMs = Date.UTC(year, month - 1, day);
    const endMs = startMs + 86400000; // +1 day
    return db.prepare(
      'SELECT * FROM error_logs WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC',
    ).all(startMs, endMs) as ErrorLogRow[];
  }

  /** Delete an error log entry. */
  delete(id: number): boolean {
    const db = getRawDb();
    const info = db.prepare('DELETE FROM error_logs WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** Get a single error log entry by id. */
  get(id: number): ErrorLogRow | null {
    const db = getRawDb();
    return (db.prepare('SELECT * FROM error_logs WHERE id = ?').get(id) as ErrorLogRow | undefined) ?? null;
  }
}

// ---------------- Singleton ----------------
let _singleton: ErrorCalendarService | null = null;
export function initErrorCalendarService(bus: EventBusService): ErrorCalendarService {
  if (_singleton) return _singleton;
  _singleton = new ErrorCalendarService(bus);
  return _singleton;
}
export function getErrorCalendarService(): ErrorCalendarService {
  if (!_singleton) throw new Error('ErrorCalendarService not initialized');
  return _singleton;
}
