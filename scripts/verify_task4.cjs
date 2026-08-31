/**
 * Task 4 (event bus + extension points) verification.
 * Runs the task4-harness.ts through esbuild with a stubbed `electron` module.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('esbuild');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'build', 'task4-harness.mjs');
const STUB = path.join(ROOT, 'build', '_electron_stub.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-task4-stub-'));

// Create electron stub module that maps app paths to a writable temp dir.
const stubSrc = `
export const app = {
  get isPackaged() { return false; },
  getAppPath() { return process.cwd(); },
  getPath(name) {
    switch(name) {
      case 'userData': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'logs': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'temp': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'home': return '${TMP.replace(/\\/g, '\\\\')}';
      default: return '${TMP.replace(/\\/g, '\\\\')}';
    }
  },
  getVersion() { return '0.1.0-test'; },
  getName() { return 'FMB Test'; },
  whenReady: () => Promise.resolve(),
  quit: () => {},
};
export const BrowserWindow = class BrowserWindowStub { constructor() {} static getAllWindows() { return []; } };
export const ipcMain = { on() {}, handle() {} };
export const protocol = { registerSchemesAsPrivileged() {} };
export const shell = { openExternal() {} };
export const screen = { getPrimaryDisplay() { return {}; } };
export default undefined;
`;
fs.mkdirSync(path.dirname(STUB), { recursive: true });
fs.writeFileSync(STUB, stubSrc, 'utf8');

async function main() {
  try {
    await build({
      entryPoints: [path.join(ROOT, 'scripts/task4-harness.ts')],
      bundle: true,
      outfile: OUT,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      sourcemap: false,
      logLevel: 'error',
      alias: { electron: STUB },
      // Externalize ONLY deps that are native (better-sqlite3), pure-Node CJS (rotating-file-stream),
      // or environment-specific (electron already aliased). Bundle everything else so ESM imports
      // (eventemitter2, zod, nanoid, pino, pino-pretty) work without runtime interop issues.
      external: ['better-sqlite3', 'kysely', 'rotating-file-stream'],
      banner: { js: 'import { createRequire as __createRequire } from \'module\'; const require = __createRequire(import.meta.url);' },
    });
  } catch (e) {
    console.log('esbuild failed:', e);
    process.exit(2);
  }

  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [OUT], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, FMB_EVENTBUS_TEST: '1' },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 99);
}

main();
