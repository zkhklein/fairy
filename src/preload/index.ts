/**
 * Preload script.
 *
 * Exposes a tiny, typed, contextBridge API to the renderer.
 * Rules (TR-10.2 / hardening):
 *   - `contextIsolation: true` (set by electron-vite defaults, enforced in main).
 *   - `window.require` / Node globals are NOT exposed.
 *   - Only whitelisted IPC channels are bridged; arbitrary `ipcRenderer.invoke` is never allowed.
 *   - Each method is a fresh wrapper (not Node EventEmitter instances) to avoid prototype leaks.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  MainPluginListParams, MainPluginListResult,
  MainPluginGetParams, MainPluginGetResult,
  MainPluginInstallParams, MainPluginInstallResult,
  MainPluginSetStatusParams, MainPluginSetStatusResult,
  MainPluginUninstallParams, MainPluginUninstallResult,
  MainPluginValidateManifestParams, MainPluginValidateManifestResult,
  MainPluginListVersionsParams, MainPluginListVersionsResult,
  MainPluginSwitchVersionParams, MainPluginSwitchVersionResult,
  MainPluginPreInstallCheckParams, MainPluginPreInstallCheckResult,
  MainPluginInstallBatchParams, MainPluginInstallBatchResult,
  MainPluginListScheduleTemplatesParams, MainPluginListScheduleTemplatesResult,
  MainDialogShowOpenParams, MainDialogShowOpenResult,
  MainWorkflowListParams, MainWorkflowListResult,
  MainWorkflowGetParams, MainWorkflowGetResult,
  MainWorkflowCreateParams, MainWorkflowCreateResult,
  MainWorkflowUpdateParams, MainWorkflowUpdateResult,
  MainWorkflowDeleteParams, MainWorkflowDeleteResult,
  MainWorkflowRunStartParams, MainWorkflowRunStartResult,
  MainWorkflowRunCancelParams, MainWorkflowRunCancelResult,
  MainWorkflowRunListParams, MainWorkflowRunListResult,
  MainWorkflowExportJsonParams, MainWorkflowExportJsonResult,
  MainScheduleListParams, MainScheduleListResult,
  MainScheduleCreateParams, MainScheduleCreateResult,
  MainScheduleToggleParams, MainScheduleToggleResult,
  MainScheduleDeleteParams, MainScheduleDeleteResult,
  MainJobListParams, MainJobListResult,
  MainJobCancelParams, MainJobCancelResult,
  MainJobRetryParams, MainJobRetryResult,
  MainQueueSetConcurrencyParams, MainQueueSetConcurrencyResult,
  MainErrorLogListParams, MainErrorLogListResult,
  MainErrorLogResolveParams, MainErrorLogResolveResult,
  MainAuditLogListParams, MainAuditLogListResult,
  MainSystemInfoParams, MainSystemInfoResult,
  MainSystemHealthParams, MainSystemHealthResult,
  MainSystemGetSettingsParams, MainSystemGetSettingsResult,
  MainSystemSetSettingsParams, MainSystemSetSettingsResult,
  MainEpListParams, MainEpListResult,
  MainPluginGetRendererParams, MainPluginGetRendererResult,
  MainPluginCallActionParams, MainPluginCallActionResult,
} from '../shared/ipc';
import { IPC_CHANNELS } from '../shared/ipc';

function invoke<P, R>(channel: string, params: P): Promise<R> {
  return ipcRenderer.invoke(channel, params) as Promise<R>;
}

const api = {
  version: '0.1.0',
  platform: process.platform,

  // Plugins
  pluginList: (p: MainPluginListParams) => invoke<MainPluginListParams, MainPluginListResult>(IPC_CHANNELS.main_plugin_list, p),
  pluginGet: (p: MainPluginGetParams) => invoke<MainPluginGetParams, MainPluginGetResult>(IPC_CHANNELS.main_plugin_get, p),
  pluginInstall: (p: MainPluginInstallParams) => invoke<MainPluginInstallParams, MainPluginInstallResult>(IPC_CHANNELS.main_plugin_install, p),
  pluginSetStatus: (p: MainPluginSetStatusParams) => invoke<MainPluginSetStatusParams, MainPluginSetStatusResult>(IPC_CHANNELS.main_plugin_setStatus, p),
  pluginUninstall: (p: MainPluginUninstallParams) => invoke<MainPluginUninstallParams, MainPluginUninstallResult>(IPC_CHANNELS.main_plugin_uninstall, p),
  pluginValidateManifest: (p: MainPluginValidateManifestParams) => invoke<MainPluginValidateManifestParams, MainPluginValidateManifestResult>(IPC_CHANNELS.main_plugin_validateManifest, p),
  pluginListVersions: (p: MainPluginListVersionsParams) => invoke<MainPluginListVersionsParams, MainPluginListVersionsResult>(IPC_CHANNELS.main_plugin_listVersions, p),
  pluginSwitchVersion: (p: MainPluginSwitchVersionParams) => invoke<MainPluginSwitchVersionParams, MainPluginSwitchVersionResult>(IPC_CHANNELS.main_plugin_switchVersion, p),
  pluginPreInstallCheck: (p: MainPluginPreInstallCheckParams) => invoke<MainPluginPreInstallCheckParams, MainPluginPreInstallCheckResult>(IPC_CHANNELS.main_plugin_preInstallCheck, p),
  pluginInstallBatch: (p: MainPluginInstallBatchParams) => invoke<MainPluginInstallBatchParams, MainPluginInstallBatchResult>(IPC_CHANNELS.main_plugin_installBatch, p),
  pluginListScheduleTemplates: (p: MainPluginListScheduleTemplatesParams) => invoke<MainPluginListScheduleTemplatesParams, MainPluginListScheduleTemplatesResult>(IPC_CHANNELS.main_plugin_listScheduleTemplates, p),
  pluginGetRenderer: (p: MainPluginGetRendererParams) => invoke<MainPluginGetRendererParams, MainPluginGetRendererResult>(IPC_CHANNELS.main_plugin_getRenderer, p),
  pluginCallAction: (p: MainPluginCallActionParams) => invoke<MainPluginCallActionParams, MainPluginCallActionResult>(IPC_CHANNELS.main_plugin_callAction, p),

  // Native dialogs (renderer cannot call dialog directly)
  dialogShowOpen: (p: MainDialogShowOpenParams) => invoke<MainDialogShowOpenParams, MainDialogShowOpenResult>(IPC_CHANNELS.main_dialog_showOpen, p),

  // Workflows
  workflowList: (p: MainWorkflowListParams) => invoke<MainWorkflowListParams, MainWorkflowListResult>(IPC_CHANNELS.main_workflow_list, p),
  workflowGet: (p: MainWorkflowGetParams) => invoke<MainWorkflowGetParams, MainWorkflowGetResult>(IPC_CHANNELS.main_workflow_get, p),
  workflowCreate: (p: MainWorkflowCreateParams) => invoke<MainWorkflowCreateParams, MainWorkflowCreateResult>(IPC_CHANNELS.main_workflow_create, p),
  workflowUpdate: (p: MainWorkflowUpdateParams) => invoke<MainWorkflowUpdateParams, MainWorkflowUpdateResult>(IPC_CHANNELS.main_workflow_update, p),
  workflowDelete: (p: MainWorkflowDeleteParams) => invoke<MainWorkflowDeleteParams, MainWorkflowDeleteResult>(IPC_CHANNELS.main_workflow_delete, p),
  workflowRunStart: (p: MainWorkflowRunStartParams) => invoke<MainWorkflowRunStartParams, MainWorkflowRunStartResult>(IPC_CHANNELS.main_workflow_runStart, p),
  workflowRunCancel: (p: MainWorkflowRunCancelParams) => invoke<MainWorkflowRunCancelParams, MainWorkflowRunCancelResult>(IPC_CHANNELS.main_workflow_runCancel, p),
  workflowRunList: (p: MainWorkflowRunListParams) => invoke<MainWorkflowRunListParams, MainWorkflowRunListResult>(IPC_CHANNELS.main_workflow_runList, p),
  workflowExportJson: (p: MainWorkflowExportJsonParams) => invoke<MainWorkflowExportJsonParams, MainWorkflowExportJsonResult>(IPC_CHANNELS.main_workflow_exportJson, p),

  // Schedules
  scheduleList: (p: MainScheduleListParams) => invoke<MainScheduleListParams, MainScheduleListResult>(IPC_CHANNELS.main_schedule_list, p),
  scheduleCreate: (p: MainScheduleCreateParams) => invoke<MainScheduleCreateParams, MainScheduleCreateResult>(IPC_CHANNELS.main_schedule_create, p),
  scheduleToggle: (p: MainScheduleToggleParams) => invoke<MainScheduleToggleParams, MainScheduleToggleResult>(IPC_CHANNELS.main_schedule_toggle, p),
  scheduleDelete: (p: MainScheduleDeleteParams) => invoke<MainScheduleDeleteParams, MainScheduleDeleteResult>(IPC_CHANNELS.main_schedule_delete, p),

  // Jobs
  jobList: (p: MainJobListParams) => invoke<MainJobListParams, MainJobListResult>(IPC_CHANNELS.main_job_list, p),
  jobCancel: (p: MainJobCancelParams) => invoke<MainJobCancelParams, MainJobCancelResult>(IPC_CHANNELS.main_job_cancel, p),
  jobRetry: (p: MainJobRetryParams) => invoke<MainJobRetryParams, MainJobRetryResult>(IPC_CHANNELS.main_job_retry, p),
  queueSetConcurrency: (p: MainQueueSetConcurrencyParams) => invoke<MainQueueSetConcurrencyParams, MainQueueSetConcurrencyResult>(IPC_CHANNELS.main_queue_setConcurrency, p),

  // Error log / audit
  errorLogList: (p: MainErrorLogListParams) => invoke<MainErrorLogListParams, MainErrorLogListResult>(IPC_CHANNELS.main_errorLog_list, p),
  errorLogResolve: (p: MainErrorLogResolveParams) => invoke<MainErrorLogResolveParams, MainErrorLogResolveResult>(IPC_CHANNELS.main_errorLog_resolve, p),
  auditLogList: (p: MainAuditLogListParams) => invoke<MainAuditLogListParams, MainAuditLogListResult>(IPC_CHANNELS.main_auditLog_list, p),

  // System
  systemInfo: (p: MainSystemInfoParams = {}) => invoke<MainSystemInfoParams, MainSystemInfoResult>(IPC_CHANNELS.main_system_info, p),
  systemHealth: (p: MainSystemHealthParams = {}) => invoke<MainSystemHealthParams, MainSystemHealthResult>(IPC_CHANNELS.main_system_health, p),
  systemGetSettings: (p: MainSystemGetSettingsParams = {}) => invoke<MainSystemGetSettingsParams, MainSystemGetSettingsResult>(IPC_CHANNELS.main_system_getSettings, p),
  systemSetSettings: (p: MainSystemSetSettingsParams) => invoke<MainSystemSetSettingsParams, MainSystemSetSettingsResult>(IPC_CHANNELS.main_system_setSettings, p),
  epList: (p: MainEpListParams) => invoke<MainEpListParams, MainEpListResult>(IPC_CHANNELS.main_ep_list, p),
};

export type FmbApi = typeof api;

declare global {
  interface Window {
    fmb: FmbApi;
  }
}

contextBridge.exposeInMainWorld('fmb', api);

/**
 * Bridge: broadcast main-process → renderer setting changes as a
 * plain DOM `CustomEvent` so renderer React code doesn't need Node APIs.
 *
 * Usage inside the renderer:
 *   window.addEventListener('fmb:settingsChanged', handler);
 *
 * The `detail` carries the list of keys the patch touched so a page can
 * do targeted refresh instead of a full settings reload.
 */
ipcRenderer.on('fmb:settingsChanged', (_evt, payload) => {
  const ev = new CustomEvent('fmb:settingsChanged', { detail: payload });
  window.dispatchEvent(ev);
});
