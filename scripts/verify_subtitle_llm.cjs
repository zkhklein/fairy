/* llm runner 验收：内置 mock（FMB invoke + DeepInfra），验证 JSON 契约/重试/二分拆块/落盘 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-llm-'));
const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir, { recursive: true });
const srtPath = path.join(workDir, 'raw.srt');
let body = '';
for (let i = 1; i <= 60; i++) body += i + '\r\n00:0' + (i % 10) + ':00,000 --> 00:0' + (i % 10) + ':02,000\r\n原文第' + i + '条です\r\n\r\n';
fs.writeFileSync(srtPath, body, 'utf8');

let chunk2Attempts = 0; const seenChunks = [];
const reply = (res, content) => res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { total_tokens: 100 } }));
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', c => d += c); req.on('end', () => {
    if (req.url.startsWith('/api/v1/plugins/')) {
      const j = JSON.parse(d || '{}');
      if (j.action === 'getApiKey') { res.end(JSON.stringify({ ok: true, result: { key: 'test-key' } })); return; }
      res.end(JSON.stringify({ ok: true, result: null })); return;
    }
    if (req.url === '/v1/openai/chat/completions') {
      const j = JSON.parse(d);
      const cues = JSON.parse(j.messages[1].content).cues;
      seenChunks.push(cues.length);
      const isChunk2 = cues[0].id === 21 && cues.length === 20; /* 第 2 块覆盖 1-based 21..40 */
      if (isChunk2 && ++chunk2Attempts === 1) { reply(res, '{"translations":[]}'); return; } /* 契约违反（缺全部编号）→ 带坏输出重试 */
      const isFullChunk3 = cues[0].id === 41 && cues.length === 20; /* 第 3 块（41..60）整块永久 source 串位 → 二分拆块路径 */
      if (isFullChunk3) {
        const shifted = cues.map((c, i) => ({ id: c.id, source: c.source + (i === 0 ? '（串位）' : ''), text: '译文' + c.id }));
        reply(res, JSON.stringify({ translations: shifted }));
        return;
      }
      reply(res, JSON.stringify({ translations: cues.map(c => ({ id: c.id, source: c.source, text: '译文' + c.id })) }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const src = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/llmtranslate/runner.js.txt'), 'utf8').replace('/*__FMB_SRT__*/', () => fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/shared/srt.js.txt'), 'utf8'));
  const P = {
    taskId: 't_llm', srtPath, sourceLang: 'ja', workDir,
    fmbDataDir: tmp, callbackPluginId: 'com.fmb.subtitle.llmtranslate', studioPluginId: 'com.fmb.subtitle.studio',
    apiBase: 'http://127.0.0.1:' + port, model: 'mock', glossary: '', glossaryPaths: [],
  };
  const runner = path.join(tmp, '_runner.js');
  fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(P) + ';'));
  const env = Object.assign({}, process.env, { FMB_HTTP_PORT: String(port), FMB_HTTP_TOKEN: 'localtesttoken' });
  /* spawnSync 会冻结本进程事件循环导致内置 mock 无法应答，故用异步 spawn + 超时杀 */
  const child = spawn(process.execPath, [runner], { env });
  let out = '', err = '', killed = false;
  const killer = setTimeout(() => { killed = true; child.kill(); }, 60000);
  child.stdout.on('data', c => out += c);
  child.stderr.on('data', c => err += c);
  child.on('exit', (status) => {
    clearTimeout(killer);
    console.log(out); console.error(err);
    server.close();
    if (killed || status !== 0) { console.error('FAIL: exit ' + (killed ? 'timeout' : status)); process.exit(1); }
    const srt = fs.readFileSync(path.join(workDir, 'translated.srt'), 'utf8');
    if (!srt.includes('译文60')) { console.error('FAIL: missing last entry'); process.exit(1); }
    if (chunk2Attempts < 2) { console.error('FAIL: contract retry not exercised'); process.exit(1); }
    if (!seenChunks.includes(10)) { console.error('FAIL: split retry not exercised (no 10-entry sub-chunk seen)'); process.exit(1); }
    const m3 = (srt.match(/译文4[1-9]|译文5[0-9]|译文60/g) || []).length;
    if (m3 < 20) { console.error('FAIL: chunk-3 lines missing after split retry: ' + m3); process.exit(1); }
    if (seenChunks.length < 3) { console.error('FAIL: expected >=3 chunks (60 条 / 20) + retry'); process.exit(1); }
    console.log('PASS llm runner, chunks=' + JSON.stringify(seenChunks) + ' chunk2Attempts=' + chunk2Attempts);
    process.exit(0);
  });
});
