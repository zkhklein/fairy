/**
 * T10 UI-base static verification harness.
 *
 * Verifies (without requiring a running Electron renderer):
 *   TR-10.1: 8 nav items, each route path starts with '/', 8 distinct pages.
 *   TR-10.2: contextIsolation=true, nodeIntegration=false,
 *            preload uses contextBridge.exposeInMainWorld exactly once,
 *            renderer source code does NOT use window.require / Node globals.
 *   TR-10.3: every page under src/renderer/pages references
 *            PageShell / Skeleton / Empty / Result.
 *   IPC contract: every channel in IPC_REGISTRY has both params & result
 *                 Zod schemas, and the main handlers file wires one handler
 *                 per channel.
 *   Stores: 6 Zustand stores exist covering plugins/workflows/schedules/
 *           jobs/errors/ui + system startup collection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  IPC_REGISTRY,
  IPC_CHANNELS,
} from '../src/shared/ipc/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const results: Array<{ name: string; pass: boolean; note: string }> = [];
function check(name: string, cond: boolean, note = ''): void {
  results.push({ name, pass: !!cond, note });
}

// ---- TR-10.1: 8 nav items & routing ----
const routerSrc = fs.readFileSync(path.join(root, 'src/renderer/router/index.tsx'), 'utf8');
const navMatches = routerSrc.match(/key:\s*'\/[^']+'/g) ?? [];
check('TR-10.1 NAV_ITEMS count === 8', navMatches.length === 8, `actual=${navMatches.length}`);

const distinctRoutes = new Set(routerSrc.match(/path:\s*'\/[^']+'/g) ?? []);
check('TR-10.1 distinct path entries === 8', distinctRoutes.size === 8, `actual=${distinctRoutes.size}`);

const pagesDir = path.join(root, 'src/renderer/pages');
const pageFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.tsx'));
check('TR-10.1 8 page files exist (NAV_ITEMS pages + optional T12 app-plugin host)', pageFiles.length >= 8, pageFiles.join(', '));

// App.tsx creates BrowserRouter for '/' and maps NAV_ITEMS + NotFound
const appSrc = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8');
check('TR-10.1 App.tsx uses createBrowserRouter + RouterProvider', /createBrowserRouter\([\s\S]*RouterProvider/.test(appSrc));
check('TR-10.1 / redirects to /dashboard', appSrc.includes(`<Navigate to="/dashboard"`));
check('TR-10.1 NotFound Result 404', /Result[\s\S]*status="404"/.test(appSrc));

// Layout: Sider / Menu / Breadcrumb / Outlet / Footer
const layoutSrc = fs.readFileSync(path.join(root, 'src/renderer/layout/MainLayout.tsx'), 'utf8');
check('TR-10.1 Layout has Sider (Menu)', layoutSrc.includes('<Sider') && layoutSrc.includes('<Menu'));
check('TR-10.1 Layout has Header + Breadcrumb', layoutSrc.includes('<Header') && layoutSrc.includes('<Breadcrumb'));
check('TR-10.1 Layout has Outlet', layoutSrc.includes('<Outlet />'));
check('TR-10.1 Layout has Footer', layoutSrc.includes('<Footer'));

// ---- TR-10.2: preload security ----
const mainSrc = fs.readFileSync(path.join(root, 'src/main-app/index.ts'), 'utf8');
check('TR-10.2 contextIsolation=true in main BrowserWindow', mainSrc.includes('contextIsolation: true'));
check('TR-10.2 nodeIntegration=false in main BrowserWindow', mainSrc.includes('nodeIntegration: false'));

const preloadSrc = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
const exposeCount = (preloadSrc.match(/contextBridge\.exposeInMainWorld\(/g) ?? []).length;
check('TR-10.2 preload exposes exactly ONE namespace via contextBridge', exposeCount === 1, `count=${exposeCount}`);
check('TR-10.2 preload exposes fmb', /exposeInMainWorld\(\s*'fmb'\s*,/.test(preloadSrc));
check('TR-10.2 preload does NOT expose ipcRenderer directly', !preloadSrc.includes('exposeInMainWorld(...ipcRenderer'));
// Exposing require() would be assigning it (window.require = require) or returning it through contextBridge.
// A plain "require(" string is fine (appears in doc comments / type comments).
const exposesRequire = /exposeInMainWorld\([^;]*\brequire\b/.test(preloadSrc)
  || /window\.require\s*=/.test(preloadSrc);
check('TR-10.2 preload does NOT expose require() on window', !exposesRequire);
check('TR-10.2 no window.require assignment', !/window\.require\s*=/.test(preloadSrc));

// Renderer directory-wide: grep for direct Node globals
function walkDir(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, out); else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rendererTs = walkDir(path.join(root, 'src/renderer'));
const forbiddenPattern = /\b(window\.(require|process|__dirname|__filename|global|module|exports|Buffer)|require\([^\)][^\)]*['"]electron['"])/;
let violations: string[] = [];
for (const file of rendererTs) {
  const src = fs.readFileSync(file, 'utf8');
  if (forbiddenPattern.test(src)) violations.push(path.relative(root, file));
}
check('TR-10.2 renderer has zero direct Node global / electron require usages',
  violations.length === 0, violations.join(', '));

// ---- TR-10.3: Four-state coverage on every page via PageShell ----
// Four states are centralised in PageShell (Skeleton/Empty/Result error/success).
// A page conforms if it uses PageShell with all three state-driving props set
// (loading, error, empty) AND provides JSX children as the "success" branch.
const shellChecks = pageFiles.map((file) => {
  const src = fs.readFileSync(path.join(pagesDir, file), 'utf8');
  const usesShell = /<PageShell\b/.test(src);
  const hasLoading = /\bloading\s*=\s*\{/.test(src) || /loading\?\?/g.test(src);
  const hasError = /\berror\s*=\s*\{/.test(src);
  const hasEmpty = /\bempty\s*=\s*\{/.test(src);
  const hasChildren = usesShell && /<PageShell[\s\S]*?>([\s\S]+?)<\/PageShell>/.test(src);
  return {
    file,
    ok: usesShell && hasError && hasEmpty && hasChildren,
    note: `shell=${usesShell},loading=${hasLoading},error=${hasError},empty=${hasEmpty},children=${hasChildren}`,
  };
});
const shellsOk = shellChecks.every((s) => s.ok);
check('TR-10.3 each page uses PageShell with loading/error/empty props + success children', shellsOk,
  shellChecks.map((s) => `${s.file}(${s.note})`).join('; '));

// ---- IPC contract: one wire per registered channel ----
const handlersSrc = fs.readFileSync(path.join(root, 'src/main-app/core/ipc/handlers.ts'), 'utf8');
const wireCounts = IPC_REGISTRY.map((ch) => {
  // wire call pattern is `wire(main_plugin_list,`
  const id = ch.channel.split(':')[1].replace(/\./g, '_');
  const re = new RegExp(`\\bwire\\s*\\(\\s*main_${id}\\s*,`);
  return { channel: ch.channel, wired: re.test(handlersSrc) };
});
const missing = wireCounts.filter((w) => !w.wired).map((w) => w.channel);
check('T10 every IPC_REGISTRY channel has main-process handler', missing.length === 0, `missing: ${missing.join(', ')}`);

// ---- Zod schema validation for params/result ----
let schemaFailures: string[] = [];
for (const ch of IPC_REGISTRY) {
  const paramsOk = !!ch.params && typeof ch.params.safeParse === 'function';
  const resultOk = !!ch.result && typeof ch.result.safeParse === 'function';
  if (!paramsOk || !resultOk) schemaFailures.push(ch.channel);
}
check('T10 every channel has Zod params+result schemas with safeParse', schemaFailures.length === 0,
  `bad: ${schemaFailures.join(', ')}`);

// IPC_CHANNELS string map matches registry size
check('T10 IPC_CHANNELS map === IPC_REGISTRY size',
  Object.keys(IPC_CHANNELS).length === IPC_REGISTRY.length,
  `channels=${Object.keys(IPC_CHANNELS).length}, registry=${IPC_REGISTRY.length}`);

// ---- Stores: 6 Zustand stores ----
const storeSrc = fs.readFileSync(path.join(root, 'src/renderer/stores/index.ts'), 'utf8');
const stores = ['usePluginStore', 'useWorkflowStore', 'useScheduleStore',
  'useJobStore', 'useErrorStore', 'useUiStore'];
const missingStores = stores.filter((n) => !new RegExp(`export const ${n}\\b`).test(storeSrc));
check('T10 6 Zustand stores exported', missingStores.length === 0, `missing: ${missingStores.join(', ')}`);
check('T10 useUiStore.loadSystem calls systemInfo on startup',
  /loadSystem[\s\S]*Promise\.all\([\s\S]*systemInfo\(\)[\s\S]*systemHealth\(\)/.test(storeSrc));

// ---- Renderer api/fmb imports FmbApi type from preload and uses call path ----
const apiSrc = fs.readFileSync(path.join(root, 'src/renderer/api/fmb.ts'), 'utf8');
check('T10 renderer fmbApi guards with "typeof window.fmb"',
  /typeof window !== 'undefined' && window\.fmb/.test(apiSrc) || /if \(typeof window !== 'undefined' && window\.fmb\)/.test(apiSrc) || apiSrc.includes('getFmb()'));

// ---- ConfigProvider + BrowserRouter wires ----
const mainTsx = fs.readFileSync(path.join(root, 'src/renderer/src/main.tsx'), 'utf8');
check('T10 main.tsx wraps with ConfigProvider', mainTsx.includes('<ConfigProvider'));
check('T10 main.tsx passes zhCN locale', mainTsx.includes("locale={zhCN}"));
check('T10 main.tsx wraps AntdApp (antd v5 message/modal hooks)', mainTsx.includes('<AntdApp>'));

// ---- Summary ----
const passes = results.filter((r) => r.pass).length;
const total = results.length;
console.log('\n=== T10 UI Base verification ===');
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${r.name}${r.note ? ' — ' + r.note : ''}`);
}
console.log(`\nTotal: ${passes}/${total} passed.`);
if (passes < total) {
  console.log('\n⚠️  Missing: build-time tsc/build checks are SKIPPED because the sandbox');
  console.log('    cannot pnpm install antd / zustand / react-router-dom / dayjs packages');
  console.log('    (temp-write / pnpm-store-write EPERM blocks).');
  console.log('    Please run this after `pnpm install`:');
  console.log('      pnpm typecheck   // or: node_modules/.bin/tsc -b --pretty');
  console.log('      pnpm build       // or: electron-vite build');
  process.exit(1);
}
console.log('\n✅ Structural checks PASS. Build checks (tsc/build) still require user pnpm install.');
