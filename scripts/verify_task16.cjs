/* eslint-disable */
/**
 * Pure-Node verification runner for Task 16 (Demo plugins + zip packaging).
 *
 * Uses adm-zip (already a project dependency) to inspect the produced zips
 * without extracting them. Mirrors TR-16.1 ~ TR-16.3 + packaging-script checks.
 *
 * Usage: node scripts/verify_task16.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function check(label, cond, note) {
  RESULTS.push({ label, pass: !!cond, note });
  process.stdout.write(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${note ? ' — ' + note : ''}\n`);
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }
function zipEntries(rel) {
  const zp = path.join(ROOT, 'plugins-dist', rel);
  if (!fs.existsSync(zp)) return null;
  const z = new AdmZip(zp);
  return z.getEntries().map((e) => e.entryName);
}
function zipRead(rel, entry) {
  const zp = path.join(ROOT, 'plugins-dist', rel);
  const z = new AdmZip(zp);
  const e = z.getEntry(entry);
  return e ? e.getData().toString('utf8') : null;
}

console.log('\n=== Task 16 验证驱动 (adm-zip inspection) ===\n');

// ---- source manifests ----
const mAtomic = JSON.parse(read('plugins-source/atomic/demo-echo/manifest.json'));
const mApp = JSON.parse(read('plugins-source/app/demo-counter/manifest.json'));
const mExt = JSON.parse(read('plugins-source/extension/demo-install-notify/manifest.json'));

// ---- TR-16.1: 3 zips with manifest.json + entry file ----
console.log('TR-16.1 三类插件 zip 打包 + 入口完整');
check('atomic manifest id', mAtomic.id === 'com.fmb.demo.atomic');
check('atomic type=atomic', mAtomic.type === 'atomic');
check('atomic main=main.js', mAtomic.main === 'main.js');
check('atomic declares demo.echo extension point', mAtomic.extensionPoints.includes('demo.echo::echo'));

check('app manifest id', mApp.id === 'com.fmb.demo.app');
check('app type=app', mApp.type === 'app');
check('app depends on atomic-demo', mApp.dependencies && mApp.dependencies['com.fmb.demo.atomic'] === '^0.1.0');
check('app declares workflows:execute permission', (mApp.permissions || []).includes('workflows:execute'));
check('app declares kv:read/write', (mApp.permissions || []).includes('kv:read') && (mApp.permissions || []).includes('kv:write'));
check('app declares extensions:call', (mApp.permissions || []).includes('extensions:call'));
check('app has renderer entry', !!mApp.renderer);

check('extension manifest id', mExt.id === 'com.fmb.demo.extension');
check('extension type=extension', mExt.type === 'extension');
check('extension subscribes plugin.afterInstall', mExt.extensionPoints.includes('plugin.afterInstall::onAfterInstall'));
check('extension declares log:write + kv:write', (mExt.permissions || []).includes('log:write') && (mExt.permissions || []).includes('kv:write'));

const zipAtomic = 'com.fmb.demo.atomic@0.1.0.zip';
const zipApp = 'com.fmb.demo.app@0.1.0.zip';
const zipExt = 'com.fmb.demo.extension@0.1.0.zip';
check('atomic zip exists', exists(path.join('plugins-dist', zipAtomic)));
check('app zip exists', exists(path.join('plugins-dist', zipApp)));
check('extension zip exists', exists(path.join('plugins-dist', zipExt)));

const aEntries = zipEntries(zipAtomic);
const pEntries = zipEntries(zipApp);
const eEntries = zipEntries(zipExt);
check('atomic zip has manifest.json', aEntries && aEntries.includes('manifest.json'));
check('atomic zip has main.js', aEntries && aEntries.includes('main.js'));
check('app zip has manifest.json', pEntries && pEntries.includes('manifest.json'));
check('app zip has main.js', pEntries && pEntries.includes('main.js'));
check('app zip has renderer.umd.js', pEntries && pEntries.includes('renderer.umd.js'));
check('extension zip has manifest.json', eEntries && eEntries.includes('manifest.json'));
check('extension zip has main.js', eEntries && eEntries.includes('main.js'));

// staged manifest in app zip points at pre-compiled renderer.umd.js
const appManInZip = pEntries ? zipRead(zipApp, 'manifest.json') : null;
check('app staged manifest.renderer = renderer.umd.js', appManInZip && JSON.parse(appManInZip).renderer === 'renderer.umd.js');
check('app staged manifest.main = main.js', appManInZip && JSON.parse(appManInZip).main === 'main.js');

// ---- TR-16.2: atomic-demo crashMe throws (fault injection node) ----
console.log('\nTR-16.2 atomic-demo crashMe 故障注入节点');
const atomicMainSrc = read('plugins-source/atomic/demo-echo/main.ts');
check('exports crashMe', /crashMe\s*\(/.test(atomicMainSrc));
check('crashMe throws Error', /crashMe[\s\S]*?throw new Error/.test(atomicMainSrc));
check('crashMe mentions AC-14', atomicMainSrc.includes('AC-14'));
check('exports echo (returns input)', /echo\(input\)[\s\S]*?return input/.test(atomicMainSrc));
check('echo bound as demo.echo extension handler', atomicMainSrc.includes('demo.echo'));
// verify the compiled main.js in the zip still throws
const atomicMainJs = aEntries ? zipRead(zipAtomic, 'main.js') : null;
check('compiled main.js keeps crashMe throw', atomicMainJs && /throw new Error/.test(atomicMainJs) && /crashMe/.test(atomicMainJs));
check('compiled main.js keeps echo return', atomicMainJs && /echo/.test(atomicMainJs));

// ---- TR-16.3: extension-demo records install with traceId ----
console.log('\nTR-16.3 extension-demo afterInstall 记录含 traceId');
const extMainSrc = read('plugins-source/extension/demo-install-notify/main.ts');
check('exports onAfterInstall', /onAfterInstall\s*\(/.test(extMainSrc));
check('generates traceId', /traceId\s*=/.test(extMainSrc) && /Date\.now\(\)/.test(extMainSrc));
check('writes warn log via hostApi.logger.warn', extMainSrc.includes('hostApi.logger.warn'));
check('persists kv record ext_demo_log_', extMainSrc.includes("'ext_demo_log_'") || extMainSrc.includes('ext_demo_log_'));
check('records audit entry', extMainSrc.includes('hostApi.audit.record'));
check('reads payload.plugin.id', extMainSrc.includes('payload.plugin') && extMainSrc.includes('.id'));
// compiled main.js in the zip retains the traceId/kv logic
const extMainJs = eEntries ? zipRead(zipExt, 'main.js') : null;
check('compiled ext main.js has onAfterInstall', extMainJs && /onAfterInstall/.test(extMainJs));
check('compiled ext main.js has traceId', extMainJs && /traceId/.test(extMainJs));
check('compiled ext main.js writes kv', extMainJs && /kv\.set/.test(extMainJs));

// ---- TR-16.4: app-demo bidirectional comms (renderer→main→atomic) ----
console.log('\nTR-16.4 app-demo 双向通信链路');
const appMainSrc = read('plugins-source/app/demo-counter/main.ts');
check('exports bump', /bump\s*\(/.test(appMainSrc));
check('bump reads kv count', appMainSrc.includes("hostApi.kv.get('count')"));
check('bump writes kv count', appMainSrc.includes("hostApi.kv.set('count'"));
check('bump pings demo.echo via extensions.call', appMainSrc.includes("extensions.call('demo.echo'"));
check('exports getCount', /getCount\s*\(/.test(appMainSrc));
const appRendererSrc = read('plugins-source/app/demo-counter/renderer/index.ts');
check('renderer exports mount', /module\.exports\s*=\s*\{[\s\S]*mount\(/.test(appRendererSrc));
check('renderer exports unmount', /unmount\(/.test(appRendererSrc));
check('renderer calls callPluginMainAction bump', appRendererSrc.includes("callPluginMainAction('bump'"));
check('renderer calls callPluginMainAction getCount', appRendererSrc.includes("callPluginMainAction('getCount'"));
check('renderer uses plain DOM (no React require)', !/require\(['"]react/.test(appRendererSrc));
const appRendererJs = pEntries ? zipRead(zipApp, 'renderer.umd.js') : null;
check('compiled renderer.umd.js has mount', appRendererJs && /mount\s*\(/.test(appRendererJs));
check('compiled renderer.umd.js has callPluginMainAction', appRendererJs && /callPluginMainAction/.test(appRendererJs));

// ---- TR-16.5: package-plugin.ts script correctness ----
console.log('\nTR-16.5 package-plugin.ts 打包脚本正确性');
const pkg = read('scripts/package-plugin.ts');
check('imports esbuild', pkg.includes("import esbuild from 'esbuild'"));
check('imports adm-zip', pkg.includes("import AdmZip from 'adm-zip'"));
check('compiles main to main.js (cjs)', pkg.includes("outfile: mainOut") && pkg.includes("format: 'cjs'"));
check('compiles app renderer to renderer.umd.js', pkg.includes("renderer.umd.js"));
check('renderer externalizes react/react-dom/antd', pkg.includes("'react', 'react-dom', 'react-dom/client', 'antd'"));
check('rewrites staged manifest.renderer', pkg.includes("staged.renderer = 'renderer.umd.js'"));
check('zips to plugins-dist/<id>@<version>.zip', pkg.includes('${manifest.id}@${manifest.version}.zip'));
check('ALL_PLUGINS lists 3 dirs', pkg.includes("'atomic/demo-echo'") && pkg.includes("'app/demo-counter'") && pkg.includes("'extension/demo-install-notify'"));
const pkgJson = JSON.parse(read('package.json'));
check('package.json has package:plugins script', pkgJson.scripts && pkgJson.scripts['package:plugins']);
check('package:plugins runs package-plugin.ts', pkgJson.scripts['package:plugins'] === 'node scripts/package-plugin.ts');

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
process.exit(passed === total ? 0 : 1);
