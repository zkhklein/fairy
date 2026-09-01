/**
 * Workflow CRUD service — manages the workflows table.
 * Also provides the singleton WorkflowExecutor instance.
 */
import { nanoid } from 'nanoid';
import { getRawDb } from '../db';
import { createLogger } from '../logger';
import type { EventBusService } from '../event-bus';
import type { PluginService } from '../plugin/loader';
import { WorkflowExecutor, type ExecuteResult, type ExecuteOptions } from './executor';
import { parseWorkflowDefinition, type WorkflowDefinition } from './dsl';

const log = createLogger('workflow-crud');

export interface CreateWorkflowArgs {
  id?: string;
  name: string;
  description?: string;
  definition: WorkflowDefinition | string;
  vars?: Record<string, unknown>;
  /** Mandatory owner — must correspond to a type='app' plugin. */
  owner_plugin_id: string;
}

export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  definition_json: string;
  vars_json: string;
  owner_plugin_id: string;
  created_at: number;
  updated_at: number;
}

export class WorkflowService {
  private executor: WorkflowExecutor;

  constructor(private bus: EventBusService, private pluginService?: PluginService) {
    this.executor = new WorkflowExecutor({ bus, pluginService });
  }

  // ---------------- CRUD ----------------

  create(args: CreateWorkflowArgs): WorkflowRow {
    const db = getRawDb();
    // Verify owner is a type=app plugin (belt-and-suspenders alongside the DB
    // triggers we install in migration 002).
    const owner = db.prepare('SELECT type FROM plugins WHERE id = ?').get(args.owner_plugin_id) as { type?: string } | undefined;
    if (!owner || owner.type !== 'app') {
      throw new Error(`owner_plugin_id=${args.owner_plugin_id} must correspond to a type='app' plugin`);
    }
    const id = args.id ?? `wf-${nanoid(10)}`;
    const now = Date.now();
    const defStr = typeof args.definition === 'string' ? args.definition : JSON.stringify(args.definition);
    const varsStr = JSON.stringify(args.vars ?? {});
    // Validate definition
    parseWorkflowDefinition(defStr);
    db.prepare(
      'INSERT INTO workflows (id, name, description, definition_json, vars_json, owner_plugin_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(id, args.name, args.description ?? '', defStr, varsStr, args.owner_plugin_id, now, now);
    log.info({ id, name: args.name, ownerPluginId: args.owner_plugin_id }, 'workflow created');
    return this.get(id)!;
  }

  get(id: string): WorkflowRow | null {
    const db = getRawDb();
    return (db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined) ?? null;
  }

  list(params: { page?: number; pageSize?: number; q?: string } = {}): {
    items: Array<WorkflowRow & {
      owner_name?: string;
      owner_type?: string;
      referenced_plugin_ids: string[];
      node_counts: { total: number; atomic: number; control: number };
      definition: Record<string, unknown>;
      vars: Record<string, unknown>;
    }>;
    total: number;
    page: number;
    pageSize: number;
  } {
    const db = getRawDb();
    const sql = `SELECT w.*, p.name AS owner_name, p.type AS owner_type
                 FROM workflows w
                 LEFT JOIN plugins p ON p.id = w.owner_plugin_id
                 WHERE 1=1` +
      (params.q ? ` AND (w.name LIKE @qlike OR w.id LIKE @qlike)` : ``) +
      ` ORDER BY w.updated_at DESC`;
    const rows = db.prepare(sql).all({ qlike: `%${params.q ?? ''}%` }) as Array<any>;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const enriched = rows.map((r) => this._enrichRow(r));
    return { items: enriched.slice(start, start + pageSize), total: rows.length, page, pageSize };
  }

  /** Scan the DAG definition to derive referenced atomic plugin ids + node counts. */
  private _enrichRow(row: WorkflowRow & { owner_name?: string; owner_type?: string }) {
    let definition: Record<string, any> = {};
    try { definition = row.definition_json ? JSON.parse(row.definition_json) : {}; } catch { /* noop */ }
    const nodes = Array.isArray(definition.nodes) ? (definition.nodes as any[]) : [];
    const referencedIds = new Set<string>();
    let atomicCount = 0;
    for (const n of nodes) {
      const type: string = String(n.type ?? '');
      if (type === 'atomic' || typeof n.pluginId === 'string') {
        atomicCount++;
        if (typeof n.pluginId === 'string' && n.pluginId.length > 0) referencedIds.add(n.pluginId);
      }
    }
    const controlCount = Math.max(0, nodes.length - atomicCount);
    let vars: Record<string, unknown> = {};
    try { vars = row.vars_json ? JSON.parse(row.vars_json) : {}; } catch { /* noop */ }
    return {
      ...row,
      referenced_plugin_ids: Array.from(referencedIds),
      node_counts: { total: nodes.length, atomic: atomicCount, control: controlCount },
      definition,
      vars,
    };
  }

  getViewModel(id: string): {
    id: string; name: string; description: string;
    definition_json: string; vars_json: string;
    owner_plugin_id: string;
    owner_name?: string;
    owner_type?: string;
    referenced_plugin_ids: string[];
    node_counts: { total: number; atomic: number; control: number };
    created_at: number; updated_at: number;
    definition: Record<string, unknown>;
    vars: Record<string, unknown>;
  } | null {
    const db = getRawDb();
    const row = db.prepare(`SELECT w.*, p.name AS owner_name, p.type AS owner_type
                            FROM workflows w LEFT JOIN plugins p ON p.id = w.owner_plugin_id
                            WHERE w.id = ?`).get(id) as any;
    if (!row) return null;
    return this._enrichRow(row);
  }

  update(params: { id: string } & Partial<Pick<WorkflowRow, 'name' | 'description' | 'definition_json' | 'vars_json'>>): WorkflowRow | null {
    const db = getRawDb();
    const current = this.get(params.id);
    if (!current) return null;
    const name = params.name ?? current.name;
    const description = params.description ?? current.description;
    const definition_json = params.definition_json ?? current.definition_json;
    const vars_json = params.vars_json ?? current.vars_json;
    if (params.definition_json) parseWorkflowDefinition(definition_json);
    db.prepare('UPDATE workflows SET name=?, description=?, definition_json=?, vars_json=?, updated_at=? WHERE id=?')
      .run(name, description, definition_json, vars_json, Date.now(), params.id);
    return this.get(params.id);
  }

  delete(id: string): boolean {
    const db = getRawDb();
    const info = db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ---------------- Runs ----------------

  async run(workflowId: string, input?: Record<string, unknown>): Promise<{
    id: string; workflow_id: string; trigger: string; status: string;
    input_json: string; output_json: string | null;
    started_at: number | null; finished_at: number | null;
    created_at: number; duration_ms: number | null;
    error_stack: string | null; trace_id: string;
    input: Record<string, unknown>; output: Record<string, unknown> | null;
  }> {
    const result = await this.execute(workflowId, { input });
    const row = getRawDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(result.runId) as any;
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      trigger: row.trigger,
      status: row.status,
      input_json: row.input_json ?? '{}',
      output_json: row.output_json ?? null,
      started_at: row.started_at ?? null,
      finished_at: row.finished_at ?? null,
      created_at: row.created_at,
      duration_ms: (row.duration_ms == null) ? null : Number(row.duration_ms),
      error_stack: row.error_stack ?? null,
      trace_id: row.trace_id,
      input: row.input_json ? JSON.parse(row.input_json) : {},
      output: row.output_json ? JSON.parse(row.output_json) : null,
    };
  }

  cancelRun(runId: string): {
    id: string; workflow_id: string; trigger: string; status: string;
    input_json: string; output_json: string | null;
    started_at: number | null; finished_at: number | null;
    created_at: number; duration_ms: number | null;
    error_stack: string | null; trace_id: string;
    input: Record<string, unknown>; output: Record<string, unknown> | null;
  } {
    const db = getRawDb();
    db.prepare(`UPDATE workflow_runs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('running','pending')`).run(Date.now(), runId);
    const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as any;
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      trigger: row.trigger,
      status: row.status,
      input_json: row.input_json ?? '{}',
      output_json: row.output_json ?? null,
      started_at: row.started_at ?? null,
      finished_at: row.finished_at ?? null,
      created_at: row.created_at,
      duration_ms: (row.duration_ms == null) ? null : Number(row.duration_ms),
      error_stack: row.error_stack ?? null,
      trace_id: row.trace_id,
      input: row.input_json ? JSON.parse(row.input_json) : {},
      output: row.output_json ? JSON.parse(row.output_json) : null,
    };
  }

  listRuns(params: { page?: number; pageSize?: number; workflowId?: string; status?: string } = {}): {
    items: Array<{
      id: string; workflow_id: string; trigger: string; status: string;
      input_json: string; output_json: string | null;
      started_at: number | null; finished_at: number | null;
      created_at: number; duration_ms: number | null;
      error_stack: string | null; trace_id: string;
      input: Record<string, unknown>; output: Record<string, unknown> | null;
    }>;
    total: number; page: number; pageSize: number;
  } {
    const db = getRawDb();
    const sql = `SELECT * FROM workflow_runs WHERE 1=1` +
      (params.workflowId ? ` AND workflow_id = @wf` : ``) +
      (params.status ? ` AND status = @st` : ``) +
      ` ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all({ wf: params.workflowId, st: params.status }) as any[];
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const items = rows.slice(start, start + pageSize).map((r) => ({
      id: r.id,
      workflow_id: r.workflow_id,
      trigger: r.trigger,
      status: r.status,
      input_json: r.input_json ?? '{}',
      output_json: r.output_json ?? null,
      started_at: r.started_at ?? null,
      finished_at: r.finished_at ?? null,
      created_at: r.created_at,
      duration_ms: (r.duration_ms == null) ? null : Number(r.duration_ms),
      error_stack: r.error_stack ?? null,
      trace_id: r.trace_id,
      input: r.input_json ? JSON.parse(r.input_json) : {},
      output: r.output_json ? JSON.parse(r.output_json) : null,
    }));
    return { items, total: rows.length, page, pageSize };
  }

  duplicate(id: string, newName?: string): WorkflowRow | null {
    const orig = this.get(id);
    if (!orig) return null;
    return this.create({
      name: newName ?? `${orig.name} (copy)`,
      description: orig.description,
      definition: orig.definition_json,
      vars: JSON.parse(orig.vars_json),
      owner_plugin_id: orig.owner_plugin_id,
    });
  }

  importJson(json: string, ownerPluginId?: string): WorkflowRow {
    const data = JSON.parse(json);
    return this.create({
      id: data.id,
      name: data.name,
      description: data.description,
      definition: JSON.stringify(data.definition ?? data.definition_json),
      vars: data.vars ?? JSON.parse(data.vars_json ?? '{}'),
      owner_plugin_id: ownerPluginId ?? data.owner_plugin_id ?? 'com.fmb.host',
    });
  }

  exportJson(id: string): string {
    const row = this.get(id);
    if (!row) throw new Error(`Workflow ${id} not found`);
    return JSON.stringify({
      id: row.id,
      name: row.name,
      description: row.description,
      definition: JSON.parse(row.definition_json),
      vars: JSON.parse(row.vars_json),
    }, null, 2);
  }

  // ---------------- Execution ----------------

  async execute(workflowId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    const row = this.get(workflowId);
    if (!row) throw new Error(`Workflow "${workflowId}" not found`);
    return this.executor.execute(workflowId, row.definition_json, opts);
  }

  getExecutor(): WorkflowExecutor {
    return this.executor;
  }
}

// ---------------- Singleton ----------------
let _singleton: WorkflowService | null = null;
export function initWorkflowService(bus: EventBusService, pluginService?: PluginService): WorkflowService {
  if (_singleton) return _singleton;
  _singleton = new WorkflowService(bus, pluginService);
  return _singleton;
}
export function getWorkflowService(): WorkflowService {
  if (!_singleton) throw new Error('WorkflowService not initialized: call initWorkflowService() at boot');
  return _singleton;
}
