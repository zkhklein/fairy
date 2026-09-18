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
  MainPluginPreInstallCheckResult,
  MainPluginInstallBatchResult,
  MainPluginListScheduleTemplatesResult,
} from '@shared/ipc';

type FetchState = { loading: boolean; error: string | null; ts: number };

// ---------------- Plugin store ----------------
interface PluginState extends FetchState {
  data: MainPluginListResult | null;
  versions: { pluginId: string; items: MainPluginListVersionsResult['items'] } | null;
  versionsError: string | null;
  // Install flow (UI-facing: preCheck result cache + batch result)
  preChecks: Array<MainPluginPreInstallCheckResult>;
  preChecksLoading: boolean;
  batchResults: MainPluginInstallBatchResult['results'] | null;
  batchLoading: boolean;
  scheduleTemplates: MainPluginListScheduleTemplatesResult | null;
  scheduleTemplatesLoading: boolean;

  list: (params?: Parameters<typeof fmbApi.pluginList>[0]) => Promise<void>;
  listVersions: (id: string) => Promise<void>;
  switchVersion: (id: string, version: string) => Promise<void>;
  preInstallBatch: (zipPaths: string[]) => Promise<void>;
  installBatch: (args: { zipPaths: string[]; autoEnable?: boolean; overwriteDeps?: string[] }) => Promise<void>;
  loadScheduleTemplates: () => Promise<void>;
}
export const usePluginStore = create<PluginState>((set, get) => ({
  loading: false,
  error: null,
  ts: 0,
  data: null,
  versions: null,
  versionsError: null,
  preChecks: [],
  preChecksLoading: false,
  batchResults: null,
  batchLoading: false,
  scheduleTemplates: null,
  scheduleTemplatesLoading: false,

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
  preInstallBatch: async (zipPaths) => {
    set({ preChecksLoading: true, error: null });
    try {
      const results = await Promise.all(
        zipPaths.map((zp) => fmbApi.pluginPreInstallCheck({ zipPath: zp })),
      );
      set({ preChecksLoading: false, preChecks: results });
    } catch (e) {
      set({
        preChecksLoading: false,
        error: (e as { message?: string }).message ?? '预检查失败',
      });
    }
  },
  installBatch: async ({ zipPaths, autoEnable = false, overwriteDeps = [] }) => {
    set({ batchLoading: true, batchResults: null });
    try {
      const r = await fmbApi.pluginInstallBatch({ zipPaths, autoEnable, overwriteDeps });
      set({ batchLoading: false, batchResults: r.results });
      void get().list(); // refresh table
    } catch (e) {
      set({
        batchLoading: false,
        error: (e as { message?: string }).message ?? '批量安装失败',
      });
    }
  },
  loadScheduleTemplates: async () => {
    set({ scheduleTemplatesLoading: true });
    try {
      set({
        scheduleTemplates: await fmbApi.pluginListScheduleTemplates(),
        scheduleTemplatesLoading: false,
      });
    } catch (e) {
      set({
        scheduleTemplatesLoading: false,
        error: (e as { message?: string }).message ?? '模板加载失败',
      });
    }
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
  // Persisted (loaded from settings service; folded in once on loadSystem).
  uiCompact: 0 | 1;
  uiCollapsed: 0 | 1;
  // Transient runtime override for sider toggles, immediately reflected in
  // the layout component; kept separate so saves don't write every toggle,
  // but still sync back to settings when `persistSiderCollapsed` is called.
  siderCollapsed: boolean;
  toggleSider: () => void;
  // One-shot apply: updates runtime state + fires a settings patch. Used by
  // MainLayout on mount so the sider default matches the saved preference.
  seedFromSettings: (s: Pick<MainSystemGetSettingsResult, 'ui.compact' | 'ui.collapsed'>) => void;
  persistSiderCollapsed: (collapsed: boolean) => Promise<void>;

  systemInfo: MainSystemInfoResult | null;
  systemHealth: MainSystemHealthResult | null;
  systemError: string | null;
  systemLoading: boolean;
  loadSystem: () => Promise<void>;
  refreshHealth: () => Promise<void>;
}
export const useUiStore = create<UiState>((set, get) => ({
  uiCompact: 0,
  uiCollapsed: 0,
  siderCollapsed: false,
  toggleSider: () => {
    const next = !get().siderCollapsed;
    set({ siderCollapsed: next });
    // sync back to settings lazily so preference survives reload
    void get().persistSiderCollapsed(next);
  },
  seedFromSettings: (s) => {
    const compact =
      typeof s['ui.compact'] === 'boolean' ? (s['ui.compact'] ? 1 : 0) : (s['ui.compact'] as 0 | 1) ?? 0;
    const collapsed =
      typeof s['ui.collapsed'] === 'boolean' ? (s['ui.collapsed'] ? 1 : 0) : (s['ui.collapsed'] as 0 | 1) ?? 0;
    set({
      uiCompact: compact,
      uiCollapsed: collapsed,
      siderCollapsed: collapsed === 1,
    });
  },
  persistSiderCollapsed: async (collapsed) => {
    try {
      const final = await fmbApi.systemSetSettings({ 'ui.collapsed': collapsed ? 1 : 0 });
      const val = typeof final['ui.collapsed'] === 'boolean'
        ? (final['ui.collapsed'] ? 1 : 0)
        : final['ui.collapsed'] ?? 0;
      set({ uiCollapsed: val as 0 | 1 });
    } catch { /* silent: user-facing collapse still worked */ }
  },

  systemInfo: null,
  systemHealth: null,
  systemError: null,
  systemLoading: false,
  loadSystem: async () => {
    set({ systemLoading: true, systemError: null });
    try {
      const [info, health, settings] = await Promise.all([
        fmbApi.systemInfo(), fmbApi.systemHealth(), fmbApi.systemGetSettings(),
      ]);
      set({ systemInfo: info, systemHealth: health, systemLoading: false });
      get().seedFromSettings(settings);
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
    try {
      const data = await fmbApi.systemGetSettings({});
      set({ loading: false, data, ts: Date.now() });
      // Seed the UI store so layout/theme reacts *before* the next paint.
      useUiStore.getState().seedFromSettings(data);
    } catch (e) {
      set({ loading: false, error: (e as { message?: string }).message ?? 'Failed to load settings' });
    }
  },
  patch: async (patch) => {
    const result = await fmbApi.systemSetSettings(patch);
    set({ data: result, ts: Date.now() });
    // Immediate UI side-effects for patched UI settings.
    const sync: Partial<Pick<MainSystemGetSettingsResult, 'ui.compact' | 'ui.collapsed'>> = {};
    if ('ui.compact' in patch || patch['ui.compact'] !== undefined) sync['ui.compact'] = result['ui.compact'];
    if ('ui.collapsed' in patch || patch['ui.collapsed'] !== undefined) sync['ui.collapsed'] = result['ui.collapsed'];
    if (Object.keys(sync).length > 0) {
      const prev = useUiStore.getState();
      useUiStore.getState().seedFromSettings({
        ['ui.compact']: sync['ui.compact'] ?? prev.uiCompact,
        ['ui.collapsed']: sync['ui.collapsed'] ?? prev.uiCollapsed,
      });
    }
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
