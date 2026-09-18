/**
 * Bundled-deps install harness — pure Node (no vitest), electron stubbed.
 *
 * Verifies the app-plugin zip `bundled/*.zip` flow end-to-end against the real
 * PluginService:
 *   1. precheck surfaces bundledDeps (new dep)
 *   2. installBatch auto-installs + auto-enables bundled deps before the app
 *   3. same bundled version → skipped
 *   4. upgrade bundled version, no overwrite choice → skipped (range satisfied)
 *   5. upgrade + overwriteDeps → overwritten, current_version promoted
 *   6. requiredOverwrite (installed version violates declared range) and user
 *      declines → whole install fails with dep.conflict
 *   7. requiredOverwrite + overwrite chosen → downgrade installed & promoted
 *   8. installed app dir does NOT retain the bundled/ payload
 *   9. precheck fails when bundled version does not satisfy declared range
 *
 * Run: `node scripts/_build-bundled-deps-test.mjs && node build/bundled-deps.mjs`
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import AdmZip from 'adm-zip';

// ---------- Bootstrap: stub electron + isolate userData/db ----------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-bundled-'));
fs.mkdirSync(path.join(TMP_ROOT, 'logs'), { recursive: true });
process.env['FMB_FORCE_USERDATA'] = TMP_ROOT;
// db.ts resolveDbPath() honors FMB_DB_PATH as the explicit scratch-db override.
process.env['FMB_DB_PATH'] = path.join(TMP_ROOT, 'fmb.db');
process.env['ELECTRON_RUN_AS_NODE'] = '1';

import { initDatabase, closeDatabase, getRawDb } from '../src/main-app/core/db';
import { initEventBus } from '../src/main-app/core/event-bus';
import { initPluginService, getPluginService } from '../src/main-app/core/plugin/loader';
import type { EventBusService } from '../src/main-app/core/event-bus';

// ---------- tiny assert framework ----------
let pass = 0, fail = 0;
const failures: string[] = [];
function t(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const run = async (): Promise<void> => { await fn(); };
  const r = run();
  return r.then(
    () => { pass++; console.log(`  ok   ${name}`); },
    (e) => { fail++; failures.push(name); console.log(`  FAIL ${name}\n       ${(e && (e as Error).stack) || String(e)}`); },
  );
}
function eq<T>(a: T, b: T, why = ''): void {
  if (a !== b) throw new Error(`${why} want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------- zip helpers ----------
function makePluginZip(manifest: Record<string, unknown>, extra?: Record<string, Buffer>): string {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.addFile('main.js', Buffer.from('module.exports={activate(){},deactivate(){}};', 'utf8'));
  for (const [name, content] of Object.entries(extra ?? {})) zip.addFile(name, content);
  const p = path.join(TMP_ROOT, `zip-${Math.random().toString(36).slice(2, 8)}.zip`);
  zip.writeZip(p);
  return p;
}
function depZip(depId: string, version: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    id: depId, name: `Dep ${depId}`, version, type: 'atomic',
    description: 'bundled-deps test dep', permissions: ['log:write'], dependencies: {}, main: 'main.js',
  }, null, 2), 'utf8'));
  zip.addFile('main.js', Buffer.from('module.exports={activate(){},deactivate(){},ping(){return "pong";}};', 'utf8'));
  return zip.toBuffer();
}
function appZip(appId: string, version: string, depId: string, range: string, bundledVersion: string): string {
  return makePluginZip({
    id: appId, name: `App ${appId}`, version, type: 'app',
    description: 'bundled-deps test app', permissions: ['log:write'],
    dependencies: { [depId]: range }, main: 'main.js',
  }, { [`bundled/${depId}@${bundledVersion}.zip`]: depZip(depId, bundledVersion) });
}

// ---------- bootstrap services ----------
initDatabase();
const bus: EventBusService = initEventBus();
const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const pluginSvc = initPluginService({ pluginsRoot: PLUGINS_DIR, eventBus: bus });

const DEP = 'com.fmb.test.dep-a';
const APP = 'com.fmb.test.app-a';

async function main(): Promise<void> {
  // 1) precheck: new dep surfaced
  const z1 = appZip(APP, '1.0.0', DEP, '^1.0.0', '1.0.0');
  await t('1 precheck: bundledDeps contains new dep', async () => {
    const pre = await pluginSvc.preInstallCheckFromZip(z1);
    eq(pre.ok, true, 'precheck ok');
    eq(pre.bundledDeps.length, 1, 'bundledDeps length');
    eq(pre.bundledDeps[0]!.depId, DEP);
    eq(pre.bundledDeps[0]!.version, '1.0.0');
    eq(pre.bundledDeps[0]!.status, 'new');
    eq(pre.bundledDeps[0]!.requiredOverwrite, false);
  });

  // 2) install: dep auto-installed + auto-enabled before app
  await t('2 installBatch: bundled dep installed + enabled with app', async () => {
    const r = await pluginSvc.installBatch({ zipPaths: [z1], autoEnable: true });
    const item = r.results[0]!;
    eq(item.ok, true, `install ok: ${JSON.stringify(item.errors)}`);
    eq(item.pluginId, APP);
    eq(item.installedDeps.length, 1);
    eq(item.installedDeps[0]!.pluginId, DEP);
    eq(item.installedDeps[0]!.action, 'installed');
    eq(pluginSvc.get(DEP)?.current_version, '1.0.0', 'dep current_version');
    eq(pluginSvc.get(DEP)?.status, 'enabled', 'dep enabled');
    eq(pluginSvc.get(APP)?.status, 'enabled', 'app enabled');
  });

  // 2b) installed app dir must NOT retain bundled/
  t('2b installed app dir drops bundled/ payload', () => {
    const dir = path.join(PLUGINS_DIR, `${APP}@1.0.0`);
    eq(fs.existsSync(dir), true, 'app dir exists');
    eq(fs.existsSync(path.join(dir, 'bundled')), false, 'bundled/ removed after install');
  });

  // 3) same bundled version → skipped
  await t('3 reinstall same bundled version → skipped', async () => {
    const pre = await pluginSvc.preInstallCheckFromZip(z1);
    eq(pre.bundledDeps[0]!.status, 'same');
    const r = await pluginSvc.installBatch({ zipPaths: [z1], autoEnable: false });
    eq(r.results[0]!.installedDeps[0]!.action, 'skipped');
    eq(pluginSvc.get(DEP)?.current_version, '1.0.0');
  });

  // 4) bundled upgrade, no overwrite → skipped (installed satisfies range)
  const z2 = appZip(APP, '1.0.1', DEP, '^1.0.0', '1.1.0');
  await t('4 bundled upgrade + no overwrite → skipped, dep stays', async () => {
    const pre = await pluginSvc.preInstallCheckFromZip(z2);
    eq(pre.bundledDeps[0]!.status, 'upgrade');
    eq(pre.bundledDeps[0]!.installedVersion, '1.0.0');
    eq(pre.bundledDeps[0]!.requiredOverwrite, false);
    const r = await pluginSvc.installBatch({ zipPaths: [z2], autoEnable: false, overwriteDeps: [] });
    eq(r.results[0]!.ok, true);
    eq(r.results[0]!.installedDeps[0]!.action, 'skipped');
    eq(pluginSvc.get(DEP)?.current_version, '1.0.0', 'dep unchanged');
  });

  // 5) bundled upgrade + overwrite → overwritten
  await t('5 bundled upgrade + overwrite → overwritten to 1.1.0', async () => {
    const r = await pluginSvc.installBatch({ zipPaths: [z2], autoEnable: false, overwriteDeps: [DEP] });
    eq(r.results[0]!.ok, true);
    eq(r.results[0]!.installedDeps[0]!.action, 'overwritten');
    eq(pluginSvc.get(DEP)?.current_version, '1.1.0', 'dep promoted');
  });

  // 6) requiredOverwrite declined → whole install fails with dep.conflict
  const z3 = appZip(APP, '1.0.2', DEP, '^0.9.0', '0.9.5');
  await t('6 requiredOverwrite declined → install fails (dep.conflict)', async () => {
    const pre = await pluginSvc.preInstallCheckFromZip(z3);
    eq(pre.ok, true, 'precheck ok (bundled satisfies range)');
    eq(pre.bundledDeps[0]!.status, 'downgrade');
    eq(pre.bundledDeps[0]!.requiredOverwrite, true);
    const r = await pluginSvc.installBatch({ zipPaths: [z3], autoEnable: false, overwriteDeps: [] });
    eq(r.results[0]!.ok, false, 'install must fail');
    const msg = r.results[0]!.errors.map((e) => e.message).join(';');
    if (!/覆盖|conflict/i.test(msg)) throw new Error(`expected conflict message, got: ${msg}`);
    eq(pluginSvc.get(DEP)?.current_version, '1.1.0', 'dep untouched');
  });

  // 7) requiredOverwrite accepted → downgrade installed + promoted
  await t('7 requiredOverwrite accepted → downgrade to 0.9.5 promoted', async () => {
    const r = await pluginSvc.installBatch({ zipPaths: [z3], autoEnable: false, overwriteDeps: [DEP] });
    eq(r.results[0]!.ok, true, `install ok: ${JSON.stringify(r.results[0]!.errors)}`);
    eq(r.results[0]!.installedDeps[0]!.action, 'overwritten');
    eq(pluginSvc.get(DEP)?.current_version, '0.9.5', 'dep downgraded+promoted');
  });

  // 8) bundled version violating declared range → precheck conflict (not hidden)
  const z4 = appZip(APP, '1.0.3', DEP, '^3.0.0', '0.9.5');
  await t('8 bundled version outside declared range → precheck ok=false', async () => {
    const pre = await pluginSvc.preInstallCheckFromZip(z4);
    eq(pre.ok, false, 'precheck must fail');
    eq(pre.depCheck.conflicts.length > 0 || pre.depCheck.missing.length > 0, true, 'conflict/missing surfaced');
  });

  console.log(`\n==== bundled-deps: ${pass}/${pass + fail} passed ${fail === 0 ? '—— ALL GREEN ✅' : '—— FAILURES ❌: ' + failures.join(' | ')}`);
}

main()
  .catch((e) => { console.error('harness error:', e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* noop */ }
    try { getPluginService(); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(fail === 0 ? 0 : 1);
  });
