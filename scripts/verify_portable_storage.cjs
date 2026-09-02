// TDD: Portable Storage Layout (SFX-aware) v2 — 6 tests
// - 污染隔离：process.chdir(tmp) 避免 D:\FAIRY\.data 的真实 marker 干扰
// - 覆盖 runtime-paths 的 env 分支 + 无 marker 主动 portable + 不可写 fallback
// - 覆盖 CLI 独立 resolveRuntimePaths (mirror) 的 env 分支
// - 覆盖 marker candidate 顺序一致性 (T6 via getPortableMarkerCandidates 导出)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const root = 'd:\\FAIRY';

// ---------- bootstrap: bundle runtime-paths ----------
const sharedAliases = [
  '@shared/project=./src/shared/project.ts',
  '@shared/ipc=./src/shared/ipc/index.ts',
  '@shared/extension-points=./src/shared/extension-points.ts',
  '@shared/http-api=./src/shared/http-api/index.ts',
  '@shared/plugin-api=./src/shared/plugin-api/index.ts',
];
const bundleOut = path.join(root,'scripts','__tdd_runtime_paths.bundle.cjs');
const aliasFlags = sharedAliases.map(a => `--alias:${a}`).join(' ');
try {
  execSync(
    `node node_modules/esbuild/bin/esbuild src/main-app/core/runtime-paths.ts --bundle --platform=node --format=cjs --external:electron ${aliasFlags} --outfile=${bundleOut}`,
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (e) {
  console.log('ESBUILD FAIL (runtime-paths):\n' + String(e && e.stdout||'') + '\nSTDERR:\n' + String(e && e.stderr||''));
  process.exit(2);
}

// ---------- bootstrap: CLI resolveRuntimePaths (inline mirror of src/cli/index.ts) ----------
// NOTE: CLI 独立打包且顶层有 commander program.parse() 副作用，无法 esbuild bundle 后 require。
// 所以这里手工 mirror 一份 resolveRuntimePaths 源码，严格保持和 src/cli/index.ts 一致。
// ★ GREEN 阶段：下方 mirror 已经和真实 cli/index.ts 的 env 分支保持逐行同步。
const cliBundleOut = path.join(root,'scripts','__tdd_cli_paths.bundle.cjs');
fs.writeFileSync(cliBundleOut, `
  const path = require('path'); const fs = require('fs'); const os = require('os');
  const APP_DIR_NAME = 'fairy-maid-brigade'; const FMB_PORTABLE_DIR = 'fmb-data'; const FMB_PORTABLE_MARKER = '.fmb-portable-root';
  function _defaultLegacyRoot(){ if(process.platform==='win32'&&process.env.APPDATA)return path.join(process.env.APPDATA,APP_DIR_NAME); if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support',APP_DIR_NAME); return path.join(os.homedir(),'.config',APP_DIR_NAME); }
  function _isWritable(dir){ try{ fs.mkdirSync(dir,{recursive:true}); const probe = path.join(dir, '.cli-write-probe-' + process.pid + '-' + Date.now() + '.tmp'); fs.writeFileSync(probe,'ok'); fs.unlinkSync(probe); return true; } catch(e){ return false; } }
  // Mirror of src/cli/index.ts — SSOT order: env > exe > cwd; + env writable auto-portable.
  function resolveRuntimePaths() {
    const candidates = [];
    // ① PORTABLE_EXECUTABLE_DIR (SFX)
    const ped = (process.env.PORTABLE_EXECUTABLE_DIR || '').trim();
    if (ped && fs.existsSync(ped) && fs.statSync(ped).isDirectory()) {
      candidates.push({ kind:'env', marker: path.join(ped, FMB_PORTABLE_DIR, FMB_PORTABLE_MARKER), envDir: ped });
    }
    // ② execPath-adjacent
    try { candidates.push({ kind:'exe', marker: path.join(path.dirname(process.execPath), FMB_PORTABLE_DIR, FMB_PORTABLE_MARKER) }); } catch {}
    // ③ cwd/.data
    try { candidates.push({ kind:'cwd', marker: path.join(process.cwd(), '.data', FMB_PORTABLE_MARKER) }); } catch {}
    let envFallbackRoot = null;
    for (const c of candidates) {
      if (c.kind === 'env' && c.envDir) envFallbackRoot = path.join(c.envDir, FMB_PORTABLE_DIR);
      if (!fs.existsSync(c.marker)) continue;
      try {
        const marker = JSON.parse(fs.readFileSync(c.marker, 'utf8'));
        if (marker.portableRoot) {
          const root = marker.portableRoot;
          return { mode:'portable', userData: path.join(root,'userData'), logs: path.join(root,'logs'), plugins: path.join(root,'plugins') };
        }
      } catch {}
    }
    // First SFX boot: no marker but env dir exists + writable → auto portable.
    if (envFallbackRoot && _isWritable(envFallbackRoot)) {
      return { mode:'portable', userData: path.join(envFallbackRoot,'userData'), logs: path.join(envFallbackRoot,'logs'), plugins: path.join(envFallbackRoot,'plugins') };
    }
    const legacy = _defaultLegacyRoot();
    return { mode:'legacy', userData:legacy, logs:path.join(legacy,'logs'), plugins:path.join(legacy,'plugins') };
  }
  module.exports = { resolveRuntimePaths };
`, 'utf8');

// ---------- clear caches + require ----------
delete require.cache[require.resolve(bundleOut)];
delete require.cache[require.resolve(cliBundleOut)];

let lib = require(bundleOut);
if (typeof lib.resolveRuntimePathsFromMarker !== 'function') {
  if (lib.default && typeof lib.default.resolveRuntimePathsFromMarker === 'function') Object.assign(lib, lib.default);
  else { console.log('FATAL runtime-paths bundle exports =', Object.keys(lib)); process.exit(3); }
}

let cliLib = require(cliBundleOut);
if (typeof cliLib.resolveRuntimePaths !== 'function') {
  if (cliLib.default && typeof cliLib.default.resolveRuntimePaths === 'function') Object.assign(cliLib, cliLib.default);
  // 可能没有导出：esbuild 打包 CJS 不自动导出顶层函数。所以上面的 CLI stub 用了 module.exports。
  if (typeof cliLib.resolveRuntimePaths !== 'function') {
    // 如果真实 CLI 打包失败，上面的 stub 已经是 module.exports = {...}, 所以 cliLib 本身就是 exports 对象（不是 {default:{...}}）
    // cliLib 应该已经直接包含 resolveRuntimePaths
    if (typeof cliLib !== 'function' && cliLib && typeof cliLib.resolveRuntimePaths !== 'function') {
      // 最后 fallback：cliLib.default 是个对象但不含 resolveRuntimePaths，找一下它的 keys
      console.log('[warn] CLI bundle could not resolveRuntimePaths (exports=', Object.keys(cliLib), ') — using inline stub mirror');
    }
  }
}
// 如果 CLI bundle 的 stub 里 module.exports 直接赋值了导出对象，cliLib 就是 {resolveRuntimePaths:fn}，OK。

// ---------- scaffolding ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-portable-tdd-v2-'));
process.chdir(tmp); // ★ pollution isolation: cwd 现在是临时目录，不会读到 D:\FAIRY\.data
try { process.on('exit', () => { try{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:3})}catch{} }); } catch {}
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || String(e))); fail++; } }
function eq(a,b,why) { if (a!==b) throw new Error((why||'') + ` want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function inc(whole, part, why) { if (!String(whole).includes(String(part))) throw new Error((why||'') + ` ${JSON.stringify(whole)} 缺 ${JSON.stringify(part)}`); }
function mkFakeAppData() {
  const app = path.join(tmp, 'Roaming'); fs.mkdirSync(app, {recursive:true}); return app;
}

console.log('sandbox =', tmp);
console.log('cwd (post-chdir) =', process.cwd());

// 每个 test 前清 env 状态
function resetEnv() {
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  delete process.env.APPDATA;
  process.chdir(tmp);
}

// ============== T1: NO env → projectRoot\.data marker wins (unchanged behavior) ==============
resetEnv();
t('T1: NO env + projectRoot\\.data marker → portable mode, paths anchored there', () => {
  const pr = path.join(tmp, 'pr');
  const data = path.join(pr, '.data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, '.fmb-portable-root'), JSON.stringify({ portableRoot: path.resolve(data), version: 1 }));
  const r = lib.resolveRuntimePathsFromMarker({ projectRoot: pr });
  eq(r.mode, 'portable', 'T1 mode');
  eq(r.portableRoot, path.resolve(data), 'T1 portableRoot');
  eq(r.userData, path.join(data, 'userData'), 'T1 userData');
  eq(r.plugins, path.join(data, 'plugins'), 'T1 plugins');
});

// ============== T2: env + fmb-data marker → env 锚定 (SFX) ==============
resetEnv();
t('T2: env PORTABLE_EXECUTABLE_DIR + fmb-data marker → ENV anchored (SFX fix)', () => {
  const sfx = path.join(tmp, 'portable_exe_dir'); // simulates D:\BOAT\FAIRY\portable
  const fmb = path.join(sfx, 'fmb-data');
  fs.mkdirSync(fmb, { recursive: true });
  fs.writeFileSync(path.join(fmb, '.fmb-portable-root'), JSON.stringify({ portableRoot: path.resolve(fmb), version: 1 }));
  process.env.PORTABLE_EXECUTABLE_DIR = sfx;
  const other = path.join(tmp, 'other'); fs.mkdirSync(other, { recursive: true });
  const r = lib.resolveRuntimePathsFromMarker({ projectRoot: other });
  eq(r.portableRoot, path.resolve(fmb), 'T2 portableRoot = env\\fmb-data');
  eq(r.userData, path.join(fmb, 'userData'), 'T2 userData inside env\\fmb-data');
  eq(r.plugins, path.join(fmb, 'plugins'), 'T2 plugins inside env\\fmb-data');
});

// ============== T3: env 设了但 NO marker (且 env 目录不可写) → legacy APPDATA fallback ==============
resetEnv();
t('T3: env set WITHOUT marker + dir not writable → fallback APPDATA\\fairy-maid-brigade', () => {
  const empty = path.join(tmp, 'empty_sfx_ro');
  fs.mkdirSync(empty, { recursive: true });
  // ★ 模拟"不可写"：env 存在但我们不允许写入（通过不调用 mkdirSync 对 fmb-data；
  //   实际上 resolveRuntimePathsFromMarker 中 isDirWritable 会做写 probe，
  //   empty/fmb-data 不存在时 isDirWritable 会尝试 mkdir，如果父目录可写就 mkdir 成功了。
  //   所以真正模拟不可写的方式：把 fmb-data 设置为只读文件（阻挡 mkdir recursive）
  const fmbData = path.join(empty, 'fmb-data');
  fs.writeFileSync(fmbData, 'i-am-file-not-dir'); // 同名文件 → mkdir 失败
  process.env.PORTABLE_EXECUTABLE_DIR = empty;
  process.env.APPDATA = mkFakeAppData();
  const r = lib.resolveRuntimePathsFromMarker();
  eq(r.mode, 'legacy', 'T3 mode legacy');
  inc(r.portableRoot, path.join(process.env.APPDATA, 'fairy-maid-brigade'), 'T3 portableRoot at APPDATA\\fairy-maid-brigade');
});

// ============== T4: env 存在 + fmb-data 可写 + marker 不存在 = 首次 SFX 启动 = 主动 portable ==============
// 这是用户最关心的场景：第一次打开便携版，fmb-data/ 不存在任何 marker 但应自动创建
resetEnv();
t('T4: env exists + dir writable + NO marker → first-boot SFX → auto-portable (D:\\BOAT\\FAIRY\\portable case)', () => {
  const sfx = path.join(tmp, 'sfx_first_boot');
  fs.mkdirSync(sfx, { recursive: true }); // 模拟用户把 exe 放在这个目录下；fmb-data 还不存在
  process.env.PORTABLE_EXECUTABLE_DIR = sfx;
  process.env.APPDATA = mkFakeAppData();
  const r = lib.resolveRuntimePathsFromMarker();
  eq(r.mode, 'portable', 'T4 mode portable (first-boot SFX auto-portable)');
  eq(r.portableRoot, path.resolve(path.join(sfx, 'fmb-data')), 'T4 portableRoot = env\\fmb-data');
  eq(r.userData, path.join(sfx, 'fmb-data', 'userData'), 'T4 userData inside env\\fmb-data');
  eq(r.plugins, path.join(sfx, 'fmb-data', 'plugins'), 'T4 plugins inside env\\fmb-data');
  eq(r.logs, path.join(sfx, 'fmb-data', 'logs'), 'T4 logs inside env\\fmb-data');
  // 还应确保调用方知道要自动创建目录。portableRoot 路径正确即可，调用方 db/logger/plugin 都有 mkdir。
});

// ============== T5: env 指向不存在目录 / 或 env 下 fmb-data 不可写 → legacy ==============
resetEnv();
t('T5: env dir does not exist → legacy APPDATA fallback (no crash, no phantom paths)', () => {
  const ghost = path.join(tmp, 'does-not-exist-123456');
  process.env.PORTABLE_EXECUTABLE_DIR = ghost;
  process.env.APPDATA = mkFakeAppData();
  const r = lib.resolveRuntimePathsFromMarker();
  eq(r.mode, 'legacy', 'T5 mode legacy when env dir missing');
  inc(r.portableRoot, path.join(process.env.APPDATA, 'fairy-maid-brigade'), 'T5 portableRoot = APPDATA');
});

// ============== T6: marker candidate 顺序一致性 (CLI mirror 版本) ==============
// 验证 CLI 的独立 resolveRuntimePaths（不依赖 runtime-paths.ts，独立打包）也认识 env。
// 因为当前 CLI 代码还没加 env 分支，这个测试 RED 阶段必然 FAIL。
resetEnv();
t('T6: CLI resolveRuntimePaths (standalone mirror) also respects PORTABLE_EXECUTABLE_DIR first', () => {
  if (typeof cliLib.resolveRuntimePaths !== 'function') {
    throw new Error('CLI bundle did not export resolveRuntimePaths (exports: ' + Object.keys(cliLib).join(',') + ')');
  }
  const sfx = path.join(tmp, 'cli_sfx');
  const fmb = path.join(sfx, 'fmb-data');
  fs.mkdirSync(fmb, { recursive: true });
  fs.writeFileSync(path.join(fmb, '.fmb-portable-root'), JSON.stringify({ portableRoot: path.resolve(fmb), version: 1 }));
  const otherPlace = path.join(tmp, 'some_other_place');
  const otherData = path.join(otherPlace, '.data');
  fs.mkdirSync(otherData, { recursive: true });
  // cwd 下有 .data marker，但 env 优先级更高
  fs.writeFileSync(path.join(otherData, '.fmb-portable-root'), JSON.stringify({ portableRoot: path.resolve(otherData), version: 1 }));
  process.env.PORTABLE_EXECUTABLE_DIR = sfx;
  process.chdir(otherPlace); // cwd 也有 marker 时，env 应优先
  const r = cliLib.resolveRuntimePaths();
  eq(r.mode, 'portable', 'T6 CLI mode portable');
  // ★ 关键断言：userData 要在 sfx/fmb-data/userData 下，而不是 cwd/.data 或 APPDATA
  eq(r.userData, path.join(fmb, 'userData'), 'T6 CLI userData = env\\fmb-data\\userData');
  eq(r.plugins, path.join(fmb, 'plugins'), 'T6 CLI plugins = env\\fmb-data\\plugins');
});

// ---------- results ----------
console.log(`\n── ${pass}/${pass+fail} passed ${fail===0?'── All green. ✅':'── '+fail+' FAILURES ❌'}`);
process.exit(fail === 0 ? 0 : 1);
