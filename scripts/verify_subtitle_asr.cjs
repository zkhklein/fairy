/* asr runner 验收：fake whisper 验证进度解析（\r 覆写切分）/语言解析/产物改名/CUDA 回退
 * spike 实测：whisper 退出码恒 0 —— fake 第一次（cuda）exit 0 但不产 srt 触发回退；
 * 第二次（cpu）正常产出 ep01.srt。成功判定 = workDir 内出现 raw.srt 以外的 *.srt。 */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-asr-'));
const workDir = path.join(tmp, 'work'); fs.mkdirSync(workDir, { recursive: true });
const mediaPath = path.join(tmp, 'ep01.mp4'); fs.writeFileSync(mediaPath, 'fake');

/* fake whisper：退出码恒 0（贴合实测）。--device cuda → stdout 打印 CUDA 错误、不产 srt；
 * 否则打印检测语言 + 进度（前两条用裸 \r 合并在一次 write，验证 runner 的 \r 切分），产 ep01.srt。 */
const fake = path.join(tmp, 'fake-whisper.js');
fs.writeFileSync(fake, `
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2);
const outIdx=args.indexOf('--output_dir');
const outDir=outIdx>=0?args[outIdx+1]:process.cwd();
const devIdx=args.indexOf('--device');
const device=devIdx>=0?args[devIdx+1]:'';
process.stdout.write('Some banner line\\n');
if(device==='cuda'){process.stdout.write('CUDA error: no kernel image\\n');process.exit(0);}
process.stdout.write('Detected lang');
setTimeout(() => {
process.stdout.write('uage: Japanese\\n');
process.stdout.write('Progress: 10.0%\\rProgress: 55.0%\\r');
process.stdout.write('Progress: 100.0%\\r\\n');
fs.writeFileSync(path.join(outDir,'ep01.srt'),'1\\r\\n00:00:01,000 --> 00:00:02,000\\r\\nこんにちは\\r\\n\\r\\n45\\r\\n00:05:44,340 --> 00:05:44,340\\r\\nGood morning.\\r\\n\\r\\n');
process.exit(0);
}, 40);
`);

const src = fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/atomic/asr/runner.js.txt'), 'utf8').replace('/*__FMB_SRT__*/', () => fs.readFileSync(path.join(ROOT, 'plugins-source/subtitle-pipeline/shared/srt.js.txt'), 'utf8'));
const P = {
  taskId: 't_asr', mediaPath, language: 'auto', workDir,
  whisperExe: process.execPath, argsPrefix: [fake], modelDir: tmp,
  fmbDataDir: tmp, callbackPluginId: 'com.fmb.subtitle.asr', studioPluginId: 'com.fmb.subtitle.studio',
};
const runner = path.join(tmp, '_runner.js');
fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', 'var P = ' + JSON.stringify(P) + ';'));

const env = { ...process.env, APPDATA: tmp, LOCALAPPDATA: tmp, FMB_HTTP_PORT: '', FMB_HTTP_TOKEN: '' };
const r = spawnSync(process.execPath, [runner], { env, encoding: 'utf8', timeout: 60000 });
console.log(r.stdout); console.error(r.stderr);
if (r.status !== 0) { console.error('FAIL: exit ' + r.status); process.exit(1); }
const raw = path.join(workDir, 'raw.srt');
if (!fs.existsSync(raw)) { console.error('FAIL: raw.srt missing'); process.exit(1); }
if (!fs.readFileSync(raw, 'utf8').includes('こんにちは')) { console.error('FAIL: raw.srt content'); process.exit(1); }
let summary; try { summary = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { console.error('FAIL: no json summary'); process.exit(1); }
if (summary.detectedLanguage !== 'ja') { console.error('FAIL: detectedLanguage=' + summary.detectedLanguage); process.exit(1); }
if (summary.retriedWithCpu !== true) { console.error('FAIL: CUDA fallback not exercised'); process.exit(1); }
if (summary.timelineWarnings?.[0]?.id !== 45) throw new Error('ASR must diagnose zero-duration source IDs');
P.whisperExe = path.join(tmp, 'must-not-launch-missing.exe');
fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', () => 'var P = ' + JSON.stringify(P) + ';'));
const reused = spawnSync(process.execPath, [runner], { env, encoding: 'utf8', timeout: 10000 });
const reusedSummary = JSON.parse(reused.stdout.trim());
if (reused.status !== 0 || !reusedSummary.reused || reusedSummary.detectedLanguage !== 'ja') throw new Error('cached ASR must retain detected language without starting whisper');
if (reusedSummary.timelineWarnings?.[0]?.id !== 45) throw new Error('cached ASR must diagnose zero-duration source IDs');
P.language = 'en';
fs.writeFileSync(runner, src.replace('/*__FMB_PARAMS__*/', () => 'var P = ' + JSON.stringify(P) + ';'));
const override = spawnSync(process.execPath, [runner], { env, encoding: 'utf8', timeout: 10000 });
if (override.status !== 0 || JSON.parse(override.stdout.trim()).detectedLanguage !== 'en') throw new Error('explicit retry language must override cached detection');
console.log('PASS asr runner');
