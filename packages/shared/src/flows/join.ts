import type { VectorLine, VectorPoint, VectorPolygon, VectorShape } from './vector';

/**
 * Joining shapes of one color that touch.
 *
 * The decomposition hands back a region as the convex pieces it was cut into,
 * and a stroke as the runs its middle was traced in. Both are right about the
 * picture and wrong about the drawing: a person looking at a red cheek sees one
 * shape, not seven triangles, and a line that forks is two lines that meet, not
 * three that happen to end in the same place. So once the picture has been
 * measured into shapes, neighbours of the same color are put back together.
 *
 * Two rules, one for each kind of shape:
 *
 * - **Polygons that share a side** and are exactly the same color become one
 *   polygon — unless the one polygon would have to touch itself or have a hole,
 *   which a polygon (a single loop of points) cannot. A ring cut into pieces
 *   therefore comes back as two, not one.
 * - **Lines whose ends are close** and are exactly the same color become one
 *   line. Where three or more ends meet, the pair that carries on straightest is
 *   joined and the rest are left, which is how a fork reads as a line with a
 *   branch rather than as three stubs.
 *
 * "Exactly the same color" is the hex string. Two shapes a shade apart are two
 * things in the picture, and joining them would paint one of them the wrong
 * color.
 */

/* ------------------------------------------------------------------ *
 * Polygons
 * ------------------------------------------------------------------ */

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

/**
 * The same loop, wound the one way every polygon here is wound, with any point
 * repeated back to back dropped.
 *
 * Winding matters because a shared side is found as the same two points in
 * opposite orders. That only holds if both polygons go round the same way.
 */
function normalised(points: VectorPoint[]): VectorPoint[] {
  const clean: VectorPoint[] = [];
  for (const point of points) {
    const last = clean[clean.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) clean.push(point);
  }
  while (clean.length > 1 && key(clean[0]!) === key(clean[clean.length - 1]!)) clean.pop();
  return area(clean) < 0 ? clean.reverse() : clean;
}

/**
 * Two polygons as one, or `null` when they cannot be.
 *
 * Every side of both, less the sides they share — each shared side appears once
 * in each, in opposite directions, and cancels. What is left is the outline of
 * the two together. It is accepted only when it is one simple loop:
 *
 * - no point is left with two ways out, which is the outline touching itself;
 * - and walking it from any side comes back having used every side, because a
 *   second loop left over is a hole.
 *
 * Found on exact coordinates. The decomposition gives neighbours literally the
 * same points along the boundary they share — that is what makes them fit — so
 * there is nothing to round and nothing to match approximately.
 */
export function unionOfTwo(one: VectorPoint[], two: VectorPoint[]): VectorPoint[] | null {
  const a = normalised(one);
  const b = normalised(two);
  if (a.length < 3 || b.length < 3) return null;

  const edges: Array<[VectorPoint, VectorPoint]> = [];
  for (const ring of [a, b]) {
    for (let index = 0; index < ring.length; index += 1) {
      edges.push([ring[index]!, ring[(index + 1) % ring.length]!]);
    }
  }

  const directed = new Map<string, number>();
  for (const [from, to] of edges) {
    const name = `${key(from)}>${key(to)}`;
    directed.set(name, (directed.get(name) ?? 0) + 1);
  }

  let shared = 0;
  const left: Array<[VectorPoint, VectorPoint]> = [];
  for (const [from, to] of edges) {
    const back = `${key(to)}>${key(from)}`;
    if (directed.has(back)) {
      shared += 1;
      continue;
    }
    left.push([from, to]);
  }
  // Nothing in common is nothing to join. Each shared side was counted twice,
  // once from each polygon.
  if (shared === 0 || left.length < 3) return null;

  const next = new Map<string, VectorPoint>();
  for (const [from, to] of left) {
    const name = key(from);
    if (next.has(name)) return null; // touches itself here
    next.set(name, to);
  }

  const start = left[0]![0];
  const loop: VectorPoint[] = [start];
  let at = next.get(key(start));
  while (at && key(at) !== key(start)) {
    loop.push(at);
    if (loop.length > left.length) return null;
    at = next.get(key(at));
  }
  if (!at || loop.length !== left.length) return null; // a hole, or a loose end
  return loop;
}

/**
 * Join every pair of same-color polygons that share a side, as far as joining
 * goes.
 *
 * Greedy: each polygon keeps absorbing a neighbour until none is left that it
 * can absorb. A merged polygon is put back on the list, so a region cut into a
 * fan of pieces is rebuilt one piece at a time. The joined polygon keeps the id
 * of the bigger of the two, so a shape that was the bulk of a region is still
 * the same shape afterwards.
 *
 * Returns the shapes in their original order — a joined polygon takes the place
 * of the first of its parts — with how many joins were made.
 */
export function joinPolygons(shapes: VectorShape[]): { shapes: VectorShape[]; joined: number } {
  interface Live {
    polygon: VectorPolygon;
    points: VectorPoint[];
    order: number;
    alive: boolean;
  }

  const live: Live[] = [];
  const owner = new Map<string, Live>();
  const sides = (entry: Live) =>
    entry.points.map((point, index) => `${key(point)}>${key(entry.points[(index + 1) % entry.points.length]!)}`);
  const claim = (entry: Live) => {
    for (const side of sides(entry)) owner.set(side, entry);
  };
  const release = (entry: Live) => {
    for (const side of sides(entry)) if (owner.get(side) === entry) owner.delete(side);
  };

  shapes.forEach((shape, order) => {
    if (shape.kind !== 'polygon') return;
    const points = normalised(shape.points);
    if (points.length < 3) return;
    const entry: Live = { polygon: shape, points, order, alive: true };
    live.push(entry);
    claim(entry);
  });

  let joined = 0;
  const queue = [...live];
  while (queue.length > 0) {
    const entry = queue.pop()!;
    if (!entry.alive) continue;

    let merged: Live | null = null;
    for (let index = 0; index < entry.points.length && !merged; index += 1) {
      const from = entry.points[index]!;
      const to = entry.points[(index + 1) % entry.points.length]!;
      const other = owner.get(`${key(to)}>${key(from)}`);
      if (!other || other === entry || !other.alive) continue;
      if (other.polygon.color !== entry.polygon.color) continue;

      const points = unionOfTwo(entry.points, other.points);
      if (!points) continue;

      const bigger =
        Math.abs(area(entry.points)) >= Math.abs(area(other.points)) ? entry.polygon : other.polygon;
      release(entry);
      release(other);
      entry.alive = false;
      other.alive = false;
      merged = {
        polygon: { ...bigger, points },
        points,
        order: Math.min(entry.order, other.order),
        alive: true,
      };
    }

    if (merged) {
      joined += 1;
      live.push(merged);
      claim(merged);
      queue.push(merged);
    }
  }

  const byOrder = new Map<number, VectorPolygon>();
  for (const entry of live) if (entry.alive) byOrder.set(entry.order, { ...entry.polygon, points: entry.points });

  const out: VectorShape[] = [];
  shapes.forEach((shape, order) => {
    if (shape.kind !== 'polygon') {
      out.push(shape);
      return;
    }
    const polygon = byOrder.get(order);
    if (polygon) out.push(polygon);
    // A polygon too degenerate to have been considered is kept as it was, not lost.
    else if (normalised(shape.points).length < 3) out.push(shape);
  });
  return { shapes: out, joined };
}

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

type End = 'start' | 'end';

function endPoint(line: VectorLine, end: End): VectorPoint {
  return end === 'start' ? line.points[0]! : line.points[line.points.length - 1]!;
}

/** Which way a line is heading as it leaves by this end, as a unit vector. */
function outward(line: VectorLine, end: End): VectorPoint {
  const points = line.points;
  const tip = endPoint(line, end);
  // Looked at from a little way back rather than from the last segment alone,
  // which can be a stub a pixel long pointing anywhere.
  let back = tip;
  const walk = end === 'start' ? points : [...points].reverse();
  for (const point of walk) {
    back = point;
    if (Math.hypot(point.x - tip.x, point.y - tip.y) >= 3) break;
  }
  const dx = tip.x - back.x;
  const dy = tip.y - back.y;
  const length = Math.hypot(dx, dy);
  return length < 1e-9 ? { x: 0, y: 0 } : { x: dx / length, y: dy / length };
}

function lengthOf(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
  }
  return total;
}

/**
 * Join same-color lines whose ends are within `gap` of each other.
 *
 * Every pair of close ends is a candidate. They are taken straightest first —
 * the angle between one line leaving and the other arriving — so that where a
 * stroke forks, the two runs that carry on through the fork are the ones joined.
 * Each end is used once, and a join that would bring a chain back round to its
 * own other end is skipped: that would be a loop, and closing one is a different
 * decision from joining two lines.
 *
 * Where two ends meet, the joined line has one point halfway between them, so
 * neither line is favoured and the gap that separated them is drawn.
 */
export function joinLines(
  shapes: VectorShape[],
  gap: number,
): { shapes: VectorShape[]; joined: number } {
  if (!(gap >= 0)) return { shapes, joined: 0 };

  const lines: Array<{ line: VectorLine; order: number }> = [];
  shapes.forEach((shape, order) => {
    if (shape.kind === 'line' && !shape.closed && shape.points.length >= 2) lines.push({ line: shape, order });
  });

  interface Candidate {
    one: number;
    oneEnd: End;
    two: number;
    twoEnd: End;
    turn: number;
    distance: number;
  }
  const candidates: Candidate[] = [];
  for (let one = 0; one < lines.length; one += 1) {
    for (let two = one + 1; two < lines.length; two += 1) {
      const a = lines[one]!.line;
      const b = lines[two]!.line;
      if (a.color !== b.color) continue;
      for (const oneEnd of ['start', 'end'] as const) {
        for (const twoEnd of ['start', 'end'] as const) {
          const p = endPoint(a, oneEnd);
          const q = endPoint(b, twoEnd);
          const distance = Math.hypot(p.x - q.x, p.y - q.y);
          if (distance > gap) continue;
          // Carrying straight on, one line leaves the way the other arrives:
          // their outward directions point in opposite directions.
          const u = outward(a, oneEnd);
          const v = outward(b, twoEnd);
          const turn = Math.acos(Math.max(-1, Math.min(1, -(u.x * v.x + u.y * v.y))));
          candidates.push({ one, oneEnd, two, twoEnd, turn, distance });
        }
      }
    }
  }
  if (candidates.length === 0) return { shapes, joined: 0 };
  candidates.sort((x, y) => x.turn - y.turn || x.distance - y.distance);

  // Union-find over lines, so a join that would close a chain on itself is seen.
  const parent = lines.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const link = new Map<string, { line: number; end: End }>();
  const endKey = (line: number, end: End) => `${line}:${end}`;

  let joined = 0;
  for (const candidate of candidates) {
    const a = endKey(candidate.one, candidate.oneEnd);
    const b = endKey(candidate.two, candidate.twoEnd);
    if (link.has(a) || link.has(b)) continue;
    if (root(candidate.one) === root(candidate.two)) continue;
    link.set(a, { line: candidate.two, end: candidate.twoEnd });
    link.set(b, { line: candidate.one, end: candidate.oneEnd });
    parent[root(candidate.one)] = root(candidate.two);
    joined += 1;
  }
  if (joined === 0) return { shapes, joined: 0 };

  /*
   * Walk each chain from a free end to the other free end.
   *
   * Every chain has exactly two free ends, because a join never closes one. Each
   * line is entered by one end and left by the other, so it is added forwards or
   * backwards according to which end it was entered by.
   */
  const used = new Set<number>();
  const chains = new Map<number, VectorLine>();
  for (let first = 0; first < lines.length; first += 1) {
    if (used.has(first)) continue;
    let entry: End | null = null;
    if (!link.has(endKey(first, 'start'))) entry = 'start';
    else if (!link.has(endKey(first, 'end'))) entry = 'end';
    if (!entry) continue;

    const parts: Array<{ line: VectorLine; points: VectorPoint[] }> = [];
    let at: number | undefined = first;
    let enteredBy: End = entry;
    while (at !== undefined && !used.has(at)) {
      used.add(at);
      const line = lines[at]!.line;
      const points = enteredBy === 'start' ? [...line.points] : [...line.points].reverse();
      parts.push({ line, points });
      const leaving: End = enteredBy === 'start' ? 'end' : 'start';
      const next = link.get(endKey(at, leaving));
      at = next?.line;
      enteredBy = next?.end ?? 'start';
    }
    if (parts.length < 2) continue;

    const points: VectorPoint[] = [...parts[0]!.points];
    for (const part of parts.slice(1)) {
      const last = points.pop()!;
      const [head, ...rest] = part.points;
      points.push({ x: (last.x + head!.x) / 2, y: (last.y + head!.y) / 2 }, ...rest);
    }

    // The width the pieces had, weighted by how much of the line each is.
    let weighted = 0;
    let total = 0;
    for (const part of parts) {
      const length = Math.max(1e-6, lengthOf(part.points));
      weighted += part.line.width * length;
      total += length;
    }
    const longest = parts.reduce((best, part) =>
      lengthOf(part.points) > lengthOf(best.points) ? part : best,
    );
    chains.set(lines[first]!.order, {
      ...longest.line,
      points,
      width: Math.round((weighted / total) * 10) / 10,
      // Smoothed if any part of it was. A curve joined to a short straight stub is
      // still a curve, and drawing it corner to corner would put a kink in it.
      curved: parts.some((part) => part.line.curved),
      closed: false,
    });
  }

  // Every line that was joined to anything is now part of a chain, drawn once, in
  // the place of the line its chain was walked from.
  const partOfChain = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (link.has(endKey(index, 'start')) || link.has(endKey(index, 'end'))) partOfChain.add(lines[index]!.order);
  }

  const out: VectorShape[] = [];
  shapes.forEach((shape, order) => {
    const chain = chains.get(order);
    if (chain) out.push(chain);
    else if (!partOfChain.has(order)) out.push(shape);
  });
  return { shapes: out, joined };
}
