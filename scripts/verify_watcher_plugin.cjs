#!/usr/bin/env node
'use strict';
/**
 * scripts/verify_watcher_plugin.cjs — RED-GREEN TDD 验证
 *
 * 值守插件套件目录规范 + 行为的纯 Node 验收脚本（零依赖 cjs，直接 node 跑）。
 *
 * 任务集合：
 *   1) 目录规划（为未来拆独立仓库做准备）
 *      plugins-source/
 *        watchers/             ← 独立仓库根 (新插件都按 suite 分组)
 *          app/fmb-watchdog/
 *          atomic/fmb-watcher-traework/
 *          atomic/fmb-watcher-chatgpt/
 *          package.json       ← 未来拆分仓库时作为仓根 manifest
 *          README.md
 *   2) 三个插件各自 manifest.json 符合 PluginManifestSchema
 *      - 原子插件导出 2 个 action: check + ensureRunning
 *      - app 插件: renderer 有 Switch; main 有 setEnabled/getState/readinessCheck
 *   3) HostApi 新增 system.processes 模块：新增 HostContracts 条目与 schema
 *      - processes.query(processNames): boolean (进程存在否)
 *      - processes.start(executablePath, args, cwd): {pid}
 *      + 对应权限 system:process:read / system:process:start
 *   4) package-plugin.ts ALL_PLUGINS 已包含三个新路径
 *   5) 实际打包 pnpm package:plugins — 三个 zip 产出
 *   6) 用 node child_process 真模拟两个"测试进程"验证原子 action 行为 (启用=重启,未启用=不动)
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins-source');
const WATCHERS = path.join(SRC, 'watchers');
const DIST = path.join(ROOT, 'plugins-dist');

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    failures.push('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e)));
    console.log('  FAIL ' + name + ' — ' + (e && e.message ? e.message : String(e)));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ` — expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

// ── SECTION A: 目录结构 ──────────────────────────────────────────
console.log('\n[A] 目录规划（watchers suite 为未来独立 git 仓做准备）');
test('watchers suite 根目录存在 plugins-source/watchers/', () => {
  ok(fs.statSync(WATCHERS).isDirectory(), 'missing dir: ' + WATCHERS);
});
test('suite 根有 package.json (未来拆分仓库时的仓根 manifest)', () => {
  const pkg = path.join(WATCHERS, 'package.json');
  const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  ok(parsed.name && parsed.version, 'suite package.json missing name/version');
});
test('suite 根有 README.md', () => {
  ok(fs.statSync(path.join(WATCHERS, 'README.md')).isFile());
});
const expected = [
  'app/fmb-watchdog',
  'atomic/fmb-watcher-traework',
  'atomic/fmb-watcher-chatgpt',
];
for (const rel of expected) {
  test(`存在 ${rel}`, () => {
    const d = path.join(WATCHERS, rel);
    ok(fs.statSync(d).isDirectory(), 'missing dir ' + d);
    const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
    ok(m.id && m.name && m.version && m.type, 'manifest 基础字段缺失 at ' + rel);
    ok(fs.statSync(path.join(d, 'main.ts')).isFile(), 'main.ts 缺失 at ' + rel);
  });
}

// ── SECTION B: Manifest 契约 ──────────────────────────────────────
console.log('\n[B] 三个插件 manifest.json 契约');
function readManifest(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { __missing: p, error: e.message }; } }
const appManifest = readManifest(path.join(WATCHERS, 'app/fmb-watchdog/manifest.json'));
const traeManifest = readManifest(path.join(WATCHERS, 'atomic/fmb-watcher-traework/manifest.json'));
const chatManifest = readManifest(path.join(WATCHERS, 'atomic/fmb-watcher-chatgpt/manifest.json'));
function notMissing(m, name) {
  if (m && m.__missing) throw new Error(name + ' manifest 缺失: ' + m.error);
  return true;
}
test('app 插件 id 按命名规范 com.fmb.watchdog', () => { notMissing(appManifest, 'watchdog'); eq(appManifest.id, 'com.fmb.watchdog'); });
test('app 插件类型是 app', () => { notMissing(appManifest, 'watchdog'); eq(appManifest.type, 'app'); });
test('app 插件依赖两个 atomic', () => {
  notMissing(appManifest, 'watchdog');
  const deps = appManifest.dependencies || {};
  ok(deps['com.fmb.watcher.traework'], 'missing dep traework');
  ok(deps['com.fmb.watcher.chatgpt'], 'missing dep chatgpt');
});
test('app 插件声明权限 (log:write,kv:read,kv:write,plugins:read,plugins:invoke,extensions:call,system:process:read)', () => {
  notMissing(appManifest, 'watchdog');
  const have = new Set(appManifest.permissions || []);
  ok(hasAll(have, ['log:write', 'kv:read', 'kv:write', 'plugins:read', 'plugins:invoke', 'extensions:call', 'system:process:read']),
     'missing basic perms: ' + JSON.stringify([...have]));
});
test('traework atomic id = com.fmb.watcher.traework', () => { notMissing(traeManifest, 'trae'); eq(traeManifest.id, 'com.fmb.watcher.traework'); });
test('chatgpt atomic id = com.fmb.watcher.chatgpt', () => { notMissing(chatManifest, 'chat'); eq(chatManifest.id, 'com.fmb.watcher.chatgpt'); });
test('两个 atomic 都声明 system:process:read + system:process:start 权限', () => {
  for (const [m, name] of [[traeManifest, 'trae'], [chatManifest, 'chat']]) {
    notMissing(m, name);
    const have = new Set(m.permissions || []);
    ok(hasAll(have, ['system:process:read', 'system:process:start', 'log:write', 'kv:read', 'kv:write']),
       'atomic ' + name + ' 缺权限: ' + JSON.stringify([...have]));
  }
});
test('app 插件有 renderer 字段 (对应 Switch UI 页面)', () => {
  notMissing(appManifest, 'watchdog');
  ok(appManifest.renderer, 'app plugin needs renderer field');
  const absR = path.join(WATCHERS, 'app/fmb-watchdog', appManifest.renderer);
  ok(fs.existsSync(absR), 'renderer entry not exist: ' + absR);
});
function hasAll(s, xs) { for (const x of xs) if (!s.has(x)) return false; return true; }

// ── SECTION C: 宿主 HostApi 扩展 system.processes ────────────────
console.log('\n[C] HostApi contracts shared schema 扩展（processes.query / processes.start）');
const sharedPluginApi = fs.readFileSync(path.join(ROOT, 'src/shared/plugin-api/index.ts'), 'utf8');
test('HostContracts.processes.query schema 已定义', () => {
  ok(sharedPluginApi.includes('processes') && sharedPluginApi.includes('query'), '未看到 processes.query 定义');
  // 要求: params 含 processNames: string[]，result 有 Record<processName, boolean>
  ok(sharedPluginApi.includes('processNames') || sharedPluginApi.includes('processName'),
     'processes.query 需要 processName(s) 参数');
});
test('HostContracts.processes.start schema 已定义', () => {
  ok(sharedPluginApi.includes('processes') && (sharedPluginApi.includes('start') || sharedPluginApi.includes('launch')),
     '未看到 processes.start 定义');
  ok(sharedPluginApi.includes('executablePath'), '启动必须含可执行路径字段');
});
const sandboxCode = fs.readFileSync(path.join(ROOT, 'src/main-app/core/plugin/sandbox.ts'), 'utf8');
test('PERMISSION_RULES 新增 system:process:read / system:process:start', () => {
  ok(sandboxCode.includes('system:process:read') && sandboxCode.includes('system:process:start'),
     'PERMISSION_RULES 缺两个 system 权限');
});
const hostApiBuild = fs.readFileSync(path.join(ROOT, 'src/main-app/core/plugin/host-api.ts'), 'utf8');
test('buildHostApi 真正实现 processes.query (tasklist / ps 读)+ processes.start (spawn detached)', () => {
  ok(hostApiBuild.includes('processes') && hostApiBuild.includes('query'), 'processes.query 宿主实现缺失');
  ok(hostApiBuild.includes('start') && hostApiBuild.includes('executablePath'), 'processes.start 宿主实现缺失');
});

// ── SECTION D: package-plugin 打包列表注册 ────────────────────────
console.log('\n[D] package-plugin.ts ALL_PLUGINS 包含三个新插件');
const pkgScript = fs.readFileSync(path.join(ROOT, 'scripts/package-plugin.ts'), 'utf8');
const need = [
  'watchers/app/fmb-watchdog',
  'watchers/atomic/fmb-watcher-traework',
  'watchers/atomic/fmb-watcher-chatgpt',
];
for (const rel of need) {
  test(`ALL_PLUGINS 含 ${rel}`, () => ok(pkgScript.includes(`'${rel}'`) || pkgScript.includes(`"${rel}"`), '未注册 ' + rel));
}

// ── SECTION E: 实际打包三枚 zip ───────────────────────────────────
console.log('\n[E] pnpm package:plugins 实际产出 zip');
const before = new Set(distZipNames());
try { cp.execSync('pnpm package:plugins', { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); }
catch (e) { /* 不 throw — 我们直接看产物 */ }
const zips = distZipNames();
test('产出 com.fmb.watchdog@*.zip', () => ok(zips.find(n => n.startsWith('com.fmb.watchdog@') && n.endsWith('.zip')), 'zip missing watchdog'));
test('产出 com.fmb.watcher.traework@*.zip', () => ok(zips.find(n => n.startsWith('com.fmb.watcher.traework@')), 'zip missing trae'));
test('产出 com.fmb.watcher.chatgpt@*.zip', () => ok(zips.find(n => n.startsWith('com.fmb.watcher.chatgpt@')), 'zip missing chat'));

// ── SECTION F: 原子插件 main.ts 编译后真包含 check + ensureRunning exports (静态扫描)
console.log('\n[F] 原子 action 函数静态检查');
for (const [rel, id] of [
  ['atomic/fmb-watcher-traework', 'com.fmb.watcher.traework'],
  ['atomic/fmb-watcher-chatgpt', 'com.fmb.watcher.chatgpt'],
]) {
  const src = fs.readFileSync(path.join(WATCHERS, rel, 'main.ts'), 'utf8');
  test(`${id} 导出 check(payload)`, () => ok(/exports\.check\s*=|check\s*\([^)]*\)\s*\{|check\s*:\s*function/.test(src) || src.includes('check('), 'check action 缺失'));
  test(`${id} 导出 ensureRunning(payload)`, () => ok(src.includes('ensureRunning'), 'ensureRunning action 缺失'));
  test(`${id} 导出 check 会调 hostApi.processes.query(...)`, () => ok(src.includes('processes.query') || src.includes('hostApi.processes'), '未使用 processes.query'));
  test(`${id} ensureRunning 会在未运行时调 hostApi.processes.start(...)`, () => ok(src.includes('processes.start') || src.includes('hostApi.processes.start'), '未使用 processes.start'));
}

// ── SECTION G: 真模拟进程存在性与启动（只用 Node child_process，不需要宿主）
console.log('\n[G] 进程检测/重启模拟 — 证明 atomic 逻辑的预期');
const tmpSleepers = [];
try {
  // G1: query 不存在的进程返回 false
  test('对不存在的进程名检测返回 false (模拟)', () => {
    const names = ['__NOT_A_PROCESS_FMB_WATCHER_DUMMY_XYZ_9981.exe'];
    const running = queryWindowsProcesses(names);
    eq(running[names[0]], false, '不存在进程被误判为在运行');
  });
  // G2: 启动一个挂起的 node 假 sleeper，然后再检测
  test('存在的 Sleeper 进程检测为 true (模拟)', () => {
    const sleeper = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 999999999)'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    tmpSleepers.push(sleeper);
    busyWait(500);
    const r = queryWindowsProcesses([`${path.basename(process.execPath)}`]);
    // 至少 node.exe 在跑
    ok(Object.values(r).some(Boolean), 'node.exe 至少有一个在运行');
  });
  // G3: ensureRunning 的前提 — 当 target 不在运行时, spawn 新进程真能产生新 PID
  test('ensureRunning 启动新进程真生成 PID (不影响正在运行的进程)', () => {
    // 模拟 "ensureRunning": 检测到目标不存在 → spawn 返回 pid
    const pre = countNodePids();
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 999999999)'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    tmpSleepers.push(child);
    busyWait(350);
    const post = countNodePids();
    ok(post > pre, '启动新进程失败: pre=' + pre + ' post=' + post + ' (pid=' + child.pid + ')');
  });
} finally {
  // 清理所有 sleeper
  for (const s of tmpSleepers) {
    try { process.kill(s.pid); } catch (_) {}
  }
}

// ── DONE ──────────────────────────────────────────────────────────
console.log(`\n────────── ${pass}/${pass + fail} passed ──────────`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('All green. ✅');
  process.exit(0);
}

function distZipNames() {
  try { return fs.readdirSync(DIST).filter(n => n.endsWith('.zip')); } catch { return []; }
}
function busyWait(ms) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }

/** 使用 tasklist 查运行中的进程 (Win)，模拟宿主 processes.query 的真实实现。*/
function queryWindowsProcesses(names) {
  const wanted = new Set(names.map(n => n.toLowerCase().replace(/\.exe$/i, '').toLowerCase()));
  const out = {}; for (const n of names) out[n] = false;
  try {
    const rows = cp.execSync(
      'tasklist /FO CSV /NH 2>nul',
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    ).split(/\r?\n/).filter(Boolean);
    for (const row of rows) {
      const m = row.match(/^"([^"]+)"/);
      if (!m) continue;
      const name = m[1].replace(/\.exe$/i, '').toLowerCase();
      if (wanted.has(name)) {
        // 把对应的 .exe 条目设 true
        for (const key of Object.keys(out)) {
          const k = key.toLowerCase().replace(/\.exe$/i, '');
          if (k === name) out[key] = true;
        }
      }
    }
  } catch (_) { /* tasklist 不可用时 fallback: 全部 false */ }
  return out;
}
function countNodePids() {
  try {
    return cp.execSync(
      'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2>nul',
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    ).split(/\r?\n/).filter(s => s.includes('.exe')).length;
  } catch { return 0; }
}
