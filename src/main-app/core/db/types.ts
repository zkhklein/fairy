/**
 * FMB core DB row types (shared between Kysely, audits, and services).
 * NOTE: These types are intentionally duplicated in Task 2 so that Task 2's DB layer is
 * self-contained; Task 3 will replace them by exporting a single source of truth from
 * `src/shared/types/*` and aliasing here without breaking runtime.
 */
import type { Generated } from 'kysely';

export type PluginType = 'atomic' | 'app' | 'extension';
export type PluginStatus = 'installed' | 'enabled' | 'disabled';

export interface Plugin {
  id: string;
  name: string;
  type: PluginType;
  description: string;
  current_version: string;
  status: PluginStatus;
  permissions_json: string; // JSON string[]
  dependencies_json: string; // JSON Record<pluginId, semverRange>
  manifest_json: string; // raw manifest object
  installed_at: number;
  updated_at: number;
}

export interface PluginVersion {
  id: Generated<number>;
  plugin_id: string;
  version: string;
  directory: string;
  installed_at: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  definition_json: string;
  vars_json: string;
  created_at: number;
  updated_at: number;
}

export type TriggerType = 'manual' | 'schedule' | 'api' | 'cli' | 'event';
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  trigger: TriggerType;
  status: RunStatus;
  input_json: string;
  output_json: string | null;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error_stack: string | null;
  trace_id: string;
}

export type NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type NodeType = 'atomic' | 'condition' | 'loop' | 'subflow' | 'delay';

export interface WorkflowNode {
  id: Generated<number>;
  run_id: string;
  node_id: string;
  node_type: NodeType;
  status: NodeStatus;
  attempts: number;
  input_json: string | null;
  output_json: string | null;
  error_stack: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface Schedule {
  id: string;
  name: string;
  cron_expr: string | null;
  one_shot_at: number | null;
  workflow_id: string;
  input_json: string;
  enabled: number; // 0|1
  misfire_policy: 'run_now' | 'skip' | 'last_missed';
  timezone: string;
  last_fired_at: number | null;
  next_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

export type JobType = 'workflow_run' | 'atomic_call' | 'system';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead';
export type RetryBackoff = 'fixed' | 'exponential';

export interface JobQueue {
  id: Generated<number>;
  type: JobType;
  payload_json: string;
  priority: number; // 0..9
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  retry_backoff: RetryBackoff;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  worker_id: string | null;
  run_after: number;
  trace_id: string | null;
}

export type ErrorLevel = 'error' | 'warn' | 'info';

export interface ErrorLog {
  id: Generated<number>;
  level: ErrorLevel;
  source: string;
  message: string;
  stack: string | null;
  metadata_json: string | null;
  trace_id: string | null;
  resolved: number; // 0|1
  ignored: number; // 0|1
  created_at: number;
}

export type AuditSource = 'ui' | 'cli' | 'http' | 'system' | 'plugin';

export interface AuditLog {
  id: Generated<number>;
  action: string;
  actor: string;
  source: AuditSource;
  payload_json: string | null;
  trace_id: string | null;
  created_at: number;
}

export interface ExtensionPointBinding {
  id: Generated<number>;
  extension_point: string;
  plugin_id: string;
  handler_name: string;
  enabled: number; // 0|1
  registered_at: number;
}

export interface Secret {
  id: Generated<number>;
  key: string;
  value_enc: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface KvStoreRow {
  k: string;
  v: string;
  updated_at: number;
}
