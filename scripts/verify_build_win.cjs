// TDD: Windows Production Build 验收脚本 — Artifact integrity + packaging sanity
// - Phase A (structural): 检查 dist9/ 目录产物完整度（2 个安装器 exe + 1 个 unpacked 应用目录 + app.asar + plugins-dist 资源）
// - Phase B (runtime-smoke): 不启动 GUI，只验证 unpacked 资源结构满足便携版 SSOT（plugins-dist/ demo zips 可见、asar 可用）
// 运行方式：node scripts\verify_build_win.cjs
// 注意：Phase A 在 build 完成前运行应全部 FAIL（RED 保证），build 后再跑应全部 GREEN。

const fs = require('fs');
const path = require('path');
const root = 'd:\\FAIRY';
const outDir = path.join(root, 'dist10');
const VERSION = '0.1.0';
const PRODUCT = 'Fairy Maid Brigade';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || String(e))); fail++; } }
function eq(a, b, why) { if (a !== b) throw new Error((why || '') + ` want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function inc(whole, part, why) { if (!String(whole).includes(String(part))) throw new Error((why || '') + ` missing: ${JSON.stringify(part)}`); }
function ninc(whole, part, why) { if (String(whole).includes(String(part))) throw new Error((why || '') + ` unwanted: ${JSON.stringify(String(part).slice(0,200))}`); }
function exists(p, why) { if (!fs.existsSync(p)) throw new Error((why || '') + ` not found: ${p}`); }
function notExists(p, why) { if (fs.existsSync(p)) throw new Error((why || '') + ` must NOT exist: ${p}`); }
function sizeOf(p) { return fs.statSync(p).size; }
function sizeRange(p, minMB, maxMB, why) {
  const sz = sizeOf(p); const min = minMB*1024*1024, max = maxMB*1024*1024;
  if (sz < min || sz > max) throw new Error((why || '') + ` ${p}: size=${(sz/1024/1024).toFixed(2)}MB, want [${minMB},${maxMB}] MB`);
}
function listDir(p) { return fs.existsSync(p) ? fs.readdirSync(p) : null; }

// ---------- helpers ----------
const nsisExe = path.join(outDir, `${PRODUCT} ${VERSION} x64.exe`);
const portableExe = path.join(outDir, `${PRODUCT} ${VERSION} x64 Portable.exe`);
const unpackedDir = path.join(outDir, 'win-unpacked');
const unpackedExe = path.join(unpackedDir, `${PRODUCT}.exe`);
const asarFile = path.join(unpackedDir, 'resources', 'app.asar');
const unpackedPluginsDist = path.join(unpackedDir, 'resources', 'plugins-dist');
const latestBlockMap = path.join(outDir, `${PRODUCT} ${VERSION} x64.exe.blockmap`);  // maybe present but not required

// ---------- Phase A: Installer artifacts presence & sanity ----------
console.log('\n==== Phase A: Artifact presence / size sanity ====\n');

t('A1: dist9/ 目录存在', () => exists(outDir, 'A1'));
t('A2: NSIS 安装器 exe 存在 (' + path.basename(nsisExe) + ')', () => exists(nsisExe, 'A2'));
t('A3: Portable 免安装 exe 存在 (' + path.basename(portableExe) + ')', () => exists(portableExe, 'A3'));
t('A4: win-unpacked 目录存在（electron-builder unpacked 产物）', () => exists(unpackedDir, 'A4'));
t('A5: win-unpacked/Fairy Maid Brigade.exe 存在', () => exists(unpackedExe, 'A5'));

t('A6: NSIS 安装器文件大小合理 [60, 150] MB', () => sizeRange(nsisExe, 60, 150, 'A6'));
t('A7: Portable exe 文件大小合理 [60, 150] MB', () => sizeRange(portableExe, 60, 150, 'A7'));
t('A8: unpacked resources/app.asar 存在（主程序打包）', () => exists(asarFile, 'A8'));
t('A9: app.asar 大小合理 [2, 80] MB（renderer+main+preload+cli+biz deps, antd/hono/better-sqlite3 体积较大）', () => sizeRange(asarFile, 2, 80, 'A9'));

// ---------- Phase B: Bundled content integrity (plugins-dist + asar sanity) ----------
console.log('\n==== Phase B: Bundled content integrity ====\n');

t('B1: unpacked resources/plugins-dist/ 目录存在（demo 插件 zip 随包分发）', () => exists(unpackedPluginsDist, 'B1'));

const demoPluginZips = listDir(unpackedPluginsDist) || [];
t('B2: plugins-dist/ 至少包含 3 个 demo 插件（atomic/app/extension 3 大类）+ 3 个 watcher（watchdog/traework/chatgpt）= >=6 zips', () => {
  const zips = demoPluginZips.filter(f => f.endsWith('.zip'));
  eq(zips.length >= 6, true, 'B2 plugins-dist zip count');
});

const expectedZips = [
  'com.fmb.demo.atomic@',        // atomic/demo-echo (manifest uses generic atomic id)
  'com.fmb.demo.app@',           // app/demo-counter (manifest uses generic app id)
  'com.fmb.demo.extension@',     // extension/demo-install-notify (manifest uses generic extension id)
  'com.fmb.watchdog@',
  'com.fmb.watcher.traework@',
  'com.fmb.watcher.chatgpt@',
];
expectedZips.forEach((pref, idx) => {
  const letter = String.fromCharCode(67 + idx);  // C D E F G H
  t(`B${letter}: plugins-dist/ 中存在前缀 ${JSON.stringify(pref)} 的 zip`, () => {
    const match = demoPluginZips.find(f => f.startsWith(pref) && f.endsWith('.zip'));
    eq(typeof match === 'string' && match.length > pref.length + 2, true, `B${letter} ${pref}`);
  });
});

t('BI: unpacked/resources 中不存在内置 com.fmb.host 插件目录（因为 builtin 概念已移除）', () => {
  const hostCandidates = [
    path.join(unpackedDir, 'resources', 'com.fmb.host@0.1.0'),
    path.join(unpackedDir, 'resources', 'plugins-dist', 'com.fmb.host@0.1.0.zip'),
  ];
  hostCandidates.forEach(p => {
    if (fs.existsSync(p)) throw new Error(`BI 意外存在 host 产物: ${p}`);
  });
});

t('BJ: dist9/ 下没有"临时 work 目录"残留（排除 win-unpacked 后应剩余 2+ 个安装器产物 + 可选 blockmap/latest.yml）', () => {
  const topLevel = fs.readdirSync(outDir);
  // 临时 work 目录常见: __uninstaller-nsis-* / *.log 等
  const knownGarbagePatterns = /^(__uninstaller-nsis-|\.DS_Store|__|\.tmp$)/i;
  const garbage = topLevel.filter(n => knownGarbagePatterns.test(n));
  eq(garbage.length, 0, `BJ 发现疑似垃圾临时文件/目录: ${JSON.stringify(garbage)}`);
});

// ---------- summary ----------
const total = pass + fail;
console.log(`\n── Phase A+B: ${pass}/${total} passed${fail>0?' —— '+fail+' FAILURES ❌':' —— ALL GREEN ✅'}`);
process.exit(fail === 0 ? 0 : 1);
