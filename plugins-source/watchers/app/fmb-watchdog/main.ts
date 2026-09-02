/**
 * com.fmb.watchdog — App plugin main module (fixed this-scope: use closure).
 *
 * Responsibilities:
 *   1) onEnable → populate per-target `env:*` KVs from host env.
 *   2) expose main actions UI calls via HostUIApi.callPluginMainAction:
 *        setEnabled / getState / readinessCheck / setExecPath / runNow.
 *   3) target: 'traework' ↔ com.fmb.watcher.traework
 *              'chatgpt' ↔ com.fmb.watcher.chatgpt
 *
 * IMPL NOTE: We keep ALL handlers (activate/deactivate/getState/setEnabled/
 * setExecPath/runNow/readinessCheck) as free-standing named functions in the
 * module closure. None of them use `this`. The export object simply *refs*
 * those same functions. This avoids the "Cannot set properties of undefined
 * (setting 'stopped')" class of bugs that occur when the plugin loader calls
 * `exports.activate(ctx)` without binding `this` (vm strict mode defaults
 * `this` to undefined).
 */
/* global hostApi, __hostEnv */
var TARGETS = {
  traework: {
    atomicId: 'com.fmb.watcher.traework',
    displayName: 'TraeWork',
    scheduleIdKv: 'scheduleId:traework',
    workflowIdKv: 'workflowId:traework',
    enabledKv: 'enabled:traework',
    lastKv: 'lastCheckResult:traework',
  },
  chatgpt: {
    atomicId: 'com.fmb.watcher.chatgpt',
    displayName: 'ChatGPT',
    scheduleIdKv: 'scheduleId:chatgpt',
    workflowIdKv: 'workflowId:chatgpt',
    enabledKv: 'enabled:chatgpt',
    lastKv: 'lastCheckResult:chatgpt',
  },
};
var CRON_EVERY_2_MIN = '*/2 * * * *';
var POLL_INTERVAL_MS = 30_000;
var GUARD_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes = "cron" replacement (internal setInterval)
// ---- Closure state (no `this`) ----
var _interval: any = null;         // 30s poll — check status only, NEVER disturb
var _cronInterval: any = null;     // 2min guard — run ensureRunning for enabled targets
var _stopped = false;
var _hostEnv: any = null;

function _cacheHostEnvOnce() {
  if (_hostEnv) return _hostEnv;
  try {
    var h = (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {};
    _hostEnv = {
      LOCALAPPDATA: h.LOCALAPPDATA || '',
      PROGRAMFILES: h.PROGRAMFILES || '',
      'PROGRAMFILES(X86)': h['PROGRAMFILES(X86)'] || '',
      PROGRAMW6432: h.PROGRAMW6432 || '',
    };
  } catch (_) {
    _hostEnv = { LOCALAPPDATA:'', PROGRAMFILES:'','PROGRAMFILES(X86)':'', PROGRAMW6432:'' };
  }
  return _hostEnv;
}

async function _writeEnvKVIfAbsent() {
  var env = _cacheHostEnvOnce();
  var pairs = [
    ['env:LOCALAPPDATA', env.LOCALAPPDATA],
    ['env:PROGRAMFILES', env.PROGRAMFILES],
    ['env:PROGRAMFILES(X86)', env['PROGRAMFILES(X86)']],
    ['env:PROGRAMW6432', env.PROGRAMW6432],
  ];
  for (var i = 0; i < pairs.length; i++) {
    var k = pairs[i][0], v = pairs[i][1];
    if (!v) continue;
    try {
      var cur = await hostApi.kv.get(k);
      if (!cur) await hostApi.kv.set(k, v);
    } catch (_) {}
  }
}

async function _pollOnce() {
  if (_stopped) return;
  var t = Date.now();
  var keys = Object.keys(TARGETS);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var meta = TARGETS[key];
    var live: any = null;
    var lastError: any = null;
    var usedDirect = false;
    try {
      live = await hostApi.plugins.invoke({
        pluginId: meta.atomicId,
        method: 'check',
        payload: {},
      });
    } catch (err) {
      lastError = (err && (err.message || String(err))) || String(err);
      // plugins.invoke failed (e.g. atomic not enabled / not installed) — fall
      // back to raw processes query so the UI still shows *some* reasonable
      // state (instead of stale / null rows).
      usedDirect = true;
      var CAND = (key === 'traework') ? ['Trae.exe', 'TraeWork.exe'] : ['ChatGPT.exe', 'ChatGPTDesktop.exe'];
      try {
        var q = await hostApi.processes.query({ processNames: CAND });
        var running = false;
        for (var j = 0; j < CAND.length; j++) if (q[CAND[j]] === true) { running = true; break; }
        live = {
          running: running,
          execPath: null,
          needSetup: false,
          displayName: meta.displayName,
          note: 'direct hostApi.processes.query fallback (plugins.invoke failed: atomic likely not enabled)',
        };
      } catch (_) { /* leave live=null */ }
    }
    if (live && typeof live === 'object') {
      var snapshot: any = {};
      for (var p in live) if (Object.prototype.hasOwnProperty.call(live, p)) snapshot[p] = live[p];
      snapshot.lastCheckMs = t;
      snapshot.lastAction = live.action || null;
      if (usedDirect) snapshot.source = 'fallback-processes-query';
      else snapshot.source = 'atomic.plugins.invoke(check)';
      snapshot.lastError = lastError || live.lastError || null;
      try { await hostApi.kv.set(meta.lastKv, JSON.stringify(snapshot)); } catch (_) {}
    }
  }
}

async function _ensureWorkflowAndScheduleFor(target: any) {
  // Previously this tried to create host-level workflows + schedules via
  // hostApi.workflows.create / hostApi.schedules.create. Those paths were the
  // likely source of process-level crashes on enable. We now rely entirely on
  // two in-plugin setInterval loops (see activate) to do the same job:
  //   - 30s poll: only check, never disturb running programs (_pollOnce)
  //   - 2min loop: call atomic ensureRunning (the "cron guard")
  //
  // We still write workflowIdKv/scheduleIdKv so the UI renderer can show
  // "internal schedule active" status consistently.
  var meta = TARGETS[target as keyof typeof TARGETS];
  if (!meta) throw new Error('Unknown target: ' + target);
  try { await hostApi.kv.set('debug:wf:' + target + ':step', '1-internal-cron-mode'); } catch (_) {}
  var internalId = 'internal-' + target + '-2min-loop';
  await hostApi.kv.set(meta.workflowIdKv, 'watchdog-' + target + '-internal');
  await hostApi.kv.set(meta.scheduleIdKv, internalId);
  try { await hostApi.kv.set('debug:wf:' + target + ':step', '5-done'); } catch (_) {}
  return { workflowId: 'watchdog-' + target + '-internal', scheduleId: internalId, mode: 'plugin-internal-setInterval' };
}

async function _reconcile() {
  var keys = Object.keys(TARGETS);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var meta = TARGETS[key];
    var en = await hostApi.kv.get(meta.enabledKv);
    if (en === '1' || en === 'true') {
      try { await _ensureWorkflowAndScheduleFor(key); }
      catch (err) {
        var msg = (err && err.message) ? err.message : String(err);
        try { hostApi.logger.error('watchdog.reconcile.fail for target=' + key + ': ' + msg, {
          target: key,
          error: msg,
          stack: (err && err.stack) ? String(err.stack) : null,
        }); } catch (_) {}
      }
    }
  }
}

async function _invokeAtomic(target: string, action: string) {
  var meta = TARGETS[target as keyof typeof TARGETS];
  if (!meta) throw new Error('Unknown target: ' + target);
  // action ∈ { check, ensureRunning, setExecPath } → map to exported atomic fn.
  // check + ensureRunning are directly on exports (public API for atomic).
  // setExecPath is exported as `onSetExecPath(payload)`.
  var method: string;
  switch (action) {
    case 'check':         method = 'check'; break;
    case 'ensureRunning': method = 'ensureRunning'; break;
    case 'setExecPath':   method = 'onSetExecPath'; break;
    default: throw new Error('_invokeAtomic: unknown action ' + action);
  }
  var r = await hostApi.plugins.invoke({ pluginId: meta.atomicId, method: method, payload: {} });
  return r;
}

// ---- Exported handlers (ALL are free functions; none use `this`) ----
async function activate(ctx: any) {
  ctx.hostApi.logger.info('watchdog app activating', { pluginId: ctx.pluginId });
  var startTs = Date.now();
  try {
    try { await hostApi.kv.set('debug:activate:step', '1-enter', false); } catch (_) {}
    try { await _writeEnvKVIfAbsent(); } catch (e) {
      try { ctx.hostApi.logger.warn('watchdog env seed failed (atomics fall back to C: drive defaults)', {
        error: (e && e.message) ? e.message : String(e),
      }); } catch (_) {}
    }
    try { await hostApi.kv.set('debug:activate:step', '2-env-seeded', false); } catch (_) {}
    try { await _reconcile(); }
    catch (err) {
      var msg = (err && err.message) ? err.message : String(err);
      try { hostApi.logger.error('watchdog.activate.reconcile.fail: ' + msg, {
        error: msg,
        stack: (err && err.stack) ? String(err.stack) : null,
      }); } catch (_) {}
      try { await hostApi.kv.set('debug:activate:reconcileErr', msg, false); } catch (_) {}
    }
    try { await hostApi.kv.set('debug:activate:step', '3-reconciled', false); } catch (_) {}
    _stopped = false;
    // Loops are implemented internally via sandbox-exposed setInterval so the
    // watchdog keeps working purely inside the plugin VM — no dependency on
    // host-level workflows/schedules creation paths (which historically caused
    // process-level crashes when the plugin enabled).
    var tickPoll = function () {
      if (_stopped) return;
      _pollOnce().then(function () {}).catch(function () {});
    };
    var tickGuard = function () {
      if (_stopped) return;
      // For each enabled target, invoke atomic ensureRunning (the guarded
      // action that NEVER disturbs a running instance; only spawns the exe
      // when processes.query reports all candidate PIDs absent). Errors are
      // swallowed; the 30s poll loop updates the UI state regardless.
      var keys: string[] = Object.keys(TARGETS);
      var i = 0;
      var next = function () {
        if (_stopped || i >= keys.length) return;
        var key = keys[i++];
        var meta = TARGETS[key as keyof typeof TARGETS];
        Promise.resolve()
          .then(function () { return hostApi.kv.get(meta.enabledKv); })
          .then(function (en) {
            if (en !== '1' && en !== 'true') return null;
            return _invokeAtomic(key, 'ensureRunning');
          })
          .then(function () { try { return _pollOnce(); } catch (_) { return null; } })
          .then(function () { next(); })
          .catch(function () { next(); });
      };
      next();
    };
    _interval = setInterval(tickPoll, POLL_INTERVAL_MS);       // 30s status check
    _cronInterval = setInterval(tickGuard, GUARD_INTERVAL_MS); // 2min ensureRunning cron
    setTimeout(tickPoll, 500);
    setTimeout(tickGuard, 1500);
  } finally {
    try { await hostApi.kv.set('debug:activate:totalMs', String(Date.now() - startTs), false); } catch (_) {}
  }
}

async function deactivate() {
  try { hostApi.logger.info('watchdog app deactivating'); } catch (_) {}
  _stopped = true;
  if (_interval) { try { clearInterval(_interval); } catch (_) {} }
  if (_cronInterval) { try { clearInterval(_cronInterval); } catch (_) {} }
  _interval = null;
  _cronInterval = null;
}

async function getState() {
  var targets = {};
  var keys = Object.keys(TARGETS);
  var pending = [];
  for (var i = 0; i < keys.length; i++) {
    (function () {
      var key = keys[i];
      var meta = TARGETS[key];
      var p = hostApi.kv.get(meta.enabledKv).then(function (enabledRaw) {
        var enabled = (enabledRaw === '1' || enabledRaw === 'true');
        return hostApi.kv.get(meta.lastKv).then(function (lastRaw) {
          var last = null;
          if (lastRaw) { try { last = JSON.parse(lastRaw); } catch (_) {} }
          return hostApi.plugins.invoke({ pluginId: meta.atomicId, method: 'check', payload: {} }).then(function (live: any) {
            // Merge fresh live fields on TOP OF the KV snapshot so historic KV fields
            // (lastCheckMs, lastAction, lastError — written by the 30s poll loop) survive
            // even though the atomic check() payload doesn't echo them back.
            if (live && typeof live === 'object') last = Object.assign({}, last || {}, live);
            targets[key] = {
              enabled: enabled,
              displayName: meta.displayName,
              atomicId: meta.atomicId,
              running: !!(last && last.running),
              execPath: (last && typeof last.execPath === 'string') ? last.execPath : null,
              needSetup: Boolean(last && last.needSetup),
              lastCheckMs: (last && typeof last.lastCheckMs === 'number') ? last.lastCheckMs : null,
              lastAction: (last && last.lastAction) || null,
              lastError: (last && last.lastError) || null,
            };
          }).catch(function () {
            targets[key] = {
              enabled: enabled,
              displayName: meta.displayName,
              atomicId: meta.atomicId,
              running: !!(last && last.running),
              execPath: (last && typeof last.execPath === 'string') ? last.execPath : null,
              needSetup: Boolean(last && last.needSetup),
              lastCheckMs: (last && typeof last.lastCheckMs === 'number') ? last.lastCheckMs : null,
              lastAction: (last && last.lastAction) || null,
              lastError: (last && last.lastError) || null,
            };
          });
        });
      });
      pending.push(p);
    })();
  }
  // Await all individual per-target promises deterministically; 4s timeout
  // guard just in case an EP call is very slow.
  var waitStart = Date.now();
  await Promise.race([
    Promise.all(pending),
    new Promise(function (resolve) {
      (function spin() {
        if ((Date.now() - waitStart) > 4000) { resolve(); return; }
        setTimeout(spin, 80);
      })();
    }),
  ]);
  return { targets: targets, pollIntervalMs: POLL_INTERVAL_MS, cronSpec: CRON_EVERY_2_MIN };
}

async function setEnabled(payload: any) {
  var target = payload.target;
  var enabled = !!payload.enabled;
  var meta = TARGETS[target as keyof typeof TARGETS];
  if (!meta) throw new Error('Unknown target: ' + target);
  await hostApi.kv.set(meta.enabledKv, enabled ? '1' : '0');
  if (enabled) {
    await _ensureWorkflowAndScheduleFor(target);
    // Immediately run one ensureRunning guard pass so a fresh toggle-on takes
    // effect NOW instead of waiting up to 2 min for the next cron tick.
    try { await _invokeAtomic(target, 'ensureRunning'); } catch (_) {}
  }
  // Note: the internal schedule is the plugin-level 2min setInterval loop
  // (controlled by the global `_stopped` flag). Per-target enabled/off is
  // read from KV on every tick — no per-target schedule to toggle.
  try { await _pollOnce(); } catch (_) {}
  return getState();
}

async function setExecPath(payload: any) {
  var target = payload.target;
  var userPath = (payload && typeof payload.path === 'string') ? payload.path.trim() : null;
  var meta = TARGETS[target as keyof typeof TARGETS];
  if (!meta) throw new Error('Unknown target: ' + target);
  if (userPath !== null && userPath.length === 0) userPath = null;
  // Write the global KV first so subsequent reinstalls / new plugin instances
  // can re-read this even if the atomic plugin's scoped KV is wiped.
  // userPath === null means: erase the override, fall back to candidates.
  var gk = 'global:execPath:' + meta.atomicId;
  if (userPath === null) await hostApi.kv.del(gk, true); else await hostApi.kv.set(gk, userPath, true);
  // Then write directly into atomic plugin's own scoped KV via its exported
  // onSetExecPath handler (this validates + logs it too).
  try {
    await hostApi.plugins.invoke({
      pluginId: meta.atomicId,
      method: 'onSetExecPath',
      payload: { path: userPath === null ? '' : userPath },
    });
  } catch (_) { /* atomic may be disabled — global write above will be picked up next boot */ }
  try { await _pollOnce(); } catch (_) {}
  return getState();
}

async function runNow(payload) {
  var target = payload.target;
  if (!TARGETS[target]) throw new Error('Unknown target: ' + target);
  var r = await _invokeAtomic(target, 'ensureRunning');
  try { await _pollOnce(); } catch (_) {}
  var s = await getState();
  return { result: r, state: s };
}

async function readinessCheck() {
  var checks = [];
  var list = await hostApi.plugins.list();
  var keys = Object.keys(TARGETS);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var meta = TARGETS[key];
    var found = null;
    for (var j = 0; j < list.length; j++) {
      if (list[j].id === meta.atomicId) { found = list[j]; break; }
    }
    checks.push({
      target: key,
      atomicInstalled: !!found,
      atomicEnabled: !!(found && found.status === 'enabled'),
    });
  }
  return { checks: checks, pollIntervalMs: POLL_INTERVAL_MS, cronSpec: CRON_EVERY_2_MIN };
}

module.exports = {
  activate: activate,
  deactivate: deactivate,
  getState: getState,
  setEnabled: setEnabled,
  setExecPath: setExecPath,
  runNow: runNow,
  readinessCheck: readinessCheck,
};
