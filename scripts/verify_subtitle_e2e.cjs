/*
 * 字幕流水线真实 E2E（纯 Node 零依赖）：
 *   发现运行中实例 → 安装+启用 4 插件 → 注入 DeepInfra key → createTasks → 轮询至 done → 断言 .zh.srt
 *
 * 用法: node scripts/verify_subtitle_e2e.cjs <mediaPath>
 *
 * 与原始 brief 的差异（binding controller 修正）：
 *   - 实例发现优先 portable（D:\BOAT\FAIRY\portable\fmb-data\userData\.fmb-http.json）
 *   - 健康探测 /api/v1/health（实际路由；/api/v1/system/health 兼容兜底）
 *   - 安装/启用走 HTTP 直连（POST /api/v1/plugins, PATCH /api/v1/plugins/:id），不经 CLI
 *   - API key 从 D:\BOAT\SUCCUBUSQ\.env 读 DEEPINFRA_API_KEY，经 studio setConfig 注入，永不明文打印
 *   - 断言追加：entries >= 3
 */
const fs = require('fs'), path = require('path'), http = require('http');

const media = process.argv[2];
if (!media || !fs.existsSync(media)) { console.error('usage: node scripts/verify_subtitle_e2e.cjs <mediaPath>'); process.exit(2); }
const MEDIA = path.resolve(media);
const ROOT = path.resolve(__dirname, '..');

/* ---------- .env → DEEPINFRA_API_KEY（脱敏） ---------- */
function readApiKey() {
  const p = 'D:\\BOAT\\SUCCUBUSQ\\.env';
  if (!fs.existsSync(p)) throw new Error('.env not found: ' + p);
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DEEPINFRA_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('DEEPINFRA_API_KEY not found in .env');
}
const API_KEY = readApiKey();
const MASKED = API_KEY.length > 8 ? API_KEY.slice(0, 3) + '***' + API_KEY.slice(-4) : '***';
console.log('[key] DEEPINFRA_API_KEY loaded: ' + MASKED);

/* ---------- 实例发现：候选 .fmb-http.json + 健康探测 ---------- */
function httpCall(meta, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: meta.port, path: p, method,
      headers: Object.assign({ 'Authorization': 'Bearer ' + meta.token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 30000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (_) { resolve({ status: res.statusCode, json: null, raw: d }); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}
async function probe(meta) {
  for (const p of ['/api/v1/health', '/api/v1/system/health']) {
    try { const r = await httpCall(meta, 'GET', p); if (r.status === 200) return r.json; } catch (_) {}
  }
  return null;
}
async function findHttpMeta() {
  const cands = [
    'D:\\BOAT\\FAIRY\\portable\\fmb-data\\userData\\.fmb-http.json',
    path.join(process.env.APPDATA || '', 'fairy-maid-brigade', '.fmb-http.json'),
    path.join(process.env.LOCALAPPDATA || '', 'fairy-maid-brigade', '.fmb-http.json'),
  ];
  const probed = [];
  for (const c of cands) {
    if (!fs.existsSync(c)) { probed.push(c + ' (missing)'); continue; }
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(c, 'utf8').replace(/^﻿/, '')); } catch (_) {}
    if (!meta || !meta.port || !meta.token) { probed.push(c + ' (unreadable)'); continue; }
    const h = await probe(meta);
    if (h) { console.log('[discovery] live instance: ' + c + ' port=' + meta.port + ' version=' + (h.version || '?')); return meta; }
    probed.push(c + ' (no 200 on health)');
  }
  console.error('BLOCKED: 没有应答的 FMB 实例。探测结果:\n  ' + probed.join('\n  '));
  process.exit(3);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const meta = await findHttpMeta();
  const call = (m, p, b) => httpCall(meta, m, p, b);
  const invoke = (pluginId, action, payload) => call('POST', `/api/v1/plugins/${pluginId}/invoke`, { action, payload });

  /* 1. 安装 + 启用 4 插件（asr → llmtranslate → writer → studio；已安装=幂等跳过） */
  const zips = ['com.fmb.subtitle.asr', 'com.fmb.subtitle.llmtranslate', 'com.fmb.subtitle.writer', 'com.fmb.subtitle.studio'];
  for (const id of zips) {
    const zipPath = path.join(ROOT, 'plugins-dist', id + '@0.1.0.zip');
    if (!fs.existsSync(zipPath)) { console.error('FAIL: zip missing: ' + zipPath); process.exit(1); }
    /* disable 先行（若已启用），保证重装后沙箱加载新代码；未启用时 4xx 忽略 */
    await call('PATCH', '/api/v1/plugins/' + id, { status: 'disabled' });
    const r = await call('POST', '/api/v1/plugins', { zipPath });
    const tail = r.json ? JSON.stringify(r.json).slice(0, 160) : String(r.raw || '').slice(0, 160);
    console.log(`[install] ${id}: http=${r.status} ${tail}`);
    if (r.status >= 400 && !/already|installed|exists|版本/i.test(tail)) { console.error('FAIL: install ' + id); process.exit(1); }
    const e = await call('PATCH', '/api/v1/plugins/' + id, { status: 'enabled' });
    console.log(`[enable]  ${id}: http=${e.status}`);
    if (e.status >= 400) { console.error('FAIL: enable ' + id + ' → ' + (e.raw || JSON.stringify(e.json))); process.exit(1); }
  }

  /* 2. 验证 4 插件 status=enabled */
  const list = await call('GET', '/api/v1/plugins?pageSize=100');
  const items = (list.json && list.json.items) || [];
  for (const id of zips) {
    const it = items.find(x => x.id === id);
    if (!it || it.status !== 'enabled') { console.error('FAIL: plugin not enabled: ' + id + ' status=' + (it && it.status)); process.exit(1); }
  }
  console.log('[verify] 4 plugins enabled');

  /* 3. 注入 API Key（studio.setConfig 会转发给 llmtranslate） */
  const sc = await invoke('com.fmb.subtitle.studio', 'setConfig', { apiKey: API_KEY });
  if (!sc.json || sc.json.ok !== true) { console.error('FAIL: setConfig → ' + JSON.stringify(sc.json || sc.raw)); process.exit(1); }
  const cfg = await invoke('com.fmb.subtitle.studio', 'getConfig', {});
  if (!cfg.json || !cfg.json.result || !cfg.json.result.hasApiKey) { console.error('FAIL: hasApiKey=false after setConfig'); process.exit(1); }
  console.log('[config] apiKey set (' + MASKED + '), hasApiKey=true');

  /* 4. 创建任务并轮询（10s 间隔，90min 上限） */
  const created = await invoke('com.fmb.subtitle.studio', 'createTasks', { paths: [MEDIA], language: 'auto' });
  console.log('[task]', JSON.stringify(created.json));
  if (!created.json || created.json.ok !== true) { console.error('FAIL: createTasks'); process.exit(1); }
  const deadline = Date.now() + 90 * 60 * 1000;
  let finalTask = null, lastLine = '';
  while (Date.now() < deadline) {
    await sleep(10000);
    const l = await invoke('com.fmb.subtitle.studio', 'listTasks', {});
    const tasks = (l.json && l.json.result && l.json.result.tasks) || [];
    /* 同媒体可能有历史任务：取 createdAt 最大者 */
    const mine = tasks.filter(x => path.resolve(x.mediaPath) === MEDIA).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const t = mine[0];
    if (t) {
      const line = `[poll] ${t.status} · ${t.progressText || ''}`;
      if (line !== lastLine) { console.log(line); lastLine = line; }
      if (t.status === 'done') { finalTask = t; break; }
      if (t.status === 'failed') { console.error('FAIL: task failed: ' + t.error); process.exit(1); }
    }
  }
  if (!finalTask) { console.error('FAIL: timeout (90min)'); process.exit(1); }

  /* 5. 断言最终字幕 */
  const finalPath = finalTask.finalPath;
  if (!finalPath || !fs.existsSync(finalPath)) { console.error('FAIL: final srt missing: ' + finalPath); process.exit(1); }
  const buf = fs.readFileSync(finalPath);
  if (buf[0] === 0xEF) { console.error('FAIL: BOM'); process.exit(1); }
  const text = buf.toString('utf8');
  const entries = text.split(/\r\n\r\n|\n\n/).filter(b => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(b));
  if (!entries.length) { console.error('FAIL: no timeline entries'); process.exit(1); }
  if (!/[一-鿿]/.test(text)) { console.error('FAIL: no CJK chars (translation missing?)'); process.exit(1); }
  if (entries.length < 3) { console.error('FAIL: entries < 3 (TTS 有 6-8 句): ' + entries.length); process.exit(1); }
  console.log(`PASS e2e: ${finalPath} entries=${entries.length}`);
  process.exit(0);
})().catch(e => { console.error('FAIL: ' + (e && e.message)); process.exit(1); });
