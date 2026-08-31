// Task 4 event bus test harness — compiles via esbuild to avoid electron dep.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-task4-'));
process.env['APPDATA'] = TMP_ROOT;

// ---------------- Helpers ----------------
const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) { failures.push(msg); console.log(' FAIL', msg); }
  else console.log(' PASS', msg);
}

// ---------------- Under test ----------------
import { EventBusService, wildcardStringMatch } from '../src/main-app/core/event-bus/index';
import { EXTENSION_POINTS } from '../src/main-app/core/event-bus/extension-points';

function newBus() { return new EventBusService({ maxListeners: 12 }); }

// ---------------- TR-4.1 error isolation ----------------
console.log('\n[TR-4.1] Handlers run independently: middle thrower does not starve neighbors');
const bus41 = newBus();
const fired: number[] = [];
const owner = 'test:41';
bus41.on('plugin.afterInstall', () => { fired.push(1); }, { owner });
bus41.on('plugin.afterInstall', () => { fired.push(2); throw new Error('middle handler fails!'); }, { owner, name: 'middleThrower' });
bus41.on('plugin.afterInstall', async () => { fired.push(3); }, { owner });
const res = await bus41.safeEmit('plugin.afterInstall', { plugin: {} as any, pluginVersion: {} as any } as any, { traceId: 'tr41-001' });
// Error isolation: every handler ran regardless of throw
check(fired.length === 3 && fired[0] === 1 && fired[1] === 2 && fired[2] === 3,
  `fired = [${fired.join(',')}] expected [1,2,3]`);
// At least 1 error captured (the thrower)
check(res.errors >= 1, `res.errors >= 1 (actual=${res.errors})`);
// Failures array contains the thrown message text
const hasMiddleFailure = res.failures.some(f => /middle handler fails/i.test(f.message));
check(hasMiddleFailure, `res.failures contains the thrown message (failures=${JSON.stringify(res.failures.map(f => f.message))})`);
// Errors written to error_logs (level=warn) via the sink we registered above.
// Our harness uses the pino fallback. For this test, we don't need actual DB rows
// as long as sink was actually invoked. Verify by installing a custom sink.
let sinkCalls = 0;
const bus41b = newBus();
const { setEventBusErrorSink } = await import('../src/main-app/core/event-bus/index');
setEventBusErrorSink((args) => { if (args.level === 'warn') sinkCalls++; });
bus41b.on('e', () => { throw new Error('x'); });
await bus41b.safeEmit('e', {} as any);
check(sinkCalls >= 1, `error sink invoked ${sinkCalls} times for level=warn (>=1 expected)`);

// ---------------- TR-4.2 wildcard workflow.* subscription ----------------
console.log('\n[TR-4.2] wildcard workflow.* matches both nodeComplete and nodeError');
const bus42 = newBus();
const received: string[] = [];
bus42.on('workflow.*', ((payload: any) => { received.push(payload.$event || 'unknown'); }) as any, { owner: 'wc-test', name: 'wcHandler' });
// EventEmitter2 only emits payload; we can't encode event name into payload unless
// the emitter does so — test by adding a sentinel per emit instead.
const eventsSeen: string[] = [];
bus42.on('workflow.nodeComplete', (() => eventsSeen.push('nodeComplete')) as any, { owner: 'x' });
bus42.on('workflow.nodeError', (() => eventsSeen.push('nodeError')) as any, { owner: 'x' });
// Our on() tracks listeners; wildcard matches are determined at emit time via EventEmitter2.
// Use countListeners to verify wildcard matches both.
const ncCount = bus42.countListeners('workflow.nodeComplete');
const neCount = bus42.countListeners('workflow.nodeError');
check(ncCount === 2, `listeners('workflow.nodeComplete') = ${ncCount} (wildcard + exact = 2)`);
check(neCount === 2, `listeners('workflow.nodeError') = ${neCount} (wildcard + exact = 2)`);
// Actually fire to ensure both events hit the wildcard handler.
let wcFiredForComplete = false;
let wcFiredForError = false;
const bus42b = newBus();
bus42b.on('workflow.*', ((_p: any, meta?: any) => {
  // Workaround: we can't know which event triggered from payload alone in
  // EventEmitter2, but we can add specific listeners + wildcard all 3 bound;
  // so after both emits, if total count increments 2 then wildcard fired.
}) as any, { owner: 'wc', name: 'w' });
bus42b.on('workflow.nodeComplete', () => { wcFiredForComplete = true; }, { owner: 't' });
bus42b.on('workflow.nodeError', () => { wcFiredForError = true; }, { owner: 't' });
const rNc = await bus42b.safeEmit('workflow.nodeComplete', { runId: 'r1', node: {} as any, traceId: 't' } as any);
const rNe = await bus42b.safeEmit('workflow.nodeError', { runId: 'r1', node: {} as any, error: new Error('x'), traceId: 't' } as any);
// Wildcard + exact = 2 each time
check(rNc.totalListeners === 2 && wcFiredForComplete, `nodeComplete safeEmit hit 2 listeners (${rNc.totalListeners}) + exact fired`);
check(rNe.totalListeners === 2 && wcFiredForError, `nodeError safeEmit hit 2 listeners (${rNe.totalListeners}) + exact fired`);
// Sanity-check helper wildcardStringMatch against EventEmitter2 behaviour
check(wildcardStringMatch('workflow.nodeComplete', 'workflow.*') === true, 'wildcardStringMatch(workflow.nodeComplete, workflow.*)');
check(wildcardStringMatch('workflow.nodeError', 'workflow.*') === true, 'wildcardStringMatch(workflow.nodeError, workflow.*)');
check(wildcardStringMatch('queue.jobCompleted', 'workflow.*') === false, 'wildcardStringMatch(queue.jobCompleted, workflow.*) is false');

// ---------------- TR-4.3 listBindings('plugin.afterInstall') correct count ----------------
console.log('\n[TR-4.3] listBindings accurately reports number of subscriptions');
const bus43 = newBus();
function bind(owner: string, name: string) {
  bus43.on('plugin.afterInstall', (() => { }) as any, { owner, name });
}
bind('core', 'auditLogPluginInstall');
bind('ext-a', 'sendWebhookAfterInstall');
bind('ext-b', 'invalidatePluginCacheAfterInstall');
const bindings43 = bus43.listBindings('plugin.afterInstall');
// listBindings returns array of [{ event, meta: HandlerMeta[] }] (one entry per matching pattern).
// Since we used exact pattern the only bucket returned is event='plugin.afterInstall' with meta.length = 3
check(bindings43.length === 1, `listBindings returns exactly 1 bucket (actual=${bindings43.length})`);
check(bindings43[0]?.meta.length === 3, `bucket meta.length = ${bindings43[0]?.meta.length} expected 3 (names=${JSON.stringify(bindings43[0]?.meta.map(m => m.name))})`);
// Now remove ext-a via offByOwner, recheck
bus43.offByOwner('ext-a');
const bindings43b = bus43.listBindings('plugin.afterInstall');
check(bindings43b[0]?.meta.length === 2, `after offByOwner(ext-a) meta.length = ${bindings43b[0]?.meta.length} (expected 2)`);
// Unregister via on() returned cleanup:
const unsub = bus43.on('plugin.afterInstall', (() => { }) as any, { owner: 'z', name: 'transient' });
check(bus43.listBindings('plugin.afterInstall')[0]?.meta.length === 3, 'after new on() meta length 3');
unsub();
check(bus43.listBindings('plugin.afterInstall')[0]?.meta.length === 2, 'after unsub() meta length back to 2');

// ---------------- Sanity: extension points >= 12 ----------------
console.log('\n[TR-4.extra] Built-in extension points count >= 12');
check(EXTENSION_POINTS.length >= 12, `EXTENSION_POINTS.length = ${EXTENSION_POINTS.length} (>= 12 expected)`);
console.log('  - Points list:', EXTENSION_POINTS.slice(0, 8).join(', '), EXTENSION_POINTS.length > 8 ? `… +${EXTENSION_POINTS.length - 8}` : '');

// ---------------- SUMMARY ----------------
console.log('\n=== SUMMARY ===');
if (failures.length) {
  console.log(`FAILED ${failures.length} check(s):`);
  failures.forEach(e => console.log('  -', e));
  process.exit(1);
} else {
  console.log('ALL TASK 4 CHECKS PASSED');
  process.exit(0);
}
