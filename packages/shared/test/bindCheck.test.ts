import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindNodes, emptyBindFlowData, nodeKey, type BindFlowData } from '../src/flows/rigBind';
import {
  bindUnboundByShape,
  partOfShape,
  putInPart,
  separateNodes,
  splitNodes,
  unboundNodeKeys,
} from '../src/flows/rigBindCheck';
import { emptyRigFlowData } from '../src/flows/rig';
import type { VectorImage, VectorPolygon } from '../src/flows/vector';

const rect = (id: string, x: number, y: number, w: number, h: number): VectorPolygon => ({
  id,
  kind: 'polygon',
  color: '#ff0000',
  points: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
});

/** An arm and a chest side by side, sharing the edge x = 10. */
const drawing: VectorImage = {
  width: 30,
  height: 10,
  shapes: [
    { ...rect('chest', 0, 0, 10, 10), points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
    { ...rect('arm', 10, 0, 20, 10), points: [{ x: 10, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 5 }] },
  ],
};

function bound(): BindFlowData {
  let data: BindFlowData = { ...emptyBindFlowData(), rig: emptyRigFlowData('human'), image: drawing };
  data = bindNodes(data, ['0,0', '0,10', '10,0', '10,5', '10,10'], 'chest');
  data = bindNodes(data, ['30,0', '30,10'], 'arm');
  return data;
}

test('unbound nodes are found, and put in the part their shapes are in', () => {
  const withHat = { ...drawing, shapes: [...drawing.shapes, rect('hat', 0, 20, 4, 4)] };
  const start: BindFlowData = { ...emptyBindFlowData(), rig: emptyRigFlowData('human'), image: withHat };
  assert.equal(unboundNodeKeys(start).length, 11);
  const some = bindNodes(start, ['0,0', '0,10', '10,0'], 'chest');
  const { data, bound: count } = bindUnboundByShape(some);
  // The chest's nodes go to the chest, and so do the arm's: every bound node
  // it has is the chest's. The hat has no part yet, so it waits.
  assert.equal(data.nodes['10,5'], 'chest');
  assert.equal(data.nodes['30,0'], 'chest');
  assert.equal(data.nodes['0,20'], undefined);
  assert.equal(count, 4);
  assert.deepEqual(unboundNodeKeys(data).sort(), ['0,20', '0,24', '4,20', '4,24']);
  assert.equal(data.edits, some.edits + 1, 'one edit');
});

test('a shape is in the part carrying most of its nodes', () => {
  const data = bound();
  assert.equal(partOfShape(data, drawing.shapes[0]!), 'chest');
  // The arm has three chest nodes on its edge and two of its own: the chest wins.
  assert.equal(partOfShape(data, drawing.shapes[1]!), 'chest');
  const fixed = bindNodes(data, ['10,5'], 'arm');
  assert.equal(partOfShape(fixed, drawing.shapes[1]!), 'arm');
});

test('boundary nodes between two parts are found, grouped by the parts', () => {
  const data = bindNodes(bound(), ['10,5'], 'arm');
  const groups = splitNodes(data);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group!.kind, 'shared');
  assert.deepEqual([...group!.keys].sort(), ['10,0', '10,10', '10,5']);
  assert.deepEqual(group!.bones, ['chest', 'arm'], 'the part carrying most of them first');
  assert.equal(splitNodes({ ...data, nodes: {} }).length, 0, 'nothing bound, nothing split');
});

test('putting a group in one part binds every node in it there', () => {
  const data = bindNodes(bound(), ['10,5'], 'arm');
  const [group] = splitNodes(data);
  const settled = putInPart(data, group!, 'arm');
  for (const key of group!.keys) assert.equal(settled.nodes[key], 'arm');
});

test('separating gives each part its own copy of the boundary, bound to it', () => {
  const data = bindNodes(bound(), ['10,5'], 'arm');
  const [group] = splitNodes(data);
  const apart = separateNodes(data, group!);
  const [chest, arm] = apart.image!.shapes;
  // Each node stays with the part it was in, and the other part's shape gets a
  // copy a hair's breadth into it: the chest keeps (10,0) and (10,10), the arm
  // keeps (10,5).
  assert.ok(chest!.points.some((point) => point.x === 10 && point.y === 0));
  assert.ok(!arm!.points.some((point) => point.x === 10 && point.y === 0));
  const armCopies = arm!.points.filter((point) => point.x > 10 && point.x < 10.1);
  assert.equal(armCopies.length, 2);
  for (const copy of armCopies) assert.equal(apart.nodes[nodeKey(copy)], 'arm');
  const chestCopies = chest!.points.filter((point) => point.x < 10 && point.x > 9.9);
  assert.equal(chestCopies.length, 1);
  assert.equal(apart.nodes[nodeKey(chestCopies[0]!)], 'chest');
  assert.equal(apart.nodes['10,0'], 'chest');
  assert.equal(apart.nodes['10,5'], 'arm');
  assert.equal(splitNodes(apart).length, 0, 'nothing shared any more, and the copies are not taken for a mistake');
  assert.equal(splitNodes({ ...apart, apart: [] }).filter((found) => found.kind === 'near').length, 1, 'which they would be, were they not marked');
});

test('nodes on top of each other bound to different parts are found', () => {
  const image: VectorImage = { width: 20, height: 10, shapes: [rect('a', 0, 0, 5, 5), rect('b', 5.3, 0, 5, 5)] };
  let data: BindFlowData = { ...emptyBindFlowData(), rig: emptyRigFlowData('human'), image };
  data = bindNodes(data, ['0,0', '5,0', '5,5', '0,5'], 'one');
  data = bindNodes(data, ['5.3,0', '10.3,0', '10.3,5', '5.3,5'], 'two');
  const groups = splitNodes(data, 0.5);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.kind, 'near');
  assert.equal(groups[0]!.keys.length, 4);
  assert.equal(splitNodes(data, 0.2).length, 0, 'further apart than counts as the same place');
  const settled = putInPart(data, groups[0]!, 'one');
  assert.equal(splitNodes(settled, 0.5).length, 0);
});
