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

    var params = {
      taskId: taskId, mediaPath: payload.mediaPath, translatedSrtPath: payload.translatedSrtPath,
      rawSrtPath: payload.rawSrtPath || '', sourceLang: payload.sourceLang || '',
      workDir: payload.workDir, fmbDataDir: _dataRoot(), callbackPluginId: 'com.fmb.subtitle.writer',
    };
    var script = runnerSrc.replace('/*__FMB_SRT__*/', function () { return srtSrc; }).replace('/*__FMB_PARAMS__*/', function () { return 'var P = ' + JSON.stringify(params) + ';'; });

    await hostApi.processes.start({ executablePath: await _nodePath(), args: ['-e', script], detached: true, timeoutMs: 10000 });

    var deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
      var raw = await hostApi.kv.get('writeResult:' + taskId);
      if (raw) {
        var r = JSON.parse(raw);
        if (!r.ok) throw new Error('writer: ' + (r.error || 'unknown'));
        return { ok: true, finalPath: r.finalPath, entries: r.entries, origPath: r.origPath || '', origLang: r.origLang || '' };
      }
      await new Promise(function (rs) { setTimeout(rs, 1000); });
    }
    throw new Error('writer: runner timed out (2min)');
  },
};
