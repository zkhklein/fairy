/**
 * Task 5 verify runner — compiles task5-harness.ts through esbuild with stub
 * electron (same approach as verify_task4.cjs), then executes the bundle.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('esbuild');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'build', 'task5-harness.mjs');
const STUB = path.join(ROOT, 'build', '_electron_stub.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-task5-stub-'));

const stubSrc = `
export const app = {
  get isPackaged() { return (process.env.FMB_TASK5_TEST ?? '') === '1'; },
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
      entryPoints: [path.join(ROOT, 'scripts/task5-harness.ts')],
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
      // Native / problematic deps externalized: better-sqlite3 + kysely also external?
      // Actually better-sqlite3 is native; we need it. Keep externalize better-sqlite3 only
      // so harness uses native binding. Let esbuild bundle everything else (consistent).
      external: ['better-sqlite3'],
      banner: { js: 'import { createRequire as __createRequire } from \'module\'; const require = __createRequire(import.meta.url);' },
    });
  } catch (e) {
    console.log('esbuild failed:', e);
    process.exit(2);
  }
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  // Use electron binary (Node 20) because better-sqlite3 is prebuilt for Electron 30
  // (NODE_MODULE_VERSION = 123), not the host Node v24. Run electron in "node mode" so it
  // executes a script file.
  const electronPkg = require.resolve('electron/package.json', { paths: [ROOT] });
  const electronAppPath = JSON.parse(fs.readFileSync(electronPkg, 'utf8'))?.main;
  let runner = process.execPath;
  let runnerArgs = [OUT];
  const maybeElectronExe = path.join(path.dirname(electronPkg), 'dist', 'electron.exe');
  if (fs.existsSync(maybeElectronExe)) {
    runner = maybeElectronExe;
    runnerArgs = [OUT];
  }
  const env = { ...process.env, FMB_TASK5_TEST: '1', ELECTRON_RUN_AS_NODE: '1' };
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
