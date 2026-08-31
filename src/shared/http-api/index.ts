/**
 * HTTP API contract skeleton (REST-style + RPC-style actions).
 *
 * Used later by `hono` server (T16) to mount routes. Contracts here are
 * intentionally framework-agnostic: each route carries zod schemas for path
 * params, query, body and result. Middleware is expected to:
 *   1. Parse + validate req (path/query/body) against respective schemas.
 *   2. Invoke handler, validate return value against result schema.
 *   3. Serialize errors into ProblemDetails (RFC 9457).
 *
 * All routes live under `/api/v1/`. Prefix is omitted from individual `path`
 * entries below so the same list can be reused by v2/v3 routers.
 */
import { z } from 'zod';
import {
  AuditLogSchema,
  AuditSource,
  ErrorLogLevel,
  JobSchema,
  JobStatus,
  JobType,
  PagedSchema,
  PaginationQuerySchema,
  PluginManifestSchema,
  PluginSchema,
  PluginStatus,
  PluginType,
  PluginViewModelSchema,
  RunViewModelSchema,
  ScheduleSchema,
  WorkflowRunStatus,
  WorkflowSchema,
  WorkflowViewModelSchema,
} from '../types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRoute<P = any, Q = any, B = any, R = any> {
  readonly method: HttpMethod;
  /** Path template, starting with `/` (relative to `/api/v1/`). Use `:id` style placeholders for path params. */
  readonly path: string;
  readonly pathParams?: z.ZodType<P>;
  readonly query?: z.ZodType<Q>;
  readonly body?: z.ZodType<B>;
  readonly result: z.ZodType<R>;
  readonly auth?: boolean;
  readonly description?: string;
  readonly tags?: string[];
}

function route<P, Q, B, R>(r: HttpRoute<P, Q, B, R>): HttpRoute<P, Q, B, R> {
  return r;
}

// ---------- Plugins ----------
export const http_plugin_list = route({
  method: 'GET', path: '/plugins', tags: ['plugins'],
  query: PaginationQuerySchema.extend({ status: PluginStatus.optional(), type: PluginType.optional(), q: z.string().max(64).optional() }),
  result: PagedSchema(PluginSchema),
  description: 'Paginate installed plugins.',
});

export const http_plugin_get = route({
  method: 'GET', path: '/plugins/:id', tags: ['plugins'],
  pathParams: z.object({ id: z.string().min(2) }),
  result: PluginViewModelSchema,
});

export const http_plugin_install = route({
  method: 'POST', path: '/plugins/install', tags: ['plugins'], auth: true,
  body: z.object({ zipPath: z.string().min(1) }),
  result: PluginSchema,
  description: 'Install a plugin zip from filesystem path or uploaded URI.',
});

export const http_plugin_validateManifest = route({
  method: 'POST', path: '/plugins/validate-manifest', tags: ['plugins'],
  body: z.record(z.string(), z.unknown()),
  result: z.object({ ok: z.boolean(), manifest: PluginManifestSchema.optional(), errors: z.array(z.any()) }),
});

export const http_plugin_setStatus = route({
  method: 'PATCH', path: '/plugins/:id/status', tags: ['plugins'], auth: true,
  pathParams: z.object({ id: z.string().min(2) }),
  body: z.object({ status: PluginStatus }),
  result: PluginSchema,
});

export const http_plugin_delete = route({
  method: 'DELETE', path: '/plugins/:id', tags: ['plugins'], auth: true,
  pathParams: z.object({ id: z.string().min(2) }),
  result: z.object({ ok: z.literal(true) }),
});

// ---------- Workflows ----------
export const http_workflow_list = route({
  method: 'GET', path: '/workflows', tags: ['workflows'],
  query: PaginationQuerySchema.extend({ q: z.string().max(64).optional() }),
  result: PagedSchema(WorkflowSchema),
});
export const http_workflow_get = route({
  method: 'GET', path: '/workflows/:id', tags: ['workflows'],
  pathParams: z.object({ id: z.string().min(1) }),
  result: WorkflowViewModelSchema,
});
export const http_workflow_create = route({
  method: 'POST', path: '/workflows', tags: ['workflows'], auth: true,
  body: WorkflowSchema.omit({ id: true, created_at: true, updated_at: true }).partial({ definition_json: true, vars_json: true }),
  result: WorkflowSchema,
});
export const http_workflow_update = route({
  method: 'PUT', path: '/workflows/:id', tags: ['workflows'], auth: true,
  pathParams: z.object({ id: z.string().min(1) }),
  body: WorkflowSchema.partial(),
  result: WorkflowSchema,
});
export const http_workflow_delete = route({
  method: 'DELETE', path: '/workflows/:id', tags: ['workflows'], auth: true,
  pathParams: z.object({ id: z.string().min(1) }),
  result: z.object({ ok: z.literal(true) }),
});

export const http_workflow_runStart = route({
  method: 'POST', path: '/workflows/:id/runs', tags: ['workflows'], auth: true,
  pathParams: z.object({ id: z.string().min(1) }),
  body: z.object({ input: z.record(z.string(), z.unknown()).default({}) }),
  result: RunViewModelSchema,
  description: 'Trigger a workflow run manually or via API.',
});
export const http_workflow_runList = route({
  method: 'GET', path: '/workflow-runs', tags: ['workflows'],
  query: PaginationQuerySchema.extend({ workflowId: z.string().min(1).optional(), status: WorkflowRunStatus.optional() }),
  result: PagedSchema(RunViewModelSchema),
});
export const http_workflow_runCancel = route({
  method: 'POST', path: '/workflow-runs/:runId/cancel', tags: ['workflows'], auth: true,
  pathParams: z.object({ runId: z.string().min(1) }),
  result: RunViewModelSchema,
});

// ---------- Schedules ----------
export const http_schedule_list = route({
  method: 'GET', path: '/schedules', tags: ['schedules'],
  query: PaginationQuerySchema.extend({ enabled: z.union([z.literal(0), z.literal(1)]).optional() }),
  result: PagedSchema(ScheduleSchema),
});
export const http_schedule_create = route({
  method: 'POST', path: '/schedules', tags: ['schedules'], auth: true,
  body: ScheduleSchema.omit({ id: true, created_at: true, updated_at: true, last_fired_at: true, next_fired_at: true }),
  result: ScheduleSchema,
});
export const http_schedule_toggle = route({
  method: 'PATCH', path: '/schedules/:id/enabled', tags: ['schedules'], auth: true,
  pathParams: z.object({ id: z.string().min(1) }),
  body: z.object({ enabled: z.union([z.literal(0), z.literal(1)]) }),
  result: ScheduleSchema,
});
export const http_schedule_delete = route({
  method: 'DELETE', path: '/schedules/:id', tags: ['schedules'], auth: true,
  pathParams: z.object({ id: z.string().min(1) }),
  result: z.object({ ok: z.literal(true) }),
});

// ---------- Jobs ----------
export const http_job_list = route({
  method: 'GET', path: '/jobs', tags: ['jobs'],
  query: PaginationQuerySchema.extend({ type: JobType.optional(), status: JobStatus.optional() }),
  result: PagedSchema(JobSchema),
});
export const http_job_cancel = route({
  method: 'POST', path: '/jobs/:id/cancel', tags: ['jobs'], auth: true,
  pathParams: z.object({ id: z.coerce.number().int().positive() }),
  result: JobSchema,
});
export const http_job_retry = route({
  method: 'POST', path: '/jobs/:id/retry', tags: ['jobs'], auth: true,
  pathParams: z.object({ id: z.coerce.number().int().positive() }),
  result: JobSchema,
});

// ---------- Error calendar + audit ----------
export const http_errorLog_list = route({
  method: 'GET', path: '/error-logs', tags: ['errors'],
  query: PaginationQuerySchema.extend({
    level: ErrorLogLevel.optional(),
    resolved: z.union([z.literal(0), z.literal(1)]).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
  }),
  result: PagedSchema(AuditLogSchema),
});
export const http_errorLog_resolve = route({
  method: 'PATCH', path: '/error-logs/:id/resolved', tags: ['errors'], auth: true,
  pathParams: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({ resolved: z.boolean() }),
  result: AuditLogSchema,
});
export const http_auditLog_list = route({
  method: 'GET', path: '/audit-logs', tags: ['audit'],
  query: PaginationQuerySchema.extend({ action: z.string().max(64).optional(), source: AuditSource.optional() }),
  result: PagedSchema(AuditLogSchema),
});

// ---------- System ----------
export const http_system_health = route({
  method: 'GET', path: '/system/health', tags: ['system'],
  result: z.object({
    ok: z.literal(true),
    dbOk: z.boolean(),
    eventBusListeners: z.number().int().nonnegative(),
    pendingJobs: z.number().int().nonnegative(),
    activeRuns: z.number().int().nonnegative(),
    enabledPlugins: z.number().int().nonnegative(),
    version: z.string(),
  }),
  description: 'Public healthcheck endpoint (no auth).',
});

export const http_system_info = route({
  method: 'GET', path: '/system/info', tags: ['system'], auth: true,
  result: z.object({
    version: z.string(),
    platform: z.enum(['win32', 'darwin', 'linux']),
    arch: z.enum(['x64', 'arm64', 'ia32']),
    nodeVersion: z.string(),
    electronVersion: z.string().optional(),
    dbPath: z.string(),
    logsDir: z.string(),
    pluginsDir: z.string(),
    uptimeMs: z.number().nonnegative(),
  }),
});

/** All routes array — hono/middleware iterate this in T16 to mount endpoints. */
export const HTTP_ROUTES: readonly HttpRoute[] = [
  http_plugin_list, http_plugin_get, http_plugin_install, http_plugin_validateManifest,
  http_plugin_setStatus, http_plugin_delete,
  http_workflow_list, http_workflow_get, http_workflow_create, http_workflow_update,
  http_workflow_delete, http_workflow_runStart, http_workflow_runList, http_workflow_runCancel,
  http_schedule_list, http_schedule_create, http_schedule_toggle, http_schedule_delete,
  http_job_list, http_job_cancel, http_job_retry,
  http_errorLog_list, http_errorLog_resolve,
  http_auditLog_list,
  http_system_health, http_system_info,
] as const;

/** Tags used by OpenAPI generator (future) to group endpoints. */
export const HTTP_TAG_DESCRIPTIONS: Record<string, string> = {
  plugins: 'Plugin installation / versioning / status control',
  workflows: 'Workflow definition CRUD + run execution + run history',
  schedules: 'Cron / one-shot schedules bound to workflows',
  jobs: 'Persistent job queue (dequeue, retry, cancel, dead-letter)',
  errors: 'Error calendar + resolution workflow',
  audit: 'Audit log querying (append-only via events)',
  system: 'Platform health, version, directories',
};
