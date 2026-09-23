import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RegionLoops } from '../src/flows/arcs';
import { unionOfTwo } from '../src/flows/join';
import { absorbSmallPolygons, spaceNodes, spacePath, spaceShapes } from '../src/flows/tidy';
import type { VectorLine, VectorPoint, VectorPolygon, VectorShape } from '../src/flows/vector';

const P = (x: number, y: number): VectorPoint => ({ x, y });

function area(points: VectorPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

function polygon(id: string, color: string, ...points: Array<[number, number]>): VectorPolygon {
  return { id, kind: 'polygon', color, points: points.map(([x, y]) => P(x, y)) };
}

const loops = (...outers: VectorPoint[][]): Map<number, RegionLoops> =>
  new Map(outers.map((outer, id) => [id, { outer, holes: [] }]));

/* ---------------- no two nodes closer than a distance ---------------- */

test('two nodes closer than the gap become one, in every outline that has them', () => {
  // Two squares sharing an edge, with a pair of points half a pixel apart on it.
  const left = [P(0, 0), P(4, 0), P(4, 2), P(4, 2.5), P(4, 6), P(0, 6)];
  const right = [P(4, 0), P(10, 0), P(10, 6), P(4, 6), P(4, 2.5), P(4, 2)];
  const { loops: out, merged } = spaceNodes(loops(left, right), 1.5);
  assert.equal(merged, 1);
  const a = out.get(0)!.outer;
  const b = out.get(1)!.outer;
  assert.equal(a.length, 5);
  assert.equal(b.length, 5);
  // Still sharing the boundary exactly: the two join into one rectangle.
  const whole = unionOfTwo(a, b);
  assert.ok(whole, 'the neighbours still meet');
  assert.equal(area(whole!), area(left) + area(right));
});

test('where three outlines meet is the node that stays', () => {
  // (4, 0) is a joint — three regions meet there — and (4.5, 0) is not.
  const one = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  const two = [P(4, 0), P(4.5, 0), P(9, 0), P(9, 4), P(4, 4)];
  const three = [P(0, -4), P(9, -4), P(9, 0), P(4.5, 0), P(4, 0), P(0, 0)];
  const { loops: out } = spaceNodes(loops(one, two, three), 1);
  const kept = [...out.values()].flatMap((loop) => loop.outer).filter((point) => point.y === 0 && point.x > 3 && point.x < 5);
  assert.ok(kept.every((point) => point.x === 4), JSON.stringify(kept));
});

test('a run of short steps is thinned out, not collapsed into one point', () => {
  // Points a pixel apart along a curve, and a gap of one and a half: every other
  // one goes, and what is left is still the curve.
  const curve = Array.from({ length: 11 }, (_, at) => P(at, Math.round(Math.sqrt(100 - (at - 5) ** 2) * 2) / 2));
  const outer = [...curve, P(10, -5), P(0, -5)];
  const { loops: out } = spaceNodes(loops(outer), 1.5);
  const after = out.get(0)!.outer;
  // Eleven points along the curve thin to about half that; the two corners stay.
  assert.ok(after.length >= 6, `${after.length} points left — the curve collapsed`);
  for (let at = 0; at < after.length; at += 1) {
    const a = after[at]!;
    const b = after[(at + 1) % after.length]!;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 1.5 - 1e-9, `${JSON.stringify(a)} to ${JSON.stringify(b)}`);
  }
});

test('an outline smaller than the gap in every direction is gone', () => {
  const speck = [P(0, 0), P(0.5, 0), P(0.5, 0.5)];
  const big = [P(10, 10), P(20, 10), P(20, 20), P(10, 20)];
  const { loops: out } = spaceNodes(loops(speck, big), 1.5);
  assert.equal(out.has(0), false);
  assert.equal(out.get(1)!.outer.length, 4);
});

test('a gap of nothing changes nothing', () => {
  const input = loops([P(0, 0), P(0.1, 0), P(1, 1)]);
  assert.equal(spaceNodes(input, 0).loops, input);
});

test('a line keeps its ends and loses what crowds them', () => {
  const line = [P(0, 0), P(0.5, 0), P(3, 0), P(3.5, 0), P(6, 0), P(6.4, 0)];
  assert.deepEqual(spacePath(line, 1.5), [P(0, 0), P(3, 0), P(6.4, 0)]);
  assert.deepEqual(spacePath([P(0, 0), P(0.2, 0)], 1.5), [P(0, 0), P(0.2, 0)], 'two points are the least a line can be');
});

test('spacing finished shapes moves shared nodes together and drops a line reduced to a dot', () => {
  const shapes: VectorShape[] = [
    polygon('a', '#ff0000', [0, 0], [4, 0], [4, 2], [4, 2.4], [4, 6], [0, 6]),
    polygon('b', '#0000ff', [4, 0], [10, 0], [10, 6], [4, 6], [4, 2.4], [4, 2]),
    { id: 'l', kind: 'line', color: '#000000', width: 1, points: [P(20, 20), P(20.5, 20)], curved: false, closed: false } satisfies VectorLine,
  ];
  const { shapes: out } = spaceShapes(shapes, 1.5);
  const [a, b] = out as VectorPolygon[];
  assert.ok(unionOfTwo(a!.points, b!.points), 'the two polygons still share their edge exactly');
  assert.equal(out.length, 3, 'a line with two distinct points stays a line');
});

/* ---------------- no polygon smaller than an area ---------------- */

test('a small polygon folds into the neighbour it shares most of its outline with', () => {
  /*
   * A thin wedge between a big red square and a big blue one, touching red along
   * a long side and blue along a short one. It goes to red, takes red's color by
   * becoming part of it, and leaves no hole: the picture's area is unchanged.
   */
  const red = polygon('red', '#ff0000', [0, 0], [10, 0], [10, 10], [0, 10]);
  const blue = polygon('blue', '#0000ff', [10, 0], [20, 0], [20, 10], [11, 10], [10, 10]);
  const wedge = polygon('wedge', '#00ff00', [10, 10], [11, 10], [10, 12], [0, 10]);
  const before = area(red.points) + area(blue.points) + area(wedge.points);
  const { shapes, absorbed, dropped } = absorbSmallPolygons([red, blue, wedge], 12);
  assert.equal(absorbed, 1);
  assert.equal(dropped, 0);
  assert.deepEqual(shapes.map((shape) => shape.id), ['red', 'blue']);
  const after = shapes.reduce((sum, shape) => sum + area(shape.points), 0);
  assert.equal(after, before, 'no hole where the wedge was');
  assert.equal(area(shapes[0]!.points), 100 + area(wedge.points), 'and it is red that grew');
});

test('a small polygon touching nothing is dropped, and a big one is left alone', () => {
  const speck = polygon('speck', '#00ff00', [50, 50], [51, 50], [51, 51]);
  const big = polygon('big', '#ff0000', [0, 0], [10, 0], [10, 10], [0, 10]);
  const { shapes, dropped } = absorbSmallPolygons([big, speck], 6);
  assert.equal(dropped, 1);
  assert.deepEqual(shapes.map((shape) => shape.id), ['big']);
});

test('lines are never folded or dropped by the minimum area', () => {
  const line: VectorLine = { id: 'l', kind: 'line', color: '#000', width: 1, points: [P(0, 0), P(1, 0)], curved: false, closed: false };
  assert.deepEqual(absorbSmallPolygons([line], 100).shapes, [line]);
});

test('a minimum of nothing keeps every polygon', () => {
  const shapes = [polygon('speck', '#00ff00', [0, 0], [0.1, 0], [0.1, 0.1])];
  assert.equal(absorbSmallPolygons(shapes, 0).shapes, shapes);
});
