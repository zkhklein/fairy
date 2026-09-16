/* llm runner 验收：内置 mock（FMB invoke + DeepInfra），验证分块/契约重试/落盘 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), { spawn } = require('child_process');

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
      const isChunk2 = nums.length > 0 && nums[0] === 26; /* 第 2 块覆盖 1-based 序号 26..50 */
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
    if (seenChunks.length < 3) { console.error('FAIL: expected >=3 chunks (60 条 / 25) + retry'); process.exit(1); }
    console.log('PASS llm runner, chunks=' + JSON.stringify(seenChunks) + ' chunk2Attempts=' + chunk2Attempts);
    process.exit(0);
  });
});
