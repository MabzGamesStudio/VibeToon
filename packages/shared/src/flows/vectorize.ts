import type { Bitmap } from './cutout';
import { boxOf, coverageFor, fillInto, strokeInto, type Box } from './fit';
import { traceShared, type RegionLoops } from './arcs';
import { detectEdges, growRegions, type EdgeMap, type GrownRegion } from './edges';
import { joinLines, joinPolygons } from './join';
import { QuadIndex, type Bounds, type SpatialIndex } from './spatial';
import { fromHex, toHex, toOklab } from './palette';
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
 * 5. **What belongs together** — put back together the pieces of one color that
 *    share a side, and the lines of one color whose ends meet (`join.ts`).
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
   * How many rounds of "find the worst part and do it better".
   *
   * 0 is the fast path: edges, fill, trace, simplify, done. Each round after
   * that rasterises what has been drawn, measures it against the picture it came
   * from, and grants a tighter tolerance to the boundaries running through the
   * blocks that came out worst — so the effort goes where the drawing is wrong
   * rather than evenly over a drawing that is mostly right.
   */
  refineRounds: number;
  /**
   * How big a block the error is averaged over, in pixels.
   *
   * The measure is an *average*, so this is really asking how big a mistake has
   * to be to count as one. Small blocks notice a single misplaced corner; large
   * ones only notice a shape in the wrong place.
   */
  hotspotBlock: number;
  /** What fraction of the blocks that have any error at all count as hot, 0..1. */
  hotspotShare: number;
  /**
   * Join shapes of exactly the same color that touch: polygons that share a side
   * become one polygon, and lines whose ends are within `joinGap` become one line.
   *
   * On by default, because a region is one shape to anyone looking at it. Off
   * gives back the convex pieces the region was cut into, for a consumer that
   * needs every polygon convex.
   */
  joinShapes: boolean;
  /** How close two line ends have to be to join, in pixels. */
  joinGap: number;
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
  refineRounds: 1,
  hotspotBlock: 16,
  hotspotShare: 0.2,
  joinShapes: true,
  joinGap: 3,
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
  /** Pieces too thin to be areas, given back as strokes instead. */
  slivers: number;
  /** Joins of two same-color polygons that shared a side. */
  joinedPolygons: number;
  /** Joins of two same-color lines whose ends met. */
  joinedLines: number;
  transparent: number;
  /** Pixels the edge pass claimed, before they were handed back to regions. */
  edgePixels: number;
  /** Rounds of refinement that actually improved the drawing. */
  rounds: number;
  /** Blocks the last round judged worth another look. */
  hotBlocks: number;
  /** Pixels painted where the picture is not there at all. Should be none. */
  overNothing: number;
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
  /** Which region each pixel ended up in, which is what the tracer reads. */
  labels: Int32Array;
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
    labels: grown.labels,
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

/**
 * How far a point may be moved to drop it: one distance, or a different one
 * depending on where in the picture it is.
 *
 * Varying it along a boundary is what makes refinement worth anything. A
 * boundary is not uniformly good or bad — the outline of a head is exact for
 * most of its length and wrong at the chin — and an arc is one run from junction
 * to junction, so granting the *arc* a tighter tolerance spends points along
 * every part of it that was already right. Granting the tolerance point by point
 * spends them at the chin.
 */
export type Tolerance = number | ((point: VectorPoint) => number);

const toleranceAt = (tolerance: Tolerance, point: VectorPoint): number =>
  typeof tolerance === 'number' ? tolerance : tolerance(point);

const loosest = (tolerance: Tolerance, points: VectorPoint[]): number => {
  if (typeof tolerance === 'number') return tolerance;
  let most = 0;
  for (const point of points) most = Math.max(most, tolerance(point));
  return most;
};

/** Ramer-Douglas-Peucker: drop points that were not saying anything. */
export function simplify(points: VectorPoint[], tolerance: Tolerance): VectorPoint[] {
  if (points.length < 3 || loosest(tolerance, points) <= 0) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (to <= from + 1) continue;
    const a = points[from]!;
    const b = points[to]!;

    // Scored against its own tolerance, so a point in a part of the picture that
    // came out wrong is kept where the same deviation elsewhere is dropped.
    let worst = 0;
    let at = -1;
    for (let index = from + 1; index < to; index += 1) {
      const point = points[index]!;
      const away = perpendicular(point, a, b) / Math.max(1e-6, toleranceAt(tolerance, point));
      if (away > worst) {
        worst = away;
        at = index;
      }
    }
    if (worst > 1 && at > 0) {
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
export function simplifyClosed(points: VectorPoint[], tolerance: Tolerance): VectorPoint[] {
  if (points.length < 4 || loosest(tolerance, points) <= 0) return points;

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
  return mergeConvex(points, triangles).map((piece) => piece.map((at) => points[at]!));
}

/**
 * Ear clipping, on indices rather than on positions.
 *
 * Which matters, because a polygon with a hole bridged into it holds the same
 * point twice — the slit is one cut walked down and back — and every test here
 * used to ask "is this point one of the ear's corners" by comparing
 * coordinates. With duplicates that is the wrong question: the *other* copy
 * answers yes, tests get skipped that should not be, ears are accepted that
 * reach across the hole and rejected that are perfectly good, and clipping
 * stalls with a sixth of the shape still on the floor.
 *
 * Asked by position in the list instead, all three tests are exact:
 *
 * 1. The corner turns the way the polygon winds.
 * 2. No other corner lies strictly inside the ear. *Strictly*: a corner sitting
 *    exactly on the ear's edge is not inside it, and on a slit that happens
 *    constantly.
 * 3. The cut the ear makes stays inside the shape — it crosses no edge, and its
 *    middle is in the polygon rather than out in a notch or a hole. This is the
 *    one that stops a ring being clipped into a disc: an ear spanning the hole
 *    has a good corner and nothing inside it, and makes a cut straight through
 *    the middle of nothing.
 */
export function earClip(
  points: VectorPoint[],
  makeIndex: (bounds: Bounds) => SpatialIndex = (bounds) => new QuadIndex(bounds),
): number[][] {
  const count = points.length;
  if (count < 3) return [];
  const winding = signedArea(points) > 0 ? 1 : -1;

  /*
   * The same clipping as always, made fast without changing a single choice.
   *
   * It used to test every corner against every other corner and every edge, on
   * every round: cubic in the outline's length, which on a photographed region a
   * few hundred points long was most of a minute. Two things take that away.
   *
   * **Indexes** of the corners, the edges and each corner's ear triangle, so a
   * test looks only at what is near it (`spatial.ts`).
   *
   * **Remembering** each corner's answer between rounds. Clipping an ear changes
   * the polygon only inside that ear's triangle — a corner and two edges go, one
   * edge comes — so a corner whose own triangle's box does not overlap it gets the
   * same answer to every test as before: the removed corner cannot be inside it,
   * the changed edges cannot cross its cut, and the new edge and the two old ones
   * are crossed by any ray from outside the clipped triangle an even number of
   * times between them, so its middle is inside or outside exactly as it was. Only
   * the corners near the clip are asked again.
   *
   * Corners are still visited in their order in the outline and the fattest ear
   * still wins with the first one kept on a tie, so the triangles are the ones the
   * slow version made, to the bit.
   */
  const prev = new Int32Array(count);
  const next = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    prev[index] = (index - 1 + count) % count;
    next[index] = (index + 1) % count;
  }
  const alive = new Uint8Array(count).fill(1);
  let remaining = count;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const bounds: Bounds = { minX, minY, maxX, maxY };
  const corners = makeIndex(bounds);
  /** Each edge, filed under the corner it leaves from. */
  const edges = makeIndex(bounds);
  /** Each corner's ear triangle: itself and its two neighbours. */
  const ears = makeIndex(bounds);

  const fileEdge = (from: number) => {
    const a = points[from]!;
    const b = points[next[from]!]!;
    edges.insert(from, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
  };
  const fileEar = (at: number) => {
    const a = points[prev[at]!]!;
    const b = points[at]!;
    const c = points[next[at]!]!;
    ears.insert(
      at,
      Math.min(a.x, b.x, c.x),
      Math.min(a.y, b.y, c.y),
      Math.max(a.x, b.x, c.x),
      Math.max(a.y, b.y, c.y),
    );
  };
  for (let index = 0; index < count; index += 1) {
    const point = points[index]!;
    corners.insert(index, point.x, point.y, point.x, point.y);
    fileEdge(index);
    fileEar(index);
  }

  /** How good an ear this corner is right now, or -1 if it is not one. */
  const judge = (at: number): number => {
    const before = prev[at]!;
    const after = next[at]!;
    const previous = points[before]!;
    const ear = points[at]!;
    const following = points[after]!;

    // The two ends of a slit, which is not an ear but a fold.
    if (same(previous, following)) return -1;

    const turn =
      (ear.x - previous.x) * (following.y - ear.y) - (ear.y - previous.y) * (following.x - ear.x);
    if (turn * winding <= 0) return -1;

    let blocked = false;
    corners.query(
      Math.min(previous.x, ear.x, following.x),
      Math.min(previous.y, ear.y, following.y),
      Math.max(previous.x, ear.x, following.x),
      Math.max(previous.y, ear.y, following.y),
      (other) => {
        if (blocked || other === at || other === before || other === after) return;
        if (strictlyInside(points[other]!, previous, ear, following)) blocked = true;
      },
    );
    if (blocked) return -1;

    edges.query(
      Math.min(previous.x, following.x),
      Math.min(previous.y, following.y),
      Math.max(previous.x, following.x),
      Math.max(previous.y, following.y),
      (from) => {
        if (blocked) return;
        const to = next[from]!;
        if (from === before || to === before || from === after || to === after) return;
        if (from === at || to === at) return;
        if (segmentsCross(previous, following, points[from]!, points[to]!)) blocked = true;
      },
    );
    if (blocked) return -1;

    // The cut's middle is inside the shape: an even-odd ray to the right, which
    // only ever meets edges in its own row.
    const middle = { x: (previous.x + following.x) / 2, y: (previous.y + following.y) / 2 };
    let inside = false;
    edges.query(middle.x, middle.y, bounds.maxX, middle.y, (from) => {
      const a = points[next[from]!]!;
      const b = points[from]!;
      if (a.y > middle.y === b.y > middle.y) return;
      if (middle.x < ((b.x - a.x) * (middle.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    });
    if (!inside) return -1;

    /*
     * The fattest ear on offer, not the first one that will do.
     *
     * Taking the first leaves a fan of splinters along every curve, and a
     * splinter is a real problem rather than an untidiness: it is thinner than
     * a stroke, so the rule that says a piece that thin should be a stroke
     * fires on it — and a stroke is not part of the partition, so swapping one
     * in opens a seam down both of its long sides. Fifty-one of them took a
     * drawing from 825 wrong pixels to 1067.
     *
     * Measured by how square the triangle is: its shortest way across over its
     * longest, which is 0 for a splinter and highest for an equilateral one.
     */
    return squareness(previous, ear, following);
  };

  const quality = new Float64Array(count);
  const known = new Uint8Array(count);
  const out: number[][] = [];
  let guard = 0;

  while (remaining > 3 && guard < count * count + 64) {
    guard += 1;
    let clipped = -1;
    let fattest = -1;
    for (let at = 0; at < count; at += 1) {
      if (!alive[at]) continue;
      if (!known[at]) {
        quality[at] = judge(at);
        known[at] = 1;
      }
      if (quality[at]! > fattest) {
        fattest = quality[at]!;
        clipped = at;
      }
    }

    if (clipped >= 0) out.push([prev[clipped]!, clipped, next[clipped]!]);

    /*
     * Nothing would clip. Before giving up, drop a corner that is on the
     * straight between its neighbours: it encloses no area, so losing it costs
     * the shape nothing, and it is usually the thing that was in the way.
     */
    if (clipped < 0) {
      for (let at = 0; at < count && clipped < 0; at += 1) {
        if (!alive[at]) continue;
        const previous = points[prev[at]!]!;
        const ear = points[at]!;
        const following = points[next[at]!]!;
        const turn =
          (ear.x - previous.x) * (following.y - ear.y) - (ear.y - previous.y) * (following.x - ear.x);
        if (Math.abs(turn) < 1e-9) clipped = at;
      }
    }
    // A polygon that will not clip at all is self-intersecting or degenerate.
    // Give back what has been found rather than looping, and let the caller
    // report it.
    if (clipped < 0) break;

    // Take the corner out, and forget what was known near it.
    const before = prev[clipped]!;
    const after = next[clipped]!;
    const a = points[before]!;
    const b = points[clipped]!;
    const c = points[after]!;
    const near = {
      minX: Math.min(a.x, b.x, c.x),
      minY: Math.min(a.y, b.y, c.y),
      maxX: Math.max(a.x, b.x, c.x),
      maxY: Math.max(a.y, b.y, c.y),
    };
    alive[clipped] = 0;
    remaining -= 1;
    next[before] = after;
    prev[after] = before;
    corners.remove(clipped);
    edges.remove(clipped);
    ears.remove(clipped);
    fileEdge(before);
    ears.query(near.minX, near.minY, near.maxX, near.maxY, (at) => {
      known[at] = 0;
    });
    known[before] = 0;
    known[after] = 0;
    fileEar(before);
    fileEar(after);
  }

  if (remaining === 3) {
    const last: number[] = [];
    for (let at = 0; at < count; at += 1) if (alive[at]) last.push(at);
    out.push(last);
  }
  return out;
}

/** How square a triangle is: its shortest way across over its longest side, 0..~0.87. */
function squareness(a: VectorPoint, b: VectorPoint, c: VectorPoint): number {
  const sides = [
    Math.hypot(b.x - a.x, b.y - a.y),
    Math.hypot(c.x - b.x, c.y - b.y),
    Math.hypot(a.x - c.x, a.y - c.y),
  ];
  const longest = Math.max(...sides);
  if (longest < 1e-9) return 0;
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  // Twice the area over the longest side is the altitude to it, which is the
  // narrowest the triangle is across.
  return (2 * area) / longest / longest;
}

/** Inside the triangle and not on its edge, which on a slit is the difference. */
function strictlyInside(point: VectorPoint, a: VectorPoint, b: VectorPoint, c: VectorPoint): boolean {
  const side = (p: VectorPoint, q: VectorPoint, r: VectorPoint) =>
    (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const one = side(point, a, b);
  const two = side(point, b, c);
  const three = side(point, c, a);
  if (one === 0 || two === 0 || three === 0) return false;
  return one > 0 === two > 0 && two > 0 === three > 0;
}

export function signedArea(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/**
 * Hertel-Mehlhorn: take the triangulation and rub out every cut that was not
 * earning its place.
 *
 * A cut between two pieces can go whenever the shape left behind is still
 * convex, and only the two corners the cut ended at can have stopped being so —
 * every other corner is untouched. So the test is two cross products rather
 * than a walk of the whole polygon, and what comes out is at most four times as
 * many pieces as the fewest possible.
 *
 * All of it on indices. Rubbing out cuts by comparing coordinates cannot work on
 * a shape with a hole bridged into it, because the slit puts the same point in
 * the list twice: "these two pieces share this edge" comes out true of an edge
 * at the *other* copy, and the merge that follows is convex, plausible, and
 * missing a bite out of the middle. A sixth of a ring went that way.
 */
export function mergeConvex(points: VectorPoint[], triangles: number[][]): number[][] {
  const pieces: Array<number[] | null> = triangles.map((piece) => [...piece]);

  // Which pieces each cut has on either side of it.
  const cuts = new Map<string, number[]>();
  const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let at = 0; at < pieces.length; at += 1) {
    const piece = pieces[at]!;
    for (let index = 0; index < piece.length; index += 1) {
      const edge = key(piece[index]!, piece[(index + 1) % piece.length]!);
      const sides = cuts.get(edge);
      if (sides) sides.push(at);
      else cuts.set(edge, [at]);
    }
  }

  const turnsRight = (before: number, corner: number, after: number) => {
    const a = points[before]!;
    const b = points[corner]!;
    const c = points[after]!;
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  };
  const winding = signedArea(points) > 0 ? 1 : -1;

  for (const [, sides] of cuts) {
    if (sides.length !== 2) continue;
    const [one, two] = sides as [number, number];
    const first = pieces[one];
    const second = pieces[two];
    if (!first || !second) continue;

    const joined = joinAlongSharedEdge(first, second);
    if (!joined || joined.length < 3) continue;

    /*
     * And it has to be the two of them, and nothing less.
     *
     * Two pieces either side of a slit can share more than one cut, and splicing
     * along one of them gives a perfectly convex polygon that is missing a bite
     * out of the middle — a sixth of a ring went that way. Areas add when a join
     * is real, so checking that they do catches it without having to reason
     * about which cut was which.
     */
    const want = areaOf(points, first) + areaOf(points, second);
    if (Math.abs(areaOf(points, joined) - want) > 1e-6 * Math.max(1, want)) continue;

    let convex = true;
    for (let index = 0; index < joined.length && convex; index += 1) {
      const before = joined[(index - 1 + joined.length) % joined.length]!;
      const corner = joined[index]!;
      const after = joined[(index + 1) % joined.length]!;
      if (turnsRight(before, corner, after) * winding < 0) convex = false;
    }
    if (!convex) continue;

    pieces[one] = joined;
    pieces[two] = null;
    // The cut is gone, so whatever the absorbed piece was beside is now beside
    // the piece that absorbed it.
    for (const [, other] of cuts) {
      for (let index = 0; index < other.length; index += 1) {
        if (other[index] === two) other[index] = one;
      }
    }
  }

  return pieces.filter((piece): piece is number[] => piece !== null && piece.length >= 3);
}

function areaOf(points: VectorPoint[], piece: number[]): number {
  let total = 0;
  for (let index = 0; index < piece.length; index += 1) {
    const a = points[piece[index]!]!;
    const b = points[piece[(index + 1) % piece.length]!]!;
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total / 2);
}

/** Two pieces sharing exactly one cut, as one piece. Indices, so no ambiguity. */
function joinAlongSharedEdge(one: number[], two: number[]): number[] | null {
  for (let a = 0; a < one.length; a += 1) {
    const a1 = one[a]!;
    const a2 = one[(a + 1) % one.length]!;
    for (let b = 0; b < two.length; b += 1) {
      const b1 = two[b]!;
      const b2 = two[(b + 1) % two.length]!;
      // The shared cut runs the other way round in the neighbour, because both
      // wind the same way.
      if (a1 !== b2 || a2 !== b1) continue;
      const joined = [
        ...one.slice(0, a + 1),
        ...two.slice(b + 1),
        ...two.slice(0, b),
      ];
      // A corner repeated across the seam says nothing and can go.
      return joined.filter((corner, index) => corner !== joined[(index + 1) % joined.length]);
    }
  }
  return null;
}

const same = (a: VectorPoint, b: VectorPoint) =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;


/* ------------------------------------------------------------------ *
 * The whole thing
 * ------------------------------------------------------------------ */

/**
 * What a boundary running through a hot block is granted: half the tolerance,
 * and twice the points.
 *
 * Both, because either alone does nothing. A tolerance cannot buy detail the
 * budget will not pay for — `toBudget` simplifies harder until a shape fits, so
 * against a binding budget a tighter tolerance changes not one point — and a
 * bigger budget buys nothing while the tolerance says there is nothing worth
 * keeping. Granting one and not the other is how a round of refinement comes
 * back with the identical drawing.
 */
const TIGHTEN = 0.5;
const ALLOWANCE = 2;

/** What a boundary is allowed to spend on itself. */
interface Budget {
  detail: Tolerance;
  maxPoints: number;
}

export function vectorize(
  image: Bitmap,
  options: VectorizeOptions,
  makeId: (prefix: string) => string,
): { image: VectorImage; report: VectorizeReport } {
  // Found once. Rounds of refinement change how the boundaries are *simplified*,
  // never where they are, so nothing above this needs doing twice.
  const found = findRegions(image, options);

  const plain: Budget = { detail: options.detail, maxPoints: options.maxPoints };
  let detail: (points: VectorPoint[]) => Budget = () => plain;
  let best = build(image, found, options, makeId, detail);
  const lab = sourceLab(image);
  let measured = difference(image, best.image, options, lab);

  /*
   * Round by round, spend the effort where the drawing is actually wrong.
   *
   * Rasterise what has been drawn, take the difference from the picture it came
   * from, and average that over a grid of blocks. A block's average is the
   * honest measure of "how bad is it around here" — one wrong pixel is noise and
   * a whole block wrong is a shape in the wrong place — and the worst blocks are
   * where a tighter tolerance buys something. Everywhere else keeps the loose
   * one, which is the whole reason this is affordable.
   */
  for (let round = 0; round < options.refineRounds; round += 1) {
    const hot = hotBlocks(measured.error, image.width, image.height, options);
    if (hot.blocks === 0) break;

    /*
     * Point by point, not arc by arc.
     *
     * An arc runs from junction to junction and can be the whole outline of a
     * head; tightening the arc spends anchors along every part of it that was
     * already exact, blows the budget, and the budget then loosens the lot back
     * again — so asking for a closer fit came back with a worse drawing.
     * Tightening only the points that lie in a block that came out wrong spends
     * them where the mistake is.
     */
    const rich: Budget = {
      detail: (point) => (hot.holds(point) ? options.detail * TIGHTEN : options.detail),
      maxPoints: options.maxPoints > 0 ? Math.ceil(options.maxPoints * ALLOWANCE) : 0,
    };
    detail = (points) => (hot.runsThrough(points) ? rich : plain);
    const next = build(image, found, options, makeId, detail);
    const score = difference(image, next.image, options, lab);
    // Only kept if it is actually better. Spending anchors on the worst part of
    // the picture almost always is, and "almost always" is not a reason to stop
    // checking — a round that comes back worse is the loop's answer that the
    // drawing is as close as this tolerance can take it.
    if (score.wrong >= measured.wrong) break;
    next.report.rounds = round + 1;
    next.report.hotBlocks = hot.blocks;
    best = next;
    measured = score;
  }

  best.report.wrongPixels = measured.plain;
  best.report.overNothing = measured.overNothing;
  return { image: best.image, report: best.report };
}

/** The picture as shapes, at whatever tolerance each boundary is granted. */
function build(
  image: Bitmap,
  found: ReturnType<typeof findRegions>,
  options: VectorizeOptions,
  makeId: (prefix: string) => string,
  detailAt: (points: VectorPoint[]) => Budget,
): { image: VectorImage; report: VectorizeReport } {
  const { width, height } = image;
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
    slivers: 0,
    joinedPolygons: 0,
    joinedLines: 0,
    transparent: found.transparent,
    edgePixels: found.edgePixels,
    rounds: 0,
    hotBlocks: 0,
    overNothing: 0,
    problems: [],
  };

  /*
   * Strokes first, because a stroke's region is not part of the partition.
   *
   * A stroke is drawn down the middle of its own band with a width, so the band
   * is already accounted for; leaving it in as an area too would put a polygon
   * under every line in the drawing.
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

  const shapes: VectorShape[] = [];
  const byId = new Map(found.regions.map((region) => [region.id, region]));

  /*
   * Every boundary in the picture, traced and simplified **once**.
   *
   * Two regions meeting along a boundary used to simplify it separately, each
   * moving it by up to the tolerance in whatever direction its own corners
   * wanted — which leaves a sliver of overlap down one side of every boundary
   * and a sliver of gap down the other. Sharing the arc means the two shapes
   * either side of it hold the same list of numbers, so they meet exactly, and
   * the picture costs fewer points than before because each boundary is only
   * paid for once.
   */
  const loops = traceShared(found.labels, width, height, (points, closed) => {
    const budget = detailAt(points);
    return toBudget(points, budget.detail, budget.maxPoints, closed ? 3 : 2, closed);
  });

  /*
   * Areas by what they cover, biggest first, then strokes.
   *
   * They no longer overlap, so this is not load-bearing for what the picture
   * looks like — it decides only what sits on top where a stroke crosses an
   * area, and it keeps the output in a stable, readable order.
   */
  const areas = [...loops]
    .filter(([id]) => byId.has(id) && !strokes.has(byId.get(id)!))
    .sort((a, b) => Math.abs(signedArea(b[1].outer)) - Math.abs(signedArea(a[1].outer)));

  const emit = (color: string, pieces: VectorPoint[][], pixels: Set<number>) => {
    for (const piece of pieces) {
      /*
       * A piece thinner than a stroke *is* a stroke — if it covers the same ink.
       *
       * A sliver of polygon is a mark with a width pretending to be an area: it
       * costs three or more anchors to say what two and a width say better, and
       * it is miserable to grab hold of in the editor. Measured across its
       * narrowest direction, which for a triangle is its shortest altitude.
       *
       * But it is also what a convex cut leaves along any curve, and *that* kind
       * of sliver must stay a polygon. The pieces of a region are a partition —
       * they tile it exactly, with no overlap and no gap — and a stroke is not
       * part of that partition. Swapping one in for a piece opens a seam down
       * both of its long sides, and on a finely traced boundary there are dozens
       * of them: measured, it took a drawing from 825 wrong pixels to 1034.
       *
       * So the swap is measured rather than assumed. A real thin limb is covered
       * better by a stroke than by the splinters it was cut into; a splinter of
       * a curve is not, and keeps its place in the partition.
       */
      const slim = asStroke(piece, options.lineWidth);
      if (slim && coversBetter(slim, piece, pixels, width)) {
        shapes.push({
          id: makeId('line'),
          kind: 'line',
          color,
          width: Math.max(0.5, Math.round(slim.width * 10) / 10),
          points: slim.points,
          curved: false,
          closed: false,
        } satisfies VectorLine);
        report.lines += 1;
        report.slivers += 1;
        continue;
      }
      shapes.push({ id: makeId('poly'), kind: 'polygon', color, points: piece } satisfies VectorPolygon);
      report.polygons += 1;
    }
    report.convexPieces += pieces.length;
  };

  for (const [id, region] of areas) {
    const own = byId.get(id)!;
    report.drawnPixels += own.pixels.length;

    const pieces = convexPieces(region);
    if (pieces.length === 0) {
      report.problems.push(`An area at ${describe(own, width)} could not be cut into convex pieces.`);
      continue;
    }
    emit(toHex(own.color), pieces, new Set(own.pixels));
  }

  for (const region of found.regions) {
    if (!strokes.has(region)) continue;
    const color = toHex(region.color);
    const pixels = new Set(region.pixels);
    report.drawnPixels += pixels.size;

    const paths = centreline(pixels, width, height);
    const lines = paths
      .map((path) => quickLine(path, region, paths, detailAt(path.points)))
      .filter((line): line is FittedLine => line !== null);

    const widest = Math.max(0, ...lines.map((line) => line.width));
    // With the real widths known, a squat blob that the thinness test let
    // through can still turn out to be an area rather than a stroke.
    if (lines.length === 0 || widest > options.lineWidth + 0.5) {
      report.thinButNotSeparating += 1;
      const loop = loops.get(region.id);
      if (loop) emit(color, convexPieces(loop), pixels);
      continue;
    }

    for (const line of lines) {
      shapes.push({
        id: makeId('line'),
        kind: 'line',
        color,
        width: Math.max(0.5, Math.round(line.width * 10) / 10),
        points: line.points,
        // A loop is always a curve by the straight-line test, since its ends are
        // the same point. Judge it on its corners instead.
        curved: line.closed
          ? line.points.length > 6
          : looksCurved(line.points, options.curveThreshold),
        closed: line.closed,
      } satisfies VectorLine);
      report.lines += 1;
    }
  }

  if (!options.joinShapes) return { image: { width, height, shapes }, report };

  /*
   * Last, and after the slivers have been turned into strokes.
   *
   * The convex cut is still what decides which parts of a region are too thin to
   * be an area, because that is a question about a piece and not about the whole
   * region. Joining first would leave nothing to ask it of. What survives as a
   * polygon is then put back together with its neighbours of the same color.
   */
  const polygons = joinPolygons(shapes);
  const lines = joinLines(polygons.shapes, options.joinGap);
  report.joinedPolygons = polygons.joined;
  report.joinedLines = lines.joined;
  report.polygons -= polygons.joined;
  report.lines -= lines.joined;
  return { image: { width, height, shapes: lines.shapes }, report };
}

/* ------------------------------------------------------------------ *
 * 5. Measuring, and where to spend the next round
 * ------------------------------------------------------------------ */

/**
 * Painting over a part of the picture that is not there is worth this many
 * ordinary wrong pixels.
 *
 * Nothing at all should be drawn where the source is transparent, and a plain
 * one-for-one count does not say so loudly enough: a shape that bulges into the
 * empty half of the picture scores the same as one a shade off the right color,
 * and the round of refinement goes to the shade. It is also thin and spread out
 * — a boundary overshooting by a pixel along its length — so against a block
 * average it disappears next to a patch of solidly wrong color.
 *
 * Weighted up, a block with any of it in stands out, which is what makes the
 * next round pull the boundary back onto the edge of what is actually there.
 */
const OVER_NOTHING = 16;

export interface Difference {
  /** Wrong pixels, weighted: what a round of refinement is judged on. */
  wrong: number;
  /** Wrong pixels, counted one each: what the report quotes, because it is a count. */
  plain: number;
  /** How wrong each pixel is, 0 for right, up to `OVER_NOTHING` for painted nothing. */
  error: Float32Array;
  /** Of those, the ones painted where the picture is not there at all. */
  overNothing: number;
}

/**
 * Rasterise the drawing and take the difference from what it was drawn from.
 *
 * Measured once at the end of a round rather than per candidate shape. The fit
 * this replaced asked the question hundreds of times a shape and that was most
 * of what the flow spent its time on; asking it once over the whole picture says
 * just as much about whether the answer is any good, and costs one pass.
 */
/**
 * Every pixel of the source in OKLab, three numbers a pixel.
 *
 * Worked out once per decomposition and handed to every `difference`, which
 * used to convert each source pixel again on every round — two thirds of the
 * time an 800-pixel drawing took was spent converting the same colors over and
 * over. The same arithmetic as `colorDistance`, so every comparison comes out
 * exactly as it did.
 */
export function sourceLab(source: Bitmap): Float64Array {
  const lab = new Float64Array(source.width * source.height * 3);
  const seen = new Map<number, number>();
  for (let index = 0; index < source.width * source.height; index += 1) {
    const at = index * 4;
    const packed = (source.data[at]! << 16) | (source.data[at + 1]! << 8) | source.data[at + 2]!;
    // Flat artwork is a few colors across a great many pixels, so converting
    // each color once and copying it is most of the saving.
    const known = seen.get(packed);
    if (known !== undefined) {
      lab[index * 3] = lab[known * 3]!;
      lab[index * 3 + 1] = lab[known * 3 + 1]!;
      lab[index * 3 + 2] = lab[known * 3 + 2]!;
      continue;
    }
    const color = toOklab({ r: source.data[at]!, g: source.data[at + 1]!, b: source.data[at + 2]! });
    lab[index * 3] = color.L;
    lab[index * 3 + 1] = color.a;
    lab[index * 3 + 2] = color.b;
    seen.set(packed, index);
  }
  return lab;
}

export function difference(
  source: Bitmap,
  drawn: VectorImage,
  options: VectorizeOptions,
  lab: Float64Array = sourceLab(source),
): Difference {
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

  // The drawing's colors in OKLab, once each: a drawing has a few dozen.
  const painting = new Map<number, [number, number, number]>();
  const paintedLab = (packed: number): [number, number, number] => {
    let known = painting.get(packed);
    if (!known) {
      const color = toOklab({ r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 });
      known = [color.L, color.a, color.b];
      painting.set(packed, known);
    }
    return known;
  };

  const error = new Float32Array(width * height);
  let wrong = 0;
  let plain = 0;
  let overNothing = 0;
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    const clear = source.data[at + 3]! <= options.alphaFloor;
    const got = painted[index]!;

    let cost = 0;
    if (clear) {
      if (got >= 0) {
        cost = OVER_NOTHING;
        overNothing += 1;
      }
    } else if (got < 0) cost = 1;
    else {
      const [L, a, b] = paintedLab(got);
      const distance =
        100 * Math.hypot(L - lab[index * 3]!, a - lab[index * 3 + 1]!, b - lab[index * 3 + 2]!);
      // Judged by eye rather than by byte: a pixel a shade off is not wrong.
      cost = distance > 8 ? 1 : 0;
    }
    error[index] = cost;
    wrong += cost;
    if (cost > 0) plain += 1;
  }
  return { wrong, plain, error, overNothing };
}

/** How much worse than the picture's own average a block has to be to be hot. */
const WORSE_THAN_AVERAGE = 2;

export interface HotBlocks {
  /** How many blocks were judged hot. */
  blocks: number;
  /** Does this run of points pass through one? */
  runsThrough(points: VectorPoint[]): boolean;
  /** Is this one point in one? */
  holds(point: VectorPoint): boolean;
}

/**
 * The blocks of the picture that are worst, by the average error over each.
 *
 * Averaged rather than totalled, so a small block of solid wrong outranks a
 * large block with a scattering of it. Scattered error is the drawing being a
 * shade off; concentrated error is a shape in the wrong place, and a shape in
 * the wrong place is the thing another round can fix.
 */
export function hotBlocks(
  error: Float32Array,
  width: number,
  height: number,
  options: VectorizeOptions,
): HotBlocks {
  const size = Math.max(4, Math.round(options.hotspotBlock));
  const across = Math.ceil(width / size);
  const down = Math.ceil(height / size);

  const totals = new Float64Array(across * down);
  const counts = new Int32Array(across * down);
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / size) * across;
    for (let x = 0; x < width; x += 1) {
      const block = row + Math.floor(x / size);
      totals[block]! += error[y * width + x]!;
      counts[block]! += 1;
    }
  }

  const averages = Array.from(totals, (total, block) => {
    const count = counts[block] ?? 0;
    return { block, average: count > 0 ? total / count : 0 };
  }).filter((entry) => entry.average > 0);
  averages.sort((a, b) => b.average - a.average);

  /*
   * Worse than the picture, not merely the worst of it.
   *
   * Every block along an edge has a pixel or two wrong in it, so a plain "worst
   * fifth" on a drawing that is already good marks a fifth of the picture as a
   * hotspot, and the round that follows spends anchors all over a drawing with
   * nothing much wrong with it — three times the polygons for a seventh less
   * error. A block has to be twice the picture's own average to count, which on
   * a good drawing is almost nowhere and on a bad one is exactly where the
   * trouble is.
   */
  const mean = averages.reduce((sum, entry) => sum + entry.average, 0) / Math.max(1, averages.length);
  const standOut = averages.filter((entry) => entry.average >= mean * WORSE_THAN_AVERAGE);
  /*
   * Unless nothing stands out, in which case the worst of an even spread is
   * still the worst. "Twice the average" has nothing to say when every block is
   * about as wrong as every other — a picture with one block in it cannot have a
   * block twice its own average — and answering "no hotspots" there would stop
   * the refinement on exactly the drawings that need it most.
   */
  const worthIt = standOut.length > 0 ? standOut : averages;

  const share = Math.max(0, Math.min(1, options.hotspotShare));
  const take = Math.min(worthIt.length, Math.max(1, Math.round(averages.length * share)));
  const hot = new Uint8Array(across * down);
  let blocks = 0;
  for (let index = 0; index < take; index += 1) {
    hot[worthIt[index]!.block] = 1;
    blocks += 1;
  }

  return {
    blocks,
    /*
     * Asked of the run itself rather than of the box round it. A boundary can be
     * long and thin — the outline of a face crosses most of the picture — and
     * the box round one of those touches a hot block wherever the block is, so
     * asking the box is asking nothing.
     */
    runsThrough(points) {
      for (const point of points) {
        const column = Math.floor(point.x / size);
        const row = Math.floor(point.y / size);
        if (column < 0 || row < 0 || column >= across || row >= down) continue;
        if (hot[row * across + column]) return true;
      }
      return false;
    },
    holds(point) {
      const column = Math.floor(point.x / size);
      const row = Math.floor(point.y / size);
      if (column < 0 || row < 0 || column >= across || row >= down) return false;
      return hot[row * across + column] === 1;
    },
  };
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
  detail: Tolerance,
  maxPoints: number,
  minimum: number,
  closed = false,
): VectorPoint[] {
  // A budget is met by loosening *everything* in proportion, so a boundary that
  // is tight in one place and loose in another keeps that shape as it gives
  // points up.
  const scaled = (by: number): Tolerance =>
    typeof detail === 'number' ? detail * by : (point) => detail(point) * by;
  const reduce = (by: number) =>
    closed ? simplifyClosed(points, scaled(by)) : simplify(points, scaled(by));
  const cap = Math.max(minimum, maxPoints);

  let out = reduce(1);

  if (maxPoints > 0 && out.length > cap) {
    /*
     * The *smallest* tolerance that fits the budget, found by bisection.
     *
     * The obvious way — double the tolerance until it fits — overshoots, and
     * overshooting here is not a small matter. A boundary needing twenty-one
     * points at 0.45 goes 0.81, 1.46, 2.62 and lands at 4.7, which is three
     * times looser than the setting ever asked for, while the boundary beside it
     * fits on the first try and stays sharp. The drawing then has some edges
     * traced and some flattened, and — measured — asking for *more* points came
     * back with more error than asking for fewer, which is not a thing a setting
     * should ever do.
     *
     * Looser never means more points, so the smallest tolerance that fits can be
     * found exactly, and no boundary is loosened further than its own budget
     * requires.
     */
    let tight = 1;
    let loose = 1;
    let fitted: VectorPoint[] | null = null;
    for (let step = 0; step < 20 && !fitted; step += 1) {
      loose = 2 ** (step + 1);
      const tried = reduce(loose);
      if (tried.length <= cap) fitted = tried;
    }
    if (fitted) {
      for (let step = 0; step < 12; step += 1) {
        const middle = (tight + loose) / 2;
        const tried = reduce(middle);
        if (tried.length <= cap) {
          loose = middle;
          fitted = tried;
        } else {
          tight = middle;
        }
      }
      out = fitted;
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
  let by = 1;
  for (let round = 0; round < 8; round += 1) {
    by /= 2;
    const tighter = reduce(by);
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
  budget: Budget,
): FittedLine | null {
  const anchors = toBudget(path.points, budget.detail, budget.maxPoints, path.closed ? 3 : 2, path.closed);
  if (anchors.length < (path.closed ? 3 : 2)) return null;

  const total = all.reduce(
    (sum, other) => sum + pathLength(other.points) + (other.closed ? closingStep(other.points) : 0),
    0,
  );
  const width = total < 1e-6 ? 1 : region.pixels.length / total;
  return { points: anchors, width, closed: path.closed };
}

/** A region's boundary, holes cut in, as convex pieces that tile it exactly. */
export function convexPieces(loops: RegionLoops): VectorPoint[][] {
  if (loops.outer.length < 3) return [];
  const holes = loops.holes.filter((hole) => hole.length >= 3);
  if (holes.length === 0) return toConvexPieces(loops.outer);
  return toConvexPieces(bridgeHoles(loops.outer, holes));
}

/**
 * A ring with holes in it, as one ring.
 *
 * Ear clipping wants a simple polygon, and a shape with a hole is not one. The
 * old answer was to ignore the hole and fill the outer boundary, which turns a
 * black outline into a black disc and a washer into a coin — right only as long
 * as something is painted over the middle afterwards, and plainly wrong when
 * what is in the middle is nothing at all.
 *
 * So each hole is joined to the outside by a **bridge**: a cut from a hole
 * vertex to an outer vertex, walked down one side and back up the other. The
 * ring stays one closed loop, with a slit of zero width where the cut is, and
 * the hole is genuinely empty.
 *
 * The bridge is chosen as the shortest cut that crosses nothing. That is more
 * work than the usual ray-cast rule and far easier to be sure of, and the lists
 * are short — a shape has a handful of anchors by the time it gets here, not a
 * thousand.
 */
export function bridgeHoles(outer: VectorPoint[], holes: VectorPoint[][]): VectorPoint[] {
  // Holes have to wind against the ring they are cut into, or the slit turns
  // itself inside out and the "hole" is drawn as another lobe of the shape.
  const facing = signedArea(outer) > 0 ? 1 : -1;
  const pending = holes
    .map((hole) => (signedArea(hole) * facing > 0 ? [...hole].reverse() : [...hole]))
    // Biggest first: a big hole has the most ways to reach the outside, and
    // cutting it first leaves the small ones the room they need.
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

  /*
   * Every edge a cut may not cross, filed once for the whole shape.
   *
   * That is the ring's edges and every hole's. Bridging a hole in adds nothing
   * to that but the bridge itself — the hole's own edges were already there, and
   * the ring keeps every edge it had — so the file is kept up to date by adding
   * the one new edge rather than being rebuilt for every hole.
   */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of [outer, ...pending]) {
    for (const point of loop) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  const walls = new QuadIndex({ minX, minY, maxX, maxY });
  const starts: VectorPoint[] = [];
  const ends: VectorPoint[] = [];
  const wall = (c: VectorPoint, d: VectorPoint) => {
    walls.insert(starts.length, Math.min(c.x, d.x), Math.min(c.y, d.y), Math.max(c.x, d.x), Math.max(c.y, d.y));
    starts.push(c);
    ends.push(d);
  };
  for (const loop of [outer, ...pending]) {
    for (let at = 0; at < loop.length; at += 1) wall(loop[at]!, loop[(at + 1) % loop.length]!);
  }
  const crosses = (a: VectorPoint, b: VectorPoint): boolean => {
    let found = false;
    walls.query(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), (edge) => {
      if (found) return;
      const c = starts[edge]!;
      const d = ends[edge]!;
      // An edge that begins or ends at the cut's own endpoints is not a crossing —
      // that is the cut arriving, which is the whole point of it.
      if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return;
      if (segmentsCross(a, b, c, d)) found = true;
    });
    return found;
  };

  let ring = [...outer];
  for (const hole of pending) {
    const bridge = shortestCut(ring, hole, crosses);
    if (!bridge) continue;
    const [at, from] = bridge;
    wall(ring[at]!, hole[from]!);
    ring = [
      ...ring.slice(0, at + 1),
      ...hole.slice(from),
      ...hole.slice(0, from + 1),
      ring[at]!,
      ...ring.slice(at + 1),
    ];
  }
  return ring;
}

/** The shortest cut from the ring to a hole that crosses no other edge. */
function shortestCut(
  ring: VectorPoint[],
  hole: VectorPoint[],
  crosses: (a: VectorPoint, b: VectorPoint) => boolean,
): [number, number] | null {
  /*
   * Shortest first, taken off a heap rather than sorting every pair.
   *
   * Only the first few are ever looked at — the shortest cut almost always
   * crosses nothing — so sorting all of ring × hole pairs was work thrown away.
   * Ordered by length and then by position, which is exactly the order the
   * stable sort it replaces left ties in, so the same cut is chosen.
   */
  const width = hole.length;
  const total = ring.length * width;
  const lengths = new Float64Array(total);
  for (let at = 0; at < ring.length; at += 1) {
    for (let from = 0; from < width; from += 1) {
      lengths[at * width + from] = Math.hypot(ring[at]!.x - hole[from]!.x, ring[at]!.y - hole[from]!.y);
    }
  }
  const before = (one: number, two: number) =>
    lengths[one]! < lengths[two]! || (lengths[one] === lengths[two] && one < two);
  const heap = new Int32Array(total);
  for (let at = 0; at < total; at += 1) heap[at] = at;
  const sift = (start: number, size: number) => {
    let at = start;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let least = at;
      if (left < size && before(heap[left]!, heap[least]!)) least = left;
      if (right < size && before(heap[right]!, heap[least]!)) least = right;
      if (least === at) return;
      const swap = heap[at]!;
      heap[at] = heap[least]!;
      heap[least] = swap;
      at = least;
    }
  };
  for (let at = Math.floor(total / 2) - 1; at >= 0; at -= 1) sift(at, total);

  for (let size = total; size > 0; size -= 1) {
    const pair = heap[0]!;
    heap[0] = heap[size - 1]!;
    sift(0, size - 1);
    const at = Math.floor(pair / width);
    const from = pair % width;
    if (!crosses(ring[at]!, hole[from]!)) return [at, from];
  }
  return null;
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

/** How many times longer than it is wide a piece must be to be a mark. */
const ELONGATED = 3;

/**
 * Does drawing this piece as a stroke cover its ink at least as well as filling
 * it does?
 *
 * Judged over the piece's own box against the pixels of the region it came from,
 * so it costs what the piece is worth rather than what the picture is. A tie
 * goes to the stroke, because two anchors and a width beat three anchors when
 * they say the same thing.
 */
function coversBetter(
  slim: { points: VectorPoint[]; width: number },
  piece: VectorPoint[],
  pixels: Set<number>,
  imageWidth: number,
): boolean {
  const box = boxOf(
    piece.map((point) => Math.round(point.y) * imageWidth + Math.round(point.x)),
    imageWidth,
    2,
  );
  if (box.width <= 0 || box.height <= 0) return false;

  const filled = coverageFor(box);
  fillInto(piece, box, filled);
  const stroked = coverageFor(box);
  strokeInto(slim.points, slim.width, box, stroked);

  let asArea = 0;
  let asMark = 0;
  for (let row = 0; row < box.height; row += 1) {
    for (let column = 0; column < box.width; column += 1) {
      const x = box.x + column;
      const y = box.y + row;
      if (x < 0 || y < 0 || x >= imageWidth) continue;
      const index = y * imageWidth + x;
      const ink = pixels.has(index);
      const at = row * box.width + column;
      if (filled[at]! >= 128 !== ink) asArea += 1;
      if (stroked[at]! >= 128 !== ink) asMark += 1;
    }
  }
  return asMark <= asArea;
}

/**
 * A convex piece measured across its narrowest direction, as a stroke — or
 * `null` if it is an area: wide enough, or too short to be a mark.
 *
 * The narrowest direction of a convex shape is always across one of its edges,
 * so trying each edge in turn finds it exactly. For a triangle that is its
 * shortest altitude, which is what "the minimum width of any triangle" means.
 *
 * What comes back runs the length of the piece along the middle of it, so the
 * stroke covers the same ink the polygon did with two anchors instead of three
 * or more.
 */
export function asStroke(
  piece: VectorPoint[],
  lineWidth: number,
): { points: VectorPoint[]; width: number } | null {
  if (piece.length < 3) return null;

  let width = Infinity;
  let across: VectorPoint = { x: 1, y: 0 };
  for (let index = 0; index < piece.length; index += 1) {
    const a = piece[index]!;
    const b = piece[(index + 1) % piece.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    // The edge's outward normal, and how far the furthest vertex is along it.
    const nx = -(b.y - a.y) / length;
    const ny = (b.x - a.x) / length;
    let deepest = 0;
    for (const point of piece) {
      deepest = Math.max(deepest, Math.abs((point.x - a.x) * nx + (point.y - a.y) * ny));
    }
    if (deepest < width) {
      width = deepest;
      across = { x: nx, y: ny };
    }
  }
  if (!Number.isFinite(width) || width > lineWidth) return null;

  // Along the piece is across the narrow way, turned a quarter.
  const along = { x: -across.y, y: across.x };
  let low = Infinity;
  let high = -Infinity;
  let nearSide = Infinity;
  let farSide = -Infinity;
  for (const point of piece) {
    const t = point.x * along.x + point.y * along.y;
    const u = point.x * across.x + point.y * across.y;
    low = Math.min(low, t);
    high = Math.max(high, t);
    nearSide = Math.min(nearSide, u);
    farSide = Math.max(farSide, u);
  }
  if (high - low < 1e-6) return null;

  /*
   * Thin is half the rule here too.
   *
   * A mark has a length. A triangle a pixel wide and two long is not a stroke,
   * it is a scrap of one — and drawn as a stroke it is a round-capped blob of
   * roughly the right area in roughly the wrong place. At a tight tolerance a
   * boundary is made of scraps like that by the hundred, and turning them all
   * into strokes takes a drawing that was 1.2% wrong to 4.7%. Measured.
   *
   * Long enough to be a mark is the same question the region test asks, so it
   * gets the same kind of answer: three times longer than it is wide.
   */
  if (high - low < width * ELONGATED) return null;

  const middle = (nearSide + farSide) / 2;
  const on = (t: number): VectorPoint => ({
    x: along.x * t + across.x * middle,
    y: along.y * t + across.y * middle,
  });
  /*
   * Its area over its length, not the width that made it a sliver.
   *
   * A triangle tapers: at its base it is as wide as the narrowest measure and at
   * its point it is nothing, so a band of the widest part covers half again too
   * much ink and a band of the narrowest covers half too little. Area over
   * length is the width of the rectangle that covers the same, which is the same
   * rule a drawn stroke's width is measured by.
   */
  const covering = Math.abs(signedArea(piece)) / (high - low);
  return { points: [on(low), on(high)], width: Math.max(Math.min(covering, width), 0.5) };
}



/* ------------------------------------------------------------------ *
 * The slow path
 *
 * Everything below is only reached with `refine` turned on. It measures each
 * candidate against the pixels instead of trusting the trace, which finds a
 * better answer and costs far more time — worth it for a final pass over a
 * drawing you are keeping, not for the twenty you throw away first.
 * ------------------------------------------------------------------ */




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
