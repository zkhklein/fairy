/**
 * FMB shared domain types + Zod schemas.
 * Single source of truth used by:
 *   - Main process (DB types, plugin-system)
 *   - Renderer process (UI forms, tables, stores)
 *   - Plugin runtime (manifest validation, HostApi contracts)
 *   - HTTP API (request/response validation via Hono + ZodOpenAPI downstream)
 *   - IPC channel contracts
 *
 * Pattern: `export const XSchema = z.object({ ... })` with `z.infer<typeof XSchema>`
 * to derive the TS type automatically → guarantees type/schema never drift.
 */
import { z } from 'zod';

// ---------- Enums ----------
export const PluginType = z.enum(['atomic', 'app', 'extension']);
export type PluginType = z.infer<typeof PluginType>;

export const PluginStatus = z.enum(['installed', 'enabled', 'disabled']);
export type PluginStatus = z.infer<typeof PluginStatus>;

export const WorkflowTrigger = z.enum(['manual', 'schedule', 'api', 'cli', 'event']);
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

export const WorkflowRunStatus = z.enum(['pending', 'running', 'success', 'failed', 'cancelled']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowNodeType = z.enum(['atomic', 'condition', 'loop', 'subflow', 'delay']);
export type WorkflowNodeType = z.infer<typeof WorkflowNodeType>;

export const WorkflowNodeStatus = z.enum(['pending', 'running', 'success', 'failed', 'skipped']);
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatus>;

export const ScheduleMisfirePolicy = z.enum(['run_now', 'skip', 'last_missed']);
export type ScheduleMisfirePolicy = z.infer<typeof ScheduleMisfirePolicy>;

export const JobType = z.enum(['workflow_run', 'atomic_call', 'system']);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(['pending', 'running', 'completed', 'failed', 'dead']);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobRetryBackoff = z.enum(['fixed', 'exponential']);
export type JobRetryBackoff = z.infer<typeof JobRetryBackoff>;

export const ErrorLogLevel = z.enum(['error', 'warn', 'info']);
export type ErrorLogLevel = z.infer<typeof ErrorLogLevel>;

export const AuditSource = z.enum(['ui', 'cli', 'http', 'system', 'plugin']);
export type AuditSource = z.infer<typeof AuditSource>;

// ---------- Helpers ----------
const zJsonText = z
  .string()
  .default('{}')
  .describe('JSON serialised as TEXT column (SQLite storage)');
const zJsonArr = z.string().default('[]').describe('JSON array serialised as TEXT');
const zUnixMs = z.number().int().nonnegative().describe('Unix epoch milliseconds');
const zUnixMsNullable = zUnixMs.nullish();

// ---------- Plugin manifest schema (zip package.json style, used BEFORE install) ----------
export const PluginManifestSchema = z
  .object({
    id: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'must match kebab-case id'),
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    type: PluginType,
    description: z.string().max(2000).default(''),
    permissions: z.array(z.string()).default([]),
    dependencies: z.record(z.string(), z.string()).default({}),
    main: z.string().min(1),
    renderer: z.string().optional(),
    extensionPoints: z.array(z.string()).default([]),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ---------- Installed plugin (plugins table) ----------
export const PluginSchema = z.object({
  id: z.string().min(2),
  name: z.string().min(1),
  type: PluginType,
  description: z.string().default(''),
  current_version: z.string().min(1),
  status: PluginStatus.default('installed'),
  permissions_json: zJsonArr,
  dependencies_json: zJsonText,
  manifest_json: zJsonText,
  installed_at: zUnixMs,
  updated_at: zUnixMs,
});
export type Plugin = z.infer<typeof PluginSchema>;

export const PluginVersionSchema = z.object({
  id: z.number().int().positive().optional(),
  plugin_id: z.string().min(2),
  version: z.string().min(1),
  directory: z.string().min(1),
  installed_at: zUnixMs,
});
export type PluginVersion = z.infer<typeof PluginVersionSchema>;

// ---------- Workflows ----------
export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(256),
  description: z.string().default(''),
  definition_json: zJsonText,
  vars_json: zJsonText,
  created_at: zUnixMs,
  updated_at: zUnixMs,
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string().min(1),
  workflow_id: z.string().min(1),
  trigger: WorkflowTrigger,
  status: WorkflowRunStatus.default('pending'),
  input_json: zJsonText,
  output_json: z.string().nullable(),
  started_at: zUnixMsNullable,
  finished_at: zUnixMsNullable,
  created_at: zUnixMs,
  duration_ms: z.number().int().nonnegative().nullable(),
  error_stack: z.string().nullable(),
  trace_id: z.string().min(1),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const WorkflowNodeSchema = z.object({
  id: z.number().int().positive().optional(),
  run_id: z.string().min(1),
  node_id: z.string().min(1),
  node_type: WorkflowNodeType,
  status: WorkflowNodeStatus,
  attempts: z.number().int().nonnegative().default(0),
  input_json: z.string().nullable(),
  output_json: z.string().nullable(),
  error_stack: z.string().nullable(),
  started_at: zUnixMsNullable,
  finished_at: zUnixMsNullable,
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

// ---------- Schedules ----------
export const ScheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cron_expr: z.string().nullable(),
  one_shot_at: zUnixMsNullable,
  workflow_id: z.string().min(1),
  input_json: zJsonText,
  enabled: z.union([z.literal(0), z.literal(1)]).default(1),
  misfire_policy: ScheduleMisfirePolicy.default('skip'),
  timezone: z.string().min(1).default('UTC'),
  last_fired_at: zUnixMsNullable,
  next_fired_at: zUnixMsNullable,
  created_at: zUnixMs,
  updated_at: zUnixMs,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

// ---------- Job queue ----------
export const JobSchema = z.object({
  id: z.number().int().positive().optional(),
  type: JobType,
  payload_json: zJsonText,
  priority: z.number().int().min(0).max(9).default(0),
  status: JobStatus.default('pending'),
  attempts: z.number().int().nonnegative().default(0),
  max_attempts: z.number().int().positive().default(3),
  retry_backoff: JobRetryBackoff.default('exponential'),
  started_at: zUnixMsNullable,
  finished_at: zUnixMsNullable,
  last_error: z.string().nullable(),
  worker_id: z.string().nullable(),
  run_after: zUnixMs.default(0),
  trace_id: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

// ---------- Error / Audit / Secrets / KV / Bindings ----------
export const ErrorLogSchema = z.object({
  id: z.number().int().positive().optional(),
  level: ErrorLogLevel,
  source: z.string().min(1),
  message: z.string().min(1),
  stack: z.string().nullable(),
  metadata_json: z.string().nullable(),
  trace_id: z.string().nullable(),
  resolved: z.union([z.literal(0), z.literal(1)]).default(0),
  ignored: z.union([z.literal(0), z.literal(1)]).default(0),
  created_at: zUnixMs,
});
export type ErrorLog = z.infer<typeof ErrorLogSchema>;

export const AuditLogSchema = z.object({
  id: z.number().int().positive().optional(),
  action: z.string().min(1),
  actor: z.string().min(1).default('system'),
  source: AuditSource,
  payload_json: z.string().nullable(),
  trace_id: z.string().nullable(),
  created_at: zUnixMs,
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const ExtensionPointBindingSchema = z.object({
  id: z.number().int().positive().optional(),
  extension_point: z.string().min(1),
  plugin_id: z.string().min(2),
  handler_name: z.string().min(1),
  enabled: z.union([z.literal(0), z.literal(1)]).default(1),
  registered_at: zUnixMs,
});
export type ExtensionPointBinding = z.infer<typeof ExtensionPointBindingSchema>;

export const SecretSchema = z.object({
  id: z.number().int().positive().optional(),
  key: z.string().min(1).max(256),
  value_enc: z.string().min(1),
  description: z.string().nullable(),
  created_at: zUnixMs,
  updated_at: zUnixMs,
});
export type Secret = z.infer<typeof SecretSchema>;

export const KvStoreRowSchema = z.object({
  k: z.string().min(1),
  v: z.string(),
  updated_at: zUnixMs,
});
export type KvStoreRow = z.infer<typeof KvStoreRowSchema>;

// Track applied migrations
export const MigrationRecordSchema = z.object({
  name: z.string().min(1),
  applied_at: zUnixMs,
});
export type MigrationRecord = z.infer<typeof MigrationRecordSchema>;

// ---------- Pagination helpers ----------
export const PaginationQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function PagedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
}

// ---------- UI-safe view model (stripped TEXT JSON → real objects) ----------
// (Materialised at API boundary by host; plugins/renderers never deal with raw JSON columns)
export const PluginViewModelSchema = PluginSchema.extend({
  permissions: z.array(z.string()),
  dependencies: z.record(z.string(), z.string()),
  manifest: z.record(z.string(), z.unknown()),
});
export type PluginViewModel = z.infer<typeof PluginViewModelSchema>;

export const WorkflowViewModelSchema = WorkflowSchema.extend({
  definition: z.record(z.string(), z.unknown()),
  vars: z.record(z.string(), z.unknown()),
});
export type WorkflowViewModel = z.infer<typeof WorkflowViewModelSchema>;

export const RunViewModelSchema = WorkflowRunSchema.extend({
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
});
export type RunViewModel = z.infer<typeof RunViewModelSchema>;

export const JobViewModelSchema = JobSchema.extend({
  payload: z.record(z.string(), z.unknown()),
});
export type JobViewModel = z.infer<typeof JobViewModelSchema>;
