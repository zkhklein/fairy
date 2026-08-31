/**
 * Queue max_attempts contract tests (TDD RED phase harness).
 *
 * Validates:
 *   - AC Q1: enqueue(maxAttempts = 0 | -1 | undefined) stores a *positive* max_attempts.
 *   - AC Q2: list() return items pass PagedSchema(JobViewModelSchema) (Zod safeParse).
 *   - AC Q3: legacy DB rows with max_attempts <= 0 are normalized on read so IPC
 *     never emits a schema violation for historical data.
 *
 * Pure Node harness. Uses same electron-stub esbuild alias pipeline as the
 * fault-injection test. Run via:
 *   node scripts/_build-queue-test.mjs && node build/queue-max-attempts.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

// ---------- Bootstrap: isolated userData ----------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-qma-'));
fs.mkdirSync(path.join(TMP_ROOT, 'logs'), { recursive: true });
process.env['FMB_FORCE_USERDATA'] = TMP_ROOT;
process.env['FMB_FORCE_DB_TEST_PATH'] = path.join(TMP_ROOT, 'fmb.db');
process.env['ELECTRON_RUN_AS_NODE'] = '1';

// ---------- Imports ----------
import { initDatabase, closeDatabase, getRawDb } from '../src/main-app/core/db';
import { initEventBus } from '../src/main-app/core/event-bus';
import { initQueueService, getQueueService } from '../src/main-app/core/queue/service';
import { JobViewModelSchema, PagedSchema } from '../src/shared/types';

// ---------- Harness helpers ----------
type CaseResult = { id: string; pass: boolean; note?: string };
const results: CaseResult[] = [];
function case_(id: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(
      () => { results.push({ id, pass: true }); console.log(`✓ ${id} PASS`); },
      (err: unknown) => { results.push({ id, pass: false, note: err instanceof Error ? err.message : String(err) }); console.log(`✗ ${id} FAIL - ${err instanceof Error ? err.message : String(err)}`); },
    );
}

// ---------- Setup ----------
console.log(`[BOOT] tmpRoot=${TMP_ROOT}`);
initDatabase();
const bus = initEventBus();
const queueSvc = initQueueService(bus);
queueSvc.stop(); // dispatcher not needed for schema tests

async function main(): Promise<void> {
  // Q1: enqueue with explicit 0 / -1 / undefined must yield positive max_attempts.
  const cases0: Array<{ id: string; arg: number | undefined; min?: number }> = [
    { id: 'Q1-undef-defaults', arg: undefined, min: 1 },
    { id: 'Q1-zero-clamped', arg: 0, min: 1 },
    { id: 'Q1-negative-clamped', arg: -1, min: 1 },
    { id: 'Q1-valid-kept', arg: 5, min: 5 },
  ];
  for (const c of cases0) {
    await case_(c.id, () => {
      const row = queueSvc.enqueue({ type: 'system', payload: { i: c.id }, maxAttempts: c.arg });
      assert.ok(row.max_attempts >= c.min!, `expected max_attempts >= ${c.min}, got ${row.max_attempts}`);
      assert.equal(Number.isInteger(row.max_attempts), true);
    });
  }

  // Q2: list() must pass PagedSchema(JobViewModelSchema) safeParse.
  await case_('Q2-list-schema-valid', () => {
    queueSvc.enqueue({ type: 'atomic_call', payload: { n: 1, handler: 'p/a' }, maxAttempts: 0 });
    queueSvc.enqueue({ type: 'workflow_run', payload: { id: 'wf-1' }, maxAttempts: -2 });
    const page = queueSvc.list({ page: 1, pageSize: 50 });
    // Also wrap with payload parsing to match JobViewModelSchema extension.
    const vm = {
      items: page.items.map((j) => ({
        ...j,
        payload: (() => { try { return JSON.parse(j.payload_json); } catch { return {}; } })(),
      })),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
    const parsed = PagedSchema(JobViewModelSchema).safeParse(vm);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      throw new Error(msg);
    }
  });

  // Q3: legacy DB row with max_attempts <= 0 must still validate via list().
  await case_('Q3-legacy-row-normalized', () => {
    const db = getRawDb();
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO job_queue (type, payload_json, priority, status, attempts, max_attempts, retry_backoff, run_after, trace_id)
       VALUES (?,?,?,?,0,0,'exponential',0,?)`,
    ).run('system', JSON.stringify({ legacy: true }), 0, 'failed', 'legacy-trace');
    const legacyId = Number(info.lastInsertRowid);
    const page = queueSvc.list({ page: 1, pageSize: 500 });
    const legacy = page.items.find((r) => r.id === legacyId);
    assert.ok(legacy, `legacy row id=${legacyId} should be present`);
    const vm = {
      ...legacy,
      payload: JSON.parse(legacy.payload_json),
    };
    const parsed = JobViewModelSchema.safeParse(vm);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      throw new Error(msg);
    }
    // Ensure the normalization didn't mutate DB's stored value (0 must remain 0
    // in storage — normalization is read-time only).
    const stored = db.prepare('SELECT max_attempts FROM job_queue WHERE id=?').get(legacyId) as { max_attempts: number };
    assert.equal(stored.max_attempts, 0, 'stored max_attempts should remain untouched at 0');
  });

  // ---------- Summary ----------
  console.log('');
  console.log('=== SUMMARY ===');
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log(` PASS ${r.id}`); }
    else { fail++; console.log(` FAIL ${r.id}  - ${r.note ?? ''}`); }
  }
  console.log(`pass=${pass} fail=${fail} total=${results.length}`);
  closeDatabase();
  if (fail > 0) process.exit(1);
}

void main();
