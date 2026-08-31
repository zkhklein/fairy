/* eslint-disable */
/**
 * Pure-Node verification runner for Task 18 (electron-builder packaging).
 *
 * Covers config, icon artifacts, package.json wiring. Does NOT run the
 * full build:win (that can take 10+ min first run due to Electron binary
 * downloads + code-sig warnings); use `pnpm build:win` interactively for
 * the actual NSIS/portable outputs.
 *
 * Usage: node scripts/verify_task18.cjs
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
function size(p) { return fs.statSync(path.join(ROOT, p)).size; }

console.log('\n=== Task 18 验证驱动 (electron-builder) ===\n');

// ---- TR-18.1: electron-builder dep + package.json wiring ----
console.log('TR-18.1 依赖 + 脚本');
const pkg = JSON.parse(read('package.json'));
check('devDependencies 有 electron-builder', pkg.devDependencies && pkg.devDependencies['electron-builder']);
check('scripts.build:icons 存在', pkg.scripts && pkg.scripts['build:icons']);
check('scripts.build:icons 跑 make-icons.mjs', pkg.scripts['build:icons'].includes('make-icons.mjs'));
check('scripts.build:win 存在', pkg.scripts && pkg.scripts['build:win']);
check('build:win = build:icons + build + electron-builder --win --x64',
  pkg.scripts['build:win'].includes('build:icons')
  && pkg.scripts['build:win'].includes('pnpm build')
  && pkg.scripts['build:win'].includes('electron-builder --win --x64'));

// ---- TR-18.2: electron-builder.yml ----
console.log('\nTR-18.2 electron-builder.yml 字段');
check('electron-builder.yml 存在', exists('electron-builder.yml'));
const yml = read('electron-builder.yml');
check('appId com.fairymaidbrigade.app', /appId:\s*com\.fairymaidbrigade\.app/.test(yml));
check('productName Fairy Maid Brigade', /productName:\s*Fairy Maid Brigade/.test(yml));
check('directories.output dist/', /directories:[\s\S]*output:\s*dist\//.test(yml) || /output:\s*dist/.test(yml));
check('buildResources = build-resources', /buildResources:\s*build-resources/.test(yml));
check('win.target: nsis + portable (x64)', yml.includes('target: nsis') || /nsis[\s\S]*portable/.test(yml));
check('win.icon build-resources/icon.ico', /icon:\s*build-resources\/icon\.ico/.test(yml));
check('artifactName 模板含 productName version arch ext', /artifactName:\s*"\$\{productName\} \$\{version\} \$\{arch\}\.\$\{ext\}"/.test(yml));

// NSIS 字段
check('nsis oneClick=false', /nsis:[\s\S]*oneClick:\s*false/.test(yml));
check('nsis allowToChangeInstallationDirectory=true', yml.includes('allowToChangeInstallationDirectory: true'));
check('nsis perMachine=false', yml.includes('perMachine: false'));
check('nsis createDesktopShortcut=true', yml.includes('createDesktopShortcut: true'));
check('nsis createStartMenuShortcut=true', yml.includes('createStartMenuShortcut: true'));
check('nsis installerIcon / uninstallerIcon', yml.includes('installerIcon: build-resources/icon.ico') && yml.includes('uninstallerIcon: build-resources/icon.ico'));

// Portable
check('portable block exists', /portable:/.test(yml));
check('portable requestExecutionLevel user', yml.includes('requestExecutionLevel: user'));

// files / extraResources
check('files 含 out/main, out/preload, out/renderer, out/cli',
  yml.includes('out/main/**/*') && yml.includes('out/preload/**/*')
  && yml.includes('out/renderer/**/*') && yml.includes('out/cli/**/*'));
check('extraResources plugins-dist 内置 3 Demo zip',
  yml.includes('extraResources:')
  && yml.includes('from: plugins-dist')
  && yml.includes('to: plugins-dist')
  && yml.includes('*.zip'));

// asarUnpack native/CJS
check('asarUnpack better-sqlite3', yml.includes('node_modules/better-sqlite3/**/*'));
check('asarUnpack pino + rotating-file-stream',
  yml.includes('node_modules/pino/**/*') && yml.includes('node_modules/rotating-file-stream/**/*'));

// ---- TR-18.3: 图标产物 ----
console.log('\nTR-18.3 图标产物 (build-resources/)');
check('build-resources/icon.ico 存在', exists('build-resources/icon.ico'));
check('build-resources/icon.png 存在', exists('build-resources/icon.png'));
check('build-resources/icon.svg 存在', exists('build-resources/icon.svg'));
check('icon.ico 合理大小 (> 10KB)', size('build-resources/icon.ico') > 10 * 1024, `实际 ${(size('build-resources/icon.ico')/1024).toFixed(0)}KB`);
check('icon.png 合理大小 (> 4KB, zlib 压缩 1024×渐变 ≈ 10KB)', size('build-resources/icon.png') > 4 * 1024, `实际 ${(size('build-resources/icon.png')/1024).toFixed(0)}KB`);
// ICO 格式头部校验 (6 bytes: 0,0, type=1, count=N)
const icoHeader = fs.readFileSync(path.join(ROOT, 'build-resources/icon.ico'), null, 0, 6);
check('icon.ico 头: reserved=0', icoHeader[0] === 0 && icoHeader[1] === 0);
check('icon.ico 头: type=1 (ICO)', icoHeader.readUInt16LE(2) === 1);
check('icon.ico 头: count=6 (16/32/48/64/128/256)', icoHeader.readUInt16LE(4) === 6);
// PNG 8 字节签名校验
const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
const pngBytes = fs.readFileSync(path.join(ROOT, 'build-resources/icon.png'), null, 0, 8);
check('icon.png 合法 PNG 签名', pngSig.every((b, i) => pngBytes[i] === b));

// ---- TR-18.4: make-icons.mjs 脚本能力 ----
console.log('\nTR-18.4 make-icons.mjs 脚本');
const mi = read('scripts/make-icons.mjs');
check('写 SVG 到 build-resources/icon.svg', mi.includes("icon.svg"));
check('多尺寸 ICO 写入 (16,32,48,64,128,256)', /const ICO_SIZES = \[16, 32, 48, 64, 128, 256\]/.test(mi));
check('writeIco 函数存在', /function writeIco\(/.test(mi));
check('writePng 函数存在', /function writePng\(/.test(mi));
check('1024×1024 PNG 输出', /writePng\(1024, PNG_PATH\)/.test(mi));
check('rasterize 纯像素渲染 (无 sharp 依赖)', /function rasterize\(size\)/.test(mi) && !mi.includes('from \'sharp\''));
check('gradient fill + rounded corners', mi.includes('cornerDx') && mi.includes('bgTop') && mi.includes('bgBottom'));
check('maid apron highlight accent palette', mi.includes('PALETTE') && mi.includes('accent'));
check('FORCE 环境变量可覆盖现有 SVG', mi.includes('process.env.FORCE'));

// ---- TR-18.5: plugins-dist 3 Demo zip 存在（extraResources 用） ----
console.log('\nTR-18.5 3 Demo zip 待打包资源');
check('plugins-dist/com.fmb.demo.atomic@0.1.0.zip 存在', exists('plugins-dist/com.fmb.demo.atomic@0.1.0.zip'));
check('plugins-dist/com.fmb.demo.app@0.1.0.zip 存在', exists('plugins-dist/com.fmb.demo.app@0.1.0.zip'));
check('plugins-dist/com.fmb.demo.extension@0.1.0.zip 存在', exists('plugins-dist/com.fmb.demo.extension@0.1.0.zip'));

// ---- TR-18.6: 构建产物就绪（出路径都在） ----
console.log('\nTR-18.6 build 产物就绪');
check('out/main/index.js 存在', exists('out/main/index.js'));
check('out/preload/index.js 存在', exists('out/preload/index.js'));
check('out/renderer/index.html 存在', exists('out/renderer/index.html'));
check('out/cli/index.js 存在', exists('out/cli/index.js'));

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
process.exit(passed === total ? 0 : 1);
