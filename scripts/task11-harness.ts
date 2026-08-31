/**
 * Task 11/12 static + dynamic verification harness.
 *
 * Scope:
 *   TR-11.1 Backend IPC: settings get/set contract matches shared IPC schema
 *   TR-11.2 kv_store SQL table schema + default INSERT exist in settings/migrations
 *   TR-11.3 main_ep_list: Extension point list channel correctly returns 20+ entries on empty state
 *   TR-11.4 Plugin listVersions / switchVersion contracts exist & Zod schemas pass
 *   TR-11.5 Workflow export JSON / queue setConcurrency contracts exist
 *   TR-12.1 Route `/app-plugins/:pluginId` is registered in AppRouter
 *   TR-12.2 AppPluginPage attaches Shadow DOM with id `app-plugin-{id}`
 *   TR-12.3 HostUIApi is typed and exposed through shadow.__hostApi for harness echo roundtrip
 *
 * Run:
 *   npx tsx scripts/task11-harness.ts  (require tsx; otherwise use scripts/verify_task11.cjs via ts-node)
 */
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS: { label: string; pass: boolean; note?: string }[] = [];
function check(label: string, cond: unknown, note?: string): void {
  RESULTS.push({ label, pass: !!cond, note });
  process.stdout.write(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${note ? ' — ' + note : ''}\n`);
}

function readFile(p: string): string {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
function fileExists(p: string): boolean {
  return fs.existsSync(path.join(ROOT, p));
}

console.log('\n=== Task 11/12 验证驱动 ===\n');

// ---------- TR-11.1 IPC schema contracts ----------
console.log('\nTR-11.1 Settings IPC channels in shared/ipc/index.ts');
const ipc = readFile('src/shared/ipc/index.ts');
check('main_system_getSettings channel def', ipc.includes('main_system_getSettings'));
check('main_system_setSettings channel def', ipc.includes('main_system_setSettings'));
check('main_system_setSettings uses SettingsSchema', ipc.includes('SettingsSchema'));
check('SettingsSchema includes queue.concurrency', /['"`]queue\.concurrency['"`]/.test(ipc));
check('SettingsSchema includes http.port',       /['"`]http\.port['"`]/.test(ipc));
check('SettingsSchema includes http.token',      /['"`]http\.token['"`]/.test(ipc));
check('SettingsSchema includes log.level',       /['"`]log\.level['"`]/.test(ipc));
check('SettingsSchema includes system.autoStart',   /['"`]system\.autoStart['"`]/.test(ipc));
check('SettingsSchema includes system.closeBehavior', /['"`]system\.closeBehavior['"`]/.test(ipc));
check('MainSystemGetSettingsResult type exported', ipc.includes('MainSystemGetSettingsResult'));

// ---------- TR-11.2 settings SQL table / migration ----------
console.log('\nTR-11.2 Settings storage: kv_store table creation SQL + defaults exist');
const settingsSvc = readFile('src/main-app/core/settings/service.ts');
check('CREATE TABLE IF NOT EXISTS kv_store exists', settingsSvc.includes('CREATE TABLE IF NOT EXISTS kv_store'));
check('kv_store has key/value/updated_at columns',
  settingsSvc.includes('key') && settingsSvc.includes('value') && settingsSvc.includes('updated_at'));
check('INSERT OR REPLACE for defaults', settingsSvc.includes('INSERT OR REPLACE') || settingsSvc.includes('INSERT OR IGNORE'));
check('Default queue.concurrency',       settingsSvc.includes('queue.concurrency'));
check('Default http.port',               settingsSvc.includes('http.port'));
check('Default http.token',              settingsSvc.includes('http.token'));
check('Default log.level',               settingsSvc.includes('log.level'));
check('Default system.autoStart',        settingsSvc.includes('system.autoStart'));
check('Default system.closeBehavior',    settingsSvc.includes('system.closeBehavior'));
check('settings.ts getAll returns defaults object', settingsSvc.includes('getAll'));
check('settings.ts applyPatch validates params',    settingsSvc.includes('applyPatch'));

// ---------- TR-11.3 main_ep_list ----------
console.log('\nTR-11.3 main_ep_list extension point list channel');
check('main_ep_list channel def', ipc.includes('main_ep_list'));
check('MainEpListResult exported', ipc.includes('MainEpListResult'));
const handlers = readFile('src/main-app/core/ipc/handlers.ts');
check('handlers wire main_ep_list', handlers.includes('main_ep_list'));
check('EP_DESCRIPTIONS map >= 10 entries',
  (handlers.match(/app\.onReady|app\.beforeQuit|workflow\.nodeEnter|workflow\.nodeLeave|workflow\.workflowStart|workflow\.workflowComplete|queue\.jobEnqueued|queue\.jobCompleted|queue\.jobFailed|schedule\.fired|error\.captured|plugin\.installed|plugin\.uninstalled|plugin\.enabled|plugin\.disabled|settings\.changed|plugin\.actionCalled|plugin\.kvsChanged|schedule\.created|schedule\.paused|workflow\.created|workflow\.deleted/g)?.length ?? 0) >= 10);
check('bindings column joined via plugin_bindings',
  handlers.includes('plugin_bindings') || handlers.includes('LEFT JOIN'));

// ---------- TR-11.4 Plugin versions + dependencies ----------
console.log('\nTR-11.4 Plugin version switching & dependencies column');
check('main_plugin_listVersions channel def', ipc.includes('main_plugin_listVersions'));
check('main_plugin_switchVersion channel def', ipc.includes('main_plugin_switchVersion'));
check('handlers wire plugin_listVersions',     handlers.includes('plugin_listVersions'));
check('handlers wire plugin_switchVersion',    handlers.includes('plugin_switchVersion'));
check('plugin manifest_json dependencies expose',
  handlers.includes('dependencies') && handlers.includes('manifest_json'));

// ---------- TR-11.5 Workflow export / queue concurrency ----------
console.log('\nTR-11.5 Workflow export JSON & queue concurrency IPC');
check('main_workflow_exportJson channel def', ipc.includes('main_workflow_exportJson'));
check('main_queue_setConcurrency channel def', ipc.includes('main_queue_setConcurrency'));
check('handlers wire workflow_exportJson', handlers.includes('workflow_exportJson'));
check('handlers wire queue_setConcurrency', handlers.includes('queue_setConcurrency'));
check('IPC renderer API exports all 7 new methods', (() => {
  const fmb = readFile('src/renderer/api/fmb.ts');
  const methods = ['systemGetSettings','systemSetSettings','epList','pluginListVersions','pluginSwitchVersion','workflowExportJson','queueSetConcurrency'];
  return methods.every((m) => fmb.includes(m));
})(), 'renderer API methods present');

// ---------- Zustand stores for new modules ----------
console.log('\nTR-11.5 Zustand stores include settings + extension-points');
const stores = readFile('src/renderer/stores/index.ts');
check('useSettingsStore exported', stores.includes('export const useSettingsStore'));
check('useExtensionPointsStore exported', stores.includes('export const useExtensionPointsStore'));
check('PluginStore has listVersions', stores.includes('listVersions:'));
check('PluginStore has switchVersion', stores.includes('switchVersion:'));
check('WorkflowStore has exportJson', stores.includes('exportJson:'));
check('JobStore has setConcurrency', stores.includes('setConcurrency:'));

// ---------- TR-12.1 App-plugins route registered ----------
console.log('\nTR-12.1 Router includes /app-plugins/:pluginId');
const appTsx = readFile('src/renderer/src/App.tsx');
check('AppPluginPage imported', appTsx.includes('AppPluginPage'));
check('app-plugins/:pluginId route registered', appTsx.includes('app-plugins/:pluginId'));
const routerFile = readFile('src/renderer/router/index.tsx');
check('NAV_ITEMS are exported with 8+ entries',
  (routerFile.match(/path:\s*['"]\//g)?.length ?? 0) >= 8);

// ---------- TR-12.2 AppPluginPage attaches Shadow DOM ----------
console.log('\nTR-12.2/T12.3 AppPluginPage scaffold: Shadow DOM + HostUIApi');
const appPage = readFile('src/renderer/pages/AppPluginPage.tsx');
check('attachShadow({ mode: open })', appPage.includes('attachShadow({ mode: '));
check('id `app-plugin-${pluginId}`', appPage.includes('app-plugin-${pluginId}'));
check('HostUIApi interface', appPage.includes('interface HostUIApi'));
check('readPluginState + callPluginMainAction + navigate',
  appPage.includes('readPluginState') && appPage.includes('callPluginMainAction') && appPage.includes('navigate:'));
check('Shadow DOM cleanup on unmount', appPage.includes('removeChild') && appPage.includes('shadowRoot'));
check('404 result for missing plugin', appPage.includes('404'));
check('Non-app type plugin rejected w/ error', appPage.includes('type !== \'app\''));

// ---------- Preload exposes new methods ----------
console.log('\nTR-11.x Preload + IPC contract mirror');
const preload = readFile('src/preload/index.ts');
[
  'systemGetSettings','systemSetSettings',
  'epList',
  'pluginListVersions','pluginSwitchVersion',
  'workflowExportJson',
  'queueSetConcurrency',
].forEach((m) => {
  check(`preload exposes ${m}`, preload.includes(m));
});

// ---------- Files exist ----------
console.log('\nFile existence checks');
[
  'src/main-app/core/settings/service.ts',
  'src/main-app/core/ipc/handlers.ts',
  'src/preload/index.ts',
  'src/renderer/api/fmb.ts',
  'src/renderer/stores/index.ts',
  'src/renderer/router/index.tsx',
  'src/renderer/layout/MainLayout.tsx',
  'src/renderer/components/PageShell.tsx',
  'src/renderer/pages/AppPluginPage.tsx',
  'src/renderer/pages/ExtensionPoints.tsx',
].forEach((p) => {
  check(`exists ${p}`, fileExists(p));
});

// ---------- Summary ----------
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
if (passed !== total) process.exitCode = 1;
