import type { Bitmap } from './cutout';

/**
 * Finding the lines in a picture: the strokes an artist draws between two
 * areas, told apart from the edges where one area simply meets another.
 *
 * Across a line, the colour does three things: it is one colour, then it
 * changes sharply to the line's colour, then — a few pixels on — it changes
 * sharply again to the colour on the far side. Only that counts:
 *
 * - **An edge** — one colour meeting another directly — has one change, not
 *   two, so it is not a line.
 * - **A gradient** changes a little at every pixel and never sharply, so it
 *   is not a line either.
 * - **A soft edge**, one or two pixels part-way between the colours either side
 *   of it, is a blend and not a colour of its own. It is taken as part of the
 *   edge, so anti-aliasing does not turn every edge into a thin line.
 *
 * The picture is read in **chunks**. In each, every row, column and both
 * diagonals are walked and cut into runs of one colour; a short run with a
 * sharp change on both sides, into colours unlike its own, is a line crossed
 * in that direction. Then it must be **longer than it is wide**: the run's
 * pixels, joined up with the ones like them nearby, have to reach along the
 * line at least `ratio` times the line's width. A speck or a short dash is not
 * a line; a stroke is.
 *
 * Every pixel of a line gets a confidence from how sharp its two changes are
 * and how far past the ratio it reaches. The result is drawn black where there
 * is no line and red where there is, redder the surer.
 */

export interface LineOptions {
  /**
   * How different two neighbouring pixels must be for the change between them
   * to count as sharp, 0..100 (black against white is 100).
   */
  contrast: number;
  /** How far a pixel may drift from its run's colour and still be in it, 0..100. */
  flatness: number;
  /** The widest a line can be, in pixels. Anything wider is an area. */
  maxWidth: number;
  /** How many times longer than wide a line must be. */
  ratio: number;
  /** The side of the square chunks the picture is read in, in pixels. */
  chunk: number;
}

export const DEFAULT_LINE_OPTIONS: LineOptions = {
  contrast: 18,
  flatness: 10,
  maxWidth: 8,
  ratio: 3,
  chunk: 48,
};

export interface LinesFlowData {
  editor: 'lines';
  options: LineOptions;
  /** What the editor shows: the lines found, or the picture itself. */
  view: 'lines' | 'original';
  /** The picture it was last shown, so the generator can say what it did. */
  source?: { width: number; height: number; hash?: string };
}

export function emptyLinesFlowData(): LinesFlowData {
  return { editor: 'lines', options: { ...DEFAULT_LINE_OPTIONS }, view: 'lines' };
}

/** The four ways a picture is walked, and the way along a line each one crosses. */
const DIRECTIONS: Array<{ step: [number, number]; along: [number, number] }> = [
  { step: [1, 0], along: [0, 1] },
  { step: [0, 1], along: [1, 0] },
  { step: [1, 1], along: [1, -1] },
  { step: [1, -1], along: [1, 1] },
];

/** Colour distance, 0..100, over red, green, blue and alpha. */
export function pixelDistance(data: ArrayLike<number>, a: number, b: number): number {
  const dr = data[a]! - data[b]!;
  const dg = data[a + 1]! - data[b + 1]!;
  const db = data[a + 2]! - data[b + 2]!;
  const da = data[a + 3]! - data[b + 3]!;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 5.1;
}

function colourDistance(a: readonly number[], b: readonly number[]): number {
  const dr = a[0]! - b[0]!;
  const dg = a[1]! - b[1]!;
  const db = a[2]! - b[2]!;
  const da = a[3]! - b[3]!;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 5.1;
}

/**
 * Is `middle` a blend of `left` and `right` — somewhere along the way from one
 * to the other — rather than a colour of its own?
 */
export function isBlend(left: readonly number[], middle: readonly number[], right: readonly number[]): boolean {
  const span = [0, 1, 2, 3].map((i) => right[i]! - left[i]!);
  const length = Math.hypot(...span);
  if (length < 1e-6) return false;
  const offset = [0, 1, 2, 3].map((i) => middle[i]! - left[i]!);
  const t = (offset[0]! * span[0]! + offset[1]! * span[1]! + offset[2]! * span[2]! + offset[3]! * span[3]!) / (length * length);
  if (t <= 0.05 || t >= 0.95) return false;
  const off = Math.hypot(...[0, 1, 2, 3].map((i) => offset[i]! - t * span[i]!));
  return off <= length * 0.2;
}

interface Run {
  /** Positions along the walk, `end` exclusive. */
  start: number;
  end: number;
  /** Mean colour. */
  colour: number[];
  /** Whether the change into this run from the one before was sharp, and how much. */
  sharpIn: number;
}

/**
 * Cut one walk into runs of one colour. A run ends where a pixel is sharply
 * unlike the one before it, or has drifted from the run's colour — the second
 * is how a gradient ends up as many runs with no sharp change between them.
 */
function runsOf(data: ArrayLike<number>, offsets: readonly number[], options: LineOptions): Run[] {
  const runs: Run[] = [];
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;
  let start = 0;
  let sharpIn = 0;
  // Distances are compared squared, on the raw 0..510 scale.
  const sharp2 = (options.contrast * 5.1) ** 2;
  const flat2 = (options.flatness * 5.1) ** 2;
  let previous = -1;
  for (let i = 0; i < offsets.length; i += 1) {
    const at = offsets[i]!;
    const pr = data[at]!;
    const pg = data[at + 1]!;
    const pb = data[at + 2]!;
    const pa = data[at + 3]!;
    if (count > 0) {
      const sr = pr - data[previous]!;
      const sg = pg - data[previous + 1]!;
      const sb = pb - data[previous + 2]!;
      const sa = pa - data[previous + 3]!;
      const step2 = sr * sr + sg * sg + sb * sb + sa * sa;
      const dr = pr - r / count;
      const dg = pg - g / count;
      const db = pb - b / count;
      const da = pa - a / count;
      if (step2 >= sharp2 || dr * dr + dg * dg + db * db + da * da > flat2) {
        runs.push({ start, end: i, colour: [r / count, g / count, b / count, a / count], sharpIn });
        r = 0;
        g = 0;
        b = 0;
        a = 0;
        count = 0;
        start = i;
        sharpIn = step2 >= sharp2 ? Math.sqrt(step2) / 5.1 : 0;
      }
    }
    r += pr;
    g += pg;
    b += pb;
    a += pa;
    count += 1;
    previous = at;
  }
  if (count > 0) runs.push({ start, end: offsets.length, colour: [r / count, g / count, b / count, a / count], sharpIn });
  return runs;
}

/** Fold the short blends between two runs into the edge they soften. */
function withoutBlends(runs: Run[], options: LineOptions): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!;
    const before = out[out.length - 1];
    const after = runs[i + 1];
    if (before && after && run.end - run.start <= 2 && isBlend(before.colour, run.colour, after.colour)) {
      // The edge is as sharp as the colours either side of the blend are apart.
      // Its pixels go with the run before it.
      const across = colourDistance(before.colour, after.colour);
      out[out.length - 1] = { ...before, end: run.end };
      runs[i + 1] = { ...after, sharpIn: across >= options.contrast ? across : 0 };
      continue;
    }
    out.push(run);
  }
  return out;
}

export interface LineResult {
  width: number;
  height: number;
  /** 0..1 for every pixel: how sure it is that the pixel is on a line. */
  confidence: Float32Array;
  stats: {
    /** Pixels on a line, at any confidence. */
    linePixels: number;
    /** Line crossings found before the longer-than-wide test. */
    crossings: number;
    chunks: number;
    ms: number;
  };
}

/**
 * The lines in a picture, as a confidence for every pixel.
 */
export function detectLines(bitmap: Bitmap, input: Partial<LineOptions> = {}): LineResult {
  const started = Date.now();
  const options = normaliseLineOptions(input);
  const { width, height, data } = bitmap;
  const total = width * height;
  const confidence = new Float32Array(total);
  let crossings = 0;
  const chunk = options.chunk;
  const chunksX = Math.ceil(width / chunk);
  const chunksY = Math.ceil(height / chunk);
  // Room round a chunk for the colours either side of a line at its border.
  const context = options.maxWidth + 3;
  // And for a line to show how long it is, beyond the chunk it was found in.
  const reach = Math.ceil(chunk / 2);

  for (const direction of DIRECTIONS) {
    // Per pixel: the line's width across, and how sharp its sides are, where a
    // walk in this direction found one.
    const widthAt = new Uint16Array(total);
    const sharpAt = new Float32Array(total);

    for (let cy = 0; cy < chunksY; cy += 1) {
      for (let cx = 0; cx < chunksX; cx += 1) {
        const x0 = cx * chunk;
        const y0 = cy * chunk;
        const x1 = Math.min(width, x0 + chunk);
        const y1 = Math.min(height, y0 + chunk);
        const wx0 = Math.max(0, x0 - context);
        const wy0 = Math.max(0, y0 - context);
        const wx1 = Math.min(width, x1 + context);
        const wy1 = Math.min(height, y1 + context);
        const [dx, dy] = direction.step;
        const inWindow = (x: number, y: number) => x >= wx0 && x < wx1 && y >= wy0 && y < wy1;

        for (let sy = wy0; sy < wy1; sy += 1) {
          for (let sx = wx0; sx < wx1; sx += 1) {
            // Every walk starts where the pixel before it is outside the window.
            if (inWindow(sx - dx, sy - dy)) continue;
            const xs: number[] = [];
            const ys: number[] = [];
            const offsets: number[] = [];
            for (let x = sx, y = sy; inWindow(x, y); x += dx, y += dy) {
              xs.push(x);
              ys.push(y);
              offsets.push((y * width + x) * 4);
            }
            if (offsets.length < 3) continue;
            const runs = withoutBlends(runsOf(data, offsets, options), options);
            for (let r = 1; r + 1 < runs.length; r += 1) {
              const line = runs[r]!;
              const next = runs[r + 1]!;
              const across = line.end - line.start;
              if (across > options.maxWidth) continue;
              if (line.sharpIn <= 0 || next.sharpIn <= 0) continue;
              const before = runs[r - 1]!;
              // Its own colour: not a blend of the two either side.
              if (isBlend(before.colour, line.colour, next.colour)) continue;
              if (colourDistance(line.colour, before.colour) < options.contrast) continue;
              if (colourDistance(line.colour, next.colour) < options.contrast) continue;
              const sharp = Math.min(line.sharpIn, next.sharpIn);
              let marked = false;
              for (let p = line.start; p < line.end; p += 1) {
                const x = xs[p]!;
                const y = ys[p]!;
                if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
                const at = y * width + x;
                widthAt[at] = across;
                sharpAt[at] = sharp;
                marked = true;
              }
              if (marked) crossings += 1;
            }
          }
        }
      }
    }

    // Longer than wide: each patch of crossings, joined up, must reach along
    // the line `ratio` times its width. Measured per chunk, reaching half a
    // chunk past it so a line on a chunk's border is not cut short.
    const [ax, ay] = direction.along;
    const [sx, sy] = direction.step;
    const seen = new Int32Array(total).fill(-1);
    let pass = 0;
    for (let cy = 0; cy < chunksY; cy += 1) {
      for (let cx = 0; cx < chunksX; cx += 1) {
        pass += 1;
        const x0 = cx * chunk;
        const y0 = cy * chunk;
        const x1 = Math.min(width, x0 + chunk);
        const y1 = Math.min(height, y0 + chunk);
        const wx0 = Math.max(0, x0 - reach);
        const wy0 = Math.max(0, y0 - reach);
        const wx1 = Math.min(width, x1 + reach);
        const wy1 = Math.min(height, y1 + reach);
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const seed = y * width + x;
            if (widthAt[seed] === 0 || seen[seed] === pass) continue;
            // The patch, 8-connected, within the reach of this chunk.
            const patch: number[] = [seed];
            seen[seed] = pass;
            let minAlong = Infinity;
            let maxAlong = -Infinity;
            let minAcross = Infinity;
            let maxAcross = -Infinity;
            let widthSum = 0;
            for (let k = 0; k < patch.length; k += 1) {
              const at = patch[k]!;
              const px = at % width;
              const py = (at - px) / width;
              const along = px * ax + py * ay;
              const acrossPos = px * sx + py * sy;
              if (along < minAlong) minAlong = along;
              if (along > maxAlong) maxAlong = along;
              if (acrossPos < minAcross) minAcross = acrossPos;
              if (acrossPos > maxAcross) maxAcross = acrossPos;
              widthSum += widthAt[at]!;
              for (let ny = py - 1; ny <= py + 1; ny += 1) {
                for (let nx = px - 1; nx <= px + 1; nx += 1) {
                  if (nx < wx0 || nx >= wx1 || ny < wy0 || ny >= wy1) continue;
                  const next = ny * width + nx;
                  if (widthAt[next] === 0 || seen[next] === pass) continue;
                  // Only the same band: a short run of the colour beside a line,
                  // where a walk clips a corner, is a patch of its own, not
                  // part of the line it touches.
                  if (pixelDistance(data, at * 4, next * 4) >= options.contrast) continue;
                  seen[next] = pass;
                  patch.push(next);
                }
              }
            }
            const lineWidth = widthSum / patch.length;
            // A diagonal walk steps √2 per pixel, along and across alike.
            const unit = Math.hypot(ax, ay);
            const length = (maxAlong - minAlong) / unit + 1;
            const ratio = length / Math.max(1, lineWidth);
            if (ratio < options.ratio) continue;
            const reachScore = Math.min(1, ratio / (options.ratio * 2));
            for (const at of patch) {
              const px = at % width;
              const py = (at - px) / width;
              if (px < x0 || px >= x1 || py < y0 || py >= y1) continue;
              const sharpScore = Math.min(1, sharpAt[at]! / (options.contrast * 2.5));
              const score = Math.max(0.2, Math.min(1, sharpScore * 0.5 + reachScore * 0.5));
              if (score > confidence[at]!) confidence[at] = score;
            }
          }
        }
      }
    }
  }

  let linePixels = 0;
  for (let i = 0; i < total; i += 1) if (confidence[i]! > 0) linePixels += 1;
  return {
    width,
    height,
    confidence,
    stats: { linePixels, crossings, chunks: chunksX * chunksY, ms: Date.now() - started },
  };
}

export function normaliseLineOptions(input: Partial<LineOptions>): LineOptions {
  const merged = { ...DEFAULT_LINE_OPTIONS, ...input };
  return {
    contrast: Math.max(1, Math.min(100, merged.contrast)),
    flatness: Math.max(0, Math.min(100, merged.flatness)),
    maxWidth: Math.max(1, Math.min(64, Math.round(merged.maxWidth))),
    ratio: Math.max(0.1, Math.min(50, merged.ratio)),
    chunk: Math.max(8, Math.min(1024, Math.round(merged.chunk))),
  };
}

/** The lines as a picture: black where there is none, red where there is, redder the surer. */
export function lineImage(result: LineResult): Bitmap {
  const out = new Uint8ClampedArray(result.width * result.height * 4);
  for (let i = 0; i < result.confidence.length; i += 1) {
    const at = i * 4;
    out[at] = Math.round(result.confidence[i]! * 255);
    out[at + 3] = 255;
  }
  return { width: result.width, height: result.height, data: out };
}

/** What was found, in words. */
export function summariseLines(result: LineResult): string {
  const share = (result.stats.linePixels / Math.max(1, result.width * result.height)) * 100;
  return `${result.width} × ${result.height} · ${result.stats.linePixels.toLocaleString()} line pixels (${share.toFixed(1)}%) · ${result.stats.chunks} chunk(s) · ${result.stats.ms} ms`;
}

export function linesReport(result: LineResult, options: LineOptions, source: string): string {
  const confident = [0.25, 0.5, 0.75].map((floor) => {
    let count = 0;
    for (const value of result.confidence) if (value >= floor) count += 1;
    return count;
  });
  return [
    '# Lines',
    '',
    `Found in **${source}**: ${summariseLines(result)}.`,
    '',
    '| Setting | Value |',
    '| --- | --- |',
    `| Sharp change | ${options.contrast} |`,
    `| Flatness | ${options.flatness} |`,
    `| Widest line | ${options.maxWidth} px |`,
    `| Longer than wide by | ×${options.ratio} |`,
    `| Chunk | ${options.chunk} px |`,
    '',
    '| Confidence at least | Pixels |',
    '| --- | --- |',
    `| 25% | ${confident[0]} |`,
    `| 50% | ${confident[1]} |`,
    `| 75% | ${confident[2]} |`,
    '',
    '`lines.png` is black where there is no line and red where there is, redder the surer.',
    '',
  ].join('\n');
}
