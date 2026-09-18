/**
 * SchedulerService — cron-based task scheduling with SQLite persistence.
 *
 * Features:
 *   - CRUD for schedules (cron_expr or one_shot_at timestamp)
 *   - Startup recovery: load enabled schedules, detect missed runs
 *   - Misfire policies: run_now (immediately execute missed), skip (ignore), last_missed (run once)
 *   - nextRunTimes(scheduleId, n) — preview upcoming firing times
 *   - Pause/resume (toggle enabled)
 *
 * Uses setInterval(60s tick) + the built-in cron parser to check all
 * active schedules each minute. This is simpler and more reliable than
 * setTimeout per schedule (avoids drift and timer cleanup issues).
 */
import { nanoid } from 'nanoid';
import { getRawDb } from '../db';
import { createLogger } from '../logger';
import type { EventBusService } from '../event-bus';
import type { WorkflowService } from '../workflow/crud';
import { parseCron, nextRunTimes, type CronFields } from './cron-parser';
import type { Schedule } from '@shared/index';

const log = createLogger('scheduler');
const TICK_INTERVAL_MS = 10_000; // Check every 10s for sub-minute precision

export interface ScheduleRow {
  id: string;
  name: string;
  cron_expr: string | null;
  one_shot_at: number | null;
  workflow_id: string;
  input_json: string;
  enabled: 0 | 1;
  misfire_policy: 'run_now' | 'skip' | 'last_missed';
  timezone: string;
  last_fired_at: number | null;
  next_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateScheduleArgs {
  id?: string;
  name: string;
  cronExpr?: string | null;
  oneShotAtMs?: number | null;
  workflowId: string;
  input?: Record<string, unknown>;
  misfirePolicy?: 'run_now' | 'skip' | 'last_missed';
  timezone?: string;
  enabled?: boolean;
}

interface ActiveSchedule {
  row: ScheduleRow;
  cronFields: CronFields | null; // null for one-shot schedules
}

export class SchedulerService {
  private active = new Map<string, ActiveSchedule>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing = new Set<string>(); // Prevent concurrent fires of same schedule

  constructor(private bus: EventBusService, private workflowService: WorkflowService) {}

  // ---------------- CRUD ----------------

  create(args: CreateScheduleArgs): ScheduleRow {
    const db = getRawDb();
    const id = args.id ?? `sched-${nanoid(10)}`;
    const now = Date.now();

    if (!args.cronExpr && !args.oneShotAtMs) {
      throw new Error('Schedule must have either cronExpr or oneShotAtMs');
    }

    let cronFields: CronFields | null = null;
    if (args.cronExpr) {
      cronFields = parseCron(args.cronExpr); // Throws on invalid
    }

    const next = this.computeNextFire(cronFields, args.oneShotAtMs ?? null, now);

    db.prepare(
      `INSERT INTO schedules (id, name, cron_expr, one_shot_at, workflow_id, input_json, enabled, misfire_policy, timezone, last_fired_at, next_fired_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, args.name, args.cronExpr ?? null, args.oneShotAtMs ?? null,
      args.workflowId, JSON.stringify(args.input ?? {}), args.enabled === false ? 0 : 1,
      args.misfirePolicy ?? 'skip', args.timezone ?? 'UTC',
      null, next, now, now,
    );

    const row = this.getRow(id)!;
    if (row.enabled === 1) this.register(row);
    log.info({ id, name: args.name, cronExpr: args.cronExpr }, 'schedule created');
    return row;
  }

  get(id: string): ScheduleRow | null { return this.getRow(id); }
  list(params: { page?: number; pageSize?: number; enabled?: 0 | 1 } = {}): { items: ScheduleRow[]; total: number; page: number; pageSize: number } {
    const db = getRawDb();
    const sql = `SELECT * FROM schedules WHERE 1=1` +
      (params.enabled !== undefined ? ` AND enabled = @enabled` : ``) +
      ` ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all({ enabled: params.enabled }) as ScheduleRow[];
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return { items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
  }

  update(id: string, patch: Partial<Pick<ScheduleRow, 'name' | 'cron_expr' | 'one_shot_at' | 'workflow_id' | 'input_json' | 'enabled' | 'misfire_policy' | 'timezone'>>): ScheduleRow | null {
    const db = getRawDb();
    const current = this.get(id);
    if (!current) return null;
    const name = patch.name ?? current.name;
    const cron_expr = patch.cron_expr !== undefined ? patch.cron_expr : current.cron_expr;
    const one_shot_at = patch.one_shot_at !== undefined ? patch.one_shot_at : current.one_shot_at;
    const workflow_id = patch.workflow_id ?? current.workflow_id;
    const input_json = patch.input_json ?? current.input_json;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
    const misfire_policy = patch.misfire_policy ?? current.misfire_policy;
    const timezone = patch.timezone ?? current.timezone;
    const now = Date.now();

    let cronFields: CronFields | null = null;
    if (cron_expr) { cronFields = parseCron(cron_expr); }
    const next = enabled === 1 ? this.computeNextFire(cronFields, one_shot_at, now) : null;

    db.prepare(
      `UPDATE schedules SET name=?, cron_expr=?, one_shot_at=?, workflow_id=?, input_json=?, enabled=?, misfire_policy=?, timezone=?, next_fired_at=?, updated_at=? WHERE id=?`,
    ).run(name, cron_expr, one_shot_at, workflow_id, input_json, enabled, misfire_policy, timezone, next, now, id);

    // Re-register if active
    this.unregister(id);
    const row = this.getRow(id)!;
    if (row.enabled === 1) this.register(row);
    return row;
  }

  delete(id: string): boolean {
    const db = getRawDb();
    this.unregister(id);
    const info = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return info.changes > 0;
  }

  toggle(id: string, enabled: boolean): ScheduleRow | null {
    return this.update(id, { enabled: enabled ? 1 : 0 });
  }

  pause(id: string): ScheduleRow | null { return this.toggle(id, false); }
  resume(id: string): ScheduleRow | null { return this.toggle(id, true); }

  nextRunTimes(id: string, count = 5): Date[] {
    const row = this.get(id);
    if (!row || row.enabled !== 1) return [];
    if (row.cron_expr) {
      const fields = parseCron(row.cron_expr);
      return nextRunTimes(fields, count);
    }
    if (row.one_shot_at) return [new Date(row.one_shot_at)];
    return [];
  }

  // ---------------- Lifecycle ----------------

  /** Start the scheduler tick loop. Call after all schedules are loaded. */
  start(): void {
    if (this.timer) return;
    this.loadAll();
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    log.info({ activeCount: this.active.size }, 'scheduler started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.active.clear();
  }

  /** Load all enabled schedules from DB and register them. Also handles misfire recovery. */
  loadAll(): void {
    const db = getRawDb();
    const rows = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as ScheduleRow[];
    const now = Date.now();
    for (const row of rows) {
      // Misfire detection
      if (row.next_fired_at && row.next_fired_at < now) {
        const missed = row.misfire_policy;
        if (missed === 'run_now' || missed === 'last_missed') {
          log.info({ id: row.id, missedAt: row.next_fired_at, policy: missed }, 'misfire detected, executing immediately');
          // Fire immediately
          this.fireSchedule(row, now).catch(e => log.warn({ err: String(e) }, 'misfire execution failed'));
        }
        // Update next_fired_at
        let cronFields: CronFields | null = null;
        if (row.cron_expr) { try { cronFields = parseCron(row.cron_expr); } catch {} }
        const next = this.computeNextFire(cronFields, row.one_shot_at, now);
        db.prepare('UPDATE schedules SET next_fired_at=?, last_fired_at=?, updated_at=? WHERE id=?')
          .run(next, now, now, row.id);
        // Mirror onto the row before register() — otherwise the stale
        // next_fired_at would immediately satisfy checkShouldFire().
        row.next_fired_at = next;
        row.last_fired_at = now;
        if (row.one_shot_at) {
          // One-shot: disable after firing
          db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(row.id);
          continue;
        }
      }
      this.register(row);
    }
  }

  /** Register a schedule for active monitoring. */
  private register(row: ScheduleRow): void {
    let cronFields: CronFields | null = null;
    if (row.cron_expr) {
      try { cronFields = parseCron(row.cron_expr); } catch (e) {
        log.error({ id: row.id, err: (e as Error).message }, 'failed to parse cron expr, schedule disabled');
        return;
      }
    }
    this.active.set(row.id, { row, cronFields });
    log.info({ id: row.id, name: row.name, cron: row.cron_expr, oneShot: row.one_shot_at }, 'schedule registered');
  }

  private unregister(id: string): void {
    this.active.delete(id);
  }

  /** Main tick — check all active schedules against current time. */
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of Array.from(this.active.entries())) {
      if (this.firing.has(id)) continue;
      const shouldFire = this.checkShouldFire(entry, now);
      if (shouldFire) {
        this.firing.add(id);
        this.fireSchedule(entry.row, now)
          .catch(e => log.warn({ id, err: String(e) }, 'schedule fire failed'))
          .finally(() => this.firing.delete(id));
      }
    }
  }

  private checkShouldFire(entry: ActiveSchedule, now: number): boolean {
    const { row } = entry;
    // Fire only when the maintained next_fired_at has been reached. The value
    // is computed by computeNextFire() (strictly the next matching minute for
    // cron, or the one-shot timestamp) and mirrored onto entry.row after each
    // fire — so the 10s tick cannot re-fire multiple times within one matched
    // cron minute (previously matchesCron(now) re-fired ~6x per matched minute).
    return row.next_fired_at !== null && now >= row.next_fired_at;
  }

  /** Fire a schedule — emit event and execute the associated workflow. */
  private async fireSchedule(row: ScheduleRow, now: number): Promise<void> {
    const db = getRawDb();
    const traceId = nanoid(16);

    // Update last_fired_at
    let cronFields: CronFields | null = null;
    if (row.cron_expr) { try { cronFields = parseCron(row.cron_expr); } catch {} }
    const next = this.computeNextFire(cronFields, row.one_shot_at, now);

    db.prepare('UPDATE schedules SET last_fired_at=?, next_fired_at=?, updated_at=? WHERE id=?')
      .run(now, next, now, row.id);
    // Mirror onto the in-memory row so checkShouldFire() sees the fresh
    // next_fired_at on subsequent ticks (active map holds this same object).
    row.last_fired_at = now;
    row.next_fired_at = next;

    // Emit schedule.triggered with the full Schedule record (matches contract)
    await this.bus.safeEmit('schedule.triggered', { schedule: row as Schedule, fireTimeMs: now, traceId }, { traceId, source: 'scheduler' });

    // Execute workflow
    try {
      const input = JSON.parse(row.input_json || '{}');
      await this.workflowService.execute(row.workflow_id, { input, trigger: 'schedule', traceId });
      log.info({ id: row.id, workflowId: row.workflow_id, traceId }, 'schedule fired, workflow executed');
    } catch (e) {
      log.error({ id: row.id, err: (e as Error).message }, 'schedule fired but workflow execution failed');
    }

    // For one-shot schedules: disable after firing
    if (row.one_shot_at) {
      db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(row.id);
      this.unregister(row.id);
    }
  }

  private computeNextFire(cronFields: CronFields | null, oneShot: number | null, from: number): number | null {
    if (oneShot) return oneShot;
    if (cronFields) {
      const times = nextRunTimes(cronFields, 1, new Date(from));
      return times.length > 0 ? times[0].getTime() : null;
    }
    return null;
  }

  private getRow(id: string): ScheduleRow | null {
    const db = getRawDb();
    return (db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined) ?? null;
  }
}

// ---------------- Singleton ----------------
let _singleton: SchedulerService | null = null;
export function initSchedulerService(bus: EventBusService, workflowService: WorkflowService): SchedulerService {
  if (_singleton) return _singleton;
  _singleton = new SchedulerService(bus, workflowService);
  return _singleton;
}
export function getSchedulerService(): SchedulerService {
  if (!_singleton) throw new Error('SchedulerService not initialized');
  return _singleton;
}
