/**
 * atomic com.fmb.watcher.traework
 *
 * Atomic actions (usable as workflow nodes or via IPC callAction):
 *   - check(payload?) -> { running: boolean, pidHint?: number, execPath: string|null, needSetup: boolean }
 *   - ensureRunning(payload?) -> { runningWas: boolean, action: 'noop'|'started', pid?: number, needSetup: boolean, lastError?: string }
 *
 * CONTRACT: NEVER KILL / DISTURB a running target. `ensureRunning` first
 * runs check; only proceeds to hostApi.processes.start(execPath) if running===false.
 * `start` itself is spawned detached+unref (host implementation) so the running
 * software's lifetime is INDEPENDENT of FMB. FMB restarts → software keeps running.
 */
/* global hostApi, __hostEnv */
module.exports = (function factory() {
  // ---- TraeWork specifics ----
  // NOTE: Bytedance distributes this product under several rebranded image names
  // on zh-CN Windows installs (TraeWork CN → "TRAE SOLO CN.exe", TraeCode CN →
  // "Trae CN.exe"). Keep both English-default + CN-bundle candidates so
  // processes.query detects the process correctly regardless of locale.
  const PROCESS_NAME_CANDIDATES = ['Trae.exe', 'TraeWork.exe', 'TRAE SOLO CN.exe', 'Trae CN.exe', 'TraeCode.exe']; // Windows image names
  const KV_EXEC_PATH_KEY = 'execPath';
  const GLOBAL_KV_EXEC_KEY = 'global:execPath:com.fmb.watcher.traework';

  // 候选安装位置；会按顺序找第一个存在的
  function candidatePaths(host: any) {
    const env = host._cachedEnv || {};
    const list: string[] = [];
    const push = (p: string | null) => { if (p && !list.includes(p)) list.push(p); };
    push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Trae\\Trae.exe` : null);
    push(env.PROGRAMFILES ? `${env.PROGRAMFILES}\\Trae\\Trae.exe` : null);
    push(env['PROGRAMFILES(X86)'] ? `${env['PROGRAMFILES(X86)']}\\Trae\\Trae.exe` : null);
    push(env.PROGRAMW6432 ? `${env.PROGRAMW6432}\\Trae\\Trae.exe` : null);
    // TraeWork 别名
    push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\TraeWork\\TraeWork.exe` : null);
    push(env.PROGRAMFILES ? `${env.PROGRAMFILES}\\TraeWork\\TraeWork.exe` : null);
    // 中文发行版（zh-CN bundles: TraeWork CN / TraeCode CN）
    push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\TRAE SOLO CN\\TRAE SOLO CN.exe` : null);
    push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Trae CN\\Trae CN.exe` : null);
    return list;
  }
  const DISPLAY_NAME = 'TraeWork';
  const PLUGIN_ID = 'com.fmb.watcher.traework';

  // ---- Host helpers ----
  // hostApi is injected as a sandbox global.

  async function _readEnv() {
    const injected = (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : ({} as any);
    const [la, pf, pf86, pw64] = await Promise.all([
      hostApi.kv.get('env:LOCALAPPDATA'),
      hostApi.kv.get('env:PROGRAMFILES'),
      hostApi.kv.get('env:PROGRAMFILES(X86)'),
      hostApi.kv.get('env:PROGRAMW6432'),
    ]);
    return {
      LOCALAPPDATA: la || injected.LOCALAPPDATA || 'C:\\Users\\Public\\AppData\\Local',
      PROGRAMFILES: pf || injected.PROGRAMFILES || 'C:\\Program Files',
      'PROGRAMFILES(X86)': pf86 || injected['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      PROGRAMW6432: pw64 || injected.PROGRAMW6432 || 'C:\\Program Files',
    };
  }

  async function _resolveExecPath() {
    // Priority: 1) plugin-scoped KV override, 2) global KV from watchdog UI, 3) candidate guesses.
    const override = await hostApi.kv.get(KV_EXEC_PATH_KEY);
    if (override) return override;
    const globalOverride = await hostApi.kv.get(GLOBAL_KV_EXEC_KEY, true);
    if (globalOverride) return globalOverride;
    const env = await _readEnv();
    const candHost: any = { _cachedEnv: env };
    const cand = candidatePaths(candHost);
    return cand[0] || null;
  }

  // Simple path.basename for Windows — avoids require('path') since the plugin
  // sandbox blocks native Node built-ins. Works for our single use-case (pulling
  // image name out of an absolute path passed via overrideExec).
  function _basename(p: string): string {
    if (!p) return '';
    const s1 = p.replace(/\\/g, '/');
    const i = s1.lastIndexOf('/');
    return i >= 0 ? s1.slice(i + 1) : s1;
  }

  /** Check: is TraeWork / Trae.exe currently alive?
   *  Optional payload overrides (for E2E safe harness / debug / UI temporary check):
   *    processNames?: string[] — override the default candidate image-name list
   *    execPath?: string     — override the default resolved executable path
   *                           (we also derive the final image name from the basename) */
  async function check(payload: any) {
    const overrideNames: string[] | null =
      payload && Array.isArray(payload.processNames) ? payload.processNames.filter(x => typeof x === 'string') : null;
    const overrideExec: string | null =
      payload && typeof payload.execPath === 'string' ? payload.execPath.trim() || null : null;
    let procNames: string[];
    if (overrideNames) {
      procNames = overrideNames.slice();
      if (overrideExec) {
        const bn = _basename(overrideExec);
        if (bn && !procNames.includes(bn)) procNames.push(bn);
      }
    } else {
      procNames = PROCESS_NAME_CANDIDATES.slice();
      if (overrideExec) {
        const bn = _basename(overrideExec);
        if (bn && !procNames.includes(bn)) procNames.push(bn);
      }
    }
    const q = await hostApi.processes.query({ processNames: procNames });
    const running = procNames.some(n => q[n] === true);
    const execPath = overrideExec || (await _resolveExecPath());
    hostApi.logger.info(`${PLUGIN_ID}.check`, { running, execPath, procNames, overrides: !!overrideNames || !!overrideExec });
    return {
      running,
      execPath,
      needSetup: !execPath,
      displayName: DISPLAY_NAME,
    };
  }

  /** Only if not running -> start the exe; otherwise strictly no-op.
   *  Accepts same payload overrides as `check` (payload.processNames / payload.execPath). */
  async function ensureRunning(payload: any) {
    const cur = await check(payload);
    if (cur.running) {
      hostApi.logger.info(`${PLUGIN_ID}.ensureRunning → noop (already running). Do not disturb.`, { execPath: cur.execPath });
      return { runningWas: true, action: 'noop', needSetup: cur.needSetup, execPath: cur.execPath, displayName: DISPLAY_NAME };
    }
    if (!cur.execPath) {
      hostApi.logger.warn(`${PLUGIN_ID}.ensureRunning → needSetup: no execPath.`);
      return { runningWas: false, action: 'aborted:needSetup', needSetup: true, execPath: null, displayName: DISPLAY_NAME, lastError: 'No executable path configured; set KV `execPath` in app UI.' };
    }
    try {
      const r = await hostApi.processes.start({
        executablePath: cur.execPath,
        args: [],
        detached: true,
        timeoutMs: 30_000,
      });
      hostApi.logger.info(`${PLUGIN_ID}.ensureRunning → started detached`, { pid: r.pid, spawnedAtMs: r.spawnedAtMs, execPath: cur.execPath });
      return {
        runningWas: false,
        action: 'started',
        pid: r.pid,
        spawnedAtMs: r.spawnedAtMs,
        needSetup: false,
        execPath: cur.execPath,
        displayName: DISPLAY_NAME,
      };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      hostApi.logger.error(`${PLUGIN_ID}.ensureRunning → start failed`, { error: msg, execPath: cur.execPath });
      return {
        runningWas: false,
        action: 'failed',
        needSetup: true,
        execPath: cur.execPath,
        displayName: DISPLAY_NAME,
        lastError: msg,
      };
    }
  }

  return {
    async activate(ctx: any) {
      ctx.hostApi.logger.info(`${PLUGIN_ID} activated`, { displayName: DISPLAY_NAME });
      // Host plugin loader automatically binds manifest.extensionPoints to the
      // exported names below (onCheck, onEnsureRunning, onSetExecPath). Nothing
      // to do here.
    },
    async deactivate() {
      hostApi.logger.info(`${PLUGIN_ID} deactivated`, { displayName: DISPLAY_NAME });
    },

    /** Extension point: watchdog.check:traework → current status */
    onCheck: check,
    /** Extension point: watchdog.ensureRunning:traework → start if absent */
    onEnsureRunning: ensureRunning,
    /** Extension point: watchdog.setExecPath:traework → write our scoped KV.
     *  Pass empty string to CLEAR the override (revert to auto candidate list). */
    async onSetExecPath(payload: any) {
      const newPath = payload && typeof payload.path === 'string' ? payload.path.trim() : '';
      if (newPath === '') {
        try { await hostApi.kv.del(KV_EXEC_PATH_KEY); } catch (_) {}
        return { ok: true, path: null, cleared: true };
      }
      await hostApi.kv.set(KV_EXEC_PATH_KEY, newPath);
      hostApi.logger.info(`${PLUGIN_ID} onSetExecPath`, { path: newPath });
      return { ok: true, path: newPath };
    },

    check,
    ensureRunning,
  };
})();
