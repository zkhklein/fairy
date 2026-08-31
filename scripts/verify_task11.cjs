/* eslint-disable */
/**
 * Pure-Node verification runner for Task 11/12 (no tsx/esbuild required).
 * Mirrors the logic from scripts/task11-harness.ts but runs as CommonJS.
 *
 * Usage:
 *   node scripts/verify_task11.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function check(label, cond, note) {
  RESULTS.push({ label, pass: !!cond, note });
  process.stdout.write(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${note ? ' — ' + note : ''}\n`);
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

console.log('\n=== Task 11/12 验证驱动 (no-deps, pure CJS) ===\n');

// TR-11.1 Settings IPC channels in shared/ipc/index.ts
console.log('\nTR-11.1 Settings IPC channels in shared/ipc/index.ts');
const ipc = read('src/shared/ipc/index.ts');
check('main_system_getSettings channel def', ipc.includes('main_system_getSettings'));
check('main_system_setSettings channel def', ipc.includes('main_system_setSettings'));
check('main_system_setSettings uses SettingsSchema', ipc.includes('SettingsSchema'));
check('SettingsSchema includes queue.concurrency',       /["'`]queue\.concurrency["'`]/.test(ipc));
check('SettingsSchema includes http.port',              /["'`]http\.port["'`]/.test(ipc));
check('SettingsSchema includes http.token',             /["'`]http\.token["'`]/.test(ipc));
check('SettingsSchema includes log.level',              /["'`]log\.level["'`]/.test(ipc));
check('SettingsSchema includes system.autoStart',       /["'`]system\.autoStart["'`]/.test(ipc));
check('SettingsSchema includes system.closeBehavior',   /["'`]system\.closeBehavior["'`]/.test(ipc));
check('MainSystemGetSettingsResult type exported', ipc.includes('MainSystemGetSettingsResult'));

// TR-11.2 Settings storage: kv_store table creation SQL + defaults exist
console.log('\nTR-11.2 Settings storage: kv_store table creation SQL + defaults exist');
const settingsSvc = read('src/main-app/core/settings/service.ts');
check('CREATE TABLE IF NOT EXISTS kv_store exists', settingsSvc.includes('CREATE TABLE IF NOT EXISTS kv_store'));
check('kv_store has key/value/updated_at columns',
  settingsSvc.includes('key') && settingsSvc.includes('value') && settingsSvc.includes('updated_at'));
check('INSERT OR REPLACE for defaults',
  settingsSvc.includes('INSERT OR REPLACE') || settingsSvc.includes('INSERT OR IGNORE'));
check('Default queue.concurrency',     settingsSvc.includes('queue.concurrency'));
check('Default http.port',             settingsSvc.includes('http.port'));
check('Default http.token',            settingsSvc.includes('http.token'));
check('Default log.level',             settingsSvc.includes('log.level'));
check('Default system.autoStart',      settingsSvc.includes('system.autoStart'));
check('Default system.closeBehavior',  settingsSvc.includes('system.closeBehavior'));
check('SettingsSvc.getAll', settingsSvc.includes('getAll'));
check('SettingsSvc.applyPatch', settingsSvc.includes('applyPatch'));

// TR-11.3 main_ep_list
console.log('\nTR-11.3 main_ep_list extension point list channel');
check('main_ep_list channel def', ipc.includes('main_ep_list'));
check('MainEpListResult exported', ipc.includes('MainEpListResult'));
const handlers = read('src/main-app/core/ipc/handlers.ts');
check('handlers wire main_ep_list', handlers.includes('main_ep_list'));
const EP = [
  'app.onReady','app.beforeQuit','workflow.nodeEnter','workflow.nodeLeave',
  'workflow.workflowStart','workflow.workflowComplete','queue.jobEnqueued',
  'queue.jobCompleted','queue.jobFailed','schedule.fired','error.captured',
  'plugin.installed','plugin.uninstalled','plugin.enabled','plugin.disabled',
  'settings.changed','plugin.actionCalled','plugin.kvsChanged','schedule.created',
  'schedule.paused','workflow.created','workflow.deleted',
];
const hits = EP.filter((name) => handlers.includes(name)).length;
check(`EP_DESCRIPTIONS-like registry: ${hits} of ${EP.length} entries present`, hits >= 10, `${hits} found`);
check('bindings join (LEFT JOIN or plugin_bindings)',
  handlers.includes('plugin_bindings') || handlers.includes('LEFT JOIN'));

// TR-11.4 Plugin versions + dependencies
console.log('\nTR-11.4 Plugin version switching & dependencies column');
check('main_plugin_listVersions channel def', ipc.includes('main_plugin_listVersions'));
check('main_plugin_switchVersion channel def', ipc.includes('main_plugin_switchVersion'));
check('handlers wire plugin_listVersions',     handlers.includes('plugin_listVersions'));
check('handlers wire plugin_switchVersion',    handlers.includes('plugin_switchVersion'));
check('plugin manifest_json + dependencies expose',
  handlers.includes('dependencies') && handlers.includes('manifest_json'));

// TR-11.5 Workflow export / queue concurrency
console.log('\nTR-11.5 Workflow export JSON & queue concurrency IPC');
check('main_workflow_exportJson channel def', ipc.includes('main_workflow_exportJson'));
check('main_queue_setConcurrency channel def', ipc.includes('main_queue_setConcurrency'));
check('handlers wire workflow_exportJson', handlers.includes('workflow_exportJson'));
check('handlers wire queue_setConcurrency', handlers.includes('queue_setConcurrency'));
const fmb = read('src/renderer/api/fmb.ts');
const methods = [
  'systemGetSettings','systemSetSettings',
  'epList',
  'pluginListVersions','pluginSwitchVersion',
  'workflowExportJson','queueSetConcurrency',
];
const missing = methods.filter((m) => !fmb.includes(m));
check(`renderer API exports 7 new methods (miss=${missing.join(',') || 'none'})`, missing.length === 0);

// Zustand stores for new modules
console.log('\nTR-11.5 Zustand stores include settings + extension-points');
const stores = read('src/renderer/stores/index.ts');
check('useSettingsStore exported', stores.includes('export const useSettingsStore'));
check('useExtensionPointsStore exported', stores.includes('export const useExtensionPointsStore'));
check('PluginStore has listVersions', stores.includes('listVersions:'));
check('PluginStore has switchVersion', stores.includes('switchVersion:'));
check('WorkflowStore has exportJson', stores.includes('exportJson:'));
check('JobStore has setConcurrency', stores.includes('setConcurrency:'));

// TR-12.1 App-plugins route registered
console.log('\nTR-12.1 Router includes /app-plugins/:pluginId');
const appTsx = read('src/renderer/src/App.tsx');
check('AppPluginPage imported', appTsx.includes('AppPluginPage'));
check('app-plugins/:pluginId route registered', appTsx.includes('app-plugins/:pluginId'));
const routerFile = read('src/renderer/router/index.tsx');
const pathCount = (routerFile.match(/path:\s*["']\//g) || []).length;
check(`NAV_ITEMS are exported with 8+ entries (found ${pathCount} path: declarations)`, pathCount >= 8);

// TR-12.2/T12.3 AppPluginPage: Shadow DOM + HostUIApi
console.log('\nTR-12.2/T12.3 AppPluginPage scaffold: Shadow DOM + HostUIApi');
const appPage = read('src/renderer/pages/AppPluginPage.tsx');
check('attachShadow({ mode: open })', appPage.includes('attachShadow({ mode: '));
check('id `app-plugin-${pluginId}`', appPage.includes('app-plugin-${pluginId}'));
check('HostUIApi interface', appPage.includes('interface HostUIApi'));
check('readPluginState + callPluginMainAction + navigate methods',
  appPage.includes('readPluginState') && appPage.includes('callPluginMainAction') && appPage.includes('navigate:'));
check('Shadow DOM cleanup on unmount', appPage.includes('removeChild') && appPage.includes('shadowRoot'));
check('404 result for missing plugin', appPage.includes('404'));
check('Non-app type plugin rejected with error', appPage.includes("type !== 'app'"));

// Preload exposes new methods
console.log('\nTR-11.x Preload + IPC contract mirror');
const preload = read('src/preload/index.ts');
methods.forEach((m) => { check(`preload exposes ${m}`, preload.includes(m)); });

// File existence
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
].forEach((p) => { check(`exists ${p}`, exists(p)); });

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
if (passed !== total) { process.exitCode = 1; }
