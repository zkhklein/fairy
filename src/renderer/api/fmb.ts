/**
 * Renderer-side typed API client wrapping `window.fmb` exposed by the preload.
 *
 * Keeps React pages / Zustand stores completely free of `window.fmb.xx` strings.
 * Each method mirrors the preload's `FmbApi` and returns a typed Promise.
 */
import type { FmbApi } from '../../preload';
import type {
  MainPluginListParams, MainPluginListResult,
  MainPluginGetParams, MainPluginGetResult,
  MainPluginInstallParams, MainPluginInstallResult,
  MainPluginSetStatusParams, MainPluginSetStatusResult,
  MainPluginUninstallParams, MainPluginUninstallResult,
  MainPluginValidateManifestParams, MainPluginValidateManifestResult,
  MainPluginListVersionsParams, MainPluginListVersionsResult,
  MainPluginSwitchVersionParams, MainPluginSwitchVersionResult,
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
} from '@shared/ipc';

/**
 * Detect whether we're running in a real Electron window with `window.fmb`,
 * or in a browser-only dev context (e.g. `vite` dev server without Electron).
 * In the latter case we throw a descriptive error so the UI can show a
 * Result/Error state.
 */
function getFmb(): FmbApi {
  if (typeof window !== 'undefined' && window.fmb) return window.fmb;
  throw Object.assign(new Error('FMB preload not available. Open the UI through the Electron main window.'), {
    code: 'FMB_PRELOAD_MISSING',
  });
}

export const fmbApi = {
  version(): string { return getFmb().version; },
  platform(): string { return getFmb().platform; },

  pluginList(p: MainPluginListParams) { return getFmb().pluginList(p) as Promise<MainPluginListResult>; },
  pluginGet(p: MainPluginGetParams) { return getFmb().pluginGet(p) as Promise<MainPluginGetResult>; },
  pluginInstall(p: MainPluginInstallParams) { return getFmb().pluginInstall(p) as Promise<MainPluginInstallResult>; },
  pluginSetStatus(p: MainPluginSetStatusParams) { return getFmb().pluginSetStatus(p) as Promise<MainPluginSetStatusResult>; },
  pluginUninstall(p: MainPluginUninstallParams) { return getFmb().pluginUninstall(p) as Promise<MainPluginUninstallResult>; },
  pluginValidateManifest(p: MainPluginValidateManifestParams) {
    return getFmb().pluginValidateManifest(p) as Promise<MainPluginValidateManifestResult>;
  },
  pluginListVersions(p: MainPluginListVersionsParams) { return getFmb().pluginListVersions(p) as Promise<MainPluginListVersionsResult>; },
  pluginSwitchVersion(p: MainPluginSwitchVersionParams) { return getFmb().pluginSwitchVersion(p) as Promise<MainPluginSwitchVersionResult>; },
  pluginGetRenderer(p: MainPluginGetRendererParams) { return getFmb().pluginGetRenderer(p) as Promise<MainPluginGetRendererResult>; },
  pluginCallAction(p: MainPluginCallActionParams) { return getFmb().pluginCallAction(p) as Promise<MainPluginCallActionResult>; },

  workflowList(p: MainWorkflowListParams) { return getFmb().workflowList(p) as Promise<MainWorkflowListResult>; },
  workflowGet(p: MainWorkflowGetParams) { return getFmb().workflowGet(p) as Promise<MainWorkflowGetResult>; },
  workflowCreate(p: MainWorkflowCreateParams) { return getFmb().workflowCreate(p) as Promise<MainWorkflowCreateResult>; },
  workflowUpdate(p: MainWorkflowUpdateParams) { return getFmb().workflowUpdate(p) as Promise<MainWorkflowUpdateResult>; },
  workflowDelete(p: MainWorkflowDeleteParams) { return getFmb().workflowDelete(p) as Promise<MainWorkflowDeleteResult>; },
  workflowRunStart(p: MainWorkflowRunStartParams) { return getFmb().workflowRunStart(p) as Promise<MainWorkflowRunStartResult>; },
  workflowRunCancel(p: MainWorkflowRunCancelParams) { return getFmb().workflowRunCancel(p) as Promise<MainWorkflowRunCancelResult>; },
  workflowRunList(p: MainWorkflowRunListParams) { return getFmb().workflowRunList(p) as Promise<MainWorkflowRunListResult>; },
  workflowExportJson(p: MainWorkflowExportJsonParams) { return getFmb().workflowExportJson(p) as Promise<MainWorkflowExportJsonResult>; },

  scheduleList(p: MainScheduleListParams) { return getFmb().scheduleList(p) as Promise<MainScheduleListResult>; },
  scheduleCreate(p: MainScheduleCreateParams) { return getFmb().scheduleCreate(p) as Promise<MainScheduleCreateResult>; },
  scheduleToggle(p: MainScheduleToggleParams) { return getFmb().scheduleToggle(p) as Promise<MainScheduleToggleResult>; },
  scheduleDelete(p: MainScheduleDeleteParams) { return getFmb().scheduleDelete(p) as Promise<MainScheduleDeleteResult>; },

  jobList(p: MainJobListParams) { return getFmb().jobList(p) as Promise<MainJobListResult>; },
  jobCancel(p: MainJobCancelParams) { return getFmb().jobCancel(p) as Promise<MainJobCancelResult>; },
  jobRetry(p: MainJobRetryParams) { return getFmb().jobRetry(p) as Promise<MainJobRetryResult>; },
  queueSetConcurrency(p: MainQueueSetConcurrencyParams) { return getFmb().queueSetConcurrency(p) as Promise<MainQueueSetConcurrencyResult>; },

  errorLogList(p: MainErrorLogListParams) { return getFmb().errorLogList(p) as Promise<MainErrorLogListResult>; },
  errorLogResolve(p: MainErrorLogResolveParams) { return getFmb().errorLogResolve(p) as Promise<MainErrorLogResolveResult>; },
  auditLogList(p: MainAuditLogListParams) { return getFmb().auditLogList(p) as Promise<MainAuditLogListResult>; },

  systemInfo(p: MainSystemInfoParams = {}) { return getFmb().systemInfo(p) as Promise<MainSystemInfoResult>; },
  systemHealth(p: MainSystemHealthParams = {}) { return getFmb().systemHealth(p) as Promise<MainSystemHealthResult>; },
  systemGetSettings(p: MainSystemGetSettingsParams = {}) { return getFmb().systemGetSettings(p) as Promise<MainSystemGetSettingsResult>; },
  systemSetSettings(p: MainSystemSetSettingsParams) { return getFmb().systemSetSettings(p) as Promise<MainSystemSetSettingsResult>; },
  epList(p: MainEpListParams) { return getFmb().epList(p) as Promise<MainEpListResult>; },
};
