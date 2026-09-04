import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Set the app name early so userData path is always fairy-maid-brigade
// regardless of whether we're packaged or running via the raw Electron binary.
app.setName('fairy-maid-brigade');

// Portable storage layout MUST be applied BEFORE app.whenReady().
// Electron silently ignores setPath() calls after boot.
import { applyPortablePathsAndMigrate } from './core/runtime-paths';

const __RUNTIME_PATHS__ = (() => {
  try {
    return applyPortablePathsAndMigrate();
  } catch (e) {
    // If anything explodes, log to stderr and let the default paths kick in.
    // eslint-disable-next-line no-console
    console.error('[fmb] applyPortablePathsAndMigrate failed:', e);
    return null;
  }
})();

import { initDatabase, closeDatabase } from './core/db';
import { createLogger, setGlobalLogLevel } from './core/logger';
import { audit, newTraceId } from './core/audit';
import { initEventBus, getEventBus } from './core/event-bus';
import { initPluginService, getPluginService } from './core/plugin';
import { initWorkflowService, getWorkflowService } from './core/workflow/crud';
import { initSchedulerService, getSchedulerService } from './core/scheduler/service';
import { initQueueService, getQueueService } from './core/queue/service';
import { initErrorCalendarService, getErrorCalendarService } from './core/error-calendar/service';
import { registerIpcHandlers } from './core/ipc/handlers';
import { getLogsDir } from './core/logger';
import { initSettingsService, getSettingsService } from './core/settings/service';
import { TrayService } from './tray';
import { NotifyService, focusWindow } from './notify';
import { startHttpServer } from './http';
import type { HttpServerHandle } from './http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Write boot markers to userData (always writable) instead of the relative
// path inside app.asar (read-only in packaged mode → silent write failures
// → no diagnostic logs). In dev mode fall back to project root for convenience.
// If portable mode was applied, userData has already been redirected to
// fmb-data/userData so this naturally lands alongside the portable db.
const MARKER_FILE = (() => {
  try {
    return path.join(app.getPath('userData'), 'boot-markers.log');
  } catch {
    return path.join(__dirname, '../../boot-markers.log');
  }
})();

// --- Self-check mode (T20): launched by scripts/self-check.ps1 with
// `--self-check --fmb-self-check-marker=<path>`. In this mode we skip the GUI
// window, boot core services + HTTP API headlessly, and write
// `PORT=<port>\nTOKEN=<token>\n` to the marker path so the harness can
// discover and authenticate against the loopback API without touching the DB.
const SELF_CHECK_MODE = process.argv.includes('--self-check');
const SELF_CHECK_MARKER = (() => {
  const arg = process.argv.find((a) => a.startsWith('--fmb-self-check-marker='));
  return arg ? arg.slice('--fmb-self-check-marker='.length) : '';
})();
try { fs.unlinkSync(MARKER_FILE) } catch { /* noop */ }
function mk(tag: string, extra?: unknown): void {
  try {
    const line = `${new Date().toISOString()} ${tag} ${extra === undefined ? '' : JSON.stringify(extra)}\n`;
    fs.appendFileSync(MARKER_FILE, line, 'utf8');
  } catch { /* noop */ }
}
mk('APPLY_PATHS_MODE', {
  mode: __RUNTIME_PATHS__?.mode ?? 'legacy',
  portableRoot: __RUNTIME_PATHS__?.portableRoot ?? null,
  userData: __RUNTIME_PATHS__?.userData ?? null,
  migratedFrom: __RUNTIME_PATHS__?.migratedFrom ?? null,
});
mk('MAIN_MODULE_LOAD', { pid: process.pid, argv0: process.argv0, electronVer: process.versions.electron, nodeVer: process.versions.node });
process.on('uncaughtException', (err) => mk('UNCAUGHT', { name: err.name, message: err.message, stack: err.stack }));
process.on('unhandledRejection', (r) => mk('UNHANDLED', { reason: String(r) }));

// eslint-disable-next-line node/prefer-global/process
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

const FALLBACK_DEV_SERVER_URL = 'http://localhost:5173';

/**
 * The real main code now runs from two possible locations:
 *   - DEV:  `build/main-app/index.mjs` (esbuild ESM output, loaded via
 *           src/main/index.ts bootstrap) → two levels up from project root.
 *   - PACKAGED: eventually installed via electron-builder → alongside asar.
 *           (T19 will harden packaged paths; here we keep app.isPackaged branch robust).
 */
function projectRoot(): string {
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  // build/main-app/index.mjs → ../../ → project root
  return path.resolve(__dirname, '..', '..');
}

let mainWindow: BrowserWindow | null = null;
let bootTraceId: string = newTraceId();
let logger = createLogger('main'); // instantiated early; used in shutdown handler too
let isQuitting = false;
let trayService: TrayService | null = null;
let notifyService: NotifyService | null = null;
let httpHandle: HttpServerHandle | null = null;
function getMainWindow(): BrowserWindow | null { return mainWindow; }

function resolveRendererEntry(): { mode: 'url'; url: string } | { mode: 'file'; file: string } {
  if (!app.isPackaged) {
    // eslint-disable-next-line node/prefer-global/process
    const fromEnv = process.env['VITE_DEV_SERVER_URL'] || process.env.VITE_DEV_SERVER_URL;
    const url = (typeof fromEnv === 'string' && fromEnv.length > 0) ? fromEnv : FALLBACK_DEV_SERVER_URL;
    return { mode: 'url', url };
  }
  // Packaged: renderer sits inside app.asar at out/renderer/index.html.
  // app.getAppPath() resolves to <resources>/app.asar; loadFile reads asar
  // transparently. (Earlier code pointed at <exe>/resources/renderer/ which
  // is outside the asar and never existed → blank window.)
  return { mode: 'file', file: path.join(app.getAppPath(), 'out', 'renderer', 'index.html') };
}

function resolvePreloadPath(): string {
  if (app.isPackaged) {
    // Preload lives inside app.asar at out/preload/index.js. Electron loads
    // preload scripts from asar transparently.
    return path.join(app.getAppPath(), 'out', 'preload', 'index.js');
  }
  // Dev: electron-vite emits preload CJS bundle into out/preload/ relative to project root.
  return path.join(projectRoot(), 'out', 'preload', 'index.js');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Fairy Maid Brigade',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Packaged mode loads the renderer via `file://` loadFile(). Chromium's
      // default webSecurity=true enforces CORS on ES module scripts under
      // file:// (the file:// origin cannot serve CORS headers), which silently
      // blocks `<script type=module crossorigin>` → bundle never loads → blank
      // window. Disabling webSecurity for packaged mode allows file:// to load
      // ES modules transparently. Dev mode (http://localhost:5173) keeps
      // webSecurity=true because http origins serve CORS headers correctly.
      webSecurity: !app.isPackaged,
      preload: resolvePreloadPath(),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Close-to-tray: unless settings say 'quit' or we're already quitting, hide
  // the window instead of closing it so the app stays alive in the tray.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    let closeToTray = true;
    try {
      closeToTray = getSettingsService().get('system.closeBehavior') !== 'quit';
    } catch { /* settings not ready → default to tray */ }
    if (closeToTray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const entry = resolveRendererEntry();
  if (entry.mode === 'url') {
    const load = async (): Promise<void> => {
      try {
        await mainWindow?.loadURL(entry.url);
      } catch (err) {
        // Retry once against fallback URL if VITE_DEV_SERVER_URL was stale
        if (entry.url !== FALLBACK_DEV_SERVER_URL) {
          await mainWindow?.loadURL(FALLBACK_DEV_SERVER_URL);
          return;
        }
        throw err;
      }
    };
    void load();
  } else {
    void mainWindow.loadFile(entry.file);
  }

  // Diagnostic: confirm renderer actually mounted (blank-window debugging).
  const wc = mainWindow.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => mk('RENDERER_FAIL_LOAD', { code, desc, url, triedEntry: entry }));
  wc.on('did-finish-load', () => {
    mk('RENDERER_FINISH_LOAD', { url: wc.getURL(), isPackaged: app.isPackaged });
    wc.executeJavaScript(
      `(document.getElementById('root')?.children.length||0) + ':' + (document.body?.children.length||0)`,
    )
      .then((cnt: string) => mk('RENDERER_DOM', { rootChildren: cnt }))
      .catch((err: unknown) => mk('RENDERER_DOM_ERR', { msg: (err as Error).message }));
  });
  // DevTools auto-open only in development — packaged mode stays clean for end users.
  if (!app.isPackaged) {
    wc.on('dom-ready', () => {
      wc.openDevTools({ mode: 'detach' });
    });
  }
}

app.whenReady().then(() => {
  mk('APP_WHEN_READY_START');
  // 1) Infrastructure boot: Database + migrations + initial audit row
  const bootStart = Date.now();
  let dbInfo = { path: '', migrationsApplied: [] as string[] };
  try {
    dbInfo = initDatabase();
    mk('DB_INIT_OK', { dbPath: dbInfo.path, count: dbInfo.migrationsApplied.length });
  } catch (err) {
    mk('DB_INIT_ERR', { name: (err as Error).name, msg: (err as Error).message, stack: (err as Error).stack });
  }
  const bootTraceId = newTraceId();
  const logger = createLogger('main');
  logger.info(
    { bootTraceId, dbPath: dbInfo.path, migrationsApplied: dbInfo.migrationsApplied, tookMs: Date.now() - bootStart },
    'fmb infrastructure booted',
  );
  try {
    audit({
      action: 'app.boot',
      source: 'system',
      actor: 'system',
      payload: { appVersion: app.getVersion(), nodeVersion: process.versions.node, electronVersion: process.versions.electron, dbPath: dbInfo.path, migrationsApplied: dbInfo.migrationsApplied.length },
      traceId: bootTraceId,
    });
    mk('AUDIT_BOOT_OK');
  } catch (err) {
    mk('AUDIT_BOOT_ERR', { msg: (err as Error).message });
  }

  // --- Event bus + onReady extension point + core services + IPC ---
  try {
    const bus = initEventBus({ maxListeners: 64 });
    mk('EVENT_BUS_OK', { maxListeners: 64, extensionPoints: bus.registeredExtensionPoints.length });
    const pluginSvc = initPluginService();
    mk('PLUGIN_SERVICE_OK', { pluginsDir: pluginSvc.root });
    const workflowSvc = initWorkflowService(bus, pluginSvc);
    // Wire Host.workflows.create/start/get callbacks so app plugins create
    // workflows with owner_plugin_id auto-filled (enforced ownership contract).
    pluginSvc.setWorkflowCallbacks({
      create: (a) => workflowSvc.create({
        id: a.id,
        name: a.name,
        description: a.description,
        definition: a.definition as any,
        vars: a.vars,
        owner_plugin_id: a.owner_plugin_id,
      }) as unknown as Record<string, unknown>,
      start: async (workflowId, input) => {
        const r = await workflowSvc.run(workflowId, input);
        return { runId: r.id, status: r.status };
      },
      get: (id) => workflowSvc.getViewModel(id) as unknown as Record<string, unknown> | null,
    });
    mk('WORKFLOW_SERVICE_OK');
    const schedulerSvc = initSchedulerService(bus, workflowSvc);
    // Wire Host.schedules.create/toggle callbacks so app plugins can register
    // cron schedules (e.g. the watchdog plugin's */2 * * * * keepalive loop).
    pluginSvc.setScheduleCallbacks({
      create: (a) => schedulerSvc.create({
        id: a.id,
        name: a.name,
        cronExpr: a.cronExpr,
        oneShotAtMs: a.oneShotAtMs,
        workflowId: a.workflowId,
        input: a.input ?? {},
        enabled: a.enabled ?? true,
      }) as unknown as Record<string, unknown>,
      toggle: (id, enabled) => schedulerSvc.toggle(id, enabled) as unknown as Record<string, unknown> | null,
    });
    mk('SCHEDULER_SERVICE_OK');
    const queueSvc = initQueueService(bus);
    mk('QUEUE_SERVICE_OK');
    const errorCalSvc = initErrorCalendarService(bus);
    mk('ERROR_CALENDAR_SERVICE_OK');
    const _settingsSvc = initSettingsService();
    // Apply saved concurrency immediately so user preference beats default
    try { queueSvc.setConcurrency(_settingsSvc.get('queue.concurrency')); } catch { /* noop */ }
    // Apply saved global log level before the rest of boot so subsequent
    // subservices (http, tray, notify, worker) pick up the user's choice,
    // not the "info" default.
    try { setGlobalLogLevel(_settingsSvc.get('log.level')); } catch { /* noop */ }
    // Apply auto-start preference at boot so even if settings were edited
    // outside the settings UI (CLI / HTTP), it still gets respected.
    try {
      const open = _settingsSvc.get('system.autoStart') === 1;
      app.setLoginItemSettings({ openAtLogin: open, path: app.getPath('exe') });
    } catch { /* noop */ }
    mk('SETTINGS_SERVICE_OK');
    const bootTs = bootStart;
    const disposeIpc = registerIpcHandlers({
      services: {
        workflow: workflowSvc,
        scheduler: schedulerSvc,
        queue: queueSvc,
        errorCalendar: errorCalSvc,
      },
      bootTs,
      logsDir: getLogsDir(),
      pluginsDir: pluginSvc.root,
      get mainWindow() { return mainWindow; },
    });
    mk('IPC_HANDLERS_REGISTERED');
    // Start worker subsystems (non-blocking)
    try { schedulerSvc.start(); } catch (err) { mk('SCHEDULER_START_ERR', { msg: (err as Error).message }); }
    try { queueSvc.start(); } catch (err) { mk('QUEUE_START_ERR', { msg: (err as Error).message }); }
    void bus.safeEmit('app.onReady', {
      bootTraceId,
      appVersion: app.getVersion(),
      dbPath: dbInfo.path,
    }, { source: 'main.boot', traceId: bootTraceId }).then((res) => {
      mk('APP_ONREADY_FIRED', { listeners: res.totalListeners, errors: res.errors, durationMs: res.durationMs });
    });
    // Keep dispose referenced for shutdown
    (globalThis as any).__fmbDisposeIpc = disposeIpc;
  } catch (err) {
    mk('BOOT_SERVICES_ERR', { name: (err as Error).name, msg: (err as Error).message, stack: (err as Error).stack });
  }

  // In self-check mode we run headless (no BrowserWindow) so the harness can
  // drive the loopback HTTP API without a GUI session.
  if (!SELF_CHECK_MODE) {
    createWindow();
    mk('CREATE_WINDOW_CALLED');
  } else {
    mk('SELF_CHECK_MODE_SKIP_WINDOW');
  }

  // --- Task 13: system tray + Toast notifications ---
  try {
    trayService = new TrayService({
      getMainWindow,
      createWindow,
      pauseAll: () => {
        try { getQueueService().stop(); } catch (e) { mk('TRAY_PAUSE_QUEUE_ERR', { msg: (e as Error).message }); }
        try { getSchedulerService().stop(); } catch (e) { mk('TRAY_PAUSE_SCHED_ERR', { msg: (e as Error).message }); }
      },
      resumeAll: () => {
        try { getQueueService().start(); } catch (e) { mk('TRAY_RESUME_QUEUE_ERR', { msg: (e as Error).message }); }
        try { getSchedulerService().start(); } catch (e) { mk('TRAY_RESUME_SCHED_ERR', { msg: (e as Error).message }); }
      },
      logsDir: getLogsDir(),
    });
    trayService.start();
    mk('TRAY_SERVICE_OK');

    notifyService = new NotifyService({
      onActivate: () => focusWindow(getMainWindow()),
      getMinLevel: () => null, // default 'warn'; settings-driven toggle deferred
    });
    notifyService.start();
    mk('NOTIFY_SERVICE_OK');
  } catch (err) {
    mk('TRAY_NOTIFY_INIT_ERR', { name: (err as Error).name, msg: (err as Error).message, stack: (err as Error).stack });
  }

  // --- Task 15: Localhost HTTP API (loopback only, Bearer token) ---
  try {
    httpHandle = startHttpServer({ bootTs: bootStart });
    if (httpHandle) mk('HTTP_SERVER_OK', { port: httpHandle.port });
    else mk('HTTP_SERVER_NULL');
    // Self-check: expose port+token to the launching harness via the marker
    // file it supplied on the command line.
    if (SELF_CHECK_MODE && SELF_CHECK_MARKER && httpHandle) {
      try {
        fs.writeFileSync(
          SELF_CHECK_MARKER,
          `PORT=${httpHandle.port}\nTOKEN=${httpHandle.token}\n`,
          'utf8',
        );
        mk('SELF_CHECK_MARKER_WRITTEN', { path: SELF_CHECK_MARKER, port: httpHandle.port });
      } catch (err) {
        mk('SELF_CHECK_MARKER_ERR', { msg: (err as Error).message });
      }
    }
  } catch (err) {
    mk('HTTP_SERVER_ERR', { name: (err as Error).name, msg: (err as Error).message, stack: (err as Error).stack });
  }

  // Proactively clear the bootstrap keepalive interval (the bootstrap also
  // auto-clears it 1s after import resolves; explicit call ensures no 30s
  // timer lingers when the user exits the app).
  try { (globalThis as any).__fmbClearKeepalive?.(); } catch { /* noop */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // Allow windows to actually close (close handler otherwise hides to tray).
  isQuitting = true;
  try { notifyService?.dispose(); } catch { /* noop */ }
  try { trayService?.destroy(); } catch { /* noop */ }
  try { httpHandle?.close(); } catch { /* noop */ }
  mk('BEFORE_QUIT', { isQuitting });
});

app.on('window-all-closed', () => {
  // In self-check (headless) mode we deliberately never create a window, so
  // this event fires right after boot — but the harness still needs the HTTP
  // API alive. Do NOT quit; keep running until the harness sends /app/quit.
  if (SELF_CHECK_MODE) {
    mk('SELF_CHECK_WINDOW_ALL_CLOSED_IGNORED');
    return;
  }
  isQuitting = true;
  try {
    // Stop worker subsystems so queue/scheduler timers don't prevent clean exit
    try { getSchedulerService().stop(); } catch { /* noop */ }
    try { getQueueService().stop(); } catch { /* noop */ }
    // Dispose IPC handlers if registered
    try { (globalThis as any).__fmbDisposeIpc?.(); } catch { /* noop */ }
    try { notifyService?.dispose(); } catch { /* noop */ }
    try { trayService?.destroy(); } catch { /* noop */ }
    try { httpHandle?.close(); } catch { /* noop */ }
  } catch { /* noop */ }
  void getEventBus().safeEmit('app.beforeQuit', { exitCode: 0 }, { traceId: newTraceId(), source: 'main.shutdown' })
    .finally(() => {
      closeDatabase();
      logger.info({ bootTraceId }, 'fmb shutdown - database closed');
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
});
