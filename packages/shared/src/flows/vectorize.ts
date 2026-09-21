import type { Bitmap } from './cutout';
import { colorDistance, quantise, toHex, type Rgb } from './palette';
import {
  isConvex,
  type VectorImage,
  type VectorLine,
  type VectorPoint,
  type VectorPolygon,
  type VectorShape,
} from './vector';

/**
 * Turning a picture back into shapes.
 *
 * The work goes in four steps, and each one answers a question the next needs:
 *
 * 1. **Which pixels belong together** — flood the image into regions of one color.
 * 2. **Which regions are strokes** — a region that is thin *and* separates two
 *    different things is a drawn line; everything else is an area.
 * 3. **Where their edges are** — trace each region's outline, and each stroke's
 *    centreline.
 * 4. **What shape that is** — simplify to anchors, decide straight or curved, and
 *    cut areas into convex pieces.
 */

export interface VectorizeOptions {
  /**
   * The widest a stroke can be, in pixels, and still be treated as a line.
   *
   * This is the one setting that decides what the picture *is*. Below it a thin
   * shape is a drawn mark with a middle; above it the same shape is a long thin
   * area with an inside. There is no right answer in general — it depends on how
   * the picture was drawn — so it is a number you turn while watching the result.
   */
  lineWidth: number;
  /**
   * How different two neighbouring pixels may be and still count as the same
   * color, in the OKLab-times-100 scale used everywhere else here.
   */
  tolerance: number;
  /** Pixels rounded to this many bits a channel before anything is grouped. */
  precision: number;
  /** Regions smaller than this are noise and are dropped. */
  minArea: number;
  /**
   * How far a traced outline may be moved to lose a point, in pixels. Larger
   * gives fewer anchors and a looser shape.
   */
  simplify: number;
  /**
   * How bent a run has to be before it is called a curve rather than a straight
   * line, as a fraction of its length.
   */
  curveThreshold: number;
  /** Pixels at or below this alpha are transparent, and are not part of anything. */
  alphaFloor: number;
}

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  lineWidth: 3,
  tolerance: 8,
  precision: 5,
  minArea: 12,
  simplify: 1.2,
  curveThreshold: 0.04,
  alphaFloor: 8,
};

export interface VectorizeReport {
  regions: number;
  dropped: number;
  lines: number;
  polygons: number;
  /** Regions thin enough to be a stroke but bordering only one thing. */
  thinButNotSeparating: number;
  convexPieces: number;
  transparent: number;
  problems: string[];
}

/* ------------------------------------------------------------------ *
 * 1. Regions
 * ------------------------------------------------------------------ */

const TRANSPARENT = -1;

export interface PixelRegion {
  id: number;
  color: Rgb;
  pixels: number[];
  /** Region ids touching this one; `TRANSPARENT` for the outside. */
  neighbours: Set<number>;
  /** The thickest the region gets, in pixels: twice its distance transform. */
  thickness: number;
}

/** Group pixels into runs of one color, four-way connected. */
export function findRegions(image: Bitmap, options: VectorizeOptions): {
  labels: Int32Array;
  regions: PixelRegion[];
  transparent: number;
} {
  const { width, height, data } = image;
  const size = width * height;
  const labels = new Int32Array(size).fill(-2);
  const regions: PixelRegion[] = [];
  let transparent = 0;

  const colorAt = (index: number): Rgb => ({
    r: quantise(data[index * 4]!, options.precision),
    g: quantise(data[index * 4 + 1]!, options.precision),
    b: quantise(data[index * 4 + 2]!, options.precision),
  });
  const clear = (index: number) => data[index * 4 + 3]! <= options.alphaFloor;

  for (let start = 0; start < size; start += 1) {
    if (clear(start)) {
      labels[start] = TRANSPARENT;
      transparent += 1;
      continue;
    }
    if (labels[start] !== -2) continue;

    const id = regions.length;
    const seed = colorAt(start);
    const pixels: number[] = [];
    const stack = [start];
    labels[start] = id;

    while (stack.length > 0) {
      const index = stack.pop()!;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const push = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const next = ny * width + nx;
        if (labels[next] !== -2 || clear(next)) return;
        // Against the seed color, not the neighbour's: neighbour-to-neighbour
        // walks a gradient across the whole picture, the same way a flood fill
        // does, and would make one region of everything.
        if (colorDistance(colorAt(next), seed) > options.tolerance) return;
        labels[next] = id;
        stack.push(next);
      };
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }

    regions.push({ id, color: seed, pixels, neighbours: new Set(), thickness: 0 });
  }

  // Who touches whom, which is what decides a line from an area.
  for (let index = 0; index < size; index += 1) {
    const label = labels[index]!;
    if (label === TRANSPARENT) continue;
    const x = index % width;
    const y = (index - x) / width;
    const look = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        regions[label]!.neighbours.add(TRANSPARENT);
        return;
      }
      const other = labels[ny * width + nx]!;
      if (other !== label) regions[label]!.neighbours.add(other);
    };
    look(x + 1, y);
    look(x - 1, y);
    look(x, y + 1);
    look(x, y - 1);
  }

  for (const region of regions) {
    region.thickness = thicknessOf(region, width, height);
  }
  return { labels, regions, transparent };
}

/**
 * How thick a region gets, by distance transform.
 *
 * The largest distance from any of its pixels to something that is not it,
 * doubled. A three-pixel-wide stroke has a middle one and a half pixels from
 * either edge, so it comes out three.
 *
 * Two chamfer passes rather than an exact Euclidean transform: the error is
 * under a tenth of a pixel on the widths that matter here, and the exact version
 * is several times the code for a number that is then compared against a
 * threshold someone set by eye.
 */
function thicknessOf(region: PixelRegion, width: number, height: number): number {
  if (region.pixels.length === 0) return 0;
  const own = new Set(region.pixels);
  const distance = new Map<number, number>();
  const BIG = 1e6;
  for (const index of region.pixels) distance.set(index, BIG);

  const near = 1;
  const diagonal = Math.SQRT2;
  const relax = (index: number, from: number, cost: number) => {
    const source = distance.get(from);
    if (source === undefined) return;
    const candidate = source + cost;
    if (candidate < distance.get(index)!) distance.set(index, candidate);
  };
  const outside = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height || !own.has(y * width + x);

  const sorted = [...region.pixels].sort((a, b) => a - b);
  for (const pass of [sorted, [...sorted].reverse()]) {
    const forward = pass === sorted;
    for (const index of pass) {
      const x = index % width;
      const y = (index - x) / width;
      // A pixel on the boundary is half a pixel from the edge of the shape.
      if (outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1)) {
        distance.set(index, Math.min(distance.get(index)!, 0.5));
      }
      const steps: Array<[number, number, number]> = forward
        ? [
            [-1, 0, near],
            [0, -1, near],
            [-1, -1, diagonal],
            [1, -1, diagonal],
          ]
        : [
            [1, 0, near],
            [0, 1, near],
            [1, 1, diagonal],
            [-1, 1, diagonal],
          ];
      for (const [dx, dy, cost] of steps) {
        const nx = x + dx;
        const ny = y + dy;
        if (outside(nx, ny)) continue;
        relax(index, ny * width + nx, cost);
      }
    }
  }

  let deepest = 0;
  for (const value of distance.values()) if (value < BIG && value > deepest) deepest = value;
  return deepest * 2;
}

/* ------------------------------------------------------------------ *
 * 2. Lines against areas
 * ------------------------------------------------------------------ */

/**
 * Is this region a drawn line?
 *
 * Both halves matter, and the second is the one that makes the rule right.
 *
 * **Thin** alone is not enough: a long thin rectangle of solid color sitting on
 * its own is a shape, not a stroke.
 *
 * **Separating** alone is not enough either: every region separates its
 * neighbours from each other in some sense.
 *
 * A stroke is thin *and* has different things on either side of it — which is
 * exactly the example that motivates the whole flow. A red box beside a blue box
 * is two areas and no line, because neither is thin. Put a black stroke between
 * them and the black is thin and has red one side and blue the other, so it is a
 * line and the boxes are still areas.
 */
export function isLineRegion(region: PixelRegion, options: VectorizeOptions): boolean {
  // A pixel short of the limit, because the distance transform reads an
  // even-width stroke as one pixel thinner than it is — a 2-wide stroke has no
  // pixel more than half a pixel from its edge. The real width is measured from
  // the centreline afterwards, and `strokeWidth` is what the threshold is
  // finally applied to; this only decides what is worth measuring.
  if (region.thickness > options.lineWidth + 1) return false;
  return region.neighbours.size >= 2;
}

/**
 * How wide a stroke is, from its area and the length of its middle.
 *
 * A rectangle's area over its length is its width, and that holds well enough
 * for a wobbly hand-drawn one. Better than reading it off the distance transform,
 * which is out by a pixel on every even width: a 2-wide stroke has no pixel more
 * than half a pixel from its edge, so the transform calls it 1.
 */
export function strokeWidth(pixels: number, paths: Centreline[]): number {
  const length = paths.reduce(
    (sum, path) => sum + pathLength(path.points) + (path.closed ? closingStep(path.points) : 0),
    0,
  );
  if (length < 1e-6) return 1;
  return pixels / length;
}

/* ------------------------------------------------------------------ *
 * 3. Outlines and centrelines
 * ------------------------------------------------------------------ */

/**
 * Walk the boundary of a region, in order.
 *
 * Moore neighbourhood tracing from the top-left-most pixel, going clockwise.
 * The walk is on pixel *corners* rather than centres, so the outline lands on
 * the edge of the shape instead of half a pixel inside it.
 */
export function traceOutline(
  pixels: Set<number>,
  width: number,
  height: number,
): VectorPoint[] {
  let start = -1;
  for (const index of pixels) {
    if (start === -1 || index < start) start = index;
  }
  if (start === -1) return [];

  const has = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && pixels.has(y * width + x);

  // Square tracing on the corner lattice: walk the boundary keeping the shape on
  // the right. Directions are right, down, left, up.
  const steps: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const startX = start % width;
  const startY = (start - startX) / width;

  const out: VectorPoint[] = [];
  let x = startX;
  let y = startY;
  let direction = 0;
  const first = { x, y };
  let guard = 0;
  const limit = pixels.size * 8 + 64;

  do {
    out.push({ x, y });
    // Try to turn left first, then straight, then right, then back: that traces
    // the outline tightly rather than cutting corners off it.
    let moved = false;
    for (let turn = 3; turn <= 6 && !moved; turn += 1) {
      const next = (direction + turn) % 4;
      const [dx, dy] = steps[next]!;
      const nx = x + dx;
      const ny = y + dy;
      if (!edgeExists(has, x, y, nx, ny)) continue;
      x = nx;
      y = ny;
      direction = next;
      moved = true;
    }
    if (!moved) break;
    guard += 1;
  } while ((x !== first.x || y !== first.y) && guard < limit);

  return out;
}

/** Is there a boundary edge between corner (x,y) and (nx,ny)? */
function edgeExists(
  has: (x: number, y: number) => boolean,
  x: number,
  y: number,
  nx: number,
  ny: number,
): boolean {
  if (nx === x + 1 && ny === y) return has(x, y) !== has(x, y - 1);
  if (nx === x - 1 && ny === y) return has(x - 1, y) !== has(x - 1, y - 1);
  if (nx === x && ny === y + 1) return has(x, y) !== has(x - 1, y);
  if (nx === x && ny === y - 1) return has(x, y - 1) !== has(x - 1, y - 1);
  return false;
}

/**
 * The middle of a stroke, as a path.
 *
 * Zhang-Suen thinning down to a one-pixel skeleton, then walked end to end. A
 * stroke's centreline is what you want to draw it back with; its outline would
 * give you a long thin loop around it instead, which is the wrong shape and
 * twice the points.
 */
export interface Centreline {
  points: VectorPoint[];
  /** A loop — an outline that goes all the way round rather than a stroke. */
  closed: boolean;
}

export function centreline(pixels: Set<number>, width: number, height: number): Centreline[] {
  const skeleton = thin(pixels, width, height);
  return walkSkeleton(skeleton, width, height).map((path) => ({
    // A loop has no ends to put back, and pushing its first point outwards
    // would open it.
    points: path.closed ? path.points : extendEnds(path.points, pixels, width, height),
    closed: path.closed,
  }));
}

/** The step from the last point back to the first, for a loop. */
function closingStep(points: VectorPoint[]): number {
  if (points.length < 2) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.hypot(first.x - last.x, first.y - last.y);
}

/** How long a path is, end to end along it. */
export function pathLength(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
  }
  return total;
}

export function thin(pixels: Set<number>, width: number, height: number): Set<number> {
  const current = new Set(pixels);
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && current.has(y * width + x) ? 1 : 0;

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds += 1;
    for (const step of [0, 1]) {
      const doomed: number[] = [];
      for (const index of current) {
        const x = index % width;
        const y = (index - x) / width;
        // The eight neighbours, clockwise from north.
        const p = [
          at(x, y - 1),
          at(x + 1, y - 1),
          at(x + 1, y),
          at(x + 1, y + 1),
          at(x, y + 1),
          at(x - 1, y + 1),
          at(x - 1, y),
          at(x - 1, y - 1),
        ];
        const filled = p.reduce((sum, value) => sum + value, 0);
        if (filled < 2 || filled > 6) continue;

        // Transitions from empty to filled going round: exactly one means
        // removing this pixel cannot break the shape in two.
        let transitions = 0;
        for (let n = 0; n < 8; n += 1) {
          if (p[n] === 0 && p[(n + 1) % 8] === 1) transitions += 1;
        }
        if (transitions !== 1) continue;

        const [north, east, south, west] = [p[0]!, p[2]!, p[4]!, p[6]!];
        if (step === 0) {
          if (north * east * south !== 0) continue;
          if (east * south * west !== 0) continue;
        } else {
          if (north * east * west !== 0) continue;
          if (north * south * west !== 0) continue;
        }
        doomed.push(index);
      }
      for (const index of doomed) current.delete(index);
      if (doomed.length > 0) changed = true;
    }
  }
  return current;
}

/**
 * Push an open end back out to the edge of the stroke it came from.
 *
 * Thinning eats the ends of a stroke: each round peels a layer, and an endpoint
 * has nothing behind it to protect it. A line drawn from the skeleton alone
 * stops a pixel or two short at both ends, which on a picture of short marks is
 * most of the mark. Walking the last direction until it leaves the region puts
 * back what the thinning took, and stops exactly where the ink does.
 */
function extendEnds(
  path: VectorPoint[],
  pixels: Set<number>,
  width: number,
  height: number,
): VectorPoint[] {
  if (path.length < 2) return path;
  const inside = (point: VectorPoint) => {
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    return x >= 0 && y >= 0 && x < width && y < height && pixels.has(y * width + x);
  };

  const reach = (from: VectorPoint, towards: VectorPoint): VectorPoint => {
    const dx = from.x - towards.x;
    const dy = from.y - towards.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return from;
    const step = { x: dx / length, y: dy / length };
    let out = from;
    // Half a pixel at a time, and never further than the stroke could be.
    for (let taken = 0; taken < 64; taken += 1) {
      const next = { x: out.x + step.x * 0.5, y: out.y + step.y * 0.5 };
      if (!inside(next)) break;
      out = next;
    }
    return out;
  };

  const out = [...path];
  out[0] = reach(out[0]!, out[1]!);
  out[out.length - 1] = reach(out[out.length - 1]!, out[out.length - 2]!);
  return out;
}

/** Follow a one-pixel skeleton into paths, breaking at junctions. */
function walkSkeleton(
  skeleton: Set<number>,
  width: number,
  height: number,
): Array<{ points: VectorPoint[]; closed: boolean }> {
  /**
   * The neighbours that are really neighbours.
   *
   * A diagonal link is dropped when the two pixels are already joined the long
   * way round, through an orthogonal pixel that is also in the skeleton. Without
   * that rule the outside corner of any rectangle looks like a junction — the
   * pixel beside the corner is diagonally adjacent to the pixel below it as well
   * as orthogonally adjacent to the corner itself — and a perfectly good closed
   * outline shatters into one path per corner.
   */
  const neighboursOf = (index: number): number[] => {
    const x = index % width;
    const y = (index - x) / width;
    const has = (nx: number, ny: number) =>
      nx >= 0 && ny >= 0 && nx < width && ny < height && skeleton.has(ny * width + nx);

    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        if (!has(x + dx, y + dy)) continue;
        if (dx !== 0 && dy !== 0 && (has(x + dx, y) || has(x, y + dy))) continue;
        out.push((y + dy) * width + (x + dx));
      }
    }
    return out;
  };

  const used = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const paths: VectorPoint[][] = [];
  const closed = new Set<VectorPoint[]>();

  const toPoint = (index: number): VectorPoint => {
    const x = index % width;
    // Pixel centres, so a stroke's middle lands in the middle of the stroke.
    return { x: x + 0.5, y: (index - x) / width + 0.5 };
  };

  const walkFrom = (start: number) => {
    for (const first of neighboursOf(start)) {
      if (used.has(edgeKey(start, first))) continue;
      const path = [toPoint(start)];
      let previous = start;
      let current = first;
      used.add(edgeKey(previous, current));
      path.push(toPoint(current));

      for (;;) {
        const onward = neighboursOf(current).filter(
          (candidate) => candidate !== previous && !used.has(edgeKey(current, candidate)),
        );
        // Stop at an end or a junction: a junction is where one stroke becomes
        // two, and carrying on through it would join marks that are not one mark.
        if (onward.length !== 1) break;
        const next = onward[0]!;
        used.add(edgeKey(current, next));
        previous = current;
        current = next;
        path.push(toPoint(current));
      }
      if (path.length < 2) continue;
      // Back where it started: a closed outline rather than a stroke with two
      // ends that happen to touch. Saying so is what lets it be drawn and edited
      // as a loop.
      if (current === start && path.length > 2) {
        path.pop();
        closed.add(path);
      }
      paths.push(path);
    }
  };

  // Ends and junctions first, so paths run end to end rather than starting in
  // the middle of a stroke.
  for (const index of skeleton) {
    const count = neighboursOf(index).length;
    if (count !== 2) walkFrom(index);
  }
  // Anything left is a closed loop with no ends at all.
  for (const index of skeleton) walkFrom(index);

  return paths.map((points) => ({ points, closed: closed.has(points) }));
}

/* ------------------------------------------------------------------ *
 * 4. Fitting
 * ------------------------------------------------------------------ */

/** Ramer-Douglas-Peucker: drop points that were not saying anything. */
export function simplify(points: VectorPoint[], tolerance: number): VectorPoint[] {
  if (points.length < 3 || tolerance <= 0) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (to <= from + 1) continue;
    const a = points[from]!;
    const b = points[to]!;

    let worst = 0;
    let at = -1;
    for (let index = from + 1; index < to; index += 1) {
      const away = perpendicular(points[index]!, a, b);
      if (away > worst) {
        worst = away;
        at = index;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

function perpendicular(point: VectorPoint, a: VectorPoint, b: VectorPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

/**
 * Is this run of anchors a curve, or a straight line that wobbles?
 *
 * Measured as how far the path departs from the straight line between its ends,
 * relative to how long it is. Relative because a 2px bow across 10px is a curve
 * and the same bow across 400px is a straight line someone drew by hand.
 */
export function looksCurved(points: VectorPoint[], threshold: number): boolean {
  if (points.length < 3) return false;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  if (span < 1e-6) return true;
  let worst = 0;
  for (const point of points) worst = Math.max(worst, perpendicular(point, a, b));
  return worst / span > threshold;
}

/**
 * Cut a polygon into convex pieces.
 *
 * Ear clipping down to triangles, then Hertel-Mehlhorn: glue neighbouring pieces
 * back together wherever the join stays convex. Triangles alone would satisfy
 * "convex" and produce ten times the shapes, which is worse to edit and worse to
 * read; merging gets most of that back for very little work.
 */
export function toConvexPieces(points: VectorPoint[]): VectorPoint[][] {
  if (points.length < 3) return [];
  if (isConvex(points)) return [points];

  const triangles = earClip(points);
  if (triangles.length === 0) return [];
  return mergeConvex(triangles);
}

function earClip(points: VectorPoint[]): VectorPoint[][] {
  const winding = signedArea(points) > 0 ? 1 : -1;
  const remaining = points.map((point, index) => ({ point, index }));
  const out: VectorPoint[][] = [];
  let guard = 0;

  while (remaining.length > 3 && guard < points.length * points.length + 64) {
    guard += 1;
    let clipped = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const previous = remaining[(index - 1 + remaining.length) % remaining.length]!.point;
      const ear = remaining[index]!.point;
      const next = remaining[(index + 1) % remaining.length]!.point;

      const cross = (ear.x - previous.x) * (next.y - ear.y) - (ear.y - previous.y) * (next.x - ear.x);
      if (cross * winding <= 0) continue;

      const others = remaining
        .filter((_, at) => at !== index && at !== (index - 1 + remaining.length) % remaining.length && at !== (index + 1) % remaining.length)
        .map((entry) => entry.point);
      if (others.some((point) => inTriangle(point, previous, ear, next))) continue;

      out.push([previous, ear, next]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    // A polygon that will not clip is self-intersecting or degenerate. Give back
    // what has been found rather than looping, and let the caller report it.
    if (!clipped) break;
  }
  if (remaining.length === 3) out.push(remaining.map((entry) => entry.point));
  return out;
}

function signedArea(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

function inTriangle(point: VectorPoint, a: VectorPoint, b: VectorPoint, c: VectorPoint): boolean {
  const sign = (p: VectorPoint, q: VectorPoint, r: VectorPoint) =>
    (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const d1 = sign(point, a, b);
  const d2 = sign(point, b, c);
  const d3 = sign(point, c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** Glue neighbouring pieces together while the result is still convex. */
function mergeConvex(pieces: VectorPoint[][]): VectorPoint[][] {
  const current = pieces.map((piece) => [...piece]);
  let merged = true;
  let guard = 0;

  while (merged && guard < 200) {
    merged = false;
    guard += 1;
    outer: for (let one = 0; one < current.length; one += 1) {
      for (let two = one + 1; two < current.length; two += 1) {
        const joined = joinAlongSharedEdge(current[one]!, current[two]!);
        if (!joined || !isConvex(joined)) continue;
        current.splice(two, 1);
        current[one] = joined;
        merged = true;
        break outer;
      }
    }
  }
  return current;
}

const same = (a: VectorPoint, b: VectorPoint) =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** Two polygons sharing exactly one edge, as one polygon. */
function joinAlongSharedEdge(one: VectorPoint[], two: VectorPoint[]): VectorPoint[] | null {
  for (let a = 0; a < one.length; a += 1) {
    const a1 = one[a]!;
    const a2 = one[(a + 1) % one.length]!;
    for (let b = 0; b < two.length; b += 1) {
      const b1 = two[b]!;
      const b2 = two[(b + 1) % two.length]!;
      // The shared edge runs the other way round in the neighbour, because both
      // wind the same way.
      if (!same(a1, b2) || !same(a2, b1)) continue;
      const joined = [
        ...one.slice(0, a + 1),
        ...two.slice(b + 1),
        ...two.slice(0, b),
      ];
      // Drop a point repeated across the seam.
      return joined.filter(
        (point, index) => !same(point, joined[(index + 1) % joined.length]!),
      );
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The whole thing
 * ------------------------------------------------------------------ */

export function vectorize(
  image: Bitmap,
  options: VectorizeOptions,
  makeId: (prefix: string) => string,
): { image: VectorImage; report: VectorizeReport } {
  const { width, height } = image;
  const { regions, transparent } = findRegions(image, options);
  const report: VectorizeReport = {
    regions: regions.length,
    dropped: 0,
    lines: 0,
    polygons: 0,
    thinButNotSeparating: 0,
    convexPieces: 0,
    transparent,
    problems: [],
  };

  const shapes: VectorShape[] = [];

  for (const region of regions) {
    if (region.pixels.length < options.minArea) {
      report.dropped += 1;
      continue;
    }
    const color = toHex(region.color);
    const pixels = new Set(region.pixels);

    if (isLineRegion(region, options)) {
      const paths = centreline(pixels, width, height);
      const measured = strokeWidth(region.pixels.length, paths);

      // Now that its real width is known, it may turn out to be an area after
      // all — a squat blob is thin by the distance transform and not a stroke.
      if (paths.length > 0 && measured <= options.lineWidth) {
        for (const path of paths) {
          const anchors = simplify(path.points, options.simplify);
          if (anchors.length < (path.closed ? 3 : 2)) continue;
          shapes.push({
            id: makeId('line'),
            kind: 'line',
            color,
            width: Math.max(0.5, Math.round(measured * 10) / 10),
            points: anchors,
            // A loop is always a curve by the straight-line test, since its ends
            // are the same point. Judge it on its corners instead.
            curved: path.closed
              ? anchors.length > 6
              : looksCurved(anchors, options.curveThreshold),
            closed: path.closed,
          } satisfies VectorLine);
          report.lines += 1;
        }
        continue;
      }
    }

    if (region.thickness <= options.lineWidth) report.thinButNotSeparating += 1;

    const outline = simplify(traceOutline(pixels, width, height), options.simplify);
    if (outline.length < 3) {
      report.dropped += 1;
      continue;
    }
    const pieces = toConvexPieces(outline);
    if (pieces.length === 0) {
      report.problems.push(`An area at ${describe(region, width)} could not be cut into convex pieces.`);
      continue;
    }
    for (const piece of pieces) {
      const polygon: VectorPolygon = { id: makeId('poly'), kind: 'polygon', color, points: piece };
      shapes.push(polygon);
      report.polygons += 1;
    }
    report.convexPieces += pieces.length;
  }

  return { image: { width, height, shapes }, report };
}

function describe(region: PixelRegion, width: number): string {
  const first = region.pixels[0] ?? 0;
  const x = first % width;
  return `${x}, ${(first - x) / width}`;
}

export function summariseVectorize(report: VectorizeReport): string {
  return [
    `${report.regions} region(s)`,
    `${report.lines} line(s)`,
    `${report.polygons} polygon(s)`,
    ...(report.dropped > 0 ? [`${report.dropped} dropped as too small`] : []),
  ].join(' · ');
}
