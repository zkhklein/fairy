/**
 * Workflow DSL — Zod schema for JSON workflow definitions.
 *
 * A workflow definition consists of:
 *   - nodes[]: ordered list of typed nodes (atomic/condition/loop/subflow/delay)
 *   - edges[]: directed edges connecting nodes (source → target)
 *   - vars?:   global variable defaults (overridable per-run)
 *
 * Node types:
 *   atomic    — calls a plugin action (pluginId, action, inputs)
 *   condition — evaluates an expression, branches to trueNode / falseNode
 *   loop      — iterates over a collection, executing bodyId per item
 *   subflow   — invokes another workflow by id
 *   delay     — pauses execution for N milliseconds
 */
import { z } from 'zod';

// ---------- Node schemas ----------

const retrySchema = z.object({
  maxAttempts: z.number().int().positive().default(1),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  delayMs: z.number().int().nonnegative().default(1000),
}).optional();

const baseNodeFields = {
  id: z.string().min(1),
  name: z.string().optional(),
  retry: retrySchema,
};

const atomicNode = z.object({
  ...baseNodeFields,
  type: z.literal('atomic'),
  pluginId: z.string().min(1),
  action: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const conditionNode = z.object({
  ...baseNodeFields,
  type: z.literal('condition'),
  expr: z.string().min(1),
  trueNode: z.string().min(1),
  falseNode: z.string().min(1),
});

const loopNode = z.object({
  ...baseNodeFields,
  type: z.literal('loop'),
  collection: z.string().min(1),
  bodyId: z.string().min(1),
});

const subflowNode = z.object({
  ...baseNodeFields,
  type: z.literal('subflow'),
  workflowId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const delayNode = z.object({
  ...baseNodeFields,
  type: z.literal('delay'),
  ms: z.number().int().nonnegative(),
});

export const WorkflowNodeDefinitionSchema = z.discriminatedUnion('type', [
  atomicNode,
  conditionNode,
  loopNode,
  subflowNode,
  delayNode,
]);
export type WorkflowNodeDefinition = z.infer<typeof WorkflowNodeDefinitionSchema>;

export const WorkflowEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

// ---------- Full definition ----------

export const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeDefinitionSchema).min(1),
  edges: z.array(WorkflowEdgeSchema).default([]),
  vars: z.record(z.string(), z.unknown()).default({}),
  entryNode: z.string().optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ---------- Parse helper ----------

export function parseWorkflowDefinition(json: string): WorkflowDefinition {
  const raw = JSON.parse(json);
  return WorkflowDefinitionSchema.parse(raw);
}
