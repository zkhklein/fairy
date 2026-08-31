/**
 * Host-Plugin API boundary types + runtime param/result zod contracts.
 *
 * A plugin is loaded in an isolated vm context (T5). Its entry module receives a
 * `PluginContext` object which exposes `host: HostApi`. Every method on HostApi
 * carries:
 *   - `params: ZodType` → host runtime validates args before executing (errors
 *     converted to ProblemDetails, never throw raw JS into plugin code).
 *   - `result: ZodType` → host runtime also validates its own return values so
 *     plugins never receive undocumented fields (contract is enforced both ways).
 *
 * This design fulfills "接口可直接调用" (agents can rely on HostApi with
 * confidence because every contract is machine-readable and enforced).
 */
import { z } from 'zod';
import {
  AuditSource,
  ExtensionPointBindingSchema,
  JobSchema,
  JobStatus,
  JobType,
  PluginManifestSchema,
  PluginStatus,
  PluginType,
  SecretSchema,
  WorkflowRunStatus,
  WorkflowSchema,
} from '../types';

// ---------- Plugin lifecycle descriptors ----------
export const PluginLifecycleEventSchema = z.enum([
  'beforeEnable', 'afterEnable', 'beforeDisable', 'afterDisable', 'beforeUninstall', 'afterUninstall',
]);
export type PluginLifecycleEvent = z.infer<typeof PluginLifecycleEventSchema>;

export const PluginEntrySchema = z.object({
  /** Plugin's own id (matches manifest; host injects here so plugin can log) */
  pluginId: z.string().min(2),
  /** Host API surface the plugin may call. */
  host: z.custom<HostApi>((v) => typeof v === 'object' && v !== null),
  /** Disposable register helpers. */
  register: z.custom<PluginRegister>((v) => typeof v === 'object' && v !== null),
});
export type PluginEntryArgs = z.infer<typeof PluginEntrySchema>;

export type PluginMain = (args: PluginEntryArgs) => PluginLifecycleHandlers | Promise<PluginLifecycleHandlers>;

export interface PluginLifecycleHandlers {
  onEnable?(): void | Promise<void>;
  onDisable?(): void | Promise<void>;
  onUninstall?(): void | Promise<void>;
}

// ---------- Helper for typed method definitions (params + result zod) ----------
export interface HostMethod<P, R> {
  params: z.ZodType<P>;
  result: z.ZodType<R>;
}
function method<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(params: P, result: R): HostMethod<z.infer<P>, z.infer<R>> {
  return { params, result };
}

// ============ Event bus host methods ============
export const HostEventBusOn = method(
  z.object({ event: z.string().min(1), handler: z.function().args(z.unknown()).returns(z.any()) }),
  z.object({ off: z.function().returns(z.void()) }),
);
export const HostEventBusEmit = method(
  z.object({ event: z.string().min(1), payload: z.unknown() }),
  z.object({ listenerCount: z.number().int().nonnegative() }),
);
export const HostEventBusOnce = method(
  z.object({ event: z.string().min(1), handler: z.function().args(z.unknown()).returns(z.any()) }),
  z.void(),
);

// ============ Logger ============
export const HostLoggerLevels = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export const HostLoggerLog = method(
  z.object({ level: HostLoggerLevels.default('info'), message: z.string().min(1), data: z.record(z.string(), z.unknown()).optional() }),
  z.void(),
);

// ============ Audit ============
export const HostAuditRecord = method(
  z.object({
    action: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()).default({}),
    source: AuditSource.default('plugin'),
    actor: z.string().min(1).default('system'),
  }),
  z.object({ id: z.number().int().positive() }),
);

// ============ Secret store ============
export const HostSecretGet = method(z.object({ key: z.string().min(1) }), SecretSchema.nullable());
export const HostSecretSet = method(
  z.object({ key: z.string().min(1), value: z.string().min(1), description: z.string().optional() }),
  SecretSchema,
);
export const HostSecretDelete = method(z.object({ id: z.number().int().positive() }), z.object({ ok: z.literal(true) }));

// ============ KV store (plugin-scoped unless global:true + permission) ============
export const HostKvGet = method(z.object({ key: z.string().min(1), global: z.boolean().default(false) }), z.string().nullable());
export const HostKvSet = method(
  z.object({ key: z.string().min(1), value: z.string(), global: z.boolean().default(false) }),
  z.object({ ok: z.literal(true) }),
);
export const HostKvDelete = method(z.object({ key: z.string().min(1), global: z.boolean().default(false) }), z.object({ ok: z.literal(true) }));

// ============ Workflow engine ============
export const HostWorkflowStart = method(
  z.object({ workflowId: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ runId: z.string().min(1), status: WorkflowRunStatus }),
);
export const HostWorkflowGet = method(z.object({ id: z.string().min(1) }), WorkflowSchema.nullable());

// ============ Scheduler ============
export const HostScheduleCreate = method(
  z.object({
    name: z.string().min(1),
    cron: z.string().min(1).optional(),
    oneShotAtMs: z.number().int().nonnegative().optional(),
    workflowId: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ id: z.string().min(1) }),
);
export const HostScheduleToggle = method(
  z.object({ id: z.string().min(1), enabled: z.boolean() }),
  z.object({ ok: z.literal(true) }),
);

// ============ Job queue ============
export const HostJobEnqueue = method(
  z.object({
    type: JobType,
    payload: z.record(z.string(), z.unknown()),
    priority: z.number().int().min(0).max(9).default(0),
    runAfterMs: z.number().int().nonnegative().default(0),
  }),
  JobSchema.pick({ id: true, status: true }),
);
export const HostJobGet = method(z.object({ id: z.number().int().positive() }), JobSchema.nullable());
export const HostJobCancel = method(z.object({ id: z.number().int().positive() }), JobSchema.pick({ id: true, status: true }));

// ============ Plugin registry (discovery + self meta) ============
export const HostPluginSelf = method(z.object({}), PluginManifestSchema.extend({ status: PluginStatus }));
export const HostPluginList = method(
  z.object({ type: PluginType.optional(), status: PluginStatus.optional() }),
  z.array(PluginManifestSchema.extend({ status: PluginStatus, installedAt: z.number() })),
);

// ============ Extension points ============
export const HostRegisterExtension = method(
  z.object({ point: z.string().min(1), handlerName: z.string().min(1) }),
  ExtensionPointBindingSchema.pick({ id: true }),
);
export const HostCallExtension = method(
  z.object({ point: z.string().min(1), payload: z.unknown() }),
  z.array(z.unknown()),
);

// ============ UI contribution (renderer-only helpers: register routes, menu items) ============
export const HostUiRegisterMenuItem = method(
  z.object({ path: z.string().min(1), label: z.string().min(1), icon: z.string().optional() }),
  z.object({ id: z.string().min(1) }),
);

// ----- HostApi type + HostContracts runtime record -----
export interface HostApi {
  eventBus: {
    on(event: string, handler: (payload: unknown) => void): { off: () => void };
    once(event: string, handler: (payload: unknown) => void): void;
    emit(event: string, payload?: unknown): { listenerCount: number };
  };
  logger: {
    log(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string, data?: Record<string, unknown>): void;
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };
  audit: {
    record(action: string, payload?: Record<string, unknown>, source?: z.infer<typeof AuditSource>, actor?: string): { id: number };
  };
  secrets: {
    get(key: string): Promise<z.infer<typeof SecretSchema> | null>;
    set(key: string, value: string, description?: string): Promise<z.infer<typeof SecretSchema>>;
    delete(id: number): Promise<{ ok: true }>;
  };
  kv: {
    get(key: string, global?: boolean): Promise<string | null>;
    set(key: string, value: string, global?: boolean): Promise<{ ok: true }>;
    delete(key: string, global?: boolean): Promise<{ ok: true }>;
  };
  workflows: {
    start(workflowId: string, input?: Record<string, unknown>): Promise<{ runId: string; status: z.infer<typeof WorkflowRunStatus> }>;
    get(id: string): Promise<z.infer<typeof WorkflowSchema> | null>;
  };
  schedules: {
    create(args: { name: string; cron?: string; oneShotAtMs?: number; workflowId: string; input?: Record<string, unknown> }): Promise<{ id: string }>;
    toggle(id: string, enabled: boolean): Promise<{ ok: true }>;
  };
  jobs: {
    enqueue(args: { type: z.infer<typeof JobType>; payload: Record<string, unknown>; priority?: number; runAfterMs?: number }): Promise<{ id?: number; status: z.infer<typeof JobStatus> }>;
    get(id: number): Promise<z.infer<typeof JobSchema> | null>;
    cancel(id: number): Promise<{ id: number; status: z.infer<typeof JobStatus> }>;
  };
  plugins: {
    self(): Promise<z.infer<typeof PluginManifestSchema> & { status: z.infer<typeof PluginStatus> }>;
    list(args?: { type?: z.infer<typeof PluginType>; status?: z.infer<typeof PluginStatus> }): Promise<Array<z.infer<typeof PluginManifestSchema> & { status: z.infer<typeof PluginStatus>; installedAt: number }>>;
  };
  extensions: {
    register(point: string, handlerName: string): Promise<{ id?: number }>;
    call(point: string, payload?: unknown): Promise<unknown[]>;
  };
  ui: {
    registerMenuItem(args: { path: string; label: string; icon?: string }): Promise<{ id: string }>;
  };
}

/**
 * Runtime-available zod contracts: host validates calls against these at runtime
 * (in addition to the static TS types above).
 */
export const HostContracts = {
  eventBus: { on: HostEventBusOn, once: HostEventBusOnce, emit: HostEventBusEmit },
  logger: { log: HostLoggerLog },
  audit: { record: HostAuditRecord },
  secrets: { get: HostSecretGet, set: HostSecretSet, delete: HostSecretDelete },
  kv: { get: HostKvGet, set: HostKvSet, delete: HostKvDelete },
  workflows: { start: HostWorkflowStart, get: HostWorkflowGet },
  schedules: { create: HostScheduleCreate, toggle: HostScheduleToggle },
  jobs: { enqueue: HostJobEnqueue, get: HostJobGet, cancel: HostJobCancel },
  plugins: { self: HostPluginSelf, list: HostPluginList },
  extensions: { register: HostRegisterExtension, call: HostCallExtension },
  ui: { registerMenuItem: HostUiRegisterMenuItem },
} as const;

/** Plugin registration helpers (passed into entry point). */
export interface PluginRegister {
  /** Declare an atomic action that can be used as workflow nodes. */
  atomicAction<In extends Record<string, unknown>, Out>(args: {
    name: string;
    description?: string;
    inputSchema?: z.ZodType<In>;
    outputSchema?: z.ZodType<Out>;
    permissions?: string[];
    handler: (input: In, ctx: PluginActionContext) => Promise<Out> | Out;
  }): void;
  /** Declare a UI contribution sub-page (only works for app-type plugins). */
  appPage(args: { route: string; title: string; component?: unknown }): void;
}

export interface PluginActionContext {
  traceId: string;
  logger: HostApi['logger'];
  secrets: HostApi['secrets'];
  kv: HostApi['kv'];
}
