/**
 * Scheduler tick dedup tests — guards the fix for "cron schedule re-fires on
 * every 10s tick within a matched minute".
 *
 * Validates:
 *   - AC S1: a cron schedule whose fire time is reached fires exactly ONCE per
 *     matched minute, even when tick() runs multiple times in that minute.
 *   - AC S2: after firing, the in-memory next_fired_at is advanced beyond now
 *     (so the next tick in the same minute does not re-fire).
 *   - AC S3: DB next_fired_at matches the in-memory value after firing.
 *
 * Harness pattern mirrors queue-max-attempts.test.ts. Run via:
 *   node scripts/_build-scheduler-test.mjs && node build/scheduler-tick-dedup.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

// ---------- Bootstrap: isolated userData ----------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-sched-'));
fs.mkdirSync(path.join(TMP_ROOT, 'logs'), { recursive: true });
process.env['FMB_DB_PATH'] = path.join(TMP_ROOT, 'fmb.db');
process.env['ELECTRON_RUN_AS_NODE'] = '1';

// ---------- Imports ----------
import { initDatabase, closeDatabase, getRawDb } from '../src/main-app/core/db';
import { initEventBus } from '../src/main-app/core/event-bus';
import { initSchedulerService } from '../src/main-app/core/scheduler/service';
import type { WorkflowService } from '../src/main-app/core/workflow/crud';

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
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ---------- Setup ----------
console.log(`[BOOT] tmpRoot=${TMP_ROOT}`);
initDatabase();
const bus = initEventBus();

let executeCount = 0;
const wfStub = {
  execute: async () => { executeCount++; return { runId: 'run-stub', status: 'success' as const, output: null }; },
};
const sched = initSchedulerService(bus, wfStub as unknown as WorkflowService);
// NOTE: do NOT call sched.start() — we drive tick() manually.

// schedules.workflow_id has FK → workflows(id): seed a dummy workflow row.
getRawDb()
  .prepare(`INSERT INTO workflows (id, name, description, definition_json, vars_json, owner_plugin_id, created_at, updated_at)
            VALUES ('wf-test', 'wf-test', '', '{"nodes":[],"edges":[],"entryNode":""}', '{}', NULL, ?, ?)`)
  .run(Date.now(), Date.now());

// tick once, then wait for the fire-and-forget fireSchedule() to settle so the
// `firing` guard clears (mirrors real 10s tick spacing, just faster).
async function tickAndSettle(svc: unknown): Promise<void> {
  await (svc as { tick: () => Promise<void> }).tick();
  await sleep(80);
}

async function main(): Promise<void> {
  // Cron '* * * * *' matches EVERY minute — worst case for the old bug
  // (old code fired on every tick while the current minute matched).
  const row = sched.create({ name: 'test-every-minute', cronExpr: '* * * * *', workflowId: 'wf-test' });

  // Simulate "fire time reached" without waiting a real minute: pin the
  // in-memory next_fired_at to now (the active map entry is the same object
  // checkShouldFire reads).
  const svcAny = sched as unknown as { active: Map<string, { row: { next_fired_at: number | null } }>; tick: () => Promise<void> };
  const entry = svcAny.active.get(row.id)!;
  assert.ok(entry, 'schedule should be registered in active map');
  entry.row.next_fired_at = Date.now();

  await case_('S1-fires-once-per-matched-minute', async () => {
    const before = executeCount;
    await tickAndSettle(svcAny);
    await tickAndSettle(svcAny);
    await tickAndSettle(svcAny);
    const fired = executeCount - before;
    assert.equal(fired, 1, `expected exactly 1 fire across 3 same-minute ticks, got ${fired}`);
  });

  await case_('S2-memory-next-fire-advanced', () => {
    const next = entry.row.next_fired_at;
    assert.ok(next !== null && next > Date.now(), `next_fired_at should be in the future, got ${next}`);
  });

  await case_('S3-db-next-fire-matches-memory', () => {
    const db = getRawDb();
    const stored = db.prepare('SELECT next_fired_at, last_fired_at FROM schedules WHERE id = ?').get(row.id) as { next_fired_at: number | null; last_fired_at: number | null };
    assert.equal(stored.next_fired_at, entry.row.next_fired_at, 'DB next_fired_at must equal in-memory value');
    assert.ok(stored.last_fired_at !== null, 'last_fired_at should be recorded');
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
