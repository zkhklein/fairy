/* eslint-disable */
/**
 * Pure-Node verification runner for Task 12-B/C
 * (Plugin sub-page dynamic mount + renderer sandbox).
 *
 * Static structural checks only — no Electron runtime needed.
 * Mirrors TR-12.1 ~ TR-12.10.
 *
 * Usage: node scripts/verify_task12.cjs
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

console.log('\n=== Task 12-B/C 验证驱动 (no-deps, pure CJS) ===\n');

// ---- TR-12.1: IPC contract for renderer bundle + callAction ----
console.log('TR-12.1 IPC 通道契约 (getRenderer + callAction)');
const ipc = read('src/shared/ipc/index.ts');
check('main_plugin_getRenderer defined', /export const main_plugin_getRenderer = make\(/.test(ipc));
check('getRenderer channel string', ipc.includes("channel: 'main:plugin.getRenderer'"));
check('getRenderer params: pluginId', /main_plugin_getRenderer[\s\S]*?pluginId: z\.string\(\)\.min\(1\)/.test(ipc));
check('getRenderer result: code (string|null)', /main_plugin_getRenderer[\s\S]*?code: z\.union\(\[z\.string\(\), z\.null\(\)\]\)/.test(ipc));
check('getRenderer result: version', /main_plugin_getRenderer[\s\S]*?version: z\.union\(\[z\.string\(\), z\.null\(\)\]\)/.test(ipc));
check('getRenderer result: error optional', /main_plugin_getRenderer[\s\S]*?error: z\.string\(\)\.optional\(\)/.test(ipc));
check('main_plugin_callAction defined', /export const main_plugin_callAction = make\(/.test(ipc));
check('callAction channel string', ipc.includes("channel: 'main:plugin.callAction'"));
check('callAction params: pluginId + action + payload', /main_plugin_callAction[\s\S]*?pluginId: z\.string\(\)\.min\(1\)[\s\S]*?action: z\.string\(\)\.min\(1\)[\s\S]*?payload: z\.unknown\(\)\.optional\(\)/.test(ipc));
check('callAction result: ok boolean', /main_plugin_callAction[\s\S]*?ok: z\.boolean\(\)/.test(ipc));
check('callAction result: result optional + error optional', /main_plugin_callAction[\s\S]*?result: z\.unknown\(\)\.optional\(\)[\s\S]*?error: z\.string\(\)\.optional\(\)/.test(ipc));
check('IPC_REGISTRY includes both', ipc.includes('main_plugin_getRenderer, main_plugin_callAction,'));
check('IPC_CHANNELS maps both', ipc.includes('main_plugin_getRenderer: main_plugin_getRenderer.channel') && ipc.includes('main_plugin_callAction: main_plugin_callAction.channel'));
check('type aliases exported', ipc.includes('MainPluginGetRendererParams') && ipc.includes('MainPluginCallActionResult'));

// ---- TR-12.2: T12-B esbuild compile at install time ----
console.log('\nTR-12.2 安装时 esbuild 编译 app 插件 renderer → renderer.umd.js');
const loader = read('src/main-app/core/plugin/loader.ts');
check('compileRendererIfApp method', /private async compileRendererIfApp\(/.test(loader));
check('called from install path', loader.includes('await this.compileRendererIfApp(targetDir, manifest)'));
check('output file renderer.umd.js', loader.includes("path.join(pluginDir, 'renderer.umd.js')"));
check('keeps pre-compiled bundle if present', /if \(fs\.existsSync\(outFile\)\)/.test(loader) && loader.includes('already present (pre-compiled)'));
check('dynamic import esbuild', loader.includes("await import('esbuild')"));
check('esbuild bundle:true', loader.includes('bundle: true'));
check('esbuild format cjs', loader.includes("format: 'cjs'"));
check('esbuild platform browser', loader.includes("platform: 'browser'"));
check('externalizes react/react-dom/antd', loader.includes("external: ['react', 'react-dom', 'react-dom/client', 'antd']"));
check('ts/tsx loaders', loader.includes("'.tsx': 'tsx'") && loader.includes("'.ts': 'ts'"));
check('graceful failure (warn, not throw)', loader.includes('esbuild compile failed'));

// ---- TR-12.3: service methods getRendererCode + callAction ----
console.log('\nTR-12.3 服务层 getRendererCode + callAction');
check('getRendererCode method', /getRendererCode\(pluginId: string\)/.test(loader));
check('getRendererCode returns code|null + version|null', /getRendererCode[\s\S]*?return \{ code: null, version: null \}/.test(loader));
check('reads renderer.umd.js from version dir', loader.includes("path.join(pvRow.directory, 'renderer.umd.js')"));
check('callAction method', /async callAction\(pluginId: string, action: string, payload\?/.test(loader));
check('callAction requires enabled (loadedInstances)', loader.includes('this.loadedInstances.get(pluginId)'));
check('callAction not-enabled error', loader.includes('is not enabled'));
check('callAction looks up exports[action]', loader.includes('inst.sandbox.module.exports'));
check('callAction action-not-found error', loader.includes('not found on plugin exports'));
check('callAction ok:true on success', loader.includes('return { ok: true, result }'));
check('callAction catches + returns error', /callAction[\s\S]*?return \{ ok: false, error:/.test(loader));

// ---- TR-12.4: handlers.ts wiring ----
console.log('\nTR-12.4 handlers.ts 接线');
const handlers = read('src/main-app/core/ipc/handlers.ts');
check('imports both channels', handlers.includes('main_plugin_getRenderer, main_plugin_callAction'));
check('wires main_plugin_getRenderer', /wire\(main_plugin_getRenderer/.test(handlers));
check('getRenderer delegates to pluginSvc.getRendererCode', handlers.includes('pluginSvc.getRendererCode(p.pluginId)'));
check('wires main_plugin_callAction', /wire\(main_plugin_callAction[\s\S]*?async/.test(handlers));
check('callAction delegates to pluginSvc.callAction', handlers.includes('pluginSvc.callAction(p.pluginId, p.action, p.payload)'));

// ---- TR-12.5: preload exposure + renderer API client ----
console.log('\nTR-12.5 preload 暴露 + renderer API 客户端');
const preload = read('src/preload/index.ts');
check('preload pluginGetRenderer', preload.includes('pluginGetRenderer:'));
check('preload pluginGetRenderer invokes main_plugin_getRenderer', /pluginGetRenderer[\s\S]*?IPC_CHANNELS\.main_plugin_getRenderer/.test(preload));
check('preload pluginCallAction', preload.includes('pluginCallAction:'));
check('preload pluginCallAction invokes main_plugin_callAction', /pluginCallAction[\s\S]*?IPC_CHANNELS\.main_plugin_callAction/.test(preload));
const fmb = read('src/renderer/api/fmb.ts');
check('fmbApi pluginGetRenderer typed', /pluginGetRenderer\(p: MainPluginGetRendererParams\)/.test(fmb));
check('fmbApi pluginGetRenderer returns typed Promise', /pluginGetRenderer[\s\S]*?Promise<MainPluginGetRendererResult>/.test(fmb));
check('fmbApi pluginCallAction typed', /pluginCallAction\(p: MainPluginCallActionParams\)/.test(fmb));
check('fmbApi pluginCallAction returns typed Promise', /pluginCallAction[\s\S]*?Promise<MainPluginCallActionResult>/.test(fmb));

// ---- TR-12.6: dynamic routing ----
console.log('\nTR-12.6 应用插件子页面动态路由');
const app = read('src/renderer/src/App.tsx');
check('route app-plugins/:pluginId', app.includes("path: 'app-plugins/:pluginId'"));
check('route uses AppPluginPage', app.includes('element: <AppPluginPage />'));
const page = read('src/renderer/pages/AppPluginPage.tsx');
check('useParams pluginId', page.includes("useParams<{ pluginId: string }>()"));
check('rejects non-app plugin type', page.includes("p.type !== 'app'"));

// ---- TR-12.7: Shadow DOM isolation + theme propagation ----
console.log('\nTR-12.7 Shadow DOM 隔离 + 主题变量传递');
check('attachShadow open mode', page.includes("host.attachShadow({ mode: 'open' })"));
check('reuses existing shadowRoot', page.includes('host.shadowRoot ?? host.attachShadow'));
check('copies --ant- tokens', page.includes("prop.startsWith('--ant-')"));
check('copies --fmb- tokens', page.includes("prop.startsWith('--fmb-')"));
check('copies via getComputedStyle(documentElement)', page.includes('getComputedStyle(document.documentElement)'));
check('creates plugin container in shadow', page.includes("container.id = 'plugin-root'"));
check('appends container to shadow', page.includes('shadow.appendChild(container)'));

// ---- TR-12.8: UMD bundle evaluation + require shim ----
console.log('\nTR-12.8 UMD bundle 受控求值 + require shim');
check('evaluateRendererBundle function', /function evaluateRendererBundle\(code: string\)/.test(page));
check('uses new Function (controlled scope)', page.includes("new Function('module', 'exports', 'require', code)"));
check('module/exports/require shim', page.includes('moduleObj') && page.includes('moduleObj.exports'));
check('require shim provides react', page.includes("if (name === 'react') return React"));
check('require shim provides react-dom', page.includes("if (name === 'react-dom') return ReactDOM"));
check('require shim provides antd', page.includes("if (name === 'antd') return antd"));
check('require shim jsx-runtime', page.includes("if (name === 'react/jsx-runtime')"));
check('jsx shim Fragment', page.includes('Fragment: React.Fragment'));
check('rejects unknown requires', page.includes('Plugin renderer cannot require'));
check('returns module.exports', page.includes('return moduleObj.exports as'));

// ---- TR-12.9: HostUIApi + IPC action bridge ----
console.log('\nTR-12.9 HostUIApi + IPC 动作桥接');
check('HostUIApi interface exported', /export interface HostUIApi/.test(page));
check('HostUIApi readPluginState', page.includes('readPluginState(): Promise<Record<string, unknown>>'));
check('HostUIApi callPluginMainAction generic', /callPluginMainAction<A extends string>/.test(page));
check('HostUIApi navigate', page.includes('navigate(to: string): void'));
check('buildHostApi uses fmbApi.pluginCallAction', page.includes('fmbApi.pluginCallAction({ pluginId, action, payload'));
check('throws on action !ok', page.includes("if (!r.ok) throw new Error(r.error"));
check('navigate delegates to router navigate', page.includes('navigate: (to) => navigate(to)'));

// ---- TR-12.10: mount/unmount lifecycle + cleanup ----
console.log('\nTR-12.10 mount/unmount 生命周期 + 清理');
check('PluginRendererModule interface (mount/unmount)', /interface PluginRendererModule[\s\S]*?mount\(hostElement/.test(page) && /unmount\?\(hostElement/.test(page));
check('awaits pluginModule.mount', page.includes('await pluginModule.mount(container, api)'));
check('stores unmount ref', page.includes('unmountRef.current = typeof pluginModule.unmount'));
check('cleanup calls unmount', page.includes('unmountRef.current?.(host)'));
check('cleanup clears shadow children', page.includes('while (host.shadowRoot.firstChild) host.shadowRoot.removeChild(host.shadowRoot.firstChild)'));
check('bundleError state for missing bundle', page.includes('renderer.code') && page.includes('setBundleError'));
check('PageShell four-state shell', /PageShell[\s\S]*?loading={loading}[\s\S]*?error={error \?\? bundleError}/.test(page));

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
process.exit(passed === total ? 0 : 1);
