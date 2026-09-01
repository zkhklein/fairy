/**
 * IPC channel contract registry.
 *
 * Each channel is a plain object `{ channel, params, result }` where params/result
 * are Zod schemas. Three uses:
 *   1. Main process `ipcMain.handle(channel, (e, rawParams) => result.parse(PARSED_RESULT))`
 *      — validates caller params with safeParse before entering business logic.
 *   2. Renderer `window.fmb.ipc.invoke<Ch, Params, R>(channel, params)`
 *      — preload script validates params against `params` schema before sending.
 *   3. CLI / HTTP API reuse the same schemas (single source of truth).
 *
 * Naming convention: `<process>:<domain>.<action>` — process = `main` (main-owned),
 *   `renderer` (renderer-initiated, unusual). Actions: list | get | create | update |
 *   delete | enable | disable | start | pause | resume | cancel.
 */
import { z } from 'zod';
import {
  AuditLogSchema,
  ErrorLogSchema,
  JobSchema,
  JobStatus,
  JobType,
  PagedSchema,
  PaginationQuerySchema,
  PluginManifestSchema,
  PluginSchema,
  PluginStatus,
  PluginType,
  PluginVersionSchema,
  PluginViewModelSchema,
  RunViewModelSchema,
  ScheduleSchema,
  WorkflowRunStatus,
  WorkflowSchema,
  WorkflowViewModelSchema,
} from '../types';

export interface IpcChannel<P, R> {
  readonly channel: string;
  readonly params: z.ZodType<P>;
  readonly result: z.ZodType<R>;
  readonly description?: string;
}

function make<P, R>(c: IpcChannel<P, R>): IpcChannel<P, R> {
  return c;
}

// ---------- Plugins ----------
export const main_plugin_list = make({
  channel: 'main:plugin.list',
  params: PaginationQuerySchema.extend({
    status: PluginStatus.optional(),
    type: PluginType.optional(),
    q: z.string().max(64).optional(),
  }),
  result: PagedSchema(PluginSchema),
  description: 'Paginate installed plugins (filterable by status/type/search).',
});

export const main_plugin_get = make({
  channel: 'main:plugin.get',
  params: z.object({ id: z.string().min(2) }),
  result: PluginViewModelSchema.nullable(),
});

export const main_plugin_install = make({
  channel: 'main:plugin.install',
  params: z.object({ zipPath: z.string().min(1) }),
  result: PluginSchema.extend({ manifest: z.record(z.string(), z.unknown()) }),
  description: 'Install a plugin zip by filesystem path (manifest validated first).',
});

export const main_plugin_setStatus = make({
  channel: 'main:plugin.setStatus',
  params: z.object({ id: z.string().min(2), status: PluginStatus }),
  result: PluginSchema,
});

export const main_plugin_uninstall = make({
  channel: 'main:plugin.uninstall',
  params: z.object({ id: z.string().min(2) }),
  result: z.object({ ok: z.literal(true) }),
});

export const main_plugin_validateManifest = make({
  channel: 'main:plugin.validateManifest',
  params: z.record(z.string(), z.unknown()),
  result: z.object({ ok: z.boolean(), manifest: PluginManifestSchema.optional(), errors: z.array(z.any()).default([]) }),
  description: 'Dry-run manifest validation used by the upload UI.',
});

// ---------- Workflows ----------
export const main_workflow_list = make({
  channel: 'main:workflow.list',
  params: PaginationQuerySchema.extend({ q: z.string().max(64).optional() }),
  // The crud service now joins owner plugin metadata + scans definition for
  // referenced plugin ids / node counts → use the enriched view model.
  result: PagedSchema(WorkflowViewModelSchema),
});

export const main_workflow_get = make({
  channel: 'main:workflow.get',
  params: z.object({ id: z.string().min(1) }),
  result: WorkflowViewModelSchema.nullable(),
});

export const main_workflow_create = make({
  channel: 'main:workflow.create',
  params: WorkflowSchema.omit({ id: true, created_at: true, updated_at: true, definition_json: true, vars_json: true }).partial({ description: true }).extend({
    id: z.string().min(1).optional(),
    definition_json: z.string().min(1).optional(),       // raw JSON string option
    definition: z.record(z.string(), z.unknown()).optional(), // parsed object option
    vars_json: z.string().min(1).optional(),             // raw JSON string option
    vars: z.record(z.string(), z.unknown()).optional(),  // parsed object option
  }),
  result: WorkflowSchema,
});

export const main_workflow_update = make({
  channel: 'main:workflow.update',
  params: WorkflowSchema.pick({ id: true }).extend({
    name: z.string().min(1).max(256).optional(),
    description: z.string().optional(),
    definition_json: z.string().min(1).optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
    vars_json: z.string().min(1).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  }),
  result: WorkflowSchema,
});

export const main_workflow_delete = make({
  channel: 'main:workflow.delete',
  params: z.object({ id: z.string().min(1) }),
  result: z.object({ ok: z.literal(true) }),
});

export const main_workflow_runStart = make({
  channel: 'main:workflow.runStart',
  params: z.object({ id: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }),
  result: RunViewModelSchema,
});

export const main_workflow_runCancel = make({
  channel: 'main:workflow.runCancel',
  params: z.object({ runId: z.string().min(1) }),
  result: RunViewModelSchema,
});

export const main_workflow_runList = make({
  channel: 'main:workflow.runList',
  params: PaginationQuerySchema.extend({
    workflowId: z.string().min(1).optional(),
    status: WorkflowRunStatus.optional(),
  }),
  result: PagedSchema(RunViewModelSchema),
});

// ---------- Schedules ----------
export const main_schedule_list = make({
  channel: 'main:schedule.list',
  params: PaginationQuerySchema.extend({ enabled: z.union([z.literal(0), z.literal(1)]).optional() }),
  result: PagedSchema(ScheduleSchema),
});
export const main_schedule_create = make({
  channel: 'main:schedule.create',
  params: ScheduleSchema.omit({ id: true, created_at: true, updated_at: true, last_fired_at: true, next_fired_at: true, cron_expr: true, one_shot_at: true, workflow_id: true, input_json: true, misfire_policy: true }).extend({
    // snake_case names (aligned to schema column)
    cron_expr: ScheduleSchema.shape.cron_expr.optional(),
    one_shot_at: ScheduleSchema.shape.one_shot_at.optional(),
    workflow_id: ScheduleSchema.shape.workflow_id.optional(),
    input_json: ScheduleSchema.shape.input_json.optional(),
    misfire_policy: ScheduleSchema.shape.misfire_policy.optional(),
    // camelCase aliases (UI friendly; translated in the IPC handler)
    cronExpr: z.string().min(1).nullable().optional(),
    oneShotAtMs: z.number().int().nonnegative().nullable().optional(),
    workflowId: z.string().min(1).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    misfirePolicy: ScheduleSchema.shape.misfire_policy.optional(),
    enabled: z.union([z.literal(0), z.literal(1)]).default(1),
    timezone: ScheduleSchema.shape.timezone,
    name: z.string().min(1),
  }),
  result: ScheduleSchema,
});
export const main_schedule_toggle = make({
  channel: 'main:schedule.toggle',
  params: z.object({ id: z.string().min(1), enabled: z.union([z.literal(0), z.literal(1)]) }),
  result: ScheduleSchema,
});
export const main_schedule_delete = make({
  channel: 'main:schedule.delete',
  params: z.object({ id: z.string().min(1) }),
  result: z.object({ ok: z.literal(true) }),
});

// ---------- Job queue ----------
export const main_job_list = make({
  channel: 'main:job.list',
  params: PaginationQuerySchema.extend({
    type: JobType.optional(),
    status: JobStatus.optional(),
  }),
  result: PagedSchema(JobSchema),
});
export const main_job_cancel = make({
  channel: 'main:job.cancel',
  params: z.object({ id: z.number().int().positive() }),
  result: JobSchema,
});
export const main_job_retry = make({
  channel: 'main:job.retry',
  params: z.object({ id: z.number().int().positive() }),
  result: JobSchema,
});

// ---------- Error calendar + audit ----------
export const main_errorLog_list = make({
  channel: 'main:errorLog.list',
  params: PaginationQuerySchema.extend({
    level: ErrorLogSchema.shape.level.optional(),
    severity: ErrorLogSchema.shape.level.optional(),   // UI-friendly alias for `level`
    resolved: z.union([z.literal(0), z.literal(1)]).optional(),
    from: z.number().int().nonnegative().optional(),   // created_at >= from (ms epoch)
    to: z.number().int().nonnegative().optional(),     // created_at <= to (ms epoch)
    startTs: z.number().int().nonnegative().optional(),// alias for `from`
    endTs: z.number().int().nonnegative().optional(),  // alias for `to`
    source: ErrorLogSchema.shape.source.optional(),
    keyword: z.string().max(120).optional(),           // fuzzy on message + stack
  }),
  result: PagedSchema(ErrorLogSchema),
});
export const main_errorLog_resolve = make({
  channel: 'main:errorLog.resolve',
  params: z.object({ id: z.number().int().positive(), resolved: z.boolean() }),
  result: ErrorLogSchema,
});
export const main_auditLog_list = make({
  channel: 'main:auditLog.list',
  params: PaginationQuerySchema.extend({
    action: z.string().max(64).optional(),
    source: AuditLogSchema.shape.source.optional(),
  }),
  result: PagedSchema(AuditLogSchema),
});

// ---------- System ----------
export const main_system_info = make({
  channel: 'main:system.info',
  params: z.object({}).strict(),
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

export const main_system_health = make({
  channel: 'main:system.health',
  params: z.object({}).strict(),
  result: z.object({
    dbOk: z.boolean(),
    eventBusListeners: z.number().int().nonnegative(),
    pendingJobs: z.number().int().nonnegative(),
    activeRuns: z.number().int().nonnegative(),
    enabledPlugins: z.number().int().nonnegative(),
  }),
});

// ---------- Settings (T11 Settings page) ----------
const LogLevelSchema = z.enum(['fatal','error','warn','info','debug','trace','silent']);
const SettingsSchema = z.object({
  'queue.concurrency': z.number().int().min(1).max(256),
  'http.port': z.number().int().min(1024).max(65535),
  'http.token': z.string(),
  'log.level': LogLevelSchema,
  'system.autoStart': z.union([z.literal(0), z.literal(1)]),
  'system.closeBehavior': z.enum(['tray', 'quit']),
  'ui.compact': z.union([z.literal(0), z.literal(1)]),
  'ui.collapsed': z.union([z.literal(0), z.literal(1)]),
});
export const main_system_getSettings = make({
  channel: 'main:system.getSettings',
  params: z.object({}).strict().default({}),
  result: SettingsSchema,
});
export const main_system_setSettings = make({
  channel: 'main:system.setSettings',
  params: SettingsSchema.partial(),
  result: SettingsSchema,
});

// ---------- Queue concurrency (T11 queue monitoring page header slider) ----------
export const main_queue_setConcurrency = make({
  channel: 'main:queue.setConcurrency',
  params: z.object({ concurrency: z.number().int().min(1).max(256) }),
  result: z.object({ ok: z.literal(true), concurrency: z.number().int().min(1) }),
});

// ---------- Extension point list (T11 ExtensionPoints page: ≥12 items) ----------
const EpBindingSchema = z.object({ plugin_id: z.string(), handler_name: z.string(), enabled: z.union([z.literal(0), z.literal(1)]) });
export const main_ep_list = make({
  channel: 'main:ep.list',
  params: PaginationQuerySchema.extend({
    withBindings: z.boolean().optional().default(true),
  }),
  result: z.object({
    items: z.array(z.object({
      name: z.string(),
      description: z.string().max(240),
      listenerCount: z.number().int().nonnegative(),
      bindings: z.array(EpBindingSchema),
      builtin: z.boolean(),
    })),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  }),
});

// ---------- Plugin versions list / switch (T11 plugins page: 版本切换 Modal) ----------
export const main_plugin_listVersions = make({
  channel: 'main:plugin.listVersions',
  params: z.object({ id: z.string().min(1) }),
  result: z.object({ items: z.array(PluginVersionSchema) }),
});
export const main_plugin_switchVersion = make({
  channel: 'main:plugin.switchVersion',
  params: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  result: PluginSchema,
});

// ---------- Workflow export JSON (T11 workflows 页 "导出" 操作) ----------
export const main_workflow_exportJson = make({
  channel: 'main:workflow.exportJson',
  params: z.object({ id: z.string().min(1), includeRuns: z.number().int().min(0).max(500).optional().default(20) }),
  result: z.object({
    fileName: z.string().regex(/^[\w\-\. ]+\.json$/),
    contents: z.string(),
  }),
});

// ---------- Plugin renderer bundle + callAction (T12-B/C) ----------
export const main_plugin_getRenderer = make({
  channel: 'main:plugin.getRenderer',
  params: z.object({ pluginId: z.string().min(1) }),
  result: z.object({
    code: z.union([z.string(), z.null()]),
    version: z.union([z.string(), z.null()]),
    error: z.string().optional(),
  }),
  description: 'Fetch the compiled UMD renderer bundle for an app-type plugin (for Shadow DOM injection).',
});
export const main_plugin_callAction = make({
  channel: 'main:plugin.callAction',
  params: z.object({
    pluginId: z.string().min(1),
    action: z.string().min(1).max(128),
    payload: z.unknown().optional(),
  }),
  result: z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  description: 'Invoke a named action on the plugin main module exports (bridge renderer → sandbox).',
});

/** Full registry record: array for iteration + typed per-channel named exports above. */
export const IPC_REGISTRY: readonly IpcChannel<unknown, unknown>[] = [
  main_plugin_list, main_plugin_get, main_plugin_install, main_plugin_setStatus,
  main_plugin_uninstall, main_plugin_validateManifest, main_plugin_listVersions, main_plugin_switchVersion,
  main_workflow_list, main_workflow_get, main_workflow_create, main_workflow_update,
  main_workflow_delete, main_workflow_runStart, main_workflow_runCancel, main_workflow_runList, main_workflow_exportJson,
  main_schedule_list, main_schedule_create, main_schedule_toggle, main_schedule_delete,
  main_job_list, main_job_cancel, main_job_retry, main_queue_setConcurrency,
  main_errorLog_list, main_errorLog_resolve,
  main_auditLog_list,
  main_system_info, main_system_health, main_system_getSettings, main_system_setSettings,
  main_ep_list,
  main_plugin_getRenderer, main_plugin_callAction,
] as const;

/**
 * Flat channel name dictionary. The preload script uses this (string refs) to
 * call `ipcRenderer.invoke`.
 */
export const IPC_CHANNELS = {
  main_plugin_list: main_plugin_list.channel,
  main_plugin_get: main_plugin_get.channel,
  main_plugin_install: main_plugin_install.channel,
  main_plugin_setStatus: main_plugin_setStatus.channel,
  main_plugin_uninstall: main_plugin_uninstall.channel,
  main_plugin_validateManifest: main_plugin_validateManifest.channel,
  main_workflow_list: main_workflow_list.channel,
  main_workflow_get: main_workflow_get.channel,
  main_workflow_create: main_workflow_create.channel,
  main_workflow_update: main_workflow_update.channel,
  main_workflow_delete: main_workflow_delete.channel,
  main_workflow_runStart: main_workflow_runStart.channel,
  main_workflow_runCancel: main_workflow_runCancel.channel,
  main_workflow_runList: main_workflow_runList.channel,
  main_schedule_list: main_schedule_list.channel,
  main_schedule_create: main_schedule_create.channel,
  main_schedule_toggle: main_schedule_toggle.channel,
  main_schedule_delete: main_schedule_delete.channel,
  main_job_list: main_job_list.channel,
  main_job_cancel: main_job_cancel.channel,
  main_job_retry: main_job_retry.channel,
  main_errorLog_list: main_errorLog_list.channel,
  main_errorLog_resolve: main_errorLog_resolve.channel,
  main_auditLog_list: main_auditLog_list.channel,
  main_system_info: main_system_info.channel,
  main_system_health: main_system_health.channel,
  main_system_getSettings: main_system_getSettings.channel,
  main_system_setSettings: main_system_setSettings.channel,
  main_queue_setConcurrency: main_queue_setConcurrency.channel,
  main_ep_list: main_ep_list.channel,
  main_plugin_listVersions: main_plugin_listVersions.channel,
  main_plugin_switchVersion: main_plugin_switchVersion.channel,
  main_workflow_exportJson: main_workflow_exportJson.channel,
  main_plugin_getRenderer: main_plugin_getRenderer.channel,
  main_plugin_callAction: main_plugin_callAction.channel,
} as const;

// ---------- Convenient type aliases used by preload + renderer typed client ----------
export type MainPluginListParams = z.infer<typeof main_plugin_list.params>;
export type MainPluginListResult = z.infer<typeof main_plugin_list.result>;
export type MainPluginGetParams = z.infer<typeof main_plugin_get.params>;
export type MainPluginGetResult = z.infer<typeof main_plugin_get.result>;
export type MainPluginInstallParams = z.infer<typeof main_plugin_install.params>;
export type MainPluginInstallResult = z.infer<typeof main_plugin_install.result>;
export type MainPluginSetStatusParams = z.infer<typeof main_plugin_setStatus.params>;
export type MainPluginSetStatusResult = z.infer<typeof main_plugin_setStatus.result>;
export type MainPluginUninstallParams = z.infer<typeof main_plugin_uninstall.params>;
export type MainPluginUninstallResult = z.infer<typeof main_plugin_uninstall.result>;
export type MainPluginValidateManifestParams = z.infer<typeof main_plugin_validateManifest.params>;
export type MainPluginValidateManifestResult = z.infer<typeof main_plugin_validateManifest.result>;

export type MainWorkflowListParams = z.infer<typeof main_workflow_list.params>;
export type MainWorkflowListResult = z.infer<typeof main_workflow_list.result>;
export type MainWorkflowGetParams = z.infer<typeof main_workflow_get.params>;
export type MainWorkflowGetResult = z.infer<typeof main_workflow_get.result>;
export type MainWorkflowCreateParams = z.infer<typeof main_workflow_create.params>;
export type MainWorkflowCreateResult = z.infer<typeof main_workflow_create.result>;
export type MainWorkflowUpdateParams = z.infer<typeof main_workflow_update.params>;
export type MainWorkflowUpdateResult = z.infer<typeof main_workflow_update.result>;
export type MainWorkflowDeleteParams = z.infer<typeof main_workflow_delete.params>;
export type MainWorkflowDeleteResult = z.infer<typeof main_workflow_delete.result>;
export type MainWorkflowRunStartParams = z.infer<typeof main_workflow_runStart.params>;
export type MainWorkflowRunStartResult = z.infer<typeof main_workflow_runStart.result>;
export type MainWorkflowRunCancelParams = z.infer<typeof main_workflow_runCancel.params>;
export type MainWorkflowRunCancelResult = z.infer<typeof main_workflow_runCancel.result>;
export type MainWorkflowRunListParams = z.infer<typeof main_workflow_runList.params>;
export type MainWorkflowRunListResult = z.infer<typeof main_workflow_runList.result>;

export type MainScheduleListParams = z.infer<typeof main_schedule_list.params>;
export type MainScheduleListResult = z.infer<typeof main_schedule_list.result>;
export type MainScheduleCreateParams = z.infer<typeof main_schedule_create.params>;
export type MainScheduleCreateResult = z.infer<typeof main_schedule_create.result>;
export type MainScheduleToggleParams = z.infer<typeof main_schedule_toggle.params>;
export type MainScheduleToggleResult = z.infer<typeof main_schedule_toggle.result>;
export type MainScheduleDeleteParams = z.infer<typeof main_schedule_delete.params>;
export type MainScheduleDeleteResult = z.infer<typeof main_schedule_delete.result>;

export type MainJobListParams = z.infer<typeof main_job_list.params>;
export type MainJobListResult = z.infer<typeof main_job_list.result>;
export type MainJobCancelParams = z.infer<typeof main_job_cancel.params>;
export type MainJobCancelResult = z.infer<typeof main_job_cancel.result>;
export type MainJobRetryParams = z.infer<typeof main_job_retry.params>;
export type MainJobRetryResult = z.infer<typeof main_job_retry.result>;

export type MainErrorLogListParams = z.infer<typeof main_errorLog_list.params>;
export type MainErrorLogListResult = z.infer<typeof main_errorLog_list.result>;
export type MainErrorLogResolveParams = z.infer<typeof main_errorLog_resolve.params>;
export type MainErrorLogResolveResult = z.infer<typeof main_errorLog_resolve.result>;

export type MainAuditLogListParams = z.infer<typeof main_auditLog_list.params>;
export type MainAuditLogListResult = z.infer<typeof main_auditLog_list.result>;

export type MainSystemInfoParams = z.infer<typeof main_system_info.params>;
export type MainSystemInfoResult = z.infer<typeof main_system_info.result>;
export type MainSystemHealthParams = z.infer<typeof main_system_health.params>;
export type MainSystemHealthResult = z.infer<typeof main_system_health.result>;
export type MainSystemGetSettingsParams = z.infer<typeof main_system_getSettings.params>;
export type MainSystemGetSettingsResult = z.infer<typeof main_system_getSettings.result>;
export type MainSystemSetSettingsParams = z.infer<typeof main_system_setSettings.params>;
export type MainSystemSetSettingsResult = z.infer<typeof main_system_setSettings.result>;
export type MainQueueSetConcurrencyParams = z.infer<typeof main_queue_setConcurrency.params>;
export type MainQueueSetConcurrencyResult = z.infer<typeof main_queue_setConcurrency.result>;
export type MainEpListParams = z.infer<typeof main_ep_list.params>;
export type MainEpListResult = z.infer<typeof main_ep_list.result>;
export type MainPluginListVersionsParams = z.infer<typeof main_plugin_listVersions.params>;
export type MainPluginListVersionsResult = z.infer<typeof main_plugin_listVersions.result>;
export type MainPluginSwitchVersionParams = z.infer<typeof main_plugin_switchVersion.params>;
export type MainPluginSwitchVersionResult = z.infer<typeof main_plugin_switchVersion.result>;
export type MainWorkflowExportJsonParams = z.infer<typeof main_workflow_exportJson.params>;
export type MainWorkflowExportJsonResult = z.infer<typeof main_workflow_exportJson.result>;
export type MainPluginGetRendererParams = z.infer<typeof main_plugin_getRenderer.params>;
export type MainPluginGetRendererResult = z.infer<typeof main_plugin_getRenderer.result>;
export type MainPluginCallActionParams = z.infer<typeof main_plugin_callAction.params>;
export type MainPluginCallActionResult = z.infer<typeof main_plugin_callAction.result>;
