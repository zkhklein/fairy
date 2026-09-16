# 字幕提取与翻译流水线（Subtitle Pipeline）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 4 个插件（whisper ASR / LLM 翻译 / 字幕写出 3 个 atomic + subtitle studio 1 个 app），实现"选媒体文件 → whisper 提取外语字幕 → DeepInfra 翻译成中文 → 写出 `<视频名>.zh.srt` 到媒体同目录"的完整链路。

**Architecture:** 每个 atomic = `main.ts`（沙箱插件：action + KV 轮询）+ `runner.js.txt`（沙箱外 Node 脚本，esbuild text loader 内嵌进 main.js，运行时用 `node -e` 直接执行，经 localhost HTTP invoke 回传进度/终态）。app 插件注册 3 节点工作流 `wf-subtitle-flow`，KV 任务队列串行消费（`workflows.start` 同步阻塞返回即终态）。

**Tech Stack:** TypeScript（esbuild 打包）、FMB 插件沙箱（hostApi）、faster-whisper-xxl.exe（PotPlayer 自带）、DeepInfra chat completions（Qwen/Qwen3-30B-A3B）、Node.js stdlib（runner 内 fs/https/child_process）。

**Spec:** `docs/superpowers/specs/2026-09-17-subtitle-pipeline-design.md`（本计划全部要求以 spec 为准；两处实现期验证点已在任务内标注）

## Global Constraints

- Shell 一律 pwsh 7（`C:\Program Files\PowerShell\7\pwsh.exe`），不用 powershell.exe 5.1；文本文件 UTF-8 无 BOM、行尾 LF。
- 插件沙箱无 fs/net/child_process；外部能力只能 `hostApi.processes.start`：PowerShell 必须 `detached:false`，node.exe 用 `detached:true`。
- node.exe 默认路径 `C:\Program Files\nodejs\node.exe`（KV `config:nodePath` 可覆盖）。
- 脚本启动方式固定为 `node -e <script>`（照 baidunetdisk `_launchScript`：消除文件写入竞态；单个脚本保持在 ~20KB 内，远离 32767 字符命令行上限）。
- 脚本源码内禁止 `//` 行注释（字符串拼接历史事故）；用 `/* */` 或不写注释。
- API key 不落盘、不上命令行、不进脚本源码：runner 运行时通过 localhost invoke `getApiKey` 自取。
- manifest.json 的 id/version 与目录约定一致；插件 zip 产物固定 `plugins-dist/`。
- 每完成一个任务：`pnpm typecheck` 保持 0 errors 后 commit。
- 全部完成后：`pnpm package:plugins` + 真实 E2E + `pnpm build:win` 覆盖 `dist/`（standing rule）。

## File Structure

```
plugins-source/subtitle-pipeline/
├─ atomic/asr/manifest.json            com.fmb.subtitle.asr
├─ atomic/asr/runner.js.txt            whisper spawn + 进度解析 + CUDA 回退
├─ atomic/asr/main.ts                  transcribe / storeResult / storeProgress / setConfig
├─ atomic/llmtranslate/manifest.json   com.fmb.subtitle.llmtranslate
├─ atomic/llmtranslate/runner.js.txt   srt 解析 + 分块 + DeepInfra + 编号契约
├─ atomic/llmtranslate/main.ts         translateSrt / getApiKey / storeResult / storeProgress / setConfig
├─ atomic/writer/manifest.json         com.fmb.subtitle.writer
├─ atomic/writer/runner.js.txt         校验 + 写 <stem>.zh.srt + 清理
├─ atomic/writer/main.ts               emit / storeResult / setConfig
└─ app/studio/manifest.json            com.fmb.subtitle.studio
   app/studio/main.ts                  工作流注册 + KV 任务队列 + UI actions
   app/studio/renderer/index.ts        任务页（plain DOM，照 uploader 风格）

scripts/verify_subtitle_writer.cjs     writer runner 自测（纯 Node，零依赖）
scripts/verify_subtitle_llm.cjs        llm runner 自测（内置 mock 服务器）
scripts/verify_subtitle_asr.cjs        asr runner 自测（fake whisper）
scripts/verify_subtitle_e2e.cjs        真实链路验收（打运行中实例，真实视频）
scripts/package-plugin.ts              修改：ALL_PLUGINS += 4 条
```

**参数注入契约（4 个 runner 统一）**：runner 源码第一行固定为 `/*__FMB_PARAMS__*/`；main.ts 发射前做 `RUNNER_SRC.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(params) + ';')`。runner 内引用全局 `P`。自测时 verify 脚本做同样的 replace（或 runner 在 `--selftest` 分支自建 P）。

---

### Task 1: Spike — 锁定 whisper CLI 参数与输出格式

**Files:**
- 不创建仓库文件；产出是结论（写回 Task 4 的命令模板注释与 spec §4.1 备注）

- [ ] **Step 1: 生成 3 秒静音 wav 作探针媒体**

```powershell
node -e "const fs=require('fs');const sr=16000,n=sr*3;const b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);fs.writeFileSync(process.env.TEMP+'\\fmb-spike.wav',b)"
```

- [ ] **Step 2: 以本地模型目录直传跑 whisper（CUDA）**

```powershell
$w="$env:APPDATA\PotPlayerMini64\Engine\Faster-Whisper-XXL\faster-whisper-xxl.exe"; $m="$env:APPDATA\PotPlayerMini64\Model\faster-whisper-large-v3-turbo"; $o="$env:TEMP\fmb-spike-out"; New-Item -ItemType Directory -Force $o | Out-Null; & $w "$env:TEMP\fmb-spike.wav" --model $m --output_dir $o --output_format srt --print_progress --device cuda --compute_type int8_float16 --vad_filter true --standard_asia 2>&1 | Select-Object -Last 30; "EXIT=$LASTEXITCODE"; Get-ChildItem $o
```

- [ ] **Step 3: 记录结论**

确认并记录：(a) `--model <本地目录>` 是否成功加载（若失败，改试 `--model large-v3-turbo --model_dir "$env:APPDATA\PotPlayerMini64\Model"`）；(b) 输出文件名规则（`<名>.srt` 还是 `<名>.<扩展>.srt`）；(c) `--print_progress` 的进度行实际格式；(d) exit code。(e) CUDA 是否生效（日志含 CUDA/cuBLAS 字样或速度明显快）。静音文件产出空 srt 属正常——本 spike 只验证机制，语音内容在 Task 8 E2E 用真实视频验证。

- [ ] **Step 4: 如结论与 spec §4.1 命令模板有偏差，更新 spec**

Run: `git -C d:\FAIRY add docs/superpowers/specs/2026-09-17-subtitle-pipeline-design.md; git -C d:\FAIRY commit -m "docs(spec): lock whisper CLI flags from spike"`

---

### Task 2: writer 原子插件（建立 runner 模式）

**Files:**
- Create: `plugins-source/subtitle-pipeline/atomic/writer/manifest.json`
- Create: `plugins-source/subtitle-pipeline/atomic/writer/runner.js.txt`
- Create: `plugins-source/subtitle-pipeline/atomic/writer/main.ts`
- Test: `scripts/verify_subtitle_writer.cjs`

**Interfaces:**
- Consumes: 无（首个插件）
- Produces: `parseSrt(text)` / `formatSrt(entries)` 的语义约定（llm 插件产出 `translated.srt` 必须满足 writer 的校验：条目>0、text 非空、`HH:MM:SS,mmm --> HH:MM:SS,mmm`）；`/*__FMB_PARAMS__*/` 注入契约；`findHttpMeta/postInvoke` 回调协议（llm/asr runner 复用同代码）

- [ ] **Step 1: 写失败的验收脚本**

Create `scripts/verify_subtitle_writer.cjs`：

```javascript
/* writer runner 验收：fixture srt → 写出 <stem>.zh.srt → 断言内容/编码/清理 */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-writer-'));
const mediaDir = path.join(tmp, 'media'); fs.mkdirSync(mediaDir, { recursive: true });
const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir, { recursive: true });
const mediaPath = path.join(mediaDir, 'episode01.mp4'); fs.writeFileSync(mediaPath, 'fake');
const srtPath = path.join(workDir, 'translated.srt');
fs.writeFileSync(srtPath, '1\r\n00:00:01,000 --> 00:00:03,500\r\n你好世界\r\n\r\n2\n00:00:04,000 --> 00:00:06,000\n第二行\n多行原文已合并\n', 'utf8');
fs.writeFileSync(path.join(workDir, '_asr_runner.js'), 'junk'); /* 验证清理 */

const src = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/writer/runner.js.txt'), 'utf8');
const P = { taskId: 't_test', mediaPath, translatedSrtPath: srtPath, workDir, fmbDataDir: tmp, callbackPluginId: 'com.fmb.subtitle.writer' };
const runner = path.join(tmp, '_runner.js');
fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(P) + ';'));

const r = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
console.log(r.stdout); console.error(r.stderr);
if (r.status !== 0) { console.error('FAIL: runner exit ' + r.status); process.exit(1); }

const finalPath = path.join(mediaDir, 'episode01.zh.srt');
if (!fs.existsSync(finalPath)) { console.error('FAIL: final srt missing'); process.exit(1); }
const raw = fs.readFileSync(finalPath);
if (raw[0] === 0xEF && raw[1] === 0xBB) { console.error('FAIL: BOM present'); process.exit(1); }
const text = raw.toString('utf8');
if (!text.includes('你好世界') || !text.includes('第二行\n多行原文已合并'.replace('\n', '\r\n'))) { console.error('FAIL: content'); process.exit(1); }
if (!/\r\n\r\n/.test(text)) { console.error('FAIL: not CRLF'); process.exit(1); }
if (fs.existsSync(workDir)) { console.error('FAIL: workDir not cleaned'); process.exit(1); }
console.log('PASS writer runner');
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/verify_subtitle_writer.cjs`
Expected: FAIL（读不到 runner.js.txt，抛 ENOENT）

- [ ] **Step 3: 实现 runner.js.txt**

Create `plugins-source/subtitle-pipeline/atomic/writer/runner.js.txt`（首行必须是 `/*__FMB_PARAMS__*/`）：

```javascript
/*__FMB_PARAMS__*/
(function () {
  var fs = require('fs'), path = require('path'), http = require('http');
  function findHttpMeta(fdd) {
    var c = [];
    if (process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN) return { port: +process.env.FMB_HTTP_PORT, token: process.env.FMB_HTTP_TOKEN };
    if (fdd) { c.push(path.join(fdd, '.fmb-http.json')); c.push(path.join(fdd, 'userData', '.fmb-http.json')); }
    if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, 'fairy-maid-brigade', '.fmb-http.json'));
    if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, 'fairy-maid-brigade', '.fmb-http.json'));
    for (var i = 0; i < c.length; i++) { try { if (fs.existsSync(c[i])) return JSON.parse(fs.readFileSync(c[i], 'utf8')); } catch (_) {} }
    return null;
  }
  function postInvoke(meta, pluginId, action, payload) {
    return new Promise(function (resolve) {
      try {
        var body = JSON.stringify({ action: action, payload: payload });
        var req = http.request({ hostname: '127.0.0.1', port: meta.port, path: '/api/v1/plugins/' + pluginId + '/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + meta.token } }, function (res) { var d = ''; res.on('data', function (c2) { d += c2; }); res.on('end', function () { resolve(d); }); });
        req.on('error', function () { resolve(null); });
        req.write(body); req.end();
      } catch (_) { resolve(null); }
    });
  }
  function parseSrt(text) {
    var t = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var blocks = t.split(/\n\n+/), out = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) continue;
      var off = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
      if (off >= lines.length) continue;
      var m = lines[off].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!m) continue;
      out.push({ start: m[1].replace('.', ','), end: m[2].replace('.', ','), text: lines.slice(off + 1).join('\n') });
    }
    return out;
  }
  function formatSrt(entries) {
    var o = [];
    for (var i = 0; i < entries.length; i++) o.push(String(i + 1), entries[i].start + ' --> ' + entries[i].end, entries[i].text, '');
    return o.join('\r\n') + '\r\n';
  }
  function done(obj) {
    var meta = findHttpMeta(P.fmbDataDir);
    var finish = function () { process.exit(obj.ok ? 0 : 1); };
    if (meta && P.callbackPluginId) postInvoke(meta, P.callbackPluginId, 'storeResult', Object.assign({ taskId: P.taskId }, obj)).then(finish); else finish();
    setTimeout(finish, 5000);
  }
  try {
    var entries = parseSrt(fs.readFileSync(P.translatedSrtPath, 'utf8'));
    if (!entries.length) throw new Error('译文 srt 无有效条目');
    for (var i = 0; i < entries.length; i++) if (!entries[i].text.trim()) throw new Error('第 ' + (i + 1) + ' 条译文为空');
    var stem = path.basename(P.mediaPath).replace(/\.[^.]+$/, '');
    var finalPath = path.join(path.dirname(P.mediaPath), stem + '.zh.srt');
    fs.writeFileSync(finalPath, formatSrt(entries), 'utf8');
    try { fs.rmSync(P.workDir, { recursive: true, force: true }); } catch (_) {}
    console.log(JSON.stringify({ ok: true, finalPath: finalPath, entries: entries.length }));
    done({ ok: true, finalPath: finalPath, entries: entries.length });
  } catch (e) {
    console.error('writer failed: ' + (e && e.message));
    done({ ok: false, error: String(e && e.message || e) });
  }
})();
```

注意：第 12 行 `replace(/^﻿/, '')` 中的 `﻿` 是字面 BOM 字符（U+FEFF），写入文件时确保它是真实字符而非转义（本文件本身 UTF-8 无 BOM 保存）。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/verify_subtitle_writer.cjs`
Expected: `PASS writer runner`

- [ ] **Step 5: 写 manifest.json**

Create `plugins-source/subtitle-pipeline/atomic/writer/manifest.json`：

```json
{
  "id": "com.fmb.subtitle.writer",
  "name": "Subtitle Writer",
  "version": "0.1.0",
  "type": "atomic",
  "description": "Validates translated SRT (non-empty entries, legal timeline), writes <stem>.zh.srt next to the media file (UTF-8 no BOM, CRLF), then cleans up the work directory.",
  "permissions": ["system:process:start", "system:process:read", "kv:read", "kv:write", "log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

- [ ] **Step 6: 写 main.ts**

Create `plugins-source/subtitle-pipeline/atomic/writer/main.ts`：

```typescript
/* global hostApi, __hostEnv */
// @ts-nocheck
import runnerSrc from './runner.js.txt';

var DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';

function _env() { return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {}; }
async function _nodePath() { var p = await hostApi.kv.get('config:nodePath'); return (p && p.trim()) || DEFAULT_NODE; }
function _dataRoot() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) { var b = f.lastIndexOf('\\'), s = f.lastIndexOf('/'); var x = Math.max(b, s); if (x < 0) break; f = f.substring(0, x); }
  return f;
}

module.exports = {
  activate(ctx) { ctx.hostApi.logger.info('subtitle-writer activated', { pluginId: ctx.pluginId }); },
  deactivate() { hostApi.logger.info('subtitle-writer deactivated', {}); },

  async setConfig(payload) {
    if (payload && typeof payload.nodePath === 'string') await hostApi.kv.set('config:nodePath', payload.nodePath.trim());
    return { ok: true };
  },

  /* HTTP 回调：runner 终态落 KV，供 emit 轮询 */
  async storeResult(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('writeResult:' + payload.taskId, JSON.stringify(payload));
    return { ok: true };
  },

  /*
   * emit(payload): { taskId, mediaPath, translatedSrtPath, workDir }
   * 启动 runner（node -e），轮询 KV writeResult:<taskId>，2 分钟超时。
   */
  async emit(payload) {
    var taskId = payload && payload.taskId;
    if (!taskId) throw new Error('emit: taskId required');
    if (!payload.mediaPath) throw new Error('emit: mediaPath required');
    if (!payload.translatedSrtPath) throw new Error('emit: translatedSrtPath required');
    if (!payload.workDir) throw new Error('emit: workDir required');
    await hostApi.kv.delete('writeResult:' + taskId);

    var script = runnerSrc.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify({
      taskId: taskId, mediaPath: payload.mediaPath, translatedSrtPath: payload.translatedSrtPath,
      workDir: payload.workDir, fmbDataDir: _dataRoot(), callbackPluginId: 'com.fmb.subtitle.writer',
    }) + ';');

    await hostApi.processes.start({ executablePath: await _nodePath(), args: ['-e', script], detached: true, timeoutMs: 10000 });

    var deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
      var raw = await hostApi.kv.get('writeResult:' + taskId);
      if (raw) {
        var r = JSON.parse(raw);
        if (!r.ok) throw new Error('writer: ' + (r.error || 'unknown'));
        return { ok: true, finalPath: r.finalPath, entries: r.entries };
      }
      await new Promise(function (rs) { setTimeout(rs, 1000); });
    }
    throw new Error('writer: runner timed out (2min)');
  },
};
```

- [ ] **Step 7: 打包冒烟 + 提交**

Run: `node scripts/package-plugin.ts subtitle-pipeline/atomic/writer`
Expected: 产出 `plugins-dist/com.fmb.subtitle.writer@0.1.0.zip`

Run: `git add plugins-source/subtitle-pipeline scripts/verify_subtitle_writer.cjs plugins-dist; git commit -m "feat(subtitle): writer atomic — validated srt emit to <stem>.zh.srt"`

---

### Task 3: llmtranslate 原子插件

**Files:**
- Create: `plugins-source/subtitle-pipeline/atomic/llmtranslate/manifest.json`
- Create: `plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.js.txt`
- Create: `plugins-source/subtitle-pipeline/atomic/llmtranslate/main.ts`
- Test: `scripts/verify_subtitle_llm.cjs`

**Interfaces:**
- Consumes: Task 2 的 `parseSrt/formatSrt` 语义、`/*__FMB_PARAMS__*/`、`findHttpMeta/postInvoke`
- Produces: `translated.srt`（writer 消费）；KV 键 `translateResult:<taskId>`；studio 进度回调 `storeProgress { taskId, stage, text }`；`getApiKey` action（runner 经 localhost invoke 同步取回 `{ key }`）

- [ ] **Step 1: 写失败的验收脚本**

Create `scripts/verify_subtitle_llm.cjs`：

```javascript
/* llm runner 验收：内置 mock（FMB invoke + DeepInfra），验证分块/契约重试/落盘 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-llm-'));
const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir, { recursive: true });
const srtPath = path.join(workDir, 'raw.srt');
let body = '';
for (let i = 1; i <= 60; i++) body += i + '\r\n00:0' + (i % 10) + ':00,000 --> 00:0' + (i % 10) + ':02,000\r\n原文第' + i + '条です\r\n\r\n';
fs.writeFileSync(srtPath, body, 'utf8');

let chunk2Attempts = 0; const seenChunks = [];
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', c => d += c); req.on('end', () => {
    if (req.url.startsWith('/api/v1/plugins/')) {
      const j = JSON.parse(d || '{}');
      if (j.action === 'getApiKey') { res.end(JSON.stringify({ ok: true, result: { key: 'test-key' } })); return; }
      res.end(JSON.stringify({ ok: true, result: null })); return;
    }
    if (req.url === '/v1/openai/chat/completions') {
      const j = JSON.parse(d);
      const nums = [...(j.messages[1].content.matchAll(/«(\d+)»/g))].map(m => +m[1]);
      seenChunks.push(nums.length);
      const isChunk2 = seenChunks.length > 1 && seenChunks.slice(0, -1).reduce((a, b) => a + b, 0) < 60 && seenChunks.length === 2;
      if (isChunk2 && ++chunk2Attempts === 1) { res.end(JSON.stringify({ choices: [{ message: { content: '«1» 坏行' } }] })); return; } /* 契约违反→触发重试 */
      res.end(JSON.stringify({ choices: [{ message: { content: nums.map(n => '«' + n + '» 译文' + n).join('\n') } }], usage: { total_tokens: 100 } }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const src = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.js.txt'), 'utf8');
  const P = {
    taskId: 't_llm', srtPath, sourceLang: 'ja', workDir,
    fmbDataDir: tmp, callbackPluginId: 'com.fmb.subtitle.llmtranslate', studioPluginId: 'com.fmb.subtitle.studio',
    apiBase: 'http://127.0.0.1:' + port, model: 'mock', glossary: '', glossaryPaths: [],
  };
  const runner = path.join(tmp, '_runner.js');
  fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(P) + ';'));
  const env = Object.assign({}, process.env, { FMB_HTTP_PORT: String(port), FMB_HTTP_TOKEN: 'x' });
  const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', env, timeout: 60000 });
  console.log(r.stdout); console.error(r.stderr);
  server.close();
  if (r.status !== 0) { console.error('FAIL: exit ' + r.status); process.exit(1); }
  const out = fs.readFileSync(path.join(workDir, 'translated.srt'), 'utf8');
  if (!out.includes('译文60')) { console.error('FAIL: missing last entry'); process.exit(1); }
  if (chunk2Attempts < 2) { console.error('FAIL: contract retry not exercised'); process.exit(1); }
  if (seenChunks.length < 3) { console.error('FAIL: expected >=3 chunks (60 条 / 25) + retry'); process.exit(1); }
  console.log('PASS llm runner, chunks=' + JSON.stringify(seenChunks) + ' chunk2Attempts=' + chunk2Attempts);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/verify_subtitle_llm.cjs`
Expected: FAIL（runner.js.txt 不存在）

- [ ] **Step 3: 实现 runner.js.txt**

Create `plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.js.txt`（首行 `/*__FMB_PARAMS__*/`；完整实现：parseSrt/formatSrt 照 Task 2 语义；findHttpMeta/postInvoke 照 Task 2 代码逐字复用；新增 postInvokeGet 返回解析后的 `result`）：

```javascript
/*__FMB_PARAMS__*/
(function () {
  var fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
  function findHttpMeta(fdd) {
    var c = [];
    if (process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN) return { port: +process.env.FMB_HTTP_PORT, token: process.env.FMB_HTTP_TOKEN };
    if (fdd) { c.push(path.join(fdd, '.fmb-http.json')); c.push(path.join(fdd, 'userData', '.fmb-http.json')); }
    if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, 'fairy-maid-brigade', '.fmb-http.json'));
    if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, 'fairy-maid-brigade', '.fmb-http.json'));
    for (var i = 0; i < c.length; i++) { try { if (fs.existsSync(c[i])) return JSON.parse(fs.readFileSync(c[i], 'utf8')); } catch (_) {} }
    return null;
  }
  function postRaw(meta, pluginId, action, payload) {
    return new Promise(function (resolve) {
      try {
        var body = JSON.stringify({ action: action, payload: payload });
        var req = http.request({ hostname: '127.0.0.1', port: meta.port, path: '/api/v1/plugins/' + pluginId + '/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + meta.token } }, function (res) { var d = ''; res.on('data', function (x) { d += x; }); res.on('end', function () { resolve(d); }); });
        req.on('error', function () { resolve(null); });
        req.write(body); req.end();
      } catch (_) { resolve(null); }
    });
  }
  function postInvoke(meta, pluginId, action, payload) { return postRaw(meta, pluginId, action, payload).then(function () {}); }
  function invokeGet(meta, pluginId, action, payload) {
    return postRaw(meta, pluginId, action, payload).then(function (d) {
      try { var j = JSON.parse(d); return j && j.result; } catch (_) { return null; }
    });
  }
  function parseSrt(text) {
    var t = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var blocks = t.split(/\n\n+/), out = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) continue;
      var off = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
      if (off >= lines.length) continue;
      var m = lines[off].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!m) continue;
      out.push({ start: m[1].replace('.', ','), end: m[2].replace('.', ','), text: lines.slice(off + 1).join('\n') });
    }
    return out;
  }
  function formatSrt(entries) {
    var o = [];
    for (var i = 0; i < entries.length; i++) o.push(String(i + 1), entries[i].start + ' --> ' + entries[i].end, entries[i].text, '');
    return o.join('\r\n') + '\r\n';
  }
  function chunkEntries(entries, maxN, maxChars) {
    var chunks = [], cur = [], cc = 0;
    for (var i = 0; i < entries.length; i++) {
      var len = entries[i].text.length;
      if (cur.length && (cur.length >= maxN || cc + len > maxChars)) { chunks.push(cur); cur = []; cc = 0; }
      cur.push(entries[i]); cc += len;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }
  function parseNumbered(text) {
    var map = {};
    String(text).split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*«\s*(\d{1,4})\s*»\s*(.*)$/);
      if (m && m[2].trim()) map[+m[1]] = m[2].trim();
    });
    return map;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fatal(msg) { var e = new Error(msg); e.fatal = true; return e; }
  function chatCompletion(cfg, messages, temperature) {
    return new Promise(function (resolve, reject) {
      var u = new URL(cfg.apiBase + '/chat/completions');
      var mod = u.protocol === 'http:' ? http : https;
      var body = JSON.stringify({ model: cfg.model, messages: messages, temperature: temperature, max_tokens: 8192, chat_template_kwargs: { enable_thinking: false } });
      var req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Length': Buffer.byteLength(body) }, timeout: 300000 }, function (res) {
        var d = ''; res.on('data', function (c) { d += c; });
        res.on('end', function () {
          if (res.statusCode === 429 || res.statusCode >= 500) return reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 200)));
          if (res.statusCode !== 200) return reject(fatal('HTTP ' + res.statusCode + ': ' + d.slice(0, 300)));
          try { var j = JSON.parse(d); resolve({ content: j.choices[0].message.content, usage: j.usage || {} }); }
          catch (e) { reject(new Error('bad json: ' + d.slice(0, 120))); }
        });
      });
      req.on('timeout', function () { req.destroy(new Error('request timeout')); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }
  async function callWithRetry(cfg, messages, temperature) {
    var delays = [2000, 4000, 8000, 16000];
    for (var i = 0; ; i++) {
      try { return await chatCompletion(cfg, messages, temperature); }
      catch (e) { if (e.fatal || i >= delays.length) throw e; await sleep(delays[i]); }
    }
  }
  function buildSystem(src) {
    return '你是专业字幕翻译引擎。规则：\n' +
      '1. 把每行从' + src + '翻译为中文，只输出译文行，不输出解释。\n' +
      '2. 输入每行格式 «i» 原文；输出必须严格逐行对应 «i» 译文，行数一致，不得合并、拆分、遗漏。\n' +
      '3. 忠实原文的语气、风格和尺度，不自行净化或改写。\n' +
      '4. 译文是字幕：口语化、简洁，单行译文尽量不超过 30 个汉字。\n' +
      '5.【上下文】仅帮助理解，不要翻译。';
  }
  function loadGlossary() {
    var parts = [];
    (P.glossaryPaths || []).forEach(function (p) {
      try { parts.push('### ' + path.basename(p) + '\n' + fs.readFileSync(p, 'utf8').replace(/^﻿/, '').trim()); }
      catch (e) { console.error('glossary path skipped: ' + p + ' (' + (e && e.message) + ')'); }
    });
    if (P.glossary && String(P.glossary).trim()) parts.push(String(P.glossary).trim());
    return parts.join('\n\n');
  }
  async function main() {
    var meta = findHttpMeta(P.fmbDataDir);
    if (!meta) throw fatal('找不到 FMB HTTP 元信息（.fmb-http.json）');
    var keyRes = await invokeGet(meta, P.callbackPluginId, 'getApiKey', {});
    if (!keyRes || !keyRes.key) throw fatal('未配置 DeepInfra API Key（在 Studio 配置页填写）');
    var cfg = { apiKey: keyRes.key, apiBase: P.apiBase || 'https://api.deepinfra.com/v1/openai', model: P.model || 'Qwen/Qwen3-30B-A3B' };
    var entries = parseSrt(fs.readFileSync(P.srtPath, 'utf8'));
    if (!entries.length) throw fatal('原始 srt 无有效条目');
    var glossary = loadGlossary();
    var src = ({ ja: '日语', en: '英语' })[P.sourceLang] || '外语';
    var chunks = chunkEntries(entries, 25, 1500);
    var totalTokens = 0;
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci], offset = entries.indexOf(chunk[0]);
      var numbered = chunk.map(function (e, i) { return '«' + (offset + i) + '» ' + e.text.replace(/\s+/g, ' '); }).join('\n');
      var userParts = [];
      if (glossary) userParts.push('【术语表/参考资料】\n' + glossary);
      if (ci > 0) {
        var ctxLines = entries.slice(Math.max(0, offset - 2), offset).map(function (e) { return e.text.replace(/\s+/g, ' '); });
        if (ctxLines.length) userParts.push('【上下文】\n' + ctxLines.join('\n'));
      }
      userParts.push('【原文】\n' + numbered);
      var messages = [{ role: 'system', content: buildSystem(src) }, { role: 'user', content: userParts.join('\n\n') }];
      var translated = null, lastErr = null;
      for (var attempt = 0; attempt < 3 && !translated; attempt++) {
        try {
          var temp = attempt === 0 ? 0.3 : 0.15;
          var msgs = attempt === 0 ? messages : messages.concat([{ role: 'user', content: '上次输出行数不符。必须严格逐行输出 «i» 译文，共 ' + chunk.length + ' 行。' }]);
          var r = await callWithRetry(cfg, msgs, temp);
          totalTokens += (r.usage && r.usage.total_tokens) || 0;
          var map = parseNumbered(r.content);
          var lines = [], ok = true;
          for (var k = 0; k < chunk.length; k++) { var v = map[offset + k]; if (!v) { ok = false; break; } lines.push(v); }
          if (ok) translated = lines; else lastErr = new Error('行数不符: expect ' + chunk.length + ' got ' + Object.keys(map).length);
        } catch (e) { lastErr = e; }
      }
      if (!translated) throw fatal('块 ' + (ci + 1) + '/' + chunks.length + ' 翻译失败: ' + (lastErr && lastErr.message));
      for (var k2 = 0; k2 < chunk.length; k2++) chunk[k2].text = translated[k2];
      await postInvoke(meta, P.studioPluginId, 'storeProgress', { taskId: P.taskId, stage: 'translating', text: '翻译中 · 块 ' + (ci + 1) + '/' + chunks.length });
      await postInvoke(meta, P.callbackPluginId, 'storeProgress', { taskId: P.taskId, ts: Date.now() });
    }
    var outPath = path.join(P.workDir, 'translated.srt');
    fs.writeFileSync(outPath, formatSrt(entries), 'utf8');
    console.log(JSON.stringify({ ok: true, translatedSrtPath: outPath, lineCount: entries.length, chunks: chunks.length, tokens: totalTokens }));
    await postInvoke(meta, P.callbackPluginId, 'storeResult', { taskId: P.taskId, ok: true, translatedSrtPath: outPath, lineCount: entries.length, chunks: chunks.length, usage: { total_tokens: totalTokens } });
  }
  main().then(function () { process.exit(0); }).catch(async function (e) {
    console.error('llm failed: ' + (e && e.message));
    try { var meta = findHttpMeta(P.fmbDataDir); if (meta) { await postInvoke(meta, P.callbackPluginId, 'storeResult', { taskId: P.taskId, ok: false, error: String(e && e.message || e) }); await postInvoke(meta, P.studioPluginId, 'storeProgress', { taskId: P.taskId, stage: 'error', text: String(e && e.message || e) }); } } catch (_) {}
    setTimeout(function () { process.exit(1); }, 1000);
  });
})();
```

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/verify_subtitle_llm.cjs`
Expected: `PASS llm runner, chunks=[25,25,10,...]` 且 chunk2Attempts≥2（第一次契约违反、重试成功）

- [ ] **Step 5: 写 manifest.json + main.ts**

Create `plugins-source/subtitle-pipeline/atomic/llmtranslate/manifest.json`：

```json
{
  "id": "com.fmb.subtitle.llmtranslate",
  "name": "LLM Subtitle Translator",
  "version": "0.1.0",
  "type": "atomic",
  "description": "Translates SRT entries to Chinese via DeepInfra (Qwen3-30B-A3B) with chunked numbered-line contract, backoff retries, optional glossary (paste + external file paths). API key is fetched at runtime via localhost invoke, never persisted by the runner.",
  "permissions": ["system:process:start", "system:process:read", "kv:read", "kv:write", "secrets:read", "log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

Create `plugins-source/subtitle-pipeline/atomic/llmtranslate/main.ts`（结构与 Task 2 main.ts 同款；轮询键 `translateResult:<taskId>`；活性等待：KV `llmProgress:<taskId>` 心跳 10 分钟停滞判失败，硬上限 2 小时）：

```typescript
/* global hostApi, __hostEnv */
// @ts-nocheck
import runnerSrc from './runner.js.txt';

var DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';

function _env() { return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {}; }
async function _nodePath() { var p = await hostApi.kv.get('config:nodePath'); return (p && p.trim()) || DEFAULT_NODE; }
function _dataRoot() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) { var b = f.lastIndexOf('\\'), s = f.lastIndexOf('/'); var x = Math.max(b, s); if (x < 0) break; f = f.substring(0, x); }
  return f;
}

module.exports = {
  activate(ctx) { ctx.hostApi.logger.info('subtitle-llmtranslate activated', { pluginId: ctx.pluginId }); },
  deactivate() { hostApi.logger.info('subtitle-llmtranslate deactivated', {}); },

  async setConfig(payload) {
    if (!payload) return { ok: true };
    if (typeof payload.nodePath === 'string') await hostApi.kv.set('config:nodePath', payload.nodePath.trim());
    if (typeof payload.apiBase === 'string') await hostApi.kv.set('config:apiBase', payload.apiBase.trim());
    if (typeof payload.model === 'string') await hostApi.kv.set('config:model', payload.model.trim());
    if (typeof payload.glossary === 'string') await hostApi.kv.set('config:glossary', payload.glossary);
    if (Array.isArray(payload.glossaryPaths)) await hostApi.kv.set('config:glossaryPaths', JSON.stringify(payload.glossaryPaths.filter(function (p) { return typeof p === 'string' && p.trim(); })));
    return { ok: true };
  },

  async getConfig() {
    return {
      ok: true,
      nodePath: await hostApi.kv.get('config:nodePath') || '',
      apiBase: await hostApi.kv.get('config:apiBase') || '',
      model: await hostApi.kv.get('config:model') || '',
      glossary: await hostApi.kv.get('config:glossary') || '',
      glossaryPaths: JSON.parse(await hostApi.kv.get('config:glossaryPaths') || '[]'),
    };
  },

  /* runner 经 localhost invoke 自取 key（不落盘/不上命令行） */
  async getApiKey() {
    var s = await hostApi.secrets.get('deepinfra_api_key');
    return { key: s && s.value ? s.value : null };
  },

  async storeResult(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('translateResult:' + payload.taskId, JSON.stringify(payload));
    return { ok: true };
  },

  /* 活性心跳（runner 每块 POST 一次） */
  async storeProgress(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('llmProgress:' + payload.taskId, String(Date.now()));
    return { ok: true };
  },

  /*
   * translateSrt(payload): { taskId, srtPath, sourceLang, workDir }
   * 轮询 translateResult:<taskId>；10 分钟无心跳判停滞失败；硬上限 2 小时。
   */
  async translateSrt(payload) {
    var taskId = payload && payload.taskId;
    if (!taskId) throw new Error('translateSrt: taskId required');
    if (!payload.srtPath) throw new Error('translateSrt: srtPath required');
    if (!payload.workDir) throw new Error('translateSrt: workDir required');
    await hostApi.kv.delete('translateResult:' + taskId);
    await hostApi.kv.delete('llmProgress:' + taskId);

    var glossaryPaths = [];
    try { glossaryPaths = JSON.parse(await hostApi.kv.get('config:glossaryPaths') || '[]'); } catch (_) {}
    var script = runnerSrc.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify({
      taskId: taskId, srtPath: payload.srtPath, sourceLang: payload.sourceLang || '', workDir: payload.workDir,
      fmbDataDir: _dataRoot(), callbackPluginId: 'com.fmb.subtitle.llmtranslate', studioPluginId: 'com.fmb.subtitle.studio',
      apiBase: await hostApi.kv.get('config:apiBase') || '', model: await hostApi.kv.get('config:model') || '',
      glossary: await hostApi.kv.get('config:glossary') || '', glossaryPaths: glossaryPaths,
    }) + ';');

    await hostApi.processes.start({ executablePath: await _nodePath(), args: ['-e', script], detached: true, timeoutMs: 10000 });

    var hardDeadline = Date.now() + 2 * 60 * 60 * 1000;
    var stallMs = 10 * 60 * 1000;
    var lastBeat = Date.now();
    while (Date.now() < hardDeadline) {
      var raw = await hostApi.kv.get('translateResult:' + taskId);
      if (raw) {
        var r = JSON.parse(raw);
        if (!r.ok) throw new Error('llmtranslate: ' + (r.error || 'unknown'));
        return { ok: true, translatedSrtPath: r.translatedSrtPath, lineCount: r.lineCount, chunks: r.chunks, usage: r.usage };
      }
      var beat = await hostApi.kv.get('llmProgress:' + taskId);
      if (beat) lastBeat = Math.max(lastBeat, parseInt(beat, 10) || lastBeat);
      if (Date.now() - lastBeat > stallMs) throw new Error('llmtranslate: 10 分钟无进度，判定停滞');
      await new Promise(function (rs) { setTimeout(rs, 2000); });
    }
    throw new Error('llmtranslate: runner timed out (2h)');
  },
};
```

- [ ] **Step 6: 打包冒烟 + typecheck + 提交**

Run: `node scripts/package-plugin.ts subtitle-pipeline/atomic/llmtranslate; pnpm typecheck`
Expected: zip 产出；typecheck 0 errors

Run: `git add plugins-source/subtitle-pipeline scripts/verify_subtitle_llm.cjs plugins-dist; git commit -m "feat(subtitle): llmtranslate atomic — chunked numbered-line DeepInfra srt translation"`

---

### Task 4: asr 原子插件

**Files:**
- Create: `plugins-source/subtitle-pipeline/atomic/asr/manifest.json`
- Create: `plugins-source/subtitle-pipeline/atomic/asr/runner.js.txt`
- Create: `plugins-source/subtitle-pipeline/atomic/asr/main.ts`
- Test: `scripts/verify_subtitle_asr.cjs`

**Interfaces:**
- Consumes: Task 1 spike 的 whisper 命令模板；Task 2/3 的回调协议
- Produces: `<workDir>\raw.srt`（llm 消费）；输出契约 `{ ok, srtPath, detectedLanguage, durationMs }`（被工作流 `${nodes.asr.output.srtPath}` 引用）；KV 键 `asrResult:<taskId>`、`asrProgress:<taskId>`

- [ ] **Step 1: 写失败的验收脚本（fake whisper）**

Create `scripts/verify_subtitle_asr.cjs`：

```javascript
/* asr runner 验收：fake whisper 验证进度解析/语言解析/产物改名/CUDA 回退 */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-asr-'));
const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir, { recursive: true });
const mediaPath = path.join(tmp, 'ep01.mp4'); fs.writeFileSync(mediaPath, 'fake');

/* fake whisper：第一次（cuda）以 CUDA 错误退出 3；第二次（cpu）正常产出 */
const fake = path.join(tmp, 'fake-whisper.js');
fs.writeFileSync(fake, `
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2);
const outIdx=args.indexOf('--output_dir');
const outDir=outIdx>=0?args[outIdx+1]:process.cwd();
console.log('Some banner line');
if(args.indexOf('--device')>=0&&args[args.indexOf('--device')+1]==='cuda'){console.error('CUDA error: no kernel image');process.exit(3);}
console.log('Detected language: ja');
['Progress: 10.0%','Progress: 55.0%','Progress: 100.0%'].forEach(l=>console.log(l));
fs.writeFileSync(path.join(outDir,'ep01.srt'),'1\\r\\n00:00:01,000 --> 00:00:02,000\\r\\nこんにちは\\r\\n\\r\\n');
process.exit(0);
`);

const src = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/asr/runner.js.txt'), 'utf8');
const P = {
  taskId: 't_asr', mediaPath, language: 'auto', workDir,
  whisperExe: process.execPath, argsPrefix: [fake], modelDir: tmp,
  fmbDataDir: tmp, callbackPluginId: 'com.fmb.subtitle.asr', studioPluginId: 'com.fmb.subtitle.studio',
};
const runner = path.join(tmp, '_runner.js');
fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(P) + ';'));

const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 60000 });
console.log(r.stdout); console.error(r.stderr);
if (r.status !== 0) { console.error('FAIL: exit ' + r.status); process.exit(1); }
const raw = path.join(workDir, 'raw.srt');
if (!fs.existsSync(raw)) { console.error('FAIL: raw.srt missing'); process.exit(1); }
if (!fs.readFileSync(raw, 'utf8').includes('こんにちは')) { console.error('FAIL: raw.srt content'); process.exit(1); }
let summary; try { summary = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { console.error('FAIL: no json summary'); process.exit(1); }
if (summary.detectedLanguage !== 'ja') { console.error('FAIL: detectedLanguage=' + summary.detectedLanguage); process.exit(1); }
if (summary.retriedWithCpu !== true) { console.error('FAIL: CUDA fallback not exercised'); process.exit(1); }
console.log('PASS asr runner');
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/verify_subtitle_asr.cjs`
Expected: FAIL（runner.js.txt 不存在）

- [ ] **Step 3: 实现 runner.js.txt**

Create `plugins-source/subtitle-pipeline/atomic/asr/runner.js.txt`（首行 `/*__FMB_PARAMS__*/`；findHttpMeta/postInvoke 照 Task 2 逐字复用）。要点：spawn `P.whisperExe`（`P.argsPrefix||[]` 前置参数供自测注入 fake）；whisper 参数数组按 Task 1 spike 结论构建（默认模板：`[mediaPath, '--model', modelDir, '--output_dir', workDir, '--output_format', 'srt', '--print_progress', '--vad_filter', 'true', '--standard_asia', '--device', device, '--compute_type', ct]`，`language!=='auto'` 时追加 `['--language', language]`）；逐行读 stdout+stderr，`/(\d+(?:\.\d+)?)\s*%/` 提进度（节流 ≥2s）POST studio `storeProgress { taskId, stage:'asr', text:'转写中 · N%' }` 并 POST 自己 `storeProgress` 心跳；`/Detected language:\s*(\S+)/i` 记语言；exit 0 → 在 workDir 找第一个 `*.srt` 改名 `raw.srt`；exit≠0 且日志含 `/cuda|cublas|cudnn|float16/i` 且当前是 cuda → 以 `cpu`/`int8` 重跑一次（`retriedWithCpu:true`）；终态 POST 自己 `storeResult` + console 输出 JSON 摘要：

```javascript
/*__FMB_PARAMS__*/
(function () {
  var fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process');
  function findHttpMeta(fdd) {
    var c = [];
    if (process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN) return { port: +process.env.FMB_HTTP_PORT, token: process.env.FMB_HTTP_TOKEN };
    if (fdd) { c.push(path.join(fdd, '.fmb-http.json')); c.push(path.join(fdd, 'userData', '.fmb-http.json')); }
    if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, 'fairy-maid-brigade', '.fmb-http.json'));
    if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, 'fairy-maid-brigade', '.fmb-http.json'));
    for (var i = 0; i < c.length; i++) { try { if (fs.existsSync(c[i])) return JSON.parse(fs.readFileSync(c[i], 'utf8')); } catch (_) {} }
    return null;
  }
  function postInvoke(meta, pluginId, action, payload) {
    return new Promise(function (resolve) {
      try {
        var body = JSON.stringify({ action: action, payload: payload });
        var req = http.request({ hostname: '127.0.0.1', port: meta.port, path: '/api/v1/plugins/' + pluginId + '/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + meta.token } }, function (res) { var d = ''; res.on('data', function (x) { d += x; }); res.on('end', function () { resolve(d); }); });
        req.on('error', function () { resolve(null); });
        req.write(body); req.end();
      } catch (_) { resolve(null); }
    });
  }
  function runWhisper(device, ct, onLine) {
    return new Promise(function (resolve) {
      var args = (P.argsPrefix || []).concat([
        P.mediaPath, '--model', P.modelDir, '--output_dir', P.workDir, '--output_format', 'srt',
        '--print_progress', '--vad_filter', 'true', '--standard_asia', '--device', device, '--compute_type', ct,
      ]);
      if (P.language && P.language !== 'auto') args.push('--language', P.language);
      var child = cp.spawn(P.whisperExe, args, { windowsHide: true });
      var tail = [];
      function feed(chunk) {
        String(chunk).split(/\r?\n/).forEach(function (line) {
          if (!line) return;
          tail.push(line); if (tail.length > 40) tail.shift();
          onLine(line);
        });
      }
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', function (e) { resolve({ code: -1, tail: tail.concat([String(e)]) }); });
      child.on('close', function (code) { resolve({ code: code, tail: tail }); });
    });
  }
  async function main() {
    var meta = findHttpMeta(P.fmbDataDir);
    var detected = '';
    var lastPost = 0;
    var self = P.callbackPluginId, studio = P.studioPluginId;
    var onLine = function (line) {
      var m = line.match(/Detected language:\s*([A-Za-z]+)/i);
      if (m) detected = m[1].toLowerCase();
      var p = line.match(/(\d+(?:\.\d+)?)\s*%/);
      var now = Date.now();
      if (p && now - lastPost >= 2000) {
        lastPost = now;
        if (meta) {
          postInvoke(meta, studio, 'storeProgress', { taskId: P.taskId, stage: 'asr', text: '转写中 · ' + Math.round(parseFloat(p[1])) + '%' });
          postInvoke(meta, self, 'storeProgress', { taskId: P.taskId, ts: now });
        }
      }
    };
    var startedAt = Date.now();
    var r1 = await runWhisper('cuda', 'int8_float16', onLine);
    var retried = false, final = r1;
    if (r1.code !== 0 && /cuda|cublas|cudnn|float16/i.test(r1.tail.join('\n'))) {
      retried = true;
      if (meta) await postInvoke(meta, studio, 'storeProgress', { taskId: P.taskId, stage: 'asr', text: 'CUDA 失败，回退 CPU 重试…' });
      final = await runWhisper('cpu', 'int8', onLine);
    }
    if (final.code !== 0) {
      var errTail = final.tail.slice(-20).join(' | ');
      if (meta) { await postInvoke(meta, self, 'storeResult', { taskId: P.taskId, ok: false, error: 'whisper exit ' + final.code + ': ' + errTail }); await postInvoke(meta, studio, 'storeProgress', { taskId: P.taskId, stage: 'error', text: 'whisper exit ' + final.code }); }
      console.error('asr failed: exit ' + final.code);
      process.exit(1);
    }
    var srt = fs.readdirSync(P.workDir).filter(function (f) { return /\.srt$/i.test(f) && f !== 'raw.srt'; })[0];
    if (!srt) {
      if (meta) await postInvoke(meta, self, 'storeResult', { taskId: P.taskId, ok: false, error: 'whisper 未产出 srt' });
      console.error('asr failed: no srt produced');
      process.exit(1);
    }
    var rawPath = path.join(P.workDir, 'raw.srt');
    fs.renameSync(path.join(P.workDir, srt), rawPath);
    var summary = { ok: true, srtPath: rawPath, detectedLanguage: detected || (P.language !== 'auto' ? P.language : ''), durationMs: Date.now() - startedAt, retriedWithCpu: retried };
    console.log(JSON.stringify(summary));
    if (meta) await postInvoke(meta, self, 'storeResult', Object.assign({ taskId: P.taskId }, summary));
    process.exit(0);
  }
  main().catch(function (e) { console.error('asr crashed: ' + (e && e.message)); process.exit(1); });
})();
```

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/verify_subtitle_asr.cjs`
Expected: `PASS asr runner`（fake 第一次 cuda 退出 3 → 回退 cpu 成功；`retriedWithCpu:true`、`detectedLanguage:'ja'`、raw.srt 就位）

- [ ] **Step 5: 写 manifest.json + main.ts**

Create `plugins-source/subtitle-pipeline/atomic/asr/manifest.json`：

```json
{
  "id": "com.fmb.subtitle.asr",
  "name": "Whisper ASR",
  "version": "0.1.0",
  "type": "atomic",
  "description": "Wraps faster-whisper-xxl.exe (bundled with PotPlayer) to transcribe audio/video into raw.srt with timeline; parses progress + detected language; CUDA failure auto-falls back to CPU int8 once.",
  "permissions": ["system:process:start", "system:process:read", "kv:read", "kv:write", "log:write"],
  "dependencies": {},
  "main": "main.js"
}
```

Create `plugins-source/subtitle-pipeline/atomic/asr/main.ts`（结构同 Task 3；`config:whisperExe`/`config:whisperModel` 覆盖，默认候选由 `__hostEnv.HOME + '\\AppData\\Roaming\\PotPlayerMini64\\...'` 推导；断点续跑：`workDir\raw.srt` 存在则直接返回复用——文件探测用 sevenzip 同款唯一探针进程 `_fileExists`；轮询 `asrResult:<taskId>`，心跳 `asrProgress:<taskId>`，10 分钟停滞判失败，硬上限 4 小时）：

```typescript
/* global hostApi, __hostEnv */
// @ts-nocheck
import runnerSrc from './runner.js.txt';

var DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';

function _env() { return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {}; }
async function _nodePath() { var p = await hostApi.kv.get('config:nodePath'); return (p && p.trim()) || DEFAULT_NODE; }
function _dataRoot() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) { var b = f.lastIndexOf('\\'), s = f.lastIndexOf('/'); var x = Math.max(b, s); if (x < 0) break; f = f.substring(0, x); }
  return f;
}
function _psPath() { var e = _env(); return (e['SystemRoot'] || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; }

/* 唯一名探针判文件存在（照 sevenzip，防串扰） */
async function _fileExists(filePath) {
  var probe = 'fmbp' + Math.random().toString(36).slice(2, 10) + '.exe';
  var checker = "if (Test-Path '" + filePath + "') { Copy-Item \"$env:SystemRoot\\System32\\PING.EXE\" (Join-Path $env:TEMP '" + probe + "') -Force; Start-Process (Join-Path $env:TEMP '" + probe + "') -ArgumentList '-n','6','127.0.0.1' -WindowStyle Hidden; }";
  try {
    var enc = Buffer.from(checker, 'utf16le').toString('base64');
    await hostApi.processes.start({ executablePath: _psPath(), args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], detached: false, timeoutMs: 8000 });
  } catch (_) { return false; }
  for (var i = 0; i < 16; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    var q = await hostApi.processes.query({ processNames: [probe] });
    if (q[probe]) return true;
  }
  return false;
}

async function _whisperExe() {
  var p = await hostApi.kv.get('config:whisperExe');
  if (p && p.trim()) return p.trim();
  var e = _env();
  return (e.HOME || 'C:\\Users\\Public') + '\\AppData\\Roaming\\PotPlayerMini64\\Engine\\Faster-Whisper-XXL\\faster-whisper-xxl.exe';
}
async function _modelDir() {
  var p = await hostApi.kv.get('config:whisperModel');
  if (p && p.trim()) return p.trim();
  var e = _env();
  return (e.HOME || 'C:\\Users\\Public') + '\\AppData\\Roaming\\PotPlayerMini64\\Model\\faster-whisper-large-v3-turbo';
}

module.exports = {
  activate(ctx) { ctx.hostApi.logger.info('subtitle-asr activated', { pluginId: ctx.pluginId }); },
  deactivate() { hostApi.logger.info('subtitle-asr deactivated', {}); },

  async setConfig(payload) {
    if (!payload) return { ok: true };
    if (typeof payload.nodePath === 'string') await hostApi.kv.set('config:nodePath', payload.nodePath.trim());
    if (typeof payload.whisperExe === 'string') await hostApi.kv.set('config:whisperExe', payload.whisperExe.trim());
    if (typeof payload.whisperModel === 'string') await hostApi.kv.set('config:whisperModel', payload.whisperModel.trim());
    return { ok: true };
  },

  async getConfig() {
    return {
      ok: true,
      whisperExe: await hostApi.kv.get('config:whisperExe') || '',
      whisperModel: await hostApi.kv.get('config:whisperModel') || '',
      nodePath: await hostApi.kv.get('config:nodePath') || '',
    };
  },

  async storeResult(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('asrResult:' + payload.taskId, JSON.stringify(payload));
    return { ok: true };
  },
  async storeProgress(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('asrProgress:' + payload.taskId, String((payload && payload.ts) || Date.now()));
    return { ok: true };
  },

  /*
   * transcribe(payload): { taskId, mediaPath, language: 'ja'|'en'|'auto', workDir }
   * → { ok, srtPath, detectedLanguage, durationMs, reused? }
   */
  async transcribe(payload) {
    var taskId = payload && payload.taskId;
    if (!taskId) throw new Error('transcribe: taskId required');
    if (!payload.mediaPath) throw new Error('transcribe: mediaPath required');
    if (!payload.workDir) throw new Error('transcribe: workDir required');
    var language = payload.language || 'auto';
    var rawPath = payload.workDir + '\\raw.srt';

    if (await _fileExists(rawPath)) {
      hostApi.logger.info('asr: raw.srt exists, reuse', { taskId: taskId });
      return { ok: true, srtPath: rawPath, detectedLanguage: language !== 'auto' ? language : '', durationMs: 0, reused: true };
    }

    await hostApi.kv.delete('asrResult:' + taskId);
    await hostApi.kv.delete('asrProgress:' + taskId);

    var script = runnerSrc.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify({
      taskId: taskId, mediaPath: payload.mediaPath, language: language, workDir: payload.workDir,
      whisperExe: await _whisperExe(), modelDir: await _modelDir(),
      fmbDataDir: _dataRoot(), callbackPluginId: 'com.fmb.subtitle.asr', studioPluginId: 'com.fmb.subtitle.studio',
    }) + ';');

    await hostApi.processes.start({ executablePath: await _nodePath(), args: ['-e', script], detached: true, timeoutMs: 10000 });

    var hardDeadline = Date.now() + 4 * 60 * 60 * 1000;
    var stallMs = 10 * 60 * 1000;
    var lastBeat = Date.now();
    while (Date.now() < hardDeadline) {
      var raw = await hostApi.kv.get('asrResult:' + taskId);
      if (raw) {
        var r = JSON.parse(raw);
        if (!r.ok) throw new Error('asr: ' + (r.error || 'unknown'));
        return { ok: true, srtPath: r.srtPath, detectedLanguage: r.detectedLanguage || (language !== 'auto' ? language : 'ja'), durationMs: r.durationMs };
      }
      var beat = await hostApi.kv.get('asrProgress:' + taskId);
      if (beat) lastBeat = Math.max(lastBeat, parseInt(beat, 10) || lastBeat);
      if (Date.now() - lastBeat > stallMs) throw new Error('asr: 10 分钟无进度，判定停滞');
      await new Promise(function (rs) { setTimeout(rs, 2000); });
    }
    throw new Error('asr: runner timed out (4h)');
  },
};
```

- [ ] **Step 6: 打包冒烟 + typecheck + 提交**

Run: `node scripts/package-plugin.ts subtitle-pipeline/atomic/asr; pnpm typecheck`
Expected: zip 产出；typecheck 0 errors

Run: `git add plugins-source/subtitle-pipeline scripts/verify_subtitle_asr.cjs plugins-dist; git commit -m "feat(subtitle): asr atomic — faster-whisper-xxl wrapper with progress parse + cuda fallback"`

---

### Task 5: studio app 后端（工作流注册 + 任务队列）

**Files:**
- Create: `plugins-source/subtitle-pipeline/app/studio/manifest.json`
- Create: `plugins-source/subtitle-pipeline/app/studio/main.ts`

**Interfaces:**
- Consumes: 三原子的 action（经工作流 DAG）；`hostApi.workflows.create/start/get`、`secrets.set`
- Produces: UI 用 action：`listTasks/createTasks/retryTask/deleteTask/getConfig/setConfig`；runner 用回调：`storeProgress`；工作流 id `wf-subtitle-flow`；任务模型字段（Task 6 renderer 依赖）：`{ taskId, mediaPath, fileName, language, status, progressText, error, finalPath, createdAt, finishedAt }`，status ∈ `queued|asr|translating|writing|done|failed`

- [ ] **Step 1: 写 manifest.json**

Create `plugins-source/subtitle-pipeline/app/studio/manifest.json`：

```json
{
  "id": "com.fmb.subtitle.studio",
  "name": "字幕工坊",
  "version": "0.1.0",
  "type": "app",
  "description": "选择外语视频/音频 → Whisper 提取字幕 → LLM 翻译成中文 → 在媒体同目录生成 <文件名>.zh.srt（PotPlayer 自动加载）。任务串行执行，支持失败重试与断点续跑。",
  "permissions": [
    "log:write", "audit:write", "kv:read", "kv:write",
    "plugins:read", "plugins:invoke",
    "workflows:create", "workflows:read", "workflows:execute",
    "secrets:read", "secrets:write",
    "system:process:start", "system:process:read"
  ],
  "dependencies": {
    "com.fmb.subtitle.asr": "^0.1.0",
    "com.fmb.subtitle.llmtranslate": "^0.1.0",
    "com.fmb.subtitle.writer": "^0.1.0"
  },
  "main": "main.js",
  "renderer": "renderer/index.ts"
}
```

- [ ] **Step 2: 实现 main.ts**

Create `plugins-source/subtitle-pipeline/app/studio/main.ts`。要点：

- `activate(ctx)`：注册工作流（先 `workflows.get('wf-subtitle-flow')`，无则 create，容忍已存在报错）；`setInterval` 2s 消费队列；把 `asr/translating/writing` 状态的遗留任务重置为 `queued`（断点续跑）
- 工作流定义（注意 `${...}` 是工作流引擎的插值语法，TS 里用普通字符串拼接避免被模板字符串吞掉）：

```typescript
/* global hostApi, __hostEnv */
// @ts-nocheck

var WF_ID = 'wf-subtitle-flow';
var TASKS_KEY = 'tasks';
var _running = false;

function _dataRoot() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) { var b = f.lastIndexOf('\\'), s = f.lastIndexOf('/'); var x = Math.max(b, s); if (x < 0) break; f = f.substring(0, x); }
  return f;
}
async function _loadTasks() { try { return JSON.parse(await hostApi.kv.get(TASKS_KEY) || '[]'); } catch (_) { return []; } }
async function _saveTasks(tasks) { await hostApi.kv.set(TASKS_KEY, JSON.stringify(tasks)); }
function _tid() { return 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function _baseName(p) { var i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i >= 0 ? p.slice(i + 1) : p; }
function _finalPathFor(mediaPath) {
  var i = Math.max(mediaPath.lastIndexOf('\\'), mediaPath.lastIndexOf('/'));
  var dir = i >= 0 ? mediaPath.slice(0, i) : '';
  var stem = _baseName(mediaPath).replace(/\.[^.]+$/, '');
  return dir + '\\' + stem + '.zh.srt';
}

async function _ensureWorkflow() {
  var existing = null;
  try { existing = await hostApi.workflows.get(WF_ID); } catch (_) { existing = null; }
  if (existing) return;
  var def = {
    nodes: [
      { id: 'asr', type: 'atomic', pluginId: 'com.fmb.subtitle.asr', action: 'transcribe',
        inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}', language: '${input.language}', workDir: '${input.workDir}' } },
      { id: 'translate', type: 'atomic', pluginId: 'com.fmb.subtitle.llmtranslate', action: 'translateSrt',
        inputs: { taskId: '${input.taskId}', srtPath: '${nodes.asr.output.srtPath}', sourceLang: '${nodes.asr.output.detectedLanguage}', workDir: '${input.workDir}' } },
      { id: 'write', type: 'atomic', pluginId: 'com.fmb.subtitle.writer', action: 'emit',
        inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}', translatedSrtPath: '${nodes.translate.output.translatedSrtPath}', workDir: '${input.workDir}' } },
    ],
    edges: [{ source: 'asr', target: 'translate' }, { source: 'translate', target: 'write' }],
    entryNode: 'asr',
    vars: {},
  };
  try {
    await hostApi.workflows.create({ id: WF_ID, name: '字幕提取翻译流水线', description: 'whisper 转写 → LLM 翻译 → 写出 .zh.srt 到媒体同目录', definition: def });
    hostApi.logger.info('studio: workflow created', { id: WF_ID });
  } catch (e) {
    hostApi.logger.info('studio: workflow already exists', { error: e && e.message });
  }
}

async function _runTask(task) {
  var tasks = await _loadTasks();
  var me = tasks.find(function (t) { return t.taskId === task.taskId; });
  if (!me) return;
  me.status = 'asr'; me.progressText = '排队启动…'; me.error = '';
  await _saveTasks(tasks);
  try {
    var r = await hostApi.workflows.start(WF_ID, {
      taskId: me.taskId, mediaPath: me.mediaPath, language: me.language || 'auto',
      workDir: _dataRoot() + '\\subtitle-tasks\\' + me.taskId,
    });
    var ok = r && r.status === 'success';
    var tasks2 = await _loadTasks();
    var me2 = tasks2.find(function (t) { return t.taskId === task.taskId; });
    if (me2) {
      me2.status = ok ? 'done' : 'failed';
      if (ok) { me2.finalPath = _finalPathFor(me2.mediaPath); me2.progressText = '完成'; }
      else if (!me2.error) me2.error = '工作流执行失败（详见错误日历/日志）';
      me2.finishedAt = Date.now();
      await _saveTasks(tasks2);
    }
  } catch (e) {
    var tasks3 = await _loadTasks();
    var me3 = tasks3.find(function (t) { return t.taskId === task.taskId; });
    if (me3) { me3.status = 'failed'; me3.error = String(e && e.message || e); me3.finishedAt = Date.now(); await _saveTasks(tasks3); }
  }
}

async function _tick() {
  if (_running) return;
  var tasks = await _loadTasks();
  var next = tasks.find(function (t) { return t.status === 'queued'; });
  if (!next) return;
  _running = true;
  try { await _runTask(next); } finally { _running = false; }
}

module.exports = {
  async activate(ctx) {
    ctx.hostApi.logger.info('subtitle-studio activated', { pluginId: ctx.pluginId });
    await _ensureWorkflow();
    var tasks = await _loadTasks();
    var changed = false;
    tasks.forEach(function (t) {
      if (t.status === 'asr' || t.status === 'translating' || t.status === 'writing') { t.status = 'queued'; t.progressText = '重启后自动恢复排队'; changed = true; }
    });
    if (changed) await _saveTasks(tasks);
    setInterval(function () { _tick().catch(function (e) { hostApi.logger.warn('studio tick error', { error: e && e.message }); }); }, 2000);
  },
  deactivate() { hostApi.logger.info('subtitle-studio deactivated', {}); },

  /* ---- UI actions ---- */
  async listTasks() { return { ok: true, tasks: await _loadTasks() }; },

  async createTasks(payload) {
    var paths = (payload && payload.paths) || [];
    var language = (payload && payload.language) || 'auto';
    if (!paths.length) throw new Error('createTasks: paths required');
    var tasks = await _loadTasks();
    var added = [];
    paths.forEach(function (p) {
      if (tasks.some(function (t) { return t.mediaPath === p && t.status !== 'failed' && t.status !== 'done'; })) return;
      var t = { taskId: _tid(), mediaPath: p, fileName: _baseName(p), language: language, status: 'queued', progressText: '排队中', error: '', finalPath: '', createdAt: Date.now(), finishedAt: 0 };
      tasks.push(t); added.push(t);
    });
    await _saveTasks(tasks);
    return { ok: true, added: added.length };
  },

  async retryTask(payload) {
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === (payload && payload.taskId); });
    if (!t) throw new Error('任务不存在');
    t.status = 'queued'; t.error = ''; t.progressText = '排队重试'; t.finishedAt = 0;
    await _saveTasks(tasks);
    return { ok: true };
  },

  async deleteTask(payload) {
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === (payload && payload.taskId); });
    if (t && (t.status === 'asr' || t.status === 'translating' || t.status === 'writing')) throw new Error('任务执行中，暂不支持删除（可重启后删除）');
    tasks = tasks.filter(function (x) { return x.taskId !== (payload && payload.taskId); });
    await _saveTasks(tasks);
    return { ok: true };
  },

  async getConfig() {
    var key = await hostApi.secrets.get('deepinfra_api_key');
    return { ok: true, hasApiKey: !!(key && key.value) };
  },

  async setConfig(payload) {
    if (payload && typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      await hostApi.secrets.set('deepinfra_api_key', payload.apiKey.trim(), 'DeepInfra API Key for subtitle translation');
    }
    return { ok: true };
  },

  /* ---- 透传原子插件配置（studio UI 只能 callPluginMainAction 自己；经 plugins.invoke 转发） ---- */
  async getAsrConfig() {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.asr', method: 'getConfig', payload: {} });
  },
  async setAsrConfig(payload) {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.asr', method: 'setConfig', payload: payload || {} });
  },
  async getLlmConfig() {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.llmtranslate', method: 'getConfig', payload: {} });
  },
  async setLlmConfig(payload) {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.llmtranslate', method: 'setConfig', payload: payload || {} });
  },
  async setWriterConfig(payload) {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.writer', method: 'setConfig', payload: payload || {} });
  },

  /* ---- runner 回调 ---- */
  async storeProgress(payload) {
    if (!payload || !payload.taskId) return { ok: true };
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === payload.taskId; });
    if (!t) return { ok: true };
    if (payload.stage === 'asr') t.status = 'asr';
    else if (payload.stage === 'translating') t.status = 'translating';
    else if (payload.stage === 'error') { t.error = payload.text || t.error; }
    if (payload.text) t.progressText = payload.text;
    await _saveTasks(tasks);
    return { ok: true };
  },
};
```

- [ ] **Step 3: 打包冒烟（含 bundled 依赖断言）+ 提交**

Run: `node scripts/package-plugin.ts subtitle-pipeline/app/studio`
Expected: 产出 `plugins-dist/com.fmb.subtitle.studio@0.1.0.zip`，且日志显示 `embedded 3 bundled dep(s)`

断言 bundled zip 内容：

```powershell
node -e "const AdmZip=require('d:/FAIRY/node_modules/adm-zip');const z=new AdmZip('d:/FAIRY/plugins-dist/com.fmb.subtitle.studio@0.1.0.zip');const names=z.getEntries().map(e=>e.entryName);console.log(names.join('\n'));const need=['bundled/com.fmb.subtitle.asr@0.1.0.zip','bundled/com.fmb.subtitle.llmtranslate@0.1.0.zip','bundled/com.fmb.subtitle.writer@0.1.0.zip'];const miss=need.filter(n=>!names.includes(n));if(miss.length){console.error('MISSING: '+miss.join(','));process.exit(1)}console.log('BUNDLED OK')"
```

Expected: `BUNDLED OK`

Run: `pnpm typecheck; git add plugins-source/subtitle-pipeline plugins-dist; git commit -m "feat(subtitle): studio app backend — wf-subtitle-flow + serial task queue"`

---

### Task 6: studio renderer（任务页 UI）

**Files:**
- Create: `plugins-source/subtitle-pipeline/app/studio/renderer/index.ts`

**Interfaces:**
- Consumes: Task 5 的 action 与任务模型；`hostApi.callPluginMainAction(action, payload)`；`window.fmb.dialogShowOpen`
- Produces: 无（叶子）

- [ ] **Step 1: 实现 renderer/index.ts**

Create `plugins-source/subtitle-pipeline/app/studio/renderer/index.ts`（plain DOM，Shadow DOM 内运行，样式全部内联——照 demo-counter/uploader 契约）。完整实现：

```typescript
/**
 * subtitle-studio renderer — 任务列表 + 文件选择 + 语言覆盖 + 配置区。
 * Renderer contract: host compiles to renderer.umd.js; AppPluginPage calls
 * module.exports.mount(container, hostUIApi). Plain DOM (no React).
 * hostUIApi.callPluginMainAction(action, payload) → sandbox main module.
 * window.fmb.dialogShowOpen → native file picker.
 */
module.exports = {
  mount(hostEl, hostApi) {
    var root = document.createElement('div');
    root.style.cssText = 'font-family:-apple-system,system-ui,sans-serif;padding:16px;color:var(--fmb-text,#222)';

    var h2 = document.createElement('h2');
    h2.textContent = '字幕工坊';
    h2.style.cssText = 'margin:0 0 12px';
    root.appendChild(h2);

    var statusMsg = document.createElement('div');
    statusMsg.style.cssText = 'margin:8px 0;min-height:20px;font-size:13px;color:#666';
    function say(msg, isErr) { statusMsg.textContent = msg; statusMsg.style.color = isErr ? '#c00' : '#060'; }

    /* ---- toolbar ---- */
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap';

    var btnPick = document.createElement('button');
    btnPick.textContent = '选择媒体文件';
    btnPick.style.cssText = 'padding:6px 14px;cursor:pointer';

    var langSel = document.createElement('select');
    langSel.style.cssText = 'padding:5px';
    [['auto', '自动检测'], ['ja', '日语'], ['en', '英语']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; langSel.appendChild(op);
    });

    var btnCfg = document.createElement('button');
    btnCfg.textContent = '配置';
    btnCfg.style.cssText = 'padding:6px 14px;cursor:pointer';

    bar.appendChild(btnPick); bar.appendChild(langSel); bar.appendChild(btnCfg);
    root.appendChild(bar);
    root.appendChild(statusMsg);

    /* ---- config panel (collapsed) ---- */
    var cfgBox = document.createElement('div');
    cfgBox.style.cssText = 'display:none;border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px';
    cfgBox.innerHTML =
      '<div style="margin-bottom:6px;font-weight:600">DeepInfra API Key（<a href="https://deepinfra.com" target="_blank">deepinfra.com</a> 创建，只显示一次）</div>' +
      '<input id="fmb-cfg-key" type="password" placeholder="留空则不修改" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:4px">' +
      '<div id="fmb-cfg-key-state" style="color:#888;margin-bottom:10px"></div>' +
      '<div style="margin-bottom:4px">LLM 模型</div><input id="fmb-cfg-model" placeholder="默认 Qwen/Qwen3-30B-A3B" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">API Base</div><input id="fmb-cfg-apibase" placeholder="默认 https://api.deepinfra.com/v1/openai" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">Whisper 引擎路径（留空=PotPlayer 默认）</div><input id="fmb-cfg-wexe" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">Whisper 模型目录（留空=PotPlayer 默认）</div><input id="fmb-cfg-wmodel" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">Node.exe 路径（留空=C:\\Program Files\\nodejs\\node.exe）</div><input id="fmb-cfg-node" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="margin-bottom:4px">术语表（可选，直接粘贴 markdown）</div><textarea id="fmb-cfg-glossary" rows="3" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:8px"></textarea>' +
      '<div style="margin-bottom:4px">知识库文件路径（可选，每行一个绝对路径；失效跳过不阻断）</div><textarea id="fmb-cfg-gpaths" rows="3" placeholder="D:\\BOAT\\SUCCUBUSQ\\knowledge\\terminology\\characters.md" style="width:100%;padding:6px;box-sizing:border-box;margin-bottom:10px"></textarea>' +
      '<button id="fmb-cfg-save" style="padding:6px 14px;cursor:pointer">保存配置</button>';
    root.appendChild(cfgBox);

    function loadConfigIntoPanel() {
      hostApi.callPluginMainAction('getConfig', {}).then(function (r) {
        cfgBox.querySelector('#fmb-cfg-key-state').textContent = r && r.hasApiKey ? '已配置 Key（输入新值可覆盖）' : '尚未配置 Key';
      }).catch(function () {});
      hostApi.callPluginMainAction('getAsrConfig', {}).then(function (r) {
        if (!r) return;
        cfgBox.querySelector('#fmb-cfg-wexe').value = r.whisperExe || '';
        cfgBox.querySelector('#fmb-cfg-wmodel').value = r.whisperModel || '';
        cfgBox.querySelector('#fmb-cfg-node').value = r.nodePath || '';
      }).catch(function () {});
      hostApi.callPluginMainAction('getLlmConfig', {}).then(function (r) {
        if (!r) return;
        cfgBox.querySelector('#fmb-cfg-model').value = r.model || '';
        cfgBox.querySelector('#fmb-cfg-apibase').value = r.apiBase || '';
        cfgBox.querySelector('#fmb-cfg-glossary').value = r.glossary || '';
        cfgBox.querySelector('#fmb-cfg-gpaths').value = (r.glossaryPaths || []).join('\n');
      }).catch(function () {});
    }
    btnCfg.onclick = function () {
      cfgBox.style.display = cfgBox.style.display === 'none' ? 'block' : 'none';
      if (cfgBox.style.display === 'block') loadConfigIntoPanel();
    };
    cfgBox.querySelector('#fmb-cfg-save').onclick = function () {
      var v = cfgBox.querySelector('#fmb-cfg-key').value.trim();
      var gpaths = cfgBox.querySelector('#fmb-cfg-gpaths').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var jobs = [];
      if (v) jobs.push(hostApi.callPluginMainAction('setConfig', { apiKey: v }));
      jobs.push(hostApi.callPluginMainAction('setAsrConfig', {
        whisperExe: cfgBox.querySelector('#fmb-cfg-wexe').value,
        whisperModel: cfgBox.querySelector('#fmb-cfg-wmodel').value,
        nodePath: cfgBox.querySelector('#fmb-cfg-node').value,
      }));
      jobs.push(hostApi.callPluginMainAction('setLlmConfig', {
        model: cfgBox.querySelector('#fmb-cfg-model').value,
        apiBase: cfgBox.querySelector('#fmb-cfg-apibase').value,
        glossary: cfgBox.querySelector('#fmb-cfg-glossary').value,
        glossaryPaths: gpaths,
        nodePath: cfgBox.querySelector('#fmb-cfg-node').value,
      }));
      jobs.push(hostApi.callPluginMainAction('setWriterConfig', {
        nodePath: cfgBox.querySelector('#fmb-cfg-node').value,
      }));
      Promise.all(jobs).then(function () {
        cfgBox.querySelector('#fmb-cfg-key').value = '';
        say('配置已保存');
        loadConfigIntoPanel();
      }).catch(function (e) { say('保存失败: ' + (e.message || e), true); });
    };

    /* ---- task table ---- */
    var table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px';
    table.innerHTML = '<thead><tr>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">文件</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">语言</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">状态</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">进度</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">结果 / 错误</th>' +
      '<th style="border-bottom:1px solid #ddd;padding:6px"></th>' +
      '</tr></thead><tbody></tbody>';
    root.appendChild(table);
    var tbody = table.querySelector('tbody');

    var STATUS_TEXT = { queued: '排队中', asr: '转写中', translating: '翻译中', writing: '写出中', done: '完成', failed: '失败' };

    function refreshTasks() {
      hostApi.callPluginMainAction('listTasks').then(function (r) {
        var tasks = (r && r.tasks) || [];
        tbody.innerHTML = '';
        if (!tasks.length) {
          var tr0 = document.createElement('tr');
          tr0.innerHTML = '<td colspan="6" style="padding:18px;color:#999;text-align:center">暂无任务——点击「选择媒体文件」开始</td>';
          tbody.appendChild(tr0); return;
        }
        tasks.forEach(function (t) {
          var tr = document.createElement('tr');
          var result = t.status === 'done' ? t.finalPath : (t.error || '');
          tr.innerHTML =
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0" title="' + (t.mediaPath || '').replace(/"/g, '&quot;') + '"></td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0">' + ({ auto: '自动', ja: '日语', en: '英语' })[t.language || 'auto'] + '</td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0">' + (STATUS_TEXT[t.status] || t.status) + '</td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0"></td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + String(result || '').replace(/"/g, '&quot;') + '"></td>' +
            '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right"></td>';
          tr.children[0].textContent = t.fileName || t.mediaPath;
          tr.children[3].textContent = t.progressText || '';
          tr.children[4].textContent = result || '';
          tr.children[4].style.color = t.status === 'failed' ? '#c00' : 'inherit';
          var ops = tr.children[5];
          if (t.status === 'failed') {
            var bRetry = document.createElement('button');
            bRetry.textContent = '重试'; bRetry.style.cssText = 'padding:2px 10px;cursor:pointer;margin-right:6px';
            bRetry.onclick = function () { hostApi.callPluginMainAction('retryTask', { taskId: t.taskId }).then(refreshTasks).catch(function (e) { say('重试失败: ' + (e.message || e), true); }); };
            ops.appendChild(bRetry);
          }
          if (t.status === 'queued' || t.status === 'done' || t.status === 'failed') {
            var bDel = document.createElement('button');
            bDel.textContent = '删除'; bDel.style.cssText = 'padding:2px 10px;cursor:pointer';
            bDel.onclick = function () { hostApi.callPluginMainAction('deleteTask', { taskId: t.taskId }).then(refreshTasks).catch(function (e) { say('删除失败: ' + (e.message || e), true); }); };
            ops.appendChild(bDel);
          }
          tbody.appendChild(tr);
        });
      }).catch(function (e) { say('刷新失败: ' + (e.message || e), true); });
    }

    btnPick.onclick = function () {
      window.fmb.dialogShowOpen({
        title: '选择视频/音频文件', multiSelections: true, openFile: true, openDirectory: false,
        filters: [{ name: '媒体文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg'] }],
      }).then(function (r) {
        var paths = (r && (r.paths || (r.path ? [r.path] : []))) || [];
        if (!paths.length) return;
        hostApi.callPluginMainAction('createTasks', { paths: paths, language: langSel.value }).then(function (res) {
          say('已添加 ' + (res && res.added != null ? res.added : paths.length) + ' 个任务');
          refreshTasks();
        }).catch(function (e) { say('添加失败: ' + (e.message || e), true); });
      }).catch(function () {});
    };

    hostEl.appendChild(root);
    refreshTasks();
    setInterval(refreshTasks, 5000);
  },
};
```

注：`dialogShowOpen` 的返回字段名（`paths` vs `path`）以实现时读的 `MainDialogShowOpenResult` 为准——上面代码两种都兼容。

- [ ] **Step 2: 打包 + typecheck + 提交**

Run: `node scripts/package-plugin.ts subtitle-pipeline/app/studio; pnpm typecheck`
Expected: zip 重建成功（含 renderer.umd.js）；typecheck 0 errors

Run: `git add plugins-source/subtitle-pipeline plugins-dist; git commit -m "feat(subtitle): studio renderer — task table + file picker + config panel"`

---

### Task 7: 打包接线 + 全量验证

**Files:**
- Modify: `scripts/package-plugin.ts`（`ALL_PLUGINS` 数组追加 4 条）

- [ ] **Step 1: 修改 ALL_PLUGINS**

```typescript
const ALL_PLUGINS = [
  'atomic/demo-echo',
  'app/demo-counter',
  'extension/demo-install-notify',
  // Baidu Netdisk Uploader suite
  'baidu-netdisk-uploader/atomic/localdb',
  'baidu-netdisk-uploader/atomic/sevenzip',
  'baidu-netdisk-uploader/atomic/baidunetdisk',
  'baidu-netdisk-uploader/app/uploader',
  // Subtitle Pipeline suite
  'subtitle-pipeline/atomic/writer',
  'subtitle-pipeline/atomic/llmtranslate',
  'subtitle-pipeline/atomic/asr',
  'subtitle-pipeline/app/studio',
];
```

- [ ] **Step 2: 全量打包 + 验收脚本 + typecheck**

Run: `pnpm package:plugins`
Expected: 11 个插件全部 OK，`plugins-dist/` 新增 4 个 zip

Run: `node scripts/verify_subtitle_writer.cjs; node scripts/verify_subtitle_llm.cjs; node scripts/verify_subtitle_asr.cjs; pnpm typecheck`
Expected: 3 个 PASS；typecheck 0 errors

Run: `git add scripts/package-plugin.ts plugins-dist; git commit -m "build(subtitle): wire 4 subtitle plugins into package:plugins"`

---

### Task 8: 真实 E2E 验收 + 发布构建

**Files:**
- Create: `scripts/verify_subtitle_e2e.cjs`

- [ ] **Step 1: 写 E2E 验收脚本**

Create `scripts/verify_subtitle_e2e.cjs`（纯 Node 零依赖；打运行中实例的 HTTP API；用法 `node scripts/verify_subtitle_e2e.cjs <视频绝对路径>`）：

```javascript
/* 字幕流水线真实 E2E：安装/启用 4 插件 → createTasks → 轮询至 done → 断言 .zh.srt */
const fs = require('fs'), path = require('path'), http = require('http'), { spawnSync } = require('child_process');

const media = process.argv[2];
if (!media || !fs.existsSync(media)) { console.error('usage: node scripts/verify_subtitle_e2e.cjs <mediaPath>'); process.exit(2); }

function findHttpMeta() {
  const cands = [
    path.join(process.env.APPDATA || '', 'fairy-maid-brigade', '.fmb-http.json'),
    path.join(process.env.LOCALAPPDATA || '', 'fairy-maid-brigade', '.fmb-http.json'),
  ];
  /* portable 实例：exe 同级 fmb-data\userData */
  if (process.env.FMB_PORTABLE_DIR) cands.unshift(path.join(process.env.FMB_PORTABLE_DIR, 'fmb-data', 'userData', '.fmb-http.json'));
  for (const c of cands) { try { if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8')); } catch (_) {} }
  throw new Error('找不到 .fmb-http.json（先启动 FMB 实例）');
}
const meta = findHttpMeta();
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: meta.port, path: p, method, headers: Object.assign({ 'Authorization': 'Bearer ' + meta.token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (_) { resolve({ status: res.statusCode, json: null, raw: d }); } });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const invoke = (pluginId, action, payload) => call('POST', `/api/v1/plugins/${pluginId}/invoke`, { action, payload });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* 1. 安装+启用（CLI 走同一 HTTP，幂等；已安装则跳过报错） */
  const zips = ['com.fmb.subtitle.asr@0.1.0', 'com.fmb.subtitle.llmtranslate@0.1.0', 'com.fmb.subtitle.writer@0.1.0', 'com.fmb.subtitle.studio@0.1.0'];
  for (const z of zips) {
    const r = spawnSync('node', ['out/cli/index.js', 'plugin', 'install', `plugins-dist/${z}.zip`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    console.log(`[install] ${z}: exit=${r.status} ${(r.stdout || '').trim().slice(-120)}`);
    const e = spawnSync('node', ['out/cli/index.js', 'plugin', 'enable', z.split('@')[0]], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    console.log(`[enable]  ${z}: exit=${e.status} ${(e.stdout || '').trim().slice(-120)}`);
  }

  /* 2. 检查 studio 已启用且已配 API Key */
  const cfg = await invoke('com.fmb.subtitle.studio', 'getConfig', {});
  if (!cfg.json || !cfg.json.result || !cfg.json.result.hasApiKey) { console.error('FAIL: 未配置 DeepInfra API Key（先在 UI 配置页填写）'); process.exit(1); }

  /* 3. 创建任务并轮询 */
  const created = await invoke('com.fmb.subtitle.studio', 'createTasks', { paths: [media], language: 'auto' });
  console.log('[task]', JSON.stringify(created.json));
  const deadline = Date.now() + 90 * 60 * 1000;
  let finalTask = null;
  while (Date.now() < deadline) {
    await sleep(10000);
    const list = await invoke('com.fmb.subtitle.studio', 'listTasks', {});
    const tasks = (list.json && list.json.result && list.json.result.tasks) || [];
    const t = tasks.find(x => x.mediaPath === media);
    if (t) { console.log(`[poll] ${t.status} · ${t.progressText || ''}`); if (t.status === 'done') { finalTask = t; break; } if (t.status === 'failed') { console.error('FAIL: task failed: ' + t.error); process.exit(1); } }
  }
  if (!finalTask) { console.error('FAIL: timeout'); process.exit(1); }

  /* 4. 断言最终字幕 */
  const finalPath = finalTask.finalPath;
  if (!fs.existsSync(finalPath)) { console.error('FAIL: final srt missing: ' + finalPath); process.exit(1); }
  const buf = fs.readFileSync(finalPath);
  if (buf[0] === 0xEF) { console.error('FAIL: BOM'); process.exit(1); }
  const text = buf.toString('utf8');
  const entries = text.split(/\r\n\r\n|\n\n/).filter(b => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(b));
  if (!entries.length) { console.error('FAIL: no timeline entries'); process.exit(1); }
  if (!/[一-鿿]/.test(text)) { console.error('FAIL: no CJK chars (translation missing?)'); process.exit(1); }
  console.log(`PASS e2e: ${finalPath} entries=${entries.length}`);
  process.exit(0);
})().catch(e => { console.error('FAIL: ' + (e && e.message)); process.exit(1); });
```

- [ ] **Step 2: 真实验收（需要用户提供一个 1-3 分钟日语测试视频 + 运行中的 FMB 实例 + 已配置 API Key）**

Run: `pnpm dev`（或运行中的便携版），然后：
Run: `node scripts/verify_subtitle_e2e.cjs "D:\path\to\test-video.mp4"`
Expected: `PASS e2e: ... entries=N`；人工在 PotPlayer 打开该视频确认中文字幕自动挂载

- [ ] **Step 3: 调用 fmb-validate-and-package 闭环验收 + 发布构建**

执行 `fmb-validate-and-package` 技能（typecheck + verify + 插件重打包），然后：
Run: `pnpm build:win`
Expected: `dist/` 下 NSIS 安装包 + portable exe 更新（含新插件 zip 经 extraResources 分发）

Run: `git add scripts/verify_subtitle_e2e.cjs; git commit -m "test(subtitle): e2e acceptance script"`

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 ASR→Task 4；§4.2 LLM→Task 3；§4.3 writer→Task 2；§4.4 studio（工作流/队列/UI/配置）→Task 5/6；§5 KV 键→各任务内联；§6 错误矩阵→CUDA 回退（Task 4）、停滞判定（Task 3/4 main.ts）、429 退避（Task 3 callWithRetry）、契约重试（Task 3）、重启恢复（Task 5 activate）；§8 验收→Task 7/8；§9 打包→Task 7/8。spike 验证点→Task 1。
- **占位符扫描**：无 TBD/TODO；所有代码块为完整实现。
- **类型一致性**：runner 输出 `{ok, srtPath, detectedLanguage, durationMs}` ↔ 工作流 `${nodes.asr.output.srtPath}`/`${nodes.asr.output.detectedLanguage}` ↔ llm 输入 `{taskId, srtPath, sourceLang, workDir}` ↔ llm 输出 `translatedSrtPath` ↔ writer 输入 `{taskId, mediaPath, translatedSrtPath, workDir}`；KV 键 `asrResult:/translateResult:/writeResult:` 与 `asrProgress:/llmProgress:` 在 runner/main 两侧一致；`storeResult/storeProgress/getApiKey` action 名三侧一致。
