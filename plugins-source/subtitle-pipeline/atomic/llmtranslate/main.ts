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
    /* apiKey 存本插件 secrets（secrets 按插件隔离；studio.setConfig 会转发过来） */
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      await hostApi.secrets.set('deepinfra_api_key', payload.apiKey.trim(), 'DeepInfra API Key');
    }
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
    /* 契约是 {value}，但旧宿主实现直接返回裸字符串 —— 两种形状都兼容 */
    var v = s ? (typeof s === 'string' ? s : s.value) : null;
    return { key: v || null };
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
