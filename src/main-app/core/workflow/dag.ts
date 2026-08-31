/**
 * DAG validation — topological sort + cycle detection + orphan detection.
 *
 * Uses Kahn's algorithm (in-degree BFS) for deterministic ordering.
 * Throws CycleDetectedError on cyclic graphs.
 */
import type { WorkflowDefinition, WorkflowNodeDefinition } from './dsl';

export class CycleDetectedError extends Error {
  override name = 'CycleDetectedError';
  constructor(public readonly cycleNodes: string[]) {
    super(`Cycle detected involving nodes: ${cycleNodes.join(' → ')}`);
  }
}

export class OrphanNodeError extends Error {
  override name = 'OrphanNodeError';
  constructor(public readonly nodeId: string) {
    super(`Node "${nodeId}" is unreachable (no incoming edges and not the entry node)`);
  }
}

export class MissingNodeError extends Error {
  override name = 'MissingNodeError';
  constructor(public readonly referencedId: string, public readonly fromNode?: string) {
    super(`Edge references missing node "${referencedId}"${fromNode ? ` (from node "${fromNode}")` : ''}`);
  }
}

export interface DagValidationResult {
  /** Nodes in topological execution order. */
  order: string[];
  /** Map of nodeId → node definition. */
  nodeMap: Map<string, WorkflowNodeDefinition>;
  /** Adjacency list: source → targets. */
  adjacency: Map<string, string[]>;
  /** Reverse adjacency: target → sources. */
  reverseAdjacency: Map<string, string[]>;
}

export function validateDag(def: WorkflowDefinition, opts?: { allowOrphans?: boolean }): DagValidationResult {
  const nodeMap = new Map<string, WorkflowNodeDefinition>();
  for (const n of def.nodes) {
    if (nodeMap.has(n.id)) throw new Error(`Duplicate node id: "${n.id}"`);
    nodeMap.set(n.id, n);
  }

  // Validate edges reference existing nodes
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of def.nodes) {
    adjacency.set(n.id, []);
    reverseAdjacency.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of def.edges) {
    if (!nodeMap.has(e.source)) throw new MissingNodeError(e.source);
    if (!nodeMap.has(e.target)) throw new MissingNodeError(e.target);
    adjacency.get(e.source)!.push(e.target);
    reverseAdjacency.get(e.target)!.push(e.source);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  // Check for orphan nodes (no incoming edges and not the entry node)
  const entryNode = def.entryNode ?? def.nodes[0]?.id;
  if (!opts?.allowOrphans) {
    for (const n of def.nodes) {
      if ((inDegree.get(n.id) ?? 0) === 0 && n.id !== entryNode) {
        throw new OrphanNodeError(n.id);
      }
    }
  }

  // Kahn's algorithm for topological sort + cycle detection
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const order: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    visited.add(current);
    order.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  // If not all nodes were visited, there's a cycle
  if (visited.size < def.nodes.length) {
    const cycleNodes = def.nodes.filter(n => !visited.has(n.id)).map(n => n.id);
    throw new CycleDetectedError(cycleNodes);
  }

  return { order, nodeMap, adjacency, reverseAdjacency };
}
