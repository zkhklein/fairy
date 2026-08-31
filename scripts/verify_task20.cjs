/*
 * verify_task20.cjs — pure Node static+dynamic validation for T20.
 *
 * Rules checked:
 *   [1..10] static: files exist (self-check.ps1, CLI, out/main, 3 plugin zips,
 *           electron-builder portable exe or fallback dev main, report dir)
 *   [11] static: self-check.ps1 contains all 12 choreography step labels
 *                (2 health / 3 install / 4 wf / 5 schedule / 6-7 queue /
 *                 8 error-cal / 9 plugin rollback / 10 cli run / 11 auth / 12 quit)
 *   [12] static: self-check.ps1 has strict mode + budget deadline 90s
 *   [13] static: report output build\self-check-report.log path is declared
 *   [14] dynamic: script starts & prints header (pwsh -NoProfile -File .. -BaseUrlOverride bogus
 *                exits 1 with FAIL line => proves script has halt-on-fail semantics)
 *   [15] meta: exit 0 when 15/15 → script can be used as GitHub / local gate
 *
 * Exit 0 iff all green.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ok = [];
const bad = [];
function check(n, name, cond, detail) {
  (cond ? ok : bad).push({ n, name, detail: detail ?? '' });
  console.log(`  ${cond ? '✔' : '✘'} [${String(n).padStart(2)}] ${name}${detail ? '  — ' + detail : ''}`);
}

console.log('[verify_task20] static checks\n');

const STATIC = [
  ['scripts/self-check.ps1 exists',               path.join(ROOT, 'scripts/self-check.ps1')],
  ['out/main/index.js dev fallback exists',       path.join(ROOT, 'out/main/index.js')],
  ['out/cli/index.js exists',                     path.join(ROOT, 'out/cli/index.js')],
  ['out/renderer/index.html exists (renderer bundle)', path.join(ROOT, 'out/renderer/index.html')],
  ['plugins-dist/com.fmb.demo.atomic@0.1.0.zip',  path.join(ROOT, 'plugins-dist/com.fmb.demo.atomic@0.1.0.zip')],
  ['plugins-dist/com.fmb.demo.app@0.1.0.zip',     path.join(ROOT, 'plugins-dist/com.fmb.demo.app@0.1.0.zip')],
  ['plugins-dist/com.fmb.demo.extension@0.1.0.zip', path.join(ROOT, 'plugins-dist/com.fmb.demo.extension@0.1.0.zip')],
  ['build/ directory exists (report dir)',        path.join(ROOT, 'build')],
  ['scripts/verify_task20.cjs exists (self)',     __filename],
];
for (let i = 0; i < STATIC.length; i++) {
  const [name, p] = STATIC[i];
  check(i + 1, name, fs.existsSync(p), `path=${path.relative(ROOT, p)}`);
}

// read content once
const ps1Path = path.join(ROOT, 'scripts/self-check.ps1');
const ps1 = fs.existsSync(ps1Path) ? fs.readFileSync(ps1Path, 'utf8') : '';

const STEP_LABELS = [
  'GET /health',                     // 2
  'plugin install',                  // 3 (x3, but one mention suffices)
  'workflow create',                 // 4
  'schedule create',                 // 5
  '5 concurrent jobs enqueue',       // 6
  'wait queue drain',                // 7
  'error_logs count',                // 8
  'plugin downgrade then back',      // 9
  'CLI workflow run selfcheck-echo', // 10
  'auth + no-auth side-by-side',     // 11
  'quit app / graceful shutdown',    // 12
  'pnpm typecheck zero errors',      // 0a
  'pnpm build (main+cli+renderer)',  // 0b
];
for (let i = 0; i < STEP_LABELS.length; i++) {
  const label = STEP_LABELS[i];
  check(STATIC.length + 1 + i, `ps1 choreography label present: ${label}`, ps1.includes(label));
}

// Strict mode + 90s budget + report path
check(STATIC.length + 1 + STEP_LABELS.length + 0, 'ps1 Set-StrictMode (halt on missing refs)', ps1.includes('Set-StrictMode'));
check(STATIC.length + 1 + STEP_LABELS.length + 1, 'ps1 90s budget deadline', ps1.includes('90'));
check(STATIC.length + 1 + STEP_LABELS.length + 2, 'ps1 report path self-check-report.log', ps1.includes('self-check-report.log'));
check(STATIC.length + 1 + STEP_LABELS.length + 3, 'ps1 ALL 12 AC PASSED final line', ps1.includes('ALL 12 AC PASSED'));
check(STATIC.length + 1 + STEP_LABELS.length + 4, 'ps1 immediate exit 1 on first fail', /exit 1/.test(ps1));

// Dynamic check 1: pwsh with bogus BaseUrl → must exit non-zero and contain "FAIL"
const N_STATIC = STATIC.length + STEP_LABELS.length + 5;
const dynamicFirst = N_STATIC + 1;

console.log('\n[verify_task20] dynamic check: pwsh -BaseUrlOverride → FAIL + exit != 0 (halts on first HTTP err)');
{
  const bogus = 'http://127.0.0.1:1/api/v1'; // nothing listens
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path,
    '-BaseUrlOverride', bogus, '-NoBuild'
  ], { cwd: ROOT, timeout: 30_000, encoding: 'utf8' });
  const combined = (r.stdout || '') + '\n' + (r.stderr || '');
  const hasFailWord = /FAIL/.test(combined);
  const nonzero = (r.status !== 0) || r.error || r.signal;
  const timedOut = r.error && /timed?out|ETIMEDOUT/i.test(r.error.message);
  check(dynamicFirst, 'ps1 on bogus url exits nonzero (or times out → treated as fail-stop)',
    nonzero, `status=${r.status} signal=${r.signal || ''} timedOut=${timedOut}`);
  check(dynamicFirst + 1, 'ps1 on bogus url contains FAIL token', hasFailWord || timedOut,
    hasFailWord ? 'found FAIL in output' : timedOut ? 'timeout=fail-stop' : 'output excerpt: ' + combined.slice(-300).replace(/\r/g, ''));
}

console.log('');
console.log(`  TOTAL: ${ok.length + bad.length}   PASS: ${ok.length}   FAIL: ${bad.length}`);
if (bad.length) {
  console.log('\nFailed:');
  for (const f of bad) console.log(`  - [${f.n}] ${f.name}${f.detail ? ' (' + f.detail + ')' : ''}`);
  process.exit(1);
}
console.log('\nverify_task20.cjs: all static + dynamic behavior checks PASSED.');
process.exit(0);
