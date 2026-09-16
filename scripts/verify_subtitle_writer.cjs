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
