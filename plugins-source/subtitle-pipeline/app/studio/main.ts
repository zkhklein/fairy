/* global hostApi, __hostEnv */
// @ts-nocheck

var WF_ID = 'wf-subtitle-flow';
var TASKS_KEY = 'tasks';
var _running = false;
var _timer = null;

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
  var existing = null;
  try { existing = await hostApi.workflows.get(WF_ID); } catch (_) { existing = null; }
  if (existing) return;
  var def = {
    nodes: [
      { id: 'asr', type: 'atomic', pluginId: 'com.fmb.subtitle.asr', action: 'transcribe',
        inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}', language: '${input.language}', workDir: '${input.workDir}' } },
      { id: 'translate', type: 'atomic', pluginId: 'com.fmb.subtitle.llmtranslate', action: 'translateSrt',
        inputs: { taskId: '${input.taskId}', srtPath: '${nodes.asr.output.srtPath}', sourceLang: '${nodes.asr.output.detectedLanguage}', workDir: '${input.workDir}' } },
      { id: 'write', type: 'atomic', pluginId: 'com.fmb.subtitle.writer', action: 'emit',
        inputs: { taskId: '${input.taskId}', mediaPath: '${input.mediaPath}', translatedSrtPath: '${nodes.translate.output.translatedSrtPath}', workDir: '${input.workDir}' } },
    ],
    edges: [{ source: 'asr', target: 'translate' }, { source: 'translate', target: 'write' }],
    entryNode: 'asr',
    vars: {},
  };
  try {
    await hostApi.workflows.create({ id: WF_ID, name: '字幕提取翻译流水线', description: 'whisper 转写 → LLM 翻译 → 写出 .zh.srt 到媒体同目录', definition: def });
    hostApi.logger.info('studio: workflow created', { id: WF_ID });
  } catch (e) {
    hostApi.logger.info('studio: workflow already exists', { error: e && e.message });
  }
}

async function _runTask(task) {
  var tasks = await _loadTasks();
  var me = tasks.find(function (t) { return t.taskId === task.taskId; });
  if (!me) return;
  me.status = 'asr'; me.progressText = '排队启动…'; me.error = '';
  await _saveTasks(tasks);
  try {
    var r = await hostApi.workflows.start(WF_ID, {
      taskId: me.taskId, mediaPath: me.mediaPath, language: me.language || 'auto',
      workDir: _dataRoot() + '\\subtitle-tasks\\' + me.taskId,
    });
    var ok = r && r.status === 'success';
    var tasks2 = await _loadTasks();
    var me2 = tasks2.find(function (t) { return t.taskId === task.taskId; });
    if (me2) {
      me2.status = ok ? 'done' : 'failed';
      if (ok) { me2.finalPath = _finalPathFor(me2.mediaPath); me2.progressText = '完成'; }
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
  try { await _runTask(next); } finally { _running = false; }
}

module.exports = {
  async activate(ctx) {
    ctx.hostApi.logger.info('subtitle-studio activated', { pluginId: ctx.pluginId });
    await _ensureWorkflow();
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
    return { ok: true, hasApiKey: !!(key && key.value) };
  },

  async setConfig(payload) {
    if (payload && typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      await hostApi.secrets.set('deepinfra_api_key', payload.apiKey.trim(), 'DeepInfra API Key for subtitle translation');
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

  /* ---- runner 回调 ---- */
  async storeProgress(payload) {
    if (!payload || !payload.taskId) return { ok: true };
    var tasks = await _loadTasks();
    var t = tasks.find(function (x) { return x.taskId === payload.taskId; });
    if (!t) return { ok: true };
    if (payload.stage === 'asr') t.status = 'asr';
    else if (payload.stage === 'translating') t.status = 'translating';
    else if (payload.stage === 'error') { t.error = payload.text || t.error; }
    if (payload.text) t.progressText = payload.text;
    await _saveTasks(tasks);
    return { ok: true };
  },
};
