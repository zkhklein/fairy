/**
 * Main-process IPC handlers.
 *
 * Each handler in `registerIpcHandlers()` matches one channel from
 * `@shared/ipc`. On every call we:
 *   1. Parse `rawParams` against the channel's Zod params schema (renderer trust boundary).
 *   2. Delegate to the matching service method.
 *   3. Validate the result against the channel's Zod result schema.
 *   4. Return a safe JSON value.
 *
 * Callers must have already initialised:
 *   - `initDatabase()`
 *   - `initEventBus()`
 *   - `initPluginService()`
 *   - `WorkflowService` / `SchedulerService` / `QueueService` / `ErrorCalendarService`
 *
 * This file is intentionally lightweight: it wires channels to services,
 * keeping each handler < ~10 LOC to keep bug surface tiny.
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { app } from 'electron';
import os from 'node:os';
import {
  IPC_REGISTRY,
  main_plugin_list, main_plugin_get, main_plugin_install, main_plugin_setStatus,
  main_plugin_uninstall, main_plugin_validateManifest, main_plugin_listVersions, main_plugin_switchVersion,
  main_plugin_preInstallCheck, main_plugin_installBatch, main_plugin_listScheduleTemplates,
  main_workflow_list, main_workflow_get, main_workflow_create, main_workflow_update,
  main_workflow_delete, main_workflow_runStart, main_workflow_runCancel, main_workflow_runList, main_workflow_exportJson,
  main_schedule_list, main_schedule_create, main_schedule_toggle, main_schedule_delete,
  main_job_list, main_job_cancel, main_job_retry, main_queue_setConcurrency,
  main_errorLog_list, main_errorLog_resolve,
  main_auditLog_list,
  main_system_info, main_system_health, main_system_getSettings, main_system_setSettings,
  main_ep_list,
  main_plugin_getRenderer, main_plugin_callAction,
  main_dialog_showOpen,
  type IpcChannel,
  type MainPluginListScheduleTemplatesResult,
} from '@shared/ipc';
import type { z } from 'zod';
import { nanoid } from 'nanoid';
import { getPluginService } from '../plugin/loader';
import { parseManifestText } from '../plugin/manifest';
import { WorkflowService } from '../workflow/crud';
import { SchedulerService } from '../scheduler/service';
import { QueueService } from '../queue/service';
import { ErrorCalendarService } from '../error-calendar/service';
import { getEventBus } from '../event-bus';
import { getRawDb } from '../db';
import { createLogger, setGlobalLogLevel } from '../logger';
import { getSettingsService } from '../settings/service';
import { EXTENSION_POINTS } from '../event-bus/extension-points';
import type { PluginManifest } from '@shared/types';

const log = createLogger('ipc');

interface IpcRegistry {
  services: {
    workflow: WorkflowService;
    scheduler: SchedulerService;
    queue: QueueService;
    errorCalendar: ErrorCalendarService;
  };
  bootTs: number;
  logsDir: string;
  pluginsDir: string;
  epDescriptions?: Partial<Record<string, string>>;
  // Main BrowserWindow reference (needed for modal dialog parent binding so
  // the dialog doesn't surface behind the window on Windows). Pass undefined
  // in tests; the dialog call uses null as parent in that case.
  mainWindow?: BrowserWindow | null;
}

/**
 * Register every channel in `IPC_REGISTRY`.
 * Returns a dispose function for tests (production keeps them up for life).
 */
export function registerIpcHandlers(ctx: IpcRegistry): () => void {
  const pluginSvc = getPluginService();
  const bus = getEventBus();
  const db = getRawDb();
  const { workflow, scheduler, queue, errorCalendar } = ctx.services;

  function wire<P, R>(ch: IpcChannel<P, R>, handler: (params: P) => unknown): void {
    ipcMain.handle(ch.channel, async (_event, rawParams: unknown) => {
      try {
        const parsed = (ch.params as z.ZodType<P>).safeParse(rawParams);
        if (!parsed.success) {
          log.warn({ channel: ch.channel, issues: parsed.error.issues }, 'ipc invalid params');
          throw Object.assign(new Error('Invalid IPC params: ' + parsed.error.message), {
            code: 'IPC_INVALID_PARAMS',
            issues: parsed.error.issues,
          });
        }
        const result = await handler(parsed.data);
        const validated = (ch.result as z.ZodType<R>).safeParse(result);
        if (!validated.success) {
          log.error(
            { channel: ch.channel, issues: validated.error.issues, rawResult: JSON.stringify(result).slice(0, 400) },
            'ipc result schema violation',
          );
          throw Object.assign(new Error('Invalid IPC result'), { code: 'IPC_INVALID_RESULT', issues: validated.error.issues });
        }
        return validated.data;
      } catch (err) {
        const e = err as Error & { code?: unknown; issues?: unknown };
        log.error({ channel: ch.channel, code: e.code ?? null, msg: e.message }, 'ipc handler error');
        // Return a plain serialisable error shape.
        throw {
          message: e.message || 'Unknown IPC error',
          code: typeof e.code === 'string' ? e.code : 'IPC_ERROR',
          issues: e.issues ?? null,
        };
      }
    });
  }

  // ---- Plugins ----
  /**
   * Serialize a plugin Result.error (a ProblemDetails object) into an Error
   * whose `message` is fully human-readable + `issues` array contains the
   * structured path-errors. IPC handlers' catch() block then converts this
   * to plain {message,code,issues} so the renderer sees real context instead
   * of the opaque "[object Object]" default toString().
   */
  function pluginError(err: any, code: string): Error & { code: string; issues: unknown } {
    const title: string = err?.title ?? `${code} failed`;
    const status: number | undefined = err?.status ? Number(err.status) : undefined;
    const detail: string | undefined = err?.detail ? String(err.detail) : undefined;
    const rawErrors: Array<{ path?: (string | number)[]; message?: string; code?: string }> =
      Array.isArray(err?.errors) ? (err.errors as any[]) : [];
    const issues = rawErrors.map(e => ({
      path: Array.isArray(e.path) ? e.path.map(String) : undefined,
      message: e.message ? String(e.message) : undefined,
      code: e.code ? String(e.code) : undefined,
    }));
    const parts: string[] = [title];
    if (status != null) parts.push(`[HTTP ${status}]`);
    if (detail) parts.push(detail);
    if (issues.length) {
      parts.push(
        issues
          .map(issue => {
            const loc = issue.path?.length ? ` (${issue.path.join('/')})` : '';
            const c = issue.code ? `[${issue.code}]` : '';
            return `•${c}${loc} ${issue.message ?? ''}`.trim();
          })
          .join('; '),
      );
    }
    const msg = parts.join(' — ');
    const e = new Error(msg) as Error & { code: string; issues: unknown };
    e.code = code;
    e.issues = issues.length ? issues : null;
    // log.warn so operators can backtrack failures without UI details.
    log.warn({ code, status: status ?? null, title, detail, issues }, 'plugin op failed');
    return e;
  }
  wire(main_plugin_list, (p) => pluginSvc.list(p));
  wire(main_plugin_get, (p) => {
    const raw = pluginSvc.get(p.id);
    if (!raw) return null;
    return {
      ...raw,
      permissions: raw.permissions_json ? JSON.parse(raw.permissions_json) : [],
      dependencies: raw.dependencies_json ? JSON.parse(raw.dependencies_json) : {},
      manifest: raw.manifest_json ? JSON.parse(raw.manifest_json) : {},
      versions: pluginSvc.listVersions(p.id),
    };
  });
  wire(main_plugin_install, async (p) => {
    const r = await pluginSvc.installFromZip(p.zipPath);
    if (!r.ok) throw pluginError(r.error, 'INSTALL_FAILED');
    return pluginSvc.get((r as { pluginId: string }).pluginId);
  });
  wire(main_plugin_setStatus, async (p) => {
    if (p.status === 'enabled') {
      const r = await pluginSvc.enablePlugin(p.id);
      if (!r.ok) throw pluginError(r.error, 'ENABLE_FAILED');
    } else if (p.status === 'disabled') {
      const r = await pluginSvc.disablePlugin(p.id);
      if (!r.ok) throw pluginError(r.error, 'DISABLE_FAILED');
    }
    return pluginSvc.get(p.id);
  });
  wire(main_plugin_uninstall, async (p) => {
    const r = await pluginSvc.uninstallPlugin(p.id);
    if (!r.ok) throw pluginError(r.error, 'UNINSTALL_FAILED');
    return { ok: true as const };
  });
  wire(main_plugin_validateManifest, (p) => {
    const text = typeof (p as { manifestText?: string }).manifestText === 'string'
      ? (p as { manifestText: string }).manifestText
      : JSON.stringify(p);
    const r = parseManifestText(text);
    return {
      ok: r.ok,
      manifest: r.ok ? r.manifest : undefined,
      errors: r.ok ? [] : (r.error?.errors ?? []),
    };
  });
  wire(main_plugin_listVersions, (p) => ({ items: pluginSvc.listVersions(p.id) }));
  wire(main_plugin_switchVersion, async (p) => {
    const r = await pluginSvc.switchVersion(p.id, p.version);
    if (!r.ok) throw pluginError(r.error, 'SWITCH_VERSION_FAILED');
    return pluginSvc.get(p.id);
  });
  // Dry-run per-zip install preview
  wire(main_plugin_preInstallCheck, async (p) => {
    const r = await pluginSvc.preInstallCheckFromZip(p.zipPath);
    return {
      ok: r.ok,
      zipPath: p.zipPath,
      manifest: r.manifest,
      versionStatus: r.versionStatus,
      installedVersion: r.installedVersion,
      depCheck: r.depCheck,
      errors: r.errors,
    };
  });
  // Batch install + optional auto-enable. Results returned per zip,
  // individual failures never abort the remaining batch.
  wire(main_plugin_installBatch, async (p) => pluginSvc.installBatch({ zipPaths: p.zipPaths, autoEnable: !!p.autoEnable }));
  // Enabled app plugins that declare at least one scheduleTemplate.
  wire(main_plugin_listScheduleTemplates, () => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.status, pv.manifest_json
        FROM plugins p
        JOIN plugin_versions pv ON pv.plugin_id = p.id
                                 AND pv.version = p.current_version
       WHERE p.type = 'app' AND p.status = 'enabled'
    `).all() as Array<{ id: string; name: string; status: string; manifest_json: string }>;
    const items: MainPluginListScheduleTemplatesResult['items'] = [];
    for (const r of rows) {
      let manifest: PluginManifest | null = null;
      try { manifest = JSON.parse(r.manifest_json) as PluginManifest; } catch { continue; }
      if (!manifest?.scheduleTemplates || manifest.scheduleTemplates.length === 0) continue;
      items.push({ pluginId: r.id, pluginName: r.name, templates: manifest.scheduleTemplates });
    }
    return { items };
  });

  // Native OS open-file dialog. Binding the BrowserWindow as parent avoids
  // Windows opening the picker as a background/taskbar-flashing-only window.
  wire(main_dialog_showOpen, async (p) => {
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [];
    if (p.openFile) properties.push('openFile');
    if (p.openDirectory) properties.push('openDirectory');
    if (p.multiSelections) properties.push('multiSelections');
    if (properties.length === 0) properties.push('openFile');
    const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined;
    const result = await dialog.showOpenDialog(win as any, {
      title: p.title,
      defaultPath: p.defaultPath,
      buttonLabel: p.buttonLabel,
      filters: p.filters as Array<{ name: string; extensions: string[] }>,
      properties,
    });
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  // T12-B/C: plugin renderer bundle + callAction
  wire(main_plugin_getRenderer, (p) => {
    const r = pluginSvc.getRendererCode(p.pluginId);
    return { code: r.code, version: r.version };
  });
  wire(main_plugin_callAction, async (p) => {
    return pluginSvc.callAction(p.pluginId, p.action, p.payload);
  });

  // ---- Workflows ----
  wire(main_workflow_list, (p) => workflow.list(p));
  wire(main_workflow_get, (p) => workflow.getViewModel(p.id));
  wire(main_workflow_create, () => {
    // UI/CLI direct creation is disallowed after the owner-ownership contract
    // (v3): workflows must be created exclusively from an app plugin's HostAPI
    // so `owner_plugin_id` can be trusted to match the plugin's own identity.
    // The channel is intentionally kept alive so older renderers don't throw
    // `no handler registered`, but it always returns a 403-shaped error.
    const err: Error & { code?: string; status?: number } = new Error(
      '创建工作流仅允许从 app 插件 HostAPI 发起（工作流归应用插件所有）。请从对应应用插件的子页面内创建。',
    );
    err.code = 'CREATION_DISALLOWED';
    err.status = 403;
    throw err;
  });
  wire(main_workflow_update, (p) => {
    // Translate IPC aliases → WorkflowService.update patch
    let definition_json: string | undefined;
    let vars_json: string | undefined;
    if (p.definition_json !== undefined) definition_json = p.definition_json;
    else if (p.definition !== undefined) definition_json = JSON.stringify(p.definition);
    if (p.vars_json !== undefined) vars_json = p.vars_json;
    else if (p.vars !== undefined) vars_json = JSON.stringify(p.vars);
    return workflow.update({ id: p.id, name: p.name, description: p.description, definition_json, vars_json });
  });
  wire(main_workflow_delete, (p) => { workflow.delete(p.id); return { ok: true as const }; });
  wire(main_workflow_runStart, async (p) => workflow.run(p.id, p.input));
  wire(main_workflow_runCancel, (p) => workflow.cancelRun(p.runId));
  wire(main_workflow_runList, (p) => workflow.listRuns(p));
  wire(main_workflow_exportJson, (p) => {
    const vm = workflow.getViewModel(p.id);
    if (!vm) throw Object.assign(new Error(`Workflow ${p.id} not found`), { code: 'WF_NOT_FOUND' });
    const runs = workflow.listRuns({ workflowId: p.id, pageSize: p.includeRuns, page: 1 });
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workflow: {
        id: vm.id, name: vm.name, description: vm.description,
        definition: vm.definition, vars: vm.vars,
      },
      recentRuns: (runs.items as Array<{ id: string; status: string; created_at: number; finished_at: number | null; duration_ms: number | null; error_stack: string | null }>).map((r) => ({
        run_id: r.id, status: r.status, created_at: r.created_at, ended_at: r.finished_at,
        duration_ms: r.duration_ms, error_message: r.error_stack,
      })),
    };
    return {
      fileName: `${vm.name.replace(/[^\w\-\. ]+/g, '_') || 'workflow'}-${p.id}.json`,
      contents: JSON.stringify(payload, null, 2),
    };
  });

  // ---- Schedules ----
  wire(main_schedule_list, (p) => scheduler.list(p));
  wire(main_schedule_create, async (p) => {
    const input_json = p.input_json ?? (p.input ? JSON.stringify(p.input) : (p.params ? JSON.stringify(p.params) : '{}'));
    const workflowId = p.workflowId ?? p.workflow_id ?? undefined;
    if (!workflowId) {
      throw Object.assign(new Error('缺少 workflowId：请先选择/创建一个工作流。'), {
        code: 'MISSING_WORKFLOW_ID',
        status: 400,
      });
    }
    const base = {
      name: p.name,
      cronExpr: p.cronExpr ?? p.cron_expr ?? undefined,
      oneShotAtMs: p.oneShotAtMs ?? p.one_shot_at ?? undefined,
      workflowId,
      input: input_json ? JSON.parse(input_json) : {},
      enabled: p.enabled === 1,
      misfirePolicy: p.misfirePolicy ?? p.misfire_policy ?? 'skip',
      timezone: p.timezone ?? 'UTC',
    };
    // v3 ownership contract: when `owner_plugin_id` is provided, first
    // validate the plugin is an *enabled* app-type plugin — this serves the
    // same purpose as the Host.schedules.create self-identity check. There is
    // no owner column on the `schedules` table today, so we gate at creation
    // time and let the scheduler/database execute it normally.
    if (p.owner_plugin_id) {
      const plug = pluginSvc.get(p.owner_plugin_id);
      if (!plug || plug.type !== 'app' || plug.status !== 'enabled') {
        throw Object.assign(
          new Error(`owner_plugin_id="${p.owner_plugin_id}" 不是已启用的 app 插件，拒绝创建定时任务。`),
          { code: 'OWNER_NOT_APP_PLUGIN', status: 400 },
        );
      }
    }
    return scheduler.create(base);
  });
  wire(main_schedule_toggle, (p) => scheduler.toggle(p.id, p.enabled === 1));
  wire(main_schedule_delete, (p) => { scheduler.delete(p.id); return { ok: true as const }; });

  // ---- Jobs ----
  wire(main_job_list, (p) => queue.list(p));
  wire(main_job_cancel, (p) => queue.cancel(p.id));
  wire(main_job_retry, (p) => queue.retry(p.id));
  wire(main_queue_setConcurrency, (p) => {
    queue.setConcurrency(p.concurrency);
    // Also persist to settings so it survives restart
    void getSettingsService().applyPatch({ 'queue.concurrency': p.concurrency });
    return { ok: true as const, concurrency: p.concurrency };
  });

  // ---- Error logs / audit ----
  wire(main_errorLog_list, (p) => {
    const filters: any = {
      page: p.page,
      pageSize: p.pageSize,
      level: p.severity as any,
      source: p.source,
      keyword: p.keyword,
      fromMs: p.startTs ?? (p as { from?: number }).from,
      toMs: p.endTs ?? (p as { to?: number }).to,
      resolved: p.resolved === 1 ? true : p.resolved === 0 ? false : undefined,
    };
    return errorCalendar.query(filters);
  });
  wire(main_errorLog_resolve, (p) => errorCalendar.markResolved(p.id, p.resolved));
  wire(main_auditLog_list, (p) => {
    const page = p.page ?? 1;
    const pageSize = p.pageSize ?? 20;
    const sql = `SELECT * FROM audit_logs WHERE 1=1` +
      (p.action ? ` AND action = @action` : '') +
      (p.source ? ` AND source = @source` : '') +
      ` ORDER BY created_at DESC`;
    const all = db.prepare(sql).all({ action: p.action, source: p.source }) as unknown[];
    const start = (page - 1) * pageSize;
    return { total: all.length, page, pageSize, items: all.slice(start, start + pageSize) };
  });

  // ---- System ----
  wire(main_system_info, () => {
    const arch = os.arch() as 'x64' | 'arm64' | 'ia32' | string;
    const platform = process.platform as 'win32' | 'darwin' | 'linux' | string;
    const plat: 'win32' | 'darwin' | 'linux' =
      (platform === 'win32' || platform === 'darwin' || platform === 'linux')
        ? platform : 'win32';
    const arc: 'x64' | 'arm64' | 'ia32' =
      (arch === 'x64' || arch === 'arm64' || arch === 'ia32')
        ? arch : 'x64';
    return {
      version: app.getVersion(),
      platform: plat,
      arch: arc,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      dbPath: (db as unknown as { name?: string }).name ?? '',
      logsDir: ctx.logsDir,
      pluginsDir: ctx.pluginsDir,
      uptimeMs: Date.now() - ctx.bootTs,
    };
  });
  wire(main_system_health, () => {
    const activeRuns = (db.prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('running','pending')`).get() as { c: number }).c;
    const pendingJobs = (db.prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE status='pending'`).get() as { c: number }).c;
    const enabledPlugins = (db.prepare(`SELECT COUNT(*) AS c FROM plugins WHERE status='enabled'`).get() as { c: number }).c;
    const busAny = bus as unknown as { listenerCount?: (event?: unknown) => number };
    return {
      dbOk: true,
      eventBusListeners: busAny.listenerCount?.() ?? 0,
      pendingJobs,
      activeRuns,
      enabledPlugins,
    };
  });

  // ---- Settings ----
  const settingsSvc = getSettingsService();
  wire(main_system_getSettings, () => settingsSvc.getAll());
  wire(main_system_setSettings, (p) => {
    const patchKeys = Object.keys(p);
    // `p` is Zod-parsed via params schema (which uses boolOrBit transforms).
    // The Zod output type still hints at `boolean | 0 | 1` but transform
    // guarantees `0 | 1` for those keys. Cast for `applyPatch` typing.
    const patch = p as unknown as Partial<Record<string, unknown>>;
    const final = settingsSvc.applyPatch(patch);
    // Immediate side-effects on relevant key changes.
    if (patchKeys.includes('queue.concurrency')) {
      queue.setConcurrency(final['queue.concurrency']);
    }
    if (patchKeys.includes('log.level')) {
      setGlobalLogLevel(final['log.level']);
    }
    if (patchKeys.includes('system.autoStart')) {
      try {
        const open = final['system.autoStart'] === 1;
        app.setLoginItemSettings({
          openAtLogin: open,
          path: app.getPath('exe'),
        });
        log.info({ openAtLogin: open }, 'auto-start preference applied');
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'failed to apply auto-start setting');
      }
    }
    // Broadcast change to renderer so the UI can re-seed settings without
    // a reload (used by ThemeWrapper for compact mode, MainLayout for
    // collapsed sider, Settings page for live-updated values).
    try {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send('fmb:settingsChanged', { keys: patchKeys });
      }
    } catch { /* silent — no window during CLI / early boot */ }
    return final;
  });

  // ---- Extension points list (T11 ExtensionPoints page ≥ 20 items) ----
  // (plugin_bindings is the historical name; actual column is extension_point_bindings
  //  referenced below via the LEFT JOIN query on `pb` alias.)
  const EP_DESCRIPTIONS: Partial<Record<string, string>> = {
    // ===== Lifecycle =====
    'app.onReady':            '主进程基础设施（DB + 事件总线 + 插件系统）初始化完成后首次触发一次。',
    'app.beforeQuit':         '应用退出前触发，用于持久化 / 清理资源 / 写日志。',
    // ===== Plugin mgmt (both low-level + UI-facing names) =====
    'plugin.installed':       '插件落库并启用后（高层别名：plugin.afterInstall）。',
    'plugin.uninstalled':     '插件卸载完成后（高层别名：plugin.afterUninstall）。',
    'plugin.enabled':         '插件状态切换为 enabled。',
    'plugin.disabled':        '插件状态切换为 disabled。',
    'plugin.beforeInstall':   '插件 zip 安装前。处理者可通过 throw 阻止安装。',
    'plugin.afterInstall':    '插件成功安装且首次版本落库后触发。',
    'plugin.beforeUninstall': '插件卸载前触发，可用于备份配置。',
    'plugin.afterUninstall':  '插件卸载完成后触发。',
    'plugin.statusChanged':   '插件启用/停用状态切换时触发。',
    'plugin.actionCalled':    '插件 exports.main.actions[name] 被 HostUIApi 调用前/后。',
    'plugin.kvsChanged':      '插件私有 KV (plugin.<id>.kvs) 中任意字段增删改。',
    // ===== Workflow =====
    'workflow.created':        '工作流 DSL 创建 / 导入成功。',
    'workflow.deleted':        '工作流被删除。',
    'workflow.workflowStart':  '工作流 run 启动。(alias: workflow.beforeExecute)',
    'workflow.workflowComplete': '工作流 run 完成（success/failure/cancel）。(alias: workflow.afterExecute)',
    'workflow.nodeEnter':      '工作流节点即将执行（alias: workflow.beforeExecute 单节点粒度）。',
    'workflow.nodeLeave':      '工作流节点执行结束（无论成功失败）。',
    'workflow.beforeExecute':  '工作流 run 开始执行前触发。',
    'workflow.afterExecute':   '工作流 run 结束时触发。',
    'workflow.nodeComplete':   '工作流中单个节点成功执行后触发。',
    'workflow.nodeError':      '工作流中单个节点执行失败后触发。',
    // ===== Scheduler =====
    'schedule.fired':      'Cron / one-shot 时间到达（alias：schedule.triggered）。',
    'schedule.created':    '新增定时任务定义。',
    'schedule.paused':     '定时任务切换为 paused。',
    'schedule.triggered':  '定时任务 Cron / one-shot 时间到达并被调度器触发时触发。',
    // ===== Queue =====
    'queue.jobEnqueued':  '作业入队完成后触发。',
    'queue.jobCompleted': '作业成功完成后触发。',
    'queue.jobFailed':    '作业耗尽所有重试 / 被标记 dead 后触发。',
    // ===== Error & audit =====
    'error.captured':   '错误日志新增一条错误时触发（alias：errorLog.newEntry）。',
    'errorLog.newEntry': '错误日志新增一条错误时触发，可用于通知。',
    'audit.newEntry':    'audit_logs 新增一条记录时触发。',
    // ===== UI =====
    'ui.mainMenu.render':      '主界面左侧菜单生成前，可用于注入插件子菜单项。',
    'ui.mainDashboard.card':   '仪表盘渲染卡片前触发，可用于注入插件自定义卡片。',
    // ===== Settings =====
    'settings.changed': '某个设置项变更时触发（key / before / after）。',
    // ===== HTTP API (T15) =====
    'http.api.beforeRequest': 'HTTP API 收到请求但未执行业务逻辑时触发。',
    'http.api.afterResponse': 'HTTP API 返回响应后触发，含状态码与耗时。',
  };
  wire(main_ep_list, (p) => {
    // Ensure bindings table exists (handles older DB without schema)
    db.exec(`CREATE TABLE IF NOT EXISTS extension_point_bindings (
      extension_point TEXT NOT NULL,
      plugin_id       TEXT NOT NULL,
      handler_name    TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (extension_point, plugin_id, handler_name)
    )`);
    const epNames = Array.from(new Set([
      ...(bus.registeredExtensionPoints ?? []),
      ...EXTENSION_POINTS,
      ...Object.keys(EP_DESCRIPTIONS),
    ])) as string[];
    // LEFT JOIN: rows even if no bindings yet; also exposes `plugin_bindings` semantic through alias CTE
    const bindingsRows = db.prepare(`
      WITH plugin_bindings(extension_point, plugin_id, handler_name, enabled) AS (
        SELECT extension_point, plugin_id, handler_name, enabled FROM extension_point_bindings
      )
      SELECT pb.extension_point AS name, pb.plugin_id, pb.handler_name, pb.enabled
      FROM plugin_bindings pb
      LEFT JOIN extension_point_bindings epb ON epb.extension_point = pb.extension_point
                                        AND epb.plugin_id = pb.plugin_id
                                        AND epb.handler_name = pb.handler_name
    `).all() as Array<{ name: string; plugin_id: string; handler_name: string; enabled: 0 | 1 }>;
    const bindingsByEp = new Map<string, Array<{ plugin_id: string; handler_name: string; enabled: 0 | 1 }>>();
    for (const r of bindingsRows) {
      const arr = bindingsByEp.get(r.name) ?? []; arr.push(r); bindingsByEp.set(r.name, arr);
    }
    const items = epNames.map((name) => {
      const bindings = (p.withBindings !== false ? (bindingsByEp.get(name) ?? []) : []);
      let listenerCount: number;
      const busAny = bus as unknown as { listenerCount?: (event?: unknown) => number };
      try { listenerCount = busAny.listenerCount?.(name) ?? bindings.length; }
      catch { listenerCount = bindings.length; }
      return {
        name,
        description: (ctx.epDescriptions?.[name] ?? EP_DESCRIPTIONS[name] ?? ''),
        listenerCount,
        bindings,
        builtin: (EXTENSION_POINTS as readonly string[]).includes(name),
      };
    });
    const total = items.length;
    const page = p.page ?? 1;
    const pageSize = p.pageSize ?? 50;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  });

  return function dispose(): void {
    for (const ch of IPC_REGISTRY) ipcMain.removeHandler(ch.channel);
  };
}
