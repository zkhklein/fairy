/**
 * FMB dev runner — orchestrates esbuild:main watch + electron-vite dev in parallel.
 *
 * Responsibilities:
 *   1) Start `node scripts/build-main.mjs watch` (esbuild watches src/main-app/
 *      TS and emits CJS + sourcemap into build/main-app/ on every change).
 *   2) Wait for the first main output to land on disk (so the bootstrap stub
 *      inside electron-vite sees it before it loads).
 *   3) Start `pnpm electron-vite dev` — it takes care of renderer HMR and
 *      spawning Electron. Electron loads out/main/index.js (= bootstrap at
 *      src/main/index.ts) → bootstrap require()s build/main-app/index.js
 *      compiled by esbuild → runs.
 *
 * SIGINT / child exit kills siblings (best-effort on Windows).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const buildMainOut = path.join(ROOT, 'build', 'main-app', 'index.mjs');
const waitForFile = (p, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (fs.existsSync(p)) {
        clearInterval(id);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(id);
        reject(new Error(`timed out waiting for ${p}`));
      }
    }, 100);
  });

console.log('[dev:1/3] starting esbuild:main watch...');
const esbuild = spawn('node', ['scripts/build-main.mjs', 'watch'], {
  stdio: 'inherit',
  cwd: ROOT,
  shell: false,
});

await waitForFile(buildMainOut);
console.log('[dev:2/3] build/main-app/index.mjs ready. Starting electron-vite...');
const ev = spawn('pnpm', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  cwd: ROOT,
  shell: true,
});

const shutdown = (code = 0) => {
  try { esbuild.kill('SIGTERM'); } catch { /* noop */ }
  try { ev.kill('SIGTERM'); } catch { /* noop */ }
  // eslint-disable-next-line no-process-exit
  setTimeout(() => process.exit(code), 50);
};

for (const sig of ['SIGINT', 'SIGTERM', 'exit']) process.on(sig, shutdown);
esbuild.on('exit', (c) => { if (c !== 0 && c != null) console.warn('[dev] esbuild exited', c); });
ev.on('exit', (c) => shutdown(c ?? 0));
