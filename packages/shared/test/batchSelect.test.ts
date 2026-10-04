import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchOutputs, connectionBatchMode, isBatchNode, itemFolder, itemView } from '../src/graph/batch';
import { computeSignature, validateConnection } from '../src/graph/graph';
import {
  emptyBatchSelectFlowData,
  folderKindOf,
  invertSelected,
  isSelected,
  itemMatchesFilter,
  selectKey,
  selectSources,
  setSelected,
  splitSelection,
  summariseSelection,
  type BatchSelectFlowData,
} from '../src/flows/batchSelect';
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
    hash: `set-${flowId}`,
    bytes: 300,
    generatedAt: '2026-10-04T00:00:00Z',
    entries,
    entryHashes: Object.fromEntries(entries.map((entry) => [entry, `h-${flowId}-${entry}`])),
  };
}

/** Two Shot Splits' clips into one Batch Select. */
function twoSplits(): { project: Project; select: FlowNode } {
  const a = { ...createNode('animation.video.shots', at, 'Opening'), id: 'a' };
  a.outputs = [clipsRef('a', ['shot-01.webm', 'shot-02.webm', 'shot-03.webm'])];
  const b = { ...createNode('animation.video.shots', at, 'Ending'), id: 'b' };
  b.outputs = [clipsRef('b', ['shot-01.webm', 'shot-02.webm'])];
  const select = { ...createNode('production.batch.select', at, 'Pick'), id: 'pick' };
  const project: Project = {
    ...createProject('select'),
    nodes: [a, b, select],
    connections: [
      createConnection({ nodeId: 'a', portId: 'clips' }, { nodeId: 'pick', portId: 'items' }),
      createConnection({ nodeId: 'b', portId: 'clips' }, { nodeId: 'pick', portId: 'items' }),
    ],
  };
  return { project, select };
}

const withData = (project: Project, data: BatchSelectFlowData): Project => ({
  ...project,
  nodes: project.nodes.map((node) => (node.id === 'pick' ? { ...node, data } : node)),
});

test('a new Batch Select starts with every item ticked and no filter', () => {
  const data = emptyBatchSelectFlowData();
  assert.deepEqual(data, { editor: 'batchSelect', excluded: [], filter: '' });
  assert.equal(isSelected(data, 'anything'), true);
});

test('folders wired in are listed together, each item once, from every wire', () => {
  const { project, select } = twoSplits();
  const sources = selectSources(project, select);
  assert.deepEqual(sources.map((source) => source.source.name), ['Opening', 'Ending']);
  assert.deepEqual(sources.map((source) => source.items.length), [3, 2]);
  assert.equal(sources[0]!.items[0]!.key, 'a:clips/shot-01.webm');
  assert.equal(sources[0]!.items[0]!.kind, 'video');
  assert.equal(isBatchNode(project, select), false, 'a folder into a folder input goes whole: the selector is not itself a batch');
});

test('two wires with the same file name are written under different names', () => {
  const { project, select } = twoSplits();
  const names = selectSources(project, select).flatMap((source) => source.items.map((item) => item.fileName));
  assert.equal(new Set(names).size, names.length, names.join(', '));
  assert.ok(names.includes('Ending-shot-01.webm'));
});

test('unticking keeps the choice by item, and an item that arrives later is ticked', () => {
  const { project, select } = twoSplits();
  const data = setSelected(emptyBatchSelectFlowData(), [selectKey({ from: { nodeId: 'a', portId: 'clips' } }, 'shot-02.webm')], false);
  const split = splitSelection(withData(project, data), select, data);
  assert.equal(split.selected.length, 4);
  assert.deepEqual(split.rest.map((item) => item.label), ['shot-02']);
  // A fourth shot appears upstream: ticked, since only unticked items are kept.
  const grown = { ...project, nodes: project.nodes.map((node) => (node.id === 'a' ? { ...node, outputs: [clipsRef('a', ['shot-01.webm', 'shot-02.webm', 'shot-03.webm', 'shot-04.webm'])] } : node)) };
  assert.equal(splitSelection(withData(grown, data), select, data).selected.length, 5);
});

test('tick all, untick all and invert act on the items given', () => {
  const keys = ['x', 'y', 'z'];
  const none = setSelected(emptyBatchSelectFlowData(), keys, false);
  assert.ok(keys.every((key) => !isSelected(none, key)));
  const flipped = invertSelected(setSelected(none, ['y'], true), keys);
  assert.deepEqual(keys.map((key) => isSelected(flipped, key)), [true, false, true]);
  assert.ok(keys.every((key) => isSelected(setSelected(flipped, keys, true), key)));
});

test('the filter matches names, ignoring case, and an empty one matches everything', () => {
  const item = { key: 'k', label: 'Shot-03', fileName: 'shot-03.webm' };
  assert.equal(itemMatchesFilter(item, 'shot-0'), true);
  assert.equal(itemMatchesFilter(item, 'SHOT-03'), true);
  assert.equal(itemMatchesFilter(item, 'background'), false);
  assert.equal(itemMatchesFilter(item, '  '), true);
});

test('a batch flow wired in arrives gathered, and its items are named for the item they are', () => {
  // Shot Split clips → Video Background (a batch of 2) → Batch Select.
  const shots = { ...createNode('animation.video.shots', at, 'Shots'), id: 'shots' };
  shots.outputs = [clipsRef('shots', ['shot-01.webm', 'shot-02.webm'])];
  const bg = { ...createNode('art.video.background', at, 'Background'), id: 'bg' };
  const select = { ...createNode('production.batch.select', at, 'Pick'), id: 'pick' };
  let project: Project = {
    ...createProject('gathered'),
    nodes: [shots, bg, select],
    connections: [
      createConnection({ nodeId: 'shots', portId: 'clips' }, { nodeId: 'bg', portId: 'video' }),
      createConnection({ nodeId: 'bg', portId: 'image' }, { nodeId: 'pick', portId: 'items' }),
    ],
  };
  for (const key of ['shot-01.webm']) {
    const node = project.nodes.find((candidate) => candidate.id === 'bg')!;
    const view = itemView(project, node, key);
    const outputs: ArtifactRef[] = [{ port: 'image', kind: 'image', fileName: 'background.png', path: `artifacts/bg/items/${itemFolder(key)}/background.png`, hash: `png-${key}`, bytes: 10, generatedAt: 'now' }];
    const done = { ...view.node, outputs };
    const signature = computeSignature({ ...view.project, nodes: view.project.nodes.map((n) => (n.id === 'bg' ? done : n)) }, done);
    const next = { ...node, batch: { items: { [key]: { outputs, lastRun: { at: 'now', signature, log: [] } } } } };
    const withItem = { ...project, nodes: project.nodes.map((n) => (n.id === 'bg' ? next : n)) };
    project = { ...project, nodes: project.nodes.map((n) => (n.id === 'bg' ? { ...next, outputs: batchOutputs(withItem, next) } : n)) };
  }
  assert.equal(connectionBatchMode(project, project.connections[1]!), 'gather');
  assert.equal(isBatchNode(project, project.nodes.find((n) => n.id === 'pick')!), false);
  const [source] = selectSources(project, select);
  assert.deepEqual(source!.items.map((item) => [item.fileName, item.kind ?? null]), [['shot-01.png', 'image'], ['shot-02.webm', null]]);
  const split = splitSelection(project, select, emptyBatchSelectFlowData());
  assert.deepEqual(split.selected.map((item) => item.fileName), ['shot-01.png']);
  assert.deepEqual(split.waiting.map((item) => item.label), ['shot-02'], 'not made yet: left out, and said so');
  assert.equal(split.kind, 'image');
  assert.equal(folderKindOf(split.kind!), 'imageSet');
});

test('a folder holds one kind of file: other kinds are set aside and said so', () => {
  const { project, select } = twoSplits();
  const images = { ...createNode('art.image', at, 'Stills'), id: 'stills' };
  images.outputs = [{ port: 'image', kind: 'imageSet', fileName: 'stills', path: 'artifacts/stills/stills', hash: 'st', bytes: 1, generatedAt: 'now', entries: ['a.png'] }];
  const mixed = { ...project, nodes: [...project.nodes, images], connections: [...project.connections, createConnection({ nodeId: 'stills', portId: 'image' }, { nodeId: 'pick', portId: 'items' })] };
  const split = splitSelection(mixed, select, emptyBatchSelectFlowData());
  assert.equal(split.kind, 'video');
  assert.deepEqual(split.otherKind.map((item) => item.fileName), ['a.png']);
  assert.match(summariseSelection(split), /5 selected · 0 left out · 1 of another kind set aside/);
});

test('only folders can be wired in, and what goes out goes on as a batch', () => {
  const { project } = twoSplits();
  const one = { ...createNode('art.image', at, 'One'), id: 'one' };
  const lines = { ...createNode('art.lines', at, 'Lines'), id: 'lines' };
  const bare = { ...project, nodes: [...project.nodes, one, lines], connections: [] };
  assert.equal(validateConnection(bare, { nodeId: 'a', portId: 'clips' }, { nodeId: 'pick', portId: 'items' }).ok, true);
  const out = { ...project, nodes: [...project.nodes, lines], connections: [...project.connections, createConnection({ nodeId: 'pick', portId: 'selected' }, { nodeId: 'lines', portId: 'image' })] };
  assert.equal(validateConnection({ ...out, connections: project.connections }, { nodeId: 'pick', portId: 'selected' }, { nodeId: 'lines', portId: 'image' }).ok, true);
});

test('an old Batch Select with missing fields is filled in on load', () => {
  const { project } = twoSplits();
  const broken = { ...project, nodes: project.nodes.map((node) => (node.id === 'pick' ? { ...node, data: { editor: 'batchSelect' } as never } : node)) };
  const migrated = migrateProject(broken);
  assert.deepEqual(migrated.nodes.find((node) => node.id === 'pick')!.data, { editor: 'batchSelect', excluded: [], filter: '' });
});
