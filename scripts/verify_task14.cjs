/* eslint-disable */
/**
 * Pure-Node verification runner for Task 14 (CLI implementation).
 *
 * Static structural checks only — no Electron runtime, no running base.
 * Mirrors TR-14.1 ~ TR-14.8.
 *
 * Usage: node scripts/verify_task14.cjs
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

console.log('\n=== Task 14 验证驱动 (no-deps, pure CJS) ===\n');

// ---- TR-14.1: commander dependency + CLI entry ----
console.log('TR-14.1 commander 依赖 + CLI 入口');
const pkg = JSON.parse(read('package.json'));
check('commander in dependencies', pkg.dependencies && pkg.dependencies.commander, `got ${pkg.dependencies?.commander}`);
check('bin field present', pkg.bin && pkg.bin.fmb, 'bin.fmb missing');
check('bin points to out/cli/index.js', pkg.bin && pkg.bin.fmb === 'out/cli/index.js');
check('build:cli script', pkg.scripts && pkg.scripts['build:cli'], 'build:cli missing');
check('build includes build:cli', pkg.scripts && pkg.scripts.build && pkg.scripts.build.includes('build:cli'));
check('typecheck includes tsconfig.cli.json', pkg.scripts && pkg.scripts.typecheck && pkg.scripts.typecheck.includes('tsconfig.cli.json'));
check('tsconfig.cli.json exists', exists('tsconfig.cli.json'));
check('build-cli.mjs bundler exists', exists('scripts/build-cli.mjs'));

const cli = read('src/cli/index.ts');
check('shebang line', cli.startsWith('#!/usr/bin/env node'));
check('imports Command from commander', cli.includes("import { Command } from 'commander'"));
check('program name fmb', cli.includes(".name('fmb')"));
check('program version', cli.includes(".version("));

// ---- TR-14.2: HTTP meta file discovery ----
console.log('\nTR-14.2 HTTP meta 文件发现 (.fmb-http.json)');
check('getUserDataDir function', /function getUserDataDir\(\)/.test(cli));
check('win32 uses APPDATA', cli.includes("process.platform === 'win32'") && cli.includes('process.env.APPDATA'));
check('darwin uses Library/Application Support', cli.includes("process.platform === 'darwin'") && cli.includes('Application Support'));
check('linux uses .config fallback', cli.includes('.config'));
check('APP_DIR_NAME fairy-maid-brigade', cli.includes("APP_DIR_NAME = 'fairy-maid-brigade'"));
check('getHttpMeta function', /function getHttpMeta\(\)/.test(cli));
check('getHttpMeta reads .fmb-http.json', cli.includes("path.join(dir, '.fmb-http.json')"));
check('getHttpMeta returns {port,token}|null', /getHttpMeta\(\): \{ port: number; token: string \} \| null/.test(cli));

// ---- TR-14.3: HTTP client with Bearer auth ----
console.log('\nTR-14.3 HTTP 客户端 + Bearer 认证');
check('apiRequest function', /async function apiRequest\(/.test(cli));
check('uses meta port or DEFAULT_PORT', cli.includes('meta?.port ?? DEFAULT_PORT'));
check('DEFAULT_PORT 18765', cli.includes('DEFAULT_PORT = 18765'));
check('reads token from meta', cli.includes('meta?.token'));
check('Authorization Bearer header', cli.includes('`Bearer ${token}`'));
check('exempts /health from auth', cli.includes("endpoint !== '/health'"));
check('exempts /openapi.json from auth', cli.includes("endpoint !== '/openapi.json'"));
check('sets Content-Type application/json', cli.includes("'Content-Type': 'application/json'"));
check('target 127.0.0.1 loopback', cli.includes('http://127.0.0.1:'));
check('builds /api/v1 endpoint', cli.includes('`http://127.0.0.1:${port}/api/v1${endpoint}`'));
check('throws on !res.ok', cli.includes('if (!res.ok)'));
check('HTTP error includes status + detail', cli.includes('`HTTP ${res.status}: ${detail}`'));
check('parses JSON body', cli.includes('JSON.parse(text)'));

// ---- TR-14.4: ensureBaseRunning (auto-start + retry) ----
console.log('\nTR-14.4 基座自启动 + 重试');
check('ensureBaseRunning function', /async function ensureBaseRunning\(\)/.test(cli));
check('probes /health first', cli.includes("fetch(`http://127.0.0.1:${port}/api/v1/health`"));
check('AbortSignal.timeout on probe', cli.includes('AbortSignal.timeout(2000)'));
check('returns if health ok', cli.includes('if (r.ok) return'));
check('candidate exe paths array', cli.includes('exePaths = ['));
check('packaged exe path', cli.includes('Fairy Maid Brigade.exe'));
check('dev electron binary path', cli.includes("'.bin', 'electron'"));
check('spawns detached + unref', cli.includes('spawn(exe, [], { detached: true') && cli.includes("stdio: 'ignore'") && cli.includes('unref()'));
check('retry loop 10 attempts', cli.includes('i < 10'));
check('500ms retry delay', cli.includes('setTimeout(r, 500)'));
check('throws when base unreachable', cli.includes('基座未运行且无法自动启动'));

// ---- TR-14.5: command groups ----
console.log('\nTR-14.5 命令组覆盖');
check('status command', /program[\s\S]*?\.command\('status'\)/.test(cli));
check('plugin command group', cli.includes("program.command('plugin')"));
check('plugin list', cli.includes("plugin.command('list')"));
check('plugin install <zip>', cli.includes("plugin.command('install <zip>')"));
check('plugin uninstall <id>', cli.includes("plugin.command('uninstall <id>')"));
check('plugin enable <id>', cli.includes("plugin.command('enable <id>')"));
check('plugin disable <id>', cli.includes("plugin.command('disable <id>')"));
check('plugin switch <id> <version>', cli.includes("plugin.command('switch <id> <version>')"));
check('plugin init scaffold', cli.includes("plugin.command('init')"));
check('workflow command group', cli.includes("program.command('workflow')"));
check('workflow list', cli.includes("workflow.command('list')"));
check('workflow get <id>', cli.includes("workflow.command('get <id>')"));
check('workflow run <id>', cli.includes("workflow.command('run <id>')"));
check('workflow export <id>', cli.includes("workflow.command('export <id>')"));
check('workflow import <file>', cli.includes("workflow.command('import <file>')"));
check('workflow delete <id>', cli.includes("workflow.command('delete <id>')"));
check('schedule command group', cli.includes("program.command('schedule')"));
check('schedule list', cli.includes("schedule.command('list')"));
check('schedule add', cli.includes("schedule.command('add')"));
check('schedule remove <id>', cli.includes("schedule.command('remove <id>')"));
check('schedule pause <id>', cli.includes("schedule.command('pause <id>')"));
check('schedule resume <id>', cli.includes("schedule.command('resume <id>')"));
check('queue command group', cli.includes("program.command('queue')"));
check('queue stats', cli.includes("queue.command('stats')"));
check('queue list', cli.includes("queue.command('list')"));
check('queue retry-dead', cli.includes("queue.command('retry-dead')"));
check('queue clear-dead', cli.includes("queue.command('clear-dead')"));
check('error command group', cli.includes("program.command('error')"));
check('error list', cli.includes("error.command('list')"));
check('error resolve <id>', cli.includes("error.command('resolve <id>')"));
check('error ignore <id>', cli.includes("error.command('ignore <id>')"));
check('logs command', cli.includes(".command('logs')"));
check('schedule add required workflowId', cli.includes("requiredOption('--workflowId <id>'"));
check('schedule add --cron option', cli.includes("option('--cron <expr>'"));
check('schedule add --at one-shot option', cli.includes("option('--at <iso>'"));

// ---- TR-14.6: output helpers (table/json) ----
console.log('\nTR-14.6 输出格式化 (table/json)');
check('output function', /function output\(data: any, format: string = 'table'\)/.test(cli));
check('json format branch', cli.includes("if (format === 'json')"));
check('json JSON.stringify pretty', cli.includes('JSON.stringify(data, null, 2)'));
check('table renders items array', cli.includes('Array.isArray(data?.items)'));
check('table header row', cli.includes("keys.map((k) => k.padEnd(20)).join(' | ')"));
check('table separator row', cli.includes("'-'.repeat(20)"));
check('table plain array branch', cli.includes('Array.isArray(data)'));
check('table object branch', cli.includes("data && typeof data === 'object'"));
check('safeRun error wrapper', /function safeRun\(/.test(cli));
check('safeRun exits 1 on error', cli.includes("process.exit(1)"));
check('parseAsync entry', cli.includes('program.parseAsync(process.argv)'));

// ---- TR-14.7: plugin init scaffold generates valid manifest ----
console.log('\nTR-14.7 插件脚手架 init 生成合法 manifest');
check('init creates dir', cli.includes('fs.mkdirSync(dir, { recursive: true })'));
check('init writes manifest.json', cli.includes("path.join(dir, 'manifest.json')"));
check('init manifest has id com.fmb.', cli.includes('com.fmb.'));
check('init manifest version 0.1.0', cli.includes("version: '0.1.0'"));
check('init manifest type from --type', cli.includes("type: opts.type"));
check('init manifest permissions []', cli.includes('permissions: []'));
check('init manifest dependencies {}', cli.includes('dependencies: {}'));
check('init manifest main main.js', cli.includes("main: 'main.js'"));
check('init app type adds renderer', cli.includes("opts.type === 'app'") && cli.includes("renderer: 'renderer/index.js'"));
check('init extension type adds extensionPoints', cli.includes("opts.type === 'extension'") && cli.includes('extensionPoints:'));
check('init writes main.js', cli.includes("path.join(dir, 'main.js')"));
check('init app writes renderer/index.js', cli.includes("path.join(dir, 'renderer', 'index.js')"));

// ---- TR-14.8: HTTP server writes .fmb-http.json ----
console.log('\nTR-14.8 HTTP 服务端写入 .fmb-http.json 供 CLI 发现');
const http = read('src/main-app/http/index.ts');
check('metaPath uses userData dir', http.includes("path.join(electronApp.getPath('userData'), '.fmb-http.json')"));
check('writes port + token', http.includes("JSON.stringify({ port, token }"));
check('utf8 write', http.includes("'utf8')"));
check('log on meta write', http.includes('wrote http meta file for CLI'));
check('warn on write failure', http.includes('failed to write http meta file'));
check('close deletes meta file', http.includes('if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath)'));

// ---- TR-14.9: build-cli.mjs bundler correctness ----
console.log('\nTR-14.9 build-cli.mjs 打包器正确性');
const buildCli = read('scripts/build-cli.mjs');
check('entry src/cli/index.ts', buildCli.includes("src/cli/index.ts"));
check('output out/cli/index.js', buildCli.includes('out/cli/index.js'));
check('platform node', buildCli.includes("platform: 'node'"));
check('format cjs', buildCli.includes("format: 'cjs'"));
check('externalizes node: built-ins', buildCli.includes("'node:*'"));
check('uses tsconfig.cli.json', buildCli.includes('tsconfig.cli.json'));
check('chmod 0o755 for bin', buildCli.includes('fs.chmodSync(OUT_FILE, 0o755)'));
check('watch mode supported', buildCli.includes("mode === 'watch'"));

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
process.exit(passed === total ? 0 : 1);
