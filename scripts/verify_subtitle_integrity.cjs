/* Offline integration: real runners, temporary files, localhost fake provider only. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const base = path.join(ROOT, 'plugins-source/subtitle-pipeline');
const KEY = 'CANARY_API_KEY_DO_NOT_SAVE';
const TOKEN = 'CANARY_LOCAL_TOKEN_DO_NOT_SAVE';
const srt = (texts, ids = texts.map((_, i) => i + 1)) => texts.map((text, i) => `${ids[i]}\n00:00:${String(i * 2).padStart(2, '0')},000 --> 00:00:${String(i * 2 + 1).padStart(2, '0')},000\n${text}\n`).join('\n');
function runnerSource(stage, params) {
  let source = fs.readFileSync(path.join(base, 'atomic', stage, 'runner.js.txt'), 'utf8');
  const shared = path.join(base, 'shared/srt.js.txt');
  if (fs.existsSync(shared)) source = source.replace('/*__FMB_SRT__*/', fs.readFileSync(shared, 'utf8'));
  return source.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(params) + ';');
}
async function runStage(stage, params, env) {
  const script = path.join(params.workDir, stage + '-test.cjs');
  fs.writeFileSync(script, runnerSource(stage, params));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, windowsHide: true });
    let output = '';
    child.stdout.on('data', x => output += x);
    child.stderr.on('data', x => output += x);
    const timer = setTimeout(() => { child.kill(); reject(new Error('offline runner timeout')); }, 20000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
async function scenario(t, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-integrity-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir);
  const srtPath = path.join(workDir, 'raw.srt');
  fs.writeFileSync(srtPath, options.srt ?? srt(['Please bring', 'the blue book.', 'The train leaves at noon.']));
  const calls = [], results = [], events = [];
  const server = http.createServer((req, res) => {
    let data = ''; req.on('data', x => data += x); req.on('end', () => {
      try {
        const body = JSON.parse(data); res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/api/v1/plugins/')) {
          events.push(body);
          if (body.action === 'storeResult') results.push(body.payload);
          res.end(JSON.stringify({ result: body.action === 'getApiKey' ? { key: options.apiKey || KEY } : null })); return;
        }
        assert.equal(req.url, '/v1/openai/chat/completions');
        calls.push(body);
        const response = options.respond ? options.respond(body, calls.length, { tmp, workDir }) : defaultResponse(body);
        res.statusCode = options.httpStatus || 200;
        res.end(JSON.stringify(response));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const env = { ...process.env, FMB_HTTP_PORT: String(server.address().port), FMB_HTTP_TOKEN: TOKEN };
  const params = { taskId: 'ordinary-dialogue', srtPath, workDir, sourceLang: 'en', fmbDataDir: tmp,
    callbackPluginId: 'com.fmb.subtitle.llmtranslate', studioPluginId: 'com.fmb.subtitle.studio',
    apiBase: `http://127.0.0.1:${server.address().port}/v1/openai`, ...options.params };
  const run = await runStage('llmtranslate', params, env);
  const result = results.at(-1);
  return { ...run, result, calls, events, tmp, workDir, srtPath, params, env };
}
function targetIds(body) {
  const payload = JSON.parse(body.messages[1].content);
  return payload.cues.map(c => c.id);
}
const completion = (content, finish_reason = 'stop') => ({ model: 'offline-model', choices: [{ finish_reason, message: { content } }], usage: { total_tokens: 7 } });
const translationsJson = (body, textOf) => JSON.stringify({ translations: JSON.parse(body.messages[1].content).cues.map(c => ({ id: c.id, source: c.source, text: textOf(c) })) });
const defaultResponse = body => completion(translationsJson(body, c => '译文' + c.id));

for (const kind of ['duplicate', 'extra', 'missing', 'empty', 'not-json', 'source-mismatch', 'truncated', 'missing-finish']) {
  test('reject ' + kind + ' without silent subtitle loss', async t => {
    const r = await scenario(t, { srt: srt(['Hello.']), respond: () => {
      if (kind === 'truncated') return completion('{"translations":[{"id":1,"source":"Hello.","text":"你好"}]}', 'length');
      if (kind === 'missing-finish') return { choices: [{ message: { content: '{"translations":[{"id":1,"source":"Hello.","text":"你好"}]}' } }] };
      const bad = {
        duplicate: '{"translations":[{"id":1,"source":"Hello.","text":"你好"},{"id":1,"source":"Hello.","text":"再见"}]}',
        extra: '{"translations":[{"id":1,"source":"Hello.","text":"你好"},{"id":2,"source":"Hello.","text":"再见"}]}',
        missing: '{"translations":[]}',
        empty: '{"translations":[{"id":1,"source":"Hello.","text":"  "}]}',
        'not-json': '译文如下：你好',
        'source-mismatch': '{"translations":[{"id":1,"source":"Hello!","text":"你好"}]}',
      }[kind];
      return completion(bad);
    } });
    assert.notEqual(r.code, 0, r.output);
    assert.equal(r.result.ok, false);
    assert.equal(fs.existsSync(path.join(r.workDir, 'translated.srt')), false);
  });
}
test('malformed nonempty SRT fails instead of becoming silence', async t => {
  const r = await scenario(t, { srt: '1\nnot a timestamp\nHello\n' });
  assert.notEqual(r.code, 0); assert.equal(r.calls.length, 0);
});
test('unknown automatic language stops before paid requests', async t => {
  const r = await scenario(t, { params: { sourceLang: '' } });
  assert.notEqual(r.code, 0); assert.equal(r.calls.length, 0);
  assert.match(r.result.error, /语言/);
});
test('preserve nonsequential original IDs and timestamps', async t => {
  const r = await scenario(t, { srt: srt(['Hello.', 'See you.'], [7, 12]) });
  assert.equal(r.code, 0, r.output);
  const output = fs.readFileSync(path.join(r.workDir, 'translated.srt'), 'utf8');
  assert.match(output, /^7\r?\n/); assert.match(output, /\n12\r?\n/);
});
test('split retries retain immutable preceding and following context', async t => {
  const r = await scenario(t, { respond: body => {
    const cues = JSON.parse(body.messages[1].content).cues;
    const rows = (cues.length > 1 ? cues.slice(1) : cues).map(c => ({ id: c.id, source: c.source, text: '译文' + c.id }));
    return completion(JSON.stringify({ translations: rows }));
  } });
  assert.equal(r.code, 0, r.output);
  const middle = r.calls.find(b => targetIds(b).join(',') === '2');
  assert.ok(middle);
  const payload = JSON.parse(middle.messages[1].content);
  assert.ok(payload.before_context.some(c => c.source.includes('Please bring')));
  assert.ok(payload.after_context.some(c => c.source.includes('The train leaves at noon')));
  assert.ok(payload.cues.every(c => c.source === 'the blue book.'));
  assert.doesNotMatch(middle.messages[0].content, /30 个汉字/);
});
test('optional alignment review auto-redoes flagged entries instead of failing', async t => {
  const r = await scenario(t, { params: { semanticReview: true, retainDiagnostics: true }, respond: body => {
    if (body.messages[0].content.includes('对齐复核')) {
      assert.match(body.messages[1].content, /Please bring/);
      assert.match(body.messages[1].content, /初翻/);
      return completion(JSON.stringify([{ id: 1, verdict: 'shifted', reason: '提前翻译了第三条的火车话题' }, { id: 2, verdict: 'ok', reason: '' }, { id: 3, verdict: 'omitted', reason: '内容丢失' }]));
    }
    const payload = JSON.parse(body.messages[1].content);
    if (body.messages[0].content.includes('复核员') && Array.isArray(payload.review_feedback)) {
      /* 自动重翻请求：只含被点名条目 + 意见反馈，回合法 JSON */
      assert.ok(payload.cues.length === 2 && payload.review_feedback.length === 2);
      return completion(JSON.stringify({ translations: payload.cues.map(c => ({ id: c.id, source: c.source, text: '重翻' + c.id })) }));
    }
    return completion(translationsJson(body, () => '初翻'));
  } });
  assert.equal(r.code, 0, r.output);
  assert.equal(fs.existsSync(path.join(r.workDir, 'translated.srt')), true);
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'review.json'), 'utf8'));
  const redone = report.entries.filter(e => e.verdict === 'auto-redone');
  assert.equal(redone.length, 2);
  assert.ok(redone.every(e => e.reason.includes('复核意见')));
  assert.ok(report.entries.some(e => e.translation === '重翻1') && report.entries.some(e => e.translation === '重翻3'));
});
test('persist escaped review and redacted diagnostics outside disposable workDir', async t => {
  const r = await scenario(t, { srt: srt(['Hello <script>alert(1)</script>.']), params: { retainDiagnostics: true, glossary: 'blue book = 蓝色的书' }, respond: () => completion('{"translations":[{"id":1,"source":"Hello <script>alert(1)</script>.","text":"你好"}]}') });
  assert.equal(r.code, 0, r.output);
  assert.ok(r.result.reviewPath && fs.existsSync(r.result.reviewPath));
  assert.ok(!path.relative(r.workDir, r.result.reviewPath).startsWith('review'));
  const reportDir = path.dirname(r.result.reviewPath);
  const files = fs.readdirSync(reportDir);
  assert.ok(files.includes('diagnostics.jsonl'));
  const contents = files.map(f => fs.readFileSync(path.join(reportDir, f), 'utf8')).join('\n');
  assert.ok(!contents.includes(KEY)); assert.ok(!contents.includes(TOKEN));
  const report = fs.readFileSync(r.result.reviewPath, 'utf8');
  assert.ok(!report.includes('<script>alert(1)</script>'));
  assert.match(report, /&lt;script&gt;/);
  const snapshot = JSON.parse(fs.readFileSync(path.join(reportDir, 'review.json'), 'utf8'));
  assert.equal(snapshot.config.model, 'Qwen/Qwen2.5-72B-Instruct');
  assert.match(snapshot.references.pastedSha256, /^[a-f0-9]{64}$/);
  const mediaPath = path.join(r.tmp, 'example.mp3'); fs.writeFileSync(mediaPath, '');
  const writer = await runStage('writer', { taskId: 'write', mediaPath, translatedSrtPath: path.join(r.workDir, 'translated.srt'), rawSrtPath: r.srtPath, workDir: r.workDir, sourceLang: 'en', fmbDataDir: r.tmp, callbackPluginId: 'writer' }, r.env);
  assert.equal(writer.code, 0, writer.output);
  assert.equal(fs.existsSync(r.workDir), false);
  assert.equal(fs.existsSync(r.result.reviewPath), true);
});
test('writer rejects changed timestamps before overwriting existing subtitle', async t => {
  const r = await scenario(t);
  assert.equal(r.code, 0, r.output);
  const target = path.join(r.tmp, 'example.zh.srt'); fs.writeFileSync(target, 'KEEP');
  const translated = path.join(r.workDir, 'translated.srt');
  fs.writeFileSync(translated, fs.readFileSync(translated, 'utf8').replace('00:00:01,000', '00:00:09,000'));
  const writer = await runStage('writer', { taskId: 'write', mediaPath: path.join(r.tmp, 'example.mp3'), translatedSrtPath: translated, rawSrtPath: r.srtPath, workDir: r.workDir, fmbDataDir: r.tmp }, r.env);
  assert.notEqual(writer.code, 0); assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP');
});
test('context spans the 20-entry boundary without translated-text contamination', async t => {
  const texts = Array.from({ length: 28 }, (_, i) => 'Ordinary sentence ' + (i + 1) + '.');
  texts[19] = 'Please bring'; texts[20] = 'the blue umbrella.';
  const r = await scenario(t, { srt: srt(texts) });
  assert.equal(r.code, 0, r.output);
  assert.equal(r.calls.length, 2);
  const first = JSON.parse(r.calls[0].messages[1].content), second = JSON.parse(r.calls[1].messages[1].content);
  assert.ok(first.after_context.some(c => c.source === 'the blue umbrella.'));
  assert.ok(second.before_context.some(c => c.source === 'Please bring'));
  assert.ok(second.before_context.every(c => !c.source.includes('译文')));
  assert.ok(!fs.existsSync(path.join(path.dirname(r.result.reviewPath), 'diagnostics.jsonl')));
});
for (const bad of ['length', 'content_filter', 'tool_calls', null]) {
  test('reject abnormal completion ' + bad, async t => {
    const r = await scenario(t, { respond: () => completion('{"translations":[{"id":1,"source":"Please bring","text":"请带来"},{"id":2,"source":"the blue book.","text":"蓝色的书"},{"id":3,"source":"The train leaves at noon.","text":"火车中午出发"}]}', bad) });
    assert.notEqual(r.code, 0); assert.equal(r.calls.length, 1);
  });
}
for (const kind of ['missing', 'duplicate', 'extra', 'unknown-verdict']) {
  test('alignment reviewer cannot pass with ' + kind + ' judgments', async t => {
    const r = await scenario(t, { params: { semanticReview: true }, respond: body => {
      if (!body.messages[0].content.includes('对齐复核')) return defaultResponse(body);
      const items = [{ id: 1, verdict: 'ok', reason: '' }, { id: 2, verdict: 'ok', reason: '' }, { id: 3, verdict: 'ok', reason: '' }];
      if (kind === 'missing') items.pop();
      if (kind === 'duplicate') items[2].id = 2;
      if (kind === 'extra') items[2].id = 4;
      if (kind === 'unknown-verdict') items[2].verdict = 'probably';
      return completion(JSON.stringify(items));
    } });
    assert.notEqual(r.code, 0); assert.match(r.result.error, /复核/);
    assert.equal(fs.existsSync(path.join(r.workDir, 'translated.srt')), false);
  });
}
test('successful optional review emits subtitles and accounts for both calls', async t => {
  const r = await scenario(t, { params: { semanticReview: true }, respond: body => {
    if (!body.messages[0].content.includes('对齐复核')) return defaultResponse(body);
    return completion(JSON.stringify([1, 2, 3].map(id => ({ id, verdict: 'ok', reason: '' }))));
  } });
  assert.equal(r.code, 0, r.output); assert.equal(r.calls.length, 2);
  assert.equal(r.result.usage.total_tokens, 14);
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'review.json'), 'utf8'));
  assert.ok(report.entries.every(e => e.verdict === 'ok'));
});
test('provider error is redacted and fatal auth failure is not retried', async t => {
  const r = await scenario(t, { params: { retainDiagnostics: true }, httpStatus: 401, respond: () => ({ error: KEY + ' ' + TOKEN }) });
  assert.notEqual(r.code, 0); assert.equal(r.calls.length, 1);
  const diagnostic = fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'diagnostics.jsonl'), 'utf8');
  assert.ok(!diagnostic.includes(KEY)); assert.ok(!diagnostic.includes(TOKEN));
  assert.ok(!r.output.includes(KEY)); assert.ok(!r.result.error.includes(KEY));
});
test('credentials echoed by a provider are rejected, never written as subtitles', async t => {
  const r = await scenario(t, { srt: srt(['Hello.']), params: { retainDiagnostics: true }, respond: () => completion('{"translations":[{"id":1,"source":"Hello.","text":"' + KEY + ' ' + TOKEN + '"}]}') });
  assert.notEqual(r.code, 0, r.output);
  assert.equal(fs.existsSync(path.join(r.workDir, 'translated.srt')), false);
  const dir = path.dirname(r.result.reviewPath);
  const contents = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!contents.includes(KEY)); assert.ok(!contents.includes(TOKEN));
});
test('quoted credentials remain redacted in nested provider error JSON', async t => {
  const unusualKey = 'CANARY"quoted\\key';
  const r = await scenario(t, { apiKey: unusualKey, params: { retainDiagnostics: true }, httpStatus: 401, respond: () => ({ error: unusualKey }) });
  assert.notEqual(r.code, 0);
  const lines = fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const response = lines.find(x => x.event === 'response').data;
  assert.ok(!JSON.stringify(response).includes('CANARY'));
});
test('diagnostic I/O failure reports a terminal failure instead of hanging', async t => {
  const r = await scenario(t, { params: { retainDiagnostics: true }, respond: (body, number, { tmp }) => {
    const reviews = path.join(tmp, 'subtitle-reviews');
    const file = path.join(reviews, fs.readdirSync(reviews)[0], 'diagnostics.jsonl');
    fs.unlinkSync(file); fs.mkdirSync(file); // append now fails with EISDIR, portable across OSes
    return defaultResponse(body);
  } });
  assert.notEqual(r.code, 0); assert.equal(r.calls.length, 1);
  assert.equal(r.result.ok, false); assert.match(r.result.error, /诊断/);
  assert.ok(r.result.reviewPath);
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'review.json'), 'utf8'));
  assert.equal(report.status, 'failed');
});
test('empty source remains valid without paying for translation', async t => {
  const r = await scenario(t, { srt: '', params: { sourceLang: '' } });
  assert.equal(r.code, 0, r.output); assert.equal(r.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(r.workDir, 'translated.srt'), 'utf8'), '');
});
const vm = require('node:vm');
const zeroDurationFixture = [
  '45\n00:05:44,340 --> 00:05:44,340\nPlease bring the book.',
  '73\n00:08:18,010 --> 00:08:18,010\nThe train has arrived.',
  '74\n00:08:18,010 --> 00:08:18,010\nLet us go.',
  '75\n00:08:18,010 --> 00:08:18,010\nTake your umbrella.',
  '76\n00:08:19,000 --> 00:08:20,000\nGoodbye.',
].join('\n\n') + '\n';
test('zero-duration ASR entries are diagnosed and survive translation and writer unchanged', async t => {
  const r = await scenario(t, { srt: zeroDurationFixture });
  assert.equal(r.code, 0, r.output);
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'review.json'), 'utf8'));
  assert.deepEqual(report.timelineWarnings.map(w => w.id), [45, 73, 74, 75]);
  assert.ok(report.timelineWarnings.every(w => w.code === 'zero_duration' && w.start === w.end));
  assert.match(fs.readFileSync(r.result.reviewPath, 'utf8'), /零时长/);
  const writer = await runStage('writer', { taskId: 'zero-write', mediaPath: path.join(r.tmp, 'example.mp3'), translatedSrtPath: path.join(r.workDir, 'translated.srt'), rawSrtPath: r.srtPath, sourceLang: 'en', workDir: r.workDir, fmbDataDir: r.tmp }, r.env);
  assert.equal(writer.code, 0, writer.output);
  const emitted = fs.readFileSync(path.join(r.tmp, 'example.zh.srt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(emitted.trim().split(/\n\n/).length, 5);
  assert.match(emitted, /45\n00:05:44,340 --> 00:05:44,340\n译文45/);
  for (const id of [73, 74, 75]) assert.ok(emitted.includes(id + '\n00:08:18,010 --> 00:08:18,010\n译文' + id));
  assert.equal(fs.readFileSync(path.join(r.tmp, 'example.en.srt'), 'utf8').replace(/\r\n/g, '\n'), zeroDurationFixture);
});
test('unknown language still reports zero-duration IDs before translation is blocked', async t => {
  const r = await scenario(t, { srt: zeroDurationFixture, params: { sourceLang: '' } });
  assert.notEqual(r.code, 0); assert.equal(r.calls.length, 0);
  const warning = r.events.find(e => e.action === 'storeProgress' && e.payload.timelineWarnings);
  assert.ok(warning); assert.deepEqual(warning.payload.timelineWarnings.map(w => w.id), [45, 73, 74, 75]);
});
const srtApi = vm.runInNewContext(fs.readFileSync(path.join(base, 'shared/srt.js.txt'), 'utf8') + '\n({ parseSrt, formatSrt, assertAligned });');
for (const [name, input] of [
  ['duplicate source ID', srt(['Hello.', 'Goodbye.'], [1, 1])],
  ['missing source ID', '00:00:00,000 --> 00:00:01,000\nHello'],
  ['invalid minutes', '1\n00:99:00,000 --> 00:99:01,000\nHello'],
  ['backwards timestamp', '1\n00:00:05,000 --> 00:00:01,000\nHello'],
  ['empty source text', '1\n00:00:00,000 --> 00:00:01,000\n'],
  ['garbage after valid source', srt(['Hello.']) + '\nBROKEN'],
]) {
  test('strict source parser rejects ' + name, () => assert.throws(() => srtApi.parseSrt(input)));
}
test('diarization prefixes feed speaker context, stripped from output and source', async t => {
  const r = await scenario(t, { srt: srt(['[SPEAKER_01]: Hello there.', '[SPEAKER_02]: Nice to meet you.', '[SPEAKER_02]: The weather is fine.']), respond: body => {
    const payload = JSON.parse(body.messages[1].content);
    if (payload.cues) {
      assert.ok(payload.cues.every(c => c.speaker === 'SPEAKER_01' || c.speaker === 'SPEAKER_02'), 'cue speaker expected');
      assert.match(body.messages[0].content, /声学说话人代号/);
      return completion(JSON.stringify({ translations: payload.cues.map(c => ({ id: c.id, source: c.source, text: '[SPEAKER_' + c.id + ']: 泄漏' + c.id })) }));
    }
    return completion('[]');
  } });
  assert.equal(r.code, 0, r.output);
  const text = fs.readFileSync(path.join(r.workDir, 'translated.srt'), 'utf8');
  assert.ok(!/\[SPEAKER_\d+\]/.test(text), 'speaker prefix leaked into translated srt');
  assert.match(text, /泄漏1/);
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(r.result.reviewPath), 'review.json'), 'utf8'));
  assert.equal(report.config.speakerInfo.speakers, 2);
  const r2 = await scenario(t, { srt: srt(['[SPEAKER_01]: Solo line one.', '[SPEAKER_01]: Solo line two.']), respond: body => {
    const payload = JSON.parse(body.messages[1].content);
    if (payload.cues) {
      assert.ok(payload.cues.every(c => !('speaker' in c)), 'single-speaker diarization must be degraded');
      assert.doesNotMatch(body.messages[0].content, /声学说话人代号/);
      return completion(JSON.stringify({ translations: payload.cues.map(c => ({ id: c.id, source: c.source, text: '单' + c.id })) }));
    }
    return completion('[]');
  } });
  assert.equal(r2.code, 0, r2.output);
});
