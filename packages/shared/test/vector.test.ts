import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addPoint,
  boundsOf,
  deletePoint,
  deleteRun,
  deleteShape,
  deleteShapes,
  emptyVectorImage,
  isConvex,
  movePoint,
  nearestPoint,
  nearestSegment,
  readVectorImage,
  shapeById,
  shapePath,
  splitLine,
  splitPolygon,
  summariseVector,
  toCubics,
  toSvg,
  type VectorImage,
  type VectorLine,
  type VectorPoint,
  type VectorPolygon,
} from '../src/flows/vector';

let counter = 0;
const makeId = (prefix: string) => `${prefix}_${(counter += 1)}`;

const square: VectorPolygon = {
  id: 'p1',
  kind: 'polygon',
  color: '#ff0000',
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
};

const stroke: VectorLine = {
  id: 'l1',
  kind: 'line',
  color: '#000000',
  width: 2,
  points: [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
    { x: 15, y: 0 },
  ],
  curved: false,
  closed: false,
};

const image = (...shapes: Array<VectorLine | VectorPolygon>): VectorImage => ({
  width: 20,
  height: 20,
  shapes,
});

/* ---------------- geometry ---------------- */

test('convex is every turn going the same way, and collinear points are allowed', () => {
  assert.equal(isConvex(square.points), true);
  // Tracing pixels produces plenty of straight runs of three; they are not dents.
  assert.equal(
    isConvex([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]),
    true,
  );
  assert.equal(
    isConvex([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]),
    false,
    'a dart is not convex',
  );
});

test('bounds are the box round the points', () => {
  assert.deepEqual(boundsOf(square.points), { x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(boundsOf([]), { x: 0, y: 0, width: 0, height: 0 });
});

test('the nearest segment of a polygon includes the one that closes it', () => {
  // Otherwise the last edge cannot be clicked, and on a triangle that is a third
  // of the shape.
  const near = nearestSegment(square, { x: -1, y: 5 })!;
  assert.equal(near.index, 3, 'the edge from the last point back to the first');
  assert.ok(near.distance <= 1.001);
});

test('an open line has no closing segment', () => {
  const near = nearestSegment(stroke, { x: 7, y: 3 })!;
  assert.equal(near.index, 1);
  assert.ok(Math.abs(near.distance - 3) < 0.001);
});

test('the nearest point is the anchor you would pick up', () => {
  const near = nearestPoint(stroke, { x: 9, y: 1 })!;
  assert.equal(near.index, 2);
});

/* ---------------- editing points ---------------- */

test('moving a point moves that point and nothing else', () => {
  const moved = movePoint(image(square), 'p1', 1, { x: 20, y: 5 });
  const shape = shapeById(moved, 'p1')!;
  assert.deepEqual(shape.points[1], { x: 20, y: 5 });
  assert.deepEqual(shape.points[0], square.points[0]);
  assert.deepEqual(square.points[1], { x: 10, y: 0 }, 'and the original is untouched');
});

test('moving a point that is not there leaves the image alone', () => {
  const before = image(square);
  assert.equal(movePoint(before, 'p1', 9, { x: 0, y: 0 }), before);
  assert.equal(movePoint(before, 'nope', 0, { x: 0, y: 0 }), before);
});

test('a new point lands where you pointed, not at the midpoint', () => {
  // The reason to add one is almost always to pull the shape somewhere specific.
  const added = addPoint(image(stroke), 'l1', 0, { x: 2, y: 7 });
  const shape = shapeById(added, 'l1')!;
  assert.equal(shape.points.length, 5);
  assert.deepEqual(shape.points[1], { x: 2, y: 7 });
  assert.deepEqual(shape.points[2], { x: 5, y: 0 }, 'and the rest shifted along');
});

test('deleting a point removes it', () => {
  const trimmed = deletePoint(image(stroke), 'l1', 1);
  assert.deepEqual(shapeById(trimmed, 'l1')!.points, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 15, y: 0 },
  ]);
});

test('deleting the point that would leave no shape deletes the shape', () => {
  // A one-point line draws as nothing and cannot be clicked to delete, so it
  // would be a shape you could neither see nor get rid of.
  const twoPoints: VectorLine = { ...stroke, points: stroke.points.slice(0, 2) };
  assert.deepEqual(deletePoint(image(twoPoints), 'l1', 0).shapes, []);

  const triangle: VectorPolygon = { ...square, points: square.points.slice(0, 3) };
  assert.deepEqual(deletePoint(image(triangle), 'p1', 0).shapes, []);
});

/* ---------------- cutting ---------------- */

test('cutting a line gives two lines that still meet', () => {
  // Cutting should divide it, not chip a gap out of it.
  const cut = splitLine(image(stroke), 'l1', 1, { x: 7, y: 0 }, makeId);
  assert.equal(cut.shapes.length, 2);
  const [head, tail] = cut.shapes as [VectorLine, VectorLine];
  assert.deepEqual(head.points[head.points.length - 1], { x: 7, y: 0 });
  assert.deepEqual(tail.points[0], { x: 7, y: 0 });
  assert.deepEqual(head.points[0], { x: 0, y: 0 });
  assert.deepEqual(tail.points[tail.points.length - 1], { x: 15, y: 0 });
});

test('both halves of a cut line keep what the line was', () => {
  const curvy: VectorLine = { ...stroke, curved: true, color: '#123456', width: 4 };
  const cut = splitLine(image(curvy), 'l1', 1, { x: 7, y: 0 }, makeId);
  for (const shape of cut.shapes as VectorLine[]) {
    assert.equal(shape.curved, true);
    assert.equal(shape.color, '#123456');
    assert.equal(shape.width, 4);
    assert.notEqual(shape.id, 'l1', 'and each is its own shape now');
  }
});

test('cutting a closed line opens it rather than making two', () => {
  const loop: VectorLine = { ...stroke, closed: true };
  const cut = splitLine(image(loop), 'l1', 1, { x: 7, y: 0 }, makeId);
  assert.equal(cut.shapes.length, 1);
  const opened = cut.shapes[0] as VectorLine;
  assert.equal(opened.closed, false);
  assert.deepEqual(opened.points[0], { x: 7, y: 0 });
  assert.deepEqual(opened.points[opened.points.length - 1], { x: 7, y: 0 });
});

test('cutting a polygon gives two polygons that share the cut', () => {
  const cut = splitPolygon(image(square), 'p1', { x: 5, y: -5 }, { x: 5, y: 15 }, makeId);
  assert.equal(cut.shapes.length, 2);
  for (const piece of cut.shapes) {
    assert.equal(piece.kind, 'polygon');
    assert.ok(piece.points.length >= 3);
  }
  const left = cut.shapes[0]!;
  const right = cut.shapes[1]!;
  assert.ok(left.points.some((point) => Math.abs(point.x - 5) < 1e-9));
  assert.ok(right.points.some((point) => Math.abs(point.x - 5) < 1e-9));
});

test('cutting a convex polygon with a straight line keeps both halves convex', () => {
  // The shape promises convexity; cutting must not quietly break it.
  const cut = splitPolygon(image(square), 'p1', { x: -5, y: -5 }, { x: 15, y: 15 }, makeId);
  assert.equal(cut.shapes.length, 2);
  for (const piece of cut.shapes) assert.ok(isConvex(piece.points), JSON.stringify(piece.points));
});

test('a cut drawn inside the shape still cuts it', () => {
  // Two clicks across a shape are almost never exactly on its outline, and a
  // segment lying wholly inside crosses none of its edges. Taken literally that
  // is "not a cut", and the gesture would do nothing for a reason you cannot see.
  const cut = splitPolygon(image(square), 'p1', { x: 5, y: 2 }, { x: 5, y: 8 }, makeId);
  assert.equal(cut.shapes.length, 2, 'the cut was not made');
  for (const piece of cut.shapes) assert.ok(isConvex(piece.points));
});

test('a cut still misses when it is genuinely nowhere near', () => {
  // Extending turns the clicks into a direction; it must not turn every click
  // into a cut of whatever happens to lie along that line.
  const before = image(square);
  assert.equal(splitPolygon(before, 'p1', { x: 20, y: 0 }, { x: 20, y: 10 }, makeId), before);
});

test('a cut that misses is not a cut, and leaves the polygon whole', () => {
  const before = image(square);
  // Entirely outside.
  assert.equal(splitPolygon(before, 'p1', { x: 20, y: 0 }, { x: 20, y: 10 }, makeId), before);
  // Clipping one corner only touches one edge.
  const grazed = splitPolygon(before, 'p1', { x: -1, y: -1 }, { x: 1, y: -1 }, makeId);
  assert.equal(grazed.shapes.length, 1);
});

/*
 * A C, opening to the right. A vertical line through its arms crosses the
 * outline four times: into the top arm and out of it, across the gap, then into
 * the bottom arm and out of it. A convex polygon is never crossed more than twice.
 */
const letterC: VectorPolygon = {
  id: 'p1',
  kind: 'polygon',
  color: '#ff0000',
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 3 },
    { x: 3, y: 3 },
    { x: 3, y: 7 },
    { x: 10, y: 7 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
};

const areaOf = (points: VectorPoint[]) =>
  Math.abs(points.reduce((sum, a, index) => {
    const b = points[(index + 1) % points.length]!;
    return sum + a.x * b.y - b.x * a.y;
  }, 0) / 2);

test('a concave polygon is cut where the clicks were, even when the line crosses it four times', () => {
  // A vertical line at x = 6 goes through both arms: in and out of the top one,
  // then in and out of the bottom one. Aimed at the top arm, it cuts the top arm.
  const cut = splitPolygon(image(letterC), 'p1', { x: 6, y: -1 }, { x: 6, y: 2 }, makeId);
  assert.equal(cut.shapes.length, 2, 'the cut was refused');
  const areas = cut.shapes.map((piece) => areaOf(piece.points)).sort((a, b) => a - b);
  assert.deepEqual(areas, [12, areaOf(letterC.points) - 12], 'the end of the top arm, and the rest');
  for (const piece of cut.shapes) {
    assert.ok(piece.points.every((point) => point.y <= 10 && point.x <= 10), JSON.stringify(piece.points));
  }
});

test('aimed at the other arm, the same line cuts the other arm', () => {
  const cut = splitPolygon(image(letterC), 'p1', { x: 6, y: 8 }, { x: 6, y: 11 }, makeId);
  assert.equal(cut.shapes.length, 2);
  const small = cut.shapes.reduce((a, b) => (areaOf(a.points) < areaOf(b.points) ? a : b));
  assert.equal(areaOf(small.points), 12);
  assert.ok(small.points.every((point) => point.y >= 7), 'from the bottom arm');
});

test('cut pieces of a concave polygon still cover exactly what it did', () => {
  const cut = splitPolygon(image(letterC), 'p1', { x: 1, y: -1 }, { x: 1, y: 11 }, makeId);
  assert.equal(cut.shapes.length, 2);
  const total = cut.shapes.reduce((sum, piece) => sum + areaOf(piece.points), 0);
  assert.equal(total, areaOf(letterC.points));
});

/* ---------------- deleting parts ---------------- */

test('taking a bite out of the middle of a line leaves two pieces', () => {
  const long: VectorLine = {
    ...stroke,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 0 },
    ],
  };
  const bitten = deleteRun(image(long), 'l1', 2, 3, makeId);
  assert.equal(bitten.shapes.length, 2);
  assert.deepEqual((bitten.shapes[0] as VectorLine).points, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ]);
  assert.deepEqual((bitten.shapes[1] as VectorLine).points, [
    { x: 4, y: 0 },
    { x: 5, y: 0 },
  ]);
});

test('taking a run off the end just shortens the line', () => {
  const trimmed = deleteRun(image(stroke), 'l1', 2, 3, makeId);
  assert.equal(trimmed.shapes.length, 1);
  assert.deepEqual((trimmed.shapes[0] as VectorLine).points, [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
  ]);
});

test('a loop with a bite out of it is a line, because it is not a loop any more', () => {
  const opened = deleteRun(image(square), 'p1', 1, 1, makeId);
  assert.equal(opened.shapes.length, 1);
  const shape = opened.shapes[0]!;
  assert.equal(shape.kind, 'line');
  assert.equal((shape as VectorLine).closed, false);
  assert.equal(shape.points.length, 3);
});

test('deleting everything deletes the shape', () => {
  assert.deepEqual(deleteRun(image(stroke), 'l1', 0, 3, makeId).shapes, []);
});

test('shapes can be deleted one at a time or together', () => {
  const both = image(square, stroke);
  assert.deepEqual(deleteShape(both, 'p1').shapes.map((shape) => shape.id), ['l1']);
  assert.deepEqual(deleteShapes(both, ['p1', 'l1']).shapes, []);
  assert.equal(deleteShapes(both, []).shapes.length, 2);
});

/* ---------------- rendering ---------------- */

test('a polygon is written as a closed path', () => {
  assert.equal(shapePath(square), 'M 0 0 L 10 0 L 10 10 L 0 10 Z');
});

test('a straight line is written straight, and is not closed', () => {
  assert.equal(shapePath(stroke), 'M 0 0 L 5 0 L 10 0 L 15 0');
});

test('a curved line is written as real cubic Béziers', () => {
  const curvy: VectorLine = { ...stroke, curved: true, points: [
    { x: 0, y: 0 },
    { x: 5, y: 10 },
    { x: 10, y: 0 },
  ] };
  const path = shapePath(curvy);
  assert.match(path, /^M 0 0 C /);
  assert.equal((path.match(/C /g) ?? []).length, 2, 'one per span');
});

test('the curve in the file is the curve the editor drew, not a fit to it', () => {
  // A Catmull-Rom segment *is* a cubic with control points at p1 ± (p2-p0)/6,
  // so converting is exact and there is nothing to go out of step.
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ];
  const [first] = toCubics(points, false);
  assert.deepEqual(first!.c1, { x: 10 / 6, y: 0 });
  assert.deepEqual(first!.to, { x: 10, y: 0 });
});

test('the svg draws areas first and strokes over them', () => {
  // The order they were in when the picture was a picture.
  const svg = toSvg(image(stroke, square));
  const polygonAt = svg.indexOf('fill="#ff0000"');
  const lineAt = svg.indexOf('stroke="#000000"');
  assert.ok(polygonAt < lineAt, 'a stroke sits on top of what it separates');
  assert.match(svg, /viewBox="0 0 20 20"/);
  assert.match(svg, /stroke-width="2"/);
});

test('an empty image is still a valid svg', () => {
  const svg = toSvg(emptyVectorImage(4, 3));
  assert.match(svg, /<svg/);
  assert.match(svg, /<\/svg>/);
  assert.match(svg, /width="4"/);
});

/* ---------------- reading ---------------- */

test('a written image reads back as what was written', () => {
  const before = image(square, stroke);
  const after = readVectorImage(JSON.parse(JSON.stringify(before)));
  assert.deepEqual(after, before);
});

test('points may be written as pairs as well as objects', () => {
  const read = readVectorImage({
    width: 10,
    height: 10,
    shapes: [{ id: 'p', kind: 'polygon', color: '#ff0000', points: [[0, 0], [5, 0], [5, 5]] }],
  });
  assert.deepEqual(read.shapes[0]!.points, [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 },
  ]);
});

test('nonsense reads as an empty image rather than throwing', () => {
  for (const junk of [null, 42, 'shapes', {}, { shapes: 'no' }]) {
    assert.deepEqual(readVectorImage(junk).shapes, [], JSON.stringify(junk));
  }
});

test('a shape that is not a shape is dropped rather than half-read', () => {
  const read = readVectorImage({
    width: 10,
    height: 10,
    shapes: [
      { id: 'good', kind: 'polygon', color: '#ff0000', points: [[0, 0], [5, 0], [5, 5]] },
      { id: 'no-color', kind: 'polygon', points: [[0, 0], [5, 0], [5, 5]] },
      { id: 'too-few', kind: 'polygon', color: '#ff0000', points: [[0, 0], [5, 0]] },
      { kind: 'polygon', color: '#ff0000', points: [[0, 0], [5, 0], [5, 5]] },
    ],
  });
  assert.deepEqual(read.shapes.map((shape) => shape.id), ['good']);
});

/* ---------------- summary ---------------- */

test('the summary counts what is there, and flags what editing may have broken', () => {
  const dart: VectorPolygon = {
    id: 'bad',
    kind: 'polygon',
    color: '#00ff00',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
  };
  const summary = summariseVector(image(square, stroke, dart));
  assert.equal(summary.shapes, 3);
  assert.equal(summary.polygons, 2);
  assert.equal(summary.lines, 1);
  assert.equal(summary.straightLines, 1);
  assert.equal(summary.curvedLines, 0);
  assert.deepEqual(summary.colors, ['#000000', '#00ff00', '#ff0000']);
  // Dragging a point can make a convex polygon concave, and a consumer relying
  // on convexity should be told rather than surprised.
  assert.equal(summary.concave, 1);
});
