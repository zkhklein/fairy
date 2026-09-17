/* global hostApi, __hostEnv */
// @ts-nocheck
import runnerSrc from './runner.js.txt';
import srtSrc from '../../shared/srt.js.txt';

var DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';

function _env() { return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {}; }
async function _nodePath() { var p = await hostApi.kv.get('config:nodePath'); return (p && p.trim()) || DEFAULT_NODE; }
function _dataRoot() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) { var b = f.lastIndexOf('\\'), s = f.lastIndexOf('/'); var x = Math.max(b, s); if (x < 0) break; f = f.substring(0, x); }
  return f;
}

async function _whisperExe() {
  var p = await hostApi.kv.get('config:whisperExe');
  if (p && p.trim()) return p.trim();
  var e = _env();
  return (e.HOME || 'C:\\Users\\Public') + '\\AppData\\Roaming\\PotPlayerMini64\\Engine\\Faster-Whisper-XXL\\faster-whisper-xxl.exe';
}

/* 模型父目录（--model_dir 参数；--model 名固定 large-v3-turbo 写在 runner 里） */
async function _modelDir() {
  var p = await hostApi.kv.get('config:whisperModelDir');
  if (p && p.trim()) return p.trim();
  var e = _env();
  return (e.HOME || 'C:\\Users\\Public') + '\\AppData\\Roaming\\PotPlayerMini64\\Model';
}

module.exports = {
  activate(ctx) { ctx.hostApi.logger.info('subtitle-asr activated', { pluginId: ctx.pluginId }); },
  deactivate() { hostApi.logger.info('subtitle-asr deactivated', {}); },

  async setConfig(payload) {
    if (!payload) return { ok: true };
    if (typeof payload.nodePath === 'string') await hostApi.kv.set('config:nodePath', payload.nodePath.trim());
    if (typeof payload.whisperExe === 'string') await hostApi.kv.set('config:whisperExe', payload.whisperExe.trim());
    if (typeof payload.whisperModelDir === 'string') await hostApi.kv.set('config:whisperModelDir', payload.whisperModelDir.trim());
    return { ok: true };
  },

  async getConfig() {
    return {
      ok: true,
      whisperExe: await hostApi.kv.get('config:whisperExe') || '',
      whisperModelDir: await hostApi.kv.get('config:whisperModelDir') || '',
      nodePath: await hostApi.kv.get('config:nodePath') || '',
    };
  },

  /* HTTP 回调：runner 终态落 KV，供 transcribe 轮询 */
  async storeResult(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('asrResult:' + payload.taskId, JSON.stringify(payload));
    return { ok: true };
  },

  /* 活性心跳（runner 每次进度 POST 一次） */
  async storeProgress(payload) {
    if (payload && payload.taskId) await hostApi.kv.set('asrProgress:' + payload.taskId, String((payload && payload.ts) || Date.now()));
    return { ok: true };
  },

  /*
   * transcribe(payload): { taskId, mediaPath, language: 'ja'|'en'|'auto', workDir }
   * → { ok, srtPath, detectedLanguage, durationMs, reused? }
   * 断点续跑：workDir\raw.srt 已存在则直接复用；轮询 asrResult:<taskId>，
   * 心跳 asrProgress:<taskId>，10 分钟停滞判失败，硬上限 4 小时。
   */
  async transcribe(payload) {
    var taskId = payload && payload.taskId;
    if (!taskId) throw new Error('transcribe: taskId required');
    if (!payload.mediaPath) throw new Error('transcribe: mediaPath required');
    if (!payload.workDir) throw new Error('transcribe: workDir required');
    var language = payload.language || 'auto';
    var previousLanguage = '';
    try { var previous = JSON.parse(await hostApi.kv.get('asrResult:' + taskId) || '{}'); previousLanguage = previous.detectedLanguage || ''; } catch (_) {}

    await hostApi.kv.delete('asrResult:' + taskId);
    await hostApi.kv.delete('asrProgress:' + taskId);

    var params = {
      taskId: taskId, mediaPath: payload.mediaPath, language: language, workDir: payload.workDir,
      whisperExe: await _whisperExe(), modelDir: await _modelDir(),
      fmbDataDir: _dataRoot(), callbackPluginId: 'com.fmb.subtitle.asr', studioPluginId: 'com.fmb.subtitle.studio',
      previousLanguage: previousLanguage,
    };
    var script = runnerSrc.replace('/*__FMB_SRT__*/', function () { return srtSrc; }).replace('/*__FMB_PARAMS__*/', function () { return 'var P = ' + JSON.stringify(params) + ';'; });

    await hostApi.processes.start({ executablePath: await _nodePath(), args: ['-e', script], detached: true, timeoutMs: 10000 });

    var hardDeadline = Date.now() + 4 * 60 * 60 * 1000;
    var stallMs = 10 * 60 * 1000;
    var lastBeat = Date.now();
    while (Date.now() < hardDeadline) {
      var raw = await hostApi.kv.get('asrResult:' + taskId);
      if (raw) {
        var r = JSON.parse(raw);
        if (!r.ok) throw new Error('asr: ' + (r.error || 'unknown'));
        return { ok: true, srtPath: r.srtPath, detectedLanguage: r.detectedLanguage || (language !== 'auto' ? language : ''), durationMs: r.durationMs, timelineWarnings: r.timelineWarnings || [] };
      }
      var beat = await hostApi.kv.get('asrProgress:' + taskId);
      if (beat) lastBeat = Math.max(lastBeat, parseInt(beat, 10) || lastBeat);
      if (Date.now() - lastBeat > stallMs) throw new Error('asr: 10 分钟无进度，判定停滞');
      await new Promise(function (rs) { setTimeout(rs, 2000); });
    }
    throw new Error('asr: runner timed out (4h)');
  },
};
