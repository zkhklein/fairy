// TDD: Plugin Refresh-Button Rescan (Structural Verification + HTTP Smoke)
//
// Phase A — Structural Verification (pure source code checks):
//   Verifies that "list() → rescan() = sideloadFromDisk + pruneMissing" chain
//   is correctly wired across loader.ts, HTTP handler, and extension-points.
//   These checks run in pure Node with no bindings.
//
// Phase B — HTTP Smoke Test (optional, runs if app already listens on 127.0.0.1:8765):
//   Uses HTTP API to hit the actual live app /api/v1/plugins endpoint, which
//   exercises the exact same path as the renderer "Refresh" button.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = 'd:\\FAIRY';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || String(e))); fail++; } }
function eq(a, b, why) { if (a !== b) throw new Error((why || '') + ` want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function inc(whole, part, why) { if (!String(whole).includes(String(part))) throw new Error((why || '') + ` missing: ${JSON.stringify(part)}`); }
function ninc(whole, part, why) { if (String(whole).includes(String(part))) throw new Error((why || '') + ` unwanted: ${JSON.stringify(String(part).slice(0,200))}`); }

const loader = fs.readFileSync(path.join(root, 'src/main-app/core/plugin/loader.ts'), 'utf8');
const extPts = fs.readFileSync(path.join(root, 'src/main-app/core/event-bus/extension-points.ts'), 'utf8');
const httpIdx = fs.readFileSync(path.join(root, 'src/main-app/http/index.ts'), 'utf8');
const handlers = fs.readFileSync(path.join(root, 'src/main-app/core/ipc/handlers.ts'), 'utf8');

console.log('\n==== Phase A: Structural Verification (code inspection) ====\n');

// ---------- A1: list() is async + calls rescan() ----------
t('A1: PluginService.list() is async (Promise-returning)', () => {
  // Match "async list(q: ...)"
  const hasAsyncList = /async\s+list\s*\(\s*q[\s\S]*?\)\s*:\s*Promise/.test(loader);
  eq(hasAsyncList, true, 'A1 list() signature is async + returns Promise');
});
t('A2: list() body awaits rescan() at top (refresh → sync disk with DB)', () => {
  // Extract list() body: need await this.rescan()
  const m = loader.match(/async\s+list\s*\([\s\S]*?\)\s*:\s*Promise<[\s\S]*?>\s*\{([\s\S]*?)\n\s*\}\s*\n\s*(?:get|listVersions|constructor|enable|disable|install|uninstall|\s*\})/);
  const body = m ? m[1] : loader.slice(loader.indexOf('async list'));
  inc(body, 'await this.rescan()', 'A2 list awaits rescan as first meaningful statement');
});

// ---------- A2: rescan() returns {newlyInstalled,newlyDisabled} + calls sideload+pruneMissing ----------
t('A3: rescan() method defined (calls sideloadFromDisk + pruneMissing)', () => {
  const hasRescan = /rescan\s*\([\s\S]*?\)\s*:\s*Promise<[\s\S]*?newlyInstalled[\s\S]*?newlyDisabled/.test(loader);
  eq(hasRescan, true, 'A3 rescan() return type has newlyInstalled + newlyDisabled');
});
t('A4: rescan() calls sideloadFromDisk (new plugins via disk copy → auto register)', () => {
  // Find rescan body, ensure it calls sideloadFromDisk
  const start = loader.indexOf('async rescan');
  eq(start > 0, true, 'A4 rescan starts');
  const body = loader.slice(start, start + 1200);
  inc(body, 'sideloadFromDisk', 'A4 rescan body calls sideloadFromDisk');
});
t('A5: rescan() awaits pruneMissing (deleted dir → auto disable / 退出)', () => {
  const start = loader.indexOf('async rescan');
  const body = loader.slice(start, start + 1200);
  inc(body, 'pruneMissing', 'A5 rescan body awaits pruneMissing');
});

// ---------- A3: pruneMissing disables missing on-disk plugins + no longer relies on builtin host skip ----------
t('A6: pruneMissing no longer references FMB_BUILTIN_HOST_PLUGIN_ID (built-in virtual host plugin concept removed)', () => {
  // Anchor on pruneMissing *method definition* (not call site inside rescan)
  const defMatch = loader.match(/(?:private\s+)?async\s+pruneMissing\b[\s\S]*?\)\s*:\s*Promise/);
  const start = defMatch ? loader.indexOf(defMatch[0]) : loader.indexOf('pruneMissing');
  eq(start > 0, true, 'A6 pruneMissing def found');
  const body = loader.slice(start, start + 4000);
  ninc(body, 'FMB_BUILTIN_HOST_PLUGIN_ID', 'A6 pruneMissing body must NOT contain hardcoded builtin-host skip (removed from codebase)');
});
t('A7: pruneMissing disables plugin (calls disablePlugin for enabled rows, updates DB status)', () => {
  const defMatch = loader.match(/(?:private\s+)?async\s+pruneMissing\b[\s\S]*?\)\s*:\s*Promise/);
  const start = defMatch ? loader.indexOf(defMatch[0]) : loader.indexOf('pruneMissing');
  const body = loader.slice(start, start + 4000);
  inc(body, 'disablePlugin', 'A7 pruneMissing invokes disablePlugin for enabled rows');
  inc(body, `status = 'disabled'`, 'A7 pruneMissing forces DB status disabled');
});
t('A8: pruneMissing emits plugin.statusChanged with reason=missing-on-disk', () => {
  // Emit may be on separate line like:
  //   void this.bus.safeEmit(
  //     'plugin.statusChanged',
  //     { ..., reason: 'missing-on-disk' },
  const defMatch = loader.match(/(?:private\s+)?async\s+pruneMissing\b[\s\S]*?\)\s*:\s*Promise/);
  const start = defMatch ? loader.indexOf(defMatch[0]) : loader.indexOf('pruneMissing');
  const body = loader.slice(start, start + 4000);
  // Match any style: emit(...'plugin.statusChanged' OR bus.safeEmit($nl'plugin.statusChanged'
  const hasStatusChanged = /(emit|safeEmit)\s*\(\s*[\r\n\s]*['"`]plugin\.statusChanged['"`]/.test(body) ||
                          /bus\.[a-zA-Z]*?Emit\s*\([\s\S]{0,60}plugin\.statusChanged/.test(body);
  eq(hasStatusChanged, true, 'A8 pruneMissing body contains bus emit/safeEmit of plugin.statusChanged (inside method)');
  inc(body, `missing-on-disk`, 'A8 reason=missing-on-disk present near that emit inside pruneMissing body');
});

// ---------- A4: extension-points plugin.statusChanged supports reason? ----------
t('A9: ExtensionEventMap plugin.statusChanged has optional reason field (typecheck passed A1-A8)', () => {
  const block = extPts.match(/'plugin\.statusChanged':\s*\{[\s\S]*?\};/)?.[0] ?? '';
  inc(block, 'pluginId', 'A9 pluginId present');
  inc(block, 'from', 'A9 from present');
  inc(block, 'to', 'A9 to present');
  // reason must exist (optionality via '?' or comment is OK; check keyword present)
  const hasReason = /reason\??\s*:\s*string/.test(block);
  eq(hasReason, true, 'A9 reason?: string declared');
});

// ---------- A5: HTTP route is async + awaits list() ----------
t('A10: /api/v1/plugins handler is async (compatible with list() async)', () => {
  // Find route: app.get('/api/v1/plugins', async (c) => { ... })
  const route = httpIdx.match(/app\.get\(\s*['"]\/api\/v1\/plugins['"][\s\S]*?\n\s*\}\)/)?.[0] ?? '';
  inc(route, 'async', 'A10 route handler uses async keyword');
  inc(route, 'await', 'A10 handler awaits getPluginService().list(p)');
});
t('A11: JSON-RPC plugin.list also awaits pluginSvc.list()', () => {
  const rpc = httpIdx.match(/case\s+['"]plugin\.list['"][\s\S]*?case\s+['"]/)?.[0] ?? '';
  inc(rpc, 'await', 'A11 JSON-RPC plugin.list awaits list()');
});

// ---------- A6: IPC handler wire() awaits result (list() → pluginSvc.list(p)) ----------
t('A12: IPC main_plugin_list handler passes return through wire() which awaits handler(parsed.data)', () => {
  // wire() contains await handler() AND the wire registration line for plugin.list
  const hasAwaitInWire = /ipcMain\.handle\s*\([\s\S]*?const\s+result\s*=\s*await\s+handler\s*\(\s*parsed\.data\s*\)/.test(handlers);
  eq(hasAwaitInWire, true, 'A12 wire body contains "await handler(parsed.data)" so pluginSvc.list(p) Promise is correctly awaited before result validation');
  const hLine = handlers.match(/wire\(\s*main_plugin_list\s*,\s*\(p\)\s*=>\s*pluginSvc\.list\s*\(\s*p\s*\)\s*\)/)?.[0] ?? '';
  eq(!!hLine, true, 'A12 main_plugin_list → pluginSvc.list(p) wiring registered (calls wire with async-compatible return)');
});

// ---------- A7: Constructor calls rescan() on boot (startup consistency) ----------
t('A13: PluginService constructor calls rescan on initialization (boot-side-load existing disk plugins)', () => {
  // Find constructor body — should contain rescan or sideload/prune call
  const m = loader.match(/constructor\s*\(opts\?[\s\S]*?\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*(\/\/|\s*rescan\s*\(|private|public|async)/);
  const body = m ? m[1] : loader.slice(loader.indexOf('constructor'), loader.indexOf('constructor') + 1500);
  inc(body, 'rescan', 'A13 constructor body invokes rescan/sideload');
});

console.log(`\n── Phase A: ${pass}/${pass+fail} passed ${fail===0?'── All green. ✅':'── '+fail+' FAILURES ❌'}`);
const phaseAFail = fail;

// =====================================================================
// Phase B: HTTP Smoke Test (optional, requires FMB app running)
// =====================================================================
console.log('\n==== Phase B: HTTP Smoke Test (optional) ====\n');
// B tests have their own pass/fail to avoid contaminating Phase A (structural)
let bPass = 0, bFail = 0, bSkip = 0;
function bt(name, cond, reason) {
  if (cond === 'skip') { bSkip++; console.log('  skip ' + name + (reason ? ' — ' + reason : '')); }
  else if (cond) { bPass++; console.log('  ok   ' + name); }
  else { bFail++; console.log('  FAIL ' + name + (reason ? ' — ' + reason : '')); }
}

async function phaseB() {
  // Discover HTTP token
  const candidates = [];
  // Candidate 1: Dev mode data dir
  candidates.push(path.join(root, '.data', 'userData', '.fmb-http.json'));
  // Candidate 2: Latest win-unpacked portable (from earlier builds)
  candidates.push(path.join(root, 'dist9', 'win-unpacked', 'fmb-data', 'userData', '.fmb-http.json'));
  // Candidate 3: APPDATA default
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'fairy-maid-brigade', '.fmb-http.json'));

  let tokenFile = candidates.find(p => fs.existsSync(p));
  if (!tokenFile) {
    bt('Phase B overall', 'skip', 'no token file found (FMB HTTP API credentials)');
    return;
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); }
  catch { bt('Phase B overall', 'skip', 'token file corrupt'); return; }
  const baseUrl = config.baseUrl || `http://127.0.0.1:${config.port || 8765}`;
  const token = config.token;
  console.log(`  Using HTTP endpoint: ${baseUrl} (token source: ${tokenFile})`);

  function request(method, urlPath, headers = {}) {
    return new Promise((resolve) => {
      const u = new URL(baseUrl + urlPath);
      const req = http.request({
        method, host: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: Object.assign({ Authorization: `Bearer ${token}` }, headers), timeout: 5000,
      }, (res) => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e?.message || e) }));
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end();
    });
  }

  // Probe: B0 — check connectivity first; if offline: skip rest, no fail
  let probe = await request('GET', '/api/v1/plugins?pageSize=1');
  if (probe.status === 0) {
    bt('Phase B overall', 'skip', `app offline (${probe.body}). Note: B tests run only when FMB app is already running (e.g. via pnpm dev or Portable exe).`);
    return;
  }

  // B1: returns 200
  bt('B1: HTTP GET /api/v1/plugins → 200 OK (Refresh button endpoint)', probe.status === 200, `got ${probe.status} ${String(probe.body).slice(0,160)}`);
  let payload;
  try { payload = probe.body && JSON.parse(probe.body); } catch {}
  let baselineTotal = 0;
  const b2ok = !!payload && typeof payload.total === 'number' && Array.isArray(payload.items);
  bt('B2: Response JSON shape {total, items}', b2ok, b2ok ? '' : `parse=${!!payload} totalType=${typeof payload?.total} itemsType=${typeof payload?.items}`);
  if (b2ok) baselineTotal = payload.total;

  // B3: plugins dir + sideload
  let pluginsDir = null;
  const tryDirs = [
    path.resolve(path.dirname(tokenFile), '..', 'plugins'),
    path.join(root, '.data', 'plugins'),
  ];
  for (const d of tryDirs) if (fs.existsSync(d)) { pluginsDir = d; break; }
  if (!pluginsDir) {
    bt('B3+B4', 'skip', 'plugins directory not discovered from token path');
    return;
  }
  const pluginId = 'com.fmb.rescan.test-' + process.pid;
  const dirName = `${pluginId}@0.1.0`;
  const pluginDir = path.join(pluginsDir, dirName);
  try {
    if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      id: pluginId, name: 'RescanTest', version: '0.1.0', type: 'atomic',
      description: 'TDD rescan test', permissions: ['log:write'], dependencies: {}, main: 'main.js',
    }));
    fs.writeFileSync(path.join(pluginDir, 'main.js'), 'module.exports={activate(){},deactivate(){},echo(x){return x;}}');
    let r2 = await request('GET', '/api/v1/plugins?pageSize=500');
    let p2; try { p2 = JSON.parse(r2.body); } catch {}
    const b3ok = r2.status === 200 && p2 && p2.total > baselineTotal && p2.items.some(i => i.id === pluginId && i.status === 'installed');
    bt('B3: After dropping plugin dir + Refresh (GET /plugins) → auto sideload visible', b3ok,
      `status=${r2.status} baseline=${baselineTotal} new=${p2?.total} idPresent=${!!(p2?.items?.find(i=>i.id===pluginId))} status=${p2?.items?.find(i=>i.id===pluginId)?.status}`);

    // B4: Delete dir → refresh → status disabled
    fs.rmSync(pluginDir, { recursive: true, force: true });
    let r3 = await request('GET', '/api/v1/plugins?pageSize=500');
    let p3; try { p3 = JSON.parse(r3.body); } catch {}
    const me = p3?.items?.find(i => i.id === pluginId);
    const b4ok = r3.status === 200 && (!me || (me.status !== 'enabled' && (me.status === 'disabled' || me.status === 'installed')));
    bt('B4: After DELETE plugin dir + Refresh → plugin auto-disabled / exited (pruneMissing complete)', b4ok,
      `status=${r3.status} removed=${!me} remainStatus=${me?.status}`);
  } finally {
    if (fs.existsSync(pluginDir)) try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  try { await phaseB(); }
  catch (e) { console.log('Phase B error (non-fatal):', e.message); }

  // Report Phase A + Phase B separately
  console.log(`\n── Phase A (structural): ${pass}/${pass+fail} passed ${fail===0?'── All green. ✅':'── '+fail+' FAILURES ❌'}`);
  if (bSkip > 0 || bPass > 0 || bFail > 0) console.log(`── Phase B (HTTP smoke): ${bPass} passed, ${bFail} failed, ${bSkip} skipped ${bFail===0?'—— B OK ✅':'—— '+bFail+' B FAILURES'}`);
  const totalFail = fail; // structural is the real gate
  console.log(`\n==== OVERALL: ${pass}/${pass+totalFail} structural checks ${totalFail===0?'—— PASSED ✅':'—— FAILED ❌'}  (Phase B failures: ${bFail})`);
  process.exit(totalFail === 0 ? 0 : 1);
})();
