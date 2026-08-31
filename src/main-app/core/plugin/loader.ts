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

import type { PluginManifest, PluginType, ProblemDetails, HostApi } from '@shared/index';
import { PluginManifestSchema, toProblemDetails } from '@shared/index';
import { readManifestFromDir } from './manifest';
import { createSandbox, PermissionDeniedError, createPermissionedHostApi } from './sandbox';
import { buildHostApi, type HostApiServices } from './host-api';

const log = createLogger('plugin-loader');

// ---------------- public types ----------------
export interface InstallResult {
  ok: boolean;
  pluginId?: string;
  version?: string;
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

  constructor(opts?: { pluginsRoot?: string; eventBus?: EventBusService }) {
    this.bus = opts?.eventBus ?? getEventBus();
    try {
      if (electronApp?.isPackaged) {
        this.pluginsRoot = path.join(electronApp.getPath('userData'), 'plugins');
      } else if (opts?.pluginsRoot) {
        this.pluginsRoot = opts.pluginsRoot;
      } else {
        this.pluginsRoot = path.join(electronApp.getAppPath(), '.data', 'plugins');
      }
    } catch {
      this.pluginsRoot = opts?.pluginsRoot ?? path.resolve(process.cwd(), '.data', 'plugins');
    }
    fs.mkdirSync(this.pluginsRoot, { recursive: true });
  }

  get root(): string { return this.pluginsRoot; }

  // ---------------- raw DB helpers (sync) ----------------
  private raw() { return getRawDb(); }

  list(q: { page?: number; pageSize?: number; status?: string; type?: string; q?: string } = {}): { total: number; page: number; pageSize: number; items: any[] } {
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
  async installFromZip(zipPath: string): Promise<InstallResult> {
    const tmpDir = path.join(this.pluginsRoot, `.tmp-${nanoid(8)}`);
    const cleanupPaths: string[] = [tmpDir];
    try {
      const zip = new AdmZip(zipPath);
      fs.mkdirSync(tmpDir, { recursive: true });
      zip.extractAllTo(tmpDir, /*overwrite*/ true);

      const parsed = readManifestFromDir(tmpDir, { instance: zipPath });
      if (!parsed.ok) return { ok: false, error: { ...parsed.error, cleanup: cleanupPaths } };
      const manifest = parsed.manifest;

      const dep = this.parseDependencies(manifest.dependencies ?? {}, { forManifest: manifest });
      if (!dep.ok) {
        const errors: PathMsg[] = [];
        errors.push(...dep.missing.map(m => ({ path: ['dependencies', m.depId], message: m.reason, code: 'dep.missing' })));
        errors.push(...dep.conflicts.map(c => ({ path: ['dependencies', c.depId], message: c.reason, code: 'dep.conflict' })));
        errors.push(...dep.cycles.map(c => ({ path: ['dependencies'], message: `cycle: ${c.join(' → ')}`, code: 'dep.cycle' })));
        return {
          ok: false,
          error: {
            type: 'https://fmb.dev/problems/dependency-check-failed',
            title: 'Dependency Check Failed',
            status: 400,
            detail: errors.map(e => `${e.path.join('/')}: ${e.message}`).join('; '),
            errors,
            instance: zipPath,
            cleanup: cleanupPaths,
          },
        };
      }

      try {
        await this.bus.safeEmit('plugin.beforeInstall', { manifest, sourceZip: zipPath }, { source: 'plugin.service', strict: true });
      } catch (e: any) {
        return {
          ok: false,
          error: { type: 'about:blank', title: 'Installation Vetoed', status: 409, detail: e?.message ?? String(e), errors: emptyErrors(), cleanup: cleanupPaths },
        };
      }

      const targetDir = path.join(this.pluginsRoot, `${manifest.id}@${manifest.version}`);
      cleanupPaths.push(targetDir);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, targetDir);

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
        const promote = !cur || (semver.valid(cur) && semver.valid(manifest.version) && semver.gt(manifest.version, cur));
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

      return { ok: true, pluginId: manifest.id, version: manifest.version };
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
        const f = path.join(pvRow.directory, '.fmb-secrets.json');
        if (!fs.existsSync(f)) return null;
        try { return JSON.parse(fs.readFileSync(f, 'utf8'))[key] ?? null; } catch { return null; }
      },
      onSecretSet: (key, value) => {
        const f = path.join(pvRow.directory, '.fmb-secrets.json');
        const obj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
        obj[key] = value;
        fs.writeFileSync(f, JSON.stringify(obj, null, 2), { mode: 0o600 });
        return { id: 0, key, value, scope: 'plugin' };
      },
      onSecretDelete: () => true,
      onKvGet: (key, global) => {
        const f = global ? path.join(this.pluginsRoot, '.fmb-kv-global.json') : path.join(pvRow.directory, '.fmb-kv.json');
        if (!fs.existsSync(f)) return null;
        try { return JSON.parse(fs.readFileSync(f, 'utf8'))[key] ?? null; } catch { return null; }
      },
      onKvSet: (key, value, global) => {
        const f = global ? path.join(this.pluginsRoot, '.fmb-kv-global.json') : path.join(pvRow.directory, '.fmb-kv.json');
        const obj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
        obj[key] = value;
        fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
        return true;
      },
      onKvDelete: (key, global) => {
        const f = global ? path.join(this.pluginsRoot, '.fmb-kv-global.json') : path.join(pvRow.directory, '.fmb-kv.json');
        if (!fs.existsSync(f)) return true;
        const obj = JSON.parse(fs.readFileSync(f, 'utf8')); delete obj[key];
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
        globals: {},
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
