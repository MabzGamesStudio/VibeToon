import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuadIndex } from '../src/flows/spatial';
import { bridgeHoles, earClip, signedArea } from '../src/flows/vectorize';
import type { VectorPoint } from '../src/flows/vector';

function random(seed: number) {
  let state = seed;
  return () => ((state = (state * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;
}

/* ---------------- the index ---------------- */

test('the quadtree finds exactly what a search of everything finds', () => {
  const rand = random(3);
  const index = new QuadIndex({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 4);
  const boxes = new Map<number, [number, number, number, number]>();
  for (let id = 0; id < 600; id += 1) {
    const x = rand() * 100;
    const y = rand() * 100;
    // Mostly points and short edges, some long ones that straddle cells.
    const w = rand() < 0.1 ? rand() * 60 : rand() * 3;
    const h = rand() < 0.1 ? rand() * 60 : rand() * 3;
    const box: [number, number, number, number] = [x, y, Math.min(100, x + w), Math.min(100, y + h)];
    boxes.set(id, box);
    index.insert(id, ...box);
  }
  for (let id = 0; id < 600; id += 7) {
    index.remove(id);
    boxes.delete(id);
  }
  for (let query = 0; query < 200; query += 1) {
    const x = rand() * 100;
    const y = rand() * 100;
    const q: [number, number, number, number] = [x, y, x + rand() * 30, y + rand() * 30];
    const found: number[] = [];
    index.query(...q, (id) => found.push(id));
    const expected = [...boxes]
      .filter(([, b]) => !(b[0] > q[2] || b[2] < q[0] || b[1] > q[3] || b[3] < q[1]))
      .map(([id]) => id);
    assert.deepEqual(found.sort((a, b) => a - b), expected.sort((a, b) => a - b), `query ${query}`);
  }
});

test('moving something in the index is putting it somewhere else, not twice', () => {
  const index = new QuadIndex({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  index.insert(1, 1, 1, 1, 1);
  index.insert(1, 8, 8, 8, 8);
  const near: number[] = [];
  index.query(0, 0, 2, 2, (id) => near.push(id));
  assert.equal(near.length, 0, 'gone from where it was');
  index.query(7, 7, 9, 9, (id) => near.push(id));
  assert.deepEqual(near, [1]);
});

/* ---------------- the clipping it made fast ---------------- */

/*
 * The ear clipping and hole bridging as they were before they were indexed:
 * every corner against every other and every edge, every round, and every pair
 * sorted. Slow and plainly right, which is what makes it the reference.
 */
const same = (a: VectorPoint, b: VectorPoint) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

function strictlyInside(point: VectorPoint, a: VectorPoint, b: VectorPoint, c: VectorPoint): boolean {
  const side = (p: VectorPoint, q: VectorPoint, r: VectorPoint) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const one = side(point, a, b);
  const two = side(point, b, c);
  const three = side(point, c, a);
  if (one === 0 || two === 0 || three === 0) return false;
  return one > 0 === two > 0 && two > 0 === three > 0;
}

function segmentsCross(a: VectorPoint, b: VectorPoint, c: VectorPoint, d: VectorPoint): boolean {
  const side = (p: VectorPoint, q: VectorPoint, r: VectorPoint) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const one = side(a, b, c);
  const two = side(a, b, d);
  const three = side(c, d, a);
  const four = side(c, d, b);
  return one !== two && three !== four && one !== 0 && two !== 0 && three !== 0 && four !== 0;
}

function insideRing(point: VectorPoint, ring: VectorPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if (a.y > point.y === b.y > point.y) continue;
    if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function squareness(a: VectorPoint, b: VectorPoint, c: VectorPoint): number {
  const sides = [Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y), Math.hypot(a.x - c.x, a.y - c.y)];
  const longest = Math.max(...sides);
  if (longest < 1e-9) return 0;
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  return (2 * area) / longest / longest;
}

function slowEarClip(points: VectorPoint[]): number[][] {
  const winding = signedArea(points) > 0 ? 1 : -1;
  const remaining = points.map((_, index) => index);
  const out: number[][] = [];
  let guard = 0;
  while (remaining.length > 3 && guard < points.length * points.length + 64) {
    guard += 1;
    const count = remaining.length;
    let clipped = -1;
    let fattest = -1;
    for (let index = 0; index < count; index += 1) {
      const before = (index - 1 + count) % count;
      const after = (index + 1) % count;
      const previous = points[remaining[before]!]!;
      const ear = points[remaining[index]!]!;
      const next = points[remaining[after]!]!;
      if (same(previous, next)) continue;
      const turn = (ear.x - previous.x) * (next.y - ear.y) - (ear.y - previous.y) * (next.x - ear.x);
      if (turn * winding <= 0) continue;
      let blocked = false;
      for (let other = 0; other < count && !blocked; other += 1) {
        if (other === index || other === before || other === after) continue;
        if (strictlyInside(points[remaining[other]!]!, previous, ear, next)) blocked = true;
      }
      for (let edge = 0; edge < count && !blocked; edge += 1) {
        const to = (edge + 1) % count;
        if (edge === before || to === before || edge === after || to === after || edge === index || to === index) continue;
        if (segmentsCross(previous, next, points[remaining[edge]!]!, points[remaining[to]!]!)) blocked = true;
      }
      if (blocked) continue;
      const middle = { x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 };
      if (!insideRing(middle, remaining.map((at) => points[at]!))) continue;
      const quality = squareness(previous, ear, next);
      if (quality > fattest) {
        fattest = quality;
        clipped = index;
      }
    }
    if (clipped >= 0) {
      out.push([remaining[(clipped - 1 + count) % count]!, remaining[clipped]!, remaining[(clipped + 1) % count]!]);
    }
    if (clipped < 0) {
      for (let index = 0; index < count && clipped < 0; index += 1) {
        const previous = points[remaining[(index - 1 + count) % count]!]!;
        const ear = points[remaining[index]!]!;
        const next = points[remaining[(index + 1) % count]!]!;
        const turn = (ear.x - previous.x) * (next.y - ear.y) - (ear.y - previous.y) * (next.x - ear.x);
        if (Math.abs(turn) < 1e-9) clipped = index;
      }
    }
    if (clipped < 0) break;
    remaining.splice(clipped, 1);
  }
  if (remaining.length === 3) out.push([...remaining]);
  return out;
}

function crossesAny(a: VectorPoint, b: VectorPoint, ring: VectorPoint[]): boolean {
  for (let index = 0; index < ring.length; index += 1) {
    const c = ring[index]!;
    const d = ring[(index + 1) % ring.length]!;
    if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) continue;
    if (segmentsCross(a, b, c, d)) return true;
  }
  return false;
}

function slowBridgeHoles(outer: VectorPoint[], holes: VectorPoint[][]): VectorPoint[] {
  const facing = signedArea(outer) > 0 ? 1 : -1;
  const pending = holes
    .map((hole) => (signedArea(hole) * facing > 0 ? [...hole].reverse() : [...hole]))
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  let ring = [...outer];
  for (const hole of pending) {
    const pairs: Array<[number, number, number]> = [];
    for (let at = 0; at < ring.length; at += 1) {
      for (let from = 0; from < hole.length; from += 1) {
        pairs.push([at, from, Math.hypot(ring[at]!.x - hole[from]!.x, ring[at]!.y - hole[from]!.y)]);
      }
    }
    pairs.sort((a, b) => a[2] - b[2]);
    let bridge: [number, number] | null = null;
    for (const [at, from] of pairs) {
      const a = ring[at]!;
      const b = hole[from]!;
      if (crossesAny(a, b, ring) || crossesAny(a, b, hole)) continue;
      if (pending.some((other) => other !== hole && crossesAny(a, b, other))) continue;
      bridge = [at, from];
      break;
    }
    if (!bridge) continue;
    const [at, from] = bridge;
    ring = [...ring.slice(0, at + 1), ...hole.slice(from), ...hole.slice(0, from + 1), ring[at]!, ...ring.slice(at + 1)];
  }
  return ring;
}

/** A star-shaped outline — always simple — on half-pixel steps, so ties and straight runs happen. */
function star(rand: () => number, n: number, cx: number, cy: number, r: number, jitter: number): VectorPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const radius = r * (1 - jitter + jitter * 2 * rand());
    return { x: Math.round((cx + Math.cos(t) * radius) * 2) / 2, y: Math.round((cy + Math.sin(t) * radius) * 2) / 2 };
  });
}

test('indexed ear clipping cuts every outline exactly as testing everything did', () => {
  const rand = random(11);
  for (let trial = 0; trial < 150; trial += 1) {
    let outline = star(rand, 4 + Math.floor(rand() * 50), 100, 100, 80, 0.2 + rand() * 0.5);
    if (rand() < 0.5) outline.reverse();
    if (trial % 3 === 0) {
      // With a hole bridged in: the slit puts points in the list twice.
      const hole = star(rand, 3 + Math.floor(rand() * 10), 100 + (rand() - 0.5) * 30, 100 + (rand() - 0.5) * 30, 12, 0.3);
      outline = slowBridgeHoles(outline, [hole]);
    }
    assert.deepEqual(earClip(outline), slowEarClip(outline), `trial ${trial}, ${outline.length} corners`);
  }
});

test('indexed hole bridging picks exactly the cuts that sorting every pair did', () => {
  const rand = random(29);
  for (let trial = 0; trial < 60; trial += 1) {
    const outer = star(rand, 12 + Math.floor(rand() * 40), 100, 100, 90, 0.15);
    const holes = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, index) =>
      star(rand, 3 + Math.floor(rand() * 8), 70 + index * 20, 80 + (rand() - 0.5) * 40, 6, 0.3),
    );
    assert.deepEqual(bridgeHoles(outer, holes), slowBridgeHoles(outer, holes), `trial ${trial}`);
  }
});

test('a long outline is clipped in a moment rather than a minute', () => {
  // 800 corners took 70 seconds tested against everything; indexed, well under one.
  const outline = star(random(5), 800, 500, 500, 400, 0.45);
  const started = performance.now();
  const triangles = earClip(outline);
  assert.equal(triangles.length, outline.length - 2, 'a whole triangulation');
  assert.ok(performance.now() - started < 3000, `${(performance.now() - started).toFixed(0)} ms`);
});
