import type { VectorPoint } from './vector';

/**
 * Fitting shapes to pixels.
 *
 * The first decomposition traced outlines and simplified them by a tolerance in
 * pixels, which asks the wrong question. "Is this anchor within 1.2px of the
 * traced path" says nothing about whether the shape that comes out **covers the
 * color it is standing for**. A corner cut off a square is well within any
 * tolerance and leaves a wedge of the picture unpainted.
 *
 * So shapes are scored against the pixels instead. A candidate is drawn, and
 * compared with what it is meant to be:
 *
 * - **missed** — pixels of this color the shape failed to cover.
 * - **extra** — pixels the shape covers that are not this color.
 *
 * Both are wrong in the same way and count the same. Against that sits the cost
 * of the shape itself: every anchor and every polygon is worth something, or the
 * best answer is always to trace each pixel exactly. The weights are settings,
 * because where that balance sits is a matter of what the drawing is for.
 */

/**
 * One byte a pixel: **how much** of it a shape covers, 0 to 255.
 *
 * Fractional rather than yes-or-no, because yes-or-no cannot see the thing this
 * is for. A band two units wide laid over three pixels of ink paints the middle
 * one fully and each outer one half; thresholded at "more than half covered"
 * that is indistinguishable from a band three units wide, so the search reports
 * 2 where the ink is 3 and the drawing comes out a third too thin. Keeping the
 * halves is what makes the difference measurable.
 */
export type Coverage = Uint8Array;

/** Fully covered. */
const FULL = 255;

/**
 * Which pixels a fit is not judged on, by image index.
 *
 * A predicate rather than a mask, so a candidate can be scored over whatever box
 * suits it. A stroke occupies a fraction of the region it belongs to, and
 * scoring every candidate width over the whole region's box — most of it empty —
 * was the single most expensive thing this file did.
 */
export type Hidden = (imageIndex: number) => boolean;

/** The part of the image a fit is judged over, so nothing walks the whole picture. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitWeights {
  /** What one wrong pixel costs. */
  pixel: number;
  /** What one anchor costs, in the same units. */
  point: number;
  /** What one polygon costs, on top of its anchors. */
  polygon: number;
}

export const DEFAULT_FIT_WEIGHTS: FitWeights = { pixel: 1, point: 6, polygon: 40 };

export interface Mismatch {
  /** Pixels that should be covered and are not. */
  missed: number;
  /** Pixels that are covered and should not be. */
  extra: number;
  /** The two added up: how wrong the shape is. */
  wrong: number;
  /** How many pixels it was trying to cover, for reading `wrong` against. */
  target: number;
}

export function boxOf(pixels: Iterable<number>, imageWidth: number, pad = 0): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of pixels) {
    const x = index % imageWidth;
    const y = (index - x) / imageWidth;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 1 + pad * 2,
    height: maxY - minY + 1 + pad * 2,
  };
}

/** A scratch buffer for one box, reused across candidates. */
export function coverageFor(box: Box): Coverage {
  return new Uint8Array(Math.max(0, box.width) * Math.max(0, box.height));
}

/**
 * Fill a closed outline into a box, by scanline, even-odd.
 *
 * Coordinates are the image's, and the box says which part of it is being drawn
 * — so a candidate for one small region costs what that region is worth rather
 * than what the picture is.
 */
export function fillInto(outline: VectorPoint[], box: Box, into: Coverage): Coverage {
  if (outline.length < 3 || box.width <= 0 || box.height <= 0) return into;

  let top = Infinity;
  let bottom = -Infinity;
  for (const point of outline) {
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }
  const first = Math.max(box.y, Math.ceil(top - 0.5));
  const last = Math.min(box.y + box.height - 1, Math.floor(bottom - 0.5) + 1);

  const crossings: number[] = [];
  for (let y = first; y <= last; y += 1) {
    crossings.length = 0;
    const scan = y + 0.5;
    for (let index = 0; index < outline.length; index += 1) {
      const a = outline[index]!;
      const b = outline[(index + 1) % outline.length]!;
      if (a.y === b.y) continue;
      const lower = Math.min(a.y, b.y);
      const upper = Math.max(a.y, b.y);
      // Half-open on y, so a vertex sitting on a scanline counts once rather
      // than twice or not at all — otherwise a shape leaks along flat edges.
      if (scan < lower || scan >= upper) continue;
      crossings.push(a.x + ((scan - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (crossings.length < 2) continue;
    crossings.sort((one, two) => one - two);
    const row = (y - box.y) * box.width;
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(box.x, Math.ceil(crossings[pair]! - 0.5));
      const to = Math.min(box.x + box.width - 1, Math.floor(crossings[pair + 1]! - 0.5));
      for (let x = from; x <= to; x += 1) into[row + (x - box.x)] = FULL;
    }
  }
  return into;
}

/** Draw a stroke of a given width into a box, as a run of round-capped segments. */
export function strokeInto(
  points: VectorPoint[],
  width: number,
  box: Box,
  into: Coverage,
): Coverage {
  if (points.length === 0 || box.width <= 0 || box.height <= 0) return into;
  const radius = Math.max(0.5, width / 2);

  /*
   * A pixel counts as covered when the band covers at least half of it, not when
   * it happens to contain its centre.
   *
   * The centre rule is off by up to a whole pixel and always in the same
   * direction, and it is off in a way that hides itself: a band of width 2 and a
   * band of width 3 put the same pixels on a straight vertical stroke, so the
   * search finds them equally good and reports the narrower one. The drawing then
   * strokes at 2 where the ink is 3, and a third of every line is missing.
   *
   * Four samples a pixel, covered on two, measures the area instead. Four is
   * enough: it resolves the half-pixel the centre rule loses, which is the whole
   * of the error.
   */
  // Sixteen samples a pixel, so coverage is known to a sixteenth. Enough to tell
  // a half-painted pixel from a full one, which is the whole of the question.
  const OFFSETS = [0.125, 0.375, 0.625, 0.875];
  const disc = (cx: number, cy: number) => {
    const from = Math.max(box.x, Math.floor(cx - radius - 1));
    const to = Math.min(box.x + box.width - 1, Math.ceil(cx + radius));
    const up = Math.max(box.y, Math.floor(cy - radius - 1));
    const down = Math.min(box.y + box.height - 1, Math.ceil(cy + radius));
    for (let y = up; y <= down; y += 1) {
      const row = (y - box.y) * box.width;
      for (let x = from; x <= to; x += 1) {
        const at = row + (x - box.x);
        if (into[at] === FULL) continue;
        let inside = 0;
        for (const ox of OFFSETS) {
          const dx = x + ox - cx;
          for (const oy of OFFSETS) {
            const dy = y + oy - cy;
            if (dx * dx + dy * dy <= radius * radius) inside += 1;
          }
        }
        if (inside === 0) continue;
        // A stroke is one shape, so overlapping stamps along it do not add up —
        // the most any stamp covers is what the stroke covers.
        const covered = Math.round((inside / 16) * FULL);
        if (covered > into[at]!) into[at] = covered;
      }
    }
  };

  if (points.length === 1) {
    disc(points[0]!.x, points[0]!.y);
    return into;
  }
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      disc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }
  return into;
}

/**
 * How wrong a drawn candidate is, against the pixels it stands for.
 *
 * `hidden` marks pixels that something drawn **after** this shape will paint
 * over, and they are not counted either way. That is not a leniency, it is what
 * the picture actually does: shapes are painted in order, and a pixel takes the
 * color of the last shape covering it.
 *
 * Without it, every enclosing shape is punished for the things inside it. A
 * background is one region with the whole picture standing on top of it; scored
 * naively it is "wrong" everywhere the subject is, and the fit responds by
 * eating the background away from its neighbours — which leaves real gaps that
 * nothing fills, because the thing it was overlapping was going to cover that
 * seam. It is also what lets an area run *under* a stroke instead of stopping
 * at its edge, and a stroke that turns out narrower than the gap it was traced
 * from no longer leaves a hairline of background showing through.
 */
export function compare(
  target: Set<number>,
  drawn: Coverage,
  box: Box,
  imageWidth: number,
  hidden?: Hidden,
): Mismatch {
  let missed = 0;
  let extra = 0;
  for (let y = 0; y < box.height; y += 1) {
    const imageY = box.y + y;
    const row = y * box.width;
    for (let x = 0; x < box.width; x += 1) {
      const at = row + x;
      const index = imageY * imageWidth + (box.x + x);
      if (hidden?.(index)) continue;
      const covered = drawn[at]!;
      const wanted = target.has(index) ? FULL : 0;
      // Counted as fractions of a pixel, so half a pixel left unpainted is half
      // a pixel wrong rather than nothing or everything.
      if (covered < wanted) missed += (wanted - covered) / FULL;
      else if (covered > wanted) extra += (covered - wanted) / FULL;
    }
  }
  return { missed, extra, wrong: missed + extra, target: target.size };
}

export function cost(
  mismatch: Mismatch,
  points: number,
  polygons: number,
  weights: FitWeights,
): number {
  return mismatch.wrong * weights.pixel + points * weights.point + polygons * weights.polygon;
}

/* ------------------------------------------------------------------ *
 * Fitting a filled region
 * ------------------------------------------------------------------ */

export interface PolygonFit {
  pieces: VectorPoint[][];
  mismatch: Mismatch;
  cost: number;
}

/**
 * Score a set of convex pieces against the region they stand for.
 *
 * Pieces are drawn into one coverage map rather than scored separately, because
 * two pieces sharing an edge cover it once between them and scoring them apart
 * would count that seam twice.
 */
export function scorePieces(
  pieces: VectorPoint[][],
  target: Set<number>,
  box: Box,
  imageWidth: number,
  weights: FitWeights,
  scratch?: Coverage,
  hidden?: Hidden,
): PolygonFit {
  const drawn = scratch ?? coverageFor(box);
  drawn.fill(0);
  for (const piece of pieces) fillInto(piece, box, drawn);
  const mismatch = compare(target, drawn, box, imageWidth, hidden);
  const points = pieces.reduce((sum, piece) => sum + piece.length, 0);
  return { pieces, mismatch, cost: cost(mismatch, points, pieces.length, weights) };
}

/**
 * Drop anchors one at a time, keeping every drop that pays for itself.
 *
 * A point costs what the weights say it costs, so a point earns its place only
 * by covering pixels no cheaper shape would. Greedy and to fixed point: the
 * cheapest drop is taken, then the question is asked again, because removing one
 * anchor changes what its neighbours are worth.
 */
export function prunePoints(
  pieces: VectorPoint[][],
  target: Set<number>,
  box: Box,
  imageWidth: number,
  weights: FitWeights,
  minimum = 3,
  hidden?: Hidden,
): PolygonFit {
  const scratch = coverageFor(box);
  let current = pieces.map((piece) => [...piece]);
  let best = scorePieces(current, target, box, imageWidth, weights, scratch, hidden);

  for (let round = 0; round < 400; round += 1) {
    let bestDrop: { piece: number; point: number; fit: PolygonFit } | null = null;

    for (let piece = 0; piece < current.length; piece += 1) {
      if (current[piece]!.length <= minimum) continue;
      for (let point = 0; point < current[piece]!.length; point += 1) {
        const candidate = current.map((existing, index) =>
          index === piece ? existing.filter((_, at) => at !== point) : existing,
        );
        const fit = scorePieces(candidate, target, box, imageWidth, weights, scratch, hidden);
        if (fit.cost >= best.cost) continue;
        if (!bestDrop || fit.cost < bestDrop.fit.cost) bestDrop = { piece, point, fit };
      }
    }

    if (!bestDrop) break;
    current = bestDrop.fit.pieces.map((piece) => [...piece]);
    best = { ...bestDrop.fit, pieces: current };
  }
  return { ...best, pieces: current };
}

/* ------------------------------------------------------------------ *
 * Fitting a stroke
 * ------------------------------------------------------------------ */

export interface StrokeFit {
  points: VectorPoint[];
  width: number;
  mismatch: Mismatch;
  cost: number;
}

export function scoreStroke(
  points: VectorPoint[],
  width: number,
  target: Set<number>,
  box: Box,
  imageWidth: number,
  weights: FitWeights,
  scratch?: Coverage,
  hidden?: Hidden,
): StrokeFit {
  const drawn = scratch ?? coverageFor(box);
  drawn.fill(0);
  strokeInto(points, width, box, drawn);
  const mismatch = compare(target, drawn, box, imageWidth, hidden);
  return { points, width, mismatch, cost: cost(mismatch, points.length, 0, weights) };
}

/**
 * How wide the stroke should be, and how far it should run.
 *
 * **Width.** Tried from thin to the configured maximum, keeping whichever covers
 * the ink best. That *is* "expand until it fills the contrast gap": the width
 * that leaves fewest wrong pixels is the width of the gap, found by measuring
 * rather than by estimating from area over length — which is off wherever a
 * stroke branches, and every crossing is a branch.
 *
 * **Length.** Each end is pushed outwards while pushing keeps helping, and
 * stopped the moment it does not. Thinning eats the ends of a stroke, so a line
 * drawn from the skeleton alone stops short at both; extending by a fixed guess
 * would overshoot as often as it fell short, so it is measured too.
 */
export function fitStroke(
  centreline: VectorPoint[],
  target: Set<number>,
  box: Box,
  imageWidth: number,
  maxWidth: number,
  weights: FitWeights,
  options: { widthStep?: number; extendStep?: number; maxExtend?: number; hidden?: Hidden } = {},
): StrokeFit {
  const widthStep = options.widthStep ?? 0.5;
  const extendStep = options.extendStep ?? 0.5;
  const maxExtend = options.maxExtend ?? Math.max(4, maxWidth * 4);
  const hidden = options.hidden;
  const scratch = coverageFor(box);

  const try_ = (points: VectorPoint[], width: number) =>
    scoreStroke(points, width, target, box, imageWidth, weights, scratch, hidden);

  /*
   * Width and centre, coarse then fine.
   *
   * A stroke an even number of pixels wide has no middle column — its skeleton
   * lands on one of the two, half a pixel off centre — and no symmetric width
   * fits an off-centre line well, so the width and the centre have to be chosen
   * against each other rather than one after the other. Trying every pairing at
   * full resolution is a hundred rasterisations a stroke and was most of what
   * this flow spent its time on, so the pairing is found coarsely and then
   * sharpened: a whole pixel at a time to find the neighbourhood, the shifts at
   * that width, then quarter pixels either side of it.
   */
  let best = try_(centreline, 1);
  for (let width = 1; width <= maxWidth + 1e-9; width += 1) {
    const fit = try_(centreline, width);
    if (fit.cost < best.cost) best = fit;
  }

  for (const shift of [-0.5, -0.25, 0.25, 0.5]) {
    const moved = shiftAcross(centreline, shift);
    if (!moved) continue;
    const fit = try_(moved, best.width);
    if (fit.cost < best.cost) best = fit;
  }

  const around = best.width;
  for (let width = Math.max(widthStep, around - 1); width <= Math.min(maxWidth, around + 1) + 1e-9; width += widthStep) {
    const fit = try_(best.points, width);
    if (fit.cost < best.cost) best = fit;
  }

  // Now the ends, at the width that won.
  let points = [...best.points];
  for (const end of ['head', 'tail'] as const) {
    for (let step = 0; step < maxExtend / extendStep; step += 1) {
      const moved = pushEnd(points, end, extendStep);
      if (!moved) break;
      const fit = try_(moved, best.width);
      if (fit.cost >= best.cost) break;
      points = moved;
      best = { ...fit, points };
    }
  }

  // A wider stroke may now be right, having found the whole of it.
  let widened = best;
  for (let width = Math.max(widthStep, best.width - 1); width <= Math.min(maxWidth, best.width + 1) + 1e-9; width += widthStep) {
    const fit = try_(points, width);
    if (fit.cost < widened.cost) widened = fit;
  }
  return { ...widened, points };
}

/**
 * Move a whole path sideways, across the direction it runs.
 *
 * Each point is moved along the normal of its own neighbourhood, so a curve
 * shifts without being straightened.
 */
function shiftAcross(points: VectorPoint[], by: number): VectorPoint[] | null {
  if (points.length < 2) return null;
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)]!;
    const after = points[Math.min(points.length - 1, index + 1)]!;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return point;
    return { x: point.x + (-dy / length) * by, y: point.y + (dx / length) * by };
  });
}

/** Push one end of a path outwards along the direction it was already going. */
function pushEnd(points: VectorPoint[], end: 'head' | 'tail', by: number): VectorPoint[] | null {
  if (points.length < 2) return null;
  const [tip, inward] =
    end === 'head'
      ? [points[0]!, points[1]!]
      : [points[points.length - 1]!, points[points.length - 2]!];
  const dx = tip.x - inward.x;
  const dy = tip.y - inward.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const moved = { x: tip.x + (dx / length) * by, y: tip.y + (dy / length) * by };
  return end === 'head' ? [moved, ...points.slice(1)] : [...points.slice(0, -1), moved];
}

/** Drop anchors from a stroke while dropping them pays for itself. */
export function pruneStroke(
  fit: StrokeFit,
  target: Set<number>,
  box: Box,
  imageWidth: number,
  weights: FitWeights,
  hidden?: Hidden,
): StrokeFit {
  const scratch = coverageFor(box);
  let best = fit;
  for (let round = 0; round < 200; round += 1) {
    if (best.points.length <= 2) break;
    let bestDrop: StrokeFit | null = null;
    // The ends are where the stroke stops, and dropping one shortens it rather
    // than simplifying it — so only the middle is considered.
    for (let index = 1; index < best.points.length - 1; index += 1) {
      const candidate = best.points.filter((_, at) => at !== index);
      const next = scoreStroke(candidate, best.width, target, box, imageWidth, weights, scratch, hidden);
      if (next.cost >= best.cost) continue;
      if (!bestDrop || next.cost < bestDrop.cost) bestDrop = next;
    }
    if (!bestDrop) break;
    best = bestDrop;
  }
  return best;
}

/**
 * Split a region's ink between the paths that run through it.
 *
 * Strokes that touch are one region — every crossing joins two of them — so a
 * region often yields several centrelines. Scoring each against *all* of the
 * region's ink makes the other strokes read as ink this one failed to cover, and
 * that missing weight swamps the thing actually being measured: a stroke comes
 * out too narrow because widening it barely dents a number dominated by ink it
 * was never going to reach.
 *
 * So each pixel is given to the path it lies nearest, and every path is judged
 * only on its own share. The result for each path is a mask of everything that
 * is not its business.
 */
export function shareInk(
  paths: VectorPoint[][],
  target: Set<number>,
  imageWidth: number,
): Hidden[] {
  if (paths.length < 2) return paths.map(() => () => false);

  // Worked out once, for the region's own pixels only — the answer is a lookup
  // afterwards however many candidates are scored against it.
  const owner = new Map<number, number>();
  for (const index of target) {
    const x = index % imageWidth;
    const point = { x: x + 0.5, y: (index - x) / imageWidth + 0.5 };
    let best = 0;
    let nearest = Infinity;
    for (let path = 0; path < paths.length; path += 1) {
      const distance = distanceToPath(point, paths[path]!);
      if (distance < nearest) {
        nearest = distance;
        best = path;
      }
    }
    owner.set(index, best);
  }

  return paths.map((_, path) => (index: number) => {
    const held = owner.get(index);
    // Only ink belonging to another path is hidden; everything that is not this
    // region's ink at all is still this path's business to stay off.
    return held !== undefined && held !== path;
  });
}

function distanceToPath(point: VectorPoint, path: VectorPoint[]): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return Math.hypot(point.x - path[0]!.x, point.y - path[0]!.y);
  let nearest = Infinity;
  for (let index = 0; index + 1 < path.length; index += 1) {
    const a = path[index]!;
    const b = path[index + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t = lengthSquared === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    const distance = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
    if (distance < nearest) nearest = distance;
  }
  return nearest;
}

/** Two of them as one: hidden by either. */
export function mergeHidden(one: Hidden | undefined, two: Hidden | undefined): Hidden | undefined {
  if (!one) return two;
  if (!two) return one;
  return (index: number) => one(index) || two(index);
}
