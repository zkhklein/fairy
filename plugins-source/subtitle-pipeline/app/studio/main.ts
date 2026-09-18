/* global hostApi, __hostEnv */
// @ts-nocheck

var WF_BASE = 'wf-subtitle-flow';
var RECOVERABLE_RE = /timed out|停滞|timeout|HTTP 5\d\d|429|ECONNRESET|socket|network|网络/i;
var _wfId = null; /* 当前生效的工作流 id（definition 演进时换新版本 id，HostApi 无 workflow update） */
var TASKS_KEY = 'tasks';
var _running = false;
var _runningSince = 0;
var _timer = null;
var _resumeTimer = null;

function _dataRoot() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) { var b = f.lastIndexOf('\\'), s = f.lastIndexOf('/'); var x = Math.max(b, s); if (x < 0) break; f = f.substring(0, x); }
  return f;
}
async function _loadTasks() { try { return JSON.parse(await hostApi.kv.get(TASKS_KEY) || '[]'); } catch (_) { return []; } }
async function _saveTasks(tasks) { await hostApi.kv.set(TASKS_KEY, JSON.stringify(tasks)); }
function _tid() { return 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function _baseName(p) { var i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i >= 0 ? p.slice(i + 1) : p; }
function _finalPathFor(mediaPath) {
  var i = Math.max(mediaPath.lastIndexOf('\\'), mediaPath.lastIndexOf('/'));
  var dir = i >= 0 ? mediaPath.slice(0, i) : '';
  var stem = _baseName(mediaPath).replace(/\.[^.]+$/, '');
  return dir + '\\' + stem + '.zh.srt';
}

async function _ensureWorkflow() {
  var def = {
    nodes: [
      { id: 'asr', type: 'atomic', pluginId: 'com.fmb.subtitle.asr', action: 'transcribe',
        inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}', language: '${input.language}', workDir: '${input.workDir}' } },
      { id: 'translate', type: 'atomic', pluginId: 'com.fmb.subtitle.llmtranslate', action: 'translateSrt',
        inputs: { taskId: '${input.taskId}', srtPath: '${nodes.asr.output.srtPath}', sourceLang: '${nodes.asr.output.detectedLanguage}', workDir: '${input.workDir}' } },
      { id: 'write', type: 'atomic', pluginId: 'com.fmb.subtitle.writer', action: 'emit',
        inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}', translatedSrtPath: '${nodes.translate.output.translatedSrtPath}', rawSrtPath: '${nodes.asr.output.srtPath}', sourceLang: '${nodes.asr.output.detectedLanguage}', workDir: '${input.workDir}' } },
    ],
    edges: [{ source: 'asr', target: 'translate' }, { source: 'translate', target: 'write' }],
    entryNode: 'asr',
    vars: {},
  };
  var defJson = JSON.stringify(def);
  /*
   * HostApi 只有 workflows.create/start/get（无 update/delete），definition 演进只能换 id：
   * 从 v1 起扫现有版本，definition 完全一致的直接复用；全不一致则建新版本号 id
   * （旧版本记录残留但无害——不会被 start 引用）。
   */
  var maxV = 0;
  for (var v = 1; v <= 20; v++) {
    var id = v === 1 ? WF_BASE : WF_BASE + '-v' + v;
    var wf = null;
    try { wf = await hostApi.workflows.get(id); } catch (_) { wf = null; }
    if (!wf) break;
    var same = false;
    try { same = JSON.stringify(wf.definition) === defJson; } catch (_) {}
    if (same) { _wfId = id; return; }
    maxV = v;
  }
  var newId = maxV === 0 ? WF_BASE : WF_BASE + '-v' + (maxV + 1);
  try {
    await hostApi.workflows.create({ id: newId, name: '字幕提取翻译流水线', description: 'whisper 转写 → LLM 翻译 → 写出 .zh.srt（附原语言 .<lang>.srt）到媒体同目录', definition: def });
    _wfId = newId;
    hostApi.logger.info('studio: workflow created', { id: newId });
  } catch (e) {
    hostApi.logger.warn('studio: workflow create failed, falling back to latest existing', { error: e && e.message });
    _wfId = maxV === 0 ? WF_BASE : WF_BASE + '-v' + maxV;
  }
}

/*
 * 自动恢复守护（参考百度上传-自动恢复）：内部 3 分钟 setInterval。
 * 项目约定 app 插件用 sandbox 内定时器做周期任务，不走 host schedules/workflows
 * （HTTP enable 路径的 schedules.create 不可靠——百度 uploader 同样 fallback 内部 timer）。
 * onAutoResume 保持导出：可经 HTTP invoke 手动触发与离线测试。
 */
async function _ensureAutoResume() {
  if (_resumeTimer) clearInterval(_resumeTimer);
  _resumeTimer = setInterval(function () {
    Promise.resolve(module.exports.onAutoResume()).catch(function (e) {
      hostApi.logger.warn('studio auto-resume tick error', { error: e && e.message });
    });
  }, 3 * 60 * 1000);
}

async function _runTask(task) {
  var tasks = await _loadTasks();
  var me = tasks.find(function (t) { return t.taskId === task.taskId; });
  if (!me) return;
  me.status = 'asr'; me.progressText = '排队启动…'; me.error = '';
  await _saveTasks(tasks);
  try {
    var r = await hostApi.workflows.start(_wfId || WF_BASE, {
      taskId: me.taskId, mediaPath: me.mediaPath, language: me.language || 'auto',
      workDir: _dataRoot() + '\\subtitle-tasks\\' + me.taskId,
    });
    var ok = r && r.status === 'success';
    var tasks2 = await _loadTasks();
    var me2 = tasks2.find(function (t) { return t.taskId === task.taskId; });
    if (me2) {
      me2.status = ok ? 'done' : 'failed';
      if (ok) { me2.finalPath = _finalPathFor(me2.mediaPath); me2.progressText = '完成 · 请结合原音复核对照报告'; }
      else if (!me2.error) me2.error = '工作流执行失败（详见错误日历/日志）';
      me2.finishedAt = Date.now();
      await _saveTasks(tasks2);
    }
  } catch (e) {
    var tasks3 = await _loadTasks();
    var me3 = tasks3.find(function (t) { return t.taskId === task.taskId; });
    if (me3) { me3.status = 'failed'; me3.error = String(e && e.message || e); me3.finishedAt = Date.now(); await _saveTasks(tasks3); }
  }
}

async function _tick() {
  if (_running) return;
  var tasks = await _loadTasks();
  var next = tasks.find(function (t) { return t.status === 'queued'; });
  if (!next) return;
  if (_running) return;
  _running = true;
  _runningSince = Date.now();
  try { await _runTask(next); } finally { _running = false; _runningSince = 0; }
}

module.exports = {
  async activate(ctx) {
    ctx.hostApi.logger.info('subtitle-studio activated', { pluginId: ctx.pluginId });
    await _ensureWorkflow();
    await _ensureAutoResume();
    var tasks = await _loadTasks();
    var changed = false;
    tasks.forEach(function (t) {
      if (t.status === 'asr' || t.status === 'translating' || t.status === 'writing') { t.status = 'queued'; t.progressText = '重启后自动恢复排队'; changed = true; }
    });
    if (changed) await _saveTasks(tasks);
    _timer = setInterval(function () { _tick().catch(function (e) { hostApi.logger.warn('studio tick error', { error: e && e.message }); }); }, 2000);
  },
  deactivate() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_resumeTimer) { clearInterval(_resumeTimer); _resumeTimer = null; }
    hostApi.logger.info('subtitle-studio deactivated', {});
  },

  /* ---- UI actions ---- */
  async listTasks() { return { ok: true, tasks: await _loadTasks() }; },

  async createTasks(payload) {
    var paths = (payload && payload.paths) || [];
    var language = (payload && payload.language) || 'auto';
    if (!paths.length) throw new Error('createTasks: paths required');
    var tasks = await _loadTasks();
    var added = [];
    paths.forEach(function (p) {
      if (tasks.some(function (t) { return t.mediaPath === p && t.status !== 'failed' && t.status !== 'done'; })) return;
      var t = { taskId: _tid(), mediaPath: p, fileName: _baseName(p), language: language, status: 'queued', progressText: '排队中', error: '', finalPath: '', createdAt: Date.now(), finishedAt: 0 };
      tasks.push(t); added.push(t);
    });
    await _saveTasks(tasks);
    return { ok: true, added: added.length };
  },

  async retryTask(payload) {
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === (payload && payload.taskId); });
    if (!t) throw new Error('任务不存在');
    if (t.status === 'asr' || t.status === 'translating' || t.status === 'writing') throw new Error('任务执行中，不能重复启动');
    if (payload.language != null) {
      if (!['auto', 'ja', 'en'].includes(payload.language)) throw new Error('不支持的源语言选项');
      t.language = payload.language;
    }
    t.reviewPath = ''; t.sourceLang = ''; t.model = ''; t.finalPath = '';
    t.timelineWarnings = [];
    t.autoRetries = 0; /* 手动重试 = 用户意志，重新授予 3 次自动恢复额度 */
    t.status = 'queued'; t.error = ''; t.progressText = '排队重试'; t.finishedAt = 0;
    await _saveTasks(tasks);
    return { ok: true };
  },

  async deleteTask(payload) {
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === (payload && payload.taskId); });
    if (t && (t.status === 'asr' || t.status === 'translating' || t.status === 'writing')) throw new Error('任务执行中，暂不支持删除（可重启后删除）');
    tasks = tasks.filter(function (x) { return x.taskId !== (payload && payload.taskId); });
    await _saveTasks(tasks);
    return { ok: true };
  },

  async getConfig() {
    var key = await hostApi.secrets.get('deepinfra_api_key');
    /* 兼容旧宿主：secrets.get 可能返回裸字符串而非 {value} */
    return { ok: true, hasApiKey: !!(key && (typeof key === 'string' ? key : key.value)) };
  },

  async setConfig(payload) {
    if (payload && typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      var key = payload.apiKey.trim();
      await hostApi.secrets.set('deepinfra_api_key', key, 'DeepInfra API Key for subtitle translation');
      /* secrets 按插件隔离：转发给实际取 key 的 llmtranslate（其 getApiKey 读自己的 secrets） */
      await hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.llmtranslate', method: 'setConfig', payload: { apiKey: key } });
    }
    return { ok: true };
  },

  /* ---- 透传原子插件配置（studio UI 只能 callPluginMainAction 自己；经 plugins.invoke 转发） ---- */
  async getAsrConfig() {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.asr', method: 'getConfig', payload: {} });
  },
  async setAsrConfig(payload) {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.asr', method: 'setConfig', payload: payload || {} });
  },
  async getLlmConfig() {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.llmtranslate', method: 'getConfig', payload: {} });
  },
  async setLlmConfig(payload) {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.llmtranslate', method: 'setConfig', payload: payload || {} });
  },
  async setWriterConfig(payload) {
    return hostApi.plugins.invoke({ pluginId: 'com.fmb.subtitle.writer', method: 'setConfig', payload: payload || {} });
  },

  /* ---- 自动恢复（参考百度上传-自动恢复）：由 3 分钟 cron 工作流周期调用 ---- */
  async onAutoResume() {
    var recovered = 0, unstuck = false, orphans = 0;
    /* 队列解堵守护：串行执行卡死超过 2 小时（远超单任务常规波动）强制放行，防全队列冻结 */
    if (_running && _runningSince && Date.now() - _runningSince > 2 * 60 * 60 * 1000) {
      _running = false; _runningSince = 0; unstuck = true;
      hostApi.logger.warn('studio auto-resume: queue stuck >2h, forced release', {});
    }
    var tasks = await _loadTasks();
    tasks.forEach(function (t) {
      var midState = t.status === 'asr' || t.status === 'translating' || t.status === 'writing';
      /* 孤儿中间态收尾：队列空闲但自动恢复额度已用尽（canan FC 实测：卡 translating 一天无人收尾） */
      if (midState && !_running && (t.autoRetries || 0) >= 3) {
        t.status = 'failed';
        t.progressText = '自动恢复额度已用尽';
        if (!t.error) t.error = '多次自动恢复后仍未完成';
        t.finishedAt = t.finishedAt || Date.now();
        orphans++;
        return;
      }
      if ((t.autoRetries || 0) >= 3) return;
      /* 中间态恢复仅在队列空闲时执行（避免与正在执行的任务并发重跑 whisper） */
      if (midState && _running) return;
      var recoverableFailed = t.status === 'failed' && RECOVERABLE_RE.test(t.error || '');
      if (!midState && !recoverableFailed) return;
      t.status = 'queued';
      t.progressText = '自动恢复排队（第 ' + ((t.autoRetries || 0) + 1) + ' 次自动重试）';
      t.autoRetries = (t.autoRetries || 0) + 1;
      t.error = '';
      recovered++;
    });
    if (recovered || orphans) await _saveTasks(tasks);
    return { ok: true, recovered: recovered, unstuck: unstuck, orphans: orphans };
  },

  /* ---- runner 回调 ---- */
  async storeProgress(payload) {
    if (!payload || !payload.taskId) return { ok: true };
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === payload.taskId; });
    if (!t) return { ok: true };
    if (typeof payload.reviewPath === 'string') t.reviewPath = payload.reviewPath;
    if (typeof payload.sourceLang === 'string') t.sourceLang = payload.sourceLang;
    if (typeof payload.model === 'string') t.model = payload.model;
    if (Array.isArray(payload.timelineWarnings)) t.timelineWarnings = payload.timelineWarnings;
    if (payload.stage === 'asr') t.status = 'asr';
    else if (payload.stage === 'translating') t.status = 'translating';
    else if (payload.stage === 'error') { t.error = payload.text || t.error; }
    if (payload.text) t.progressText = payload.text;
    await _saveTasks(tasks);
    return { ok: true };
  },
};
