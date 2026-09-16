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
process.stdout.write('Detected language: ja\\n');
process.stdout.write('Progress: 10.0%\\rProgress: 55.0%');
process.stdout.write('Progress: 100.0%\\r\\n');
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
