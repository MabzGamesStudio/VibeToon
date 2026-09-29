import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  batchItems,
  batchItemStatuses,
  batchOutputs,
  carryChange,
  connectionBatchMode,
  dropItemData,
  editBatchData,
  isBatchNode,
  itemFolder,
  itemHasOwnData,
  itemView,
} from '../src/graph/batch';
import { computeSignature, flowStatus, inputsForPort, validateConnection } from '../src/graph/graph';
import { createConnection, createNode, createProject } from '../src/project/factory';
import { migrateProject } from '../src/project/migrate';
import type { ArtifactRef } from '../src/types/artifacts';
import type { FlowNode, Project } from '../src/types/project';

const at = { x: 0, y: 0 };

function clipsRef(flowId: string, entries: string[]): ArtifactRef {
  return {
    port: 'clips',
    kind: 'videoSet',
    fileName: 'clips',
    path: `artifacts/${flowId}/clips`,
    hash: 'set1',
    bytes: 300,
    generatedAt: '2026-09-29T00:00:00Z',
    entries,
    entryHashes: Object.fromEntries(entries.map((entry) => [entry, `h-${entry}`])),
  };
}

/** Video Edit's clips → Video Background → Line Detection, and the backgrounds gathered into an animatic. */
function scene(): { project: Project; edit: FlowNode; bg: FlowNode; lines: FlowNode; animatic: FlowNode } {
  const edit = { ...createNode('animation.video.edit', at, 'Edit'), id: 'edit' };
  edit.outputs = [clipsRef('edit', ['clip-01.webm', 'clip-02.webm', 'clip-03.webm'])];
  const bg = { ...createNode('art.video.background', at, 'Background'), id: 'bg' };
  const lines = { ...createNode('art.lines', at, 'Lines'), id: 'lines' };
  const animatic = { ...createNode('animation.animatic', at, 'Animatic'), id: 'animatic' };
  const project: Project = {
    ...createProject('batches'),
    nodes: [edit, bg, lines, animatic],
    connections: [
      createConnection({ nodeId: 'edit', portId: 'clips' }, { nodeId: 'bg', portId: 'video' }),
      createConnection({ nodeId: 'bg', portId: 'image' }, { nodeId: 'lines', portId: 'image' }),
      createConnection({ nodeId: 'bg', portId: 'image' }, { nodeId: 'animatic', portId: 'panels' }),
    ],
  };
  return { project, edit, bg, lines, animatic };
}

/** Run an item as a generator would: its outputs written, its run signed. */
function ran(project: Project, nodeId: string, key: string, outputs: ArtifactRef[]): Project {
  const node = project.nodes.find((candidate) => candidate.id === nodeId)!;
  const view = itemView(project, node, key);
  const done = { ...view.node, outputs };
  const signature = computeSignature({ ...view.project, nodes: view.project.nodes.map((n) => (n.id === nodeId ? done : n)) }, done);
  const state = { ...(node.batch?.items[key] ?? {}), outputs, lastRun: { at: 'now', signature, log: [] } };
  const next = { ...node, batch: { items: { ...(node.batch?.items ?? {}), [key]: state } } };
  const withItem = { ...project, nodes: project.nodes.map((n) => (n.id === nodeId ? next : n)) };
  const gathered = { ...next, outputs: batchOutputs(withItem, next) };
  return { ...project, nodes: project.nodes.map((n) => (n.id === nodeId ? gathered : n)) };
}

const png = (flowId: string, key: string): ArtifactRef => ({
  port: 'image',
  kind: 'image',
  fileName: 'background.png',
  path: `artifacts/${flowId}/items/${itemFolder(key)}/background.png`,
  hash: `png-${key}`,
  bytes: 10,
  generatedAt: '2026-09-29T00:00:00Z',
});

test('a folder of videos wired into an input that takes one video is a batch, one item per file', () => {
  const { project, bg } = scene();
  assert.equal(validateConnection({ ...project, connections: [] }, { nodeId: 'edit', portId: 'clips' }, { nodeId: 'bg', portId: 'video' }).ok, true, 'a folder fits a one-file input as a batch');
  assert.equal(connectionBatchMode(project, project.connections[0]!), 'batch');
  assert.equal(isBatchNode(project, bg), true);
  assert.deepEqual(
    batchItems(project, bg).map((item) => [item.key, item.label, item.artifact?.kind, item.artifact?.path, item.artifact?.hash]),
    [
      ['clip-01.webm', 'clip-01', 'video', 'artifacts/edit/clips/clip-01.webm', 'h-clip-01.webm'],
      ['clip-02.webm', 'clip-02', 'video', 'artifacts/edit/clips/clip-02.webm', 'h-clip-02.webm'],
      ['clip-03.webm', 'clip-03', 'video', 'artifacts/edit/clips/clip-03.webm', 'h-clip-03.webm'],
    ],
  );
});

test('each item sees the flow as though that item alone were wired in', () => {
  const { project, bg } = scene();
  const withOwn = { ...bg, batch: { items: { 'clip-02.webm': { outputs: [], data: { ...bg.data, tolerance: 30 } as FlowNode['data'] } } } };
  const next = { ...project, nodes: project.nodes.map((n) => (n.id === 'bg' ? withOwn : n)) };
  const view = itemView(next, withOwn, 'clip-02.webm');
  const input = inputsForPort(view.project, 'bg', 'video')[0]!;
  assert.equal(input.artifact?.kind, 'video');
  assert.equal(input.artifact?.path, 'artifacts/edit/clips/clip-02.webm');
  assert.equal((view.node.data as { tolerance: number }).tolerance, 30, 'with its own settings');
  assert.equal((itemView(next, withOwn, 'clip-01.webm').node.data as { tolerance: number }).tolerance, 8, 'the others share the flow’s');
  assert.equal(view.node.itemOf, 'clip-02.webm');
  assert.equal(isBatchNode(view.project, view.node), false, 'an item is not a batch itself');
  assert.equal(next.nodes.find((n) => n.id === 'edit')!.outputs[0]!.kind, 'videoSet', 'the real project is untouched');
});

test('a batch flow is empty until its items run, stale until all have, and stale again when one changes', () => {
  let { project } = scene();
  assert.equal(flowStatus(project, project.nodes[1]!), 'empty');
  project = ran(project, 'bg', 'clip-01.webm', [png('bg', 'clip-01.webm')]);
  assert.equal(flowStatus(project, project.nodes[1]!), 'stale');
  project = ran(project, 'bg', 'clip-02.webm', [png('bg', 'clip-02.webm')]);
  project = ran(project, 'bg', 'clip-03.webm', [png('bg', 'clip-03.webm')]);
  assert.equal(flowStatus(project, project.nodes[1]!), 'ready');
  const bg = project.nodes[1]!;
  const edited = editBatchData(bg, bg.data, bg.data, { key: 'clip-02.webm', only: true });
  const changed = { ...edited, batch: { items: { ...edited.batch!.items, 'clip-02.webm': { ...edited.batch!.items['clip-02.webm']!, data: { ...bg.data, agreement: 90 } as FlowNode['data'] } } } };
  project = { ...project, nodes: project.nodes.map((n) => (n.id === 'bg' ? changed : n)) };
  assert.deepEqual(
    batchItemStatuses(project, changed).map((entry) => entry.status),
    ['ready', 'stale', 'ready'],
    'only the item that changed',
  );
  assert.equal(flowStatus(project, changed), 'stale');
});

test('what a batch flow makes is a batch too, and goes on down the graph item by item', () => {
  let { project } = scene();
  for (const key of ['clip-01.webm', 'clip-02.webm', 'clip-03.webm']) project = ran(project, 'bg', key, [png('bg', key)]);
  const bg = project.nodes[1]!;
  const out = bg.outputs.find((ref) => ref.port === 'image')!;
  assert.equal(out.items?.length, 3);
  assert.deepEqual(out.entries, ['clip-01.webm/background.png', 'clip-02.webm/background.png', 'clip-03.webm/background.png']);
  const lines = project.nodes[2]!;
  assert.equal(isBatchNode(project, lines), true);
  assert.deepEqual(batchItems(project, lines).map((item) => item.key), ['clip-01.webm', 'clip-02.webm', 'clip-03.webm'], 'the same items, by the same keys');
  const view = itemView(project, lines, 'clip-03.webm');
  assert.equal(inputsForPort(view.project, 'lines', 'image')[0]!.artifact?.path, 'artifacts/bg/items/clip-03.webm/background.png');
  // Line Detection has not run: it is empty, and a change upstream is seen by the item it touches.
  assert.equal(flowStatus(project, lines), 'empty');
  const before = computeSignature(view.project, view.node);
  const again = ran(project, 'bg', 'clip-03.webm', [{ ...png('bg', 'clip-03.webm'), hash: 'png-new' }]);
  const after = itemView(again, again.nodes[2]!, 'clip-03.webm');
  assert.notEqual(computeSignature(after.project, after.node), before);
  const first = itemView(again, again.nodes[2]!, 'clip-01.webm');
  const firstBefore = itemView(project, lines, 'clip-01.webm');
  assert.equal(computeSignature(first.project, first.node), computeSignature(firstBefore.project, firstBefore.node), 'and not by the others');
});

test('into an input that takes a folder and not one file, a batch is gathered into one folder', () => {
  let { project } = scene();
  for (const key of ['clip-01.webm', 'clip-02.webm']) project = ran(project, 'bg', key, [png('bg', key)]);
  const animatic = project.nodes[3]!;
  assert.equal(connectionBatchMode(project, project.connections[2]!), 'gather');
  assert.equal(isBatchNode(project, animatic), false);
  const panels = inputsForPort(project, 'animatic', 'panels')[0]!.artifact!;
  assert.equal(panels.kind, 'imageSet');
  assert.equal(panels.path, 'artifacts/bg/items');
  assert.deepEqual(panels.entries, ['clip-01.webm/background.png', 'clip-02.webm/background.png']);
});

test('a folder into an input that also takes a folder goes whole, unless the wire is set to split it', () => {
  const parts = { ...createNode('animation.parts', at), id: 'parts' };
  parts.outputs = [{ ...clipsRef('parts', ['arm.svg', 'leg.svg']), port: 'images', kind: 'imageSet', path: 'artifacts/parts/parts' }];
  const crop = { ...createNode('art.crop', at), id: 'crop' };
  const wire = createConnection({ nodeId: 'parts', portId: 'images' }, { nodeId: 'crop', portId: 'image' });
  const whole: Project = { ...createProject('p'), nodes: [parts, crop], connections: [wire] };
  assert.equal(connectionBatchMode(whole, wire), 'none');
  assert.equal(isBatchNode(whole, crop), false);
  const split: Project = { ...whole, connections: [{ ...wire, batch: true }] };
  assert.equal(isBatchNode(split, crop), true);
  assert.deepEqual(batchItems(split, crop).map((item) => [item.label, item.artifact?.kind]), [
    ['arm', 'image'],
    ['leg', 'image'],
  ]);
  // A folder cannot be split into an input that takes neither it nor one of its files.
  const rig = { ...createNode('animation.bind', at), id: 'bind' };
  assert.equal(validateConnection({ ...whole, nodes: [parts, rig], connections: [] }, { nodeId: 'parts', portId: 'images' }, { nodeId: 'bind', portId: 'rig' }).ok, false);
});

test('an edit to all the items reaches those with their own settings, without undoing the rest of theirs', () => {
  const bg = createNode('art.video.background', at);
  const own = { ...bg.data, tolerance: 30, brush: 4 } as FlowNode['data'];
  let node: FlowNode = { ...bg, batch: { items: { a: { outputs: [], data: own }, b: { outputs: [] } } } };
  // Shown item a, with its own settings: its tolerance of 30 is not an edit and is not spread.
  node = editBatchData(node, own, { ...own, brush: 20, agreement: 70 } as FlowNode['data'], { key: 'a', only: false });
  const shared = node.data as { brush: number; agreement: number; tolerance: number };
  assert.equal(shared.brush, 20);
  assert.equal(shared.agreement, 70);
  assert.equal(shared.tolerance, 8, 'the shown item’s own tolerance is not made everyone’s');
  const a = node.batch!.items.a!.data as { brush: number; agreement: number; tolerance: number };
  assert.deepEqual([a.tolerance, a.brush, a.agreement], [30, 20, 70], 'its own tolerance kept, the edits taken');
  assert.equal(node.batch!.items.b!.data, undefined, 'an item with no settings of its own still has none');
  node = editBatchData(node, node.data, { ...node.data, tolerance: 2 } as FlowNode['data'], { key: 'b', only: true });
  assert.equal((node.batch!.items.b!.data as unknown as { tolerance: number }).tolerance, 2);
  assert.equal((node.data as { tolerance: number }).tolerance, 8, 'editing one item leaves the others');
  assert.equal(itemHasOwnData(node, 'b'), true, 'edited on its own');
  assert.equal(dropItemData(node, 'b').batch!.items.b!.data, undefined);
  // What a run writes to an item is kept with it, but is not a choice made for it.
  const ran = editBatchData(node, node.data, { ...node.data, frameSize: { width: 4, height: 4 } } as FlowNode['data'], { key: 'c', only: true, quiet: true });
  assert.ok(ran.batch!.items.c!.data);
  assert.equal(itemHasOwnData(ran, 'c'), false);
});

test('what an editor finds out about the item it shows stays with that item, even editing every item', () => {
  const bg = createNode('art.video.background', at);
  let node: FlowNode = { ...bg, batch: { items: { a: { outputs: [] }, b: { outputs: [] } } } };
  const shown = node.data;
  const read = { ...shown, video: { hash: 'va', duration: 2, width: 64, height: 36 }, frameSize: { width: 64, height: 36 }, tolerance: 12 } as FlowNode['data'];
  node = editBatchData(node, shown, read, { key: 'a', only: false });
  const shared = node.data as { video?: unknown; tolerance: number };
  assert.equal(shared.video, undefined, 'the video read for item a is not every item’s');
  assert.equal(shared.tolerance, 12, 'while the setting changed with it is');
  const a = node.batch!.items.a!.data as { video?: { hash: string }; tolerance: number };
  assert.equal(a.video?.hash, 'va');
  assert.equal(a.tolerance, 12);
  assert.equal(itemHasOwnData(node, 'a'), false, 'a finding is not a choice');
  assert.equal(node.batch!.items.b!.data, undefined);
});

test('a change is carried key by key into nested settings', () => {
  const before = { options: { contrast: 18, flatness: 10 }, view: 'lines', list: [1, 2] };
  const after = { options: { contrast: 30, flatness: 10 }, view: 'lines', list: [1, 2, 3] };
  const onto = { options: { contrast: 18, flatness: 4 }, view: 'original', list: [9] };
  assert.deepEqual(carryChange(before, after, onto), { options: { contrast: 30, flatness: 4 }, view: 'original', list: [1, 2, 3] });
});

test('keys become safe folder names, and a view of an item is never kept', () => {
  assert.equal(itemFolder('shot 01.webm'), 'shot_01.webm');
  assert.equal(itemFolder('../up'), '__up');
  assert.equal(itemFolder(''), '_');
  const { project, bg } = scene();
  const saved = migrateProject({ ...project, nodes: project.nodes.map((n) => (n.id === 'bg' ? { ...bg, itemOf: 'clip-01.webm' } : n)) });
  assert.equal(saved.nodes[1]!.itemOf, undefined);
});
