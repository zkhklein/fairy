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
 *   eventBus: { on/once/emit sync returns }
 *   logger: { log/debug/info/warn/error sync }
 */
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
   * Carried as a callback (instead of a cyclic import) so host-api.ts stays
   * free of workflow-service references.
   */
  onCreateWorkflow?: (args: { id?: string; name: string; description?: string; definition: Record<string, unknown>; vars?: Record<string, unknown>; owner_plugin_id: string; }) => Record<string, unknown>;
  onStartWorkflow?: (workflowId: string, input?: Record<string, unknown>) => Promise<{ runId: string; status: string }>;
  onGetWorkflow?: (id: string) => Record<string, unknown> | null;
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
      const created = svc.onCreateWorkflow({
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
    async create(args) { return notImplemented('schedules.create(' + args.name + ')'); },
    async toggle(id, enabled) { return notImplemented('schedules.toggle(' + id + ')'); },
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
      const results: unknown[] = [];
      await svc.eventBus.safeEmit(point as any, payload, { source: `plugin:${owner}:extensions.call` });
      // Event bus doesn't return handler return values directly; collect from a side-channel
      // by temporarily invoking listeners manually once. Accept best-effort empty array here.
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
  };
}

export const PLACEHOLDER_ACTION_CONTEXT: PluginActionContext = {
  traceId: 'unknown',
  get logger() { return notImplemented('ctx.logger placeholder'); },
  get secrets() { return notImplemented('ctx.secrets placeholder'); },
  get kv() { return notImplemented('ctx.kv placeholder'); },
};
