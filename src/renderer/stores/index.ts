/**
 * Zustand stores for the FMB renderer.
 *
 * 每个 store 都实现统一的四态（loading / success / error / empty）：
 *   - loading: `loading` 标记 + 组件端用 `Skeleton` 渲染
 *   - error:   `error` 字段 + 组件端用 `Result` 错误页
 *   - empty:   数据长度为 0 + 组件端用 `Empty`
 *   - success: 正常渲染
 * 每个异步 action 都带 `_ts` 时间戳，便于页面根据变更触发重新拉取
 * （如：安装插件后重新 list() 一下，而非在 store 里手动合并列表）。
 */
import { create } from 'zustand';
import { fmbApi } from '../api/fmb';
import type {
  MainPluginListResult,
  MainWorkflowListResult,
  MainScheduleListResult,
  MainJobListResult,
  MainErrorLogListResult,
  MainSystemInfoResult,
  MainSystemHealthResult,
  MainSystemGetSettingsResult,
  MainEpListResult,
  MainPluginListVersionsResult,
  MainWorkflowExportJsonResult,
  MainQueueSetConcurrencyResult,
} from '@shared/ipc';

type FetchState = { loading: boolean; error: string | null; ts: number };

// ---------------- Plugin store ----------------
interface PluginState extends FetchState {
  data: MainPluginListResult | null;
  versions: { pluginId: string; items: MainPluginListVersionsResult['items'] } | null;
  versionsError: string | null;
  list: (params?: Parameters<typeof fmbApi.pluginList>[0]) => Promise<void>;
  listVersions: (id: string) => Promise<void>;
  switchVersion: (id: string, version: string) => Promise<void>;
}
export const usePluginStore = create<PluginState>((set, get) => ({
  loading: false,
  error: null,
  ts: 0,
  data: null,
  versions: null,
  versionsError: null,
  list: async (p = {}) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const r = await fmbApi.pluginList(p);
      set({ loading: false, data: r, ts: Date.now() });
    } catch (e) {
      set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load plugins' });
    }
  },
  listVersions: async (id) => {
    set({ versionsError: null });
    try {
      const r = await fmbApi.pluginListVersions({ id });
      set({ versions: { pluginId: id, items: r.items } });
    } catch (e) {
      set({ versionsError: (e as { message?: string }).message ?? '版本列表加载失败' });
    }
  },
  switchVersion: async (id, version) => {
    await fmbApi.pluginSwitchVersion({ id, version });
    void Promise.all([get().list(), get().listVersions(id)]);
  },
}));

// ---------------- Workflow store ----------------
interface WorkflowState extends FetchState {
  data: MainWorkflowListResult | null;
  list: (params?: Parameters<typeof fmbApi.workflowList>[0]) => Promise<void>;
  create: typeof fmbApi.workflowCreate;
  del: (id: string) => Promise<void>;
  run: typeof fmbApi.workflowRunStart;
}
export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  loading: false, error: null, ts: 0, data: null,
  list: async (p = {}) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try { set({ loading: false, data: await fmbApi.workflowList(p), ts: Date.now() }); }
    catch (e) { set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load workflows' }); }
  },
  create: async (p) => { const r = await fmbApi.workflowCreate(p); void get().list(); return r; },
  del: async (id) => { await fmbApi.workflowDelete({ id }); void get().list(); },
  run: async (p) => { const r = await fmbApi.workflowRunStart(p); void get().list(); return r; },
  exportJson: async (id: string, includeRuns = 20): Promise<MainWorkflowExportJsonResult> => fmbApi.workflowExportJson({ id, includeRuns }),
}));

// ---------------- Schedule store ----------------
interface ScheduleState extends FetchState {
  data: MainScheduleListResult | null;
  list: (params?: Parameters<typeof fmbApi.scheduleList>[0]) => Promise<void>;
  create: typeof fmbApi.scheduleCreate;
  toggle: (id: string, enabled: 0 | 1) => Promise<void>;
  del: (id: string) => Promise<void>;
}
export const useScheduleStore = create<ScheduleState>((set, get) => ({
  loading: false, error: null, ts: 0, data: null,
  list: async (p = {}) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try { set({ loading: false, data: await fmbApi.scheduleList(p), ts: Date.now() }); }
    catch (e) { set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load schedules' }); }
  },
  create: async (p) => { const r = await fmbApi.scheduleCreate(p); void get().list(); return r; },
  toggle: async (id, enabled) => { await fmbApi.scheduleToggle({ id, enabled }); void get().list(); },
  del: async (id) => { await fmbApi.scheduleDelete({ id }); void get().list(); },
}));

// ---------------- Queue (job) store ----------------
interface JobState extends FetchState {
  data: MainJobListResult | null;
  list: (params?: Parameters<typeof fmbApi.jobList>[0]) => Promise<void>;
  cancel: (id: number) => Promise<void>;
  retry: (id: number) => Promise<void>;
}
export const useJobStore = create<JobState>((set, get) => ({
  loading: false, error: null, ts: 0, data: null,
  list: async (p = {}) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try { set({ loading: false, data: await fmbApi.jobList(p), ts: Date.now() }); }
    catch (e) { set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load jobs' }); }
  },
  cancel: async (id) => { await fmbApi.jobCancel({ id }); void get().list(); },
  retry: async (id) => { await fmbApi.jobRetry({ id }); void get().list(); },
  setConcurrency: async (concurrency: number): Promise<MainQueueSetConcurrencyResult> => {
    const r = await fmbApi.queueSetConcurrency({ concurrency });
    void get().list();
    return r;
  },
}));

// ---------------- Error-log store ----------------
interface ErrorLogState extends FetchState {
  data: MainErrorLogListResult | null;
  list: (params?: Parameters<typeof fmbApi.errorLogList>[0]) => Promise<void>;
  resolve: (id: number, resolved: boolean) => Promise<void>;
}
export const useErrorStore = create<ErrorLogState>((set, get) => ({
  loading: false, error: null, ts: 0, data: null,
  list: async (p = {}) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try { set({ loading: false, data: await fmbApi.errorLogList(p), ts: Date.now() }); }
    catch (e) { set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load error logs' }); }
  },
  resolve: async (id, resolved) => { await fmbApi.errorLogResolve({ id, resolved }); void get().list(); },
}));

// ---------------- System + UI store ----------------
export interface UiState {
  siderCollapsed: boolean;
  toggleSider: () => void;
  systemInfo: MainSystemInfoResult | null;
  systemHealth: MainSystemHealthResult | null;
  systemError: string | null;
  systemLoading: boolean;
  loadSystem: () => Promise<void>;
  refreshHealth: () => Promise<void>;
}
export const useUiStore = create<UiState>((set, get) => ({
  siderCollapsed: false,
  toggleSider: () => set({ siderCollapsed: !get().siderCollapsed }),
  systemInfo: null,
  systemHealth: null,
  systemError: null,
  systemLoading: false,
  loadSystem: async () => {
    set({ systemLoading: true, systemError: null });
    try {
      const [info, health] = await Promise.all([fmbApi.systemInfo(), fmbApi.systemHealth()]);
      set({ systemInfo: info, systemHealth: health, systemLoading: false });
    } catch (e) {
      set({ systemLoading: false, systemError: (e as { message?: string }).message ?? 'Failed to load system info' });
    }
  },
  refreshHealth: async () => {
    try { set({ systemHealth: await fmbApi.systemHealth() }); } catch { /* silent */ }
  },
}));

// ---------------- Settings store ----------------
interface SettingsState extends FetchState {
  data: MainSystemGetSettingsResult | null;
  load: () => Promise<void>;
  patch: (patch: Partial<MainSystemGetSettingsResult>) => Promise<MainSystemGetSettingsResult>;
}
export const useSettingsStore = create<SettingsState>((set, get) => ({
  loading: false, error: null, ts: 0, data: null,
  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try { set({ loading: false, data: await fmbApi.systemGetSettings({}), ts: Date.now() }); }
    catch (e) { set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load settings' }); }
  },
  patch: async (patch) => {
    const result = await fmbApi.systemSetSettings(patch);
    set({ data: result, ts: Date.now() });
    return result;
  },
}));

// ---------------- Extension points store ----------------
interface ExtensionPointsState extends FetchState {
  data: MainEpListResult | null;
  list: (params?: Parameters<typeof fmbApi.epList>[0]) => Promise<void>;
}
export const useExtensionPointsStore = create<ExtensionPointsState>((set, get) => ({
  loading: false, error: null, ts: 0, data: null,
  list: async (p = {}) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try { set({ loading: false, data: await fmbApi.epList(p), ts: Date.now() }); }
    catch (e) { set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load extension points' }); }
  },
}));
