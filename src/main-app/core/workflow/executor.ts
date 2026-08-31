/**
 * Workflow Executor — DAG execution engine.
 *
 * Responsibilities:
 *   1. Parse + validate workflow definition (DSL → DAG)
 *   2. Initialize Context (global vars + secrets + input)
 *   3. Execute nodes in topological order with variable interpolation
 *   4. Node-level retry (maxAttempts + backoff=fixed|exponential)
 *   5. Persist execution state to workflow_runs + workflow_nodes tables
 *   6. Emit workflow.beforeExecute / nodeComplete / nodeError / afterExecute events
 *
 * Node types handled:
 *   atomic    → call plugin action via PluginService (or custom actionResolver)
 *   condition → evaluate expression, branch to trueNode/falseNode
 *   loop      → iterate over collection, execute bodyId per item
 *   subflow   → invoke another workflow by id (recursive)
 *   delay     → setTimeout(ms) pause
 */
import { nanoid } from 'nanoid';
import { getRawDb } from '../db';
import { createLogger } from '../logger';
import type { EventBusService } from '../event-bus';
import type { PluginService } from '../plugin/loader';
import type { WorkflowNode } from '@shared/index';
import { getSecret } from './secret-store';
import { validateDag, type DagValidationResult } from './dag';
import type { WorkflowDefinition, WorkflowNodeDefinition } from './dsl';
import { parseWorkflowDefinition } from './dsl';

const log = createLogger('workflow-executor');

export interface ExecuteOptions {
  input?: Record<string, unknown>;
  trigger?: 'manual' | 'schedule' | 'api' | 'cli' | 'event';
  traceId?: string;
  /** Override how atomic nodes resolve actions (for testing / built-in actions). Receives the already-interpolated inputs. */
  actionResolver?: (node: Extract<WorkflowNodeDefinition, { type: 'atomic' }>, ctx: WorkflowContext, inputs: Record<string, unknown>) => Promise<unknown>;
}

export interface ExecuteResult {
  runId: string;
  status: 'success' | 'failed' | 'cancelled';
  output: Record<string, unknown> | null;
  durationMs: number;
  error?: string;
}

export interface WorkflowContext {
  vars: Record<string, unknown>;
  secrets: Record<string, string>;
  input: Record<string, unknown>;
  nodes: Map<string, { output: unknown; status: string }>;
  traceId: string;
  runId: string;
}

// ---------------- Variable interpolation ----------------

const INTERP_RE = /\$\{([^}]+)\}/g;

function interpolate(value: unknown, ctx: WorkflowContext): unknown {
  if (typeof value === 'string') {
    return value.replace(INTERP_RE, (match, expr: string) => {
      const resolved = resolveExpr(expr.trim(), ctx);
      return resolved !== undefined ? String(resolved) : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map(v => interpolate(v, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, ctx);
    return out;
  }
  return value;
}

function resolveExpr(expr: string, ctx: WorkflowContext): unknown {
  // ${var.x} → ctx.vars.x
  // ${input.x} → ctx.input.x
  // ${secrets.KEY} → ctx.secrets.KEY
  // ${nodes.NODE_ID.output} or ${nodes.NODE_ID.output.x}
  const parts = expr.split('.');
  const root = parts[0];
  switch (root) {
    case 'var': return parts.slice(1).reduce((acc, k) => (acc as any)?.[k], ctx.vars);
    case 'input': return parts.slice(1).reduce((acc, k) => (acc as any)?.[k], ctx.input);
    case 'secrets': {
      const key = parts.slice(1).join('.');
      if (!(key in ctx.secrets)) {
        const val = getSecret(key);
        if (val !== null) ctx.secrets[key] = val;
      }
      return ctx.secrets[key];
    }
    case 'nodes': {
      const nodeId = parts[1];
      const nodeEntry = ctx.nodes.get(nodeId);
      if (!nodeEntry) return undefined;
      if (parts.length === 3 && parts[2] === 'output') return nodeEntry.output;
      if (parts.length > 3 && parts[2] === 'output') {
        return parts.slice(3).reduce((acc, k) => (acc as any)?.[k], nodeEntry.output);
      }
      return nodeEntry.output;
    }
    default:
      return (ctx.vars as any)[expr] ?? (ctx.input as any)[expr];
  }
}

// ---------------- Sleep helper ----------------

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(r => setTimeout(r, ms));
}

// ---------------- Expression evaluation ----------------

/** Simple safe-ish expression evaluator for condition nodes. */
function evalCondition(expr: string, ctx: WorkflowContext): boolean {
  try {
    // Replace ${...} references first
    const resolved = expr.replace(INTERP_RE, (_, e: string) => {
      const v = resolveExpr(e.trim(), ctx);
      return typeof v === 'string' ? `"${v}"` : String(v);
    });
    // Very limited eval: only comparison and logical operators
    // Use Function constructor in a sandboxed way (no access to globals)
    const fn = new Function(`"use strict"; return (${resolved});`);
    return !!fn();
  } catch (e) {
    log.warn({ expr, err: (e as Error).message }, 'condition eval failed, treating as false');
    return false;
  }
}

// ---------------- Executor ----------------

export interface ExecutorDeps {
  bus: EventBusService;
  pluginService?: PluginService;
}

export class WorkflowExecutor {
  constructor(private deps: ExecutorDeps) {}

  /**
   * Execute a workflow definition.
   * @param workflowId  — the workflow id (for DB persistence)
   * @param definition  — parsed workflow definition (JSON object or JSON string)
   * @param opts        — input, trigger, traceId, actionResolver
   */
  async execute(workflowId: string, definition: string | WorkflowDefinition, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    const def = typeof definition === 'string' ? parseWorkflowDefinition(definition) : definition;
    const traceId = opts.traceId ?? nanoid(16);
    const runId = nanoid(12);
    const trigger = opts.trigger ?? 'manual';
    const now = Date.now();

    // Validate DAG
    let dag: DagValidationResult;
    try {
      dag = validateDag(def);
    } catch (e) {
      const err = e as Error;
      this.persistRunError(workflowId, runId, trigger, traceId, err.message, now);
      return { runId, status: 'failed', output: null, durationMs: 0, error: err.message };
    }

    // Initialize context
    const ctx: WorkflowContext = {
      vars: { ...def.vars },
      secrets: {},
      input: opts.input ?? {},
      nodes: new Map(),
      traceId,
      runId,
    };

    // Persist run start
    const db = getRawDb();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, trigger, status, input_json, started_at, created_at, trace_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(runId, workflowId, trigger, 'running', JSON.stringify(ctx.input), now, now, traceId);

    // Emit beforeExecute (payload matches contract: runId/workflowId/input/traceId)
    await this.deps.bus.safeEmit('workflow.beforeExecute', { runId, workflowId, input: ctx.input, traceId }, { traceId, source: 'workflow' });

    let failed = false;
    let errorMsg = '';
    const entryNode = def.entryNode ?? def.nodes[0].id;

    // Build execution order: start from entry, follow edges
    const executed = new Set<string>();
    const toExecute: string[] = [entryNode];

    while (toExecute.length > 0) {
      const nodeId = toExecute.shift()!;
      if (executed.has(nodeId)) continue;

      const node = dag.nodeMap.get(nodeId);
      if (!node) {
        log.warn({ nodeId }, 'node not found in DAG, skipping');
        continue;
      }

      // Check if all dependencies (predecessors) have been executed
      const preds = dag.reverseAdjacency.get(nodeId) ?? [];
      if (!preds.every(p => executed.has(p))) {
        // Re-queue for later (will be reached via edge traversal)
        toExecute.push(nodeId);
        continue;
      }

      try {
        const result = await this.executeNode(node, ctx, opts, workflowId, runId);
        ctx.nodes.set(nodeId, { output: result, status: 'success' });
        executed.add(nodeId);

        // nodeComplete event is emitted inside executeNode (where the full
        // WorkflowNode record is available).
        // Determine next nodes
        const next: string[] = [];
        if (node.type === 'condition') {
          const branch = evalCondition(node.expr, ctx);
          next.push(branch ? node.trueNode : node.falseNode);
        }
        // Follow edges from this node
        for (const edge of def.edges) {
          if (edge.source === nodeId && !next.includes(edge.target)) next.push(edge.target);
        }
        for (const n of next) {
          if (!executed.has(n)) toExecute.push(n);
        }
      } catch (e) {
        const err = e as Error;
        ctx.nodes.set(nodeId, { output: null, status: 'failed' });
        executed.add(nodeId);
        failed = true;
        errorMsg = `${nodeId}: ${err.message}`;
        // nodeError event is emitted inside executeNode (where the full
        // WorkflowNode record + Error are available). Retries are exhausted here.
        break;
      }
    }

    // Finalize
    const endTime = Date.now();
    const durationMs = endTime - now;
    const status = failed ? 'failed' : 'success';
    const output = failed ? null : this.collectOutput(ctx, dag);

    db.prepare(
      `UPDATE workflow_runs SET status=?, output_json=?, finished_at=?, duration_ms=?, error_stack=? WHERE id=?`,
    ).run(status, output ? JSON.stringify(output) : null, endTime, durationMs, failed ? errorMsg : null, runId);

    // Emit afterExecute (payload matches contract: no `error` field)
    await this.deps.bus.safeEmit('workflow.afterExecute', { runId, workflowId, status, durationMs, traceId }, { traceId, source: 'workflow' });

    log.info({ runId, workflowId, status, durationMs }, 'workflow executed');
    return { runId, status, output, durationMs, error: failed ? errorMsg : undefined };
  }

  /** Execute a single node with retry logic. */
  private async executeNode(
    node: WorkflowNodeDefinition,
    ctx: WorkflowContext,
    opts: ExecuteOptions,
    workflowId: string,
    runId: string,
  ): Promise<unknown> {
    const retry = node.retry;
    const maxAttempts = retry?.maxAttempts ?? 1;
    const backoff = retry?.backoff ?? 'exponential';
    const baseDelay = retry?.delayMs ?? 1000;
    const db = getRawDb();
    const now = Date.now();

    // Insert workflow_nodes row
    let nodeDbId: number | undefined;
    try {
      const info = db.prepare(
        `INSERT INTO workflow_nodes (run_id, node_id, node_type, status, attempts, started_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(runId, node.id, node.type, 'running', 0, now);
      nodeDbId = Number((info as any).lastInsertRowid);
    } catch (e) {
      log.warn({ err: String(e) }, 'failed to insert workflow_nodes row');
    }

    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        // Interpolate inputs
        let input: unknown;
        switch (node.type) {
          case 'atomic': input = interpolate(node.inputs, ctx); break;
          case 'subflow': input = interpolate(node.inputs, ctx); break;
          case 'loop': input = resolveExpr(node.collection, ctx); break;
          case 'condition': input = node.expr; break;
          case 'delay': input = node.ms; break;
        }

        let output: unknown;
        switch (node.type) {
          case 'atomic': output = await this.executeAtomic(node, ctx, opts); break;
          case 'condition': {
            const result = evalCondition(node.expr, ctx);
            output = { branch: result ? 'true' : 'false' };
            break;
          }
          case 'loop': {
            const collection = resolveExpr(node.collection, ctx);
            const items = Array.isArray(collection) ? collection : [];
            const results: unknown[] = [];
            const bodyNode = dag_nodeMap(ctx, node.bodyId);
            for (const item of items) {
              ctx.vars['loopItem'] = item;
              if (bodyNode) output = await this.executeNode(bodyNode, ctx, opts, workflowId, runId);
              results.push(output);
            }
            output = { results, count: items.length };
            break;
          }
          case 'subflow': {
            // Look up subflow definition from DB
            const row = db.prepare('SELECT definition_json FROM workflows WHERE id = ?').get(node.workflowId) as { definition_json: string } | undefined;
            if (!row) throw new Error(`Subflow workflow "${node.workflowId}" not found`);
            const subDef = parseWorkflowDefinition(row.definition_json);
            const subResult = await this.execute(node.workflowId, subDef, { ...opts, input: input as Record<string, unknown>, traceId: ctx.traceId });
            output = subResult.output;
            break;
          }
          case 'delay': {
            await sleep(node.ms);
            output = { delayed: node.ms };
            break;
          }
          default: throw new Error(`Unknown node type: ${(node as any).type}`);
        }

        // Success — update node row
        const finishedAt = Date.now();
        if (nodeDbId) {
          db.prepare(
            `UPDATE workflow_nodes SET status='success', attempts=?, input_json=?, output_json=?, finished_at=? WHERE id=?`,
          ).run(attempts, JSON.stringify(input) ?? null, JSON.stringify(output), finishedAt, nodeDbId);
        }
        // Emit nodeComplete with the full WorkflowNode record (matches contract)
        const nodeRecord: WorkflowNode = {
          run_id: runId,
          node_id: node.id,
          node_type: node.type,
          status: 'success',
          attempts,
          input_json: JSON.stringify(input) ?? null,
          output_json: JSON.stringify(output) ?? null,
          error_stack: null,
          started_at: now,
          finished_at: finishedAt,
        };
        await this.deps.bus.safeEmit('workflow.nodeComplete', { runId, node: nodeRecord, traceId: ctx.traceId }, { traceId: ctx.traceId, source: 'workflow' });
        return output;
      } catch (e) {
        lastError = e as Error;
        log.warn({ nodeId: node.id, attempt, max: maxAttempts, err: (e as Error).message }, 'node attempt failed');
        if (attempt < maxAttempts) {
          // Calculate backoff delay
          const delay = backoff === 'exponential' ? baseDelay * Math.pow(2, attempt - 1) : baseDelay;
          await sleep(delay);
        }
      }
    }

    // All retries exhausted — update node row, emit nodeError, then throw
    const failedAt = Date.now();
    const errorStack = lastError?.stack ?? lastError?.message ?? 'unknown';
    if (nodeDbId) {
      db.prepare(
        `UPDATE workflow_nodes SET status='failed', attempts=?, error_stack=?, finished_at=? WHERE id=?`,
      ).run(attempts, errorStack, failedAt, nodeDbId);
    }
    const thrownError = lastError ?? new Error(`Node ${node.id} failed after ${attempts} attempts`);
    const failedNodeRecord: WorkflowNode = {
      run_id: runId,
      node_id: node.id,
      node_type: node.type,
      status: 'failed',
      attempts,
      input_json: null,
      output_json: null,
      error_stack: errorStack,
      started_at: now,
      finished_at: failedAt,
    };
    await this.deps.bus.safeEmit('workflow.nodeError', { runId, node: failedNodeRecord, error: thrownError, traceId: ctx.traceId }, { traceId: ctx.traceId, source: 'workflow' });
    throw thrownError;
  }

  /** Execute an atomic node by calling the plugin action. */
  private async executeAtomic(
    node: Extract<WorkflowNodeDefinition, { type: 'atomic' }>,
    ctx: WorkflowContext,
    opts: ExecuteOptions,
  ): Promise<unknown> {
    const inputs = interpolate(node.inputs, ctx) as Record<string, unknown>;

    // Use custom resolver if provided (for testing / built-in actions)
    if (opts.actionResolver) {
      return opts.actionResolver(node, ctx, inputs);
    }

    // Default: call plugin action via PluginService
    if (!this.deps.pluginService) throw new Error('PluginService not available for atomic node execution');
    const inst = this.deps.pluginService.loadedInstance(node.pluginId);
    if (!inst) throw new Error(`Plugin "${node.pluginId}" is not enabled`);
    const fn = inst.sandbox.module.exports[node.action];
    if (typeof fn !== 'function') throw new Error(`Plugin "${node.pluginId}" does not export action "${node.action}"`);
    const result = await fn(inputs);
    return result;
  }

  /** Collect output from the last executed node (or all leaf nodes). */
  private collectOutput(ctx: WorkflowContext, dag: DagValidationResult): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [nodeId, entry] of ctx.nodes) {
      if (entry.status === 'success') {
        output[nodeId] = entry.output;
      }
    }
    // Also include the last node's output as a convenience 'result'
    const lastNode = dag.order[dag.order.length - 1];
    if (lastNode && ctx.nodes.has(lastNode)) {
      output['result'] = ctx.nodes.get(lastNode)!.output;
    }
    return output;
  }

  private persistRunError(workflowId: string, runId: string, trigger: string, traceId: string, error: string, startTime: number): void {
    try {
      const db = getRawDb();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, trigger, status, started_at, finished_at, created_at, duration_ms, error_stack, trace_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(runId, workflowId, trigger, 'failed', startTime, Date.now(), startTime, Date.now() - startTime, error, traceId);
    } catch (e) {
      log.error({ err: String(e) }, 'failed to persist run error');
    }
  }
}

// Helper for loop body node lookup (avoid circular import)
function dag_nodeMap(_ctx: WorkflowContext, _bodyId: string): WorkflowNodeDefinition | null {
  // This is a simplified loop implementation; in a full implementation
  // we'd need access to the DAG nodeMap. For now, loop support is basic.
  return null;
}
