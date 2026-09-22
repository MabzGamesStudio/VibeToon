import type { VectorPoint } from './vector';

/**
 * Region boundaries, traced once and shared.
 *
 * Every earlier version traced each region's outline on its own and then
 * simplified it on its own, which cannot give a drawing whose shapes fit
 * together. Two regions meeting along a boundary each moved it by up to the
 * tolerance, in whatever direction their own corners happened to want — so
 * between any two shapes there was a sliver of overlap on one side of the
 * boundary and a sliver of gap on the other, and the drawing only looked right
 * because the shapes were painted in an order that hid the seams under each
 * other.
 *
 * Here the picture's boundaries are cut into **arcs** — runs from one junction,
 * where three or more regions meet, to the next — and each arc is simplified
 * exactly once. Both regions either side of it then use the same points, in
 * opposite directions. They cannot overlap, because the shared edge is literally
 * the same list of numbers; they cannot gap, for the same reason; and the whole
 * picture costs fewer points than before, because a boundary that used to be
 * simplified twice is now simplified once.
 */

/** Beyond the edge of the picture. Distinct from transparency, which is `-1`. */
export const OUTSIDE = -3;

/** One region's boundary: the loop round the outside, and the loops round its holes. */
export interface RegionLoops {
  outer: VectorPoint[];
  holes: VectorPoint[][];
}

interface Arc {
  /** Corner-lattice nodes, in order, as traced. */
  nodes: number[];
  /** The same run after simplifying, which is what a region actually uses. */
  simple: VectorPoint[];
  /** A loop with no junction on it anywhere, so it has no ends to join at. */
  closed: boolean;
}

/**
 * Trace every region in a labelled picture, sharing and simplifying the
 * boundaries between them.
 *
 * `reduce` is handed each arc and gives back the points to keep. It is passed in
 * rather than fixed here because what "simplify" means — a tolerance, a budget,
 * both — belongs to the caller, while *what gets simplified together* is the
 * whole point of this module.
 */
export function traceShared(
  labels: Int32Array,
  width: number,
  height: number,
  reduce: (points: VectorPoint[], closed: boolean) => VectorPoint[],
): Map<number, RegionLoops> {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? OUTSIDE : labels[y * width + x]!;

  const nodes = (width + 1) * (height + 1);
  const node = (x: number, y: number) => y * (width + 1) + x;
  const nodeX = (id: number) => id % (width + 1);
  const nodeY = (id: number) => (id - (id % (width + 1))) / (width + 1);

  /*
   * A boundary runs between two pixels that belong to different things, and at
   * least one of them has to be a region — the line between transparency and
   * the space outside the picture divides nothing from nothing.
   */
  const divides = (one: number, two: number) => one !== two && (one >= 0 || two >= 0);

  // Undirected edges, by the node they start at: 0 is the step to the right, 1
  // the step down. An edge is stored once, at its lower-left end.
  const across = new Uint8Array(nodes); // (x,y) → (x+1,y)
  const down = new Uint8Array(nodes); // (x,y) → (x,y+1)
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      if (x < width && divides(at(x, y - 1), at(x, y))) across[node(x, y)] = 1;
      if (y < height && divides(at(x - 1, y), at(x, y))) down[node(x, y)] = 1;
    }
  }

  /** The nodes a node is joined to by a boundary edge. */
  const neighbours = (id: number): number[] => {
    const x = nodeX(id);
    const y = nodeY(id);
    const out: number[] = [];
    if (across[id]) out.push(node(x + 1, y));
    if (x > 0 && across[node(x - 1, y)]) out.push(node(x - 1, y));
    if (down[id]) out.push(node(x, y + 1));
    if (y > 0 && down[node(x, y - 1)]) out.push(node(x, y - 1));
    return out;
  };

  /*
   * A junction is a node where the boundary is not simply passing through: three
   * or four boundaries meet, which means three or four regions do. Those points
   * are where the picture's shapes actually touch each other, so they are the
   * one thing simplifying may never move — pull a junction and the three shapes
   * meeting there come apart.
   */
  const degree = new Uint8Array(nodes);
  const junction = new Uint8Array(nodes);
  for (let id = 0; id < nodes; id += 1) {
    const count = neighbours(id).length;
    degree[id] = count;
    if (count > 0 && count !== 2) junction[id] = 1;
  }

  const arcs: Arc[] = [];
  const arcOf = new Map<number, number>(); // edge key → arc index
  const key = (one: number, two: number) => (one < two ? one * nodes + two : two * nodes + one);

  const walkArc = (from: number, first: number): void => {
    const run = [from];
    let previous = from;
    let current = first;
    for (;;) {
      run.push(current);
      arcOf.set(key(previous, current), arcs.length);
      if (junction[current] || current === from) break;
      const next = neighbours(current).find((candidate) => candidate !== previous);
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    const closed = run[0] === run[run.length - 1] && !junction[from];
    const points = run.map((id) => ({ x: nodeX(id), y: nodeY(id) }));
    arcs.push({
      nodes: run,
      simple: reduce(closed ? points.slice(0, -1) : points, closed),
      closed,
    });
  };

  // From every junction first, so an arc is a run between two of them.
  for (let id = 0; id < nodes; id += 1) {
    if (!junction[id]) continue;
    for (const next of neighbours(id)) {
      if (arcOf.has(key(id, next))) continue;
      walkArc(id, next);
    }
  }
  // Anything left is a loop with no junction on it: a shape whose whole boundary
  // divides the same two things, which is the common case for a plain blob.
  for (let id = 0; id < nodes; id += 1) {
    if (degree[id] !== 2) continue;
    for (const next of neighbours(id)) {
      if (arcOf.has(key(id, next))) continue;
      walkArc(id, next);
    }
  }

  /* ---- each region's own loops, rebuilt out of the shared arcs ---- */

  const found = new Map<number, RegionLoops>();
  const seen = new Set<number>(); // directed edge keys already walked

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = at(x, y);
      if (id < 0) continue;

      for (const [a, b] of sidesOf(x, y, at, id, node)) {
        if (seen.has(a * nodes + b)) continue;
        const loop = walkLoop(a, b, seen, nodes, id, at, node, nodeX, nodeY);
        if (loop.length < 3) continue;

        const points = rebuild(loop, arcs, arcOf, key, junction, nodeX, nodeY);
        if (points.length < 3) continue;

        const entry = found.get(id) ?? { outer: [], holes: [] };
        // The loop enclosing the most is the one round the outside; every other
        // loop this region has is a hole in it.
        if (Math.abs(area(points)) > Math.abs(area(entry.outer))) {
          if (entry.outer.length >= 3) entry.holes.push(entry.outer);
          entry.outer = points;
        } else {
          entry.holes.push(points);
        }
        found.set(id, entry);
      }
    }
  }

  return found;
}

/**
 * The sides of one pixel that are boundary, as directed corner-lattice steps.
 *
 * Wound so the pixel is always on the same hand of the direction of travel,
 * which is what makes an outer loop and a hole come out with opposite signs
 * without anything having to work out which is which.
 */
function sidesOf(
  x: number,
  y: number,
  at: (x: number, y: number) => number,
  id: number,
  node: (x: number, y: number) => number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (at(x, y - 1) !== id) out.push([node(x, y), node(x + 1, y)]);
  if (at(x + 1, y) !== id) out.push([node(x + 1, y), node(x + 1, y + 1)]);
  if (at(x, y + 1) !== id) out.push([node(x + 1, y + 1), node(x, y + 1)]);
  if (at(x - 1, y) !== id) out.push([node(x, y + 1), node(x, y)]);
  return out;
}

/** Follow one boundary loop of a region, from a directed step on it. */
function walkLoop(
  from: number,
  first: number,
  seen: Set<number>,
  nodes: number,
  id: number,
  at: (x: number, y: number) => number,
  node: (x: number, y: number) => number,
  nodeX: (id: number) => number,
  nodeY: (id: number) => number,
): number[] {
  const loop = [from];
  let previous = from;
  let current = first;
  let guard = 0;

  while (guard < nodes * 4) {
    guard += 1;
    seen.add(previous * nodes + current);
    if (current === from) break;
    loop.push(current);

    /*
     * Turn as far to the left as the boundary allows, which keeps the walk
     * hugging the region it is going round. At a point where two parts of the
     * same region meet corner to corner there are two ways on, and taking the
     * wrong one traces a figure of eight instead of two loops.
     */
    const direction = step(previous, current, nodeX, nodeY);
    let next = -1;
    for (let turn = 3; turn <= 6 && next < 0; turn += 1) {
      const heading = (direction + turn) % 4;
      const candidate = ahead(current, heading, nodeX, nodeY, node, at, id);
      if (candidate >= 0) next = candidate;
    }
    if (next < 0) break;
    previous = current;
    current = next;
  }
  return loop;
}

const HEADINGS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

function step(
  from: number,
  to: number,
  nodeX: (id: number) => number,
  nodeY: (id: number) => number,
): number {
  const dx = nodeX(to) - nodeX(from);
  const dy = nodeY(to) - nodeY(from);
  return HEADINGS.findIndex(([hx, hy]) => hx === dx && hy === dy);
}

/** The node one step along `heading`, if that step is this region's boundary. */
function ahead(
  from: number,
  heading: number,
  nodeX: (id: number) => number,
  nodeY: (id: number) => number,
  node: (x: number, y: number) => number,
  at: (x: number, y: number) => number,
  id: number,
): number {
  const x = nodeX(from);
  const y = nodeY(from);
  const [dx, dy] = HEADINGS[heading]!;
  const nx = x + dx;
  const ny = y + dy;

  /*
   * Each directed step has one pixel of the region on its right and something
   * else on its left; that is what makes it a step of *this* region's boundary
   * rather than of someone else's, and it is why an outer loop and a hole come
   * out wound opposite ways without anything having to decide which is which.
   */
  const inside =
    dx === 1
      ? at(x, y) === id
      : dx === -1
        ? at(x - 1, y - 1) === id
        : dy === 1
          ? at(x - 1, y) === id
          : at(x, y - 1) === id;
  if (!inside) return -1;

  const outside =
    dx === 1
      ? at(x, y - 1) !== id
      : dx === -1
        ? at(x - 1, y) !== id
        : dy === 1
          ? at(x, y) !== id
          : at(x - 1, y - 1) !== id;
  return outside ? node(nx, ny) : -1;
}

/** One region loop, with each run of it replaced by the shared, simplified arc. */
function rebuild(
  raw: number[],
  arcs: Arc[],
  arcOf: Map<number, number>,
  key: (one: number, two: number) => number,
  junction: Uint8Array,
  nodeX: (id: number) => number,
  nodeY: (id: number) => number,
): VectorPoint[] {
  /*
   * Start at a junction, so every arc is entered at one of its ends.
   *
   * Without this the loop can begin half way along an arc, and then there is no
   * answer to "which way round is this arc being walked" — the run gets written
   * from its end rather than from here, and the shape comes back with a piece
   * doubled and a piece missing.
   */
  const first = raw.findIndex((id) => junction[id]);
  const loop = first > 0 ? [...raw.slice(first), ...raw.slice(0, first)] : raw;

  const out: VectorPoint[] = [];
  let index = 0;

  while (index < loop.length) {
    const from = loop[index]!;
    const to = loop[(index + 1) % loop.length]!;
    const found = arcOf.get(key(from, to));
    if (found === undefined) {
      out.push({ x: nodeX(from), y: nodeY(from) });
      index += 1;
      continue;
    }

    const arc = arcs[found]!;
    if (arc.closed) {
      /*
       * The whole loop is this one arc. Where it starts does not matter — a
       * cycle rotated is the same shape — but which way round it goes does,
       * because that is what tells an outer boundary from a hole.
       */
      const ring = arc.nodes.slice(0, -1);
      const at = ring.indexOf(from);
      const forward = at >= 0 && ring[(at + 1) % ring.length] === to;
      return forward ? [...arc.simple] : [...arc.simple].reverse();
    }

    const forward = arc.nodes[0] === from;
    const run = forward ? arc.simple : [...arc.simple].reverse();
    // The last point is the junction the next arc starts from, so it is left for
    // that arc to contribute and is not written twice.
    out.push(...run.slice(0, -1));
    index += arc.nodes.length - 1;
  }
  return out;
}

function area(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}
