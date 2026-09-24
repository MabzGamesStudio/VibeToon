import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinPolygons, unionOfRegions } from '../src/flows/join';
import { posedImage } from '../src/flows/pose';
import { emptyRigFlowData } from '../src/flows/rig';
import { boundRigOf, emptyBindFlowData, nodeKey, nodesOf, type BindFlowData } from '../src/flows/rigBind';
import { absorbSmallPolygons, spaceShapes } from '../src/flows/tidy';
import {
  addPoint,
  allPoints,
  containsPoint,
  deletePoint,
  deleteRun,
  mapPoints,
  movePoint,
  nearestPoint,
  nearestSegment,
  readVectorImage,
  shapePath,
  splitPolygon,
  summariseVector,
  toSvg,
  type VectorImage,
  type VectorPoint,
  type VectorPolygon,
} from '../src/flows/vector';

const P = (x: number, y: number): VectorPoint => ({ x, y });
const square = (x: number, y: number, size: number): VectorPoint[] => [
  P(x, y),
  P(x + size, y),
  P(x + size, y + size),
  P(x, y + size),
];

/** A 10 × 10 square with a 4 × 4 hole in the middle. */
const frame: VectorPolygon = { id: 'frame', kind: 'polygon', color: '#ffcc00', points: square(0, 0, 10), holes: [square(3, 3, 4)] };
/** What fits the hole exactly. */
const plug: VectorPolygon = { id: 'plug', kind: 'polygon', color: '#111111', points: square(3, 3, 4) };

function area(points: VectorPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}
const covered = (polygon: VectorPolygon) =>
  area(polygon.points) - (polygon.holes ?? []).reduce((sum, hole) => sum + area(hole), 0);

/* ---------------- the model ---------------- */

test('a hole is drawn as its own subpath, filled even-odd', () => {
  assert.equal((shapePath(frame).match(/M /g) ?? []).length, 2);
  assert.match(toSvg({ width: 10, height: 10, shapes: [frame] }), /fill-rule="evenodd"/);
});

test('a point in the hole is not in the shape', () => {
  assert.equal(containsPoint(frame, P(1, 1)), true);
  assert.equal(containsPoint(frame, P(5, 5)), false);
  assert.equal(containsPoint(plug, P(5, 5)), true, 'it is in what fills the hole');
});

test('holes are read back, and a polygon without them reads back without them', () => {
  const image = readVectorImage(JSON.parse(JSON.stringify({ width: 10, height: 10, shapes: [frame, plug] })));
  assert.deepEqual((image.shapes[0] as VectorPolygon).holes, frame.holes);
  assert.equal('holes' in image.shapes[1]!, false);
  const degenerate = readVectorImage({ width: 1, height: 1, shapes: [{ ...frame, holes: [[P(0, 0), P(1, 1)]] }] });
  assert.equal('holes' in degenerate.shapes[0]!, false, 'a two-point hole is no hole');
});

test('a hole is counted in the summary, points and all', () => {
  const summary = summariseVector({ width: 10, height: 10, shapes: [frame, plug] });
  assert.equal(summary.holes, 1);
  assert.equal(summary.points, 12);
});

test('every point is moved together, outline then holes, in one order', () => {
  assert.equal(allPoints(frame).length, 8);
  const moved = mapPoints(frame, (point, index) => ({ x: index, y: point.y }));
  assert.deepEqual(allPoints(moved).map((point) => point.x), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(allPoints(moved).map((point) => point.y), allPoints(frame).map((point) => point.y));
});

/* ---------------- editing a hole ---------------- */

const image: VectorImage = { width: 10, height: 10, shapes: [frame] };
const holeOf = (drawn: VectorImage) => (drawn.shapes[0] as VectorPolygon).holes;

test('a hole point can be picked up, moved, added to and deleted', () => {
  const near = nearestPoint(frame, P(6.9, 3.1))!;
  assert.equal(near.index, 5, 'the hole’s second corner, after the outline’s four');
  const moved = movePoint(image, 'frame', near.index, P(8, 2));
  assert.deepEqual(holeOf(moved)![0]![1], P(8, 2));
  assert.deepEqual((moved.shapes[0] as VectorPolygon).points, frame.points, 'the outline is left alone');

  const edge = nearestSegment(frame, P(5, 3))!;
  assert.equal(edge.index, 4, 'the hole’s first side');
  const added = addPoint(image, 'frame', edge.index, P(5, 3));
  assert.equal(holeOf(added)![0]!.length, 5);
  assert.deepEqual(holeOf(added)![0]![1], P(5, 3));

  assert.equal(holeOf(deletePoint(added, 'frame', 5))![0]!.length, 4);
  assert.equal(holeOf(deletePoint(image, 'frame', 5))![0]!.length, 3);
  const closed = deletePoint(deletePoint(image, 'frame', 5), 'frame', 5);
  assert.equal(holeOf(closed), undefined, 'a hole down to two points closes');
  assert.equal(closed.shapes[0]!.points.length, 4, 'and the shape is still there');
});

test('a bite out of a hole makes it smaller or closes it', () => {
  const ids = () => 'x';
  assert.equal(holeOf(deleteRun(image, 'frame', 4, 5, ids)), undefined);
  assert.equal(deleteRun(image, 'frame', 2, 5, ids), image, 'not across the outline and a hole');
});

test('cutting a polygon keeps its hole in the half it is in', () => {
  let n = 0;
  const cut = splitPolygon({ width: 10, height: 10, shapes: [frame] }, 'frame', P(1, -1), P(1, 11), () => `p${(n += 1)}`);
  assert.equal(cut.shapes.length, 2);
  const withHole = cut.shapes.filter((shape) => (shape as VectorPolygon).holes?.length === 1);
  assert.equal(withHole.length, 1);
  assert.ok(containsPoint(withHole[0]!, P(8, 5)), 'the big half, where the hole is');
});

/* ---------------- joining with holes ---------------- */

test('a shape that exactly fills a hole closes it', () => {
  const union = unionOfRegions({ outer: frame.points, holes: frame.holes! }, { outer: plug.points, holes: [] });
  assert.ok(union);
  assert.equal(union!.holes.length, 0);
  assert.equal(area(union!.outer), 100);
});

test('a shape filling part of a hole shrinks it', () => {
  const half = [P(3, 3), P(5, 3), P(5, 7), P(3, 7)];
  const union = unionOfRegions({ outer: frame.points, holes: frame.holes! }, { outer: half, holes: [] });
  assert.ok(union);
  assert.equal(union!.holes.length, 1);
  assert.equal(area(union!.holes[0]!), 8);
});

test('two shapes side by side keep both of their holes', () => {
  const other: VectorPolygon = { ...frame, points: square(10, 0, 10), holes: [square(13, 3, 4)] };
  const union = unionOfRegions({ outer: frame.points, holes: frame.holes! }, { outer: other.points, holes: other.holes! });
  assert.ok(union);
  assert.equal(union!.holes.length, 2);
  assert.equal(area(union!.outer), 200);
});

test('overlapping shapes are not joined', () => {
  assert.equal(unionOfRegions({ outer: square(0, 0, 4), holes: [] }, { outer: square(0, 0, 4), holes: [] }), null);
  assert.equal(unionOfRegions({ outer: square(0, 0, 4), holes: [] }, { outer: square(9, 9, 4), holes: [] }), null, 'nor ones that do not meet');
});

test('a same-color shape in a hole is joined into the shape round it', () => {
  const { shapes, joined } = joinPolygons([frame, { ...plug, color: frame.color }]);
  assert.equal(joined, 1);
  assert.equal(shapes.length, 1);
  assert.equal((shapes[0] as VectorPolygon).holes, undefined);
});

test('a different-color shape in a hole is left in it', () => {
  const { shapes, joined } = joinPolygons([frame, plug]);
  assert.equal(joined, 0);
  assert.equal(shapes.length, 2);
});

/* ---------------- tidying with holes ---------------- */

test('a speck in a hole folds into the shape round it, closing the hole', () => {
  const { shapes, absorbed } = absorbSmallPolygons([frame, plug], 20);
  assert.equal(absorbed, 1);
  assert.equal(shapes.length, 1);
  assert.equal(covered(shapes[0] as VectorPolygon), 100);
});

test('a small hole leaves a big shape big: its size is what it covers', () => {
  // 100 less 16 is 84, over a minimum of 80.
  const { shapes } = absorbSmallPolygons([frame], 80);
  assert.equal(shapes.length, 1);
  const { shapes: gone } = absorbSmallPolygons([frame], 90);
  assert.equal(gone.length, 0, 'under it, with nothing to fold into, it is dropped');
});

test('spacing nodes moves a hole and what fills it together', () => {
  const crowded: VectorPolygon = { ...frame, holes: [[P(3, 3), P(3.4, 3), P(7, 3), P(7, 7), P(3, 7)]] };
  const filler: VectorPolygon = { ...plug, points: [P(3, 3), P(3, 7), P(7, 7), P(7, 3), P(3.4, 3)] };
  const { shapes, merged } = spaceShapes([crowded, filler], 1.5);
  assert.equal(merged, 1);
  const [outer, inner] = shapes as VectorPolygon[];
  assert.equal(outer!.holes![0]!.length, 4);
  assert.equal(inner!.points.length, 4);
  assert.ok(unionOfRegions({ outer: outer!.points, holes: outer!.holes! }, { outer: inner!.points, holes: [] }), 'still a perfect fit');
});

/* ---------------- binding and posing ---------------- */

test('a hole’s points are nodes, and move with the bone they are bound to', () => {
  const nodes = nodesOf({ width: 10, height: 10, shapes: [frame, plug] });
  assert.equal(nodes.length, 8, 'the hole and the plug share their four corners');
  assert.equal(nodes.find((node) => node.key === '3,3')!.uses, 2);

  const rig = emptyRigFlowData('human');
  const bone = rig.bones[0]!.id;
  const data: BindFlowData = {
    ...emptyBindFlowData(),
    rig,
    image: { width: 10, height: 10, shapes: [frame, plug] },
    nodes: Object.fromEntries(square(3, 3, 4).map((point) => [nodeKey(point), bone])),
  };
  const bound = boundRigOf(data)!;
  assert.deepEqual(bound.points.frame, [null, null, null, null, bone, bone, bone, bone]);
  const posed = posedImage(bound, { [bone]: 30 });
  const [movedFrame, movedPlug] = posed.shapes as VectorPolygon[];
  assert.deepEqual(movedFrame!.points, frame.points, 'the outline is not bound');
  assert.notDeepEqual(movedFrame!.holes![0], frame.holes![0], 'the hole moved');
  assert.deepEqual(movedFrame!.holes![0], movedPlug!.points, 'and the plug moved with it, exactly');
});
