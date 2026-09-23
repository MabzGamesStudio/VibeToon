import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinLines, joinPolygons, unionOfTwo } from '../src/flows/join';
import type { VectorLine, VectorPoint, VectorPolygon, VectorShape } from '../src/flows/vector';

const P = (x: number, y: number): VectorPoint => ({ x, y });

function polygon(id: string, color: string, ...points: Array<[number, number]>): VectorPolygon {
  return { id, kind: 'polygon', color, points: points.map(([x, y]) => P(x, y)) };
}

function line(id: string, color: string, width: number, ...points: Array<[number, number]>): VectorLine {
  return { id, kind: 'line', color, width, points: points.map(([x, y]) => P(x, y)), curved: false, closed: false };
}

function area(points: VectorPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

const polygons = (shapes: VectorShape[]) => shapes.filter((shape): shape is VectorPolygon => shape.kind === 'polygon');
const lines = (shapes: VectorShape[]) => shapes.filter((shape): shape is VectorLine => shape.kind === 'line');

/* ---------------- polygons ---------------- */

test('two same-color squares sharing a side become one polygon', () => {
  const { shapes, joined } = joinPolygons([
    polygon('a', '#ff0000', [0, 0], [1, 0], [1, 1], [0, 1]),
    polygon('b', '#ff0000', [1, 0], [2, 0], [2, 1], [1, 1]),
  ]);
  assert.equal(joined, 1);
  assert.equal(shapes.length, 1);
  assert.equal(area(polygons(shapes)[0]!.points), 2, 'covering exactly what the two covered');
});

test('the side can be shared in either winding', () => {
  // One wound clockwise and one anticlockwise: the shared side is then the same
  // two points in the same order, not opposite ones, unless winding is evened out.
  const { shapes } = joinPolygons([
    polygon('a', '#ff0000', [0, 0], [0, 1], [1, 1], [1, 0]),
    polygon('b', '#ff0000', [1, 0], [2, 0], [2, 1], [1, 1]),
  ]);
  assert.equal(shapes.length, 1);
});

test('a shade of difference is a different shape, and is left alone', () => {
  const { shapes, joined } = joinPolygons([
    polygon('a', '#ff0000', [0, 0], [1, 0], [1, 1], [0, 1]),
    polygon('b', '#ff0001', [1, 0], [2, 0], [2, 1], [1, 1]),
  ]);
  assert.equal(joined, 0);
  assert.equal(shapes.length, 2);
});

test('touching at a corner is not sharing a side', () => {
  const { joined } = joinPolygons([
    polygon('a', '#ff0000', [0, 0], [1, 0], [1, 1], [0, 1]),
    polygon('b', '#ff0000', [1, 1], [2, 1], [2, 2], [1, 2]),
  ]);
  assert.equal(joined, 0);
});

test('a concave region cut into convex pieces comes back as the one shape it was', () => {
  // An L, cut the way the decomposition cuts one: along a diagonal between two
  // of its own corners, so both pieces hold only corners the L already had.
  const { shapes, joined } = joinPolygons([
    polygon('a', '#123456', [0, 0], [2, 0], [2, 1], [1, 1]),
    polygon('b', '#123456', [0, 0], [1, 1], [1, 3], [0, 3]),
  ]);
  assert.equal(joined, 1);
  const [only] = polygons(shapes);
  assert.equal(area(only!.points), 4, 'a two-by-one bar and a one-by-two bar');
  assert.equal(only!.points.length, 6, 'the six corners of an L, and no more');
});

test('a fan of pieces is rebuilt one piece at a time', () => {
  const hexagon = [P(2, 0), P(4, 1), P(4, 3), P(2, 4), P(0, 3), P(0, 1)];
  const fan = hexagon
    .slice(1, -1)
    .map((point, index) =>
      polygon(`t${index}`, '#00ff00', [hexagon[0]!.x, hexagon[0]!.y], [point.x, point.y], [hexagon[index + 2]!.x, hexagon[index + 2]!.y]),
    );
  const { shapes, joined } = joinPolygons(fan);
  assert.equal(joined, 3);
  assert.equal(shapes.length, 1);
  assert.equal(area(polygons(shapes)[0]!.points), area(hexagon));
});

test('a ring stops one short of closing, because a polygon cannot have a hole', () => {
  /*
   * A square frame cut into four. Joining all four would need the outline to go
   * round the outside and then round the inside, which is two loops — and a
   * polygon is one. So the last join is refused and the ring stays two shapes,
   * covering exactly what the four did.
   */
  const frame = [
    polygon('top', '#000000', [0, 0], [3, 0], [2, 1], [1, 1]),
    polygon('right', '#000000', [3, 0], [3, 3], [2, 2], [2, 1]),
    polygon('bottom', '#000000', [3, 3], [0, 3], [1, 2], [2, 2]),
    polygon('left', '#000000', [0, 3], [0, 0], [1, 1], [1, 2]),
  ];
  const { shapes } = joinPolygons(frame);
  assert.equal(shapes.length, 2);
  const total = polygons(shapes).reduce((sum, shape) => sum + area(shape.points), 0);
  assert.equal(total, 9 - 1);
});

test('a join that would leave the outline touching itself is refused', () => {
  // Two L-shapes that meet along a side *and* at a lone corner: joined, the
  // outline would pass through that corner twice.
  const one = [P(0, 0), P(2, 0), P(2, 1), P(1, 1), P(1, 2), P(0, 2)];
  const two = [P(2, 0), P(3, 0), P(3, 2), P(1, 2), P(1, 1), P(2, 1)];
  assert.notEqual(unionOfTwo(one, two), null, 'sharing a run of sides is fine');
  const pinched = [P(2, 0), P(3, 0), P(3, 3), P(1, 3), P(1, 2), P(2, 2), P(2, 1)];
  // Shares (2,0)-(2,1) with `one`, and touches it again only at (1,2).
  assert.equal(unionOfTwo(one, pinched), null);
});

test('the joined polygon keeps the id of the bigger part, in the place of the first', () => {
  const stroke = line('l', '#000000', 2, [5, 5], [6, 6]);
  const { shapes } = joinPolygons([
    polygon('small', '#ff0000', [0, 0], [1, 0], [1, 1], [0, 1]),
    stroke,
    polygon('big', '#ff0000', [1, 0], [4, 0], [4, 1], [1, 1]),
  ]);
  assert.deepEqual(shapes.map((shape) => shape.id), ['big', 'l']);
});

/* ---------------- lines ---------------- */

test('two same-color lines that meet end to end become one', () => {
  const { shapes, joined } = joinLines(
    [line('a', '#000000', 2, [0, 0], [10, 0]), line('b', '#000000', 2, [10, 0], [20, 0])],
    3,
  );
  assert.equal(joined, 1);
  assert.equal(shapes.length, 1);
  assert.deepEqual(lines(shapes)[0]!.points, [P(0, 0), P(10, 0), P(20, 0)]);
});

test('ends that are close but not touching are joined halfway, closing the gap', () => {
  const { shapes } = joinLines(
    [line('a', '#000000', 2, [0, 0], [10, 0]), line('b', '#000000', 2, [12, 0], [20, 0])],
    3,
  );
  assert.deepEqual(lines(shapes)[0]!.points, [P(0, 0), P(11, 0), P(20, 0)]);
});

test('a line is turned round to join, whichever ends are the close ones', () => {
  // Both lines end at the join, so one of them has to be walked backwards.
  const { shapes } = joinLines(
    [line('a', '#000000', 2, [0, 0], [10, 0]), line('b', '#000000', 2, [20, 0], [10, 0])],
    3,
  );
  assert.deepEqual(lines(shapes)[0]!.points, [P(0, 0), P(10, 0), P(20, 0)]);
});

test('ends further apart than the gap, or a different color, are left alone', () => {
  assert.equal(
    joinLines([line('a', '#000000', 2, [0, 0], [10, 0]), line('b', '#000000', 2, [14, 0], [20, 0])], 3).joined,
    0,
  );
  assert.equal(
    joinLines([line('a', '#000000', 2, [0, 0], [10, 0]), line('b', '#000001', 2, [10, 0], [20, 0])], 3).joined,
    0,
  );
});

test('where a line forks, the two runs that carry straight on are the ones joined', () => {
  const { shapes, joined } = joinLines(
    [
      line('left', '#000000', 2, [0, 0], [10, 0]),
      line('branch', '#000000', 2, [10, 0], [10, 10]),
      line('right', '#000000', 2, [10, 0], [20, 0]),
    ],
    3,
  );
  assert.equal(joined, 1, 'each end is used once, so the branch stays its own line');
  const through = lines(shapes).find((shape) => shape.points.length === 3)!;
  assert.deepEqual(through.points, [P(0, 0), P(10, 0), P(20, 0)]);
  assert.ok(lines(shapes).some((shape) => shape.id === 'branch'));
});

test('lines are not joined into a loop', () => {
  // Three sides of a triangle whose corners all touch: joining all three would
  // close it, which is a different decision from joining two lines.
  const { shapes, joined } = joinLines(
    [
      line('a', '#000000', 2, [0, 0], [10, 0]),
      line('b', '#000000', 2, [10, 0], [5, 8]),
      line('c', '#000000', 2, [5, 8], [0, 0]),
    ],
    1,
  );
  assert.equal(joined, 2);
  assert.equal(shapes.length, 1);
  assert.equal(lines(shapes)[0]!.closed, false);
});

test('a joined line is as wide as its parts were, weighted by their length', () => {
  const { shapes } = joinLines(
    [line('a', '#000000', 2, [0, 0], [30, 0]), line('b', '#000000', 4, [30, 0], [40, 0])],
    3,
  );
  assert.equal(lines(shapes)[0]!.width, 2.5);
});

test('a closed line has no ends, and polygons are not lines', () => {
  const loop: VectorLine = { ...line('o', '#000000', 2, [0, 0], [10, 0], [10, 10]), closed: true };
  const { joined } = joinLines(
    [loop, line('a', '#000000', 2, [0, 0], [-10, 0]), polygon('p', '#000000', [0, 0], [1, 0], [1, 1])],
    3,
  );
  assert.equal(joined, 0);
});
