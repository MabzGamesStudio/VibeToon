import type { Bitmap } from './cutout';
import {
  boxOf,
  coverageFor,
  fillInto,
  fitStroke,
  mergeHidden,
  prunePoints,
  pruneStroke,
  scorePieces,
  shareInk,
  strokeInto,
  type Box,
  type FitWeights,
  type Hidden,
  type PolygonFit,
} from './fit';
import { detectEdges, growRegions, type EdgeMap, type GrownRegion } from './edges';
import { colorDistance, fromHex, toHex } from './palette';
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
 * 1. **Where the edges are** — one Canny pass over the whole picture, in `edges.ts`.
 *    Finding the boundaries once, up front, is what makes the rest cheap: every
 *    later step reads the answer instead of re-deriving it from color.
 * 2. **Which pixels belong together** — flood the space *between* the edges, the
 *    way a fill tool does, with no color comparison while spreading. The edge
 *    band is then handed to whichever side it looks like, so a region includes
 *    the blended boundary of the thing it stands for.
 * 3. **Which regions are strokes** — a region that is thin *and* separates two
 *    different things is a drawn line; everything else is an area.
 * 4. **What shape that is** — trace the outline (or the centreline), simplify to a
 *    tolerance and a point budget, decide straight or curved, and cut areas into
 *    convex pieces.
 *
 * Nothing in that path measures a candidate against the pixels. `refine` turns on
 * a slower pass that does, for when you want the last percent.
 */

export interface VectorizeOptions {
  /**
   * The widest a stroke can be, in pixels, and still be treated as a line.
   *
   * The one setting that decides what the picture *is*. Below it a thin region
   * is a drawn mark with a middle; above it the same region is a long thin area
   * with an inside.
   */
  lineWidth: number;
  /**
   * How much contrast counts as a boundary, in the OKLab-times-100 scale.
   *
   * This replaces the old same-color tolerance, and asks a better question.
   * Tolerance asked each pixel whether it was near enough the one the fill
   * started from, which gives a different answer depending on where it started
   * and leaks wherever shading happens to be gradual. This asks where the
   * picture *changes*, which is one answer for the whole image.
   */
  edgeThreshold: number;
  /**
   * The weaker threshold. A pixel over this is a boundary only where it joins
   * one that cleared the stronger one, which keeps a real boundary unbroken
   * where it briefly softens without letting noise become boundaries.
   */
  edgeFloor: number;
  /**
   * How far a shape's outline may move in order to lose a point, in pixels.
   *
   * The direct control over how many points a shape has. Every pixel step of a
   * traced outline is an anchor to begin with, which is a hundred times more
   * than any shape needs.
   */
  detail: number;
  /**
   * The most points any one shape may have. 0 for no limit.
   *
   * A budget rather than a tolerance, because "no more than sixteen points" is a
   * thing you can want and `detail` alone cannot promise it — one fiddly outline
   * will always find a way to spend forty. Where a shape is over budget the
   * tolerance is loosened for that shape until it fits.
   */
  maxPoints: number;
  /** Regions smaller than this are folded into whichever neighbour they touch most. */
  minArea: number;
  /**
   * How bent a run has to be before it is called a curve rather than a straight
   * line, as a fraction of its length.
   */
  curveThreshold: number;
  /** Pixels at or below this alpha are transparent, and are not part of anything. */
  alphaFloor: number;
  /**
   * Spend longer for a closer fit, once the shapes are found.
   *
   * Off is the fast path: edges, fill, trace, simplify, done. On adds a pass that
   * draws each candidate and compares it with the pixels it stands for, dropping
   * anchors that are not paying for themselves and searching a stroke's width
   * against the ink. Slower by several times, and worth it when the answer
   * matters more than the wait.
   */
  refine: boolean;
  /** With `refine` on: what one anchor is worth, measured in wrong pixels. */
  pointCost: number;
  /** With `refine` on: what one polygon is worth, in the same units. */
  polygonCost: number;
}

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  lineWidth: 3,
  edgeThreshold: 12,
  edgeFloor: 5,
  detail: 1.8,
  maxPoints: 20,
  minArea: 12,
  curveThreshold: 0.04,
  alphaFloor: 8,
  refine: false,
  pointCost: 6,
  polygonCost: 40,
};

export interface VectorizeReport {
  regions: number;
  dropped: number;
  lines: number;
  polygons: number;
  /** Pixels the finished shapes get wrong: missed plus covered in error. */
  wrongPixels: number;
  /** Pixels the shapes were trying to account for. */
  drawnPixels: number;
  /** Regions thin enough to be a stroke but bordering only one thing. */
  thinButNotSeparating: number;
  convexPieces: number;
  transparent: number;
  /** Pixels the edge pass claimed, before they were handed back to regions. */
  edgePixels: number;
  problems: string[];
}

/* ------------------------------------------------------------------ *
 * 1. Regions, from the edges
 * ------------------------------------------------------------------ */

/** A grown region, with how thick it gets — which decides what it becomes. */
export interface PixelRegion extends GrownRegion {
  /** The widest the region is anywhere, in pixels. */
  thickness: number;
}

/**
 * Find the regions: edges first, then fill between them.
 *
 * Replaces growing by color tolerance, which asked each pixel whether it was
 * near enough the one the fill started from. That gives a different answer
 * depending on where it started, and it leaks wherever shading is gradual — a
 * face shaded across twenty tones needed a tolerance wide enough to span the
 * shading, which was always wide enough to escape past the outline too.
 */
export function findRegions(
  image: Bitmap,
  options: VectorizeOptions,
): {
  regions: PixelRegion[];
  transparent: number;
  edgePixels: number;
  folded: number;
  map: EdgeMap;
} {
  const map = detectEdges(image, {
    edgeThreshold: options.edgeThreshold,
    edgeFloor: options.edgeFloor,
    alphaFloor: options.alphaFloor,
  });
  const grown = growRegions(image, map, options.minArea, options.edgeThreshold);
  const regions: PixelRegion[] = grown.regions.map((region) => ({
    ...region,
    thickness: thicknessOf(region.pixels, image.width),
  }));
  return {
    regions,
    transparent: grown.transparent,
    edgePixels: grown.edgePixels,
    folded: grown.folded,
    map,
  };
}

/**
 * The widest a run of pixels is anywhere, by chamfer distance transform.
 *
 * Two sweeps over the region's own bounding box rather than over the picture, and
 * in flat arrays rather than a `Map` keyed by pixel index. That matters more than
 * it looks: this is asked once per region, and a `Map` of a hundred thousand
 * entries hashing every lookup was a third of the whole flow's time on its own.
 */
export function thicknessOf(pixels: readonly number[], width: number): number {
  if (pixels.length === 0) return 0;

  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const index of pixels) {
    const x = index % width;
    const y = (index - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  // One cell of margin all round, so "outside the shape" is inside the array and
  // the sweeps need no bounds test of their own.
  const span = right - left + 3;
  const rows = bottom - top + 3;

  const BIG = 1e6;
  const distance = new Float64Array(span * rows).fill(-1);
  for (const index of pixels) {
    const x = index % width;
    const y = (index - x) / width;
    distance[(y - top + 1) * span + (x - left + 1)] = BIG;
  }

  const diagonal = Math.SQRT2;
  const relax = (at: number, from: number, cost: number) => {
    const source = distance[from]!;
    if (source < 0) return;
    const candidate = source + cost;
    if (candidate < distance[at]!) distance[at] = candidate;
  };

  for (let pass = 0; pass < 2; pass += 1) {
    const forward = pass === 0;
    for (let step = 0; step < span * rows; step += 1) {
      const at = forward ? step : span * rows - 1 - step;
      if (distance[at]! < 0) continue;
      const x = at % span;
      const y = (at - x) / span;
      // A pixel on the boundary is half a pixel from the edge of the shape.
      if (
        distance[at - 1]! < 0 ||
        distance[at + 1]! < 0 ||
        distance[at - span]! < 0 ||
        distance[at + span]! < 0
      ) {
        if (distance[at]! > 0.5) distance[at] = 0.5;
      }
      if (forward) {
        if (x > 0) relax(at, at - 1, 1);
        if (y > 0) relax(at, at - span, 1);
        if (x > 0 && y > 0) relax(at, at - span - 1, diagonal);
        if (x < span - 1 && y > 0) relax(at, at - span + 1, diagonal);
      } else {
        if (x < span - 1) relax(at, at + 1, 1);
        if (y < rows - 1) relax(at, at + span, 1);
        if (x < span - 1 && y < rows - 1) relax(at, at + span + 1, diagonal);
        if (x > 0 && y < rows - 1) relax(at, at + span - 1, diagonal);
      }
    }
  }

  let deepest = 0;
  for (const value of distance) if (value >= 0 && value < BIG && value > deepest) deepest = value;
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
export function isLineRegion(
  region: { thickness: number; neighbours: Set<number> },
  options: VectorizeOptions,
): boolean {
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

/**
 * The same, for a ring, where there is no first point and no last one.
 *
 * Running open RDP round a closed outline gets it wrong twice. The chord it
 * starts from joins the first point to the last, which on a ring are
 * neighbours — so every point is measured against a one-pixel baseline that
 * means nothing. And whichever corner the trace happened to stop on is pinned
 * while the corner beside it is free to go, which is how a two-by-two square
 * came out as a triangle with a corner missing.
 *
 * Splitting at the point farthest from the start gives two open halves that
 * between them cover the ring, each with a baseline the length of the shape.
 */
export function simplifyClosed(points: VectorPoint[], tolerance: number): VectorPoint[] {
  if (points.length < 4 || tolerance <= 0) return points;

  const first = points[0]!;
  let far = 0;
  let worst = -1;
  for (let index = 1; index < points.length; index += 1) {
    const away = Math.hypot(points[index]!.x - first.x, points[index]!.y - first.y);
    if (away > worst) {
      worst = away;
      far = index;
    }
  }
  if (far < 1) return points;

  const head = simplify(points.slice(0, far + 1), tolerance);
  const tail = simplify([...points.slice(far), first], tolerance);
  // Both halves carry the two split points; the ring closes implicitly, so the
  // shared ends are counted once.
  return [...head.slice(0, -1), ...tail.slice(0, -1)];
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
  const found = findRegions(image, options);
  const report: VectorizeReport = {
    regions: found.regions.length,
    // Specks folded into a neighbour were dropped as surely as one that could not
    // be traced — they are not shapes in the answer either way.
    dropped: found.folded,
    lines: 0,
    polygons: 0,
    wrongPixels: 0,
    drawnPixels: 0,
    thinButNotSeparating: 0,
    convexPieces: 0,
    transparent: found.transparent,
    edgePixels: found.edgePixels,
    problems: [],
  };

  /*
   * Areas by what they cover, biggest first, then strokes.
   *
   * That is how the picture was made — a background is laid down, the subject
   * stands on it, ink goes on last — and painting them back in that order means
   * an enclosing shape never has to cut itself around what sits on top of it.
   *
   * **What an area covers is what its outline encloses**, not how many pixels its
   * region held, and the difference is the whole of this. A region can be a ring:
   * a black outline round a face is a closed band of ink with a hole in it. Its
   * outline is traced on the outside, so filling it gives a disc rather than a
   * ring — which is right, because the face is painted over it afterwards and
   * only the rim is left showing. Ordered by pixel count instead, the ring is the
   * smaller of the two and goes on last, and the face disappears under a black
   * blob. That is exactly what it did.
   */
  const strokes = new Set(found.regions.filter((region) => isLineRegion(region, options)));
  // Thin is half the rule, and the half that fails is worth saying out loud: a
  // sliver of color with only one thing beside it is a shape, and someone
  // wondering why their stroke came out as a polygon wants to be told which half
  // it missed.
  for (const region of found.regions) {
    if (!strokes.has(region) && region.thickness <= options.lineWidth + 1) {
      report.thinButNotSeparating += 1;
    }
  }
  // Traced once, here, because the order needs the outline and so does the fit.
  const outlines = new Map<PixelRegion, VectorPoint[]>();
  for (const region of found.regions) {
    if (strokes.has(region)) continue;
    outlines.set(region, traceOutline(new Set(region.pixels), width, height));
  }
  const covers = (region: PixelRegion) => Math.abs(signedArea(outlines.get(region) ?? []));

  const order = [
    ...found.regions.filter((region) => !strokes.has(region)).sort((a, b) => covers(b) - covers(a)),
    ...found.regions.filter((region) => strokes.has(region)),
  ];

  const weights: FitWeights = { pixel: 1, point: options.pointCost, polygon: options.polygonCost };
  const rankOf = new Int32Array(width * height).fill(-1);
  if (options.refine) {
    for (let rank = 0; rank < order.length; rank += 1) {
      for (const index of order[rank]!.pixels) rankOf[index] = rank;
    }
  }
  const hiddenAfter = (rank: number): Hidden => (index: number) => rankOf[index]! > rank;

  const shapes: VectorShape[] = [];

  for (let rank = 0; rank < order.length; rank += 1) {
    const region = order[rank]!;
    const color = toHex(region.color);
    const pixels = new Set(region.pixels);
    report.drawnPixels += pixels.size;

    const box = boxOf(pixels, width, Math.ceil(options.lineWidth) + 2);
    const hidden = options.refine ? hiddenAfter(rank) : undefined;

    if (strokes.has(region)) {
      const paths = centreline(pixels, width, height);
      if (paths.length > 0) {
        const shares = options.refine
          ? shareInk(paths.map((path) => path.points), pixels, width)
          : paths.map(() => undefined);

        const lines = paths
          .map((path, index) =>
            options.refine
              ? fitLine(path, pixels, box, width, options, weights, mergeHidden(hidden, shares[index]))
              : quickLine(path, region, paths, options),
          )
          .filter((line): line is FittedLine => line !== null);

        const widest = Math.max(0, ...lines.map((line) => line.width));
        // With the real widths known, a squat blob that the thinness test let
        // through can still turn out to be an area rather than a stroke.
        if (lines.length > 0 && widest <= options.lineWidth + 0.5) {
          for (const line of lines) {
            shapes.push({
              id: makeId('line'),
              kind: 'line',
              color,
              width: Math.max(0.5, Math.round(line.width * 10) / 10),
              points: line.points,
              // A loop is always a curve by the straight-line test, since its
              // ends are the same point. Judge it on its corners instead.
              curved: line.closed
                ? line.points.length > 6
                : looksCurved(line.points, options.curveThreshold),
              closed: line.closed,
            } satisfies VectorLine);
            report.lines += 1;
          }
          continue;
        }
      }
      report.thinButNotSeparating += 1;
    }

    const traced = outlines.get(region) ?? traceOutline(pixels, width, height);
    if (traced.length < 3) {
      report.dropped += 1;
      continue;
    }

    const pieces = options.refine
      ? fitArea(traced, pixels, box, width, options, weights, hidden).pieces
      : quickArea(traced, options);

    if (pieces.length === 0) {
      report.problems.push(`An area at ${describe(region, width)} could not be cut into convex pieces.`);
      continue;
    }
    for (const piece of pieces) {
      shapes.push({ id: makeId('poly'), kind: 'polygon', color, points: piece } satisfies VectorPolygon);
      report.polygons += 1;
    }
    report.convexPieces += pieces.length;
  }

  const drawn: VectorImage = { width, height, shapes };
  report.wrongPixels = measureWhole(image, drawn, options);
  return { image: drawn, report };
}

/**
 * Simplify to a tolerance, and then to a budget.
 *
 * `detail` is the tolerance and does most of the work. The budget is there
 * because "no more than sixteen points" is a thing you can want and a tolerance
 * alone cannot promise it — one fiddly outline will always find a way to spend
 * forty. Where a shape is over budget the tolerance is doubled for that shape
 * until it fits, which loosens the shapes that need loosening and leaves the
 * rest alone.
 */
export function toBudget(
  points: VectorPoint[],
  detail: number,
  maxPoints: number,
  minimum: number,
  closed = false,
): VectorPoint[] {
  const reduce = (tolerance: number) =>
    closed ? simplifyClosed(points, tolerance) : simplify(points, tolerance);

  let out = reduce(detail);

  if (maxPoints > 0) {
    let tolerance = Math.max(0.2, detail);
    for (let round = 0; round < 12 && out.length > Math.max(minimum, maxPoints); round += 1) {
      tolerance *= 1.8;
      out = reduce(tolerance);
    }
  }
  if (out.length >= minimum) return out;

  /*
   * Too few to be a shape at all, so tighten until it is one.
   *
   * A tolerance is a distance, and a shape can be smaller than it — a two-pixel
   * square has no corner more than one and a half pixels off its own diagonal,
   * so a pixel and a half of slack flattens it into a line. Without this the
   * shape is simply gone from the drawing, which is never the right answer to
   * "simplify this": losing detail is the deal, losing the shape is not.
   */
  let tolerance = detail;
  for (let round = 0; round < 8 && tolerance > 0.01; round += 1) {
    tolerance /= 2;
    const tighter = reduce(tolerance);
    if (tighter.length >= minimum) return tighter;
  }
  return points;
}

interface FittedLine {
  points: VectorPoint[];
  width: number;
  closed: boolean;
}

/**
 * A stroke, measured rather than searched for.
 *
 * Its width is its area over the length of its middle — which is the width of a
 * rectangle and close enough for a wobbly hand-drawn one. That used to be worth
 * searching for, because regions grown by color tolerance did not include the
 * blended boundary and came out narrower than the ink. Regions grown between
 * edges do include it: the edge pass hands its pixels back to whichever side
 * they look like, so the area being divided here is the whole stroke.
 */
function quickLine(
  path: Centreline,
  region: PixelRegion,
  all: Centreline[],
  options: VectorizeOptions,
): FittedLine | null {
  const anchors = toBudget(
    path.points,
    options.detail,
    options.maxPoints,
    path.closed ? 3 : 2,
    path.closed,
  );
  if (anchors.length < (path.closed ? 3 : 2)) return null;

  const total = all.reduce(
    (sum, other) => sum + pathLength(other.points) + (other.closed ? closingStep(other.points) : 0),
    0,
  );
  const width = total < 1e-6 ? 1 : region.pixels.length / total;
  return { points: anchors, width, closed: path.closed };
}

/** An area, simplified and then cut into convex pieces only if it needs to be. */
function quickArea(traced: VectorPoint[], options: VectorizeOptions): VectorPoint[][] {
  // An outline is a ring, always.
  const outline = toBudget(traced, options.detail, options.maxPoints, 3, true);
  if (outline.length < 3) return [];
  return toConvexPieces(outline);
}

/**
 * How many pixels the finished drawing gets wrong, over the whole picture.
 *
 * Measured once, at the end, rather than per candidate. The old fit asked this
 * question hundreds of times a shape and that was most of what the flow spent
 * its time on; asking it once tells you just as much about whether the answer is
 * any good, and costs one pass.
 */
function measureWhole(source: Bitmap, drawn: VectorImage, options: VectorizeOptions): number {
  const { width, height } = source;
  const box: Box = { x: 0, y: 0, width, height };
  const painted = new Int32Array(width * height).fill(-1);
  const scratch = coverageFor(box);

  const order = [
    ...drawn.shapes.filter((shape) => shape.kind === 'polygon'),
    ...drawn.shapes.filter((shape) => shape.kind === 'line'),
  ];
  for (const shape of order) {
    scratch.fill(0);
    if (shape.kind === 'polygon') fillInto(shape.points, box, scratch);
    else strokeInto(shape.points, shape.width, box, scratch);
    const rgb = fromHex(shape.color);
    if (!rgb) continue;
    const packed = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
    for (let index = 0; index < scratch.length; index += 1) {
      if (scratch[index]! >= 128) painted[index] = packed;
    }
  }

  let wrong = 0;
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    const clear = source.data[at + 3]! <= options.alphaFloor;
    const got = painted[index]!;
    if (clear) {
      // Transparent in the source and painted over is wrong too, or a shape
      // could score well by spilling into the empty part of the picture.
      if (got >= 0) wrong += 1;
      continue;
    }
    if (got < 0) {
      wrong += 1;
      continue;
    }
    const distance = colorDistance(
      { r: (got >> 16) & 255, g: (got >> 8) & 255, b: got & 255 },
      { r: source.data[at]!, g: source.data[at + 1]!, b: source.data[at + 2]! },
    );
    // Judged by eye rather than by byte: a pixel a shade off is not wrong.
    if (distance > 8) wrong += 1;
  }
  return wrong;
}

/* ------------------------------------------------------------------ *
 * The slow path
 *
 * Everything below is only reached with `refine` turned on. It measures each
 * candidate against the pixels instead of trusting the trace, which finds a
 * better answer and costs far more time — worth it for a final pass over a
 * drawing you are keeping, not for the twenty you throw away first.
 * ------------------------------------------------------------------ */

/** One box cropped to another, so a tight box never reaches outside the image. */
function clampBox(inner: Box, outer: Box): Box {
  const x = Math.max(inner.x, outer.x);
  const y = Math.max(inner.y, outer.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - x),
    height: Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - y),
  };
}

/**
 * One stroke, fitted to the ink it was traced from.
 *
 * The centreline says where the stroke runs; everything else about it is
 * measured. The width is searched from thin up to the configured maximum, which
 * is what "expand until it fills the contrast gap" means in practice — the width
 * that leaves fewest wrong pixels *is* the width of the gap. Then each end is
 * pushed outwards while that keeps helping, because thinning ate them.
 */
function fitLine(
  path: Centreline,
  pixels: Set<number>,
  box: Box,
  imageWidth: number,
  options: VectorizeOptions,
  weights: FitWeights,
  hidden?: Hidden,
): FittedLine | null {
  const start = path.points;
  if (start.length < (path.closed ? 3 : 2)) return null;

  // Simplified first, so the search is over a handful of anchors rather than one
  // per pixel — and then pruned again at the end, once the width is known.
  const rough = toBudget(
    start,
    Math.max(0.6, options.detail),
    options.maxPoints,
    path.closed ? 3 : 2,
    path.closed,
  );
  const seed = rough.length >= (path.closed ? 3 : 2) ? rough : start;

  /*
   * Searched past the limit on purpose.
   *
   * Capping the search at the limit would make the "this is a stroke" test
   * vacuous — the answer could never exceed the threshold it is compared
   * against, so every candidate would pass and a squat blob would come out as a
   * very fat line. Asking what width the ink actually wants, and *then* checking
   * it against the limit, is a question with two possible answers.
   */
  // Scored over the stroke's own box rather than the region's. A region of
  // crossing strokes spans the picture while each stroke spans a corner of it,
  // and every candidate width was walking all of the former to measure the
  // latter.
  const reach = options.lineWidth * 2 + 4;
  const near = new Set<number>();
  for (const point of seed) near.add(Math.round(point.y) * imageWidth + Math.round(point.x));
  const tight = clampBox(boxOf(near, imageWidth, Math.ceil(reach)), box);

  let fit = fitStroke(seed, pixels, tight, imageWidth, options.lineWidth * 2 + 2, weights, {
    // A closed outline has no ends to push out; pushing one would open it.
    maxExtend: path.closed ? 0 : undefined,
    hidden,
  });
  fit = pruneStroke(fit, pixels, tight, imageWidth, weights, hidden);
  if (fit.points.length < (path.closed ? 3 : 2)) return null;

  return { points: fit.points, width: fit.width, closed: path.closed };
}

/**
 * One filled area, fitted to the color it stands for.
 *
 * A ladder of simplify tolerances is tried, each cut into convex pieces and
 * scored as a fill; the cheapest wins and is then pruned anchor by anchor. The
 * ladder is there because simplifying and then cutting into convex pieces are
 * not independent — a looser outline can need *more* pieces, not fewer — so the
 * only honest way to compare two tolerances is to finish the job at both and
 * look at what came out.
 */
function fitArea(
  traced: VectorPoint[],
  pixels: Set<number>,
  box: Box,
  imageWidth: number,
  options: VectorizeOptions,
  weights: FitWeights,
  hidden?: Hidden,
): PolygonFit {
  const ladder = [0.4, 0.8, 1.2, 1.8, 2.6, 3.6];
  let best: PolygonFit | null = null;
  for (const tolerance of ladder) {
    const outline = toBudget(traced, tolerance, options.maxPoints, 3, true);
    if (outline.length < 3) continue;
    const pieces = toConvexPieces(outline);
    if (pieces.length === 0) continue;
    const fit = scorePieces(pieces, pixels, box, imageWidth, weights, undefined, hidden);
    if (!best || fit.cost < best.cost) best = fit;
  }
  if (!best) {
    return {
      pieces: [],
      mismatch: { missed: pixels.size, extra: 0, wrong: pixels.size, target: pixels.size },
      cost: Infinity,
    };
  }

  return prunePoints(best.pieces, pixels, box, imageWidth, weights, 3, hidden);
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
