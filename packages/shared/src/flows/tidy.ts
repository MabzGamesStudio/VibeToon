import type { RegionLoops } from './arcs';
import { unionOfRegions, withRings, type Rings } from './join';
import type { VectorPoint, VectorPolygon, VectorShape } from './vector';

/**
 * The minimums: no two nodes closer than a distance, no polygon smaller than an
 * area. Applied to a decomposition after it has been traced and simplified, and
 * written so that neither can open a gap in the picture or overlap two shapes.
 */

const key = (point: VectorPoint): string => `${point.x},${point.y}`;

function area(points: VectorPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** A loop without points repeated back to back, the wrap included. */
function dedupe(points: VectorPoint[]): VectorPoint[] {
  const out: VectorPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) out.push(point);
  }
  while (out.length > 1 && out[0]!.x === out[out.length - 1]!.x && out[0]!.y === out[out.length - 1]!.y) out.pop();
  return out;
}

/* ------------------------------------------------------------------ *
 * No two nodes closer than a distance
 * ------------------------------------------------------------------ */

/**
 * Merge nodes closer than `gap` along any outline into one.
 *
 * Every region's outline goes through the same points as its neighbours' where
 * they meet — that is what keeps the shapes from overlapping — so the merge is
 * decided on the nodes, not on any one outline: where two nodes become one, they
 * become one in every outline that has them, and neighbours still meet exactly.
 *
 * Shortest edges first, each merge kept only while the merged node stays within
 * `gap` of every node it took in — otherwise a curve drawn as a run of short
 * steps would collapse into one point instead of being thinned out. So two nodes
 * can end up closer than the gap where merging them would have moved some other
 * node further than it: the minimum is kept as far as it can be without moving
 * anything more than the gap. A node where three or more outlines meet is the
 * one kept when it merges with a node that is not, because it is where the
 * picture's regions come together and moving it moves all of them.
 *
 * An outline left with fewer than three points is gone — it was smaller than the
 * gap in every direction, and its neighbours closed over it as their own nodes
 * merged.
 */
export function spaceNodes(
  loops: Map<number, RegionLoops>,
  gap: number,
): { loops: Map<number, RegionLoops>; merged: number } {
  if (!(gap > 0)) return { loops, merged: 0 };

  const index = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const neighbours: Array<Set<number>> = [];
  const nodeOf = (point: VectorPoint): number => {
    const name = key(point);
    let at = index.get(name);
    if (at === undefined) {
      at = xs.length;
      index.set(name, at);
      xs.push(point.x);
      ys.push(point.y);
      neighbours.push(new Set());
    }
    return at;
  };

  const edges: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  const every = [...loops.values()].flatMap((loop) => [loop.outer, ...loop.holes]);
  for (const ring of every) {
    for (let at = 0; at < ring.length; at += 1) {
      const a = nodeOf(ring[at]!);
      const b = nodeOf(ring[(at + 1) % ring.length]!);
      if (a === b) continue;
      neighbours[a]!.add(b);
      neighbours[b]!.add(a);
      const name = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(name)) continue;
      seen.add(name);
      edges.push([Math.hypot(xs[a]! - xs[b]!, ys[a]! - ys[b]!), Math.min(a, b), Math.max(a, b)]);
    }
  }
  edges.sort((one, two) => one[0] - two[0] || one[1] - two[1] || one[2] - two[2]);

  const parent = xs.map((_, at) => at);
  const members: number[][] = xs.map((_, at) => [at]);
  const root = (at: number): number => {
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  // Where outlines come together: a node with three or more neighbours.
  const joint = (at: number) => neighbours[at]!.size >= 3;

  /** Whether every node of both groups is within the gap of this one. */
  const holds = (keep: number, one: number, two: number) =>
    [...members[one]!, ...members[two]!].every((at) => Math.hypot(xs[at]! - xs[keep]!, ys[at]! - ys[keep]!) < gap);

  let merged = 0;
  /*
   * In passes, because a merge can bring two groups within reach of each other
   * that were not before. Each pass walks the outline edges shortest first and
   * joins the groups at their ends if one of the two kept nodes can hold every
   * node of both within the gap — trying the other way round when the first
   * cannot, except that a joint is never the one that moves.
   */
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const [, a, b] of edges) {
      const one = root(a);
      const two = root(b);
      if (one === two) continue;
      if (Math.hypot(xs[one]! - xs[two]!, ys[one]! - ys[two]!) >= gap) continue;
      const choices =
        joint(one) && !joint(two) ? [one] : joint(two) && !joint(one) ? [two] : [Math.min(one, two), Math.max(one, two)];
      const keep = choices.find((candidate) => holds(candidate, one, two));
      if (keep === undefined) continue;
      const lose = keep === one ? two : one;
      parent[lose] = keep;
      members[keep]!.push(...members[lose]!);
      members[lose] = [];
      merged += 1;
      changed = true;
    }
    if (!changed) break;
  }
  if (merged === 0) return { loops, merged };

  const moved = (point: VectorPoint): VectorPoint => {
    const at = root(index.get(key(point))!);
    return xs[at] === point.x && ys[at] === point.y ? point : { x: xs[at]!, y: ys[at]! };
  };
  const out = new Map<number, RegionLoops>();
  for (const [id, loop] of loops) {
    const outer = dedupe(loop.outer.map(moved));
    if (outer.length < 3 || Math.abs(area(outer)) < 1e-9) continue;
    const holes = loop.holes
      .map((hole) => dedupe(hole.map(moved)))
      .filter((hole) => hole.length >= 3 && Math.abs(area(hole)) >= 1e-9);
    out.set(id, { outer, holes });
  }
  return { loops: out, merged };
}

/**
 * The same along a single path: a point closer than `gap` to the last one kept
 * is dropped. The ends are always kept — they are where the path meets whatever
 * it meets — so the last point in from the end goes instead if it crowds it.
 */
export function spacePath(points: VectorPoint[], gap: number): VectorPoint[] {
  if (!(gap > 0) || points.length <= 2) return points;
  const kept: VectorPoint[] = [points[0]!];
  for (const point of points.slice(1, -1)) {
    const last = kept[kept.length - 1]!;
    if (Math.hypot(point.x - last.x, point.y - last.y) >= gap) kept.push(point);
  }
  const end = points[points.length - 1]!;
  const last = kept[kept.length - 1]!;
  if (kept.length > 1 && Math.hypot(end.x - last.x, end.y - last.y) < gap) kept.pop();
  kept.push(end);
  return kept;
}

/**
 * The minimum distance, applied to finished shapes.
 *
 * Polygons are spaced together, as the loops they are — they share nodes where
 * they meet, and the merge has to move those for all of them at once. A polygon
 * whose every node merged into two or fewer is dropped: it was smaller than the
 * gap in every direction, and its neighbours' shared nodes merged over it. Lines
 * are spaced along their own length, ends kept; a line of one point is dropped.
 */
export function spaceShapes(
  shapes: VectorShape[],
  gap: number,
): { shapes: VectorShape[]; merged: number } {
  if (!(gap > 0)) return { shapes, merged: 0 };
  const loops = new Map<number, RegionLoops>();
  shapes.forEach((shape, order) => {
    if (shape.kind === 'polygon') loops.set(order, { outer: shape.points, holes: shape.holes ?? [] });
  });
  const spaced = spaceNodes(loops, gap);
  let merged = spaced.merged;
  const out: VectorShape[] = [];
  shapes.forEach((shape, order) => {
    if (shape.kind === 'polygon') {
      const loop = spaced.loops.get(order);
      if (!loop) return;
      out.push(loop === loops.get(order) ? shape : withRings(shape, loop));
      return;
    }
    const points = spacePath(shape.points, gap);
    merged += shape.points.length - points.length;
    if (points.length >= 2 && !(points.length === 2 && points[0]!.x === points[1]!.x && points[0]!.y === points[1]!.y)) {
      out.push(points === shape.points ? shape : { ...shape, points });
    }
  });
  return { shapes: out, merged };
}

/* ------------------------------------------------------------------ *
 * No polygon smaller than an area
 * ------------------------------------------------------------------ */

/**
 * Fold polygons smaller than `minArea` into a neighbour.
 *
 * Into the neighbour they share the most outline with, whatever its color, which
 * takes the small one's place in the picture — the shapes still tile it, with no
 * hole where the small one was. A small polygon sitting in a hole of a bigger one
 * closes that hole. Smallest first, so a crumb between two others goes before
 * either of them is judged. A small polygon that touches no other polygon at all
 * is dropped: there is nothing to fold it into, and a speck on its own is what
 * this setting is for.
 *
 * A fold that would leave the neighbour touching itself or in two pieces is not
 * made (see `unionOfRegions`), and the next neighbour is tried; one that fits
 * none is left as it is. Size is the area actually covered: outline less holes.
 */
export function absorbSmallPolygons(
  shapes: VectorShape[],
  minArea: number,
): { shapes: VectorShape[]; absorbed: number; dropped: number } {
  if (!(minArea > 0)) return { shapes, absorbed: 0, dropped: 0 };

  interface Live {
    shape: VectorPolygon;
    rings: Rings;
    order: number;
    alive: boolean;
    changed: boolean;
  }
  const wound = (points: VectorPoint[], sign: 1 | -1) => {
    const clean = dedupe(points);
    return area(clean) * sign >= 0 ? clean : [...clean].reverse();
  };
  const covered = (rings: Rings) =>
    Math.abs(area(rings.outer)) - rings.holes.reduce((sum, hole) => sum + Math.abs(area(hole)), 0);
  const live: Live[] = [];
  shapes.forEach((shape, order) => {
    if (shape.kind !== 'polygon') return;
    const rings = { outer: wound(shape.points, 1), holes: (shape.holes ?? []).map((hole) => wound(hole, -1)) };
    live.push({ shape, rings, order, alive: true, changed: false });
  });

  const owner = new Map<string, Live>();
  const sides = (rings: Rings) =>
    [rings.outer, ...rings.holes].flatMap((ring) =>
      ring.map((point, at) => [point, ring[(at + 1) % ring.length]!] as const),
    );
  const name = (from: VectorPoint, to: VectorPoint) => `${key(from)}>${key(to)}`;
  const claim = (entry: Live) => {
    for (const [from, to] of sides(entry.rings)) owner.set(name(from, to), entry);
  };
  const release = (entry: Live) => {
    for (const [from, to] of sides(entry.rings)) if (owner.get(name(from, to)) === entry) owner.delete(name(from, to));
  };
  for (const entry of live) claim(entry);

  let absorbed = 0;
  let dropped = 0;
  const small = live
    .filter((entry) => covered(entry.rings) < minArea)
    .sort((one, two) => covered(one.rings) - covered(two.rings) || one.order - two.order);

  for (const entry of small) {
    if (!entry.alive || covered(entry.rings) >= minArea) continue;

    // Who it shares outline with, and how much.
    const shared = new Map<Live, number>();
    for (const [from, to] of sides(entry.rings)) {
      const other = owner.get(name(to, from));
      if (!other || other === entry || !other.alive) continue;
      shared.set(other, (shared.get(other) ?? 0) + Math.hypot(to.x - from.x, to.y - from.y));
    }

    if (shared.size === 0) {
      entry.alive = false;
      release(entry);
      dropped += 1;
      continue;
    }

    const ranked = [...shared].sort((one, two) => two[1] - one[1] || one[0].order - two[0].order);
    for (const [host] of ranked) {
      const rings = unionOfRegions(host.rings, entry.rings);
      if (!rings) continue;
      release(host);
      release(entry);
      host.rings = rings;
      host.changed = true;
      entry.alive = false;
      claim(host);
      absorbed += 1;
      break;
    }
  }

  if (absorbed === 0 && dropped === 0) return { shapes, absorbed, dropped };
  const byOrder = new Map(live.map((entry) => [entry.order, entry]));
  const out: VectorShape[] = [];
  shapes.forEach((shape, order) => {
    const entry = byOrder.get(order);
    if (!entry) out.push(shape);
    else if (entry.alive) out.push(entry.changed ? withRings(entry.shape, entry.rings) : entry.shape);
  });
  return { shapes: out, absorbed, dropped };
}
