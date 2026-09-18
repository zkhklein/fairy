/* llm runner 验收：内置 mock（FMB invoke + DeepInfra），验证 JSON 契约/重试/二分拆块/并行流水线/复核/自动重译/落盘 + 引导装载（gzip blob） */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), zlib = require('zlib'), { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-llm-'));
const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir, { recursive: true });
const srtPath = path.join(workDir, 'raw.srt');
let body = '';
for (let i = 1; i <= 60; i++) body += i + '\r\n00:0' + (i % 10) + ':00,000 --> 00:0' + (i % 10) + ':02,000\r\n原文第' + i + '条です\r\n\r\n';
fs.writeFileSync(srtPath, body, 'utf8');

let chunk2Attempts = 0, shiftedGiven = false;
const seenChunks = []; /* 翻译族请求（翻译/二分/重译），不含复核 */
const progressTexts = [];
let active = 0, maxActive = 0;
let lastTranslateEnd = 0, firstReviewStart = Infinity; /* 流水线断言：复核须与翻译重叠 */
const DELAY = 60; /* 拉长单次应答，让并行重叠可观测 */
function finish(res, str) { active--; if (res._kind === 'translate') lastTranslateEnd = Date.now(); res.end(str); }
const reply = (res, content) => finish(res, JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { total_tokens: 100 } }));
const server = http.createServer((req, res) => {
  active++; maxActive = Math.max(maxActive, active);
  let d = ''; req.on('data', c => d += c); req.on('end', () => {
    if (req.url.startsWith('/api/v1/plugins/')) {
      const j = JSON.parse(d || '{}');
      if (req.url.includes('com.fmb.subtitle.studio') && j.action === 'storeProgress' && j.payload && typeof j.payload.text === 'string') progressTexts.push(j.payload.text);
      if (j.action === 'getApiKey') { finish(res, JSON.stringify({ ok: true, result: { key: 'test-key' } })); return; }
      if (j.action === 'getRunConfig') { finish(res, JSON.stringify({ ok: true, result: { glossary: '', glossaryPaths: [] } })); return; }
      finish(res, JSON.stringify({ ok: true, result: null })); return;
    }
    if (req.url === '/v1/openai/chat/completions') {
      const j = JSON.parse(d);
      const payload = JSON.parse(j.messages[1].content);
      /* 重译 system 里也含「复核员」字样（引用复核意见），必须先按 review_feedback 判定 */
      const isRedo = !!payload.review_feedback;
      const isReview = !isRedo && j.messages[0].content.includes('复核员');
      res._kind = isReview ? 'review' : 'translate';
      if (isReview && firstReviewStart === Infinity) firstReviewStart = Date.now();
      if (isReview) { /* 语义复核：按 verdict 数组应答；仅首轮对 id5 给 shifted 触发自动重译 */
        setTimeout(() => {
          const ids = payload.cues.map(c => c.id);
          const judgments = ids.map(id => (id === 5 && !shiftedGiven) ? { id, verdict: 'shifted', reason: '测试：含义挪后' } : { id, verdict: 'ok', reason: '' });
          if (ids.includes(5)) shiftedGiven = true;
          reply(res, JSON.stringify(judgments));
        }, DELAY);
        return;
      }
      if (isRedo) { /* 自动重译：带复核意见的修订请求 */
        seenChunks.push(payload.cues.length);
        setTimeout(() => reply(res, JSON.stringify({ translations: payload.cues.map(c => ({ id: c.id, source: c.source, text: '重译' + c.id })) })), DELAY);
        return;
      }
      const cues = payload.cues;
      seenChunks.push(cues.length);
      const isChunk2 = cues[0].id === 21 && cues.length === 20; /* 第 2 块覆盖 1-based 21..40 */
      if (isChunk2 && ++chunk2Attempts === 1) { setTimeout(() => reply(res, '{"translations":[]}'), DELAY); return; } /* 契约违反 → 带坏输出重试 */
      const isFullChunk3 = cues[0].id === 41 && cues.length === 20; /* 第 3 块整块永久 source 串位 → 二分拆块路径 */
      if (isFullChunk3) {
        const shifted = cues.map((c, i) => ({ id: c.id, source: c.source + (i === 0 ? '（串位）' : ''), text: '译文' + c.id }));
        setTimeout(() => reply(res, JSON.stringify({ translations: shifted })), DELAY);
        return;
      }
      /* id 1 永远 source 多带 'X'（非规范化可挽救差异）→ 二分到单条 + 3 次重试仍失败 → lenient 恢复路径 */
      if (cues.some(c => c.id === 1)) {
        const withX = cues.map(c => c.id === 1 ? { id: c.id, source: c.source + 'X', text: '译文' + c.id } : { id: c.id, source: c.source, text: '译文' + c.id });
        setTimeout(() => reply(res, JSON.stringify({ translations: withX })), DELAY);
        return;
      }
      /* 无害规范化差异（多余空白）必须通过比对（canan FC 编号 2037 实测误杀） */
      const padded = cues.map(c => ({ id: c.id, source: c.source.length > 6 ? c.source.slice(0, 3) + '  ' + c.source.slice(3).replace(/第(\d+)条/, '第 $1 条') : c.source, text: '译文' + c.id }));
      setTimeout(() => reply(res, JSON.stringify({ translations: padded })), DELAY);
      return;
    }
    finish(res, '{}'); res.statusCode = 404;
  });
});

function readLatestReview() {
  const base = path.join(tmp, 'subtitle-reviews');
  const dirs = fs.readdirSync(base).map(n => path.join(base, n));
  return JSON.parse(fs.readFileSync(path.join(dirs.sort().slice(-1)[0], 'review.json'), 'utf8'));
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const composed = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.js.txt'), 'utf8').replace('/*__FMB_SRT__*/', () => fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/shared/srt.js.txt'), 'utf8'));
  /* blob 新鲜度：runner.blob.txt 必须与当前源码一致（改了 runner.js.txt/srt.js.txt 忘跑 build-runner-blob.mjs 在此拦截） */
  const blob = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.blob.txt'), 'utf8').trim();
  if (zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8') !== composed) {
    console.error('FAIL: runner.blob.txt is stale — run: node scripts/build-runner-blob.mjs'); process.exit(1);
  }
  /* 生产启动路径同款引导装载：P 注入作用域，脚本本体从 gzip blob 解出（命令行与源码规模脱钩） */
  const P = {
    taskId: 't_llm', srtPath, sourceLang: 'ja', workDir,
    fmbDataDir: tmp, callbackPluginId: 'com.fmb.subtitle.llmtranslate', studioPluginId: 'com.fmb.subtitle.studio',
    apiBase: 'http://127.0.0.1:' + port, model: 'mock',
    semanticReview: true, concurrency: 2, retainDiagnostics: true,
  };
  const boot = 'var P = ' + JSON.stringify(P) + ';eval(require("zlib").gunzipSync(Buffer.from("' + blob + '","base64")).toString("utf8"))';
  if (boot.length > 32767) { console.error('FAIL: boot command line ' + boot.length + ' chars exceeds Windows 32767 limit'); process.exit(1); }
  const env = Object.assign({}, process.env, { FMB_HTTP_PORT: String(port), FMB_HTTP_TOKEN: 'localtesttoken' });
  /* spawnSync 会冻结本进程事件循环导致内置 mock 无法应答，故用异步 spawn + 超时杀 */
  const child = spawn(process.execPath, ['-e', boot], { env });
  let out = '', err = '', killed = false;
  const killer = setTimeout(() => { killed = true; child.kill(); }, 60000);
  child.stdout.on('data', c => out += c);
  child.stderr.on('data', c => err += c);
  child.on('exit', (status) => {
    clearTimeout(killer);
    console.log(out); console.error(err);
    if (killed || status !== 0) { server.close(); console.error('FAIL: exit ' + (killed ? 'timeout' : status)); process.exit(1); }
    const srt = fs.readFileSync(path.join(workDir, 'translated.srt'), 'utf8');
    if (!srt.includes('译文60') || !srt.includes('译文1')) { console.error('FAIL: missing entries'); process.exit(1); }
    if (!srt.includes('重译5')) { console.error('FAIL: auto-redone revision missing (shifted verdict must trigger rewrite)'); process.exit(1); }
    if (chunk2Attempts < 2) { console.error('FAIL: contract retry not exercised'); process.exit(1); }
    if (!seenChunks.includes(10)) { console.error('FAIL: split retry not exercised (no 10-entry sub-chunk seen)'); process.exit(1); }
    if (!seenChunks.includes(1)) { console.error('FAIL: redo request not seen as translate-family call'); process.exit(1); }
    const m3 = (srt.match(/译文4[1-9]|译文5[0-9]|译文60/g) || []).length;
    if (m3 < 20) { console.error('FAIL: chunk-3 lines missing after split retry: ' + m3); process.exit(1); }
    if (maxActive < 2) { console.error('FAIL: no parallel overlap observed (maxActive=' + maxActive + ')'); process.exit(1); }
    if (!(firstReviewStart < lastTranslateEnd)) { console.error('FAIL: review pool did not overlap translation phase (two-phase regression, not pipelined)'); process.exit(1); }
    if (!progressTexts.some(t => t.includes('在途'))) { console.error('FAIL: sub-state (in-flight) progress text missing'); process.exit(1); }
    if (!progressTexts.some(t => /已译 \d+\/3/.test(t) && /已复核 \d+\/3/.test(t))) { console.error('FAIL: translated/reviewed counters missing from progress text'); process.exit(1); }
    /* 深度兜底 lenient 恢复：id 1 永远 source 带 X → 二分到单条 + 3 次重试仍失败 → 走 parseTranslationsLenient 恢复
     * diagnostics 必须含 source-recovered 标记，translated.srt 必须含"译文1"（恢复成功） */
    let diags = '';
    try { diags = fs.readFileSync(path.join(tmp, 'subtitle-reviews', fs.readdirSync(path.join(tmp, 'subtitle-reviews')).sort().slice(-1)[0], 'diagnostics.jsonl'), 'utf8'); } catch (_) {}
    if (!diags.includes('source-recovered')) { console.error('FAIL: lenient recovery not exercised (no source-recovered diagnostic)'); process.exit(1); }
    if (!srt.includes('译文1')) { console.error('FAIL: lenient recovery did not produce translation for id 1'); process.exit(1); }
    const review = readLatestReview();
    if (review.config.concurrency !== 2) { console.error('FAIL: report config missing concurrency'); process.exit(1); }
    const e5 = review.entries.find(e => e.id === 5);
    if (!e5 || e5.verdict !== 'auto-redone' || !e5.reviewHistory) { console.error('FAIL: id5 not marked auto-redone with history'); process.exit(1); }
    if (review.reviewStatus !== 'pending_recheck') { console.error('FAIL: expected pending_recheck after revision, got ' + review.reviewStatus); process.exit(1); }
    console.log('PASS llm runner parallel pipeline: chunks=' + JSON.stringify(seenChunks) + ' chunk2Attempts=' + chunk2Attempts + ' maxActive=' + maxActive);
    /* 断点续跑：同 workDir 二次运行应跳过全部已完成块（0 次翻译族请求；复核恢复后仍执行） */
    seenChunks.length = 0; chunk2Attempts = 0; progressTexts.length = 0;
    const child2 = spawn(process.execPath, ['-e', boot], { env });
    let out2 = '', err2 = '';
    child2.stdout.on('data', c => out2 += c);
    child2.stderr.on('data', c => err2 += c);
    const killer2 = setTimeout(() => child2.kill(), 30000);
    child2.on('exit', (status2) => {
      clearTimeout(killer2);
      server.close();
      console.log(out2); console.error(err2);
      if (status2 !== 0) { console.error('FAIL: resume run exit ' + status2); process.exit(1); }
      const retranslated = seenChunks.length;
      const srt2 = fs.readFileSync(path.join(workDir, 'translated.srt'), 'utf8');
      if (!srt2.includes('译文60') || !srt2.includes('译文1') || !srt2.includes('重译5')) { console.error('FAIL: resume run output missing'); process.exit(1); }
      if (retranslated > 3) { console.error('FAIL: resume run made ' + retranslated + ' LLM calls, expected <=3 (earlier chunks must come from checkpoint)'); process.exit(1); }
      if (!progressTexts.some(t => t.includes('断点续跑'))) { console.error('FAIL: resume progress text missing 断点续跑 marker'); process.exit(1); }
      console.log('PASS resume run: ' + retranslated + ' translate-family call(s), earlier chunks restored from checkpoint (reviews re-run as designed)');
      process.exit(0);
    });
  });
});
