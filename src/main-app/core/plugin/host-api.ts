/**
 * HostApi implementation exposed to plugins.
 * Implements the STATIC HostApi interface declared in src/shared/plugin-api.
 *
 * Signatures MUST match exactly:
 *   plugins: { self(): Promise<Manifest+status>; list(args?): Promise<Manifest[]+status+installedAt> }
 *   extensions: { register(point,handlerName): Promise<{id?}>; call(point,payload?): Promise<unknown[]> }
 *   ui: { registerMenuItem(args): Promise<{id:string}> }
 *   audit: { record(action, payload?, source?, actor?) -> {id:number} }
 *   secrets: { get/set/delete all Promises }
 *   kv: { get/set/delete all Promises }
 *   workflows: { start(), get() both Promises }
 *   schedules: { create(), toggle() Promises }
 *   jobs: { enqueue(), get(), cancel() Promises }
 *   processes: { query(): Promise<Record<name,bool>>; start(): Promise<{pid,...}> }
 *   eventBus: { on/once/emit sync returns }
 *   logger: { log/debug/info/warn/error sync }
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, basename } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  HostApi,
  PluginManifest,
  PluginActionContext,
} from '@shared/index';
import type { EventBusService } from '../event-bus';
import type { PluginService } from './loader';

export interface HostApiServices {
  eventBus: EventBusService;
  pluginService: PluginService;
  selfManifest?: PluginManifest;
  onAudit?: (args: { action: string; actor: string; source: string; payload?: unknown; traceId?: string }) => number;
  onError?: (args: { level: 'error' | 'warn' | 'info'; source: string; message: string; stack?: string; traceId?: string }) => void;
  onSecretGet?: (key: string) => any | null;
  onSecretSet?: (key: string, value: string, description?: string) => any;
  onSecretDelete?: (id: number) => boolean;
  onKvGet?: (key: string, global: boolean) => string | null;
  onKvSet?: (key: string, value: string, global: boolean) => boolean;
  onKvDelete?: (key: string, global: boolean) => boolean;
  /**
   * App-plugins can create workflows via Host.workflows.create(). This
   * callback delegates to WorkflowService.create() inside the host process.
   * Returns a Promise so the actual (synchronous better-sqlite3) DB
   * operation is deferred to the main process event loop via
   * process.nextTick — calling it synchronously inside a vm.Script sandbox
   * async continuation crashes the native module (V8 context mismatch,
   * 0xC0000005 access violation).
   */
  onCreateWorkflow?: (args: { id?: string; name: string; description?: string; definition: Record<string, unknown>; vars?: Record<string, unknown>; owner_plugin_id?: string | null; }) => Promise<Record<string, unknown>>;
  onStartWorkflow?: (workflowId: string, input?: Record<string, unknown>) => Promise<{ runId: string; status: string }>;
  onGetWorkflow?: (id: string) => Record<string, unknown> | null;
  /**
   * App-plugins can create schedules via Host.schedules.create(). The actual
   * scheduling is performed by SchedulerService (cron) so plugins can't
   * overload the event loop with per-plugin setInterval loops.
   * Returns a Promise — same process.nextTick deferral rationale as
   * onCreateWorkflow above (prevents native module crash from sandbox).
   */
  onCreateSchedule?: (args: { id?: string; name: string; cronExpr?: string; oneShotAtMs?: number; workflowId: string; input?: Record<string, unknown>; enabled?: boolean; owner_plugin_id: string; }) => Promise<Record<string, unknown>>;
  onToggleSchedule?: (id: string, enabled: boolean) => Promise<Record<string, unknown> | null>;
}

function notImplemented<T = never>(method: string): T {
  throw new Error(`HostApi.${method} not implemented yet (wired in later tasks)`);
}

export function buildHostApi(svc: HostApiServices): HostApi {
  const owner = svc.selfManifest?.id ?? 'system';

  // --- logger (sync) ---
  const logger: HostApi['logger'] = {
    log(level, message, data) {
      try { svc.eventBus.emit('logger.log' as any, { level, message, data, owner }); } catch {}
    },
    debug(message, data?) { this.log('debug', message, data); },
    info(message, data?) { this.log('info', message, data); },
    warn(message, data?) { this.log('warn', message, data); },
    error(message, data?) { this.log('error', message, data); },
  };

  // --- eventBus (sync) ---
  const eventBus: HostApi['eventBus'] = {
    on(event, handler) {
      const off = svc.eventBus.on(event as any, handler as any, { owner });
      return { off };
    },
    once(event, handler) {
      svc.eventBus.once(event as any, handler as any, { owner });
    },
    emit(event, payload) {
      const n = svc.eventBus.countListeners(event as any);
      svc.eventBus.safeEmit(event as any, payload, { source: `plugin:${owner}` }).catch(() => {});
      return { listenerCount: n };
    },
  };

  // --- audit (sync return {id}) ---
  const audit: HostApi['audit'] = {
    record(action, payload?, source?, actor?): { id: number } {
      const id = svc.onAudit?.({
        action,
        payload,
        source: (source as string) ?? 'plugin',
        actor: actor ?? owner,
      }) ?? -1;
      return { id: typeof id === 'number' ? id : -1 };
    },
  };

  // --- secrets (all Promises) ---
  const secrets: HostApi['secrets'] = {
    async get(key) {
      const r = svc.onSecretGet?.(key);
      return (r ?? null) as any;
    },
    async set(key, value, description) {
      return (svc.onSecretSet?.(key, value, description) ?? { id: 0, key, value, scope: 'plugin' }) as any;
    },
    async delete(id) {
      const ok = svc.onSecretDelete?.(id) ?? true;
      return { ok: ok as true };
    },
  };

  // --- kv (all Promises) ---
  const kv: HostApi['kv'] = {
    async get(key, global = false) {
      return svc.onKvGet?.(key, global) ?? null;
    },
    async set(key, value, global = false) {
      const ok = svc.onKvSet?.(key, value, global) ?? true;
      return { ok: ok as true };
    },
    async delete(key, global = false) {
      const ok = svc.onKvDelete?.(key, global) ?? true;
      return { ok: ok as true };
    },
  };

  // --- workflows ---
  const workflows: HostApi['workflows'] = {
    async create(args) {
      // Enforce owner_plugin_id workflow-source contract: only plugins of
      // type=app may create workflows, and owner always equals caller's own
      // pluginId (plugins can't spoof ownership to another app plugin).
      if (!svc.selfManifest) {
        throw new Error('Host.workflows.create requires plugin context (missing selfManifest)');
      }
      if (svc.selfManifest.type !== 'app') {
        throw new Error(
          `Host.workflows.create: plugin "${owner}" has type=${svc.selfManifest.type}; only type=app plugins can create workflows`,
        );
      }
      if (!svc.onCreateWorkflow) {
        throw new Error('Host.workflows.create: host did not wire onCreateWorkflow callback');
      }
      const created = await svc.onCreateWorkflow({
        id: args.id,
        name: args.name,
        description: args.description,
        definition: args.definition,
        vars: args.vars,
        owner_plugin_id: owner,
      });
      return created as unknown as ReturnType<HostApi['workflows']['create']>;
    },
    async start(workflowId, input) {
      if (!svc.onStartWorkflow) return notImplemented('workflows.start(' + workflowId + ')');
      return svc.onStartWorkflow(workflowId, input ?? {}) as ReturnType<HostApi['workflows']['start']>;
    },
    async get(id) {
      if (!svc.onGetWorkflow) return notImplemented('workflows.get(' + id + ')');
      const got = svc.onGetWorkflow(id);
      return got as unknown as ReturnType<HostApi['workflows']['get']>;
    },
  };
  // --- schedules ---
  const schedules: HostApi['schedules'] = {
    async create(args) {
      if (!svc.selfManifest) {
        throw new Error('Host.schedules.create requires plugin context (missing selfManifest)');
      }
      if (svc.selfManifest.type !== 'app') {
        throw new Error(
          `Host.schedules.create: plugin "${owner}" has type=${svc.selfManifest.type}; only type=app plugins can create schedules`,
        );
      }
      if (!svc.onCreateSchedule) {
        throw new Error('Host.schedules.create: host did not wire onCreateSchedule callback');
      }
      const created = await svc.onCreateSchedule({
        id: args.id,
        name: args.name,
        cronExpr: args.cron,
        oneShotAtMs: args.oneShotAtMs,
        workflowId: args.workflowId,
        input: args.input ?? {},
        enabled: args.enabled ?? true,
        owner_plugin_id: owner,
      });
      return created as unknown as ReturnType<HostApi['schedules']['create']>;
    },
    async toggle(id, enabled) {
      if (!svc.selfManifest) {
        throw new Error('Host.schedules.toggle requires plugin context');
      }
      if (!svc.onToggleSchedule) return notImplemented('schedules.toggle(' + id + ')');
      const r = await svc.onToggleSchedule(id, !!enabled);
      return r as unknown as ReturnType<HostApi['schedules']['toggle']>;
    },
  };
  // --- jobs ---
  const jobs: HostApi['jobs'] = {
    async enqueue(args) { return notImplemented('jobs.enqueue(' + args.type + ')'); },
    async get(id) { return notImplemented('jobs.get(' + id + ')'); },
    async cancel(id) { return notImplemented('jobs.cancel(' + id + ')'); },
  };

  // --- plugins ---
  const plugins: HostApi['plugins'] = {
    async self() {
      if (!svc.selfManifest) return notImplemented('plugins.self');
      const row = svc.pluginService.get(svc.selfManifest.id);
      return {
        ...svc.selfManifest,
        status: (row?.status ?? 'installed') as any,
      } as any;
    },
    async list(args?) {
      const result = svc.pluginService.list({
        type: args?.type as any,
        status: args?.status as any,
      }) as any;
      const rows = result.items ?? [];
      return rows.map((r: any) => {
        // For each row we need to return PluginManifest + status + installedAt.
        // Parse manifest_json stored against plugin OR fallback to best version's manifest
        let manifest: Record<string, any> | null = null;
        try { if (r.manifest_json) manifest = JSON.parse(r.manifest_json); } catch {}
        const installedAt: number = r.installed_at ?? Date.now();
        return {
          id: r.id,
          name: manifest?.name ?? r.name ?? '',
          version: r.current_version ?? manifest?.version ?? '0.0.0',
          type: manifest?.type ?? r.type ?? 'atomic',
          description: manifest?.description ?? r.description ?? '',
          permissions: manifest?.permissions ?? (r.permissions_json ? JSON.parse(r.permissions_json) : []),
          dependencies: manifest?.dependencies ?? (r.dependencies_json ? JSON.parse(r.dependencies_json) : {}),
          main: manifest?.main ?? 'index.js',
          renderer: manifest?.renderer ?? undefined,
          extensionPoints: manifest?.extensionPoints ?? [],
          status: (r.status ?? 'installed') as any,
          installedAt,
        } satisfies Record<string, any>;
      });
    },
    async invoke({ pluginId, method, payload }) {
      // Contract: HostPluginInvoke params already parsed by shared zod at
      // Proxy-level schema check. Additional runtime checks here for safety.
      if (!pluginId || typeof pluginId !== 'string') throw new Error('plugins.invoke: pluginId required');
      if (!method || typeof method !== 'string') throw new Error('plugins.invoke: method required');
      if (method === 'activate' || method === 'deactivate') {
        throw new Error(`plugins.invoke: refusing to call lifecycle method \`${method}\` on plugin ${pluginId}`);
      }
      if (pluginId === owner) {
        throw new Error('plugins.invoke: refusing to self-invoke. Use the local function directly.');
      }
      const row = svc.pluginService.get(pluginId);
      if (!row) throw new Error(`plugins.invoke: target plugin not installed (${pluginId})`);
      if ((row.status ?? 'installed') !== 'enabled') {
        throw new Error(`plugins.invoke: target plugin not enabled (${pluginId}). status=${row.status ?? 'installed'}`);
      }
      const inst = svc.pluginService.loadedInstance(pluginId);
      if (!inst) throw new Error(`plugins.invoke: no loaded instance for enabled plugin ${pluginId}. Internal loader bug.`);
      const exp: any = inst.sandbox?.module?.exports ?? null;
      if (!exp || typeof exp !== 'object') {
        throw new Error(`plugins.invoke: target ${pluginId} has no module.exports (not a sandboxed plugin?).`);
      }
      const fn: unknown = (exp as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        const available = Object.keys(exp).filter(k => typeof (exp as Record<string, unknown>)[k] === 'function').slice(0, 20);
        throw new Error(`plugins.invoke: target ${pluginId} exports has no callable method \`${method}\`. Available functions: ${available.join(', ')}`);
      }
      let result: any;
      try {
        result = await Promise.resolve(fn.call(undefined, payload));
      } catch (rawErr: any) {
        const msg = rawErr && rawErr.message ? String(rawErr.message) : String(rawErr);
        const stack = rawErr && rawErr.stack ? String(rawErr.stack) : undefined;
        try { svc.onError?.({ level: 'warn', source: `plugin:${owner}->${pluginId}.${method}`, message: `cross-plugin call failed: ${msg}`, stack, traceId: nanoid(12) }); } catch { /* swallow */ }
        const err: any = new Error(`plugins.invoke: ${pluginId}.${method} threw: ${msg}`);
        err.cause = rawErr;
        throw err;
      }
      return result;
    },
  };

  // --- extensions ---
  const extensions: HostApi['extensions'] = {
    async register(point, handlerName) {
      // Register: bind manifest-declared handler to extension point via eventBus.
      const exported: any = svc.pluginService.loadedInstance(owner)?.sandbox.module.exports ?? {};
      const handler = exported?.[handlerName];
      if (typeof handler !== 'function') {
        return { id: undefined };
      }
      svc.eventBus.on(point as any, handler as any, { owner, name: handlerName });
      return { id: undefined };
    },
    async call(point, payload) {
      // NOTE: Permission `extensions:call` is enforced at the sandbox Proxy
      // level (see PERMISSION_RULES in sandbox.ts). Individual hostApi methods
      // don't re-check permissions inline.
      // Use bus.callAndCollect so handler return values are actually surfaced
      // to the caller. Plugins rely on this for cross-plugin orchestration
      // (e.g. watchdog app calls atomic's onCheck → gets back {running, ...}).
      if (typeof (svc.eventBus as any).callAndCollect !== 'function') {
        // EventBus too old; safeEmit and return empty (shouldn't happen).
        await svc.eventBus.safeEmit(point as any, payload, { source: `plugin:${owner}:extensions.call` });
        return [];
      }
      const res = await (svc.eventBus as any).callAndCollect(point as any, payload, { source: `plugin:${owner}:extensions.call` });
      // For each returned value that isn't undefined → include in results.
      // Preserve order; filter out undefined handler returns so "no handlers"
      // ([]) is distinguishable from "handlers returned void" (all undefined → [])
      // but consumers do `if (results.length > 0) return results[0]` so OK.
      const results: unknown[] = Array.isArray(res?.values) ? res.values : [];
      return results;
    },
  };

  // --- ui ---
  const ui: HostApi['ui'] = {
    async registerMenuItem(args) {
      const id = `${owner}:menuitem:${args.path || args.label || Math.random().toString(36).slice(2, 7)}`;
      try {
        svc.eventBus.emit('ui.mainMenu.render' as any, {
          items: [{ id, path: args.path, label: args.label, icon: args.icon }],
        });
      } catch {}
      return { id };
    },
  };

  // --- system / processes (new for watcher plugins) ---
  const processes: HostApi['processes'] = {
    /**
     * Query whether each image name in the list is currently running.
     * Win-only: `tasklist /FO CSV /NH`; cross-platform fallback uses
     * `ps -eo comm=` on darwin/linux so the same call works for future
     * packaging targets.
     *
     * NEVER kills / disturbs processes — only reads. Exactly the "just check
     * don't disturb" contract our watchers rely on.
     */
    async query(args): Promise<Record<string, boolean>> {
      const names = args.processNames || [];
      const wanted = new Map<string, string>(); // key=normalized, value=original
      for (const n of names) {
        const k = basename(n).replace(/\.exe$/i, '').toLowerCase();
        if (k) wanted.set(k, n);
      }
      const result: Record<string, boolean> = {};
      for (const n of names) result[n] = false;
      if (wanted.size === 0) return result;
      try {
        const platform = process.platform;
        if (platform === 'win32') {
          // tasklist is ~20-60 ms, safe to execSync (infrequent poll from watcher).
          const out = execSync('tasklist /FO CSV /NH', {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          for (const row of out.split(/\r?\n/)) {
            if (!row) continue;
            const m = row.match(/^"([^"]+)"/);
            if (!m) continue;
            const norm = basename(m[1]).replace(/\.exe$/i, '').toLowerCase();
            if (wanted.has(norm)) {
              const original = wanted.get(norm)!;
              result[original] = true;
            }
          }
        } else {
          // macOS / linux (future)
          const out = execSync('ps -eo comm=', {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          for (const raw of out.split(/\r?\n/)) {
            const norm = basename(raw.trim()).replace(/\.exe$/i, '').toLowerCase();
            if (norm && wanted.has(norm)) {
              result[wanted.get(norm)!] = true;
            }
          }
        }
      } catch (e) {
        // Surface as warn but don't throw — the poll is best-effort; callers
        // should treat all-false as "unknown" and not blindly restart.
        try {
          logger.warn('processes.query tasklist/ps failed (returning all false)', {
            error: e instanceof Error ? e.message : String(e),
          });
        } catch {}
      }
      return result;
    },

    /**
     * Start an executable detached (default). ONLY starts if the file exists.
     * Does NOT disturb any running instance — spawn is additive. Exactly the
     * "don't disturb running software — only restart if actually exited"
     * contract. Callers should run `query` first and only call `start` if
     * the target returned false.
     */
    async start(args) {
      const { executablePath, args: cmdArgs = [], cwd, detached = true, timeoutMs = 30_000 } = args;
      if (!isAbsolute(executablePath)) {
        throw new Error(
          `processes.start: executablePath must be absolute (received: ${JSON.stringify(executablePath)})`,
        );
      }
      if (!existsSync(executablePath)) {
        throw new Error(`processes.start: executable not found at ${executablePath}`);
      }
      // Anti self-destruct: never allow starting our own electron.exe again
      // (prevents plugin mistakes from spawning FMB copies in a loop).
      const normTarget = basename(executablePath).toLowerCase();
      const normSelf = basename(process.execPath).toLowerCase();
      if (normTarget === normSelf && normTarget.endsWith('.exe')) {
        throw new Error(
          'processes.start: refusing to start the host executable itself (would fork-bomb)',
        );
      }
      const workDir = cwd && isAbsolute(cwd) ? cwd : dirname(executablePath);
      const spawnedAtMs = Date.now();
      const child = spawn(executablePath, cmdArgs, {
        detached,
        stdio: 'ignore',
        cwd: workDir,
        windowsHide: true,
        shell: false,
      });
      // Wait up to timeoutMs for a valid positive PID. spawn reports errors
      // asynchronously via 'error'; we translate into a throw so the plugin
      // can retry next poll instead of silently failing.
      return await new Promise<{ pid: number; spawnedAtMs: number; alreadyRunning: boolean }>(
        (resolve, reject) => {
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error(`processes.start: timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          child.once('error', (e) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e);
          });
          // spawn() sets child.pid synchronously on Windows for our
          // non-shell use; add a microtick delay so 'error' races are safe.
          queueMicrotask(() => {
            if (done) return;
            const pid = child.pid;
            if (!pid || pid <= 0) {
              done = true;
              clearTimeout(timer);
              reject(new Error('processes.start: spawn returned no PID'));
              return;
            }
            // Detached: unref so this long-running external program does NOT
            // keep FMB alive when the user closes the app.
            if (detached) {
              try { child.unref(); } catch {}
            }
            done = true;
            clearTimeout(timer);
            resolve({ pid, spawnedAtMs, alreadyRunning: false });
          });
        },
      );
    },
  };

  return {
    eventBus,
    logger,
    audit,
    secrets,
    kv,
    workflows,
    schedules,
    jobs,
    plugins,
    extensions,
    ui,
    processes,
  };
}

export const PLACEHOLDER_ACTION_CONTEXT: PluginActionContext = {
  traceId: 'unknown',
  get logger() { return notImplemented('ctx.logger placeholder'); },
  get secrets() { return notImplemented('ctx.secrets placeholder'); },
  get kv() { return notImplemented('ctx.kv placeholder'); },
};
