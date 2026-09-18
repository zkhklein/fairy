/**
 * PluginService — install/enable/disable/switch/uninstall plugins (zip-based).
 *
 * Uses RAW better-sqlite3 SYNCHRONOUS queries (via getRawDb()) because we only
 * do simple table access and want synchronous semantics for the plugin registry.
 * Kysely is async-only so we avoid it here to keep enable/disable/switchVersion
 * truly sequential and easier to reason about.
 *
 * Table columns — see 001_init.ts for schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import semver from 'semver';
import { nanoid } from 'nanoid';
import { app as electronApp } from 'electron';

import { createLogger } from '../logger';
import type { EventBusService } from '../event-bus';
import { getEventBus } from '../event-bus';
import { getRawDb } from '../db';
import { resolvePortableRootFromMarkers } from '../runtime-paths';

import type { PluginManifest, PluginType, ProblemDetails, HostApi } from '@shared/index';
import { PluginManifestSchema, toProblemDetails } from '@shared/index';
import { readManifestFromDir } from './manifest';
import { createSandbox, PermissionDeniedError, createPermissionedHostApi } from './sandbox';
import { buildHostApi, type HostApiServices } from './host-api';

const log = createLogger('plugin-loader');

// ---------------- public types ----------------
export interface InstalledDep {
  pluginId: string;
  version: string;
  action: 'installed' | 'overwritten' | 'skipped';
}
export interface BundledDepInfo {
  depId: string;
  version: string;
  name?: string;
  installedVersion?: string;
  status: 'new' | 'upgrade' | 'downgrade' | 'same';
  /** true when the installed version does NOT satisfy the main plugin's semver range */
  requiredOverwrite: boolean;
}
export interface InstallOptions {
  /** Dependency plugin ids (bundled inside an app zip) the user chose to overwrite. */
  overwriteDeps?: string[];
  /** Internal: force current_version promotion even on downgrade (explicit overwrite). */
  forcePromote?: boolean;
}
export interface InstallResult {
  ok: boolean;
  pluginId?: string;
  version?: string;
  installedDeps?: InstalledDep[];
  error?: ProblemDetails & { cleanup?: string[] };
}
export interface EnableResult { ok: boolean; instanceId?: string; error?: ProblemDetails; }
export interface DisableResult { ok: boolean; error?: ProblemDetails; }
export interface UninstallResult { ok: boolean; error?: ProblemDetails; }
export interface DepCheckResult {
  ok: boolean;
  missing: Array<{ depId: string; requested: string; reason: string }>;
  conflicts: Array<{ depId: string; requested: string; installed: string; reason: string }>;
  cycles: string[][];
}
export interface PluginInstance {
  instanceId: string;
  pluginId: string;
  version: string;
  type: PluginType;
  manifest: PluginManifest;
  sandbox: ReturnType<typeof createSandbox>;
  activateResult?: unknown;
}

type PathMsg = { path: (string | number)[]; message: string; code?: string };
function emptyErrors(): PathMsg[] { return []; }

// ---------------- Service ----------------
export class PluginService {
  private readonly pluginsRoot: string;
  private readonly bus: EventBusService;
  private readonly loadedInstances = new Map<string, PluginInstance>();
  // Wire WorkflowService callbacks once they become available post-boot, so
  // app plugins can use host.workflows.create() without cyclic imports.
  // NOTE: these are *synchronous* callbacks; the Promise-returning wrapping
  // (process.nextTick deferral) is done in buildHostSvcForPlugin() so the
  // sandbox async continuation never touches better-sqlite3 directly.
  private workflowCallbacks: {
    create?: (args: { id?: string; name: string; description?: string; definition: Record<string, unknown>; vars?: Record<string, unknown>; owner_plugin_id?: string | null; }) => Record<string, unknown>;
    start?: (workflowId: string, input?: Record<string, unknown>) => Promise<{ runId: string; status: string }>;
    get?: (id: string) => Record<string, unknown> | null;
  } = {};
  // Similarly for SchedulerService callbacks: create/toggle schedules.
  private scheduleCallbacks: {
    create?: (args: { id?: string; name: string; cronExpr?: string; oneShotAtMs?: number; workflowId: string; input?: Record<string, unknown>; enabled?: boolean; owner_plugin_id: string; }) => Record<string, unknown>;
    toggle?: (id: string, enabled: boolean) => Record<string, unknown> | null;
  } = {};

  setWorkflowCallbacks(cb: {
    create?: (args: { id?: string; name: string; description?: string; definition: Record<string, unknown>; vars?: Record<string, unknown>; owner_plugin_id?: string | null; }) => Record<string, unknown>;
    start?: (workflowId: string, input?: Record<string, unknown>) => Promise<{ runId: string; status: string }>;
    get?: (id: string) => Record<string, unknown> | null;
  }): void {
    this.workflowCallbacks = { ...this.workflowCallbacks, ...cb };
  }

  setScheduleCallbacks(cb: {
    create?: (args: { id?: string; name: string; cronExpr?: string; oneShotAtMs?: number; workflowId: string; input?: Record<string, unknown>; enabled?: boolean; owner_plugin_id: string; }) => Record<string, unknown>;
    toggle?: (id: string, enabled: boolean) => Record<string, unknown> | null;
  }): void {
    this.scheduleCallbacks = { ...this.scheduleCallbacks, ...cb };
  }

  constructor(opts?: { pluginsRoot?: string; eventBus?: EventBusService }) {
    this.bus = opts?.eventBus ?? getEventBus();
    try {
      if (opts?.pluginsRoot) {
        this.pluginsRoot = opts.pluginsRoot;
      } else {
        // --- Marker-first (plus SFX env-writable auto-portable) resolution
        // via SSOT in runtime-paths. Works even if ESM hoisting delayed the
        // bootstrap past app.isReady() so electronApp.setPath didn't reroute
        // userData.
        let portableRoot: string | undefined;
        try {
          portableRoot = resolvePortableRootFromMarkers({ autoPortableOnEnvWritable: true }) ?? undefined;
        } catch { /* noop */ }
        if (portableRoot) {
          this.pluginsRoot = path.join(portableRoot, 'plugins');
        } else {
          // Portable mode fallback: runtime-paths redirects setPath('userData'),
          // but the plugin directory is intentionally a sibling called `plugins`
          // under the portable root (cleaner layout than nesting inside userData).
          // We derive the portable root by going up once from userData if it
          // ends with /userData.
          const userData = electronApp.getPath('userData');
          const inferredRoot = userData.endsWith(path.sep + 'userData')
            ? path.dirname(userData)
            : userData;
          this.pluginsRoot = path.join(inferredRoot, 'plugins');
        }
      }
    } catch {
      this.pluginsRoot = opts?.pluginsRoot ?? path.resolve(process.cwd(), '.data', 'plugins');
    }
    fs.mkdirSync(this.pluginsRoot, { recursive: true });
    // Bootstrap rescan: (1) registers any plugins already on disk into SQLite (status='installed'
    // by default — the portable copy-paste behaviour), (2) marks plugins that have disappeared
    // from disk as 'disabled'. Runs at boot so a user that drops / removes plugins between runs
    // sees the correct state on first paint. Non-blocking: at this exact moment loadedInstances
    // is empty so pruneMissing does almost no I/O; the sideload is sync-only.
    void this.rescan().catch((e) => log.error({ err: String(e?.stack ?? e) }, 'constructor rescan failed'));
  }

  /**
   * Scan `pluginsRoot` for any `<id>@<version>/` directories that contain a
   * valid `manifest.json` matching the folder name, and register them into
   * the SQLite registry if they are missing. This enables the portable
   * "copy plugins folder and it just shows up" behaviour.
   *
   * Idempotent: plugins already in DB are NOT demoted in status. The version
   * row is INSERT OR IGNORE so repeated boots are cheap.
   *
   * @returns number of plugins freshly registered into `plugins` table this
   *          call (useful for TDD assertions).
   */
  sideloadFromDisk(): number {
    let registered = 0;
    try {
      const dirs = fs.readdirSync(this.pluginsRoot, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        // Skip internal/hidden folders: .tmp-* extract scratch, .DS_Store,
        // any dot-name dirs.
        if (d.name.startsWith('.')) continue;
        const match = /^(.+)@([^@]+)$/.exec(d.name);
        if (!match) continue;
        const [, dirId, dirVersion] = match;
        const fullDir = path.join(this.pluginsRoot, d.name);
        const parsed = readManifestFromDir(fullDir, { instance: `sideload:${d.name}` });
        if (!parsed.ok) {
          log.warn({ dir: fullDir, detail: parsed.error }, `sideload: skipping ${d.name} (bad manifest)`);
          continue;
        }
        const m = parsed.manifest;
        if (m.id !== dirId || m.version !== dirVersion) {
          log.warn(
            { dir: fullDir, manifestId: m.id, manifestVersion: m.version, dirId, dirVersion },
            `sideload: skipping ${d.name} (manifest id/version do not match directory name)`,
          );
          continue;
        }

        const existing = this.get(m.id);
        const now = Date.now();
        const perm = JSON.stringify(m.permissions ?? []);
        const deps = JSON.stringify(m.dependencies ?? {});
        const man = JSON.stringify(m);

        if (!existing) {
          // ── Fresh sideload: register a new plugins row (disabled by default via status='installed') ──
          this.raw()
            .prepare(
              `INSERT INTO plugins (id,name,type,description,current_version,status,permissions_json,dependencies_json,manifest_json,installed_at,updated_at)
               VALUES (@id,@name,@type,@desc,@version,'installed',@perm,@deps,@man,@t,@t)`,
            )
            .run({
              id: m.id,
              name: m.name,
              type: m.type,
              desc: m.description || '',
              version: m.version,
              perm,
              deps,
              man,
              t: now,
            });
          registered++;
          void this.bus
            .safeEmit(
              'plugin.afterInstall',
              {
                plugin: {
                  id: m.id,
                  name: m.name,
                  type: m.type,
                  description: m.description || '',
                  current_version: m.version,
                  status: 'installed',
                  permissions_json: perm,
                  dependencies_json: deps,
                  manifest_json: man,
                  installed_at: now,
                  updated_at: now,
                },
                pluginVersion: {
                  plugin_id: m.id,
                  version: m.version,
                  directory: fullDir,
                  installed_at: now,
                },
              },
              { source: 'plugin.service.sideload' },
            )
            .catch(() => {});
        } else {
          // ── Already registered. Only sync manifest/permissions/dependencies
          //    when this directory's version is current_version OR being
          //    promoted to current_version. Old version dirs MUST NOT
          //    overwrite manifest_json/permissions_json/dependencies_json —
          //    otherwise a stale @0.1.9 dir alphabetically ordered after
          //    @0.1.16 would silently revert permissions (e.g. drop
          //    schedules:create) while current_version stays 0.1.16.
          //    NEVER touch status.
          const cur: string | undefined = existing.current_version;
          const promote =
            !cur ||
            (semver.valid(cur) && semver.valid(m.version) && semver.gt(m.version, cur));
          const isCurrent = !promote && cur !== undefined && m.version === cur;
          if (promote || isCurrent) {
            this.raw()
              .prepare(
                `UPDATE plugins SET name=@name,type=@type,description=@desc,permissions_json=@perm,dependencies_json=@deps,manifest_json=@man,updated_at=@t` +
                  (promote ? `,current_version=@newver` : ``) +
                  ` WHERE id=@id`,
              )
              .run({
                id: m.id,
                name: m.name,
                type: m.type,
                desc: m.description || '',
                perm,
                deps,
                man,
                t: now,
                newver: m.version,
              });
          } else {
            // ── Old version dir (m.version < cur): keep manifest fields in
            //    sync with current_version. Only bump updated_at so we know
            //    the dir still exists on disk.
            this.raw()
              .prepare(`UPDATE plugins SET updated_at=@t WHERE id=@id`)
              .run({ id: m.id, t: now });
          }
        }

        // plugin_versions always track (INSERT OR IGNORE — PK = plugin_id+version).
        try {
          this.raw()
            .prepare(
              `INSERT OR IGNORE INTO plugin_versions (plugin_id,version,directory,installed_at) VALUES (?,?,?,?)`,
            )
            .run(m.id, m.version, fullDir, existing?.installed_at ?? now);
        } catch (e: any) {
          if (!String(e?.message || '').includes('UNIQUE')) throw e;
        }
      }
    } catch (e: any) {
      log.error({ err: String(e?.stack ?? e) }, 'sideloadFromDisk failed');
    }
    return registered;
  }

  /**
   * Combine "add new plugins on disk" + "mark missing plugins as disabled" into one
   * high-level rescan. This is the single entry point that both the constructor
   * (boot reconciliation) and `list()` (Refresh button in Plugins page) call so
   * every list refresh picks up newly dropped plugins and drops references to
   * plugins the user has just deleted from disk.
   *
   * @returns stats useful for TDD and logging.
   */
  async rescan(): Promise<{ newlyInstalled: number; newlyDisabled: number }> {
    const newlyInstalled = this.sideloadFromDisk();
    const newlyDisabled = await this.pruneMissing();
    if (newlyInstalled > 0 || newlyDisabled > 0) {
      log.info({ newlyInstalled, newlyDisabled }, 'plugin rescan complete');
    }
    return { newlyInstalled, newlyDisabled };
  }

  /**
   * Load all plugins whose DB status is 'enabled' into running sandboxes.
   * Called once at boot (after workflow/schedule callbacks are wired) so that
   * plugins the user enabled in a previous session are active again without
   * requiring a manual disable→enable cycle. Failures are logged but do not
   * abort boot.
   */
  async loadEnabledAtBoot(): Promise<{ loaded: number; failed: Array<{ id: string; error: string }> }> {
    const rows = this.raw()
      .prepare(`SELECT id, current_version FROM plugins WHERE status = 'enabled'`)
      .all() as Array<{ id: string; current_version: string }>;
    const failed: Array<{ id: string; error: string }> = [];
    let loaded = 0;
    for (const row of rows) {
      try {
        const r = await this.enablePlugin(row.id);
        if (r.ok) loaded++;
        else failed.push({ id: row.id, error: r.error?.detail ?? 'enable failed' });
      } catch (e: any) {
        failed.push({ id: row.id, error: e?.message ?? String(e) });
      }
    }
    if (loaded > 0 || failed.length > 0) {
      log.info({ loaded, failed: failed.length }, 'loadEnabledAtBoot complete');
    }
    return { loaded, failed };
  }

  /**
   * For each non-builtin plugin in SQLite, verify that the version folder
   * (`{pluginsRoot}/{id}@{current_version}/`) is still present on disk and has
   * a readable `manifest.json`. If not:
   *   - if status='enabled' → call `disablePlugin()` so the sandbox is torn
   *     down (call it "退出插件" from the user's perspective)
   *   - always SET status='disabled' in the DB so the UI paints a clear state
   *     ("插件文件缺失")
   *   - DB row is NEVER deleted here — workflows reference owner_plugin_id
   *     and a user might have just moved the folder temporarily.
   */
  private async pruneMissing(): Promise<number> {
    let newlyDisabled = 0;
    try {
      type Row = { id: string; status: 'installed' | 'enabled' | 'disabled'; current_version: string };
      const rows = this.raw()
        .prepare(`SELECT id, status, current_version FROM plugins`)
        .all() as Row[];

      for (const row of rows) {
        if (!row.current_version) continue;
        const expectedDir = path.join(this.pluginsRoot, `${row.id}@${row.current_version}`);
        const manifestOk =
          fs.existsSync(expectedDir) &&
          fs.existsSync(path.join(expectedDir, 'manifest.json'));
        if (manifestOk) continue;

        // Plugin vanished from disk.
        if (row.status === 'enabled') {
          try {
            log.info({ id: row.id, expectedDir }, `rescan: plugin missing on disk, auto-disabling (退出插件)`);
            await this.disablePlugin(row.id);
          } catch (e: any) {
            log.warn(
              { err: String(e?.stack ?? e), id: row.id },
              `rescan: disablePlugin() failed for missing plugin; forcing DB status anyway`,
            );
          }
        }
        if (row.status !== 'disabled') {
          this.raw()
            .prepare(`UPDATE plugins SET status = 'disabled', updated_at = ? WHERE id = ?`)
            .run(Date.now(), row.id);
          void this.bus.safeEmit(
            'plugin.statusChanged',
            { pluginId: row.id, from: row.status, to: 'disabled', reason: 'missing-on-disk' },
            { source: 'plugin.service.rescan' },
          );
          newlyDisabled++;
        } else if (this.loadedInstances.has(row.id)) {
          // safety: DB already said 'disabled' but instance still loaded (shouldn't happen,
          // but instance may have loaded via direct enable between our SELECT and now).
          try { await this.disablePlugin(row.id); } catch { /* best-effort */ }
        }
      }
    } catch (e: any) {
      log.error({ err: String(e?.stack ?? e) }, 'pruneMissing failed');
    }
    return newlyDisabled;
  }

  get root(): string { return this.pluginsRoot; }

  /**
   * Version-independent per-plugin store file (KV / secrets).
   *
   * Layout: `<pluginsRoot>/.kv/<id>.json` and `<pluginsRoot>/.secrets/<id>.json`.
   * Store files belong to the PLUGIN, not to one version — previously they lived
   * inside `<id>@<version>/`, so every version switch silently stranded the
   * plugin's saved config (baidu uploader lost its AppKey on upgrade this way).
   *
   * Legacy migration: on first access, if the new file is missing, all legacy
   * per-version stores (`.fmb-kv.json` / `.fmb-secrets.json` in installed
   * version dirs) are merged into it, oldest first so the freshest keys win.
   */
  private pluginStoreFile(pluginId: string, currentVersionDir: string, kind: 'kv' | 'secrets'): string {
    const dir = path.join(this.pluginsRoot, kind === 'kv' ? '.kv' : '.secrets');
    const target = path.join(dir, `${pluginId}.json`);
    if (!fs.existsSync(target)) {
      const legacyName = kind === 'kv' ? '.fmb-kv.json' : '.fmb-secrets.json';
      try {
        const dirs: string[] = [currentVersionDir];
        for (const v of this.listVersions(pluginId)) {
          if (v.directory && !dirs.includes(v.directory)) dirs.push(v.directory);
        }
        // Oldest installs first so the freshest keys win on merge. Merging (not
        // copying) matters: a newer version dir may hold a partial store (e.g.
        // runtime flags) while an older one carries the user's saved config.
        const ordered = this.listVersions(pluginId)
          .slice()
          .sort((a, b) => (a.installed_at || 0) - (b.installed_at || 0))
          .map((v) => v.directory as string)
          .filter(Boolean);
        const search = [...ordered, ...dirs.filter((d) => !ordered.includes(d))];
        const merged: Record<string, unknown> = {};
        let found = false;
        for (const d of search) {
          const legacy = path.join(d, legacyName);
          if (!fs.existsSync(legacy)) continue;
          try {
            const raw = fs.readFileSync(legacy, 'utf8').replace(/^﻿/, '');
            Object.assign(merged, JSON.parse(raw));
            found = true;
          } catch { /* skip unreadable legacy file */ }
        }
        if (found) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(target, JSON.stringify(merged, null, 2), 'utf8');
          log.info({ pluginId, to: target, kind }, 'migrated per-version store to version-independent file');
        }
      } catch (e: any) {
        log.warn({ err: String(e?.message ?? e), pluginId, kind }, 'pluginStoreFile legacy migration failed');
      }
    }
    return target;
  }

  // ---------------- raw DB helpers (sync) ----------------
  private raw() { return getRawDb(); }

  async list(q: { page?: number; pageSize?: number; status?: string; type?: string; q?: string } = {}): Promise<{ total: number; page: number; pageSize: number; items: any[] }> {
    // Plugin management page "Refresh" button calls main_plugin_list → this.list().
    // Always reconcile with disk first so newly dropped plugins show up and plugins
    // the user just deleted from pluginsRoot are exited (disabled).
    await this.rescan();
    const sql = `SELECT * FROM plugins WHERE 1=1` +
      (q.status ? ` AND status = @status` : ``) +
      (q.type ? ` AND type = @type` : ``) +
      (q.q ? ` AND (name LIKE @qlike OR id LIKE @qlike)` : ``) +
      ` ORDER BY updated_at DESC`;
    const params: any = { status: q.status, type: q.type, qlike: `%${q.q ?? ''}%` };
    const rows: any[] = this.raw().prepare(sql).all(params);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const start = (page - 1) * pageSize;
    return { total: rows.length, page, pageSize, items: rows.slice(start, start + pageSize) };
  }

  get(id: string): any {
    return this.raw().prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) ?? null;
  }

  listVersions(pluginId: string): any[] {
    return this.raw().prepare(
      `SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY installed_at DESC`,
    ).all(pluginId);
  }

  // ---------------- Install ----------------

  /**
   * Read the `bundled/*.zip` entries inside an extracted app-plugin directory.
   * Each nested zip is a full installable plugin package; only its
   * `manifest.json` entry is read (no extraction of the nested payload).
   * Returns info for the install confirmation UI (which deps are new, which
   * would overwrite an installed version) in a stable, deterministic order.
   */
  private readBundledDeps(extractedDir: string, mainManifest: PluginManifest): BundledDepInfo[] {
    const bundledDir = path.join(extractedDir, 'bundled');
    if (!fs.existsSync(bundledDir)) return [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(bundledDir).filter((f) => f.toLowerCase().endsWith('.zip')).sort();
    } catch { return []; }
    const declaredRanges = (mainManifest.dependencies ?? {}) as Record<string, string>;
    const out: BundledDepInfo[] = [];
    for (const f of files) {
      try {
        const zip = new AdmZip(path.join(bundledDir, f));
        const entry = zip.getEntry('manifest.json');
        if (!entry) continue;
        const m = JSON.parse(entry.getData().toString('utf8').replace(/^﻿/, ''));
        if (!m?.id || !m?.version) continue;
        const existing = this.get(String(m.id));
        const installedVersion: string | undefined = existing?.current_version;
        let status: BundledDepInfo['status'] = 'new';
        if (installedVersion) {
          if (semver.valid(installedVersion) && semver.valid(String(m.version))) {
            if (semver.eq(String(m.version), installedVersion)) status = 'same';
            else if (semver.gt(String(m.version), installedVersion)) status = 'upgrade';
            else status = 'downgrade';
          } else {
            status = String(m.version) === installedVersion ? 'same' : 'upgrade';
          }
        }
        const range = declaredRanges[String(m.id)];
        const requiredOverwrite =
          !!installedVersion &&
          status !== 'same' &&
          !!range &&
          !!semver.valid(installedVersion) &&
          !semver.satisfies(installedVersion, range);
        out.push({
          depId: String(m.id),
          version: String(m.version),
          name: typeof m.name === 'string' ? m.name : undefined,
          installedVersion,
          status,
          requiredOverwrite,
        });
      } catch (e: any) {
        log.warn({ err: String(e?.message ?? e), file: f }, 'readBundledDeps: skipping unreadable bundled zip');
      }
    }
    return out;
  }

  /**
   * Dry-run pre-install check: validates zip integrity + manifest schema +
   * version comparison vs. currently installed version + dependency check.
   * App-plugin zips may embed their dependency closure under `bundled/*.zip`;
   * those are surfaced via `bundledDeps` and make the corresponding declared
   * dependencies satisfiable (they no longer count as missing/conflict).
   * Never writes DB nor filesystem beyond a tmp directory (cleaned up on exit).
   * Used by the UI install confirmation modal to show per-zip statuses before
   * committing to the actual install.
   */
  async preInstallCheckFromZip(
    zipPath: string,
  ): Promise<{
    ok: boolean;
    manifest?: PluginManifest;
    versionStatus?: 'new' | 'upgrade' | 'downgrade' | 'same';
    installedVersion?: string;
    depCheck: DepCheckResult;
    bundledDeps: BundledDepInfo[];
    errors: Array<{ code?: string; message: string; detail?: unknown }>;
  }> {
    const tmpDir = path.join(this.pluginsRoot, `.pre-${nanoid(8)}`);
    const empty: BundledDepInfo[] = [];
    try {
      const errors: Array<{ code?: string; message: string; detail?: unknown }> = [];
      let manifest: PluginManifest | undefined;
      // 1. zip integrity + extract manifest dir + parse
      try {
        const zip = new AdmZip(zipPath);
        fs.mkdirSync(tmpDir, { recursive: true });
        zip.extractAllTo(tmpDir, true);
      } catch (e: any) {
        errors.push({ code: 'zip.extract_failed', message: e?.message ?? 'Zip extract failed', detail: zipPath });
        return { ok: false, depCheck: { ok: false, missing: [], conflicts: [], cycles: [] }, bundledDeps: empty, errors };
      }
      const parsed = readManifestFromDir(tmpDir, { instance: zipPath });
      if (!parsed.ok) {
        errors.push({ code: 'manifest.invalid', message: parsed.error?.detail ?? parsed.error?.title ?? 'Invalid manifest', detail: parsed.error });
        return { ok: false, depCheck: { ok: false, missing: [], conflicts: [], cycles: [] }, bundledDeps: empty, errors };
      }
      manifest = parsed.manifest;

      // 2. version status vs DB
      const existing = this.get(manifest.id);
      const installedVersion = existing?.current_version;
      let versionStatus: 'new' | 'upgrade' | 'downgrade' | 'same' = 'new';
      if (installedVersion) {
        if (semver.valid(installedVersion) && semver.valid(manifest.version)) {
          if (semver.eq(manifest.version, installedVersion)) versionStatus = 'same';
          else if (semver.gt(manifest.version, installedVersion)) versionStatus = 'upgrade';
          else versionStatus = 'downgrade';
        } else if (manifest.version === installedVersion) {
          versionStatus = 'same';
        } else {
          // non-semver: treat as same when equal else new-install-ish (upgrade)
          versionStatus = manifest.version === installedVersion ? 'same' : 'upgrade';
        }
      }

      // 2b. bundled dependency closure (app zips)
      const bundledDeps = this.readBundledDeps(tmpDir, manifest);
      const bundledSatisfies = new Map<string, string>();
      for (const b of bundledDeps) bundledSatisfies.set(b.depId, b.version);

      // 3. dependency check — bundled versions count as available
      const depCheck = this.parseDependencies(manifest.dependencies ?? {}, { forManifest: manifest });
      const declared = manifest.dependencies ?? {};
      depCheck.missing = depCheck.missing.filter((m) => {
        const bv = bundledSatisfies.get(m.depId);
        return !(bv && (!semver.valid(bv) || semver.satisfies(bv, declared[m.depId] ?? '*')));
      });
      depCheck.conflicts = depCheck.conflicts.filter((c) => {
        const bv = bundledSatisfies.get(c.depId);
        return !(bv && (!semver.valid(bv) || semver.satisfies(bv, declared[c.depId] ?? '*')));
      });
      depCheck.ok = depCheck.missing.length + depCheck.conflicts.length + depCheck.cycles.length === 0;
      for (const m of depCheck.missing) errors.push({ code: 'dep.missing', message: m.reason, detail: { depId: m.depId, requested: m.requested } });
      for (const c of depCheck.conflicts) errors.push({ code: 'dep.conflict', message: c.reason, detail: { depId: c.depId, requested: c.requested, installed: c.installed } });
      for (const cycle of depCheck.cycles) errors.push({ code: 'dep.cycle', message: `Dependency cycle: ${cycle.join(' → ')}`, detail: cycle });

      return {
        ok: depCheck.ok && errors.length === 0,
        manifest,
        versionStatus,
        installedVersion,
        depCheck,
        bundledDeps,
        errors,
      };
    } finally {
      if (fs.existsSync(tmpDir)) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }

  /**
   * Install multiple zips sequentially. Optionally auto-enable each on success.
   * The caller can control auto-enable to avoid surprises (e.g. dependency
   * chains requiring deterministic enable order are handled by pre-install
   * checks rather than this method).
   *
   * App-plugin zips may embed dependency zips under `bundled/`. Those are
   * installed (or skipped / overwritten per `overwriteDeps`) BEFORE the main
   * plugin, and when `autoEnable` is on the bundled deps are enabled first so
   * the app plugin's cross-plugin invoke works immediately.
   */
  async installBatch(args: { zipPaths: string[]; autoEnable?: boolean; overwriteDeps?: string[] }): Promise<{
    results: Array<{
      zipPath: string; ok: boolean; pluginId?: string; version?: string; autoEnabled?: boolean;
      installedDeps: InstalledDep[];
      errors: Array<{ code?: string; message: string; detail?: unknown }>;
    }>;
  }> {
    type BatchResultItem = {
      zipPath: string; ok: boolean; pluginId?: string; version?: string; autoEnabled?: boolean;
      installedDeps: InstalledDep[];
      errors: Array<{ code?: string; message: string; detail?: unknown }>;
    };
    const results: BatchResultItem[] = [];
    for (const zipPath of args.zipPaths) {
      const installed = await this.installFromZip(zipPath, { overwriteDeps: args.overwriteDeps ?? [] });
      if (!installed.ok) {
        results.push({
          zipPath,
          ok: false,
          installedDeps: installed.installedDeps ?? [],
          errors: [{
            code: (installed.error as any)?.code,
            message: installed.error?.detail ?? installed.error?.title ?? 'Install failed',
            detail: installed.error,
          }],
        });
        continue;
      }
      let autoEnabled = false;
      const errors: BatchResultItem['errors'] = [];
      const installedDeps = installed.installedDeps ?? [];
      if (args.autoEnable) {
        // Enable bundled deps first (install/overwrite/keep order preserved),
        // so the main plugin's plugins.invoke targets are alive.
        for (const dep of installedDeps) {
          try {
            const en = await this.enablePlugin(dep.pluginId);
            if (!en.ok) {
              errors.push({
                code: 'dep_enable_failed',
                message: `${dep.pluginId}: ${en.error?.detail ?? en.error?.title ?? 'Enable failed'}`,
                detail: en.error,
              });
            }
          } catch (e: any) {
            errors.push({ code: 'dep_enable_failed', message: `${dep.pluginId}: ${e?.message ?? 'Enable failed'}`, detail: String(e) });
          }
        }
      }
      if (args.autoEnable && installed.pluginId) {
        try {
          const en = await this.enablePlugin(installed.pluginId!);
          if (!en.ok) {
            errors.push({
              code: 'enable_failed',
              message: en.error?.detail ?? en.error?.title ?? 'Enable failed',
              detail: en.error,
            });
          } else {
            autoEnabled = true;
          }
        } catch (e: any) {
          errors.push({ code: 'enable_failed', message: e?.message ?? 'Enable failed', detail: String(e) });
        }
      }
      results.push({
        zipPath,
        ok: true,
        pluginId: installed.pluginId,
        version: installed.version,
        autoEnabled,
        installedDeps,
        errors,
      });
    }
    return { results };
  }

  /**
   * Install the dependency zips bundled under `<extractedDir>/bundled/`.
   * Order is topological (a bundled dep that itself depends on another bundled
   * dep is installed after it). Decision per dep:
   *   - not installed            → install
   *   - same version installed   → skip
   *   - different version + depId ∈ overwriteDeps → overwrite install
   *     (forcePromote so an explicit downgrade also becomes current)
   *   - different version + NOT chosen → keep existing IF it satisfies the
   *     declared semver range, otherwise the whole install fails.
   */
  private async installBundledDeps(
    extractedDir: string,
    mainManifest: PluginManifest,
    overwriteDeps: string[],
    cleanupPaths: string[],
  ): Promise<{ ok: boolean; installedDeps: InstalledDep[]; error?: ProblemDetails & { cleanup?: string[] } }> {
    const bundledDir = path.join(extractedDir, 'bundled');
    const installedDeps: InstalledDep[] = [];
    if (!fs.existsSync(bundledDir)) return { ok: true, installedDeps };
    const files = fs.readdirSync(bundledDir).filter((f) => f.toLowerCase().endsWith('.zip')).sort();
    if (files.length === 0) return { ok: true, installedDeps };

    // Read each bundled manifest (entry-only, no extraction).
    const items: Array<{ zipPath: string; id: string; version: string; deps: string[] }> = [];
    for (const f of files) {
      const zipPath = path.join(bundledDir, f);
      try {
        const zip = new AdmZip(zipPath);
        const entry = zip.getEntry('manifest.json');
        if (!entry) continue;
        const m = JSON.parse(entry.getData().toString('utf8').replace(/^﻿/, ''));
        if (!m?.id || !m?.version) continue;
        items.push({ zipPath, id: String(m.id), version: String(m.version), deps: Object.keys(m.dependencies ?? {}) });
      } catch { /* unreadable bundled zips were already surfaced in precheck; skip */ }
    }

    // Topo-sort among bundled items (deps first). Cycle-safe: falls back to
    // lexical order remainder (precheck's cycle detection covers the real graph).
    const byId = new Map(items.map((it) => [it.id, it]));
    const ordered: typeof items = [];
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (it: (typeof items)[number]): void => {
      if (done.has(it.id) || visiting.has(it.id)) return;
      visiting.add(it.id);
      for (const d of it.deps) {
        const target = byId.get(d);
        if (target) visit(target);
      }
      visiting.delete(it.id);
      done.add(it.id);
      ordered.push(it);
    };
    for (const it of items) visit(it);

    const declared = (mainManifest.dependencies ?? {}) as Record<string, string>;
    for (const it of ordered) {
      const existing = this.get(it.id);
      const installedVersion: string | undefined = existing?.current_version;
      const range = declared[it.id] ?? '*';

      if (installedVersion) {
        const sameVer = semver.valid(installedVersion) && semver.valid(it.version)
          ? semver.eq(it.version, installedVersion)
          : it.version === installedVersion;
        if (sameVer) {
          installedDeps.push({ pluginId: it.id, version: installedVersion, action: 'skipped' });
          continue;
        }
        if (!overwriteDeps.includes(it.id)) {
          // User kept the existing installation — acceptable only if it
          // satisfies the main plugin's declared range.
          const satisfied = !semver.valid(installedVersion) || semver.satisfies(installedVersion, range);
          if (satisfied) {
            installedDeps.push({ pluginId: it.id, version: installedVersion, action: 'skipped' });
            continue;
          }
          return {
            ok: false,
            installedDeps,
            error: {
              type: 'https://fmb.dev/problems/dependency-check-failed',
              title: 'Dependency / Validation Failed',
              status: 400,
              detail: `依赖 ${it.id} 已安装 v${installedVersion}，不满足 ${range}；请在安装确认中勾选覆盖该依赖。`,
              errors: [{ code: 'dep.conflict', message: `${it.id}@${range} required, installed ${installedVersion}, overwrite not selected` } as any],
              cleanup: cleanupPaths,
            },
          };
        }
      }

      const r = await this.installFromZip(it.zipPath, { forcePromote: overwriteDeps.includes(it.id) });
      if (!r.ok) {
        return {
          ok: false,
          installedDeps,
          error: {
            ...(r.error ?? {
              type: 'https://fmb.dev/problems/dependency-check-failed',
              title: 'Dependency install failed', status: 400, detail: `bundled dep ${it.id} install failed`, errors: [],
            }),
            cleanup: cleanupPaths,
          },
        };
      }
      installedDeps.push({
        pluginId: it.id,
        version: it.version,
        action: installedVersion ? 'overwritten' : 'installed',
      });
    }
    return { ok: true, installedDeps };
  }

  async installFromZip(zipPath: string, opts?: InstallOptions): Promise<InstallResult> {
    const tmpDir = path.join(this.pluginsRoot, `.tmp-${nanoid(8)}`);
    const cleanupPaths: string[] = [tmpDir];
    try {
      // Use the dry-run pre-check for manifest + dep validation to keep this
      // method's behavior consistent with the UI preview surface.
      const pre = await this.preInstallCheckFromZip(zipPath);
      if (!pre.manifest) {
        return {
          ok: false,
          error: {
            type: 'https://fmb.dev/problems/manifest-invalid',
            title: 'Manifest invalid',
            status: 400,
            detail: pre.errors.map((e) => e.message).join('; '),
            errors: pre.errors as any,
            instance: zipPath,
            cleanup: cleanupPaths,
          },
        };
      }
      if (!pre.ok) {
        return {
          ok: false,
          error: {
            type: 'https://fmb.dev/problems/dependency-check-failed',
            title: 'Dependency / Validation Failed',
            status: 400,
            detail: pre.errors.map((e) => e.message).join('; '),
            errors: pre.errors as any,
            instance: zipPath,
            cleanup: cleanupPaths,
          },
        };
      }
      const manifest = pre.manifest;
      // Re-extract into tmpDir (preInstallCheck wiped its tmp dir)
      const zip = new AdmZip(zipPath);
      fs.mkdirSync(tmpDir, { recursive: true });
      zip.extractAllTo(tmpDir, true);

      try {
        await this.bus.safeEmit('plugin.beforeInstall', { manifest, sourceZip: zipPath }, { source: 'plugin.service', strict: true });
      } catch (e: any) {
        return {
          ok: false,
          error: { type: 'about:blank', title: 'Installation Vetoed', status: 409, detail: e?.message ?? String(e), errors: emptyErrors(), cleanup: cleanupPaths },
        };
      }

      // App-plugin zips may embed their dependency closure under bundled/.
      // Install those FIRST (nested zip paths live inside tmpDir, which the
      // rename below would otherwise move away).
      const bundled = await this.installBundledDeps(tmpDir, manifest, opts?.overwriteDeps ?? [], cleanupPaths);
      if (!bundled.ok) {
        return { ok: false, installedDeps: bundled.installedDeps, error: bundled.error };
      }

      const targetDir = path.join(this.pluginsRoot, `${manifest.id}@${manifest.version}`);
      cleanupPaths.push(targetDir);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, targetDir);
      // Deps now live in their own plugin dirs; drop the embedded copies so the
      // installed app directory stays lean.
      const installedBundledDir = path.join(targetDir, 'bundled');
      if (fs.existsSync(installedBundledDir)) {
        try { fs.rmSync(installedBundledDir, { recursive: true, force: true }); } catch { /* noop */ }
      }

      // T12-B: compile app plugin renderer to renderer.umd.js via esbuild (if available).
      if (manifest.type === 'app' && manifest.renderer) {
        await this.compileRendererIfApp(targetDir, manifest);
      }

      const now = Date.now();
      const existing = this.get(manifest.id);
      const permissionsJson = JSON.stringify(manifest.permissions ?? []);
      const depsJson = JSON.stringify(manifest.dependencies ?? {});
      const manifestJson = JSON.stringify(manifest);

      if (!existing) {
        this.raw().prepare(`INSERT INTO plugins (id,name,type,description,current_version,status,permissions_json,dependencies_json,manifest_json,installed_at,updated_at) VALUES (@id,@name,@type,@description,@current_version,'installed',@perm,@deps,@man,@t,@t)`).run({
          id: manifest.id, name: manifest.name, type: manifest.type, description: manifest.description || '',
          current_version: manifest.version, perm: permissionsJson, deps: depsJson, man: manifestJson, t: now,
        });
      } else {
        const cur: string | undefined = existing.current_version;
        const promote = !!opts?.forcePromote || !cur || (semver.valid(cur) && semver.valid(manifest.version) && semver.gt(manifest.version, cur));
        this.raw().prepare(`UPDATE plugins SET name=@name,type=@type,description=@desc,permissions_json=@perm,dependencies_json=@deps,manifest_json=@man,updated_at=@t` + (promote ? `,current_version=@newver` : ``) + ` WHERE id=@id`).run({
          id: manifest.id, name: manifest.name, type: manifest.type, desc: manifest.description || '',
          perm: permissionsJson, deps: depsJson, man: manifestJson, t: now, newver: manifest.version,
        });
      }

      try {
        this.raw().prepare(`INSERT INTO plugin_versions (plugin_id,version,directory,installed_at) VALUES (?,?,?,?)`).run(manifest.id, manifest.version, targetDir, now);
      } catch (e: any) {
        if (!String(e?.message || '').includes('UNIQUE')) throw e;
      }

      void this.bus.safeEmit('plugin.afterInstall', {
        plugin: {
          id: manifest.id, name: manifest.name, type: manifest.type, description: manifest.description || '',
          current_version: manifest.version, status: 'installed', permissions_json: permissionsJson,
          dependencies_json: depsJson, manifest_json: manifestJson, installed_at: now, updated_at: now,
        },
        pluginVersion: { plugin_id: manifest.id, version: manifest.version, directory: targetDir, installed_at: now },
      }, { source: 'plugin.service' }).catch(() => {});

      return { ok: true, pluginId: manifest.id, version: manifest.version, installedDeps: bundled.installedDeps };
    } catch (err) {
      for (const p of cleanupPaths) try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      const pd = toProblemDetails(err, { status: 500, instance: zipPath });
      return { ok: false, error: { ...pd, cleanup: cleanupPaths } };
    } finally {
      if (fs.existsSync(tmpDir)) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ---------------- Dependencies ----------------
  parseDependencies(deps: Record<string, string>, ctx: { forManifest?: PluginManifest } = {}): DepCheckResult {
    const missing: DepCheckResult['missing'] = [];
    const conflicts: DepCheckResult['conflicts'] = [];
    const cycles: DepCheckResult['cycles'] = [];
    const rows = this.raw().prepare(`SELECT plugin_id, version FROM plugin_versions`).all() as Array<{ plugin_id: string; version: string }>;
    const installed = new Map<string, string[]>();
    for (const r of rows) {
      const list = installed.get(r.plugin_id) ?? []; list.push(r.version); installed.set(r.plugin_id, list);
    }
    for (const [depId, range] of Object.entries(deps)) {
      const versions = installed.get(depId);
      if (!versions || versions.length === 0) {
        missing.push({ depId, requested: range, reason: `${depId} is not installed` });
        continue;
      }
      const ok = versions.filter(v => !!semver.valid(v) && semver.satisfies(v, range));
      if (ok.length === 0) {
        const sorted = versions.slice().sort(semver.rcompare);
        conflicts.push({ depId, requested: range, installed: sorted[0]!, reason: `no version satisfies ${range} (installed: ${sorted.join(', ')})` });
      }
    }
    if (ctx.forManifest) {
      const visited = new Set<string>();
      const stack: string[] = [];
      const dfs = (id: string) => {
        const idx = stack.indexOf(id);
        if (idx !== -1) { cycles.push([...stack.slice(idx), id]); return; }
        if (visited.has(id)) return;
        stack.push(id);
        const latest = (installed.get(id) ?? []).filter((v): v is string => !!semver.valid(v)).sort(semver.rcompare)[0];
        let manifest: any = null;
        if (latest) {
          const row = this.raw().prepare(`SELECT directory FROM plugin_versions WHERE plugin_id = ? AND version = ?`).get(id, latest) as { directory: string } | undefined;
          if (row) {
            const parsed = readManifestFromDir(row.directory);
            manifest = parsed.ok ? parsed.manifest : null;
          }
        }
        if (manifest?.dependencies) {
          for (const next of Object.keys(manifest.dependencies as Record<string, string>)) dfs(next);
        }
        stack.pop();
        visited.add(id);
      };
      for (const depId of Object.keys(ctx.forManifest.dependencies ?? {})) dfs(depId);
    }
    return { ok: missing.length + conflicts.length + cycles.length === 0, missing, conflicts, cycles };
  }

  // ---------------- Enable ----------------
  async enablePlugin(id: string, version?: string): Promise<EnableResult> {
    const plugin = this.get(id);
    if (!plugin) return { ok: false, error: { type: 'about:blank', title: 'Not Found', status: 404, detail: `plugin ${id} not installed`, errors: emptyErrors() } };
    const targetVersion = version ?? plugin.current_version;
    if (!targetVersion) return { ok: false, error: { type: 'about:blank', title: 'No Version', status: 400, detail: `${id} has no version`, errors: emptyErrors() } };
    const pvRow = this.raw().prepare(`SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?`).get(id, targetVersion) as { plugin_id: string; version: string; directory: string } | undefined;
    if (!pvRow) return { ok: false, error: { type: 'about:blank', title: 'Not Found', status: 404, detail: `${id}@${targetVersion} not on disk`, errors: emptyErrors() } };

    const manParsed = readManifestFromDir(pvRow.directory, { instance: `enable:${id}@${targetVersion}` });
    if (!manParsed.ok) return { ok: false, error: manParsed.error };
    const manifest = manParsed.manifest;

    if (this.loadedInstances.has(id)) await this.disablePlugin(id);

    const mainPath = path.join(pvRow.directory, manifest.main);
    if (!fs.existsSync(mainPath)) return {
      ok: false,
      error: {
        type: 'https://fmb.dev/problems/plugin-main-missing',
        title: 'Plugin main missing', status: 422,
        detail: `File not found: ${mainPath}`,
        errors: [{ path: ['main'], message: `manifest.main=${manifest.main} not found`, code: 'file.missing' }],
      },
    };
    const sourceCode = fs.readFileSync(mainPath, 'utf8');

    const hostSvc: HostApiServices = {
      eventBus: this.bus,
      pluginService: this,
      selfManifest: manifest,
      // Defer synchronous better-sqlite3 / scheduler operations to the main
      // process event loop via process.nextTick. Calling these directly inside
      // a vm.Script sandbox async continuation crashes the native module
      // (V8 context mismatch, 0xC0000005 access violation).
      onCreateWorkflow: (a) => new Promise((resolve, reject) => {
        process.nextTick(() => {
          try {
            resolve(this.workflowCallbacks.create?.(a) ?? {});
          } catch (e: any) {
            log.error({ err: String(e?.stack ?? e), pluginId: id }, 'onCreateWorkflow deferred callback failed');
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }),
      onStartWorkflow: (wfId, input) => new Promise((resolve, reject) => {
        process.nextTick(() => {
          try { resolve(this.workflowCallbacks.start?.(wfId, input) ?? { runId: '', status: 'pending' }); }
          catch (e: any) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
      }),
      onGetWorkflow: (wfId) => new Promise((resolve, reject) => {
        process.nextTick(() => {
          try { resolve(this.workflowCallbacks.get?.(wfId) ?? null); }
          catch (e: any) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
      }),
      onCreateSchedule: (a) => new Promise((resolve, reject) => {
        process.nextTick(() => {
          try {
            resolve(this.scheduleCallbacks.create?.(a) ?? {});
          } catch (e: any) {
            log.error({ err: String(e?.stack ?? e), pluginId: id }, 'onCreateSchedule deferred callback failed');
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }),
      onToggleSchedule: (schedId, enabled) => new Promise((resolve, reject) => {
        process.nextTick(() => {
          try {
            resolve(this.scheduleCallbacks.toggle?.(schedId, enabled) ?? null);
          } catch (e: any) {
            log.error({ err: String(e?.stack ?? e), pluginId: id }, 'onToggleSchedule deferred callback failed');
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }),
      onAudit: (a) => {
        try {
          // audit_logs.source CHECK IN ('ui','cli','http','system','plugin'); use just 'plugin'
          const info = this.raw().prepare(`INSERT INTO audit_logs (action,source,actor,payload_json,trace_id,created_at) VALUES (?,?,?,?,?,?)`).run(
            a.action, 'plugin', a.actor, a.payload != null ? JSON.stringify(a.payload) : null, a.traceId ?? null, Date.now(),
          );
          return Number((info as any).lastInsertRowid ?? Date.now());
        } catch (e) { log.warn({ err: String(e) }, 'plugin onAudit insert failed'); return -1; }
      },
      onError: (e) => {
        try {
          // Schema columns: level, source, message, stack, metadata_json, trace_id, resolved(default 0), created_at
          this.raw().prepare(`INSERT INTO error_logs (level,source,message,stack,trace_id,created_at) VALUES (?,?,?,?,?,?)`).run(
            e.level, e.source, e.message, e.stack ?? null, e.traceId ?? null, Date.now(),
          );
        } catch (err) { log.warn({ err: String(err) }, 'plugin onError insert failed'); }
      },
      onSecretGet: (key) => {
        const f = this.pluginStoreFile(id, pvRow.directory, 'secrets');
        if (!fs.existsSync(f)) return null;
        try { return JSON.parse(fs.readFileSync(f, 'utf8'))[key] ?? null; } catch { return null; }
      },
      onSecretSet: (key, value) => {
        const f = this.pluginStoreFile(id, pvRow.directory, 'secrets');
        const obj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
        obj[key] = value;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(obj, null, 2), { mode: 0o600 });
        return { id: 0, key, value, scope: 'plugin' };
      },
      onSecretDelete: () => true,
      onKvGet: (key, global) => {
        const f = global ? path.join(this.pluginsRoot, '.fmb-kv-global.json') : this.pluginStoreFile(id, pvRow.directory, 'kv');
        if (!fs.existsSync(f)) return null;
        try {
          // Strip a leading UTF-8 BOM if present (PowerShell's Set-Content -Encoding UTF8
          // writes one; Node's JSON.parse rejects a leading U+FEFF on string input).
          const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
          return JSON.parse(raw)[key] ?? null;
        } catch { return null; }
      },
      onKvSet: (key, value, global) => {
        const f = global ? path.join(this.pluginsRoot, '.fmb-kv-global.json') : this.pluginStoreFile(id, pvRow.directory, 'kv');
        let obj = {} as Record<string, unknown>;
        if (fs.existsSync(f)) {
          try {
            const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
            obj = JSON.parse(raw);
          } catch { obj = {}; }
        }
        obj[key] = value;
        // Write WITHOUT BOM (fs.writeFileSync with 'utf8' on Node never writes one;
        // explicitly enforce consistency so round-trips through PowerShell stay clean).
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
        return true;
      },
      onKvDelete: (key, global) => {
        const f = global ? path.join(this.pluginsRoot, '.fmb-kv-global.json') : this.pluginStoreFile(id, pvRow.directory, 'kv');
        if (!fs.existsSync(f)) return true;
        let obj = {} as Record<string, unknown>;
        try {
          const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
          obj = JSON.parse(raw);
        } catch { obj = {}; }
        delete obj[key];
        fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
        return true;
      },
    };
    const hostApi = buildHostApi(hostSvc);

    let sandbox: ReturnType<typeof createSandbox> | null = null;
    // Build permission-wrapped HostApi once — reused both inside the vm sandbox
    // (createSandbox rebuilds it for globals consistency, which is fine since both
    // go through identical rules) and for ctx.hostApi passed to activate().
    let proxiedHost: HostApi | null = null;
    try {
      const onPermDenied = (err: PermissionDeniedError) => {
        hostSvc.onError?.({ level: 'warn', source: `plugin:${id}.permission`, message: err.message, stack: err.stack, traceId: nanoid(12) });
      };
      proxiedHost = createPermissionedHostApi({
        hostApi,
        manifest,
        onPermissionDenied: onPermDenied,
      });
      sandbox = createSandbox({
        manifest, sourceCode, filename: mainPath, hostApi,
        globals: {
          /**
           * White-listed environment variables provided by the host so plugins
           * can compute Windows install paths (e.g. Trae.exe / ChatGPT.exe
           * default install dirs) without leaking the real `process` object
           * into the sandbox (which would defeat isolation).
           *
           * Plugins read this as: `var env = (typeof __hostEnv === 'object' && __hostEnv) || null`.
           * Values are empty strings if undefined on the host (so string ops work).
           */
          __hostEnv: {
            LOCALAPPDATA: process.env.LOCALAPPDATA || '',
            PROGRAMFILES: process.env['ProgramFiles'] || '',
            'PROGRAMFILES(X86)': process.env['ProgramFiles(x86)'] || '',
            PROGRAMW6432: process.env['ProgramW6432'] || '',
            HOME: process.env.HOME || process.env.USERPROFILE || '',
          },
        },
        onPermissionDenied: onPermDenied,
      });
    } catch (e) {
      return { ok: false, error: toProblemDetails(e, { status: 500, instance: `enable:${id}@${targetVersion}` }) };
    }

    if (Array.isArray(manifest.extensionPoints) && manifest.extensionPoints.length > 0) {
      const exp = sandbox.module.exports;
      for (const decl of manifest.extensionPoints) {
        const [point, name] = decl.split('::').length === 2 ? decl.split('::') : [decl, 'default'];
        const h = exp?.[name ?? 'default'];
        if (typeof h === 'function') this.bus.on(point as any, h as any, { owner: id, name: decl });
      }
    }

    let activateResult: unknown = undefined;
    try {
      if (typeof sandbox.activate === 'function') {
        // IMPORTANT: pass proxiedHost so plugin code can't bypass permissions via ctx.
        const ctx: any = { pluginId: id, version: targetVersion, hostApi: proxiedHost ?? hostApi };
        activateResult = await sandbox.activate(ctx);
      } else if (typeof (sandbox.module.exports as any)?.onEnable === 'function') {
        activateResult = await (sandbox.module.exports as any).onEnable();
      }
    } catch (e) {
      sandbox.dispose();
      return { ok: false, error: toProblemDetails(e, { status: 500, instance: `enable:${id}@${targetVersion}` }) };
    }

    const instance: PluginInstance = {
      instanceId: sandbox.instanceId, pluginId: id, version: targetVersion,
      type: manifest.type, manifest, sandbox, activateResult,
    };
    this.loadedInstances.set(id, instance);

    try {
      const prevStatus = plugin.status ?? 'installed';
      this.raw().prepare(`UPDATE plugins SET status='enabled',updated_at=? WHERE id=?`).run(Date.now(), id);
      this.bus.emit('plugin.statusChanged', { pluginId: id, from: prevStatus, to: 'enabled' });
    } catch {}

    return { ok: true, instanceId: sandbox.instanceId };
  }

  async disablePlugin(id: string): Promise<DisableResult> {
    const inst = this.loadedInstances.get(id);
    if (!inst) return { ok: true };
    try {
      if (typeof inst.sandbox.deactivate === 'function') await inst.sandbox.deactivate();
      else if (typeof (inst.sandbox.module.exports as any)?.onDisable === 'function') {
        await (inst.sandbox.module.exports as any).onDisable();
      }
    } catch (e) { log.warn({ pluginId: id, message: (e as Error).message }, 'deactivate failed'); }
    inst.sandbox.dispose();
    this.bus.offByOwner(id);
    this.loadedInstances.delete(id);
    try {
      this.raw().prepare(`UPDATE plugins SET status='installed',updated_at=? WHERE id=?`).run(Date.now(), id);
      this.bus.emit('plugin.statusChanged', { pluginId: id, from: 'enabled', to: 'installed' });
    } catch {}
    return { ok: true };
  }

  async switchVersion(id: string, version: string): Promise<EnableResult> {
    const exists = this.listVersions(id).some(r => r.version === version);
    if (!exists) return { ok: false, error: { type: 'about:blank', title: 'Not Found', status: 404, detail: `${id}@${version} not installed`, errors: emptyErrors() } };
    await this.disablePlugin(id);
    try {
      this.raw().prepare(`UPDATE plugins SET current_version=?, updated_at=? WHERE id=?`).run(version, Date.now(), id);
    } catch (e) { return { ok: false, error: toProblemDetails(e, { status: 500, instance: `switchVersion:${id}` }) }; }
    return this.enablePlugin(id, version);
  }

  async uninstallPlugin(id: string, version?: string): Promise<UninstallResult> {
    const plugin = this.get(id);
    if (!plugin) return { ok: false, error: { type: 'about:blank', title: 'Not Found', status: 404, detail: `plugin ${id} not installed`, errors: emptyErrors() } };
    try {
      await this.bus.safeEmit('plugin.beforeUninstall', { pluginId: id, currentStatus: plugin.status }, { source: 'plugin.service', strict: true });
    } catch (e: any) {
      return { ok: false, error: { type: 'about:blank', title: 'Vetoed', status: 409, detail: e?.message ?? String(e), errors: emptyErrors() } };
    }
    if (this.loadedInstances.has(id)) await this.disablePlugin(id);
    const all = this.listVersions(id);
    const targets = version ? all.filter(r => r.version === version) : all;
    for (const v of targets) if (fs.existsSync(v.directory)) try { fs.rmSync(v.directory, { recursive: true, force: true }); } catch {}
    if (version) {
      this.raw().prepare(`DELETE FROM plugin_versions WHERE plugin_id = ? AND version = ?`).run(id, version);
      const remaining = this.listVersions(id);
      if (remaining.length === 0) this.raw().prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
      else {
        const valid = remaining.map(r => r.version).filter((v): v is string => !!semver.valid(v)).sort(semver.rcompare);
        if (valid[0]) this.raw().prepare(`UPDATE plugins SET current_version=?, status='installed', updated_at=? WHERE id=?`).run(valid[0], Date.now(), id);
      }
    } else {
      this.raw().prepare(`DELETE FROM plugin_versions WHERE plugin_id = ?`).run(id);
      this.raw().prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
    }
    this.bus.emit('plugin.afterUninstall', { pluginId: id });
    return { ok: true };
  }

  // ---------------- Renderer compilation (T12-B) ----------------
  /**
   * Compile the app plugin's renderer entry to a self-contained CJS bundle
   * at `<pluginDir>/renderer.umd.js`. Uses esbuild if available; falls back
   * to a pre-compiled file shipped inside the zip (for packaged apps where
   * esbuild's native binary isn't bundled).
   */
  private async compileRendererIfApp(pluginDir: string, manifest: PluginManifest): Promise<void> {
    const outFile = path.join(pluginDir, 'renderer.umd.js');
    // If the zip already ships a pre-compiled bundle, keep it as-is.
    if (fs.existsSync(outFile)) {
      log.info({ pluginId: manifest.id, version: manifest.version }, 'renderer.umd.js already present (pre-compiled)');
      return;
    }
    const entry = path.join(pluginDir, manifest.renderer!);
    if (!fs.existsSync(entry)) {
      log.warn({ pluginId: manifest.id, renderer: manifest.renderer }, 'renderer entry not found, skipping compile');
      return;
    }
    try {
      const esbuild = await import('esbuild');
      await esbuild.build({
        entryPoints: [entry],
        outfile: outFile,
        bundle: true,
        format: 'cjs',
        platform: 'browser',
        target: 'es2020',
        external: ['react', 'react-dom', 'react-dom/client', 'antd'],
        loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'text' },
        logLevel: 'error',
        write: true,
      });
      log.info({ pluginId: manifest.id, version: manifest.version }, 'renderer compiled via esbuild');
    } catch (e) {
      log.warn({ pluginId: manifest.id, err: (e as Error).message }, 'esbuild compile failed; renderer will be unavailable');
    }
  }

  /**
   * Read the compiled renderer bundle for an app plugin (T12-B).
   * Returns the code string or null if not found.
   */
  getRendererCode(pluginId: string): { code: string | null; version: string | null } {
    const plugin = this.get(pluginId);
    if (!plugin) return { code: null, version: null };
    const version = plugin.current_version as string | undefined;
    if (!version) return { code: null, version: null };
    const pvRow = this.raw().prepare(`SELECT directory FROM plugin_versions WHERE plugin_id = ? AND version = ?`).get(pluginId, version) as { directory: string } | undefined;
    if (!pvRow) return { code: null, version: null };
    const bundlePath = path.join(pvRow.directory, 'renderer.umd.js');
    if (!fs.existsSync(bundlePath)) return { code: null, version: null };
    try {
      return { code: fs.readFileSync(bundlePath, 'utf8'), version };
    } catch {
      return { code: null, version: null };
    }
  }

  /**
   * Invoke a named action on the plugin's main module exports (T12-C).
   * The plugin must be enabled (loaded in sandbox). The action function is
   * looked up on `sandbox.module.exports[action]`.
   */
  async callAction(pluginId: string, action: string, payload?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const inst = this.loadedInstances.get(pluginId);
    if (!inst) return { ok: false, error: `plugin ${pluginId} is not enabled` };
    const exp = inst.sandbox.module.exports as Record<string, unknown>;
    const fn = exp?.[action];
    if (typeof fn !== 'function') return { ok: false, error: `action "${action}" not found on plugin exports` };
    try {
      const result = await (fn as (payload?: unknown) => unknown | Promise<unknown>)(payload);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---------------- Inspect ----------------
  loadedInstance(id: string): PluginInstance | undefined { return this.loadedInstances.get(id); }
  isLoaded(id: string): boolean { return this.loadedInstances.has(id); }
  getInstanceManifest(id: string): PluginManifest | undefined { return this.loadedInstances.get(id)?.manifest; }
}

// ---------------- Singleton ----------------
let _pluginService: PluginService | null = null;
export function initPluginService(opts?: ConstructorParameters<typeof PluginService>[0]): PluginService {
  if (_pluginService) return _pluginService;
  _pluginService = new PluginService(opts);
  return _pluginService;
}
export function getPluginService(): PluginService {
  if (!_pluginService) throw new Error('PluginService not initialized');
  return _pluginService;
}
export { PermissionDeniedError };
