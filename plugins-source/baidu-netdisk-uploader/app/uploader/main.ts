/**
 * com.fmb.baidunetdisk.uploader — App plugin main module.
 *
 * Orchestrates the full pipeline:
 *   createTask → compress (7-zip) → upload (Baidu) → cleanup → completed
 *
 * All state is persisted via the com.fmb.tools.localdb atomic plugin (which
 * itself stores JSON collections in host KV). Task records include the
 * randomId (8-char archive folder/name) and password (4-char 7z key) so the
 * UI can offer a "复制身份信息" action.
 *
 * Cross-plugin calls use hostApi.plugins.invoke (requires plugins:invoke).
 * The 3-minute auto-resume is implemented as a host-level workflow + schedule
 * created on activate(); the workflow's single atomic node calls our own
 * onAutoResume action.
 *
 * NOTE: All handlers are free functions (no `this`) to avoid vm strict-mode
 * "Cannot set properties of undefined" bugs (same pattern as fmb-watchdog).
 */
/* global hostApi, __hostEnv */

var LOCALDB = 'com.fmb.tools.localdb';
var SEVENZIP = 'com.fmb.tools.sevenzip';
var BAIDU = 'com.fmb.baidunetdisk.client';
var COLL_TASKS = 'tasks';
var VOLUME_SIZE = '4092m';

var STATUS = {
  PENDING: 'pending',
  COMPRESSING: 'compressing',
  COMPRESSED: 'compressed',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  ABORTED_REC: 'aborted_recoverable',
  ABORTED_UNREC: 'aborted_unrecoverable',
};

var _resumeTimer = null;
var _scheduleCreated = false;
var _runningTasks = {}; // taskId → true while _runTask is in flight

function _env() {
  return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {};
}

/**
 * Resolve the fmb-data directory by walking up from the plugin's __filename.
 * Layout: {fmb-data}/plugins/<id>@<ver>/main.js  →  up 3 levels = fmb-data.
 * All plugin-generated files (tokens, temp scripts, 7z outputs) live under
 * {fmb-data}/baidu-uploader/ so portable builds are fully self-contained.
 */
function _fmbDataDir() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) {
    var bs = f.lastIndexOf('\\');
    var fs = f.lastIndexOf('/');
    var idx = Math.max(bs, fs);
    if (idx < 0) break;
    f = f.substring(0, idx);
  }
  return f;
}

function _defaultWorkDir() {
  var root = _fmbDataDir();
  if (root) return root + '\\baidu-uploader';
  // Fallback (shouldn't happen in normal installs)
  var env = _env();
  var base = env.LOCALAPPDATA || 'C:\\Users\\Public\\AppData\\Local';
  return base + '\\fairy-maid-brigade\\baidu-uploader';
}

function _genId(len) {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var s = '';
  for (var i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function _basename(p) {
  if (!p) return '';
  var s = p.replace(/\\/g, '/');
  var i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// ---- localdb helpers ----
function dbInsert(doc) {
  return hostApi.plugins.invoke({ pluginId: LOCALDB, method: 'insert', payload: { collection: COLL_TASKS, doc: doc } });
}
function dbUpdate(id, patch) {
  return hostApi.plugins.invoke({ pluginId: LOCALDB, method: 'update', payload: { collection: COLL_TASKS, id: id, patch: patch } });
}
function dbFindAll() {
  return hostApi.plugins.invoke({ pluginId: LOCALDB, method: 'find', payload: { collection: COLL_TASKS } });
}
function dbFindOne(id) {
  return hostApi.plugins.invoke({ pluginId: LOCALDB, method: 'findOne', payload: { collection: COLL_TASKS, id: id } });
}
function dbRemove(id) {
  return hostApi.plugins.invoke({ pluginId: LOCALDB, method: 'remove', payload: { collection: COLL_TASKS, id: id } });
}

// ---- config helpers ----
function _tokenFile(workDir) {
  return (workDir || _defaultWorkDir()) + '\\_baidu_tokens.json';
}

async function getConfig() {
  var keys = [
    'config:sevenzipPath', 'config:nodePath',
    'config:appId', 'config:appKey', 'config:secretKey', 'config:signKey',
    'config:bduss', 'config:remoteRoot', 'config:workDir',
    'config:uploadConcurrency',
  ];
  var vals = await Promise.all(keys.map(function (k) { return hostApi.kv.get(k); }));
  var workDir = vals[8] || _defaultWorkDir();
  return {
    sevenzipPath: vals[0] || 'C:\\Program Files\\7-Zip\\7z.exe',
    nodePath: vals[1] || 'C:\\Program Files\\nodejs\\node.exe',
    appId: vals[2] || '',
    appKey: vals[3] || '',
    secretKey: vals[4] || '',
    signKey: vals[5] || '',
    bduss: vals[6] || '',
    remoteRoot: vals[7] || '/apps/',
    workDir: workDir,
    tokenFile: _tokenFile(workDir),
    // Parallel part-upload workers passed to the baidunetdisk upload script.
    uploadConcurrency: Math.max(1, Math.min(16, parseInt(vals[9], 10) || 4)),
  };
}

async function setConfig(payload) {
  var map = {
    sevenzipPath: 'config:sevenzipPath',
    nodePath: 'config:nodePath',
    appId: 'config:appId',
    appKey: 'config:appKey',
    secretKey: 'config:secretKey',
    signKey: 'config:signKey',
    bduss: 'config:bduss',
    remoteRoot: 'config:remoteRoot',
    workDir: 'config:workDir',
    uploadConcurrency: 'config:uploadConcurrency',
  };
  for (var key in map) {
    if (payload && payload[key] !== undefined) {
      var v = payload[key];
      // Clamp concurrency to 1-16; anything unparsable falls back to 4.
      if (key === 'uploadConcurrency') v = String(Math.max(1, Math.min(16, parseInt(v, 10) || 4)));
      await hostApi.kv.set(map[key], String(v));
    }
  }
  // Also push sevenzipPath / nodePath into the atomic plugins' KV so they read it.
  if (payload.sevenzipPath !== undefined) {
    try { await hostApi.plugins.invoke({ pluginId: SEVENZIP, method: 'setSevenZipPath', payload: { path: payload.sevenzipPath } }); } catch (_) {}
  }
  if (payload.nodePath !== undefined) {
    try { await hostApi.plugins.invoke({ pluginId: BAIDU, method: 'setNodePath', payload: { path: payload.nodePath } }); } catch (_) {}
  }
  return getConfig();
}

// ---- pause flag helpers ----
function pauseKey(id) { return 'pause:' + id; }
async function isPaused(id) {
  var v = await hostApi.kv.get(pauseKey(id));
  return v === '1';
}
async function setPauseFlag(id, paused) {
  if (paused) await hostApi.kv.set(pauseKey(id), '1');
  else await hostApi.kv.delete(pauseKey(id));
}

// ---- core task runner ----
async function _runTask(taskId) {
  // In-flight guard: startTask / resumeTask / onAutoResume all funnel into
  // _runTask; without this a slow task (GB-scale compress+upload) could be
  // entered twice, double-spawning 7z/upload processes on the same folder.
  if (_runningTasks[taskId]) {
    hostApi.logger.warn('uploader._runTask: already running, skip', { taskId: taskId });
    return;
  }
  _runningTasks[taskId] = true;
  try {
    await _runTaskInner(taskId);
  } finally {
    delete _runningTasks[taskId];
  }
}

async function _runTaskInner(taskId) {
  var task = await dbFindOne(taskId);
  if (!task) { hostApi.logger.warn('uploader._runTask: task not found', { taskId: taskId }); return; }

  // If already in a terminal or paused state, skip.
  if (task.status === STATUS.COMPLETED || task.status === STATUS.PAUSED) return;

  var cfg = await getConfig();

  // Determine resume point from current status.
  var st = task.status;
  try {
    // Phase 1: compress (only if not already compressed/completed)
    if (st === STATUS.PENDING || st === STATUS.COMPRESSING || st === STATUS.ABORTED_REC) {
      await dbUpdate(taskId, { status: STATUS.COMPRESSING, error: null, updatedAt: Date.now() });
      hostApi.logger.info('uploader: compressing', { taskId: taskId, randomId: task.randomId });
      await hostApi.plugins.invoke({
        pluginId: SEVENZIP,
        method: 'compress',
        payload: {
          sourcePath: task.sourcePath,
          outputDir: cfg.workDir + '\\' + task.randomId,
          archiveName: task.randomId,
          password: task.password,
          volumeSize: VOLUME_SIZE,
          level: task.level || 'normal',
        },
      });
      await dbUpdate(taskId, { status: STATUS.COMPRESSED, updatedAt: Date.now() });
      st = STATUS.COMPRESSED;

      // Soft-pause check between phases.
      if (await isPaused(taskId)) {
        await dbUpdate(taskId, { status: STATUS.PAUSED, updatedAt: Date.now() });
        return;
      }
    }

    // Phase 2: upload
    if (st === STATUS.COMPRESSED || st === STATUS.UPLOADING || st === STATUS.ABORTED_REC) {
      await dbUpdate(taskId, { status: STATUS.UPLOADING, error: null, updatedAt: Date.now() });
      hostApi.logger.info('uploader: uploading', { taskId: taskId, randomId: task.randomId });
      // Honor the user-chosen remote directory: the archive goes into a
      // <randomId> subfolder UNDER the chosen dir (e.g. game-hx/eadipbi1/
      // eadipbi1.7z.001). Fall back to remoteRoot/<randomId> only when the
      // task has no chosen dir (e.g. very old records).
      var baseRemote = (task.remotePath || '').replace(/\/+$/, '') || (cfg.remoteRoot || '/apps/').replace(/\/+$/, '');
      var targetRemote = baseRemote + '/' + task.randomId;
      await hostApi.plugins.invoke({
        pluginId: BAIDU,
        method: 'upload',
        payload: {
          localFolder: cfg.workDir + '\\' + task.randomId,
          remotePath: targetRemote,
          // Task-linked requestId: upload progress callbacks then land on
          // uploadProgress:up_<taskId>, which listTasks reads for a cheap
          // liveness indicator.
          requestId: 'up_' + taskId,
          appKey: cfg.appKey,
          secretKey: cfg.secretKey,
          tokenFile: cfg.tokenFile,
          bduss: cfg.bduss,
          concurrency: cfg.uploadConcurrency,
          callbackPluginId: 'com.fmb.baidunetdisk.uploader',
        },
      });
      await dbUpdate(taskId, { status: STATUS.UPLOADED, error: null, updatedAt: Date.now() });
      st = STATUS.UPLOADED;
    }

    // Phase 3: cleanup + complete
    if (st === STATUS.UPLOADED || st === STATUS.ABORTED_REC) {
      hostApi.logger.info('uploader: cleanup', { taskId: taskId, randomId: task.randomId });
      try {
        await hostApi.plugins.invoke({
          pluginId: SEVENZIP,
          method: 'deleteFolder',
          payload: { folderPath: cfg.workDir + '\\' + task.randomId },
        });
      } catch (e) {
        hostApi.logger.warn('uploader: cleanup failed (non-fatal)', { error: e && e.message });
      }
      await dbUpdate(taskId, { status: STATUS.COMPLETED, error: null, updatedAt: Date.now() });
      hostApi.logger.info('uploader: task completed', { taskId: taskId });
    }
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    hostApi.logger.error('uploader: task aborted', { taskId: taskId, status: task.status, error: msg });
    // Classify: if source file missing → unrecoverable; else recoverable.
    // We cannot stat the file from the sandbox, so we default to recoverable
    // unless the error message hints at a missing source.
    var unrecoverable = /no such file|cannot find|source.*not found/i.test(msg);
    await dbUpdate(taskId, {
      status: unrecoverable ? STATUS.ABORTED_UNREC : STATUS.ABORTED_REC,
      error: msg,
      updatedAt: Date.now(),
    });
  }
}

// ---- exported UI actions ----
async function listTasks() {
  var tasks = await dbFindAll();
  // Sort newest first.
  tasks.sort(function (a, b) { return (b._createdAt || 0) - (a._createdAt || 0); });
  // Cheap liveness indicator for running tasks (progressText):
  //  - uploading: read the upload script's progress callbacks from global KV
  //    (keyed uploadProgress:up_<taskId> thanks to the task-linked requestId)
  //  - compressing: elapsed time only (7z progress is not readable from the
  //    sandbox; the phase advancing IS the liveness signal)
  // One small KV read per uploading task per poll — negligible.
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t.status === STATUS.UPLOADING) {
      try {
        var pv = await hostApi.kv.get('uploadProgress:up_' + t._id, true);
        if (pv) {
          var p = JSON.parse(pv);
          if (p.totalBytes) {
            var totalMb = Math.round(p.totalBytes / 1048576);
            var doneMb = Math.round((p.bytesDone || 0) / 1048576);
            var pct = Math.min(99, Math.floor(100 * (p.bytesDone || 0) / p.totalBytes));
            t.progressText = '上传中 · ' + pct + '% · ' + doneMb + '/' + totalMb + ' MB' +
              ((p.totalFiles || 0) > 1 ? ' · 文件 ' + Math.min(p.totalFiles, (p.filesDone || 0) + 1) + '/' + p.totalFiles : '');
          } else {
            t.progressText = '上传中';
          }
        } else {
          t.progressText = '上传中 · 正在启动';
        }
      } catch (_) { /* progress is best-effort */ }
    } else if (t.status === STATUS.COMPRESSING) {
      var mins = Math.max(0, Math.round((Date.now() - (t.updatedAt || Date.now())) / 60000));
      t.progressText = '压缩中 · 已进行 ' + (mins < 1 ? '不到 1 分钟' : mins + ' 分钟');
    }
  }
  return tasks;
}

/**
 * Exchange an OAuth authorization code for access_token + refresh_token.
 * The user gets the code by opening the Baidu authorization URL (generated in
 * the UI) and pasting the displayed code back.
 * payload: { code }
 */
async function authorize(payload) {
  var code = payload && payload.code;
  if (!code) throw new Error('authorize: code required');
  var cfg = await getConfig();
  if (!cfg.appKey) throw new Error('authorize: appKey not configured');
  if (!cfg.secretKey) throw new Error('authorize: secretKey not configured');
  var requestId = 'auth_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  await hostApi.plugins.invoke({
    pluginId: BAIDU,
    method: 'exchangeCode',
    payload: {
      appKey: cfg.appKey,
      secretKey: cfg.secretKey,
      code: code,
      tokenFile: cfg.tokenFile,
      callbackPluginId: 'com.fmb.baidunetdisk.uploader',
      requestId: requestId,
    },
  });
  hostApi.logger.info('uploader: authorization code exchanged', { tokenFile: cfg.tokenFile });
  return { ok: true };
}

async function createTask(payload) {
  var sourcePath = payload && payload.sourcePath;
  var remotePath = payload && payload.remotePath;
  if (!sourcePath) throw new Error('createTask: sourcePath required');
  if (!remotePath) throw new Error('createTask: remotePath required');

  // Compression level: store(仅存储) / fastest(极速) / normal(平衡) / max(最大).
  // Whitelist-validated; older tasks without the field behave as 'normal'.
  var level = (payload && payload.level) || 'normal';
  var ALLOWED_LEVELS = { store: 1, fastest: 1, normal: 1, max: 1 };
  if (!ALLOWED_LEVELS[level]) throw new Error('createTask: invalid level (store|fastest|normal|max)');

  var randomId = _genId(8);
  var password = _genId(4);

  var doc = {
    sourcePath: sourcePath,
    remotePath: remotePath,
    displayName: _basename(sourcePath),
    randomId: randomId,
    password: password,
    level: level,
    status: STATUS.PENDING,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  var inserted = await dbInsert(doc);
  hostApi.logger.info('uploader: task created', { taskId: inserted._id, randomId: randomId });
  return inserted;
}

async function startTask(payload) {
  var taskId = payload && payload.taskId;
  if (!taskId) throw new Error('startTask: taskId required');
  var task = await dbFindOne(taskId);
  if (!task) throw new Error('startTask: task not found');
  // Clear any pause flag.
  await setPauseFlag(taskId, false);
  // Kick off async; return immediately so UI doesn't block.
  setTimeout(function () { _runTask(taskId); }, 0);
  return { ok: true, taskId: taskId };
}

async function pauseTask(payload) {
  var taskId = payload && payload.taskId;
  if (!taskId) throw new Error('pauseTask: taskId required');
  await setPauseFlag(taskId, true);
  // Soft pause: the current sub-op will finish, then _runTask checks the flag.
  // If the task is between phases (compressed/uploaded), set paused now.
  var task = await dbFindOne(taskId);
  if (task && (task.status === STATUS.COMPRESSED || task.status === STATUS.UPLOADED || task.status === STATUS.PENDING)) {
    await dbUpdate(taskId, { status: STATUS.PAUSED, updatedAt: Date.now() });
  }
  return { ok: true };
}

async function resumeTask(payload) {
  var taskId = payload && payload.taskId;
  if (!taskId) throw new Error('resumeTask: taskId required');
  await setPauseFlag(taskId, false);
  setTimeout(function () { _runTask(taskId); }, 0);
  return { ok: true };
}

async function deleteTask(payload) {
  var taskId = payload && payload.taskId;
  if (!taskId) throw new Error('deleteTask: taskId required');
  var task = await dbFindOne(taskId);
  // Best-effort cleanup of local files.
  if (task) {
    try {
      var cfg = await getConfig();
      await hostApi.plugins.invoke({
        pluginId: SEVENZIP,
        method: 'deleteFolder',
        payload: { folderPath: cfg.workDir + '\\' + task.randomId },
      });
    } catch (_) {}
  }
  await setPauseFlag(taskId, false);
  await dbRemove(taskId);
  return { ok: true };
}

async function getTaskState(payload) {
  return dbFindOne(payload.taskId);
}

// ---- auto-resume schedule handler ----
async function onAutoResume(payload) {
  hostApi.logger.info('uploader: auto-resume scan', { scheduleId: payload && payload.scheduleId });
  var tasks = await dbFindAll();
  var resumed = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    // Only recoverable aborts (not paused, not unrecoverable).
    if (t.status === STATUS.ABORTED_REC) {
      resumed++;
      // Run async; don't await (one task failing shouldn't block others).
      setTimeout((function (id) { return function () { _runTask(id); }; })(t._id), 0);
    }
  }
  hostApi.logger.info('uploader: auto-resume done', { resumed: resumed });
  return { ok: true, resumed: resumed };
}

// ---- scheduled upload handler (workflow-triggered) ----
/**
 * Called by the wf-baidu-upload-flow workflow when triggered by a schedule
 * or manually from the workflow page. Creates a task and starts it.
 *
 * Payload = schedule_runtime_envelope { scheduleId, params, pluginId, ... }.
 *   - params.sourcePath  (string, required) : local file/folder to upload
 *   - params.remotePath  (string, optional) : remote sub-directory override
 */
async function onScheduledUpload(payload) {
  var params = (payload && payload.params) ? payload.params : {};
  var sourcePath = params.sourcePath;
  var remotePath = params.remotePath;
  var scheduleId = payload && payload.scheduleId;

  if (!sourcePath) {
    hostApi.logger.error('uploader: scheduled upload missing sourcePath', { scheduleId: scheduleId });
    throw new Error('定时上传缺少 sourcePath 参数');
  }

  var cfg = await getConfig();
  var finalRemote = remotePath
    ? (cfg.remoteRoot || '/apps/').replace(/\/+$/, '') + '/' + remotePath.replace(/^\/+|\/+$/g, '')
    : cfg.remoteRoot || '/apps/';

  hostApi.logger.info('uploader: scheduled upload triggered', {
    scheduleId: scheduleId,
    sourcePath: sourcePath,
    remotePath: finalRemote,
  });

  var created = await createTask({ sourcePath: sourcePath, remotePath: finalRemote, level: params.level });
  await startTask({ taskId: created._id });

  hostApi.logger.info('uploader: scheduled upload task started', {
    taskId: created._id,
    randomId: created.randomId,
  });

  return { ok: true, taskId: created._id, randomId: created.randomId };
}

// ---- lifecycle ----
async function activate(ctx) {
  ctx.hostApi.logger.info('uploader app activating', { pluginId: ctx.pluginId });

  // Init localdb collections.
  try {
    await hostApi.plugins.invoke({ pluginId: LOCALDB, method: 'init', payload: {} });
  } catch (e) {
    hostApi.logger.warn('uploader: localdb init failed', { error: e && e.message });
  }

  // Create workflows + schedule (idempotent).
  try {
    // ---- Workflow 1: auto-resume (existing) ----
    var existingWf = null;
    try { existingWf = await hostApi.workflows.get('wf-baidu-uploader-auto-resume'); } catch (_) { existingWf = null; }
    if (!existingWf) {
      try {
        var wf = await hostApi.workflows.create({
          id: 'wf-baidu-uploader-auto-resume',
          name: '百度上传-自动恢复',
          description: '每3分钟扫描可恢复中止任务并恢复',
          definition: {
            nodes: [{
              id: 'resume',
              type: 'atomic',
              pluginId: ctx.pluginId,
              action: 'onAutoResume',
              inputs: {},
            }],
            edges: [],
            entryNode: 'resume',
            vars: {},
          },
        });
        hostApi.logger.info('uploader: auto-resume workflow created', { workflowId: wf.id });
      } catch (ce) {
        hostApi.logger.info('uploader: auto-resume workflow already exists', { error: ce && ce.message });
      }
    }

    // ---- Workflow 2: scheduled upload flow (new) ----
    var existingFlow = null;
    try { existingFlow = await hostApi.workflows.get('wf-baidu-upload-flow'); } catch (_) { existingFlow = null; }
    if (!existingFlow) {
      try {
        var flow = await hostApi.workflows.create({
          id: 'wf-baidu-upload-flow',
          name: '百度上传-完整流程',
          description: '压缩 → 上传百度网盘 → 本地清理（由定时任务或手动触发）',
          definition: {
            nodes: [{
              id: 'upload',
              type: 'atomic',
              pluginId: ctx.pluginId,
              action: 'onScheduledUpload',
              inputs: {},
            }],
            edges: [],
            entryNode: 'upload',
            vars: {},
          },
        });
        hostApi.logger.info('uploader: scheduled-upload workflow created', { workflowId: flow.id });
      } catch (fe) {
        hostApi.logger.info('uploader: scheduled-upload workflow already exists', { error: fe && fe.message });
      }
    }

    // Schedule has no get(); create it and tolerate UNIQUE (already exists).
    try {
      var sched = await hostApi.schedules.create({
        id: 'sched-baidu-uploader-auto-resume',
        name: '百度上传-自动恢复(3分钟)',
        cron: '*/3 * * * *',
        workflowId: 'wf-baidu-uploader-auto-resume',
        enabled: true,
      });
      hostApi.logger.info('uploader: auto-resume schedule created', { scheduleId: sched.id });
    } catch (se) {
      hostApi.logger.info('uploader: auto-resume schedule already exists', { error: se && se.message });
    }
    _scheduleCreated = true;
  } catch (e) {
    hostApi.logger.warn('uploader: failed to create workflows/schedule (will rely on internal timer)', {
      error: e && e.message,
    });
  }

  // Internal fallback timer: every 3 minutes, run the resume scan.
  // This guarantees resume works even if the host-level schedule misfires.
  _resumeTimer = setInterval(function () {
    onAutoResume({ source: 'internal-timer' }).catch(function () {});
  }, 3 * 60 * 1000);

  hostApi.logger.info('uploader app activated', { scheduleCreated: _scheduleCreated });
}

async function deactivate() {
  hostApi.logger.info('uploader app deactivating');
  if (_resumeTimer) { try { clearInterval(_resumeTimer); } catch (_) {} }
  _resumeTimer = null;
}

/**
 * List subdirectories at a given Baidu Netdisk path.
 * Launches the baidunetdisk list script which calls back via HTTP to
 * storeDirList. Polls KV for the result.
 * payload: { dir }
 */
async function listRemoteDir(payload) {
  var dir = (payload && payload.dir) || '/';
  var cfg = await getConfig();
  if (!cfg.bduss && (!cfg.appKey || !cfg.secretKey)) throw new Error('请先配置 BDUSS 或 AppKey/SecretKey 并完成授权');
  var requestId = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  await hostApi.plugins.invoke({
    pluginId: BAIDU,
    method: 'listDir',
    payload: {
      dir: dir,
      appKey: cfg.appKey,
      secretKey: cfg.secretKey,
      tokenFile: cfg.tokenFile,
      bduss: cfg.bduss,
      callbackPluginId: 'com.fmb.baidunetdisk.uploader',
      requestId: requestId,
    },
  });
  // The list script POSTs back to storeDirList which stores in KV.
  // Poll up to 30s for the result.
  var kvKey = 'dirList:' + requestId;
  var result = null;
  for (var i = 0; i < 30; i++) {
    await new Promise(function (r) { setTimeout(r, 1000); });
    var v = await hostApi.kv.get(kvKey);
    if (v) {
      try { result = JSON.parse(v); } catch (_) {}
      break;
    }
  }
  // Clean up
  await hostApi.kv.delete(kvKey);
  if (!result) throw new Error('获取目录列表超时，请检查网络连接或授权是否有效');
  if (result && result.error) throw new Error(result.error);
  return { dir: dir, list: (result && result.list) || [] };
}

/**
 * Called back by the baidunetdisk list script via HTTP API.
 * Stores the directory list (and optional error) in KV for listRemoteDir to pick up.
 * payload: { requestId, list, error }
 */
async function storeDirList(payload) {
  var requestId = payload && payload.requestId;
  var list = payload && payload.list;
  var error = payload && payload.error;
  if (!requestId) throw new Error('storeDirList: requestId required');
  await hostApi.kv.set('dirList:' + requestId, JSON.stringify({ list: list || [], error: error || null }));
  return { ok: true };
}

/**
 * Called back by the baidunetdisk upload script via HTTP API.
 * Stores the upload result in KV for the upload action to pick up.
 * payload: { requestId, ok, message, uploaded, failed, failures }
 */
async function storeUploadResult(payload) {
  var requestId = payload && payload.requestId;
  if (!requestId) throw new Error('storeUploadResult: requestId required');
  // Use global KV so the baidunetdisk.client plugin (different KV namespace)
  // can read the result written here via HTTP callback.
  // Progress heartbeats go to a separate key; only the final outcome lands on
  // uploadResult:<id> which the client's upload() waits on.
  if (payload && (payload.phase === 'started' || payload.phase === 'progress')) {
    await hostApi.kv.set('uploadProgress:' + requestId, JSON.stringify({
      phase: payload.phase,
      counter: payload.counter || 0,
      totalBytes: payload.totalBytes || 0,
      bytesDone: payload.bytesDone || 0,
      totalFiles: payload.totalFiles || 0,
      filesDone: payload.filesDone || 0,
      part: payload.part || 0,
      parts: payload.parts || 0,
      at: Date.now(),
    }), true);
    return { ok: true };
  }
  await hostApi.kv.set('uploadResult:' + requestId, JSON.stringify({
    ok: payload.ok,
    message: payload.message || '',
    uploaded: payload.uploaded || 0,
    failed: payload.failed || 0,
    failures: payload.failures || [],
  }), true);
  return { ok: true };
}

/**
 * Called back by the baidunetdisk exchange script via HTTP API.
 * Stores the auth outcome (with the REAL Baidu error message on failure) in
 * the global KV so baidunetdisk.client's exchangeCode can read and relay it.
 * payload: { requestId, ok, message }
 */
async function storeAuthResult(payload) {
  var requestId = payload && payload.requestId;
  if (!requestId) throw new Error('storeAuthResult: requestId required');
  await hostApi.kv.set('authResult:' + requestId, JSON.stringify({
    ok: !!(payload && payload.ok),
    message: (payload && payload.message) || '',
  }), true);
  return { ok: true };
}

module.exports = {
  activate: activate,
  deactivate: deactivate,
  // UI actions
  getConfig: getConfig,
  setConfig: setConfig,
  authorize: authorize,
  listTasks: listTasks,
  createTask: createTask,
  startTask: startTask,
  pauseTask: pauseTask,
  resumeTask: resumeTask,
  deleteTask: deleteTask,
  getTaskState: getTaskState,
  listRemoteDir: listRemoteDir,
  storeDirList: storeDirList,
  storeUploadResult: storeUploadResult,
  storeAuthResult: storeAuthResult,
  // Schedule handlers
  onAutoResume: onAutoResume,
  onScheduledUpload: onScheduledUpload,
};
