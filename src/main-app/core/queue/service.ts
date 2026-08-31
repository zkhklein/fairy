/**
 * QueueService — SQLite-persisted job queue with priority, concurrency,
 * retry, dead-letter handling, and crash recovery.
 *
 * Design:
 *   - All state persisted in job_queue table (no Redis, no external deps)
 *   - Priority: 0-9 (higher = processed first); within same priority, FIFO by id
 *   - Concurrency: configurable global max (default 4); enforced by dispatcher loop
 *   - Retry: fixed or exponential backoff; max_attempts per job
 *   - Dead letter: status=dead after max_attempts exhausted
 *   - Crash recovery: on start(), all status=running jobs are reset to pending
 *   - Worker execution: in-process async (worker_threads would add complexity
 *     for the SQLite-only constraint; jobs run in main process via handler registry)
 *
 * Job handler registry: callers register handlers by job type.
 *   queue.registerHandler('workflow_run', async (payload) => { ... })
 */
import { nanoid } from 'nanoid';
import { getRawDb } from '../db';
import { createLogger } from '../logger';
import type { EventBusService } from '../event-bus';
import { Mutex } from './mutex';
import type { Job, JobType, JobRetryBackoff } from '@shared/index';

const log = createLogger('queue');
const DISPATCHER_INTERVAL_MS = 500; // Poll every 500ms

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export interface EnqueueArgs {
  type: 'workflow_run' | 'atomic_call' | 'system';
  payload: Record<string, unknown>;
  priority?: number; // 0-9
  maxAttempts?: number;
  retryBackoff?: 'fixed' | 'exponential';
  runAfterMs?: number;
  traceId?: string;
}

export interface JobRow {
  id: number;
  type: JobType;
  payload_json: string;
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  retry_backoff: JobRetryBackoff;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  worker_id: string | null;
  run_after: number;
  trace_id: string | null;
}

export interface QueueMetrics {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  dead: number;
}

/**
 * Normalize a raw job_queue row to match the published JobSchema contract:
 *   - max_attempts must be a positive integer (>= 1). Legacy DB rows or buggy
 *     callers may have written 0 / negative values; we clamp at read time so
 *     IPC/HTTP results never violate the Zod schema, without mutating the
 *     stored historical value (audit integrity preserved).
 *   - priority / attempts are coerced to safe integers because SQLite may
 *     return non-int or NULL on older dumps.
 *   - run_after / payload_json defaults are applied for the same reason.
 */
function normalizeRow(raw: any): JobRow {
  const r: any = raw ?? {};
  return {
    id: Number(r.id) || 0,
    type: r.type ?? 'system',
    payload_json: typeof r.payload_json === 'string' ? r.payload_json : '{}',
    priority: Math.max(0, Math.min(9, Number.isFinite(Number(r.priority)) ? Number(r.priority) : 0)),
    status: (['pending', 'running', 'completed', 'failed', 'dead'] as const).includes(r.status)
      ? r.status
      : 'pending',
    attempts: Math.max(0, Number.isFinite(Number(r.attempts)) ? Number(r.attempts) : 0),
    max_attempts: Math.max(1, Number.isFinite(Number(r.max_attempts)) ? Number(r.max_attempts) : 3),
    retry_backoff: r.retry_backoff === 'fixed' ? 'fixed' : 'exponential',
    started_at: (r.started_at == null) ? null : (Number.isFinite(Number(r.started_at)) ? Number(r.started_at) : null),
    finished_at: (r.finished_at == null) ? null : (Number.isFinite(Number(r.finished_at)) ? Number(r.finished_at) : null),
    last_error: (r.last_error == null) ? null : String(r.last_error),
    worker_id: (r.worker_id == null) ? null : String(r.worker_id),
    run_after: Math.max(0, Number.isFinite(Number(r.run_after)) ? Number(r.run_after) : 0),
    trace_id: (r.trace_id == null) ? null : String(r.trace_id),
  };
}

export class QueueService {
  private handlers = new Map<string, JobHandler>();
  private mutex = new Mutex();
  private timer: ReturnType<typeof setInterval> | null = null;
  private concurrency = 4;
  private runningCount = 0;

  constructor(private bus: EventBusService) {}

  // ---------------- Handler registry ----------------

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  list(params: { page?: number; pageSize?: number; type?: string; status?: 'pending' | 'running' | 'completed' | 'failed' | 'dead' } = {}): { items: JobRow[]; total: number; page: number; pageSize: number } {
    const db = getRawDb();
    const sql = `SELECT * FROM job_queue WHERE 1=1` +
      (params.type ? ` AND type = @type` : ``) +
      (params.status ? ` AND status = @status` : ``) +
      ` ORDER BY id DESC`;
    const rows = db.prepare(sql).all({ type: params.type, status: params.status }) as any[];
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return { items: rows.slice(start, start + pageSize).map(normalizeRow), total: rows.length, page, pageSize };
  }

  cancel(id: number): JobRow {
    const db = getRawDb();
    const now = Date.now();
    db.prepare(`UPDATE job_queue SET status='dead', last_error='cancelled via UI', finished_at=? WHERE id=? AND status IN ('pending','running')`)
      .run(now, id);
    const row = this.getJob(id);
    if (!row) throw new Error(`Job ${id} not found`);
    return row;
  }

  retry(id: number): JobRow {
    const db = getRawDb();
    db.prepare(`UPDATE job_queue SET status='pending', attempts=0, last_error=NULL, started_at=NULL, finished_at=NULL, worker_id=NULL, run_after=? WHERE id=? AND status IN ('failed','dead')`)
      .run(Date.now(), id);
    const row = this.getJob(id);
    if (!row) throw new Error(`Job ${id} not found`);
    void this.dispatch();
    return row;
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
    log.info({ concurrency: n }, 'concurrency updated');
  }

  getConcurrency(): number { return this.concurrency; }

  // ---------------- Enqueue / Dequeue ----------------

  enqueue(args: EnqueueArgs): JobRow {
    const db = getRawDb();
    const now = Date.now();
    const payloadJson = JSON.stringify(args.payload);
    const priority = Math.max(0, Math.min(9, args.priority ?? 0));
    // maxAttempts must be >= 1 to match JobSchema.positive(); explicit 0 /
    // negative inputs are silently upgraded to 1 (same behavior as Zod default
    // of 3 but stricter: guarantee at-least-once semantics).
    const rawMax = args.maxAttempts ?? 3;
    const maxAttempts = Math.max(1, Number.isFinite(Number(rawMax)) ? Number(rawMax) : 3);
    const retryBackoff = args.retryBackoff ?? 'exponential';
    const runAfter = args.runAfterMs ? now + args.runAfterMs : 0;
    const traceId = args.traceId ?? nanoid(16);

    const info = db.prepare(
      `INSERT INTO job_queue (type, payload_json, priority, status, attempts, max_attempts, retry_backoff, run_after, trace_id)
       VALUES (?,?,?,?,0,?,?,?,?)`,
    ).run(args.type, payloadJson, priority, 'pending', maxAttempts, retryBackoff, runAfter, traceId);

    const id = Number(info.lastInsertRowid);
    const row = this.getJob(id)!;

    // Emit jobEnqueued with the full Job record (matches contract)
    void this.bus.safeEmit('queue.jobEnqueued', { job: row as Job, traceId }, { traceId, source: 'queue' });

    log.info({ id, type: args.type, priority }, 'job enqueued');
    return row;
  }

  getJob(id: number): JobRow | null {
    const db = getRawDb();
    const raw = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(id) as any;
    return raw ? normalizeRow(raw) : null;
  }

  listJobs(status?: string): JobRow[] {
    const db = getRawDb();
    const rows = status
      ? (db.prepare('SELECT * FROM job_queue WHERE status = ? ORDER BY id DESC LIMIT 100').all(status) as any[])
      : (db.prepare('SELECT * FROM job_queue ORDER BY id DESC LIMIT 100').all() as any[]);
    return rows.map(normalizeRow);
  }

  // ---------------- Metrics ----------------

  metrics(): QueueMetrics {
    const db = getRawDb();
    const rows = db.prepare('SELECT status, COUNT(*) as count FROM job_queue GROUP BY status').all() as Array<{ status: string; count: number }>;
    const m: QueueMetrics = { pending: 0, running: 0, completed: 0, failed: 0, dead: 0 };
    for (const r of rows) {
      if (r.status in m) (m as any)[r.status] = r.count;
    }
    return m;
  }

  // ---------------- Dead letter ----------------

  retryDeadJobs(): number {
    const db = getRawDb();
    const info = db.prepare("UPDATE job_queue SET status='pending', attempts=0, run_after=0 WHERE status='dead'").run();
    log.info({ count: info.changes }, 'dead jobs retried');
    return info.changes;
  }

  clearDead(): number {
    const db = getRawDb();
    const info = db.prepare("DELETE FROM job_queue WHERE status='dead'").run();
    log.info({ count: info.changes }, 'dead jobs cleared');
    return info.changes;
  }

  // ---------------- Lifecycle ----------------

  /** Start the dispatcher. On start, recover any stuck running jobs. */
  start(): void {
    if (this.timer) return;
    this.recoverStuckJobs();
    this.timer = setInterval(() => this.dispatch(), DISPATCHER_INTERVAL_MS);
    log.info({ concurrency: this.concurrency }, 'queue dispatcher started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    log.info('queue dispatcher stopped');
  }

  /** Reset all running jobs to pending (crash recovery). */
  recoverStuckJobs(): void {
    const db = getRawDb();
    const info = db.prepare("UPDATE job_queue SET status='pending', started_at=NULL, worker_id=NULL WHERE status='running'").run();
    if (info.changes > 0) {
      log.info({ count: info.changes }, 'stuck running jobs recovered to pending');
    }
  }

  // NOTE: cancel() is implemented earlier in this class (matches JobSchema return contract)

  // ---------------- Dispatcher ----------------

  private async dispatch(): Promise<void> {
    while (this.runningCount < this.concurrency) {
      const job = await this.mutex.runExclusive(async () => this.dequeue());
      if (!job) break;
      // Fire and forget — track running count
      this.runningCount++;
      this.executeJob(job)
        .catch(e => log.error({ id: job.id, err: (e as Error).message }, 'unexpected executor error'))
        .finally(() => { this.runningCount--; });
    }
  }

  /** Atomically dequeue the highest-priority pending job. */
  private dequeue(): JobRow | null {
    const db = getRawDb();
    const now = Date.now();
    const row = db.prepare(
      `SELECT * FROM job_queue WHERE status='pending' AND run_after <= ? ORDER BY priority DESC, id ASC LIMIT 1`,
    ).get(now) as JobRow | undefined;
    if (!row) return null;

    const workerId = nanoid(8);
    db.prepare(
      "UPDATE job_queue SET status='running', started_at=?, worker_id=?, attempts=attempts+1 WHERE id=? AND status='pending'",
    ).run(now, workerId, row.id);

    // Verify we won the race (status was pending when we wrote)
    const updated = this.getJob(row.id);
    if (!updated || updated.status !== 'running' || updated.worker_id !== workerId) {
      // Lost the race — another dispatcher grabbed it
      return null;
    }
    return updated;
  }

  /** Execute a single job with retry handling. */
  private async executeJob(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.markFailed(job, new Error(`No handler registered for job type "${job.type}"`));
      return;
    }

    try {
      const payload = JSON.parse(job.payload_json || '{}');
      const result = await handler(payload);
      this.markCompleted(job, result);
    } catch (e) {
      const err = e as Error;
      log.warn({ id: job.id, attempts: job.attempts, max: job.max_attempts, err: err.message }, 'job failed');
      // Check if retries remaining
      if (job.attempts >= job.max_attempts) {
        this.markDead(job, err);
      } else {
        this.markFailedAndRequeue(job, err);
      }
    }
  }

  private markCompleted(job: JobRow, _result: unknown): void {
    const db = getRawDb();
    db.prepare("UPDATE job_queue SET status='completed', finished_at=? WHERE id=?").run(Date.now(), job.id);
    void this.bus.safeEmit('queue.jobCompleted', { job: job as Job, traceId: job.trace_id ?? undefined }, { traceId: job.trace_id ?? undefined, source: 'queue' });
    log.info({ id: job.id, type: job.type }, 'job completed');
  }

  private markFailed(job: JobRow, err: Error): void {
    const db = getRawDb();
    db.prepare("UPDATE job_queue SET status='failed', last_error=?, finished_at=? WHERE id=?").run(err.message, Date.now(), job.id);
    void this.bus.safeEmit('queue.jobFailed', { job: job as Job, error: err, traceId: job.trace_id ?? undefined }, { traceId: job.trace_id ?? undefined, source: 'queue' });
    log.warn({ id: job.id, err: err.message }, 'job marked failed');
  }

  private markDead(job: JobRow, err: Error): void {
    const db = getRawDb();
    db.prepare("UPDATE job_queue SET status='dead', last_error=?, finished_at=? WHERE id=?").run(err.message, Date.now(), job.id);
    void this.bus.safeEmit('queue.jobFailed', { job: job as Job, error: err, traceId: job.trace_id ?? undefined }, { traceId: job.trace_id ?? undefined, source: 'queue' });
    log.error({ id: job.id, attempts: job.attempts, err: err.message }, 'job marked dead (max attempts exhausted)');
  }

  private markFailedAndRequeue(job: JobRow, err: Error): void {
    const db = getRawDb();
    // Calculate backoff delay
    const attempts = job.attempts; // already incremented by dequeue
    const baseDelay = 1000; // 1s base
    const delay = job.retry_backoff === 'exponential'
      ? baseDelay * Math.pow(2, attempts - 1)
      : baseDelay;
    const runAfter = Date.now() + delay;

    db.prepare(
      "UPDATE job_queue SET status='pending', last_error=?, started_at=NULL, worker_id=NULL, run_after=? WHERE id=?",
    ).run(err.message, runAfter, job.id);

    log.info({ id: job.id, attempts, runAfter, delayMs: delay }, 'job requeued for retry');
  }
}

// ---------------- Singleton ----------------
let _singleton: QueueService | null = null;
export function initQueueService(bus: EventBusService): QueueService {
  if (_singleton) return _singleton;
  _singleton = new QueueService(bus);
  return _singleton;
}
export function getQueueService(): QueueService {
  if (!_singleton) throw new Error('QueueService not initialized');
  return _singleton;
}
