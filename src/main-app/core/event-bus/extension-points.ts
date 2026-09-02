/**
 * Built-in extension points.
 *
 * FMB exposes a set of "well-known" event names that plugins and core modules
 * can hook into. Events are emitted through the EventBus with a typed payload
 * per point so handlers can rely on structure without runtime inspections.
 *
 * Rules for adding new events:
 *   - Use `<domain>.<past-tense-verb | beforeX | afterX>` naming.
 *   - Always prefer a typed payload over `any`; unknown data goes in `meta?: Record`.
 *   - Keep the list append-only (never rename / remove existing events).
 */
import type { z } from 'zod';
import type {
  AuditLog,
  ErrorLog,
  Job,
  Plugin,
  PluginVersion,
  WorkflowRun,
  WorkflowNode,
  Schedule,
} from '@shared/index';

// ---------- Core event names ----------
export const EXTENSION_POINTS = [
  'app.onReady',
  'app.beforeQuit',
  'plugin.beforeInstall',
  'plugin.afterInstall',
  'plugin.beforeUninstall',
  'plugin.afterUninstall',
  'plugin.statusChanged',
  'workflow.beforeExecute',
  'workflow.afterExecute',
  'workflow.nodeComplete',
  'workflow.nodeError',
  'schedule.triggered',
  'queue.jobEnqueued',
  'queue.jobCompleted',
  'queue.jobFailed',
  'errorLog.newEntry',
  'audit.newEntry',
  'ui.mainMenu.render',
  'ui.mainDashboard.card',
  'settings.changed',
  'http.api.beforeRequest',
  'http.api.afterResponse',
] as const;

export type ExtensionPointName = (typeof EXTENSION_POINTS)[number];

// ---------- Payload per extension point (discriminated via name) ----------
export type ExtensionEventMap = {
  'app.onReady': {
    bootTraceId: string;
    appVersion: string;
    dbPath: string;
  };
  'app.beforeQuit': {
    exitCode: number;
  };
  'plugin.beforeInstall': {
    manifest: unknown; // unvalidated yet (handlers can reject via throw)
    sourceZip: string;
  };
  'plugin.afterInstall': {
    plugin: Plugin;
    pluginVersion: PluginVersion;
  };
  'plugin.beforeUninstall': {
    pluginId: string;
    currentStatus: string;
  };
  'plugin.afterUninstall': {
    pluginId: string;
  };
  'plugin.statusChanged': {
    pluginId: string;
    from: string;
    to: string;
    /** Optional machine-readable cause, e.g. 'missing-on-disk' during rescan. */
    reason?: string;
  };
  'workflow.beforeExecute': {
    runId: string;
    workflowId: string;
    input: Record<string, unknown>;
    traceId: string;
  };
  'workflow.afterExecute': {
    runId: string;
    workflowId: string;
    status: WorkflowRun['status'];
    durationMs?: number;
    traceId: string;
  };
  'workflow.nodeComplete': {
    runId: string;
    node: WorkflowNode;
    traceId: string;
  };
  'workflow.nodeError': {
    runId: string;
    node: WorkflowNode;
    error: Error;
    traceId: string;
  };
  'schedule.triggered': {
    schedule: Schedule;
    fireTimeMs: number;
    traceId: string;
  };
  'queue.jobEnqueued': {
    job: Job;
    traceId?: string;
  };
  'queue.jobCompleted': {
    job: Job;
    durationMs?: number;
    traceId?: string;
  };
  'queue.jobFailed': {
    job: Job;
    error: Error;
    traceId?: string;
  };
  'errorLog.newEntry': {
    log: ErrorLog;
  };
  'audit.newEntry': {
    log: AuditLog;
  };
  'ui.mainMenu.render': {
    items: Array<{ id: string; label: string; path?: string; icon?: string }>;
  };
  'ui.mainDashboard.card': {
    cards: Array<{ id: string; title: string; body?: unknown }>;
  };
  'settings.changed': {
    key: string;
    before: unknown;
    after: unknown;
  };
  'http.api.beforeRequest': {
    method: string;
    path: string;
    requestId: string;
  };
  'http.api.afterResponse': {
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    requestId: string;
  };
};

/**
 * Type-safe discriminator: extract the type of payload that goes with `event`.
 * Usage: `type P = ExtensionPayload<'workflow.nodeError'>`
 */
export type ExtensionPayload<E extends ExtensionPointName = ExtensionPointName> =
  ExtensionEventMap[E];

/** Zod schemas are NOT strictly enforced on emit: these events flow between
 *  core modules / trusted plugins. Consumers that want to validate payloads
 *  (e.g. HTTP API proxies) should use the shared domain schemas directly.
 */
export const _dummyZodReference: z.ZodTypeAny | null = null;
