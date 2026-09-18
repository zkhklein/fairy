/* global hostApi, __hostEnv */
// @ts-nocheck
/* runner.blob.txt = runner.js.txt + shared/srt.js.txt 组合后 gzip+base64（scripts/build-runner-blob.mjs 生成）。
 * 命令行只放引导装载 + 有界 P 参数：node -e 直塞整段脚本会撞 Windows 32767 字符上限
 * （2026-09-18 实测 34,944 字符 ENAMETOOLONG）。无上界的术语表由 runner 经 getRunConfig 自取。 */
import runnerBlob from './runner.blob.txt';

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
    if (typeof payload.semanticReview === 'boolean') await hostApi.kv.set('config:semanticReview', String(payload.semanticReview));
    if (typeof payload.retainDiagnostics === 'boolean') await hostApi.kv.set('config:retainDiagnostics', String(payload.retainDiagnostics));
    if (typeof payload.glossary === 'string') await hostApi.kv.set('config:glossary', payload.glossary);
    if (Array.isArray(payload.glossaryPaths)) await hostApi.kv.set('config:glossaryPaths', JSON.stringify(payload.glossaryPaths.filter(function (p) { return typeof p === 'string' && p.trim(); })));
    /* 并行度：每池（翻译池/复核池）1-6 路（默认 3），钳制到合法区间 */
    if (payload.concurrency != null) {
      var c = Math.round(Number(payload.concurrency));
      if (Number.isFinite(c) && c >= 1) await hostApi.kv.set('config:concurrency', String(Math.min(6, c)));
    }
    return { ok: true };
  },

  async getConfig() {
    var conc = parseInt(String(await hostApi.kv.get('config:concurrency') || ''), 10);
    return {
      ok: true,
      nodePath: await hostApi.kv.get('config:nodePath') || '',
      apiBase: await hostApi.kv.get('config:apiBase') || '',
      model: await hostApi.kv.get('config:model') || '',
      effectiveModel: await hostApi.kv.get('config:model') || 'Qwen/Qwen2.5-72B-Instruct',
      effectiveApiBase: await hostApi.kv.get('config:apiBase') || 'https://api.deepinfra.com/v1/openai',
      semanticReview: (await hostApi.kv.get('config:semanticReview')) === 'true',
      retainDiagnostics: (await hostApi.kv.get('config:retainDiagnostics')) === 'true',
      glossary: await hostApi.kv.get('config:glossary') || '',
      glossaryPaths: JSON.parse(await hostApi.kv.get('config:glossaryPaths') || '[]'),
      concurrency: Number.isFinite(conc) && conc >= 1 ? Math.min(6, conc) : 3,
    };
  },

  /* runner 经 localhost invoke 自取 key（不落盘/不上命令行） */
  async getApiKey() {
    var s = await hostApi.secrets.get('deepinfra_api_key');
    /* 契约是 {value}，但旧宿主实现直接返回裸字符串 —— 两种形状都兼容 */
    var v = s ? (typeof s === 'string' ? s : s.value) : null;
    return { key: v || null };
  },

  /* runner 经 localhost invoke 自取无上界配置（术语表粘贴文本不能进 node -e 命令行） */
  async getRunConfig() {
    return {
      glossary: await hostApi.kv.get('config:glossary') || '',
      glossaryPaths: JSON.parse(await hostApi.kv.get('config:glossaryPaths') || '[]'),
    };
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
    /*
     * 重启收养（2026-09-18 实测事故：应用重启 → detached runner 存活继续烧钱 + studio 重排任务
     * → 新旧两个 runner 双跑双计费）。心跳新鲜 = 有存活 runner 在推进本任务：不重复拉起，
     * 直接沿用其结果；心跳过期（停滞/已死）才 spawn 新 runner。
     * 旧版 runner 心跳只在调用边界落（间隔可达 ~5 分钟），故阈值取 5 分钟；新版 runner 每 30s 心跳全覆盖。
     */
    var beat = parseInt(String(await hostApi.kv.get('llmProgress:' + taskId) || ''), 10) || 0;
    var adopt = beat > 0 && (Date.now() - beat) < 5 * 60 * 1000;
    if (!adopt) {
      await hostApi.kv.delete('llmProgress:' + taskId);

    var concRaw = parseInt(String(await hostApi.kv.get('config:concurrency') || ''), 10);
    var params = {
      taskId: taskId, srtPath: payload.srtPath, sourceLang: payload.sourceLang || '', workDir: payload.workDir,
      fmbDataDir: _dataRoot(), callbackPluginId: 'com.fmb.subtitle.llmtranslate', studioPluginId: 'com.fmb.subtitle.studio',
      apiBase: await hostApi.kv.get('config:apiBase') || '', model: await hostApi.kv.get('config:model') || '',
      semanticReview: (await hostApi.kv.get('config:semanticReview')) === 'true',
      retainDiagnostics: (await hostApi.kv.get('config:retainDiagnostics')) === 'true',
      concurrency: Number.isFinite(concRaw) && concRaw >= 1 ? Math.min(6, concRaw) : 3,
    };
    /* 引导装载：P 注入作用域，脚本本体从 gzip blob 解出（命令行 ~13KB 且与 runner 源码规模脱钩） */
    var boot = 'var P = ' + JSON.stringify(params) + ';eval(require("zlib").gunzipSync(Buffer.from("' + runnerBlob + '","base64")).toString("utf8"))';

    await hostApi.processes.start({ executablePath: await _nodePath(), args: ['-e', boot], detached: true, timeoutMs: 10000 });
    }
    /* 收养路径：不 spawn，轮询沿用存活 runner 落盘的 translateResult */

    var hardDeadline = Date.now() + 2 * 60 * 60 * 1000;
    var stallMs = 10 * 60 * 1000;
    var lastBeat = adopt ? beat : Date.now();
    while (Date.now() < hardDeadline) {
      var raw = await hostApi.kv.get('translateResult:' + taskId);
      if (raw) {
        var r = JSON.parse(raw);
        if (!r.ok) throw new Error('llmtranslate: ' + (r.error || 'unknown'));
        return { ok: true, translatedSrtPath: r.translatedSrtPath, lineCount: r.lineCount, chunks: r.chunks, usage: r.usage, reviewPath: r.reviewPath || '' };
      }
      var beat2 = await hostApi.kv.get('llmProgress:' + taskId);
      if (beat2) lastBeat = Math.max(lastBeat, parseInt(beat2, 10) || lastBeat);
      if (Date.now() - lastBeat > stallMs) throw new Error('llmtranslate: 10 分钟无进度，判定停滞');
      await new Promise(function (rs) { setTimeout(rs, 2000); });
    }
    throw new Error('llmtranslate: runner timed out (2h)');
  },
};
