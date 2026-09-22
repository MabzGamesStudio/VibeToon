import type { VectorPoint } from './vector';

/**
 * Drawing shapes back into pixels, so what came out can be measured against what
 * went in.
 *
 * This used to be the other half of a **fit**: every candidate shape was drawn,
 * scored against the color it stood for, and kept or pruned on what it cost. That
 * is gone. It could not survive boundaries being shared between the shapes either
 * side of them — re-fitting one region's outline on its own is exactly what shared
 * boundaries exist to stop, and a fit that moves a boundary for one shape and not
 * its neighbour is an overlap by another name.
 *
 * What is left is the rasteriser, which the decomposition still needs for the
 * thing that replaced the fit: draw the whole answer once a round, take the
 * difference from the picture it came from, and spend the next round's anchors on
 * the worst part of it.
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

/** The part of the image being drawn into, so nothing walks the whole picture. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
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
      /*
       * Half-open on x as well as on y, so two shapes sharing an edge tile
       * rather than both claiming the seam.
       *
       * With the span closed at both ends, an edge landing exactly on a pixel
       * centre is inside the shape on its left *and* the shape on its right, and
       * every pixel down a 45° boundary gets painted twice. Which is invisible
       * when shapes are painted in an order — the later one wins — and is not
       * invisible at all once the shapes are meant to be a partition and
       * something counts them.
       */
      const from = Math.max(box.x, Math.ceil(crossings[pair]! - 0.5));
      const to = Math.min(box.x + box.width, Math.ceil(crossings[pair + 1]! - 0.5));
      for (let x = from; x < to; x += 1) into[row + (x - box.x)] = FULL;
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
