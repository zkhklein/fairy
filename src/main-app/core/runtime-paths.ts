/**
 * Portable storage layout — redirects ALL application side effects (Electron
 * userData / cache / sessionData / userCache + our DB / logs / plugins /
 * HTTP meta / boot-markers) into `{exeDir}/fmb-data/` when the directory is
 * writable (portable mode). Falls back to default APPDATA paths when the
 * portable root cannot be written (e.g. installed under Program Files).
 *
 * Also performs one-time migration from legacy APPDATA/fairy-maid-brigade to
 * the portable tree on first boot.
 *
 * MUST be called BEFORE app.whenReady() because Electron caches setPath()
 * values internally and silently ignores changes after ready.
 */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  FMB_PORTABLE_DIR,
  FMB_PORTABLE_MARKER,
  FMB_LEGACY_APPDATA_DIR,
} from '@shared/project';

export type RuntimeMode = 'portable' | 'legacy';

export interface RuntimePathsResult {
  mode: RuntimeMode;
  portableRoot: string;         // {exeDir}/fmb-data or APPDATA/fairy-maid-brigade equivalent
  userData: string;             // Where Electron/user DB/token/boot-markers live
  logs: string;                 // pino logs dir (independent of userData)
  plugins: string;              // plugin extraction directory
  cache: string;                // Electron cache
  sessionData: string;
  userCache: string;
  migratedFrom?: string;        // Legacy APPDATA path if migration ran this boot
}

function defaultLegacyRoot(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, FMB_LEGACY_APPDATA_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', FMB_LEGACY_APPDATA_DIR);
  }
  return path.join(os.homedir(), '.config', FMB_LEGACY_APPDATA_DIR);
}

/**
 * Compute the candidate portable root. For packaged builds it sits next to
 * the executable; for dev we still use projectRoot/.data to keep things
 * identical to the pre-existing convention.
 */
export function resolvePortableRoot(projectRootFallback?: string): string {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), FMB_PORTABLE_DIR);
  }
  const root = projectRootFallback ?? process.cwd();
  return path.join(root, '.data');
}

function copyRecursiveSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/**
 * Write the portable marker so CLI (which runs outside Electron) can resolve
 * the correct userData/logs paths without guessing.
 */
function writeMarker(portableRoot: string): void {
  const marker = path.join(portableRoot, FMB_PORTABLE_MARKER);
  try {
    fs.writeFileSync(
      marker,
      JSON.stringify(
        { portableRoot, createdAt: Date.now(), version: 1 },
        null,
        2,
      ),
      'utf8',
    );
  } catch { /* best effort */ }
}

/**
 * Try to make {portableRoot} writable; return true if a test file can be
 * created and removed. Used as a gate before calling app.setPath() so we
 * don't accidentally redirect Electron to a read-only location.
 */
function isDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply portable storage layout.
 *
 * Ordering contract:
 *   1. Resolve candidate portable root.
 *   2. Ensure portableRoot candidate dirs exist (mkdir -p).
 *   3. Probe write access; if fails → return legacy mode with APPDATA paths.
 *   4. Try app.setPath('userData'|'cache'|'sessionData'|'userCache'|'logs').
 *      Even when app.isReady() is true (ESM hoisting / large bundle boot),
 *      we still create the portable directory tree + marker file so that
 *      downstream services (db / logger / plugin-loader) can find the
 *      portable root via the marker (marker-first resolution beats
 *      app.getPath()). This is the "belt and suspenders" for portable mode.
 *   5. Write marker, run legacy migration if needed.
 */
export function applyPortablePathsAndMigrate(opts?: { projectRoot?: string }): RuntimePathsResult {
  const appWasReady = app.isReady();

  const portableRoot = resolvePortableRoot(opts?.projectRoot);
  const legacyRoot = defaultLegacyRoot();

  const userDataDir = path.join(portableRoot, 'userData');
  const cacheDir = path.join(portableRoot, 'cache');
  const sessionDataDir = path.join(portableRoot, 'sessionData');
  const userCacheDir = path.join(portableRoot, 'userCache');
  const logsDir = path.join(portableRoot, 'logs');
  const pluginsDir = path.join(portableRoot, 'plugins');

  const wantPortable =
    // For dev: always portable to projectRoot/.data; write probe confirms.
    !app.isPackaged ||
    // For packaged: only portable if the exe-adjacent directory is writable.
    isDirWritable(portableRoot);

  if (!wantPortable) {
    // Legacy fallback: leave Electron's paths alone.
    return {
      mode: 'legacy',
      portableRoot: legacyRoot,
      userData: app.getPath('userData'),
      logs: path.join(app.getPath('userData'), 'logs'),
      plugins: path.join(app.getPath('userData'), 'plugins'),
      cache: (app.getPath as any)('cache') as string,
      sessionData: app.getPath('sessionData'),
      userCache: (app.getPath as any)('userCache') as string,
    };
  }

  // Ensure subdirs exist BEFORE calling setPath (Electron may mkdir on its
  // own but explicit mkdir avoids edge cases on network drives).
  for (const d of [portableRoot, userDataDir, cacheDir, sessionDataDir, userCacheDir, logsDir, pluginsDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* noop */ }
  }

  // Best-effort setPath. In packaged builds with ESM hoisting / large bundle
  // size, app may already be ready and setPath silently fails — but we
  // already wrote the portable tree, and the marker ensures downstream
  // services resolve to the right place.
  const warnIfReady = (field: string, err: unknown) => {
    if (appWasReady && err) {
      console.warn(`[fmb-runtime-paths] app.setPath(${field}) skipped because app is ready; marker fallback ensures ${portableRoot} is still used`);
    }
  };
  try { app.setPath('userData', userDataDir); } catch (e) { warnIfReady('userData', e); }
  try { (app.setPath as any)('cache', cacheDir); } catch (e) { warnIfReady('cache', e); }
  try { app.setPath('sessionData', sessionDataDir); } catch (e) { warnIfReady('sessionData', e); }
  try { (app.setPath as any)('userCache', userCacheDir); } catch (e) { warnIfReady('userCache', e); }
  try { app.setPath('logs', logsDir); } catch (e) { warnIfReady('logs', e); }

  writeMarker(portableRoot);

  // ---- One-time legacy → portable migration ----
  let migratedFrom: string | undefined;
  const hasLegacyDb = fs.existsSync(path.join(legacyRoot, 'fmb.db'));
  const hasPortableDb = fs.existsSync(path.join(userDataDir, 'fmb.db'));
  if (hasLegacyDb && !hasPortableDb) {
    try {
      copyRecursiveSync(legacyRoot, userDataDir);
      // Move legacy plugins (from userData/plugins) into the outer plugins dir
      const legacyPlugins = path.join(legacyRoot, 'plugins');
      if (fs.existsSync(legacyPlugins)) {
        copyRecursiveSync(legacyPlugins, pluginsDir);
      }
      // Move legacy main.log / logs into outer logs dir
      const legacyLogs = path.join(legacyRoot, 'logs');
      if (fs.existsSync(legacyLogs)) {
        copyRecursiveSync(legacyLogs, logsDir);
      }
      // ---- Post-migration tidy: avoid duplicate copies of plugins/logs inside
      // userData since the portable layout keeps those at fmb-data/<plugins|logs>/.
      const rmRfBestEffort = (p: string) => {
        try {
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
        } catch { /* best effort; Electron may still write here next boot if setPath
                    silently failed, but the marker-first resolution in downstream
                    services (db/logger/plugin-loader) ensures fmb-data root still wins.
                    */ }
      };
      rmRfBestEffort(path.join(userDataDir, 'plugins'));
      rmRfBestEffort(path.join(userDataDir, 'logs'));

      // Keep an audit trail of the migration by renaming the source folder.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const renamed = `${legacyRoot}.migrated-${stamp}`;
      try { fs.renameSync(legacyRoot, renamed); } catch { /* in-use on Windows; best effort */ }
      migratedFrom = legacyRoot;
    } catch {
      // Never crash boot on migration errors; fall through with partial state.
    }
  }

  return {
    mode: 'portable',
    portableRoot,
    userData: userDataDir,
    logs: logsDir,
    plugins: pluginsDir,
    cache: cacheDir,
    sessionData: sessionDataDir,
    userCache: userCacheDir,
    migratedFrom,
  };
}

/**
 * Resolution helper for non-Electron consumers (CLI, scripts). Reads the
 * marker file to locate the portable root, otherwise falls back to APPDATA.
 */
export function resolveRuntimePathsFromMarker(opts?: { projectRoot?: string }): RuntimePathsResult {
  const tryMarkers: string[] = [];

  // 1. Packaged: portable root next to fmb CLI's own .exe / sibling exe dir.
  try {
    if (process.execPath && process.execPath.includes(FMB_LEGACY_APPDATA_DIR) === false) {
      tryMarkers.push(path.join(path.dirname(process.execPath), FMB_PORTABLE_DIR, FMB_PORTABLE_MARKER));
    }
  } catch { /* noop */ }

  // 2. Explicit project root (dev mode)
  if (opts?.projectRoot) {
    tryMarkers.push(path.join(opts.projectRoot, '.data', FMB_PORTABLE_MARKER));
  }

  // 3. cwd (dev mode fallback)
  tryMarkers.push(path.join(process.cwd(), '.data', FMB_PORTABLE_MARKER));

  for (const markerPath of tryMarkers) {
    if (!fs.existsSync(markerPath)) continue;
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { portableRoot?: string };
      if (marker.portableRoot) {
        const root = marker.portableRoot;
        return {
          mode: 'portable',
          portableRoot: root,
          userData: path.join(root, 'userData'),
          logs: path.join(root, 'logs'),
          plugins: path.join(root, 'plugins'),
          cache: path.join(root, 'cache'),
          sessionData: path.join(root, 'sessionData'),
          userCache: path.join(root, 'userCache'),
        };
      }
    } catch { /* corrupted marker; skip */ }
  }

  const legacy = defaultLegacyRoot();
  return {
    mode: 'legacy',
    portableRoot: legacy,
    userData: legacy,
    logs: path.join(legacy, 'logs'),
    plugins: path.join(legacy, 'plugins'),
    cache: legacy,
    sessionData: legacy,
    userCache: legacy,
  };
}
