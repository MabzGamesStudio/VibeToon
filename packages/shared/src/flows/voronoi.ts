import type { Bitmap } from './cutout';
import { fromHex, toHex, type Rgba } from './palette';
import type { VectorImage, VectorPoint, VectorPolygon } from './vector';

/**
 * A picture as a Voronoi diagram: so many nodes, each with a color, and every
 * pixel the color of the node nearest it.
 *
 * The nodes are placed, and colored, to make the diagram as like the picture
 * as it can be: the sum over the pixels of the squared difference between the
 * pixel and its node's color (red, green, blue and opacity, premultiplied) is
 * what is made small.
 *
 * For nodes where they are, the best color for each is easy: the average of
 * the pixels in its cell — or, with a palette, the palette color nearest that
 * average, which for squared differences is the same thing as the palette
 * color that fits the cell best. Where the nodes go is the hard part, and is
 * found in three moves:
 *
 * 1. **Start where the detail is.** Nodes are scattered with more of them
 *    where the picture changes (its edges) and some everywhere.
 * 2. **Nudge each node.** Each node in turn tries a step left, right, up and
 *    down; a step that makes the whole diagram fit better is kept, and tried
 *    again. The fit of a move is worked out exactly — which pixels change cell
 *    and what each cell's best color becomes — but only round the node, from
 *    sums kept for every cell. The steps shrink round by round.
 * 3. **Move the nodes that do least to where the fit is worst.** A node whose
 *    cell is the color of the cell beside it adds little; every other round,
 *    some of those are taken away and put where the fit is worst — inside the
 *    cell with the most error, at the middle of the part it fits worst — each
 *    kept only if the diagram fits better for it.
 *
 * The work is done on the picture made smaller (so a few hundred thousand
 * pixels), and the colors are fitted again on the picture at its own size at
 * the end. Everything is decided by a seeded random number, so the same
 * picture and settings always give the same diagram.
 */

export interface VoronoiFlowData {
  editor: 'voronoi';
  /** How many nodes. */
  nodes: number;
  /** Rounds of nudging and moving: more fits better and takes longer. */
  refine: number;
  /** With a palette wired in, the nodes take only its colors. */
  usePalette: boolean;
  /** What is written: the diagram as a picture, as shapes, or both. */
  output: 'picture' | 'vector' | 'both';
  /** As shapes: cells of the same color that touch are one shape. */
  merge: boolean;
  /** What the editor shows. */
  view: 'diagram' | 'picture';
  showEdges: boolean;
  showNodes: boolean;
  /** The picture the diagram was last fitted to. */
  image?: { hash?: string; width: number; height: number };
}

export const DEFAULT_VORONOI_NODES = 300;
export const DEFAULT_VORONOI_REFINE = 12;
export const MAX_VORONOI_NODES = 6000;

export function emptyVoronoiFlowData(): VoronoiFlowData {
  return {
    editor: 'voronoi',
    nodes: DEFAULT_VORONOI_NODES,
    refine: DEFAULT_VORONOI_REFINE,
    usePalette: true,
    output: 'picture',
    merge: true,
    view: 'diagram',
    showEdges: false,
    showNodes: false,
  };
}

export interface VoronoiOptions {
  nodes: number;
  refine: number;
  seed?: number;
  /**
   * Where to start the nodes, in the picture's pixels, instead of scattering
   * them: the nodes of a diagram of a frame before, for the next frame, so what
   * did not move fits the same way.
   */
  start?: ReadonlyArray<{ x: number; y: number }>;
}

export interface VoronoiProgress {
  stage: 'start' | 'refine' | 'finish' | 'shapes';
  done: number;
  total: number;
}

/* ---------------- random numbers ---------------- */

/** A small seeded random number generator (mulberry32), 0 ≤ n < 1. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- the picture to fit ---------------- */

/** A picture as numbers to fit: premultiplied red, green, blue and opacity (0..255) for each pixel. */
export interface WorkPicture {
  width: number;
  height: number;
  /** The work picture's pixels per pixel of the original, across and down. */
  sx: number;
  sy: number;
  values: Float32Array;
  /** Each pixel's squared length, for errors from sums. */
  squares: Float32Array;
}

/** How many pixels the work is done at, for so many nodes. */
export function workPixelsFor(nodes: number): number {
  return Math.max(40_000, Math.min(300_000, Math.round(nodes * 64)));
}

/** The picture, made no bigger than `maxPixels` by averaging, as premultiplied values. */
export function workPicture(image: Bitmap, maxPixels: number): WorkPicture {
  const { width: W, height: H, data } = image;
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, W * H)));
  const width = Math.max(1, Math.round(W * scale));
  const height = Math.max(1, Math.round(H * scale));
  const sx = width / W;
  const sy = height / H;
  const values = new Float32Array(width * height * 4);
  const counts = new Float32Array(width * height);
  for (let y = 0; y < H; y += 1) {
    const j = Math.min(height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < W; x += 1) {
      const i = Math.min(width - 1, Math.floor((x + 0.5) * sx));
      const at = (y * W + x) * 4;
      const a = data[at + 3]!;
      const k = j * width + i;
      values[k * 4] = values[k * 4]! + (data[at]! * a) / 255;
      values[k * 4 + 1] = values[k * 4 + 1]! + (data[at + 1]! * a) / 255;
      values[k * 4 + 2] = values[k * 4 + 2]! + (data[at + 2]! * a) / 255;
      values[k * 4 + 3] = values[k * 4 + 3]! + a;
      counts[k] = counts[k]! + 1;
    }
  }
  const squares = new Float32Array(width * height);
  for (let k = 0; k < width * height; k += 1) {
    const n = Math.max(1, counts[k]!);
    let sum = 0;
    for (let c = 0; c < 4; c += 1) {
      const v = values[k * 4 + c]! / n;
      values[k * 4 + c] = v;
      sum += v * v;
    }
    squares[k] = sum;
  }
  return { width, height, sx, sy, values, squares };
}

/** Palette colors as premultiplied values. */
function premultipliedPalette(palette: readonly Rgba[]): Float64Array {
  const out = new Float64Array(palette.length * 4);
  palette.forEach((color, index) => {
    out[index * 4] = (color.r * color.a) / 255;
    out[index * 4 + 1] = (color.g * color.a) / 255;
    out[index * 4 + 2] = (color.b * color.a) / 255;
    out[index * 4 + 3] = color.a;
  });
  return out;
}

/* ---------------- nearest node ---------------- */

/**
 * The nodes in a grid of buckets, for finding the node nearest a point: the
 * buckets round the point's are looked in, ring by ring, until no node further
 * out could be nearer.
 */
export class NearestGrid {
  readonly size: number;
  readonly cols: number;
  readonly rows: number;
  private readonly start: Int32Array;
  private readonly members: Int32Array;

  constructor(
    readonly xs: ArrayLike<number>,
    readonly ys: ArrayLike<number>,
    readonly count: number,
    width: number,
    height: number,
    readonly skip?: Uint8Array,
  ) {
    this.size = Math.max(1, Math.sqrt((width * height) / Math.max(1, count)));
    this.cols = Math.max(1, Math.ceil(width / this.size));
    this.rows = Math.max(1, Math.ceil(height / this.size));
    const buckets = this.cols * this.rows;
    const counts = new Int32Array(buckets + 1);
    const bucketOf = new Int32Array(count);
    for (let i = 0; i < count; i += 1) {
      if (skip?.[i]) {
        bucketOf[i] = -1;
        continue;
      }
      const b = this.bucket(xs[i]!, ys[i]!);
      bucketOf[i] = b;
      counts[b + 1] = counts[b + 1]! + 1;
    }
    for (let b = 0; b < buckets; b += 1) counts[b + 1] = counts[b + 1]! + counts[b]!;
    this.start = counts;
    this.members = new Int32Array(Math.max(1, counts[buckets]!));
    const fill = counts.slice(0, buckets);
    for (let i = 0; i < count; i += 1) {
      const b = bucketOf[i]!;
      if (b < 0) continue;
      this.members[fill[b]!] = i;
      fill[b] = fill[b]! + 1;
    }
  }

  private bucket(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.size)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.size)));
    return cy * this.cols + cx;
  }

  /** The node nearest (x, y), or -1 when there are none; of two as near, the lower-numbered. */
  nearest(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.size)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.size)));
    this.best = -1;
    this.bestDistance = Number.POSITIVE_INFINITY;
    const most = Math.max(this.cols, this.rows);
    for (let ring = 0; ring <= most; ring += 1) {
      const y0 = cy - ring;
      const y1 = cy + ring;
      const x0 = cx - ring;
      const x1 = cx + ring;
      for (let by = Math.max(0, y0); by <= Math.min(this.rows - 1, y1); by += 1) {
        if (by === y0 || by === y1) {
          for (let bx = Math.max(0, x0); bx <= Math.min(this.cols - 1, x1); bx += 1) this.look(by * this.cols + bx, x, y);
        } else {
          // Between the ring's top and bottom rows, only its two ends.
          if (x0 >= 0) this.look(by * this.cols + x0, x, y);
          if (x1 <= this.cols - 1) this.look(by * this.cols + x1, x, y);
        }
      }
      // Anything in the next ring out is more than `ring` buckets away.
      if (this.best >= 0 && this.bestDistance <= ring * this.size * (ring * this.size)) break;
    }
    return this.best;
  }

  private best = -1;
  private bestDistance = 0;

  private look(b: number, x: number, y: number): void {
    for (let k = this.start[b]!; k < this.start[b + 1]!; k += 1) {
      const i = this.members[k]!;
      const dx = this.xs[i]! - x;
      const dy = this.ys[i]! - y;
      const d = dx * dx + dy * dy;
      if (d < this.bestDistance || (d === this.bestDistance && i < this.best)) {
        this.bestDistance = d;
        this.best = i;
      }
    }
  }

  /** The nodes in the buckets within `radius` of (x, y). */
  within(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const x0 = Math.max(0, Math.floor((x - radius) / this.size));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / this.size));
    const y0 = Math.max(0, Math.floor((y - radius) / this.size));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / this.size));
    for (let by = y0; by <= y1; by += 1) {
      for (let bx = x0; bx <= x1; bx += 1) {
        const b = by * this.cols + bx;
        for (let k = this.start[b]!; k < this.start[b + 1]!; k += 1) out.push(this.members[k]!);
      }
    }
    return out;
  }
}

/* ---------------- fitting ---------------- */

/** A diagram fitted to a work picture: its nodes there, which cell each pixel is in, and each node's color. */
export interface WorkFit {
  picture: WorkPicture;
  xs: Float64Array;
  ys: Float64Array;
  owner: Int32Array;
  /** Each node's palette entry, or -1 for a color of its own. */
  entries: Int32Array;
  /** Each node's color, premultiplied. */
  colors: Float64Array;
  /** The sum of squared differences over the work picture. */
  error: number;
  relocated: number;
  rounds: number;
}

class Fitter {
  readonly n: number;
  readonly w: number;
  readonly h: number;
  readonly v: Float32Array;
  readonly sq: Float32Array;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly owner: Int32Array;
  readonly count: Int32Array;
  readonly sums: Float64Array;
  readonly squares: Float64Array;
  readonly sse: Float64Array;
  readonly entries: Int32Array;
  readonly colors: Float64Array;
  /** Each cell's pixels lie inside its box (x0, y0, x1, y1), which may be bigger than they need. */
  readonly box: Int32Array;

  /*
   * A move is logged so it can be undone: the pixels it moved, the cells it
   * changed (and their errors before), and the boxes it grew. Marks are stamps,
   * so starting a move clears them without touching every cell.
   */
  private move = 1;
  private pixelLog: number[] = [];
  private affected: number[] = [];
  private oldError: number[] = [];
  private readonly affectedMark: Int32Array;
  private boxLog: number[] = [];
  private readonly boxMark: Int32Array;
  /** For `place`: the pixels it has seen, and the nodes near the cell. */
  private pass = 1;
  private readonly pixelMark: Int32Array;
  private readonly nearMark: Int32Array;

  constructor(
    readonly picture: WorkPicture,
    count: number,
    readonly palette: Float64Array | null,
  ) {
    this.n = count;
    this.w = picture.width;
    this.h = picture.height;
    this.v = picture.values;
    this.sq = picture.squares;
    this.xs = new Float64Array(count);
    this.ys = new Float64Array(count);
    this.owner = new Int32Array(this.w * this.h);
    this.count = new Int32Array(count);
    this.sums = new Float64Array(count * 4);
    this.squares = new Float64Array(count);
    this.sse = new Float64Array(count);
    this.entries = new Int32Array(count).fill(-1);
    this.colors = new Float64Array(count * 4);
    this.box = new Int32Array(count * 4);
    this.affectedMark = new Int32Array(count);
    this.boxMark = new Int32Array(count);
    this.pixelMark = new Int32Array(this.w * this.h);
    this.nearMark = new Int32Array(count);
  }

  /** Every pixel in the cell of its nearest node, and every cell's sums, color and error afresh. */
  labelAll(): void {
    const grid = new NearestGrid(this.xs, this.ys, this.n, this.w, this.h);
    this.count.fill(0);
    this.sums.fill(0);
    this.squares.fill(0);
    for (let i = 0; i < this.n; i += 1) {
      this.box[i * 4] = this.w;
      this.box[i * 4 + 1] = this.h;
      this.box[i * 4 + 2] = -1;
      this.box[i * 4 + 3] = -1;
    }
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        const p = y * this.w + x;
        const i = grid.nearest(x + 0.5, y + 0.5);
        this.owner[p] = i;
        this.add(i, p, 1);
        const b = i * 4;
        if (x < this.box[b]!) this.box[b] = x;
        if (y < this.box[b + 1]!) this.box[b + 1] = y;
        if (x > this.box[b + 2]!) this.box[b + 2] = x;
        if (y > this.box[b + 3]!) this.box[b + 3] = y;
      }
    }
    for (let i = 0; i < this.n; i += 1) this.sse[i] = this.fitColor(i, true);
  }

  private add(i: number, p: number, sign: number): void {
    this.count[i] = this.count[i]! + sign;
    for (let c = 0; c < 4; c += 1) this.sums[i * 4 + c] = this.sums[i * 4 + c]! + sign * this.v[p * 4 + c]!;
    this.squares[i] = this.squares[i]! + sign * this.sq[p]!;
  }

  /** A cell's error with its best color, from its sums; with `keep`, that color is kept. */
  fitColor(i: number, keep: boolean): number {
    const n = this.count[i]!;
    if (n <= 0) {
      if (keep) this.entries[i] = this.palette ? 0 : -1;
      return 0;
    }
    const s0 = this.sums[i * 4]!;
    const s1 = this.sums[i * 4 + 1]!;
    const s2 = this.sums[i * 4 + 2]!;
    const s3 = this.sums[i * 4 + 3]!;
    if (!this.palette) {
      if (keep) {
        this.colors[i * 4] = s0 / n;
        this.colors[i * 4 + 1] = s1 / n;
        this.colors[i * 4 + 2] = s2 / n;
        this.colors[i * 4 + 3] = s3 / n;
      }
      return Math.max(0, this.squares[i]! - (s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3) / n);
    }
    // With a palette: Σ|v - c|² = Q + n|c|² - 2 c·S, least for the best entry.
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    const pal = this.palette;
    for (let e = 0; e < pal.length / 4; e += 1) {
      const c0 = pal[e * 4]!;
      const c1 = pal[e * 4 + 1]!;
      const c2 = pal[e * 4 + 2]!;
      const c3 = pal[e * 4 + 3]!;
      const cost = n * (c0 * c0 + c1 * c1 + c2 * c2 + c3 * c3) - 2 * (c0 * s0 + c1 * s1 + c2 * s2 + c3 * s3);
      if (cost < bestCost) {
        bestCost = cost;
        best = e;
      }
    }
    if (keep) {
      this.entries[i] = best;
      for (let c = 0; c < 4; c += 1) this.colors[i * 4 + c] = pal[best * 4 + c]!;
    }
    return Math.max(0, this.squares[i]! + bestCost);
  }

  totalError(): number {
    let total = 0;
    for (let i = 0; i < this.n; i += 1) total += this.sse[i]!;
    return total;
  }

  /** Start a move that can be undone. */
  begin(): void {
    this.pixelLog = [];
    this.affected = [];
    this.oldError = [];
    this.boxLog = [];
    this.move += 1;
  }

  /** Mark a cell changed by this move: its error is worked out again at `settle`. */
  private touch(i: number): void {
    if (this.affectedMark[i] === this.move) return;
    this.affectedMark[i] = this.move;
    this.affected.push(i);
    this.oldError.push(this.sse[i]!);
  }

  /** Keep a cell's box as it was before this move changed it, for `undo`. */
  private saveBox(i: number): void {
    if (this.boxMark[i] === this.move) return;
    this.boxMark[i] = this.move;
    this.boxLog.push(i, this.box[i * 4]!, this.box[i * 4 + 1]!, this.box[i * 4 + 2]!, this.box[i * 4 + 3]!);
  }

  /** Move pixel p from cell `from` to cell `to`. */
  private shift(p: number, from: number, to: number): void {
    this.touch(from);
    this.touch(to);
    this.owner[p] = to;
    this.add(from, p, -1);
    this.add(to, p, 1);
    this.pixelLog.push(p, from, to);
    const x = p % this.w;
    const y = (p - x) / this.w;
    const b = to * 4;
    if (x < this.box[b]! || y < this.box[b + 1]! || x > this.box[b + 2]! || y > this.box[b + 3]!) {
      this.saveBox(to);
      if (x < this.box[b]!) this.box[b] = x;
      if (y < this.box[b + 1]!) this.box[b + 1] = y;
      if (x > this.box[b + 2]!) this.box[b + 2] = x;
      if (y > this.box[b + 3]!) this.box[b + 3] = y;
    }
  }

  /** The change in error since `begin`, with every changed cell's color fitted again. */
  settle(): number {
    let delta = 0;
    for (let k = 0; k < this.affected.length; k += 1) {
      const i = this.affected[k]!;
      const now = this.fitColor(i, true);
      delta += now - this.oldError[k]!;
      this.sse[i] = now;
    }
    return delta;
  }

  /** Undo the move since `begin`: its pixels, colors, errors and boxes. Where nodes were is the caller's to put back. */
  undo(): void {
    for (let k = this.pixelLog.length - 3; k >= 0; k -= 3) {
      const p = this.pixelLog[k]!;
      const from = this.pixelLog[k + 1]!;
      const to = this.pixelLog[k + 2]!;
      this.owner[p] = from;
      this.add(to, p, -1);
      this.add(from, p, 1);
    }
    for (let k = 0; k < this.affected.length; k += 1) {
      const i = this.affected[k]!;
      this.fitColor(i, true);
      this.sse[i] = this.oldError[k]!;
    }
    for (let k = 0; k < this.boxLog.length; k += 5) {
      const i = this.boxLog[k]!;
      for (let c = 0; c < 4; c += 1) this.box[i * 4 + c] = this.boxLog[k + 1 + c]!;
    }
    this.begin();
  }

  /**
   * Put node i at (nx, ny), moving the pixels that change cell: those of its
   * own now nearer another node, and those of others now nearer it. Only the
   * box round its cell is looked at, grown while the cell reaches its side.
   */
  place(i: number, nx: number, ny: number): void {
    const reach = Math.ceil(Math.max(Math.abs(nx - this.xs[i]!), Math.abs(ny - this.ys[i]!))) + 2;
    let x0 = Math.min(this.box[i * 4]!, Math.floor(nx)) - reach;
    let y0 = Math.min(this.box[i * 4 + 1]!, Math.floor(ny)) - reach;
    let x1 = Math.max(this.box[i * 4 + 2]!, Math.floor(nx)) + reach;
    let y1 = Math.max(this.box[i * 4 + 3]!, Math.floor(ny)) + reach;
    this.xs[i] = nx;
    this.ys[i] = ny;
    this.touch(i);
    const seen = ++this.pass;
    const near: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      x0 = Math.max(0, x0);
      y0 = Math.max(0, y0);
      x1 = Math.min(this.w - 1, x1);
      y1 = Math.min(this.h - 1, y1);
      // The nodes whose cells are in the box: where a pixel of i's may go.
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const o = this.owner[y * this.w + x]!;
          if (o !== i && this.nearMark[o] !== seen) {
            this.nearMark[o] = seen;
            near.push(o);
          }
        }
      }
      let reachesSide = false;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const p = y * this.w + x;
          if (this.pixelMark[p] === seen) continue;
          this.pixelMark[p] = seen;
          const o = this.owner[p]!;
          const px = x + 0.5;
          const py = y + 0.5;
          const dNew = (px - nx) * (px - nx) + (py - ny) * (py - ny);
          let to = o;
          if (o === i) {
            let best = dNew;
            for (const j of near) {
              const d = (px - this.xs[j]!) * (px - this.xs[j]!) + (py - this.ys[j]!) * (py - this.ys[j]!);
              if (d < best) {
                best = d;
                to = j;
              }
            }
          } else {
            const d = (px - this.xs[o]!) * (px - this.xs[o]!) + (py - this.ys[o]!) * (py - this.ys[o]!);
            if (dNew < d) to = i;
          }
          if (to !== o) this.shift(p, o, to);
          if (to === i && ((x === x0 && x0 > 0) || (x === x1 && x1 < this.w - 1) || (y === y0 && y0 > 0) || (y === y1 && y1 < this.h - 1))) reachesSide = true;
        }
      }
      if (!reachesSide) return;
      const grow = Math.max(4, Math.round((x1 - x0 + y1 - y0) / 2));
      x0 -= grow;
      y0 -= grow;
      x1 += grow;
      y1 += grow;
    }
  }

  /** Take node i out: each pixel of its cell goes to the nearest of the nodes round it. */
  takeOut(i: number): void {
    const x0 = Math.max(0, this.box[i * 4]! - 1);
    const y0 = Math.max(0, this.box[i * 4 + 1]! - 1);
    const x1 = Math.min(this.w - 1, this.box[i * 4 + 2]! + 1);
    const y1 = Math.min(this.h - 1, this.box[i * 4 + 3]! + 1);
    const seen = ++this.pass;
    const near: number[] = [];
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const o = this.owner[y * this.w + x]!;
        if (o !== i && this.nearMark[o] !== seen) {
          this.nearMark[o] = seen;
          near.push(o);
        }
      }
    }
    if (near.length === 0) return;
    this.touch(i);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = y * this.w + x;
        if (this.owner[p] !== i) continue;
        let best = Number.POSITIVE_INFINITY;
        let to = near[0]!;
        for (const j of near) {
          const d = (x + 0.5 - this.xs[j]!) ** 2 + (y + 0.5 - this.ys[j]!) ** 2;
          if (d < best) {
            best = d;
            to = j;
          }
        }
        this.shift(p, i, to);
      }
    }
    // Its box is empty now: wherever it is put next starts it afresh.
    this.saveBox(i);
    this.box[i * 4] = this.w;
    this.box[i * 4 + 1] = this.h;
    this.box[i * 4 + 2] = -1;
    this.box[i * 4 + 3] = -1;
  }

  /** Put node i, taken out, down at (nx, ny): the pixels nearer it than their own node become its. */
  putIn(i: number, nx: number, ny: number): void {
    this.xs[i] = nx;
    this.ys[i] = ny;
    this.touch(i);
    let r = 3;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const x0 = Math.max(0, Math.floor(nx) - r);
      const y0 = Math.max(0, Math.floor(ny) - r);
      const x1 = Math.min(this.w - 1, Math.floor(nx) + r);
      const y1 = Math.min(this.h - 1, Math.floor(ny) + r);
      let reachesSide = false;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const p = y * this.w + x;
          const o = this.owner[p]!;
          if (o === i) continue;
          const px = x + 0.5;
          const py = y + 0.5;
          const dNew = (px - nx) ** 2 + (py - ny) ** 2;
          const d = (px - this.xs[o]!) ** 2 + (py - this.ys[o]!) ** 2;
          if (dNew < d) {
            this.shift(p, o, i);
            if ((x === x0 && x0 > 0) || (x === x1 && x1 < this.w - 1) || (y === y0 && y0 > 0) || (y === y1 && y1 < this.h - 1)) reachesSide = true;
          }
        }
      }
      if (!reachesSide) return;
      r *= 2;
    }
  }
}

/** How much each pixel of the work picture changes, for scattering nodes: more where the picture has edges. */
function detailOf(picture: WorkPicture): Float64Array {
  const { width: w, height: h, values } = picture;
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p += 1) lum[p] = 0.299 * values[p * 4]! + 0.587 * values[p * 4 + 1]! + 0.114 * values[p * 4 + 2]! + 0.5 * values[p * 4 + 3]!;
  const out = new Float64Array(w * h);
  let total = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const at = (dx: number, dy: number) => lum[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]!;
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      const g = Math.hypot(gx, gy);
      out[y * w + x] = g;
      total += g;
    }
  }
  // Some everywhere, so a flat picture is covered evenly.
  const floor = Math.max(1e-6, (total / Math.max(1, w * h)) * 0.6);
  for (let p = 0; p < w * h; p += 1) out[p] = out[p]! + floor;
  return out;
}

/** Scatter `count` nodes over the work picture, more where it has detail; stratified, so evenly spread through the detail. */
function scatter(picture: WorkPicture, count: number, random: () => number): { xs: Float64Array; ys: Float64Array } {
  const detail = detailOf(picture);
  const cdf = new Float64Array(detail.length);
  let total = 0;
  for (let p = 0; p < detail.length; p += 1) {
    total += detail[p]!;
    cdf[p] = total;
  }
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    const u = ((k + random()) / count) * total;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    const x = lo % picture.width;
    const y = (lo - x) / picture.width;
    xs[k] = x + random();
    ys[k] = y + random();
  }
  return { xs, ys };
}

/**
 * Fit a diagram of `options.nodes` nodes to a work picture (see the top of
 * this file). A generator, yielding as it goes, so a page can run it a slice
 * at a time.
 */
export function* fitWork(picture: WorkPicture, options: VoronoiOptions, palette: readonly Rgba[] | null): Generator<VoronoiProgress, WorkFit> {
  const count = Math.max(1, Math.min(MAX_VORONOI_NODES, Math.round(options.nodes), picture.width * picture.height));
  const random = seededRandom(options.seed ?? 1);
  const fitter = new Fitter(picture, count, palette && palette.length > 0 ? premultipliedPalette(palette) : null);
  yield { stage: 'start', done: 0, total: 1 };
  const scattered = scatter(picture, count, random);
  fitter.xs.set(scattered.xs);
  fitter.ys.set(scattered.ys);
  if (options.start) {
    // A start given: as many nodes as it has go where they were; any more are scattered.
    const n = Math.min(count, options.start.length);
    for (let i = 0; i < n; i += 1) {
      fitter.xs[i] = Math.min(picture.width - 1e-3, Math.max(0, options.start[i]!.x * picture.sx));
      fitter.ys[i] = Math.min(picture.height - 1e-3, Math.max(0, options.start[i]!.y * picture.sy));
    }
  }
  fitter.labelAll();
  const rounds = Math.max(1, Math.round(options.refine));
  const spacing = Math.sqrt((picture.width * picture.height) / count);
  let step = Math.max(0.5, spacing * (options.start ? 0.15 : 0.35));
  let relocated = 0;
  const order = Array.from({ length: count }, (_, i) => i);
  for (let round = 0; round < rounds; round += 1) {
    yield { stage: 'refine', done: round, total: rounds };
    // Nudge each node, in a shuffled order.
    for (let k = count - 1; k > 0; k -= 1) {
      const j = Math.floor(random() * (k + 1));
      [order[k], order[j]] = [order[j]!, order[k]!];
    }
    for (let k = 0; k < count; k += 1) {
      const i = order[k]!;
      if (fitter.count[i] === 0) continue;
      let tries = 0;
      let dir = -1;
      const dirs = [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
      ] as const;
      for (;;) {
        let bestDelta = -1e-6;
        let bestDir = -1;
        const candidates = dir >= 0 ? [dir] : [0, 1, 2, 3];
        for (const d of candidates) {
          const nx = fitter.xs[i]! + dirs[d]![0];
          const ny = fitter.ys[i]! + dirs[d]![1];
          if (nx < 0 || ny < 0 || nx >= picture.width || ny >= picture.height) continue;
          const ox = fitter.xs[i]!;
          const oy = fitter.ys[i]!;
          fitter.begin();
          fitter.place(i, nx, ny);
          const delta = fitter.settle();
          fitter.undo();
          fitter.xs[i] = ox;
          fitter.ys[i] = oy;
          if (delta < bestDelta) {
            bestDelta = delta;
            bestDir = d;
          }
        }
        if (bestDir < 0) break;
        fitter.begin();
        fitter.place(i, fitter.xs[i]! + dirs[bestDir]![0], fitter.ys[i]! + dirs[bestDir]![1]);
        fitter.settle();
        // Keep going the way that paid, a few times.
        dir = bestDir;
        tries += 1;
        if (tries >= 4) break;
      }
      if (k % 256 === 255) yield { stage: 'refine', done: round + k / count, total: rounds };
    }
    // Every other round, move the nodes that do least to where the fit is worst.
    if (round % 2 === 1 && round < rounds - 1) {
      fitter.labelAll();
      relocated += relocate(fitter, Math.max(1, Math.round(count * 0.04)));
    }
    step = Math.max(0.5, step * 0.72);
    fitter.labelAll();
  }
  fitter.labelAll();
  return {
    picture,
    xs: fitter.xs,
    ys: fitter.ys,
    owner: fitter.owner,
    entries: fitter.entries,
    colors: fitter.colors,
    error: fitter.totalError(),
    relocated,
    rounds,
  };
}

/**
 * Take up to `budget` nodes whose cells cost least to lose — empty ones, and
 * those most like a neighbour — and put each where the fit is worst, keeping
 * each move only if the diagram fits better for it. Returns how many moved.
 */
function relocate(fitter: Fitter, budget: number): number {
  const { w, h, n } = fitter;
  // What losing each cell costs: nothing if empty, else the least Ward cost of joining it to a neighbour.
  const cheap = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const colorDistance = (a: number, b: number) => {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d += (fitter.colors[a * 4 + c]! - fitter.colors[b * 4 + c]!) ** 2;
    return d;
  };
  const consider = (a: number, b: number) => {
    const na = fitter.count[a]!;
    const nb = fitter.count[b]!;
    if (na === 0 || nb === 0) return;
    const cost = ((na * nb) / (na + nb)) * colorDistance(a, b);
    if (cost < cheap[a]!) cheap[a] = cost;
    if (cost < cheap[b]!) cheap[b] = cost;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = fitter.owner[y * w + x]!;
      if (x + 1 < w) {
        const r = fitter.owner[y * w + x + 1]!;
        if (r !== o) consider(o, r);
      }
      if (y + 1 < h) {
        const d = fitter.owner[(y + 1) * w + x]!;
        if (d !== o) consider(o, d);
      }
    }
  }
  for (let i = 0; i < n; i += 1) if (fitter.count[i] === 0) cheap[i] = -1;
  const donors = Array.from({ length: n }, (_, i) => i).sort((a, b) => cheap[a]! - cheap[b]!);
  const worst = Array.from({ length: n }, (_, i) => i).sort((a, b) => fitter.sse[b]! - fitter.sse[a]!);
  let moved = 0;
  let used = 0;
  const taken = new Set<number>();
  for (const target of worst) {
    if (moved >= budget || used >= budget * 3) break;
    if (fitter.sse[target]! <= 0) break;
    const donor = donors.find((candidate) => candidate !== target && !taken.has(candidate));
    if (donor === undefined) break;
    used += 1;
    // Where the target cell fits worst: the middle of its pixels that fit worse than its average.
    const b = target * 4;
    const nT = Math.max(1, fitter.count[target]!);
    const mean = fitter.sse[target]! / nT;
    let wx = 0;
    let wy = 0;
    let wt = 0;
    for (let y = Math.max(0, fitter.box[b + 1]!); y <= Math.min(h - 1, fitter.box[b + 3]!); y += 1) {
      for (let x = Math.max(0, fitter.box[b]!); x <= Math.min(w - 1, fitter.box[b + 2]!); x += 1) {
        const p = y * w + x;
        if (fitter.owner[p] !== target) continue;
        let e = 0;
        for (let c = 0; c < 4; c += 1) e += (fitter.v[p * 4 + c]! - fitter.colors[target * 4 + c]!) ** 2;
        if (e <= mean) continue;
        const weight = e - mean;
        wx += (x + 0.5) * weight;
        wy += (y + 0.5) * weight;
        wt += weight;
      }
    }
    if (wt <= 0) continue;
    const nx = wx / wt;
    const ny = wy / wt;
    const ox = fitter.xs[donor]!;
    const oy = fitter.ys[donor]!;
    fitter.begin();
    fitter.takeOut(donor);
    fitter.putIn(donor, nx, ny);
    const delta = fitter.settle();
    if (delta < -1e-6) {
      moved += 1;
      taken.add(donor);
      taken.add(target);
    } else {
      fitter.undo();
      fitter.xs[donor] = ox;
      fitter.ys[donor] = oy;
      taken.add(donor);
    }
  }
  return moved;
}

/* ---------------- the diagram at the picture's own size ---------------- */

export interface VoronoiNode {
  /** Where it is, in the picture's pixels. */
  x: number;
  y: number;
  /** Its color, not premultiplied. */
  color: Rgba;
  /** Its palette entry, or -1 for a color of its own. */
  entry: number;
  /** Pixels in its cell. */
  pixels: number;
}

export interface VoronoiFit {
  width: number;
  height: number;
  nodes: VoronoiNode[];
  /** Which node's cell each pixel is in. */
  owner: Int32Array;
  /** How far the diagram is from the picture: the mean difference per pixel (0..510, red, green, blue and opacity) and the peak signal to noise, in decibels. */
  error: { mean: number; psnr: number };
  palette: Rgba[] | null;
  relocated: number;
  rounds: number;
}

const unpremultiply = (c: ArrayLike<number>, at: number): Rgba => {
  const a = c[at + 3]!;
  if (a <= 0.5) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: Math.round(Math.min(255, (c[at]! * 255) / a)), g: Math.round(Math.min(255, (c[at + 1]! * 255) / a)), b: Math.round(Math.min(255, (c[at + 2]! * 255) / a)), a: Math.round(Math.min(255, a)) };
};

/** How far a diagram is from the picture: the mean difference per pixel and the peak signal to noise. */
function* measureWork(image: Bitmap, owner: Int32Array, colors: ArrayLike<number>): Generator<VoronoiProgress, { mean: number; psnr: number }> {
  const { width: W, height: H, data } = image;
  let total = 0;
  let squares = 0;
  for (let p = 0; p < W * H; p += 1) {
    if (p % (W * 64) === 0) yield { stage: 'finish', done: H + Math.floor(p / W), total: H * 2 };
    const i = owner[p]!;
    const a = data[p * 4 + 3]!;
    const v0 = (data[p * 4]! * a) / 255;
    const v1 = (data[p * 4 + 1]! * a) / 255;
    const v2 = (data[p * 4 + 2]! * a) / 255;
    const e = (v0 - colors[i * 4]!) ** 2 + (v1 - colors[i * 4 + 1]!) ** 2 + (v2 - colors[i * 4 + 2]!) ** 2 + (a - colors[i * 4 + 3]!) ** 2;
    squares += e;
    total += Math.sqrt(e);
  }
  const msePerChannel = squares / Math.max(1, W * H * 4);
  return { mean: total / Math.max(1, W * H), psnr: msePerChannel > 0 ? 10 * Math.log10((255 * 255) / msePerChannel) : 99 };
}

/**
 * The diagram at the picture's own size: the nodes where the fit put them,
 * every pixel in the cell of its nearest node, and each node's color fitted
 * again from the picture's own pixels.
 */
export function* finishWork(fit: WorkFit, image: Bitmap, palette: readonly Rgba[] | null): Generator<VoronoiProgress, VoronoiFit> {
  const { width: W, height: H, data } = image;
  const n = fit.xs.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = fit.xs[i]! / fit.picture.sx;
    ys[i] = fit.ys[i]! / fit.picture.sy;
  }
  const grid = new NearestGrid(xs, ys, n, W, H);
  const owner = new Int32Array(W * H);
  const sums = new Float64Array(n * 4);
  const counts = new Int32Array(n);
  for (let y = 0; y < H; y += 1) {
    if (y % 64 === 0) yield { stage: 'finish', done: y, total: H * 2 };
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      const i = grid.nearest(x + 0.5, y + 0.5);
      owner[p] = i;
      const a = data[p * 4 + 3]!;
      sums[i * 4] = sums[i * 4]! + (data[p * 4]! * a) / 255;
      sums[i * 4 + 1] = sums[i * 4 + 1]! + (data[p * 4 + 1]! * a) / 255;
      sums[i * 4 + 2] = sums[i * 4 + 2]! + (data[p * 4 + 2]! * a) / 255;
      sums[i * 4 + 3] = sums[i * 4 + 3]! + a;
      counts[i] = counts[i]! + 1;
    }
  }
  const pal = palette && palette.length > 0 ? premultipliedPalette(palette) : null;
  const colors = new Float64Array(n * 4);
  const entries = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const c = counts[i]!;
    if (c === 0) {
      // A node with no pixels keeps the color it had.
      for (let k = 0; k < 4; k += 1) colors[i * 4 + k] = fit.colors[i * 4 + k]!;
      entries[i] = fit.entries[i]!;
      continue;
    }
    const mean = [sums[i * 4]! / c, sums[i * 4 + 1]! / c, sums[i * 4 + 2]! / c, sums[i * 4 + 3]! / c];
    if (!pal) {
      for (let k = 0; k < 4; k += 1) colors[i * 4 + k] = mean[k]!;
      continue;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let e = 0; e < pal.length / 4; e += 1) {
      let d = 0;
      for (let k = 0; k < 4; k += 1) d += (pal[e * 4 + k]! - mean[k]!) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = e;
      }
    }
    entries[i] = best;
    for (let k = 0; k < 4; k += 1) colors[i * 4 + k] = pal[best * 4 + k]!;
  }
  const error = yield* measureWork(image, owner, colors);
  const nodes: VoronoiNode[] = Array.from({ length: n }, (_, i) => ({ x: xs[i]!, y: ys[i]!, color: unpremultiply(colors, i * 4), entry: entries[i]!, pixels: counts[i]! }));
  return {
    width: W,
    height: H,
    nodes,
    owner,
    error,
    palette: pal && palette ? [...palette] : null,
    relocated: fit.relocated,
    rounds: fit.rounds,
  };
}

/** Fit a diagram to a picture and finish it at the picture's size: the whole of it, as a generator. */
export function* voronoiWork(image: Bitmap, options: VoronoiOptions, palette: readonly Rgba[] | null): Generator<VoronoiProgress, VoronoiFit> {
  const picture = workPicture(image, workPixelsFor(options.nodes));
  const fit = yield* fitWork(picture, options, palette);
  return yield* finishWork(fit, image, palette);
}

/** `voronoiWork`, all at once. */
export function fitVoronoi(image: Bitmap, options: VoronoiOptions, palette: readonly Rgba[] | null = null): VoronoiFit {
  const work = voronoiWork(image, options, palette);
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

/* ---------------- what is written ---------------- */

/** The diagram as a picture: each pixel its cell's color. */
export function voronoiImage(fit: VoronoiFit): Bitmap {
  const data = new Uint8ClampedArray(fit.width * fit.height * 4);
  for (let p = 0; p < fit.owner.length; p += 1) {
    const c = fit.nodes[fit.owner[p]!]!.color;
    data[p * 4] = c.r;
    data[p * 4 + 1] = c.g;
    data[p * 4 + 2] = c.b;
    data[p * 4 + 3] = c.a;
  }
  return { width: fit.width, height: fit.height, data };
}

/** A color's key, for "the same color": the palette entry when there is one, else the hex. */
export function nodeColorKey(node: VoronoiNode): string {
  return node.entry >= 0 ? `e${node.entry}` : toHex(node.color);
}

/**
 * Which nodes are one area: cells of the same color that share an edge,
 * joined. Returns each node's area, numbered from 0, and how many there are.
 */
export function sameColorAreas(fit: VoronoiFit): { areaOf: Int32Array; count: number } {
  const n = fit.nodes.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const keys = fit.nodes.map(nodeColorKey);
  const { width: W, height: H, owner } = fit;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = owner[y * W + x]!;
      const pairs = [x + 1 < W ? owner[y * W + x + 1]! : o, y + 1 < H ? owner[(y + 1) * W + x]! : o];
      for (const other of pairs) {
        if (other === o || keys[other] !== keys[o]) continue;
        const a = root(o);
        const b = root(other);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const areaOf = new Int32Array(n);
  const number = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const r = root(i);
    if (!number.has(r)) number.set(r, number.size);
    areaOf[i] = number.get(r)!;
  }
  return { areaOf, count: number.size };
}

/* ---------------- the cells as shapes ---------------- */

/**
 * A cell's outline, exactly: the picture's rectangle cut by the line halfway
 * to every node near enough to matter. `sides[k]` is the node across the edge
 * from point k to point k + 1, or -1 for the picture's edge.
 */
export function cellPolygon(fit: Pick<VoronoiFit, 'width' | 'height' | 'nodes'>, i: number, grid: NearestGrid): { points: VectorPoint[]; sides: number[] } {
  let points: VectorPoint[] = [
    { x: 0, y: 0 },
    { x: fit.width, y: 0 },
    { x: fit.width, y: fit.height },
    { x: 0, y: fit.height },
  ];
  let sides = [-1, -1, -1, -1];
  const px = fit.nodes[i]!.x;
  const py = fit.nodes[i]!.y;
  const done = new Set<number>([i]);
  const candidates: number[] = [];
  let radius = grid.size * 1.5;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    grid.within(px, py, radius, candidates);
    // Nearest first: the polygon shrinks fastest, and later cuts are mostly no-ops.
    const fresh = candidates.filter((j) => !done.has(j)).sort((a, b) => (fit.nodes[a]!.x - px) ** 2 + (fit.nodes[a]!.y - py) ** 2 - ((fit.nodes[b]!.x - px) ** 2 + (fit.nodes[b]!.y - py) ** 2));
    for (const j of fresh) {
      done.add(j);
      const qx = fit.nodes[j]!.x;
      const qy = fit.nodes[j]!.y;
      // Keep the side nearer i: (q - p)·x ≤ (|q|² - |p|²) / 2.
      const ax = qx - px;
      const ay = qy - py;
      if (ax === 0 && ay === 0) {
        // Two nodes in one place: the cell is the lower-numbered one's, as the pixels are.
        if (j < i) return { points: [], sides: [] };
        continue;
      }
      const limit = (qx * qx + qy * qy - px * px - py * py) / 2;
      const clipped = clipHalfPlane(points, sides, ax, ay, limit, j);
      points = clipped.points;
      sides = clipped.sides;
      if (points.length === 0) return { points, sides };
    }
    // Every node that could cut it is within twice its furthest corner.
    let far = 0;
    for (const point of points) far = Math.max(far, Math.hypot(point.x - px, point.y - py));
    if (radius >= 2 * far + grid.size) break;
    // Out a ring at a time: a cell not yet closed on one side reaches the picture's edge, and every node would be looked at.
    radius = Math.min(radius * 2, 2 * far + grid.size);
  }
  return { points, sides };
}

function clipHalfPlane(points: VectorPoint[], sides: number[], ax: number, ay: number, limit: number, tag: number): { points: VectorPoint[]; sides: number[] } {
  const out: VectorPoint[] = [];
  const outSides: number[] = [];
  const count = points.length;
  const inside = (p: VectorPoint) => ax * p.x + ay * p.y <= limit + 1e-9;
  for (let k = 0; k < count; k += 1) {
    const a = points[k]!;
    const b = points[(k + 1) % count]!;
    const ain = inside(a);
    const bin = inside(b);
    const da = ax * a.x + ay * a.y - limit;
    const db = ax * b.x + ay * b.y - limit;
    const cross = () => {
      const t = da / (da - db);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    if (ain && bin) {
      out.push(a);
      outSides.push(sides[k]!);
    } else if (ain && !bin) {
      out.push(a);
      outSides.push(sides[k]!);
      out.push(cross());
      // From where it leaves to where it comes back in runs along the cut.
      outSides.push(tag);
    } else if (!ain && bin) {
      out.push(cross());
      outSides.push(sides[k]!);
    }
  }
  return { points: out, sides: outSides };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Drop points where the outline goes straight on, and repeats. */
function tidyLoop(points: VectorPoint[]): VectorPoint[] {
  let loop = points.map((p) => ({ x: round2(p.x), y: round2(p.y) }));
  let changed = true;
  while (changed && loop.length > 3) {
    changed = false;
    const out: VectorPoint[] = [];
    for (let k = 0; k < loop.length; k += 1) {
      const prev = out.length > 0 ? out[out.length - 1]! : loop[loop.length - 1]!;
      const cur = loop[k]!;
      const next = loop[(k + 1) % loop.length]!;
      if (Math.abs(cur.x - prev.x) < 1e-9 && Math.abs(cur.y - prev.y) < 1e-9) {
        changed = true;
        continue;
      }
      const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
      if (Math.abs(cross) < 1e-6) {
        changed = true;
        continue;
      }
      out.push(cur);
    }
    loop = out;
  }
  return loop;
}

const signedArea = (points: readonly VectorPoint[]) => {
  let sum = 0;
  for (let k = 0; k < points.length; k += 1) {
    const a = points[k]!;
    const b = points[(k + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
};

/** Even-odd: is the point inside the loop? */
function insideLoop(loop: readonly VectorPoint[], point: VectorPoint): boolean {
  let inside = false;
  for (let k = 0, previous = loop.length - 1; k < loop.length; previous = k, k += 1) {
    const a = loop[k]!;
    const b = loop[previous]!;
    if (a.y > point.y === b.y > point.y) continue;
    if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The diagram as shapes: a polygon for each cell, or — with `merge` — one for
 * each area of same-colored cells that share an edge, its outline the cells'
 * edges that face another color or the picture's edge, and holes where
 * another area is inside it. Nodes with no pixel make no cell (their
 * neighbours close over them, as in the picture), and fully see-through
 * cells make no shape.
 */
export function voronoiVector(fit: VoronoiFit, merge: boolean): VectorImage {
  const work = voronoiVectorWork(fit, merge);
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

/** `voronoiVector`, a slice at a time. */
export function* voronoiVectorWork(fit: VoronoiFit, merge: boolean): Generator<VoronoiProgress, VectorImage> {
  const n = fit.nodes.length;
  const xs = Float64Array.from(fit.nodes, (node) => node.x);
  const ys = Float64Array.from(fit.nodes, (node) => node.y);
  const skip = Uint8Array.from(fit.nodes, (node) => (node.pixels > 0 ? 0 : 1));
  const grid = new NearestGrid(xs, ys, n, fit.width, fit.height, skip);
  const cells: Array<{ points: VectorPoint[]; sides: number[] }> = [];
  for (let i = 0; i < n; i += 1) {
    if (i % 64 === 0) yield { stage: 'shapes', done: i, total: n };
    cells.push(skip[i] ? { points: [], sides: [] } : cellPolygon(fit, i, grid));
  }
  const shapes: VectorPolygon[] = [];
  if (!merge) {
    cells.forEach((cell, i) => {
      const color = fit.nodes[i]!.color;
      if (color.a === 0 || cell.points.length < 3) return;
      const points = tidyLoop(cell.points);
      if (points.length >= 3 && Math.abs(signedArea(points)) > 1e-6) shapes.push({ id: `cell-${i + 1}`, kind: 'polygon', color: toHex(color), points });
    });
    return { width: fit.width, height: fit.height, shapes };
  }

  // Cells of one color that share an edge are one area.
  const keys = fit.nodes.map(nodeColorKey);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  cells.forEach((cell, i) => {
    for (const j of cell.sides) {
      if (j < 0 || keys[j] !== keys[i]) continue;
      const a = root(i);
      const b = root(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    if (cells[i]!.points.length < 3) continue;
    const r = root(i);
    const list = members.get(r) ?? [];
    list.push(i);
    members.set(r, list);
  }

  // Each corner once: the same corner worked out from two cells can differ in its last digits.
  const corners = new Map<string, { key: string; point: VectorPoint }>();
  const corner = (p: VectorPoint) => {
    const gx = Math.round(p.x * 512);
    const gy = Math.round(p.y * 512);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const found = corners.get(`${gx + dx},${gy + dy}`);
        if (found) return found;
      }
    }
    const made = { key: `${gx},${gy}`, point: p };
    corners.set(made.key, made);
    return made;
  };

  for (const [area, cellsOfArea] of [...members].sort((a, b) => a[0] - b[0])) {
    const color = fit.nodes[area]!.color;
    if (color.a === 0) continue;
    // The edges facing out of the area, from start to end. Every cell winds the same way, so the area's outline does too, and its holes the other way.
    const outgoing = new Map<string, Array<{ from: VectorPoint; toKey: string }>>();
    for (const i of cellsOfArea) {
      const { points, sides } = cells[i]!;
      for (let k = 0; k < points.length; k += 1) {
        const side = sides[k]!;
        if (side >= 0 && cells[side]!.points.length >= 3 && root(side) === area) continue;
        const from = corner(points[k]!);
        const to = corner(points[(k + 1) % points.length]!);
        if (from.key === to.key) continue;
        const list = outgoing.get(from.key) ?? [];
        list.push({ from: from.point, toKey: to.key });
        outgoing.set(from.key, list);
      }
    }
    const loops: VectorPoint[][] = [];
    for (const [startKey] of outgoing) {
      while ((outgoing.get(startKey)?.length ?? 0) > 0) {
        const loop: VectorPoint[] = [];
        let key = startKey;
        for (let guard = 0; guard < 1_000_000; guard += 1) {
          const list = outgoing.get(key);
          if (!list || list.length === 0) break;
          const edge = list.pop()!;
          loop.push(edge.from);
          key = edge.toKey;
          if (key === startKey) break;
        }
        const tidy = loop.length >= 3 ? tidyLoop(loop) : [];
        if (tidy.length >= 3 && Math.abs(signedArea(tidy)) > 1e-6) loops.push(tidy);
      }
    }
    const outlines = loops.filter((loop) => signedArea(loop) > 0).sort((a, b) => signedArea(b) - signedArea(a));
    if (outlines.length === 0) continue;
    const holesOf = outlines.map((): VectorPoint[][] => []);
    for (const hole of loops.filter((loop) => signedArea(loop) < 0)) {
      // Inside the smallest outline that has most of its corners in it.
      let best = 0;
      for (let k = outlines.length - 1; k >= 0; k -= 1) {
        const inside = hole.filter((point) => insideLoop(outlines[k]!, point)).length;
        if (inside * 2 >= hole.length) {
          best = k;
          break;
        }
      }
      holesOf[best]!.push(hole);
    }
    outlines.forEach((points, k) => {
      const id = `area-${shapes.length + 1}`;
      const holes = holesOf[k]!;
      shapes.push(holes.length > 0 ? { id, kind: 'polygon', color: toHex(color), points, holes } : { id, kind: 'polygon', color: toHex(color), points });
    });
  }
  return { width: fit.width, height: fit.height, shapes };
}

/** nodes.json: every node, where it is and its color, how well the diagram fits, and the picture it was fitted to. */
export function voronoiNodesFile(data: VoronoiFlowData, fit: VoronoiFit, source: string | null = null): string {
  return `${JSON.stringify(
    {
      kind: 'voronoi',
      version: 1,
      width: fit.width,
      height: fit.height,
      source,
      settings: { nodes: data.nodes, refine: data.refine, palette: fit.palette ? fit.palette.map(toHex) : null },
      error: { mean: Math.round(fit.error.mean * 100) / 100, psnr: Math.round(fit.error.psnr * 100) / 100 },
      relocated: fit.relocated,
      rounds: fit.rounds,
      nodes: fit.nodes.map((node) => ({ x: round2(node.x), y: round2(node.y), color: toHex(node.color), ...(node.entry >= 0 ? { entry: node.entry } : {}), pixels: node.pixels })),
    },
    null,
    2,
  )}\n`;
}

/** nodes.json read back. */
export interface VoronoiNodesFile {
  width: number;
  height: number;
  /** The hash of the picture it was fitted to, when known. */
  source: string | null;
  settings: { nodes: number; refine: number; palette: string[] | null };
  relocated: number;
  rounds: number;
  nodes: Array<{ x: number; y: number; color: Rgba; entry: number }>;
}

/** Read nodes.json; null when it is not one. */
export function readVoronoiNodes(json: unknown): VoronoiNodesFile | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  if (record.kind !== 'voronoi' || !Array.isArray(record.nodes)) return null;
  const width = Number(record.width);
  const height = Number(record.height);
  if (!(width > 0 && height > 0)) return null;
  const nodes: VoronoiNodesFile['nodes'] = [];
  for (const raw of record.nodes) {
    if (nodes.length >= MAX_VORONOI_NODES) break;
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const x = Number(node.x);
    const y = Number(node.y);
    const color = typeof node.color === 'string' ? fromHex(node.color) : undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !color) continue;
    nodes.push({ x, y, color, entry: Number.isInteger(node.entry) && (node.entry as number) >= 0 ? (node.entry as number) : -1 });
  }
  if (nodes.length === 0) return null;
  const settings = (record.settings && typeof record.settings === 'object' ? record.settings : {}) as Record<string, unknown>;
  const palette = Array.isArray(settings.palette) ? settings.palette.filter((hex): hex is string => typeof hex === 'string' && fromHex(hex) !== undefined) : null;
  return {
    width,
    height,
    source: typeof record.source === 'string' ? record.source : null,
    settings: { nodes: Number(settings.nodes) || nodes.length, refine: Number(settings.refine) || 0, palette },
    relocated: Number(record.relocated) || 0,
    rounds: Number(record.rounds) || 0,
    nodes,
  };
}

/**
 * A diagram from nodes already placed and colored — nodes.json read back —
 * on a picture: every pixel labelled again, and how far off it is measured.
 * A picture of another size has the nodes scaled to it.
 */
export function diagramFromNodes(image: Bitmap, file: VoronoiNodesFile): VoronoiFit {
  const { width: W, height: H } = image;
  const n = file.nodes.length;
  const xs = Float64Array.from(file.nodes, (node) => (node.x * W) / file.width);
  const ys = Float64Array.from(file.nodes, (node) => (node.y * H) / file.height);
  const grid = new NearestGrid(xs, ys, n, W, H);
  const owner = new Int32Array(W * H);
  const counts = new Int32Array(n);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = grid.nearest(x + 0.5, y + 0.5);
      owner[y * W + x] = i;
      counts[i] = counts[i]! + 1;
    }
  }
  const colors = new Float64Array(n * 4);
  file.nodes.forEach((node, i) => {
    colors[i * 4] = (node.color.r * node.color.a) / 255;
    colors[i * 4 + 1] = (node.color.g * node.color.a) / 255;
    colors[i * 4 + 2] = (node.color.b * node.color.a) / 255;
    colors[i * 4 + 3] = node.color.a;
  });
  const measuring = measureWork(image, owner, colors);
  let next = measuring.next();
  while (!next.done) next = measuring.next();
  return {
    width: W,
    height: H,
    nodes: file.nodes.map((node, i) => ({ x: xs[i]!, y: ys[i]!, color: { ...node.color }, entry: node.entry, pixels: counts[i]! })),
    owner,
    error: next.value,
    palette: file.settings.palette ? file.settings.palette.map((hex) => fromHex(hex)!) : null,
    relocated: file.relocated,
    rounds: file.rounds,
  };
}

/** The report, in words. */
export function voronoiReport(data: VoronoiFlowData, fit: VoronoiFit | null, vector: VectorImage | null = null): string {
  const lines = ['# Voronoi diagram', ''];
  if (!fit) return `${lines.join('\n')}Not fitted yet: open the flow and press Fit.\n`;
  const used = fit.nodes.filter((node) => node.pixels > 0).length;
  const areas = sameColorAreas(fit).count;
  lines.push(
    `A ${fit.width} × ${fit.height} picture as ${fit.nodes.length} node(s)${used < fit.nodes.length ? ` (${used} with any pixels)` : ''}, after ${fit.rounds} round(s) of nudging; ${fit.relocated} node(s) moved to where the fit was worst.`,
    '',
    fit.palette ? `- Colors: only the palette's ${fit.palette.length} (${fit.palette.map(toHex).join(', ')}).` : '- Colors: each node its cell’s average.',
    `- How far off: ${fit.error.mean.toFixed(2)} on average per pixel (red, green, blue and opacity; 0 is exact), ${fit.error.psnr.toFixed(1)} dB peak signal to noise.`,
    `- ${areas} area(s) of same-colored cells that touch.`,
    vector ? `- As shapes: ${vector.shapes.length} polygon(s)${data.merge ? ', same-colored cells joined' : ', one per cell'}.` : '- Not written as shapes.',
    '',
  );
  return lines.join('\n');
}

export function summariseVoronoi(data: VoronoiFlowData): string {
  return `${data.nodes} node(s), ${data.refine} round(s)${data.output === 'picture' ? '' : data.output === 'vector' ? ', as shapes' : ', as a picture and shapes'}`;
}
