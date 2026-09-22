import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTSIDE, traceShared } from '../src/flows/arcs';
import { simplify } from '../src/flows/vectorize';
import type { VectorPoint } from '../src/flows/vector';

/** A labelled picture from a character map. `.` is transparent. */
function labelled(rows: string[]): { labels: Int32Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]!.length;
  const labels = new Int32Array(width * height);
  const seen: Record<string, number> = { '.': -1 };
  let next = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const character = rows[y]![x]!;
      if (!(character in seen)) seen[character] = next++;
      labels[y * width + x] = seen[character]!;
    }
  }
  return { labels, width, height };
}

const asIs = (points: VectorPoint[]) => points;
const trace = (rows: string[], reduce = asIs) => {
  const { labels, width, height } = labelled(rows);
  return traceShared(labels, width, height, reduce);
};
const at = (points: VectorPoint[]) => points.map((point) => `${point.x},${point.y}`);

test('a plain block is traced as its corners', () => {
  const found = trace(['AA', 'AA']);
  assert.equal(found.size, 1);
  assert.deepEqual(at(found.get(0)!.outer), ['0,0', '1,0', '2,0', '2,1', '2,2', '1,2', '0,2', '0,1']);
  assert.deepEqual(found.get(0)!.holes, []);
});

test('two regions meeting along a boundary hold the very same points', () => {
  /*
   * The whole reason boundaries are traced once and shared. Simplified
   * separately, each side moves the boundary by up to the tolerance in whatever
   * direction its own corners want — which leaves a sliver of overlap down one
   * side of it and a sliver of gap down the other, and the drawing only looks
   * right because the shapes are painted in an order that hides the seams.
   */
  const found = trace(['AB', 'AB']);
  const left = at(found.get(0)!.outer);
  const right = at(found.get(1)!.outer);

  const shared = ['1,0', '1,1', '1,2'];
  for (const point of shared) {
    assert.ok(left.includes(point), `the left shape is missing ${point}`);
    assert.ok(right.includes(point), `the right shape is missing ${point}`);
  }
  // And in opposite directions, which is what makes them meet rather than stack.
  const steps = (ring: string[]) =>
    ring.map((point, index) => `${point} → ${ring[(index + 1) % ring.length]}`);
  assert.ok(steps(left).includes('1,0 → 1,1'), `the left shape walks ${steps(left).join(', ')}`);
  assert.ok(steps(right).includes('1,1 → 1,0'), `the right shape walks ${steps(right).join(', ')}`);
});

test('a boundary is simplified once, so both sides get the same simplification', () => {
  // A staircase between two regions: loose enough that simplifying it has
  // something to do.
  const found = trace(
    ['AAAABBBB', 'AAABBBBB', 'AABBBBBB', 'ABBBBBBB'],
    (points) => simplify(points, 2),
  );
  const left = at(found.get(0)!.outer);
  const right = at(found.get(1)!.outer);

  // Every point on the shared diagonal is in both lists, or one of them has
  // moved the boundary somewhere the other did not.
  const onDiagonal = left.filter((point) => right.includes(point));
  assert.ok(onDiagonal.length >= 2, `only ${onDiagonal.length} point(s) are shared`);
  for (const point of left) {
    const [x, y] = point.split(',').map(Number) as [number, number];
    const diagonal = x + y === 4 || x + y === 8;
    if (diagonal) assert.ok(right.includes(point), `${point} is on the boundary but only one side has it`);
  }
});

test('a hole is a hole, not a filled middle', () => {
  const found = trace(['AAA', 'ABA', 'AAA']);
  const ring = found.get(0)!;
  assert.equal(ring.holes.length, 1);
  assert.deepEqual(at(ring.holes[0]!).sort(), ['1,1', '1,2', '2,1', '2,2']);
  // The hole winds against the outside, which is what lets it be cut out.
  assert.ok(area(ring.outer) * area(ring.holes[0]!) < 0, 'the hole winds the same way as the outside');
});

test('transparency in the middle of a shape is a hole too', () => {
  const found = trace(['AAA', 'A.A', 'AAA']);
  assert.equal(found.size, 1, 'transparency is not a region');
  assert.equal(found.get(0)!.holes.length, 1);
});

test('a picture of nothing has no regions', () => {
  assert.equal(trace(['..', '..']).size, 0);
});

test('a junction where three regions meet belongs to all of them', () => {
  const found = trace(['AABB', 'AABB', 'CCDD', 'CCDD']);
  assert.equal(found.size, 4);
  for (const [, loops] of found) {
    assert.ok(at(loops.outer).includes('2,2'), 'a shape is missing the point where they all meet');
  }
});

test('the edge of the picture bounds a region, and the outside is not one', () => {
  const found = trace(['AA', 'AA']);
  assert.equal(found.has(OUTSIDE), false);
  assert.deepEqual(
    at(found.get(0)!.outer).filter((point) => point === '0,0'),
    ['0,0'],
    'the corner of the picture appears once',
  );
});

function area(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}
