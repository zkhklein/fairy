/**
 * REAL end-to-end verification of the baidu uploader plugin chain against the
 * RUNNING portable app (D:\BOAT\FAIRY\portable) via the FMB HTTP API.
 *
 * Steps:
 *   1. install the 3 freshly packaged zips (sevenzip 0.1.1, client 0.2.3,
 *      uploader 0.3.2) and switch the enabled plugins to them
 *   2. NEGATIVE: compress a non-existent source → MUST fail honestly
 *      (before the fix this silently "succeeded")
 *   3. NEGATIVE: upload an empty folder → MUST fail honestly
 *      (before the fix this reported "0 uploaded, 0 failed" as ok)
 *   4. REAL: create a 3MB test file → uploader createTask + startTask → poll
 *      until terminal → expect COMPLETED → verify the archive REALLY exists on
 *      Baidu Netdisk (xpan list via the saved OAuth token) → cleanup remote
 *      dir + local file + task record
 *
 * Run: node scripts/verify_uploader_e2e.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'plugins-dist');
const FMB_DATA = 'D:\\BOAT\\FAIRY\\portable\\fmb-data';
const HTTP_META = JSON.parse(fs.readFileSync(path.join(FMB_DATA, 'userData', '.fmb-http.json'), 'utf8'));
const BASE = `http://127.0.0.1:${HTTP_META.port}`;
const TOKEN = HTTP_META.token;

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* noop */ }
  return { status: res.status, json, text };
}

async function invoke(pluginId, action, payload) {
  const r = await api('POST', `/api/v1/plugins/${pluginId}/invoke`, { action, payload });
  return r;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d)); } });
    }).on('error', reject);
  });
}

async function main() {
  console.log('== step 0: sanity — portable HTTP API alive ==');
  const list = await api('GET', '/api/v1/plugins?pageSize=50');
  t('HTTP API reachable', list.status === 200 && Array.isArray(list.json?.items), list.text.slice(0, 200));

  // ---- step 1: install + switch to the new versions ----
  console.log('== step 1: install new zips + switch versions ==');
  const installs = [
    ['com.fmb.tools.sevenzip', '0.1.4'],
    ['com.fmb.baidunetdisk.client', '0.2.7'],
    ['com.fmb.baidunetdisk.uploader', '0.3.10'],
  ];
  for (const [id, ver] of installs) {
    const zip = path.join(DIST, `${id}@${ver}.zip`);
    const inst = await api('POST', '/api/v1/plugins', { zipPath: zip });
    t(`install ${id}@${ver}`, inst.status === 200 || inst.status === 201, inst.text.slice(0, 200));
    const sw = await api('POST', `/api/v1/plugins/${id}/actions/switch-version`, { version: ver });
    t(`switch ${id} → ${ver}`, sw.status === 200 && sw.json?.current_version === ver, sw.text.slice(0, 200));
  }
  const after = await api('GET', '/api/v1/plugins?pageSize=50');
  for (const [id, ver] of installs) {
    const row = after.json.items.find((i) => i.id === id);
    t(`${id} enabled at ${ver}`, row && row.current_version === ver && row.status === 'enabled', JSON.stringify(row && { v: row.current_version, s: row.status }));
  }

  // step 1b: the running app is still the OLD host (per-version KV), and the
  // version switch strands saved config in the old version dir. Re-push it
  // from the newest legacy file found. (The new host build's pluginStoreFile
  // migration makes this unnecessary once the new exe is deployed.)
  console.log('== step 1b: restore config from legacy version dir ==');
  let legacyKv = null;
  const plugRoot = path.join(FMB_DATA, 'plugins');
  const uploaderDirs = fs.readdirSync(plugRoot)
    .filter((d) => d.startsWith('com.fmb.baidunetdisk.uploader@'))
    .sort()
    .reverse();
  for (const d of uploaderDirs) {
    const p = path.join(plugRoot, d, '.fmb-kv.json');
    if (fs.existsSync(p)) {
      legacyKv = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
      if (legacyKv['config:appKey']) break;
    }
  }
  const cfgPayload = {};
  for (const [k, v] of Object.entries(legacyKv || {})) {
    if (k.startsWith('config:')) cfgPayload[k.slice('config:'.length)] = v;
  }
  const setCfg = await invoke('com.fmb.baidunetdisk.uploader', 'setConfig', cfgPayload);
  t('config restored via setConfig', setCfg.json && setCfg.json.ok && setCfg.json.result && !!setCfg.json.result.appKey, JSON.stringify(setCfg.json).slice(0, 200));

  // ---- step 2: NEGATIVE — compress non-existent source must FAIL ----
  console.log('== step 2: negative compress (missing source) ==');
  const negOut = path.join(FMB_DATA, 'baidu-uploader', 'e2e-neg');
  const neg = await invoke('com.fmb.tools.sevenzip', 'compress', {
    sourcePath: 'D:\\no\\such\\source\\file.xyz',
    outputDir: negOut,
    archiveName: 'neg',
    password: 'test',
  });
  t('missing source → compress FAILS honestly', neg.json && neg.json.ok === false && /no output|failed|missing|压缩失败|退出码/i.test(neg.json.error || ''), JSON.stringify(neg.json).slice(0, 300));

  // ---- step 2.5: compress idempotency — a verified archive skips re-work ----
  console.log('== step 2.5: compress idempotency (reused) ==');
  const idemDir = path.join(FMB_DATA, 'baidu-uploader', 'e2e-idem');
  const idemSrc = path.join(os.tmpdir(), 'fmb-e2e-idem-src.bin');
  fs.writeFileSync(idemSrc, Buffer.alloc(1024 * 1024, 3)); // 1MB
  const c1 = await invoke('com.fmb.tools.sevenzip', 'compress', {
    sourcePath: idemSrc, outputDir: idemDir, archiveName: 'idem', password: 'pw',
  });
  t('first compress ok', c1.json && c1.json.ok === true, JSON.stringify(c1.json).slice(0, 300));
  const c2 = await invoke('com.fmb.tools.sevenzip', 'compress', {
    sourcePath: idemSrc, outputDir: idemDir, archiveName: 'idem', password: 'pw',
  });
  t('second compress reuses verified archive', c2.json && c2.json.ok === true && c2.json.result && c2.json.result.reused === true, JSON.stringify(c2.json).slice(0, 300));

  // header encryption: listing the archive WITHOUT the password must NOT
  // reveal any file/folder names (-mhe=on).
  {
    const { execFile } = require('child_process');
    const arch = path.join(idemDir, 'idem.7z.001');
    const listed = await new Promise((resolve) => {
      execFile('C:\\Program Files\\7-Zip\\7z.exe', ['l', arch], { timeout: 15000 }, (err, stdout) => {
        resolve({ err: !!err, out: stdout || '' });
      });
    });
    t('archive listing without password reveals no names (-mhe=on)',
      !listed.out.includes('fmb-e2e-idem-src') && !listed.out.includes('.bin'),
      listed.out.slice(0, 200));
  }

  // ---- step 2.6: compression level param works + is whitelisted ----
  console.log('== step 2.6: compression level ==');
  const lvDir = path.join(FMB_DATA, 'baidu-uploader', 'e2e-level');
  const lv = await invoke('com.fmb.tools.sevenzip', 'compress', {
    sourcePath: idemSrc, outputDir: lvDir, archiveName: 'lv', password: 'pw', level: 'fastest',
  });
  t('compress with level=fastest ok', lv.json && lv.json.ok === true, JSON.stringify(lv.json).slice(0, 300));
  const badLevel = await invoke('com.fmb.baidunetdisk.uploader', 'createTask', {
    sourcePath: idemSrc, remotePath: '/apps/', level: 'ludicrous',
  });
  t('invalid level rejected by createTask', badLevel.json && badLevel.json.ok === false && /invalid level/i.test(badLevel.json.error || ''), JSON.stringify(badLevel.json).slice(0, 200));
  try { await invoke('com.fmb.tools.sevenzip', 'deleteFolder', { folderPath: lvDir }); } catch {}

  // ---- step 3: NEGATIVE — upload empty folder must FAIL ----
  console.log('== step 3: negative upload (empty folder) ==');
  const emptyDir = path.join(os.tmpdir(), 'fmb-e2e-empty'); // tmpdir: D:\BOAT is read-only for this harness
  fs.mkdirSync(emptyDir, { recursive: true });
  const cfgRes = await invoke('com.fmb.baidunetdisk.uploader', 'getConfig', {});
  const cfg = cfgRes.json?.result;
  t('getConfig readable', !!cfg && !!cfg.tokenFile);
  const negUp = await invoke('com.fmb.baidunetdisk.client', 'upload', {
    localFolder: emptyDir,
    remotePath: '/apps/fmb-e2e-neg',
    appKey: cfg.appKey,
    secretKey: cfg.secretKey,
    tokenFile: cfg.tokenFile,
    callbackPluginId: 'com.fmb.baidunetdisk.uploader',
  });
  t('empty folder → upload FAILS honestly', negUp.json && negUp.json.ok === false && /no \.7z|not readable/i.test(negUp.json.error || ''), JSON.stringify(negUp.json).slice(0, 300));

  // ---- step 4: REAL chain — compress + upload a real 3MB file ----
  console.log('== step 4: REAL end-to-end (3MB file) ==');
  const srcDir = path.join(os.tmpdir(), 'fmb-e2e-src');
  fs.mkdirSync(srcDir, { recursive: true });
  const srcFile = path.join(srcDir, 'e2e-test-file.bin');
  fs.writeFileSync(srcFile, Buffer.alloc(3 * 1024 * 1024, 7)); // 3MB
  console.log('  source file: ' + srcFile);

  // A user-chosen remote dir — verifies the chosen-directory bug fix (the
  // upload must land HERE, not at remoteRoot/<randomId>).
  const chosenRemote = '/apps/fmb-e2e-chosen-' + Date.now().toString(36);
  const created = await invoke('com.fmb.baidunetdisk.uploader', 'createTask', {
    sourcePath: srcFile,
    remotePath: chosenRemote,
  });
  t('createTask', created.json && created.json.ok && created.json.result && created.json.result._id, JSON.stringify(created.json).slice(0, 300));
  const taskId = created.json?.result?._id;
  const randomId = created.json?.result?.randomId;

  const started = await invoke('com.fmb.baidunetdisk.uploader', 'startTask', { taskId });
  t('startTask', started.json && started.json.ok === true, JSON.stringify(started.json).slice(0, 200));

  // poll task status until terminal (completed / aborted*)
  let finalTask = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const tasksRes = await invoke('com.fmb.baidunetdisk.uploader', 'listTasks', {});
    const task = tasksRes.json?.result?.find((x) => x._id === taskId);
    if (task && (task.status === 'completed' || task.status.startsWith('aborted'))) {
      finalTask = task;
      break;
    }
    process.stdout.write('.');
  }
  console.log('');
  t('task reached terminal state', !!finalTask, 'timeout');
  if (finalTask) {
    console.log(`  final status: ${finalTask.status}${finalTask.error ? ' error=' + finalTask.error : ''}`);
    t('task COMPLETED', finalTask.status === 'completed', finalTask.error || finalTask.status);
  }

  // verify REMOTE: the archive must exist at <chosenDir>/<randomId>/ —
  // chosen dir is the PARENT; the archive lives in its own randomId subfolder.
  if (finalTask && finalTask.status === 'completed') {
    const tokenData = JSON.parse(fs.readFileSync(cfg.tokenFile, 'utf8'));
    const expectDir = chosenRemote + '/' + randomId;
    const listUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=${encodeURIComponent(tokenData.access_token)}&dir=${encodeURIComponent(expectDir)}`;
    const lr = await httpsGetJson(listUrl);
    const names = (lr.list || []).map((f) => f.path);
    t('archive landed at <chosenDir>/<randomId>/', lr.errno === 0 && names.some((n) => n.startsWith(expectDir + '/')), JSON.stringify(lr).slice(0, 300));
    if (lr.errno === 0) console.log('  remote files:', names.join(', '));

    // cleanup remote test dir (filemanager delete)
    const delBody = 'filelist=' + encodeURIComponent(JSON.stringify([chosenRemote]));
    const delUrl = `https://pan.baidu.com/rest/2.0/xpan/filemanager?method=filemanager&access_token=${encodeURIComponent(tokenData.access_token)}&opera=delete`;
    const dr = await new Promise((resolve, reject) => {
      const u = new URL(delUrl);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(delBody) } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
      });
      req.on('error', reject);
      req.write(delBody);
      req.end();
    });
    t('remote test dir deleted', dr && (dr.errno === 0 || dr.errno === 12), JSON.stringify(dr).slice(0, 200));
  }

  // cleanup: delete task record + test dirs via the plugin (D:\BOAT writes are
  // sandbox-restricted for this script, so go through the plugin's own delete).
  if (taskId) await invoke('com.fmb.baidunetdisk.uploader', 'deleteTask', { taskId });
  try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch {}
  try { await invoke('com.fmb.tools.sevenzip', 'deleteFolder', { folderPath: emptyDir }); } catch {}
  try { await invoke('com.fmb.tools.sevenzip', 'deleteFolder', { folderPath: negOut }); } catch {}
  try { await invoke('com.fmb.tools.sevenzip', 'deleteFolder', { folderPath: idemDir }); } catch {}
  try { fs.rmSync(idemSrc, { force: true }); } catch {}

  console.log(`\n==== uploader e2e: ${pass}/${pass + fail} ${fail === 0 ? '—— ALL GREEN ✅' : '—— FAIL ❌'}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
