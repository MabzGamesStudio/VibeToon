import { newId } from '../ids';
import { findPort, getFlowKind } from '../registry/flowKinds';
import type { ArtifactKind } from '../types/artifacts';
import type { PortSpec } from '../types/flow';
import type {
  Connection,
  ConnectionSettings,
  FlowData,
  FlowNode,
  PortRef,
  Project,
  Vec2,
} from '../types/project';

/**
 * Custom flows: an arrangement of flows saved under a name and used again as one.
 *
 * A **template** is the arrangement as it was saved — which flows, their
 * settings, the wires between them, and which of their ports face outwards. It
 * lives with the project, and the palette lists it beside the built-in flows.
 *
 * An **instance** is one use of it on the graph: a single card with the
 * template's ports. Behind the card, each instance has its own copies of the
 * member flows — real flows in the project, marked as belonging to it and not
 * drawn on the graph. So every editor, generator and undo step works on them as
 * it does on any flow, and editing one instance's members changes that instance
 * alone: the template, and every other instance made from it, are untouched.
 *
 * Wires to and from an instance are ordinary connections to the member ports
 * behind it. The graph draws them at the instance's own port, and a wire
 * dropped on the instance's port is stored against the member port it stands
 * for.
 */

export const CUSTOM_FLOW_KIND = 'custom.flow';

/** One of an instance's ports: which member port it stands for, and what that port is. */
export interface ExposedPort {
  id: string;
  label: string;
  kinds: ArtifactKind[];
  description: string;
  required?: boolean;
  multiple?: boolean;
  /** The member flow and its port. */
  node: string;
  port: string;
}

export interface CustomFlowData {
  editor: 'custom';
  templateId: string;
  /** What the template was called when this was made, for the card. */
  templateName: string;
  inputs: ExposedPort[];
  outputs: ExposedPort[];
}

export function emptyCustomFlowData(): CustomFlowData {
  return { editor: 'custom', templateId: '', templateName: '', inputs: [], outputs: [] };
}

export interface TemplateMember {
  /** Stable within the template; members are given fresh ids in each instance. */
  key: string;
  kind: string;
  name: string;
  notes: string;
  data: FlowData;
  /** Where it sat relative to the others, so opening it out can lay it out again. */
  offset: Vec2;
}

export interface TemplatePort {
  id: string;
  label: string;
  key: string;
  port: string;
}

export interface CustomFlowTemplate {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  members: TemplateMember[];
  connections: Array<{
    from: { key: string; portId: string };
    to: { key: string; portId: string };
    rules: string;
    settings: ConnectionSettings;
  }>;
  inputs: TemplatePort[];
  outputs: TemplatePort[];
}

export function isCustomNode(node: FlowNode | undefined): boolean {
  return node?.kind === CUSTOM_FLOW_KIND;
}

export function customDataOf(node: FlowNode): CustomFlowData {
  return node.data.editor === 'custom' ? (node.data as CustomFlowData) : emptyCustomFlowData();
}

/** The flows behind an instance, in the project's order. */
export function membersOf(project: Project, groupId: string): FlowNode[] {
  return project.nodes.filter((node) => node.group === groupId);
}

export function templateById(project: Project, id: string): CustomFlowTemplate | undefined {
  return (project.customFlows ?? []).find((template) => template.id === id);
}

/** The flows drawn on the graph: everything not behind an instance. */
export function visibleNodes(project: Project): FlowNode[] {
  return project.nodes.filter((node) => !node.group);
}

/* ------------------------------------------------------------------ *
 * Ports
 * ------------------------------------------------------------------ */

function asSpec(port: ExposedPort): PortSpec {
  return {
    id: port.id,
    label: port.label,
    kinds: port.kinds,
    description: port.description,
    ...(port.required ? { required: true } : {}),
    ...(port.multiple ? { multiple: true } : {}),
  };
}

/** A flow's ports: its kind's, or an instance's own. */
export function flowPorts(node: FlowNode): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (isCustomNode(node)) {
    const data = customDataOf(node);
    return { inputs: data.inputs.map(asSpec), outputs: data.outputs.map(asSpec) };
  }
  const def = getFlowKind(node.kind);
  return { inputs: def?.inputs ?? [], outputs: def?.outputs ?? [] };
}

/** One port of a flow, instance or not. */
export function portOf(node: FlowNode, portId: string, side: 'inputs' | 'outputs'): PortSpec | undefined {
  if (isCustomNode(node)) return flowPorts(node)[side].find((port) => port.id === portId);
  return findPort(node.kind, portId, side);
}

/**
 * Where a wire really goes: an instance's port is the member port behind it.
 * Anything else is where it says.
 */
export function realEndpoint(project: Project, ref: PortRef, side: 'in' | 'out'): PortRef {
  const node = project.nodes.find((candidate) => candidate.id === ref.nodeId);
  if (!node || !isCustomNode(node)) return ref;
  const data = customDataOf(node);
  const port = (side === 'in' ? data.inputs : data.outputs).find((candidate) => candidate.id === ref.portId);
  return port ? { nodeId: port.node, portId: port.port } : ref;
}

/**
 * Where a wire is drawn: a member port that an instance shows is drawn at the
 * instance, and one it does not show is inside it and not drawn at all (null).
 * Keyed `node|port|in` or `node|port|out`.
 */
export function shownEndpoints(project: Project): Map<string, PortRef | null> {
  const out = new Map<string, PortRef | null>();
  for (const node of project.nodes) {
    if (!node.group) continue;
    const { inputs, outputs } = flowPorts(node);
    for (const port of inputs) out.set(`${node.id}|${port.id}|in`, null);
    for (const port of outputs) out.set(`${node.id}|${port.id}|out`, null);
  }
  for (const node of project.nodes) {
    if (!isCustomNode(node)) continue;
    const data = customDataOf(node);
    for (const port of data.inputs) out.set(`${port.node}|${port.port}|in`, { nodeId: node.id, portId: port.id });
    for (const port of data.outputs) out.set(`${port.node}|${port.port}|out`, { nodeId: node.id, portId: port.id });
  }
  return out;
}

/** Where to draw one end of a connection, or null when it is inside an instance. */
export function shownEnd(shown: Map<string, PortRef | null>, ref: PortRef, side: 'in' | 'out'): PortRef | null {
  const key = `${ref.nodeId}|${ref.portId}|${side}`;
  return shown.has(key) ? shown.get(key)! : ref;
}

/**
 * The ports an arrangement would show, worked out from the wiring.
 *
 * An input faces outwards unless another member feeds it — wired from outside,
 * or not wired at all, it is something the arrangement takes. An output faces
 * outwards if something outside reads it, or if nothing inside does: a member
 * whose result nobody in the arrangement uses is making it for someone.
 */
export function proposePorts(project: Project, memberIds: readonly string[]): { inputs: ExposedPort[]; outputs: ExposedPort[] } {
  const members = new Set(memberIds);
  const nodes = project.nodes.filter((node) => members.has(node.id));
  const inside = project.connections.filter((c) => members.has(c.from.nodeId) && members.has(c.to.nodeId));
  const readOutside = project.connections.filter((c) => members.has(c.from.nodeId) && !members.has(c.to.nodeId));

  const inputs: ExposedPort[] = [];
  const outputs: ExposedPort[] = [];
  for (const node of nodes) {
    const ports = flowPorts(node);
    for (const port of ports.inputs) {
      if (inside.some((c) => c.to.nodeId === node.id && c.to.portId === port.id)) continue;
      inputs.push(expose(node, port));
    }
    for (const port of ports.outputs) {
      const usedInside = inside.some((c) => c.from.nodeId === node.id && c.from.portId === port.id);
      const usedOutside = readOutside.some((c) => c.from.nodeId === node.id && c.from.portId === port.id);
      if (usedInside && !usedOutside) continue;
      outputs.push(expose(node, port));
    }
  }
  return { inputs: uniqueLabels(inputs, nodes), outputs: uniqueLabels(outputs, nodes) };
}

function expose(node: FlowNode, port: PortSpec): ExposedPort {
  return {
    id: `${node.id}.${port.id}`,
    label: port.label,
    kinds: [...port.kinds],
    description: port.description,
    ...(port.required ? { required: true } : {}),
    ...(port.multiple ? { multiple: true } : {}),
    node: node.id,
    port: port.id,
  };
}

/** Two ports both called "Image" are told apart by their flows' names. */
function uniqueLabels(ports: ExposedPort[], nodes: FlowNode[]): ExposedPort[] {
  const counts = new Map<string, number>();
  for (const port of ports) counts.set(port.label, (counts.get(port.label) ?? 0) + 1);
  return ports.map((port) =>
    (counts.get(port.label) ?? 0) > 1
      ? { ...port, label: `${nodes.find((node) => node.id === port.node)?.name ?? '?'} · ${port.label}` }
      : port,
  );
}

/* ------------------------------------------------------------------ *
 * Making one
 * ------------------------------------------------------------------ */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Port ids on an instance are the template's, so every instance of one template has the same ports. */
function templatePorts(ports: ExposedPort[], keyOf: Map<string, string>): TemplatePort[] {
  return ports.map((port) => ({
    id: `${keyOf.get(port.node)}.${port.port}`,
    label: port.label,
    key: keyOf.get(port.node)!,
    port: port.port,
  }));
}

function templateOf(
  project: Project,
  members: FlowNode[],
  inputs: ExposedPort[],
  outputs: ExposedPort[],
  meta: { id: string; name: string; description: string; createdAt: string },
): CustomFlowTemplate {
  const keyOf = new Map(members.map((node, index) => [node.id, `m${index + 1}`]));
  const minX = Math.min(...members.map((node) => node.position.x));
  const minY = Math.min(...members.map((node) => node.position.y));
  const ids = new Set(members.map((node) => node.id));
  return {
    ...meta,
    updatedAt: new Date().toISOString(),
    members: members.map((node) => ({
      key: keyOf.get(node.id)!,
      kind: node.kind,
      name: node.name,
      notes: node.notes,
      data: clone(node.data),
      offset: { x: node.position.x - minX, y: node.position.y - minY },
    })),
    connections: project.connections
      .filter((c) => ids.has(c.from.nodeId) && ids.has(c.to.nodeId))
      .map((c) => ({
        from: { key: keyOf.get(c.from.nodeId)!, portId: c.from.portId },
        to: { key: keyOf.get(c.to.nodeId)!, portId: c.to.portId },
        rules: c.rules,
        settings: clone(c.settings),
      })),
    inputs: templatePorts(inputs.filter((port) => ids.has(port.node)), keyOf),
    outputs: templatePorts(outputs.filter((port) => ids.has(port.node)), keyOf),
  };
}

/** An instance's ports, from the template's, pointed at this instance's members. */
function instancePorts(ports: TemplatePort[], memberOf: Map<string, FlowNode>, side: 'inputs' | 'outputs'): ExposedPort[] {
  const out: ExposedPort[] = [];
  for (const port of ports) {
    const member = memberOf.get(port.key);
    const spec = member ? findPort(member.kind, port.port, side) : undefined;
    if (!member || !spec) continue;
    out.push({
      id: port.id,
      label: port.label,
      kinds: [...spec.kinds],
      description: spec.description,
      ...(spec.required ? { required: true } : {}),
      ...(spec.multiple ? { multiple: true } : {}),
      node: member.id,
      port: port.port,
    });
  }
  return out;
}

export interface CreateCustomFlow {
  name: string;
  description?: string;
  memberIds: readonly string[];
  /** The ports to show, from `proposePorts`; any left out stay inside. */
  inputs: ExposedPort[];
  outputs: ExposedPort[];
}

/**
 * Save an arrangement as a custom flow, and turn the arrangement into its
 * first instance: the flows chosen go behind one card where the first of them
 * was, keeping their settings, files and wires.
 */
export function createCustomFlow(project: Project, request: CreateCustomFlow): { project: Project; templateId: string; nodeId: string } {
  const ids = new Set(request.memberIds);
  const members = project.nodes.filter((node) => ids.has(node.id) && !isCustomNode(node) && !node.group);
  if (members.length === 0) throw new Error('Choose at least one flow to make a custom flow from.');
  const name = request.name.trim() || 'Custom flow';
  const now = new Date().toISOString();
  const template = templateOf(project, members, request.inputs, request.outputs, {
    id: newId('custom'),
    name,
    description: request.description?.trim() ?? '',
    createdAt: now,
  });
  const byKey = new Map(members.map((node, index) => [`m${index + 1}`, node]));
  const groupId = newId('flow');
  const position = {
    x: Math.min(...members.map((node) => node.position.x)),
    y: Math.min(...members.map((node) => node.position.y)),
  };
  const data: CustomFlowData = {
    editor: 'custom',
    templateId: template.id,
    templateName: name,
    inputs: instancePorts(template.inputs, byKey, 'inputs'),
    outputs: instancePorts(template.outputs, byKey, 'outputs'),
  };
  const group: FlowNode = { id: groupId, kind: CUSTOM_FLOW_KIND, name, position, notes: '', data, outputs: [] };
  // Wires between two members stay; wires to a member port the instance does
  // not show would be wires to nothing visible, so they go.
  const shownIn = new Set(data.inputs.map((port) => `${port.node}|${port.port}`));
  const shownOut = new Set(data.outputs.map((port) => `${port.node}|${port.port}`));
  const connections = project.connections.filter((c) => {
    const fromInside = ids.has(c.from.nodeId);
    const toInside = ids.has(c.to.nodeId);
    if (fromInside && toInside) return true;
    if (toInside) return shownIn.has(`${c.to.nodeId}|${c.to.portId}`);
    if (fromInside) return shownOut.has(`${c.from.nodeId}|${c.from.portId}`);
    return true;
  });
  return {
    project: {
      ...project,
      customFlows: [...(project.customFlows ?? []), template],
      nodes: [...project.nodes.map((node) => (ids.has(node.id) ? { ...node, group: groupId } : node)), group],
      connections,
    },
    templateId: template.id,
    nodeId: groupId,
  };
}

/**
 * A new instance of a custom flow: fresh copies of its members with the
 * settings it was saved with, wired as they were, behind one card.
 */
export function instantiateCustomFlow(project: Project, templateId: string, position: Vec2): { project: Project; nodeId: string } {
  const template = templateById(project, templateId);
  if (!template) throw new Error('That custom flow is not in this project.');
  const groupId = newId('flow');
  const memberOf = new Map<string, FlowNode>();
  const members = template.members
    .filter((member) => getFlowKind(member.kind))
    .map((member) => {
      const node: FlowNode = {
        id: newId('flow'),
        kind: member.kind,
        name: member.name,
        position: { x: position.x + member.offset.x, y: position.y + member.offset.y },
        notes: member.notes,
        data: clone(member.data),
        outputs: [],
        group: groupId,
      };
      memberOf.set(member.key, node);
      return node;
    });
  const connections: Connection[] = [];
  for (const wire of template.connections) {
    const from = memberOf.get(wire.from.key);
    const to = memberOf.get(wire.to.key);
    if (!from || !to) continue;
    connections.push({
      id: newId('conn'),
      from: { nodeId: from.id, portId: wire.from.portId },
      to: { nodeId: to.id, portId: wire.to.portId },
      rules: wire.rules,
      settings: clone(wire.settings),
    });
  }
  const group: FlowNode = {
    id: groupId,
    kind: CUSTOM_FLOW_KIND,
    name: template.name,
    position,
    notes: '',
    data: {
      editor: 'custom',
      templateId: template.id,
      templateName: template.name,
      inputs: instancePorts(template.inputs, memberOf, 'inputs'),
      outputs: instancePorts(template.outputs, memberOf, 'outputs'),
    },
    outputs: [],
  };
  return {
    project: {
      ...project,
      nodes: [...project.nodes, ...members, group],
      connections: [...project.connections, ...connections],
    },
    nodeId: groupId,
  };
}

/** Remove an instance and everything behind it, with every wire touching them. */
export function removeInstance(project: Project, groupId: string): Project {
  const gone = new Set([groupId, ...membersOf(project, groupId).map((node) => node.id)]);
  return {
    ...project,
    nodes: project.nodes.filter((node) => !gone.has(node.id)),
    connections: project.connections.filter((c) => !gone.has(c.from.nodeId) && !gone.has(c.to.nodeId)),
  };
}

/**
 * Open an instance out: its members go back on the graph as ordinary flows,
 * laid out where the card was, and the card goes. Its wires were always to the
 * members, so they stay.
 */
export function openOutInstance(project: Project, groupId: string): Project {
  const group = project.nodes.find((node) => node.id === groupId);
  if (!group || !isCustomNode(group)) return project;
  const members = membersOf(project, groupId);
  const minX = Math.min(...members.map((node) => node.position.x));
  const minY = Math.min(...members.map((node) => node.position.y));
  return {
    ...project,
    nodes: project.nodes
      .filter((node) => node.id !== groupId)
      .map((node) => {
        if (node.group !== groupId) return node;
        const { group: _gone, ...rest } = node;
        return {
          ...rest,
          position: { x: group.position.x + node.position.x - minX, y: group.position.y + node.position.y - minY },
        };
      }),
  };
}

/**
 * Save this instance's members, as they are now, over its template — so new
 * instances start from here. Instances already made keep their own settings.
 */
export function saveInstanceAsTemplate(project: Project, groupId: string): Project {
  const group = project.nodes.find((node) => node.id === groupId);
  if (!group || !isCustomNode(group)) return project;
  const data = customDataOf(group);
  const template = templateById(project, data.templateId);
  const members = membersOf(project, groupId);
  if (!template || members.length === 0) return project;
  const next = templateOf(project, members, data.inputs, data.outputs, {
    id: template.id,
    name: template.name,
    description: template.description,
    createdAt: template.createdAt,
  });
  // The instance's port ids were the template's; keep them so wires and other
  // instances still line up.
  const ids = new Map([...data.inputs, ...data.outputs].map((port) => [`${port.node}|${port.port}`, port.id]));
  const keyOf = new Map(members.map((node, index) => [`m${index + 1}`, node.id]));
  const keep = (ports: TemplatePort[]) =>
    ports.map((port) => ({ ...port, id: ids.get(`${keyOf.get(port.key)}|${port.port}`) ?? port.id }));
  const saved = { ...next, inputs: keep(next.inputs), outputs: keep(next.outputs) };
  return {
    ...project,
    customFlows: (project.customFlows ?? []).map((one) => (one.id === template.id ? saved : one)),
  };
}

export function renameTemplate(project: Project, templateId: string, name: string, description?: string): Project {
  return {
    ...project,
    customFlows: (project.customFlows ?? []).map((one) =>
      one.id === templateId
        ? { ...one, name: name.trim() || one.name, ...(description === undefined ? {} : { description }), updatedAt: new Date().toISOString() }
        : one,
    ),
  };
}

/** Forget a template. Instances already made keep working; they just cannot be made again. */
export function deleteTemplate(project: Project, templateId: string): Project {
  return { ...project, customFlows: (project.customFlows ?? []).filter((one) => one.id !== templateId) };
}

/** How many instances of each template are on the graph. */
export function instanceCounts(project: Project): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of project.nodes) {
    if (!isCustomNode(node)) continue;
    const id = customDataOf(node).templateId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
