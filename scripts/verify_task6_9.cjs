/**
 * Task 6-9 verify runner — compiles task6-9-harness.ts through esbuild with a
 * stub electron (same approach as verify_task5.cjs), then executes the bundle
 * under the Electron binary in node mode (better-sqlite3 is prebuilt for Electron ABI).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('esbuild');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'build', 'task6-9-harness.mjs');
const STUB = path.join(ROOT, 'build', '_electron_stub.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-task6-9-stub-'));

const stubSrc = `
export const app = {
  get isPackaged() { return (process.env.FMB_TASK_TEST ?? '') === '1'; },
  getAppPath() { return process.cwd(); },
  getPath(name) {
    switch(name) {
      case 'userData': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'logs': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'temp': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'home': return '${TMP.replace(/\\/g, '\\\\')}';
      case 'exe': return process.execPath;
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
      entryPoints: [path.join(ROOT, 'scripts/task6-9-harness.ts')],
      bundle: true,
      outfile: OUT,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      sourcemap: false,
      logLevel: 'error',
      alias: {
        electron: STUB,
        '@shared/index': path.join(ROOT, 'src/shared/index.ts'),
      },
      external: ['better-sqlite3'],
      banner: { js: 'import { createRequire as __createRequire } from \'module\'; const require = __createRequire(import.meta.url);' },
    });
  } catch (e) {
    console.log('esbuild failed:', e);
    process.exit(2);
  }
  const { spawnSync } = require('node:child_process');
  // Prefer the Electron binary (Node 20 ABI) since better-sqlite3 is prebuilt for Electron 30.
  const electronPkg = require.resolve('electron/package.json', { paths: [ROOT] });
  let runner = process.execPath;
  let runnerArgs = [OUT];
  const maybeElectronExe = path.join(path.dirname(electronPkg), 'dist', 'electron.exe');
  if (fs.existsSync(maybeElectronExe)) {
    runner = maybeElectronExe;
    runnerArgs = [OUT];
  }
  const env = { ...process.env, FMB_TASK_TEST: '1', ELECTRON_RUN_AS_NODE: '1' };
  const r = spawnSync(runner, runnerArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 99);
}

main();
