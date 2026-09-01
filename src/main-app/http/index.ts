/**
 * Localhost HTTP API (Task 15) — hono + zod + Swagger UI + Bearer token.
 *
 * Design:
 *   - Binds 127.0.0.1 only (never the LAN). Port + token from settings.
 *   - Bearer token auth on all routes EXCEPT /health, /openapi.json, /docs.
 *   - Delegates to the same core services the IPC layer uses.
 *   - Emits http.api.beforeRequest / http.api.afterResponse extension points.
 *   - Errors are RFC 7807 ProblemDetails JSON.
 *   - JSON-RPC 2.0 batch endpoint at POST /api/v1/rpc.
 *
 * The first time the API boots with an empty http.token, a 32-byte hex token
 * is generated and persisted to kv_store so it is stable across restarts.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { swaggerUI } from '@hono/swagger-ui';
import { app as electronApp } from 'electron';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPluginService } from '../core/plugin/loader';
import { getWorkflowService } from '../core/workflow/crud';
import { getSchedulerService } from '../core/scheduler/service';
import { getQueueService } from '../core/queue/service';
import { getErrorCalendarService } from '../core/error-calendar/service';
import { getSettingsService } from '../core/settings/service';
import { getEventBus } from '../core/event-bus';
import { getRawDb } from '../core/db';
import { createLogger } from '../core/logger';
import { audit, newTraceId } from '../core/audit';
import { OPENAPI_SPEC } from './openapi';

const log = createLogger('http');

function problem(c: Context, status: number, title: string, detail: string): Response {
  return c.json({ type: 'about:blank', title, status, detail, instance: c.req.path }, status as any, {
    'content-type': 'application/problem+json',
  });
}

/**
 * Serialize a plugin operation's Result.error (ProblemDetails) into a
 * human-readable single-line detail text suitable for the problem() helper
 * and RFC 7807 `detail` field. Mirrors pluginError() in ipc/handlers.ts so the
 * same failure appears consistently whether triggered from UI/IPC or HTTP.
 */
function formatPluginProblem(err: any): { status: number; title: string; detail: string } {
  const title: string = err?.title ?? 'Plugin operation failed';
  const statusCode: number = Number.isFinite(Number(err?.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 400;
  const detail: string | undefined = err?.detail ? String(err.detail) : undefined;
  const rawErrors: Array<{ path?: (string | number)[]; message?: string; code?: string }> =
    Array.isArray(err?.errors) ? (err.errors as any[]) : [];
  const issueLines = rawErrors.map(e => {
    const loc = Array.isArray(e.path) && e.path.length ? ` (${e.path.map(String).join('/')})` : '';
    const c = e.code ? `[${String(e.code)}]` : '';
    return `•${c}${loc} ${String(e.message ?? '').trim()}`.trim();
  });
  const parts: string[] = [];
  if (detail) parts.push(detail);
  if (issueLines.length) parts.push(issueLines.join('; '));
  const flat = parts.join(' — ');
  return { status: statusCode, title, detail: flat || title };
}

function ensureToken(): string {
  const svc = getSettingsService();
  let token = svc.get('http.token');
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    svc.applyPatch({ 'http.token': token });
    log.info('generated new http bearer token (persisted)');
  }
  return token;
}

export interface HttpServerHandle {
  port: number;
  token: string;
  close: () => void;
}

export function startHttpServer(opts: { bootTs: number }): HttpServerHandle | null {
  const settings = getSettingsService();
  const port = settings.get('http.port') || 18765;
  const token = ensureToken();

  const app = new Hono();

  // Catch unhandled route errors so we can see the real exception instead of an
  // empty 500 body (default Hono behavior swallows the stack trace).
  app.onError((err, c) => {
    const e = err as Error;
    log.error({ err: e.message, stack: e.stack, path: c.req.path, method: c.req.method }, 'http route unhandled error');
    return problem(c, 500, 'Internal Server Error', e.message || 'unknown error');
  });

  // ---- middleware: event-bus hooks + bearer auth ----
  app.use('/api/v1/*', async (c, next) => {
    const reqId = newTraceId();
    const start = performance.now();
    const method = c.req.method;
    const path = c.req.path;
    const bus = getEventBus();
    void bus.emit('http.api.beforeRequest', { method, path, requestId: reqId } as any);
    await next();
    const durationMs = Math.round(performance.now() - start);
    const status = c.res.status;
    void bus.emit('http.api.afterResponse', { method, path, statusCode: status, durationMs, requestId: reqId } as any);
  });

  app.use('/api/v1/*', async (c, next) => {
    const path = c.req.path;
    // Exempt public routes
    if (path === '/api/v1/health' || path === '/api/v1/openapi.json' || path === '/api/v1/docs') {
      return next();
    }
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const provided = m?.[1] ?? '';
    if (!provided) return problem(c, 401, 'Unauthorized', 'Missing Bearer token');
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return problem(c, 401, 'Unauthorized', 'Invalid Bearer token');
    }
    await next();
  });

  // ---- system ----
  app.get('/api/v1/health', (c) => {
    const db = getRawDb();
    const bus = getEventBus();
    const activeRuns = (db.prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('running','pending')`).get() as { c: number }).c;
    const pendingJobs = (db.prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE status='pending'`).get() as { c: number }).c;
    const enabledPlugins = (db.prepare(`SELECT COUNT(*) AS c FROM plugins WHERE status='enabled'`).get() as { c: number }).c;
    const busAny = bus as unknown as { listenerCount?: (e?: unknown) => number };
    return c.json({
      status: 'ok',
      version: electronApp.getVersion(),
      uptimeMs: Date.now() - opts.bootTs,
      activeWorkers: (getQueueService() as unknown as { getConcurrency?: () => number }).getConcurrency?.() ?? 0,
      pendingJobs,
      activeRuns,
      enabledPlugins,
      dbOk: true,
      eventBusListeners: busAny.listenerCount?.() ?? 0,
      platform: process.platform,
      arch: os.arch(),
      nodeVersion: process.versions.node,
    });
  });

  app.get('/api/v1/openapi.json', (c) => c.json(OPENAPI_SPEC));
  app.get('/api/v1/docs', swaggerUI({ url: '/api/v1/openapi.json' }));

  // ---- plugins ----
  app.get('/api/v1/plugins', (c) => {
    const p = pluginListParams(c);
    return c.json(getPluginService().list(p));
  });

  app.post('/api/v1/plugins', async (c) => {
    const body = await c.req.json().catch(() => null) as { zipPath?: string } | null;
    if (!body?.zipPath) return problem(c, 400, 'Bad Request', 'zipPath required');
    const r = await getPluginService().installFromZip(body.zipPath);
    if (!r.ok) {
      const p = formatPluginProblem((r as any).error ?? { title: 'Install failed', status: 400 });
      return problem(c, p.status, p.title || 'Install failed', p.detail);
    }
    audit({ action: 'http.plugin.install', source: 'http', actor: 'http', payload: { zipPath: body.zipPath }, traceId: newTraceId() });
    const pid = (r as { pluginId?: string }).pluginId;
    const got = pid ? getPluginService().get(pid) : null;
    return c.json(got, 201);
  });

  app.get('/api/v1/plugins/:id', (c) => {
    const raw = getPluginService().get(c.req.param('id'));
    if (!raw) return problem(c, 404, 'Not Found', 'plugin not found');
    return c.json({
      ...raw,
      permissions: raw.permissions_json ? JSON.parse(raw.permissions_json) : [],
      dependencies: raw.dependencies_json ? JSON.parse(raw.dependencies_json) : {},
      manifest: raw.manifest_json ? JSON.parse(raw.manifest_json) : {},
      versions: getPluginService().listVersions(raw.id),
    });
  });

  app.patch('/api/v1/plugins/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { status?: string };
    if (body.status === 'enabled') {
      const r = await getPluginService().enablePlugin(id);
      if (!r.ok) {
        const p = formatPluginProblem((r as any).error ?? { title: 'Enable failed', status: 400 });
        return problem(c, p.status, p.title || 'Enable failed', p.detail);
      }
    } else if (body.status === 'disabled') {
      const r = await getPluginService().disablePlugin(id);
      if (!r.ok) {
        const p = formatPluginProblem((r as any).error ?? { title: 'Disable failed', status: 400 });
        return problem(c, p.status, p.title || 'Disable failed', p.detail);
      }
    }
    return c.json(getPluginService().get(id));
  });

  app.post('/api/v1/plugins/:id/actions/:action', async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (action === 'enable') {
      const r = await getPluginService().enablePlugin(id);
      if (!r.ok) {
        const p = formatPluginProblem((r as any).error ?? { title: 'Enable failed', status: 400 });
        return problem(c, p.status, p.title || 'Enable failed', p.detail);
      }
    } else if (action === 'disable') {
      const r = await getPluginService().disablePlugin(id);
      if (!r.ok) {
        const p = formatPluginProblem((r as any).error ?? { title: 'Disable failed', status: 400 });
        return problem(c, p.status, p.title || 'Disable failed', p.detail);
      }
    } else if (action === 'switch-version') {
      const body = await c.req.json().catch(() => ({})) as { version?: string };
      if (!body.version) return problem(c, 400, 'Bad Request', 'version required');
      const r = await getPluginService().switchVersion(id, body.version);
      if (!r.ok) {
        const p = formatPluginProblem((r as any).error ?? { title: 'Version switch failed', status: 400 });
        return problem(c, p.status, p.title || 'Switch failed', p.detail);
      }
    } else {
      return problem(c, 400, 'Bad Request', `unknown action ${action}`);
    }
    return c.json(getPluginService().get(id));
  });

  // ---- workflows ----
  app.get('/api/v1/workflows', (c) => {
    return c.json(getWorkflowService().list(workflowListParams(c)));
  });

  app.post('/api/v1/workflows', async (c) => {
    // Following the ownership contract (v3), direct workflow creation is only
    // permitted when the caller provides a trusted owner_plugin_id that
    // corresponds to an installed + enabled app-type plugin. Plain HTTP
    // callers (bearer-token only) do NOT carry plugin identity proof, so we
    // return 403 with the same message shape used by the IPC channel.
    return problem(
      c,
      403,
      'Creation Disallowed',
      '创建工作流仅允许从 app 插件 HostAPI 发起（工作流归应用插件所有）。请从对应应用插件的子页面内调用 host.workflows.create(...) 创建。',
    );
  });

  app.get('/api/v1/workflows/:id', (c) => {
    const vm = getWorkflowService().getViewModel(c.req.param('id'));
    if (!vm) return problem(c, 404, 'Not Found', 'workflow not found');
    return c.json(vm);
  });

  app.put('/api/v1/workflows/:id', async (c) => {
    const p = await c.req.json().catch(() => ({})) as any;
    const updated = getWorkflowService().update({
      id: c.req.param('id'),
      name: p.name,
      description: p.description,
      definition_json: p.definition_json ?? (p.definition !== undefined ? JSON.stringify(p.definition) : undefined),
      vars_json: p.vars_json ?? (p.vars !== undefined ? JSON.stringify(p.vars) : undefined),
    });
    return c.json(updated);
  });

  app.delete('/api/v1/workflows/:id', (c) => {
    getWorkflowService().delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/v1/workflows/:id/runs', (c) => {
    return c.json(getWorkflowService().listRuns({ workflowId: c.req.param('id'), page: pageParam(c), pageSize: pageSizeParam(c) }));
  });

  app.post('/api/v1/workflows/:id/runs', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { input?: Record<string, unknown> };
    const run = await getWorkflowService().run(c.req.param('id'), body.input ?? {});
    audit({ action: 'http.workflow.run', source: 'http', actor: 'http', payload: { id: c.req.param('id') }, traceId: newTraceId() });
    return c.json({ run_id: (run as { id: string }).id, status: (run as { status: string }).status }, 201);
  });

  app.get('/api/v1/runs/:runId', (c) => {
    const runs = getWorkflowService().listRuns({ page: 1, pageSize: 1 }) as { items?: any[] };
    // The CRUD service exposes listRuns; find by runId among recent runs.
    const all = getWorkflowService().listRuns({ page: 1, pageSize: 1000 }) as { items?: any[] };
    const found = (all.items ?? []).find((r) => r.run_id === c.req.param('runId') || r.id === c.req.param('runId'));
    if (!found) return problem(c, 404, 'Not Found', 'run not found');
    return c.json(found);
  });

  // ---- schedules ----
  app.get('/api/v1/schedules', (c) => {
    return c.json(getSchedulerService().list({ page: pageParam(c), pageSize: pageSizeParam(c) }));
  });

  app.post('/api/v1/schedules', async (c) => {
    const p = await c.req.json().catch(() => ({})) as any;
    const created = getSchedulerService().create({
      name: p.name,
      cronExpr: p.cronExpr ?? p.cron_expr,
      oneShotAtMs: p.oneShotAtMs ?? p.one_shot_at,
      workflowId: p.workflowId ?? p.workflow_id,
      input: p.input ?? (p.input_json ? JSON.parse(p.input_json) : {}),
      enabled: p.enabled !== false,
      misfirePolicy: p.misfirePolicy ?? p.misfire_policy ?? 'skip',
      timezone: p.timezone ?? 'UTC',
    });
    audit({ action: 'http.schedule.create', source: 'http', actor: 'http', payload: { name: p.name }, traceId: newTraceId() });
    return c.json(created, 201);
  });

  app.patch('/api/v1/schedules/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    const enabled = body.enabled === true;
    return c.json(getSchedulerService().toggle(c.req.param('id'), enabled));
  });

  app.delete('/api/v1/schedules/:id', (c) => {
    getSchedulerService().delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/v1/schedules/:id/actions/:action', (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (action === 'pause') return c.json(getSchedulerService().toggle(id, false));
    if (action === 'resume') return c.json(getSchedulerService().toggle(id, true));
    return problem(c, 400, 'Bad Request', `unknown action ${action}`);
  });

  // ---- queue ----
  app.get('/api/v1/queue/stats', (c) => {
    return c.json((getQueueService() as unknown as { metrics?: () => unknown }).metrics?.() ?? {});
  });

  app.get('/api/v1/queue/jobs', (c) => {
    return c.json(getQueueService().list({
      page: pageParam(c), pageSize: pageSizeParam(c),
      status: (c.req.query('status') as any) ?? undefined,
      type: (c.req.query('type') as any) ?? undefined,
    }));
  });

  app.post('/api/v1/queue/actions/retry-dead', (c) => {
    const n = (getQueueService() as unknown as { retryDeadJobs?: () => number }).retryDeadJobs?.() ?? 0;
    return c.json({ retried: n });
  });

  app.post('/api/v1/queue/actions/clear-dead', (c) => {
    const n = (getQueueService() as unknown as { clearDead?: () => number }).clearDead?.() ?? 0;
    return c.json({ cleared: n });
  });

  // Convenience alias: GET /queue → /queue/jobs (self-check & simple clients)
  app.get('/api/v1/queue', (c) => {
    return c.json(getQueueService().list({
      page: pageParam(c), pageSize: pageSizeParam(c),
      status: (c.req.query('status') as any) ?? undefined,
      type: (c.req.query('type') as any) ?? undefined,
    }));
  });

  // Enqueue a job directly (used by self-check to exercise concurrency)
  app.post('/api/v1/queue/enqueue', async (c) => {
    const p = await c.req.json().catch(() => ({})) as any;
    // job_queue.type has a CHECK constraint: ('workflow_run','atomic_call','system').
    // A caller may pass `handler` (a plugin handler ref like 'com.fmb.demo.atomic/echo')
    // to invoke an atomic plugin action — map that to the 'atomic_call' job type and
    // preserve the handler reference inside the payload for the dispatcher.
    const VALID_TYPES = new Set(['workflow_run', 'atomic_call', 'system']);
    let type: 'workflow_run' | 'atomic_call' | 'system';
    let payload = p.payload ?? {};
    if (typeof p.type === 'string' && VALID_TYPES.has(p.type)) {
      type = p.type as 'workflow_run' | 'atomic_call' | 'system';
    } else if (typeof p.handler === 'string') {
      type = 'atomic_call';
      payload = { ...payload, handler: p.handler };
    } else {
      type = 'system';
    }
    const row = getQueueService().enqueue({
      type,
      payload,
      priority: typeof p.priority === 'number' ? p.priority : undefined,
      maxAttempts: typeof p.retryMax === 'number' ? p.retryMax : undefined,
      traceId: newTraceId(),
    });
    audit({ action: 'http.queue.enqueue', source: 'http', actor: 'http', payload: { type, id: row.id }, traceId: newTraceId() });
    return c.json(row, 201);
  });

  // ---- errors ----
  app.get('/api/v1/errors', (c) => {
    const q = c.req.query.bind(c.req);
    const resolved = q('resolved');
    return c.json(getErrorCalendarService().query({
      page: pageParam(c), pageSize: pageSizeParam(c),
      level: q('level') ?? undefined,
      source: q('source') ?? undefined,
      keyword: q('keyword') ?? undefined,
      fromMs: q('from') ? Number(q('from')) : undefined,
      toMs: q('to') ? Number(q('to')) : undefined,
      resolved: resolved === '1' ? true : resolved === '0' ? false : undefined,
    }));
  });

  app.patch('/api/v1/errors/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return problem(c, 400, 'Bad Request', 'invalid id');
    const body = await c.req.json().catch(() => ({})) as { resolved?: boolean };
    const updated = getErrorCalendarService().markResolved(id, body.resolved ?? true);
    return c.json(updated);
  });

  // ---- settings ----
  app.get('/api/v1/settings', (c) => {
    return c.json(getSettingsService().getAll());
  });

  app.patch('/api/v1/settings', async (c) => {
    const p = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const updated = getSettingsService().applyPatch(p as any);
    audit({ action: 'http.settings.patch', source: 'http', actor: 'http', payload: { keys: Object.keys(p) }, traceId: newTraceId() });
    return c.json(updated);
  });

  // ---- app lifecycle ----
  app.post('/api/v1/app/quit', (c) => {
    audit({ action: 'http.app.quit', source: 'http', actor: 'http', payload: {}, traceId: newTraceId() });
    // Defer quit so the HTTP response can flush first.
    setTimeout(() => { try { electronApp.quit(); } catch { /* noop */ } }, 250);
    return c.json({ ok: true }, 202);
  });

  // ---- JSON-RPC 2.0 batch ----
  app.post('/api/v1/rpc', async (c) => {
    const req = await c.req.json().catch(() => null);
    const batch = Array.isArray(req) ? req : [req];
    const results = await Promise.all(batch.map(async (r: any) => rpcDispatch(r)));
    return c.json(results);
  });

  // ---- start server (loopback only) ----
  let server: ReturnType<typeof serve> | null = null;
  try {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
    log.info({ port, host: '127.0.0.1' }, 'http api listening on loopback');
  } catch (e) {
    log.error({ err: (e as Error).message }, 'http api failed to start');
    return null;
  }

  // Write port+token meta file so the CLI (separate process) can discover and
  // authenticate against the running HTTP API without opening the SQLite DB.
  const metaPath = path.join(electronApp.getPath('userData'), '.fmb-http.json');
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ port, token }, null, 2), 'utf8');
    log.info({ metaPath }, 'wrote http meta file for CLI');
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'failed to write http meta file');
  }

  return {
    port,
    token,
    close: () => {
      try { server?.close(); } catch { /* noop */ }
      try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch { /* noop */ }
    },
  };
}

// ---------- helpers ----------
function pageParam(c: Context): number {
  const v = Number(c.req.query('page') ?? '1');
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}
function pageSizeParam(c: Context): number {
  const v = Number(c.req.query('pageSize') ?? '20');
  return Number.isFinite(v) && v >= 1 && v <= 500 ? Math.floor(v) : 20;
}
function pluginListParams(c: Context) {
  return { page: pageParam(c), pageSize: pageSizeParam(c) } as any;
}
function workflowListParams(c: Context) {
  return { page: pageParam(c), pageSize: pageSizeParam(c) } as any;
}

async function rpcDispatch(r: any): Promise<unknown> {
  const id = r?.id;
  const method = r?.method;
  try {
    switch (method) {
      case 'health': {
        const db = getRawDb();
        const activeRuns = (db.prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('running','pending')`).get() as { c: number }).c;
        return { jsonrpc: '2.0', id, result: { version: electronApp.getVersion(), activeRuns, dbOk: true } };
      }
      case 'plugin.list':
        return { jsonrpc: '2.0', id, result: getPluginService().list({ page: 1, pageSize: 20 }) };
      case 'workflow.list':
        return { jsonrpc: '2.0', id, result: getWorkflowService().list({ page: 1, pageSize: 20 }) };
      case 'workflow.run': {
        const p = r?.params ?? {};
        const run = await getWorkflowService().run(p.id, p.input ?? {});
        return { jsonrpc: '2.0', id, result: { run_id: (run as { id: string }).id, status: (run as { status: string }).status } };
      }
      case 'schedule.list':
        return { jsonrpc: '2.0', id, result: getSchedulerService().list({ page: 1, pageSize: 20 }) };
      case 'queue.stats':
        return { jsonrpc: '2.0', id, result: (getQueueService() as unknown as { metrics?: () => unknown }).metrics?.() ?? {} };
      case 'error.list':
        return { jsonrpc: '2.0', id, result: getErrorCalendarService().query({ page: 1, pageSize: 20 }) };
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } };
  }
}
