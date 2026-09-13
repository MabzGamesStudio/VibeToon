import { hashValue } from '../ids';
import { findPort, getFlowKind, portsCompatible } from '../registry/flowKinds';
import type { ArtifactRef } from '../types/artifacts';
import type { PortSpec } from '../types/flow';
import type { Connection, FlowNode, FlowStatus, PortRef, Project } from '../types/project';

export function nodeById(project: Project, nodeId: string): FlowNode | undefined {
  return project.nodes.find((n) => n.id === nodeId);
}

export function connectionsInto(project: Project, nodeId: string): Connection[] {
  return project.connections.filter((c) => c.to.nodeId === nodeId);
}

export function connectionsOutOf(project: Project, nodeId: string): Connection[] {
  return project.connections.filter((c) => c.from.nodeId === nodeId);
}

export function artifactForPort(node: FlowNode, portId: string): ArtifactRef | undefined {
  return node.outputs.find((a) => a.port === portId);
}

/** One resolved incoming edge: the connection, its source, and what it carries. */
export interface ResolvedInput {
  connection: Connection;
  sourceNode: FlowNode;
  sourcePort: PortSpec | undefined;
  targetPort: PortSpec | undefined;
  artifact: ArtifactRef | undefined;
}

export function resolveInputs(project: Project, nodeId: string): ResolvedInput[] {
  const target = nodeById(project, nodeId);
  if (!target) return [];
  return connectionsInto(project, nodeId)
    .map((connection) => {
      const sourceNode = nodeById(project, connection.from.nodeId);
      if (!sourceNode) return undefined;
      return {
        connection,
        sourceNode,
        sourcePort: findPort(sourceNode.kind, connection.from.portId, 'outputs'),
        targetPort: findPort(target.kind, connection.to.portId, 'inputs'),
        artifact: artifactForPort(sourceNode, connection.from.portId),
      } satisfies ResolvedInput;
    })
    .filter((x): x is ResolvedInput => x !== undefined);
}

/** Enabled inputs landing on one input port, in graph order. */
export function inputsForPort(project: Project, nodeId: string, portId: string): ResolvedInput[] {
  return resolveInputs(project, nodeId).filter(
    (i) => i.connection.to.portId === portId && i.connection.settings.enabled,
  );
}

export interface ValidationResult {
  ok: boolean
  reason?: string;
}

export function validateConnection(project: Project, from: PortRef, to: PortRef): ValidationResult {
  if (from.nodeId === to.nodeId) return { ok: false, reason: 'A flow cannot feed itself.' };

  const sourceNode = nodeById(project, from.nodeId);
  const targetNode = nodeById(project, to.nodeId);
  if (!sourceNode || !targetNode) return { ok: false, reason: 'Flow not found.' };

  const sourcePort = findPort(sourceNode.kind, from.portId, 'outputs');
  const targetPort = findPort(targetNode.kind, to.portId, 'inputs');
  if (!sourcePort) return { ok: false, reason: `No output \`${from.portId}\` on ${sourceNode.name}.` };
  if (!targetPort) return { ok: false, reason: `No input \`${to.portId}\` on ${targetNode.name}.` };

  if (!portsCompatible(sourcePort, targetPort)) {
    return {
      ok: false,
      reason: `${sourcePort.label} carries ${sourcePort.kinds.join('/')} but ${targetPort.label} accepts ${targetPort.kinds.join('/')}.`,
    };
  }

  const duplicate = project.connections.some(
    (c) =>
      c.from.nodeId === from.nodeId &&
      c.from.portId === from.portId &&
      c.to.nodeId === to.nodeId &&
      c.to.portId === to.portId,
  );
  if (duplicate) return { ok: false, reason: 'That connection already exists.' };

  const existing = project.connections.filter(
    (c) => c.to.nodeId === to.nodeId && c.to.portId === to.portId,
  );
  if (!targetPort.multiple && existing.length > 0) {
    return { ok: false, reason: `${targetPort.label} takes a single input.` };
  }

  if (createsCycle(project, from.nodeId, to.nodeId)) {
    return { ok: false, reason: 'That would make a loop in the graph.' };
  }

  return { ok: true };
}

/** True when adding from -> to would close a cycle (i.e. `from` is already downstream of `to`). */
export function createsCycle(project: Project, fromNodeId: string, toNodeId: string): boolean {
  const seen = new Set<string>();
  const stack = [toNodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === fromNodeId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const connection of connectionsOutOf(project, current)) {
      stack.push(connection.to.nodeId);
    }
  }
  return false;
}

export interface TopoResult {
  /** Node ids in dependency order. */
  order: string[];
  /** Node ids that could not be ordered because they sit on a cycle. */
  cyclic: string[];
}

export function topoOrder(project: Project): TopoResult {
  const indegree = new Map<string, number>();
  for (const node of project.nodes) indegree.set(node.id, 0);
  for (const connection of project.connections) {
    if (!indegree.has(connection.to.nodeId) || !indegree.has(connection.from.nodeId)) continue;
    indegree.set(connection.to.nodeId, (indegree.get(connection.to.nodeId) ?? 0) + 1);
  }

  const queue = project.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const connection of connectionsOutOf(project, id)) {
      const next = connection.to.nodeId;
      if (!indegree.has(next)) continue;
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const ordered = new Set(order);
  return { order, cyclic: project.nodes.filter((n) => !ordered.has(n.id)).map((n) => n.id) };
}

/** Every node upstream of `nodeId`, nearest first. */
export function upstreamNodes(project: Project, nodeId: string): FlowNode[] {
  const out: FlowNode[] = [];
  const seen = new Set<string>([nodeId]);
  let frontier = [nodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const connection of connectionsInto(project, id)) {
        const sourceId = connection.from.nodeId;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);
        const node = nodeById(project, sourceId);
        if (node) {
          out.push(node);
          next.push(sourceId);
        }
      }
    }
    frontier = next;
  }
  return out;
}

export function downstreamNodes(project: Project, nodeId: string): FlowNode[] {
  const out: FlowNode[] = [];
  const seen = new Set<string>([nodeId]);
  let frontier = [nodeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const connection of connectionsOutOf(project, id)) {
        const targetId = connection.to.nodeId;
        if (seen.has(targetId)) continue;
        seen.add(targetId);
        const node = nodeById(project, targetId);
        if (node) {
          out.push(node);
          next.push(targetId);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Everything that can change a flow's output: its own editable state, the
 * project settings a generator reads, and — for each enabled incoming
 * connection — the rules on the wire and the hash of the artifact it carries.
 * Comparing this against `lastRun.signature` is how staleness is detected,
 * which is what makes the graph tell you what needs regenerating.
 */
export function computeSignature(project: Project, node: FlowNode): string {
  const inputs = resolveInputs(project, node.id)
    .filter((i) => i.connection.settings.enabled)
    .map((i) => ({
      from: `${i.connection.from.nodeId}:${i.connection.from.portId}`,
      to: i.connection.to.portId,
      rules: i.connection.rules,
      mode: i.connection.settings.mode,
      weight: i.connection.settings.weight,
      notes: i.connection.settings.notes,
      artifact: i.artifact?.hash ?? null,
    }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  return hashValue({
    kind: node.kind,
    name: node.name,
    notes: node.notes,
    data: node.data,
    settings: {
      fps: project.settings.fps,
      width: project.settings.width,
      height: project.settings.height,
      defaultShotSeconds: project.settings.defaultShotSeconds,
      styleNote: project.settings.styleNote,
    },
    inputs,
  });
}

export function missingRequiredInputs(project: Project, node: FlowNode): PortSpec[] {
  const def = getFlowKind(node.kind);
  if (!def) return [];
  return def.inputs.filter((port) => {
    if (!port.required) return false;
    return inputsForPort(project, node.id, port.id).length === 0;
  });
}

export function flowStatus(project: Project, node: FlowNode): FlowStatus {
  if (node.lastRun?.error) return 'error';
  if (!node.lastRun || node.outputs.length === 0) return 'empty';
  return node.lastRun.signature === computeSignature(project, node) ? 'ready' : 'stale';
}

/** Nodes whose outputs would change if regenerated, in dependency order. */
export function staleNodes(project: Project): FlowNode[] {
  const { order } = topoOrder(project);
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  return order
    .map((id) => byId.get(id))
    .filter((n): n is FlowNode => n !== undefined)
    .filter((n) => {
      const status = flowStatus(project, n);
      return status === 'stale' || status === 'empty' || status === 'error';
    });
}
