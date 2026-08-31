/**
 * Electron-vite DEFAULT main entry: bootstrap stub.
 *
 * electron-vite 2.x hardcodes its SSR entry convention to src/main/index.ts
 * and fully ignores rollupOptions.input overrides we tried. So THIS file IS
 * the electron-vite main entry → compiled to out/main/index.js (CommonJS).
 *
 * It then delegates to the REAL main process code emitted by esbuild into
 * build/main-app/index.mjs (ES Module). Using dynamic import() from CJS
 * context works in Node 20 and resolves the critical "require() of ES
 * Module" incompatibility (Kysely, nanoid, pino ship ESM only; CJS cannot
 * require them but ESM can import both CJS native bindings + other ESM).
 *
 * This stub is deliberately written using only Node built-ins so electron-vite
 * can inline it without pulling in any other source files or deps.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function projectRoot() {
  // __dirname at SSR emit location = <project>/out/main/ → two levels up.
  return path.resolve(__dirname, '..', '..');
}

const realMain = path.join(projectRoot(), 'build', 'main-app', 'index.mjs');

if (!fs.existsSync(realMain)) {
  // eslint-disable-next-line no-console
  console.error('[FMB:bootstrap] esbuild main bundle MISSING: ' + realMain);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}

// Node's ESM loader on Windows requires file:// URLs for absolute paths.
const realMainUrl = pathToFileURL(realMain).toString();

// Bridge the race between end-of-script and async import() resolution:
// without active handles, Node/Electron would terminate before realMain
// finishes loading and installs its long-lived handles (BrowserWindow,
// ipcMain listeners, logger streams, etc). The real main bundle clears
// this keepalive via globalThis.__fmbClearKeepalive once it has booted.
let keepalive: ReturnType<typeof setInterval> | null = null;
if (typeof setInterval !== 'undefined') {
  keepalive = setInterval(() => {}, 30_000);
}
function stopKeepalive() {
  try {
    if (keepalive != null) clearInterval(keepalive);
  } catch { /* noop */ }
  keepalive = null;
}
// Also expose for the real main bundle (optional proactive cleanup).
(globalThis as any).__fmbClearKeepalive = stopKeepalive;

import(/* webpackIgnore: true */ realMainUrl)
  .then(() => {
    // Real main bundle will keep the event loop alive via its own handles
    // (BrowserWindow, ipc, file streams). Release our hold within ~1s:
    setTimeout(stopKeepalive, 1000).unref?.();
  })
  .catch((err) => {
    stopKeepalive();
    // eslint-disable-next-line no-console
    console.error('[FMB:bootstrap] failed to load real main bundle', err && err.stack ? err.stack : err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });