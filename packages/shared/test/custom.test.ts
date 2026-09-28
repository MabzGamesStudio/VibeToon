import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CUSTOM_FLOW_KIND,
  createCustomFlow,
  createEmptyCustomFlow,
  customDataOf,
  exposeFromWiring,
  exposePort,
  deleteTemplate,
  flowPorts,
  instanceCounts,
  instantiateCustomFlow,
  membersOf,
  openOutInstance,
  portOf,
  proposePorts,
  realEndpoint,
  removeInstance,
  removeMember,
  renameTemplate,
  saveInstanceAsTemplate,
  shownEnd,
  shownEndpoints,
  unexposePort,
  visibleNodes,
} from '../src/flows/customFlow';
import { createConnection, createNode, createProject } from '../src/project/factory';
import { flowStatus, inputsForPort, missingRequiredInputs, staleNodes, validateConnection } from '../src/graph/graph';
import { diffProject, emptyHistory, record, undo } from '../src/project/history';
import type { Project } from '../src/types/project';
import type { VectorizeFlowData } from '../src/flows/vectorEdit';

/**
 * An image, decomposed, then edited — and a rig bound to the edit downstream.
 * The decomposition and the edit are what gets saved as a custom flow.
 */
function arrangement(): { project: Project; image: string; vectorize: string; edit: string; bind: string } {
  const base = createProject('Custom');
  const image = createNode('art.image', { x: 0, y: 0 }, 'Picture');
  const vectorize = createNode('art.vectorize', { x: 300, y: 0 }, 'Decompose');
  const edit = createNode('art.vector.edit', { x: 600, y: 40 }, 'Tidy');
  const bind = createNode('animation.bind', { x: 900, y: 0 }, 'Bind');
  (vectorize.data as VectorizeFlowData).options.lineWidth = 7;
  const project: Project = {
    ...base,
    nodes: [image, vectorize, edit, bind],
    connections: [
      createConnection({ nodeId: image.id, portId: 'image' }, { nodeId: vectorize.id, portId: 'image' }),
      createConnection({ nodeId: vectorize.id, portId: 'vector' }, { nodeId: edit.id, portId: 'vector' }),
      createConnection({ nodeId: edit.id, portId: 'vector' }, { nodeId: bind.id, portId: 'vector' }),
    ],
  };
  return { project, image: image.id, vectorize: vectorize.id, edit: edit.id, bind: bind.id };
}

function made() {
  const setup = arrangement();
  const ports = proposePorts(setup.project, [setup.vectorize, setup.edit]);
  const result = createCustomFlow(setup.project, { name: 'Vectorize and tidy', memberIds: [setup.vectorize, setup.edit], ...ports });
  return { ...setup, ...result };
}

test('the ports an arrangement shows come from its wiring', () => {
  const { project, vectorize, edit } = arrangement();
  const { inputs, outputs } = proposePorts(project, [vectorize, edit]);
  // The edit's vector input is fed from inside, so only the decomposition's image is taken.
  assert.deepEqual(inputs.map((port) => `${port.node === vectorize ? 'vectorize' : 'edit'}.${port.port}`), ['vectorize.image']);
  // The decomposition's vector is read only inside; its drawing and report nobody reads, so they show.
  const shown = outputs.map((port) => `${port.node === vectorize ? 'vectorize' : 'edit'}.${port.port}`);
  assert.ok(!shown.includes('vectorize.vector'));
  assert.ok(shown.includes('edit.vector'));
  assert.ok(shown.includes('vectorize.report'));
  // Two outputs both called Drawing are told apart by their flows.
  assert.ok(outputs.some((port) => port.label === 'Decompose · Drawing'));
  assert.ok(outputs.some((port) => port.label === 'Tidy · Drawing'));
});

test('making a custom flow saves a template and turns the arrangement into its first instance', () => {
  const { project, templateId, nodeId, vectorize, edit } = made();
  assert.equal(project.customFlows?.length, 1);
  const template = project.customFlows![0]!;
  assert.equal(template.id, templateId);
  assert.equal(template.name, 'Vectorize and tidy');
  assert.equal(template.members.length, 2);
  assert.equal((template.members[0]!.data as VectorizeFlowData).options.lineWidth, 7, 'with its settings');
  assert.equal(template.connections.length, 1, 'and the wire between them');
  const group = project.nodes.find((node) => node.id === nodeId)!;
  assert.equal(group.kind, CUSTOM_FLOW_KIND);
  assert.equal(group.name, 'Vectorize and tidy');
  assert.deepEqual(membersOf(project, nodeId).map((node) => node.id).sort(), [vectorize, edit].sort());
  assert.ok(!visibleNodes(project).some((node) => node.group), 'the members are behind the card');
  assert.equal(visibleNodes(project).length, 3);
});

test('an instance’s ports are its members’, and the wires stay on the members', () => {
  const { project, nodeId, image, vectorize, edit, bind } = made();
  const group = project.nodes.find((node) => node.id === nodeId)!;
  const ports = flowPorts(group);
  assert.deepEqual(ports.inputs.map((port) => port.label), ['Image']);
  assert.ok(portOf(group, ports.inputs[0]!.id, 'inputs'));
  // The outside wires are still to the members.
  assert.equal(inputsForPort(project, vectorize, 'image')[0]?.sourceNode.id, image);
  assert.equal(inputsForPort(project, bind, 'vector')[0]?.sourceNode.id, edit);
  // Drawn at the instance.
  const shown = shownEndpoints(project);
  const into = project.connections.find((c) => c.from.nodeId === image)!;
  assert.equal(shownEnd(shown, into.to, 'in')?.nodeId, nodeId);
  const inside = project.connections.find((c) => c.from.nodeId === vectorize && c.to.nodeId === edit)!;
  assert.equal(shownEnd(shown, inside.to, 'in'), null, 'a wire inside is not drawn');
});

test('a wire to an instance’s port is a wire to the member port behind it', () => {
  const { project, nodeId, vectorize } = made();
  const group = project.nodes.find((node) => node.id === nodeId)!;
  const input = customDataOf(group).inputs[0]!;
  assert.deepEqual(realEndpoint(project, { nodeId, portId: input.id }, 'in'), { nodeId: vectorize, portId: 'image' });
  const other = createNode('art.image', { x: 0, y: 300 });
  const withOther = { ...project, nodes: [...project.nodes, other] };
  const to = realEndpoint(withOther, { nodeId, portId: input.id }, 'in');
  assert.equal(validateConnection(withOther, { nodeId: other.id, portId: 'image' }, to).ok, true);
  assert.equal(validateConnection(withOther, { nodeId: other.id, portId: 'image' }, { nodeId, portId: input.id }).ok, false, 'the card itself is not a flow to wire to');
  const freed = { ...withOther, connections: withOther.connections.filter((c) => c.to.nodeId !== vectorize) };
  assert.equal(validateConnection(freed, { nodeId: other.id, portId: 'image' }, to).ok, true);
  assert.equal(missingRequiredInputs(freed, group).length, 1, 'and without it the instance is missing its picture');
});

test('each instance has its own members: editing one leaves the template and the others alone', () => {
  const first = made();
  const second = instantiateCustomFlow(first.project, first.templateId, { x: 0, y: 500 });
  const project = second.project;
  const mine = membersOf(project, second.nodeId);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((node) => !membersOf(project, first.nodeId).some((other) => other.id === node.id)), 'fresh ids');
  assert.equal(project.connections.filter((c) => mine.some((node) => node.id === c.from.nodeId)).length, 1, 'wired as saved');
  const decompose = mine.find((node) => node.kind === 'art.vectorize')!;
  assert.equal((decompose.data as VectorizeFlowData).options.lineWidth, 7, 'with the saved settings');
  // Change this one.
  const changed: Project = {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === decompose.id
        ? { ...node, data: { ...(node.data as VectorizeFlowData), options: { ...(node.data as VectorizeFlowData).options, lineWidth: 3 } } }
        : node,
    ),
  };
  const other = membersOf(changed, first.nodeId).find((node) => node.kind === 'art.vectorize')!;
  assert.equal((other.data as VectorizeFlowData).options.lineWidth, 7);
  assert.equal((changed.customFlows![0]!.members[0]!.data as VectorizeFlowData).options.lineWidth, 7);
  assert.equal(instanceCounts(changed).get(first.templateId), 2);
});

test('an instance is as up to date as the flows behind it, and is generated through them', () => {
  const { project, nodeId, vectorize } = made();
  const group = project.nodes.find((node) => node.id === nodeId)!;
  assert.equal(flowStatus(project, group), 'empty');
  const stale = staleNodes(project).map((node) => node.id);
  assert.ok(!stale.includes(nodeId), 'the card itself is never queued');
  assert.ok(stale.includes(vectorize));
});

test('saving an instance over its template changes what new instances start from', () => {
  const { project, nodeId, templateId } = made();
  const member = membersOf(project, nodeId).find((node) => node.kind === 'art.vectorize')!;
  const changed: Project = {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === member.id
        ? { ...node, data: { ...(node.data as VectorizeFlowData), options: { ...(node.data as VectorizeFlowData).options, lineWidth: 12 } } }
        : node,
    ),
  };
  const saved = saveInstanceAsTemplate(changed, nodeId);
  assert.equal((saved.customFlows![0]!.members[0]!.data as VectorizeFlowData).options.lineWidth, 12);
  const group = saved.nodes.find((node) => node.id === nodeId)!;
  assert.deepEqual(
    saved.customFlows![0]!.inputs.map((port) => port.id),
    customDataOf(group).inputs.map((port) => port.id),
    'the same port ids, so wires still line up',
  );
  const next = instantiateCustomFlow(saved, templateId, { x: 0, y: 0 });
  const fresh = membersOf(next.project, next.nodeId).find((node) => node.kind === 'art.vectorize')!;
  assert.equal((fresh.data as VectorizeFlowData).options.lineWidth, 12);
});

test('removing an instance removes what is behind it; opening it out puts the members back', () => {
  const { project, nodeId, bind } = made();
  const removed = removeInstance(project, nodeId);
  assert.equal(removed.nodes.length, 2);
  assert.ok(removed.connections.every((c) => c.to.nodeId !== bind), 'the wire from inside it went too');
  const opened = openOutInstance(project, nodeId);
  assert.equal(opened.nodes.length, 4);
  assert.ok(opened.nodes.every((node) => !node.group && node.kind !== CUSTOM_FLOW_KIND));
  assert.equal(opened.connections.length, 3, 'every wire kept');
});

test('templates can be renamed and forgotten; instances outlive their template', () => {
  const { project, templateId, nodeId } = made();
  const renamed = renameTemplate(project, templateId, 'Trace', 'Picture to tidy vector');
  assert.equal(renamed.customFlows![0]!.name, 'Trace');
  assert.equal(renamed.customFlows![0]!.description, 'Picture to tidy vector');
  const forgotten = deleteTemplate(renamed, templateId);
  assert.equal(forgotten.customFlows!.length, 0);
  assert.equal(membersOf(forgotten, nodeId).length, 2);
  assert.throws(() => instantiateCustomFlow(forgotten, templateId, { x: 0, y: 0 }));
});

test('making, placing and removing a custom flow are steps undo can take back', () => {
  const setup = arrangement();
  const created = createCustomFlow(setup.project, { name: 'X', memberIds: [setup.vectorize, setup.edit], ...proposePorts(setup.project, [setup.vectorize, setup.edit]) });
  const change = diffProject(setup.project, created.project);
  assert.ok(change.graph.includes('customFlows'));
  assert.ok(change.graph.some((item) => item.startsWith('group:')));
  const history = record(emptyHistory(), setup.project, created.project, { now: 0, gesture: null });
  const back = undo(history, created.project, null)!;
  assert.equal(back.project.customFlows?.length ?? 0, 0);
  assert.ok(back.project.nodes.every((node) => !node.group));
  assert.equal(back.project.nodes.length, 4);
});

test('an arrangement needs at least one flow, and instances cannot be put inside another', () => {
  const { project, nodeId } = made();
  assert.throws(() => createCustomFlow(project, { name: 'Empty', memberIds: [], inputs: [], outputs: [] }));
  assert.throws(() => createCustomFlow(project, { name: 'Nested', memberIds: [nodeId], inputs: [], outputs: [] }));
});

/* ---------------- building one on its own graph ---------------- */

/** An empty custom flow with a decomposition and an edit built inside it, wired. */
function built() {
  const base = createProject('Built');
  const empty = createEmptyCustomFlow(base, 'Trace', { x: 40, y: 60 });
  const decompose = { ...createNode('art.vectorize', { x: 0, y: 0 }, 'Decompose'), group: empty.nodeId };
  const tidy = { ...createNode('art.vector.edit', { x: 300, y: 0 }, 'Tidy'), group: empty.nodeId };
  const project: Project = {
    ...empty.project,
    nodes: [...empty.project.nodes, decompose, tidy],
    connections: [createConnection({ nodeId: decompose.id, portId: 'vector' }, { nodeId: tidy.id, portId: 'vector' })],
  };
  return { project, group: empty.nodeId, templateId: empty.templateId, decompose: decompose.id, tidy: tidy.id };
}

test('an empty custom flow is a card and a template with nothing behind them', () => {
  const { project, nodeId, templateId } = createEmptyCustomFlow(createProject('Empty'), '  ', { x: 10, y: 20 });
  const card = project.nodes.find((node) => node.id === nodeId)!;
  assert.equal(card.kind, CUSTOM_FLOW_KIND);
  assert.equal(card.name, 'Custom flow');
  assert.deepEqual(flowPorts(card), { inputs: [], outputs: [] });
  assert.equal(project.customFlows?.[0]?.id, templateId);
  assert.deepEqual(membersOf(project, nodeId), []);
});

test('a port of a flow inside can be shown on the card, and taken off it again', () => {
  const { project, group, decompose, tidy } = built();
  const shown = exposePort(project, group, 'inputs', decompose, 'image');
  const card = () => shown.nodes.find((node) => node.id === group)!;
  assert.deepEqual(flowPorts(card()).inputs.map((port) => port.label), ['Image']);
  assert.equal(exposePort(shown, group, 'inputs', decompose, 'image'), shown, 'showing it twice is showing it once');
  assert.equal(exposePort(project, group, 'inputs', tidy, 'vector'), project, 'an input fed from inside is not taken');

  // Wired from outside, then taken off: the wire goes with it.
  const picture = createNode('art.image', { x: -300, y: 0 }, 'Picture');
  const port = customDataOf(card()).inputs[0]!;
  const wired: Project = {
    ...shown,
    nodes: [...shown.nodes, picture],
    connections: [...shown.connections, createConnection({ nodeId: picture.id, portId: 'image' }, { nodeId: decompose, portId: 'image' })],
  };
  const hidden = unexposePort(wired, group, 'inputs', port.id);
  assert.deepEqual(customDataOf(hidden.nodes.find((node) => node.id === group)!).inputs, []);
  assert.equal(hidden.connections.length, 1, 'only the wire inside is left');
});

test('the wiring inside can say what to show, keeping names already given', () => {
  const { project, group, decompose } = built();
  const named = exposePort(project, group, 'inputs', decompose, 'image');
  const renamed: Project = {
    ...named,
    nodes: named.nodes.map((node) =>
      node.id === group
        ? { ...node, data: { ...customDataOf(node), inputs: customDataOf(node).inputs.map((port) => ({ ...port, label: 'Picture in' })) } }
        : node,
    ),
  };
  const data = customDataOf(exposeFromWiring(renamed, group).nodes.find((node) => node.id === group)!);
  assert.deepEqual(data.inputs.map((port) => port.label), ['Picture in']);
  assert.ok(data.outputs.some((port) => port.node !== decompose && port.port === 'vector'), "the edit's drawing is given");
  assert.ok(!data.outputs.some((port) => port.node === decompose && port.port === 'vector'), 'the one read inside is not');
});

test('removing a flow inside takes its shown ports and wires with it', () => {
  const { project, group, decompose } = built();
  const shown = exposeFromWiring(project, group);
  const after = removeMember(shown, decompose);
  const data = customDataOf(after.nodes.find((node) => node.id === group)!);
  assert.ok([...data.inputs, ...data.outputs].every((port) => port.node !== decompose));
  assert.deepEqual(after.connections, []);
});

test('a custom flow built on its own graph saves as a template and makes new uses', () => {
  const { project, group, templateId } = built();
  const saved = saveInstanceAsTemplate(exposeFromWiring(project, group), group);
  const template = saved.customFlows!.find((one) => one.id === templateId)!;
  assert.equal(template.members.length, 2);
  assert.equal(template.connections.length, 1);
  const again = instantiateCustomFlow(saved, templateId, { x: 800, y: 0 });
  assert.equal(membersOf(again.project, again.nodeId).length, 2);
  const card = again.project.nodes.find((node) => node.id === again.nodeId)!;
  assert.deepEqual(
    flowPorts(card).inputs.map((port) => port.id),
    flowPorts(saved.nodes.find((node) => node.id === group)!).inputs.map((port) => port.id),
    'the new use has the same ports as the one it was saved from',
  );
});
