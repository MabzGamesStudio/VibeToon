import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  averageNodeRuns,
  curveFromHandle,
  curveNodes,
  flatShapesToLines,
  flatness,
  handlePosition,
  isFlat,
  nodeHandles,
  shapeNodesNear,
  smoothShallowNodes,
} from '../src/flows/vectorSmooth';
import {
  changeNodes,
  deleteNode,
  flattenRing,
  mapPoints,
  nodeTurn,
  pointKey,
  readVectorImage,
  ringSegments,
  setNodeCurve,
  shapePath,
  type VectorImage,
  type VectorPoint,
  type VectorPolygon,
} from '../src/flows/vector';

let counter = 0;
const ids = (prefix: string) => `${prefix}-${(counter += 1)}`;

const polygon = (id: string, points: VectorPoint[], color = '#cc2222'): VectorPolygon => ({ id, kind: 'polygon', color, points });

/** A regular polygon with `sides` corners round a middle. */
function round(sides: number, radius = 20, cx = 50, cy = 50): VectorPoint[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2;
    return { x: Math.round((cx + Math.cos(angle) * radius) * 100) / 100, y: Math.round((cy + Math.sin(angle) * radius) * 100) / 100 };
  });
}

test('a node’s turn: none straight on, the corner’s angle at a corner, none at a line’s ends', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(Math.round(nodeTurn(square, 1, true)), 90);
  assert.equal(Math.round(nodeTurn([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], 1, false)), 0);
  assert.equal(nodeTurn([{ x: 0, y: 0 }, { x: 5, y: 5 }], 0, false), 0);
  assert.equal(Math.round(nodeTurn(round(12), 3, true)), 30);
});

test('a curved node draws cubic segments; corners draw straight ones', () => {
  const sharp = polygon('a', round(6));
  assert.doesNotMatch(shapePath(sharp), / C /);
  const curved = { ...sharp, points: sharp.points.map((point) => ({ ...point, s: 1 })) };
  assert.equal(shapePath(curved).match(/ C /g)?.length, 6);
  // A segment is straight only where both its ends are corners.
  const one = { ...sharp, points: sharp.points.map((point, index) => (index === 0 ? { ...point, s: 1 } : point)) };
  const segments = ringSegments(one.points, true);
  assert.equal(segments.filter((segment) => segment.curved).length, 2);
});

test('two shapes sharing a run of curved nodes draw the same curve along it', () => {
  const run = [{ x: 0, y: 0, s: 1 }, { x: 10, y: 3, s: 1 }, { x: 20, y: 4, s: 1 }, { x: 30, y: 3, s: 1 }, { x: 40, y: 0, s: 1 }];
  const forward = ringSegments(run, false);
  const backward = ringSegments([...run].reverse(), false);
  // The middle segment, walked either way, has the same handles.
  const [a, b] = [forward[1]!, backward[2]!];
  assert.deepEqual([a.c1, a.c2].map((p) => [p.x.toFixed(6), p.y.toFixed(6)]), [b.c2, b.c1].map((p) => [p.x.toFixed(6), p.y.toFixed(6)]));
});

test('a curve is flattened into points on it, and a node’s turn bends it', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0, s: 1 }, { x: 40, y: 20 }];
  const flat = flattenRing(points, false);
  assert.ok(flat.length > 5);
  assert.deepEqual(flat[flat.length - 1], { x: 40, y: 20 });
  const turned = flattenRing([{ x: 0, y: 0 }, { x: 20, y: 0, s: 1, a: 40 }, { x: 40, y: 20 }], false);
  assert.notDeepEqual(turned, flat);
});

test('a node’s curve travels with it: moved, posed, read back', () => {
  const shape = polygon('a', [{ x: 0, y: 0, s: 0.8, a: 10 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  const moved = mapPoints(shape, (point) => ({ x: point.x + 5, y: point.y }));
  assert.equal(moved.points[0]!.s, 0.8);
  assert.equal(moved.points[0]!.a, 10);
  const read = readVectorImage(JSON.parse(JSON.stringify({ width: 20, height: 20, shapes: [shape] })));
  assert.equal(read.shapes[0]!.points[0]!.s, 0.8);
  assert.equal(read.shapes[0]!.points[0]!.a, 10);
});

test('a node is changed in every shape that shares it, and a shape left too small goes', () => {
  const left = polygon('left', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  const right = polygon('right', [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }]);
  const image: VectorImage = { width: 20, height: 10, shapes: [left, right] };
  const curved = setNodeCurve(image, pointKey({ x: 10, y: 0 }), { s: 1, a: 5 });
  for (const shape of curved.shapes) {
    const node = shape.points.find((point) => point.x === 10 && point.y === 0)!;
    assert.equal(node.s, 1);
    assert.equal(node.a, 5);
  }
  const gone = deleteNode(image, pointKey({ x: 10, y: 0 }));
  assert.ok(gone.shapes.every((shape) => shape.points.length === 3));
  const triangle = polygon('tri', [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }]);
  assert.equal(deleteNode({ width: 5, height: 5, shapes: [triangle] }, '0,0').shapes.length, 0);
  // Two nodes moved onto each other become one.
  const merged = changeNodes(image, (point) => (point.x === 10 && point.y === 10 ? { x: 10, y: 0 } : point));
  assert.ok(merged.shapes.every((shape) => shape.points.length === 3));
});

test('flat by its normals: a long thin sliver is, a square and a fat rectangle are not', () => {
  const sliver = [{ x: 0, y: 0 }, { x: 40, y: 0.6 }, { x: 40, y: 1.6 }, { x: 0, y: 1 }];
  const measured = flatness(sliver, 8)!;
  assert.ok(measured.facingAcross > 0.9);
  assert.ok(isFlat(sliver, 8, 3));
  assert.equal(isFlat([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 8, 3), null);
  assert.equal(isFlat([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }, { x: 0, y: 3 }], 8, 3), null, 'a small rectangle as wide as a stroke is an area');
  // A bumpy sliver has edges facing other ways than across it.
  const bumpy = [{ x: 0, y: 0 }, { x: 10, y: 1.4 }, { x: 20, y: 0 }, { x: 30, y: 1.4 }, { x: 40, y: 0 }, { x: 40, y: 1.5 }, { x: 0, y: 1.5 }];
  assert.equal(isFlat(bumpy, 3, 3), null);
});

test('a flat polygon is replaced by a line of its color down its middle, as wide as it is', () => {
  const sliver = polygon('flat', [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 11.2 }, { x: 10, y: 11.2 }], '#223344');
  const square = polygon('square', [{ x: 0, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 30 }, { x: 0, y: 30 }]);
  const { image, flattened } = flatShapesToLines({ width: 60, height: 40, shapes: [sliver, square] }, 8, 3, ids);
  assert.equal(flattened, 1);
  const line = image.shapes.find((shape) => shape.kind === 'line')!;
  assert.equal(line.color, '#223344');
  assert.ok(line.kind === 'line' && Math.abs(line.width - 1.2) < 0.05);
  const length = Math.hypot(line.points[1]!.x - line.points[0]!.x, line.points[1]!.y - line.points[0]!.y);
  assert.ok(Math.abs(length - 40) < 0.5);
  assert.ok(image.shapes.some((shape) => shape.id === 'square'));
  assert.equal(flatShapesToLines({ width: 60, height: 40, shapes: [sliver] }, 0, 3, ids).flattened, 0, 'off at 0');
});

test('shallow nodes become smooth, sharp ones stay corners, and nothing at a three-way meeting curves', () => {
  const circle = polygon('circle', round(16));
  const smooth = smoothShallowNodes({ width: 100, height: 100, shapes: [circle] }, 30);
  assert.equal(smooth.smoothed, 16, 'a sixteen-sided circle turns 22.5° a node');
  assert.ok(smooth.image.shapes[0]!.points.every((point) => point.s === 1));
  assert.equal(smoothShallowNodes({ width: 100, height: 100, shapes: [circle] }, 20).smoothed, 0);
  assert.equal(smoothShallowNodes({ width: 100, height: 100, shapes: [circle] }, 0).smoothed, 0, 'off at 0');

  // Three shapes meeting at (10, 5): it stays a corner, whatever the angle.
  const a = polygon('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]);
  const b = polygon('b', [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }, { x: 10, y: 5 }]);
  const c = polygon('c', [{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 10 }, { x: 0, y: 10 }]);
  const met = smoothShallowNodes({ width: 20, height: 10, shapes: [a, b, c] }, 179);
  const junction = met.image.shapes.flatMap((shape) => shape.points).filter((point) => point.x === 10 && point.y === 5);
  assert.ok(junction.every((point) => point.s === undefined));
});

test('the brush finds a shape’s nodes near it, holes included', () => {
  const ring = polygon('ring', round(12, 20));
  const near = shapeNodesNear(ring, { x: 70, y: 50 }, 6);
  assert.deepEqual(near, [pointKey(ring.points[0]!)]);
  assert.equal(shapeNodesNear(ring, { x: 50, y: 50 }, 5).length, 0);
});

test('averaging a brushed run: each group of N becomes one node where they were on average', () => {
  const circle = polygon('circle', round(16));
  const image: VectorImage = { width: 100, height: 100, shapes: [circle] };
  const keys = new Set(circle.points.slice(2, 8).map(pointKey));
  const { image: averaged, removed } = averageNodeRuns(image, 'circle', keys, 3);
  assert.equal(removed, 4, 'six nodes in groups of three become two');
  assert.equal(averaged.shapes[0]!.points.length, 12);
  const group = circle.points.slice(2, 5);
  const middle = { x: group.reduce((sum, p) => sum + p.x, 0) / 3, y: group.reduce((sum, p) => sum + p.y, 0) / 3 };
  assert.ok(averaged.shapes[0]!.points.some((p) => Math.abs(p.x - middle.x) < 0.01 && Math.abs(p.y - middle.y) < 0.01));
  assert.equal(averageNodeRuns(image, 'circle', keys, 1).removed, 0, 'a group of one is nothing to do');
});

test('averaging never leaves a shape too small, keeps a line’s ends, and wraps round a loop', () => {
  const square = polygon('square', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  const all = new Set(square.points.map(pointKey));
  const { image } = averageNodeRuns({ width: 10, height: 10, shapes: [square] }, 'square', all, 8);
  assert.equal(image.shapes[0]!.points.length, 3);

  const line = { id: 'line', kind: 'line' as const, color: '#000000', width: 2, curved: false, closed: false, points: [{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 }, { x: 15, y: 1 }] };
  const ends = averageNodeRuns({ width: 20, height: 5, shapes: [line] }, 'line', new Set(line.points.map(pointKey)), 4).image.shapes[0]!;
  assert.deepEqual(ends.points[0], { x: 0, y: 0 });
  assert.deepEqual(ends.points[ends.points.length - 1], { x: 15, y: 1 });
  assert.equal(ends.points.length, 3);

  // A run across where the loop starts is still one run.
  const circle = polygon('circle', round(12));
  const across = new Set([circle.points[11]!, circle.points[0]!].map(pointKey));
  const wrapped = averageNodeRuns({ width: 100, height: 100, shapes: [circle] }, 'circle', across, 2);
  assert.equal(wrapped.removed, 1);
  assert.equal(wrapped.image.shapes[0]!.points.length, 11);
});

test('averaging moves a neighbour’s shared boundary with it', () => {
  const left = polygon('left', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 11, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  const right = polygon('right', [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 5 }]);
  const keys = new Set([pointKey({ x: 11, y: 5 }), pointKey({ x: 10, y: 10 })]);
  const { image } = averageNodeRuns({ width: 20, height: 10, shapes: [left, right] }, 'left', keys, 2);
  const [a, b] = image.shapes;
  assert.ok(a!.points.some((p) => p.x === 10.5 && p.y === 7.5));
  assert.ok(b!.points.some((p) => p.x === 10.5 && p.y === 7.5));
  assert.equal(a!.points.length, 4);
  assert.equal(b!.points.length, 4);
});

test('the curve brush sets how curved the brushed nodes are, and 0 makes them corners', () => {
  const circle = polygon('circle', round(8));
  const keys = new Set(circle.points.slice(0, 3).map(pointKey));
  const curved = curveNodes({ width: 100, height: 100, shapes: [circle] }, keys, 0.7);
  assert.deepEqual(curved.shapes[0]!.points.map((p) => p.s ?? 0), [0.7, 0.7, 0.7, 0, 0, 0, 0, 0]);
  const back = curveNodes(curved, keys, 0);
  assert.ok(back.shapes[0]!.points.every((p) => p.s === undefined));
});

test('a handle dragged sets the node’s curve and turn; put back, it reads the same', () => {
  const shape = polygon('a', [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }]);
  const image: VectorImage = { width: 30, height: 30, shapes: [shape] };
  const handles = nodeHandles(image, '30,0')!;
  assert.equal(handles.s, 0);
  assert.equal(handles.ahead, 10);
  // Straight through (30,0) runs from (0,0) towards (30,30).
  assert.ok(Math.abs(handles.straight.x - handles.straight.y) < 1e-9);
  const { s, a } = curveFromHandle(handles, 'ahead', { x: 30, y: 10 });
  assert.equal(s, 1);
  assert.equal(a, 45);
  const curved = nodeHandles(setNodeCurve(image, '30,0', { s, a }), '30,0')!;
  const at = handlePosition(curved, 'ahead');
  assert.ok(Math.abs(at.x - 30) < 1e-6 && Math.abs(at.y - 10) < 1e-6);
  // The handle behind is the same one, mirrored.
  const behind = curveFromHandle(curved, 'behind', handlePosition(curved, 'behind'));
  assert.equal(behind.a, 45);
  assert.equal(nodeHandles(image, 'nowhere'), null);
});
