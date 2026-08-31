#!/usr/bin/env node
/**
 * FMB CLI — standalone command-line tool for the Fairy Maid Brigade.
 *
 * Communicates with a running base via the localhost HTTP API (T15).
 * Discovers port + Bearer token from `<userData>/.fmb-http.json` written
 * by the HTTP server on boot. If the base isn't running, tries to start
 * it silently and retries.
 *
 * 8 command groups: plugin, workflow, schedule, queue, error, logs, status, init.
 *
 * Usage: fmb <group> <action> [options]
 */
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const APP_DIR_NAME = 'fairy-maid-brigade';
const DEFAULT_PORT = 18765;

// ---------- HTTP meta file discovery ----------
function getUserDataDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  return path.join(os.homedir(), '.config', APP_DIR_NAME);
}

function getHttpMeta(): { port: number; token: string } | null {
  // Allow direct override via env vars (used by the self-check harness to
  // avoid race conditions with the .fmb-http.json meta file).
  if (process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN) {
    return { port: parseInt(process.env.FMB_HTTP_PORT, 10), token: process.env.FMB_HTTP_TOKEN };
  }
  const dir = getUserDataDir();
  const metaFile = path.join(dir, '.fmb-http.json');
  if (fs.existsSync(metaFile)) {
    try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* noop */ }
  }
  return null;
}

// ---------- HTTP client ----------
async function apiRequest(method: string, endpoint: string, body?: unknown): Promise<any> {
  const meta = getHttpMeta();
  const port = meta?.port ?? DEFAULT_PORT;
  const token = meta?.token;
  const url = `http://127.0.0.1:${port}/api/v1${endpoint}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token && endpoint !== '/health' && endpoint !== '/openapi.json') {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const detail = data?.detail ?? data?.title ?? text;
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return data;
}

async function ensureBaseRunning(): Promise<void> {
  const port = getHttpMeta()?.port ?? DEFAULT_PORT;
  // Try health endpoint (no auth)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return;
  } catch { /* not running */ }

  // Try to start the base silently
  const exePaths = [
    // Packaged: portable exe next to the app
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Fairy Maid Brigade', 'Fairy Maid Brigade.exe') : null,
    // Dev: electron binary via pnpm dev (best-effort)
    path.join(process.cwd(), 'node_modules', '.bin', 'electron'),
  ].filter(Boolean) as string[];

  for (const exe of exePaths) {
    if (fs.existsSync(exe)) {
      try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); } catch { /* noop */ }
      break;
    }
  }

  // Retry connection
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* retry */ }
  }
  throw new Error('基座未运行且无法自动启动。请先运行 Fairy Maid Brigade 桌面应用。');
}

// ---------- Output helpers ----------
function output(data: any, format: string = 'table'): void {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  // Table format: try to render items as a table
  if (Array.isArray(data?.items) && data.items.length > 0) {
    const items = data.items;
    const keys = Object.keys(items[0]).slice(0, 8);
    // Header
    console.log(keys.map((k) => k.padEnd(20)).join(' | '));
    console.log(keys.map(() => '-'.repeat(20)).join('-+-'));
    for (const item of items) {
      console.log(keys.map((k) => String(item[k] ?? '').slice(0, 20).padEnd(20)).join(' | '));
    }
    console.log(`\n共 ${data.total ?? items.length} 条`);
  } else if (Array.isArray(data)) {
    if (data.length === 0) { console.log('(空)'); return; }
    const keys = Object.keys(data[0]).slice(0, 8);
    console.log(keys.map((k) => k.padEnd(20)).join(' | '));
    console.log(keys.map(() => '-'.repeat(20)).join('-+-'));
    for (const item of data) {
      console.log(keys.map((k) => String(item[k] ?? '').slice(0, 20).padEnd(20)).join(' | '));
    }
    console.log(`\n共 ${data.length} 条`);
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      console.log(`${k.padEnd(24)} ${val.slice(0, 80)}`);
    }
  } else {
    console.log(String(data));
  }
}

function safeRun(fn: () => Promise<void>): void {
  fn().catch((e) => { console.error(`错误: ${e.message}`); process.exit(1); });
}

// ================================================================
//  CLI definition
// ================================================================
const program = new Command();

program
  .name('fmb')
  .description('Fairy Maid Brigade CLI — manage plugins, workflows, schedules, queue, and errors.')
  .version('0.1.0');

// ---- fmb status ----
program
  .command('status')
  .description('健康检查（若基座未运行则自动拉起）')
  .option('--format <fmt>', '输出格式: json|table', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const health = await apiRequest('GET', '/health');
    output(health, opts.format);
  }));

// ---- fmb plugin ----
const plugin = program.command('plugin').description('插件管理');

plugin.command('list')
  .option('--status <s>', '按状态筛选')
  .option('--type <t>', '按类型筛选')
  .option('--format <fmt>', '输出格式', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.type) params.set('type', opts.type);
    const data = await apiRequest('GET', `/plugins?${params}`);
    output(data, opts.format);
  }));

plugin.command('install <zip>')
  .description('从 zip 文件安装插件')
  .action((zip) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', '/plugins', { zipPath: path.resolve(zip) });
    output(data, 'table');
  }));

plugin.command('uninstall <id>')
  .option('--version <v>', '卸载指定版本')
  .action((id, opts) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', `/plugins/${id}/actions/disable`);
    await apiRequest('DELETE', `/plugins/${id}`);
    output({ ok: true, id, ...opts }, 'table');
  }));

plugin.command('enable <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', `/plugins/${id}/actions/enable`);
    output(data, 'table');
  }));

plugin.command('disable <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', `/plugins/${id}/actions/disable`);
    output(data, 'table');
  }));

plugin.command('switch <id> <version>')
  .description('切换插件版本')
  .action((id, version) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', `/plugins/${id}/actions/switch-version`, { version });
    output(data, 'table');
  }));

plugin.command('init')
  .description('脚手架：创建新插件骨架')
  .option('--type <t>', '插件类型: atomic|app|extension', 'atomic')
  .argument('<name>', '插件名称')
  .action((name, opts) => safeRun(async () => {
    const dir = path.resolve(process.cwd(), name);
    if (fs.existsSync(dir)) { console.error(`目录已存在: ${dir}`); process.exit(1); }
    fs.mkdirSync(dir, { recursive: true });
    if (opts.type === 'app') fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });

    const manifest = {
      id: `com.fmb.${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      name,
      version: '0.1.0',
      type: opts.type,
      description: `${name} plugin`,
      permissions: [],
      dependencies: {},
      main: 'main.js',
      ...(opts.type === 'app' ? { renderer: 'renderer/index.js' } : {}),
      extensionPoints: opts.type === 'extension' ? ['plugin.afterInstall'] : [],
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const mainCode = opts.type === 'app'
      ? `module.exports = {\n  echo(input) { return input; },\n};\n`
      : `module.exports = {\n  activate(ctx) { ctx.logger.info('${name} activated'); },\n  deactivate() {},\n  echo(input) { return input; },\n};\n`;
    fs.writeFileSync(path.join(dir, 'main.js'), mainCode, 'utf8');

    if (opts.type === 'app') {
      const rendererCode = `module.exports = {\n  mount(hostEl, hostApi) {\n    hostEl.innerHTML = '<h1>${name}</h1><p>插件 UI 占位</p>';\n  },\n};\n`;
      fs.writeFileSync(path.join(dir, 'renderer', 'index.js'), rendererCode, 'utf8');
    }

    console.log(`已创建插件骨架: ${dir}`);
    console.log(`  manifest.json (type=${opts.type})`);
    console.log(`  main.js`);
    if (opts.type === 'app') console.log(`  renderer/index.js`);
  }));

// ---- fmb workflow ----
const workflow = program.command('workflow').description('工作流管理');

workflow.command('list')
  .option('--format <fmt>', '输出格式', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('GET', '/workflows');
    output(data, opts.format);
  }));

workflow.command('get <id>')
  .option('--format <fmt>', '输出格式', 'table')
  .action((id, opts) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('GET', `/workflows/${id}`);
    output(data, opts.format);
  }));

workflow.command('run <id>')
  .description('执行工作流')
  .option('--input <json>', '输入 JSON', '{}')
  .option('--format <fmt>', '输出格式: json|table', 'json')
  .action((id, opts) => safeRun(async () => {
    await ensureBaseRunning();
    const input = JSON.parse(opts.input);
    const data = await apiRequest('POST', `/workflows/${id}/runs`, { input });
    output(data, opts.format);
  }));

workflow.command('export <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('GET', `/workflows/${id}`);
    const exportData = await apiRequest('GET', `/workflows/${id}/runs?pageSize=20`);
    const payload = { version: 1, workflow: data, runs: exportData };
    const outFile = `${id}.json`;
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`已导出到 ${outFile}`);
  }));

workflow.command('import <file>')
  .action((file) => safeRun(async () => {
    await ensureBaseRunning();
    const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const wf = raw.workflow ?? raw;
    const data = await apiRequest('POST', '/workflows', wf);
    output(data, 'table');
  }));

workflow.command('delete <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('DELETE', `/workflows/${id}`);
    output(data, 'table');
  }));

// ---- fmb schedule ----
const schedule = program.command('schedule').description('定时任务管理');

schedule.command('list')
  .option('--format <fmt>', '输出格式', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('GET', '/schedules');
    output(data, opts.format);
  }));

schedule.command('add')
  .description('新建定时任务')
  .requiredOption('--workflowId <id>', '工作流 ID')
  .option('--cron <expr>', 'cron 表达式')
  .option('--at <iso>', '一次性执行时间 (ISO 8601)')
  .option('--name <n>', '任务名称', 'cli-schedule')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const body: Record<string, unknown> = { name: opts.name, workflowId: opts.workflowId, enabled: true };
    if (opts.cron) body.cronExpr = opts.cron;
    if (opts.at) body.oneShotAtMs = Date.parse(opts.at);
    if (!opts.cron && !opts.at) { console.error('需要 --cron 或 --at'); process.exit(1); }
    const data = await apiRequest('POST', '/schedules', body);
    output(data, 'table');
  }));

schedule.command('remove <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('DELETE', `/schedules/${id}`);
    output(data, 'table');
  }));

schedule.command('pause <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', `/schedules/${id}/actions/pause`);
    output(data, 'table');
  }));

schedule.command('resume <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', `/schedules/${id}/actions/resume`);
    output(data, 'table');
  }));

// ---- fmb queue ----
const queue = program.command('queue').description('队列监控');

queue.command('stats')
  .option('--format <fmt>', '输出格式', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('GET', '/queue/stats');
    output(data, opts.format);
  }));

queue.command('list')
  .option('--status <s>', '按状态筛选')
  .option('--type <t>', '按类型筛选')
  .option('--format <fmt>', '输出格式', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.type) params.set('type', opts.type);
    const data = await apiRequest('GET', `/queue/jobs?${params}`);
    output(data, opts.format);
  }));

queue.command('retry-dead')
  .action(() => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', '/queue/actions/retry-dead');
    output(data, 'table');
  }));

queue.command('clear-dead')
  .action(() => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', '/queue/actions/clear-dead');
    output(data, 'table');
  }));

// ---- fmb error ----
const error = program.command('error').description('错误日志管理');

error.command('list')
  .option('--level <l>', '按级别筛选')
  .option('--from <iso>', '起始时间')
  .option('--to <iso>', '结束时间')
  .option('--format <fmt>', '输出格式', 'table')
  .action((opts) => safeRun(async () => {
    await ensureBaseRunning();
    const params = new URLSearchParams();
    if (opts.level) params.set('level', opts.level);
    if (opts.from) params.set('from', String(Date.parse(opts.from)));
    if (opts.to) params.set('to', String(Date.parse(opts.to)));
    const data = await apiRequest('GET', `/errors?${params}`);
    output(data, opts.format);
  }));

error.command('resolve <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('PATCH', `/errors/${id}`, { resolved: true });
    output(data, 'table');
  }));

error.command('ignore <id>')
  .action((id) => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('PATCH', `/errors/${id}`, { resolved: false });
    output(data, 'table');
  }));

// ---- fmb quit ----
// Asks the running base to gracefully shut down via the /app/quit HTTP route.
program
  .command('quit')
  .description('请求运行中的基座优雅退出 (POST /app/quit)')
  .action(() => safeRun(async () => {
    await ensureBaseRunning();
    const data = await apiRequest('POST', '/app/quit', {});
    output(data, 'json');
  }));

// ---- fmb logs ----
program
  .command('logs')
  .description('查看日志文件')
  .option('--lines <n>', '显示行数', '50')
  .option('--level <l>', '按级别筛选')
  .action((opts) => safeRun(async () => {
    const dir = getUserDataDir();
    const logFile = path.join(dir, 'logs', 'main.log');
    if (!fs.existsSync(logFile)) { console.error(`日志文件不存在: ${logFile}`); process.exit(1); }
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const n = Math.min(parseInt(opts.lines, 10) || 50, lines.length);
    let tail = lines.slice(-n);
    if (opts.level) {
      tail = tail.filter((l) => {
        try { const obj = JSON.parse(l); return obj.level === opts.level; } catch { return false; }
      });
    }
    for (const l of tail) {
      try { const obj = JSON.parse(l); console.log(`[${obj.time ?? ''}] ${obj.level ?? ''} ${obj.msg ?? l}`); }
      catch { console.log(l); }
    }
  }));

// ---- parse ----
program.parseAsync(process.argv).catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});
