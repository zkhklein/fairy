/**
 * atomic com.fmb.watcher.chatgpt
 *
 * Atomic actions:
 *   - check(payload?)     -> { running, execPath, needSetup, displayName }
 *   - ensureRunning(?)    -> { runningWas, action, pid?, needSetup, lastError? }
 *
 * CONTRACT: NEVER KILL a running ChatGPT. If it's alive, this action returns
 * `action:'noop'`. start() is always detached+unref so FMB can exit without
 * dragging ChatGPT down.
 */
/* global hostApi, __hostEnv */
module.exports = (function factory() {
  const PROCESS_NAME_CANDIDATES = ['ChatGPT.exe', 'ChatGPTDesktop.exe'];
  const KV_EXEC_PATH_KEY = 'execPath';
  const GLOBAL_KV_EXEC_KEY = 'global:execPath:com.fmb.watcher.chatgpt';

  function candidatePaths(env: any) {
    const list: string[] = [];
    const push = (p: string | null) => { if (p && !list.includes(p)) list.push(p); };
    push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\chatgpt\\ChatGPT.exe` : null);
    push(env.PROGRAMFILES ? `${env.PROGRAMFILES}\\chatgpt\\ChatGPT.exe` : null);
    push(env['PROGRAMFILES(X86)'] ? `${env['PROGRAMFILES(X86)']}\\chatgpt\\ChatGPT.exe` : null);
    push(env.PROGRAMW6432 ? `${env.PROGRAMW6432}\\chatgpt\\ChatGPT.exe` : null);
    // 旧 OpenAI 路径
    push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\OpenAI\\ChatGPT\\ChatGPT.exe` : null);
    return list;
  }
  const DISPLAY_NAME = 'ChatGPT';
  const PLUGIN_ID = 'com.fmb.watcher.chatgpt';

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
    const override = await hostApi.kv.get(KV_EXEC_PATH_KEY);
    if (override) return override;
    const globalOverride = await hostApi.kv.get(GLOBAL_KV_EXEC_KEY, true);
    if (globalOverride) return globalOverride;
    const env = await _readEnv();
    const cands = candidatePaths(env);
    return cands[0] || null;
  }

  async function check(_payload: any) {
    const q = await hostApi.processes.query({ processNames: PROCESS_NAME_CANDIDATES });
    const running = PROCESS_NAME_CANDIDATES.some(n => q[n] === true);
    const execPath = await _resolveExecPath();
    hostApi.logger.info(`${PLUGIN_ID}.check`, { running, execPath });
    return { running, execPath, needSetup: !execPath, displayName: DISPLAY_NAME };
  }

  async function ensureRunning(_payload: any) {
    const cur = await check();
    if (cur.running) {
      hostApi.logger.info(`${PLUGIN_ID}.ensureRunning → noop (already running). Do NOT disturb.`);
      return { runningWas: true, action: 'noop', needSetup: cur.needSetup, execPath: cur.execPath, displayName: DISPLAY_NAME };
    }
    if (!cur.execPath) {
      hostApi.logger.warn(`${PLUGIN_ID}.ensureRunning → needSetup: no execPath`);
      return { runningWas: false, action: 'aborted:needSetup', needSetup: true, execPath: null, displayName: DISPLAY_NAME, lastError: 'No executable path configured.' };
    }
    try {
      const r = await hostApi.processes.start({
        executablePath: cur.execPath,
        args: [],
        detached: true,
        timeoutMs: 30_000,
      });
      hostApi.logger.info(`${PLUGIN_ID}.ensureRunning → started detached`, { pid: r.pid });
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
      hostApi.logger.error(`${PLUGIN_ID}.ensureRunning → start failed`, { error: msg });
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
    },
    async deactivate() {
      hostApi.logger.info(`${PLUGIN_ID} deactivated`, {});
    },

    /** Extension point bindings */
    onCheck: check,
    onEnsureRunning: ensureRunning,
    async onSetExecPath(payload: any) {
      const path = payload && typeof payload.path === 'string' ? payload.path.trim() : '';
      if (!path) return { ok: false, reason: 'empty path' };
      await hostApi.kv.set(KV_EXEC_PATH_KEY, path);
      hostApi.logger.info(`${PLUGIN_ID} onSetExecPath`, { path });
      return { ok: true, path };
    },

    check,
    ensureRunning,
  };
})();
