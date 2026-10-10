import type { Bitmap } from './cutout';
import type { Rgba } from './palette';
import { DEFAULT_VIDEO_SAMPLING, type VideoSampling } from './videoMatch';
import { fitWork, seededRandom, workPicture, workPixelsFor, type WorkFit } from './voronoi';

/**
 * The background of a video clip: what stays put while everything else moves.
 *
 * The clip is sampled into frames — so many a second, or so many in all — and
 * the background is built from them in three steps:
 *
 * 1. **Steady.** A camera that shakes or drifts moves the whole picture from
 *    one frame to the next. Each frame is lined up with the ones before it —
 *    the shift that makes it match best, each pixel's difference capped so
 *    what moves in front does not pull it — and the background is drawn in
 *    the frames' common place.
 * 2. **What never changes.** A pixel whose colour stays within the
 *    **tolerance** in every frame that sees it is background, as its average.
 *    Every pixel that changed is left clear.
 * 3. **Rebuild what moved, patch by patch.** For each patch with pixels that
 *    changed, each frame's version of the patch is compared with every other
 *    frame's — a pixel matching where each has the other's colour within a
 *    pixel of it, so an edge that wavers is still the same edge — those that match
 *    are grouped, and the biggest group — frames
 *    next to each other in it counting more, since a background shown in a
 *    frame is shown in the frames beside it too — is the background there, if
 *    it is in at least the **agreement** share of the frames. Its changed
 *    pixels are filled from those frames; otherwise they stay clear.
 *
 * Or, with the **Voronoi areas** algorithm, steps 2 and 3 are done by areas
 * instead of pixels and patches: each frame is drawn as a Voronoi diagram in
 * one palette of colours shared by every frame, the cells of one colour that
 * touch are an area, and an area that changes — moves, or grows or shrinks —
 * against the areas of its colour in the other frames is taken to be animated.
 * The frames are laid over each other, lined up, and each pixel of the
 * background is the middle colour of the frames where it is not in an
 * animated area.
 *
 * What a moving character covered in some frames but not in others can then be
 * put back by hand. Choose a frame where that part of the background can be
 * seen, and draw a **region** round it or **paint** it: those pixels are taken
 * from that frame. Painting with the eraser takes pixels out instead. Each
 * stroke and region belongs to its frame, and they are laid on in the order
 * they were made.
 */

export interface BackgroundRegion {
  id: string;
  kind: 'region';
  /** The frame, by its time in seconds. */
  time: number;
  mode: 'include' | 'exclude';
  /** The outline, in frame pixels, flattened `x, y, x, y, …`. */
  points: number[];
}

export interface BackgroundStroke {
  id: string;
  kind: 'stroke';
  time: number;
  mode: 'include' | 'exclude';
  /** The brush's radius, in frame pixels. */
  radius: number;
  /** The path, in frame pixels, flattened `x, y, x, y, …`. */
  points: number[];
}

export type BackgroundMark = BackgroundRegion | BackgroundStroke;

export interface VideoBackgroundFlowData {
  editor: 'videoBackground';
  sampling: VideoSampling;
  /** How far apart two colours may be and still count as the same, 0..100. */
  tolerance: number;
  /** The share of frames, in percent, a patch's background must be seen in to be rebuilt from them. */
  agreement: number;
  /** Line the frames up with each other first, following a camera that moves. */
  steady: boolean;
  /** The most the picture may move from one frame read to the next, in frame pixels. */
  maxShift: number;
  /** Rebuild what moved, patch by patch, from the frames that show the background there. */
  rebuild: boolean;
  /** The side of a patch, in frame pixels. */
  patch: number;
  /** How what moved is found: pixel by pixel and patch by patch, or by the areas of each frame's Voronoi diagram. */
  algorithm: 'patches' | 'voronoi';
  /** Voronoi areas: the nodes in each frame's diagram. */
  nodes: number;
  /** Voronoi areas: the colours of the palette every frame's diagram shares. */
  colours: number;
  /** Voronoi areas: how much an area must change against the other frames, in percent, to be animated. */
  moving: number;
  /** Voronoi areas: show the chosen frame's areas instead of the frame. */
  showAreas: boolean;
  /** The video the frames were read from, and the size they were read at. */
  video?: { hash?: string; duration: number; width: number; height: number };
  frameSize?: { width: number; height: number };
  marks: BackgroundMark[];
  /** The frame shown for marking, by time; null shows the background. */
  current: number | null;
  tool: 'region' | 'paint' | 'erase';
  brush: number;
}

export const DEFAULT_BACKGROUND_TOLERANCE = 8;
export const DEFAULT_BACKGROUND_AGREEMENT = 30;
export const DEFAULT_BACKGROUND_MAX_SHIFT = 24;
export const DEFAULT_BACKGROUND_PATCH = 16;
export const DEFAULT_BACKGROUND_NODES = 400;
export const DEFAULT_BACKGROUND_COLOURS = 12;
export const DEFAULT_BACKGROUND_MOVING = 35;
/** Two frames' versions of a patch are the same where at least this share of its changed pixels match. */
export const PATCH_SAME_SHARE = 0.9;
/** A patch's versions are put in no more groups than this; any more join the nearest. */
const MAX_PATCH_GROUPS = 24;
/** A patch's versions are compared on at most this many of its changed pixels, spread through it. */
const PATCH_SAMPLES = 96;
/** Frames are read no wider than this. */
export const MAX_BACKGROUND_WIDTH = 1280;
/** Every frame is held at once to find each pixel's commonest colour, so this many pixels in all, frames times area. */
export const BACKGROUND_PIXEL_BUDGET = 40_000_000;

export function emptyVideoBackgroundFlowData(): VideoBackgroundFlowData {
  return {
    editor: 'videoBackground',
    sampling: { ...DEFAULT_VIDEO_SAMPLING, mode: 'total', total: 24 },
    tolerance: DEFAULT_BACKGROUND_TOLERANCE,
    agreement: DEFAULT_BACKGROUND_AGREEMENT,
    steady: true,
    maxShift: DEFAULT_BACKGROUND_MAX_SHIFT,
    rebuild: true,
    patch: DEFAULT_BACKGROUND_PATCH,
    algorithm: 'patches',
    nodes: DEFAULT_BACKGROUND_NODES,
    colours: DEFAULT_BACKGROUND_COLOURS,
    moving: DEFAULT_BACKGROUND_MOVING,
    showAreas: false,
    marks: [],
    current: null,
    tool: 'paint',
    brush: 12,
  };
}

/**
 * The size frames are read at: the video's own, unless holding that many
 * frames that big would be too much, or it is wider than the cap.
 */
export function backgroundFrameSize(video: { width: number; height: number }, frames: number): { width: number; height: number } {
  if (!(video.width > 0 && video.height > 0)) return { width: 1, height: 1 };
  const aspect = video.height / video.width;
  const budgetWidth = Math.sqrt(BACKGROUND_PIXEL_BUDGET / Math.max(1, frames) / aspect);
  const width = Math.max(16, Math.floor(Math.min(video.width, MAX_BACKGROUND_WIDTH, budgetWidth)));
  return { width, height: Math.max(1, Math.round(width * aspect)) };
}

/** The settings the background is built with. */
export type BackgroundOptions = Pick<VideoBackgroundFlowData, 'tolerance' | 'agreement' | 'steady' | 'maxShift' | 'rebuild' | 'patch'>;

/**
 * Where the background sits in a frame: the frame's pixel `(x + dx, y + dy)`
 * shows the background's `(x, y)`. All zero for a camera that never moved.
 */
export interface FrameOffset {
  dx: number;
  dy: number;
}

/** Where a background pixel came from. */
export const PIXEL_CLEAR = 0;
export const PIXEL_STILL = 1;
export const PIXEL_REBUILT = 2;
export const PIXEL_MARKED = 3;

export interface BackgroundResult {
  image: Bitmap;
  /** For each pixel, where it came from: `PIXEL_CLEAR`, `PIXEL_STILL`, `PIXEL_REBUILT` or `PIXEL_MARKED`. */
  source: Uint8Array;
  /** Where the background sits in each frame. */
  offsets: FrameOffset[];
  stats: {
    frames: number;
    /** Pixels that never changed. */
    still: number;
    /** Pixels that changed, rebuilt from patches. */
    rebuilt: number;
    marked: number;
    total: number;
    /** The furthest any frame sat from the background's place, in pixels. */
    moved: number;
    /** Voronoi areas: how many areas there were in all the frames, and how many were animated. */
    areas?: { total: number; animated: number };
  };
  /** Voronoi areas: each frame's areas, and how much each changed. */
  areas?: VoronoiAreas;
}

/** How far the work has got, for showing while it runs. */
export interface BackgroundProgress {
  stage: 'steady' | 'still' | 'patches' | 'palette' | 'diagrams' | 'motion' | 'combine';
  done: number;
  total: number;
}

/* ---------------- 1. steadying ---------------- */

/** A picture's brightness at one size; `valid`, when given, is 0 where the picture is clear and has nothing to match. */
export interface BrightnessLevel {
  w: number;
  h: number;
  data: Uint8Array;
  valid?: Uint8Array;
}
type Level = BrightnessLevel;

/**
 * A picture's brightness, and halved again and again: coarse to look far,
 * fine to be exact. With `clearIsMissing`, its see-through pixels are left out
 * of any match (a background with holes where nothing could be put back).
 */
export function brightnessLevels(frame: Bitmap, levels: number, clearIsMissing = false): BrightnessLevel[] {
  const { width: w, height: h, data } = frame;
  const base = new Uint8Array(w * h);
  for (let p = 0, q = 0; p < w * h; p += 1, q += 4) base[p] = (data[q]! * 77 + data[q + 1]! * 150 + data[q + 2]! * 29) >> 8;
  let valid: Uint8Array | undefined;
  if (clearIsMissing) {
    valid = new Uint8Array(w * h);
    let missing = 0;
    for (let p = 0; p < w * h; p += 1) {
      valid[p] = data[p * 4 + 3]! >= 128 ? 1 : 0;
      missing += 1 - valid[p]!;
    }
    if (missing === 0) valid = undefined;
  }
  const out: Level[] = [{ w, h, data: base, ...(valid ? { valid } : {}) }];
  while (out.length < levels) {
    const prev = out[out.length - 1]!;
    const nw = prev.w >> 1;
    const nh = prev.h >> 1;
    const next = new Uint8Array(nw * nh);
    const nextValid = prev.valid ? new Uint8Array(nw * nh) : undefined;
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        const i = y * 2 * prev.w + x * 2;
        next[y * nw + x] = (prev.data[i]! + prev.data[i + 1]! + prev.data[i + prev.w]! + prev.data[i + prev.w + 1]! + 2) >> 2;
        if (nextValid) nextValid[y * nw + x] = prev.valid![i]! & prev.valid![i + 1]! & prev.valid![i + prev.w]! & prev.valid![i + prev.w + 1]!;
      }
    }
    out.push({ w: nw, h: nh, data: next, ...(nextValid ? { valid: nextValid } : {}) });
  }
  return out;
}

/** Halve while the picture stays at least 80 × 24, at most five times. */
export function levelCount(width: number, height: number): number {
  let levels = 1;
  let w = width;
  let h = height;
  while (levels < 6 && w >> 1 >= 80 && h >> 1 >= 24) {
    w >>= 1;
    h >>= 1;
    levels += 1;
  }
  return levels;
}

/** A pixel's difference counts no more than this: what moves in front costs the same at any shift. */
const MISMATCH_CAP = 48;

/**
 * How badly `b`, moved by `(sx, sy)`, matches `a`: the mean brightness
 * difference over where they overlap, each pixel's capped. A picture of flat
 * colours matches at many shifts but along its edges, so every pixel counts —
 * leaving out the worst, as a trimmed mean would, leaves out the edges — and
 * the cap keeps something moving in front from pulling the match: it differs
 * by about as much wherever the frames are lined up. Too little overlap is no
 * match at all.
 */
function mismatchAt(a: Level, b: Level, sx: number, sy: number, sparse: boolean): number {
  const { w, h } = a;
  const x0 = Math.max(0, -sx);
  const x1 = Math.min(w, w - sx);
  const y0 = Math.max(0, -sy);
  const y1 = Math.min(h, h - sy);
  if ((x1 - x0) * (y1 - y0) < 0.3 * w * h) return Infinity;
  let n = 0;
  let looked = 0;
  let sum = 0;
  const valid = a.valid;
  // Sparse, every other pixel as on a chessboard: half the work, and still
  // every row and column looked at, so a shift of one pixel either way shows.
  const step = sparse ? 2 : 1;
  for (let y = y0; y < y1; y += 1) {
    const rowA = y * w;
    const rowB = (y + sy) * w + sx;
    for (let x = sparse ? x0 + ((x0 + y) & 1) : x0; x < x1; x += step) {
      looked += 1;
      if (valid && !valid[rowA + x]) continue;
      const d = a.data[rowA + x]! - b.data[rowB + x]!;
      const v = d < 0 ? -d : d;
      sum += v < MISMATCH_CAP ? v : MISMATCH_CAP;
      n += 1;
    }
  }
  // Too little of it has anything to match: no match at all.
  if (n < 0.1 * looked) return Infinity;
  return sum / Math.max(1, n);
}

/**
 * The shift that lines `cur` up with `ref`: searched near `guess` on the
 * coarsest level, then made exact level by level, never more than `radius`
 * pixels from the guess. A shift no better than the guess by more than noise
 * is not taken.
 */
export function bestShift(ref: BrightnessLevel[], cur: BrightnessLevel[], guess: FrameOffset, radius: number): FrameOffset {
  const top = ref.length - 1;
  let sx = Math.round(guess.dx / 2 ** top);
  let sy = Math.round(guess.dy / 2 ** top);
  for (let level = top; level >= 0; level -= 1) {
    const scale = 2 ** level;
    let reach = 1;
    if (level === top) reach = Math.max(1, Math.ceil(radius / scale));
    else {
      // The coarser level's answer, twice as fine: right to within a pixel either way.
      sx *= 2;
      sy *= 2;
    }
    const a = ref[level]!;
    const b = cur[level]!;
    const sparse = a.w * a.h > 100_000;
    const gx = guess.dx / scale;
    const gy = guess.dy / scale;
    // No further from the guess than `radius`, give or take a coarse pixel's rounding.
    const slack = radius / scale + (level > 0 ? 0.5 : 0);
    let best = { x: Math.round(gx), y: Math.round(gy), cost: Infinity };
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const x = sx + dx;
        const y = sy + dy;
        if (Math.abs(x - gx) > slack + 1e-9 || Math.abs(y - gy) > slack + 1e-9) continue;
        // A hair's preference for the guess, so a flat picture that matches anywhere stays put.
        const cost = mismatchAt(a, b, x, y, sparse) + 0.002 * (Math.abs(x - gx) + Math.abs(y - gy));
        if (cost < best.cost) best = { x, y, cost };
      }
    }
    sx = best.x;
    sy = best.y;
  }
  const sparse = ref[0]!.w * ref[0]!.h > 100_000;
  const stay = mismatchAt(ref[0]!, cur[0]!, guess.dx, guess.dy, sparse);
  const moved = mismatchAt(ref[0]!, cur[0]!, sx, sy, sparse);
  return stay - moved < 0.15 ? { dx: guess.dx, dy: guess.dy } : { dx: sx, dy: sy };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1] ?? 0;
}

/**
 * Where the background sits in each frame, following the camera.
 *
 * Each frame is lined up with the frame it is being followed from — the one
 * before it to start with — searching near where the frame before it was, so
 * the search follows a pan however far it goes, and up to `maxShift` pixels
 * from there. A frame is lined up with that one frame, not with the one just
 * before it, so a slow drift of a fraction of a pixel a frame adds up rather
 * than rounding away; once a frame has moved a quarter of the picture from
 * it, the frames after are followed from that frame instead. The background's
 * place is then the middle of where the frames were.
 */
export function* steadyWork(frames: readonly Bitmap[], maxShift: number): Generator<BackgroundProgress, FrameOffset[]> {
  const offsets: FrameOffset[] = frames.map(() => ({ dx: 0, dy: 0 }));
  const first = frames[0];
  if (!first || frames.length < 2 || !(maxShift > 0)) return offsets;
  const { width, height } = first;
  const levels = levelCount(width, height);
  let ref = brightnessLevels(first, levels);
  let refAt: FrameOffset = { dx: 0, dy: 0 };
  for (let f = 1; f < frames.length; f += 1) {
    yield { stage: 'steady', done: f, total: frames.length };
    const frame = frames[f]!;
    if (frame.width !== width || frame.height !== height) continue;
    const cur = brightnessLevels(frame, levels);
    const before = offsets[f - 1]!;
    const shift = bestShift(ref, cur, { dx: before.dx - refAt.dx, dy: before.dy - refAt.dy }, maxShift);
    offsets[f] = { dx: refAt.dx + shift.dx, dy: refAt.dy + shift.dy };
    if (Math.abs(shift.dx) > width / 4 || Math.abs(shift.dy) > height / 4) {
      ref = cur;
      refAt = offsets[f]!;
    }
  }
  const mx = median(offsets.map((offset) => offset.dx));
  const my = median(offsets.map((offset) => offset.dy));
  return offsets.map((offset) => ({ dx: offset.dx - mx, dy: offset.dy - my }));
}

/** `steadyWork`, all at once. */
export function steadyOffsets(frames: readonly Bitmap[], maxShift: number): FrameOffset[] {
  return finish(steadyWork(frames, maxShift));
}

function finish<T>(work: Generator<BackgroundProgress, T>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

/* ---------------- 2 and 3. what never changes, and patches ---------------- */

function emptyResult(): BackgroundResult {
  return {
    image: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    source: new Uint8Array(0),
    offsets: [],
    stats: { frames: 0, still: 0, rebuilt: 0, marked: 0, total: 0, moved: 0 },
  };
}

/**
 * Build the background from frames all the same size, in the order they were
 * read (see the top of this file). `steadied`, when given, is where the
 * background sits in each frame, worked out before (see `steadyWork`), so a
 * change of tolerance or patch size does not line the frames up again.
 *
 * A generator, yielding as it goes, so a page can run it a slice at a time
 * and stay responsive; `buildBackground` runs it all at once.
 */
export function* backgroundWork(frames: readonly Bitmap[], options: BackgroundOptions, steadied?: readonly FrameOffset[]): Generator<BackgroundProgress, BackgroundResult> {
  const first = frames[0];
  if (!first) return emptyResult();
  const { width: w, height: h } = first;
  const count = frames.length;
  if (frames.some((frame) => frame.width !== w || frame.height !== h)) throw new Error('the frames are not all the same size');
  const offsets: FrameOffset[] = steadied && steadied.length === count ? steadied.map((offset) => ({ ...offset })) : options.steady ? yield* steadyWork(frames, options.maxShift) : frames.map(() => ({ dx: 0, dy: 0 }));
  const odx = Int32Array.from(offsets, (offset) => offset.dx);
  const ody = Int32Array.from(offsets, (offset) => offset.dy);
  const total = w * h;
  const out = new Uint8ClampedArray(total * 4);
  const source = new Uint8Array(total);
  const changed = new Uint8Array(total);
  // Distances are compared squared, on the 0..255 channel scale.
  const limit = Math.max(0, options.tolerance) * 5.1;
  const limit2 = limit * limit + 1e-9;

  // 2. A pixel is still if its colour stays within the tolerance across every frame that sees it.
  let still = 0;
  for (let y = 0; y < h; y += 1) {
    if (y % 8 === 0) yield { stage: 'still', done: y, total: h };
    for (let x = 0; x < w; x += 1) {
      let seen = 0;
      let r0 = 255;
      let r1 = 0;
      let g0 = 255;
      let g1 = 0;
      let b0 = 255;
      let b1 = 0;
      let a0 = 255;
      let a1 = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let f = 0; f < count; f += 1) {
        const fx = x + odx[f]!;
        const fy = y + ody[f]!;
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
        const d = frames[f]!.data;
        const at = (fy * w + fx) * 4;
        const r = d[at]!;
        const g = d[at + 1]!;
        const b = d[at + 2]!;
        const a = d[at + 3]!;
        if (r < r0) r0 = r;
        if (r > r1) r1 = r;
        if (g < g0) g0 = g;
        if (g > g1) g1 = g;
        if (b < b0) b0 = b;
        if (b > b1) b1 = b;
        if (a < a0) a0 = a;
        if (a > a1) a1 = a;
        sr += r;
        sg += g;
        sb += b;
        sa += a;
        seen += 1;
      }
      if (seen === 0) continue;
      const p = y * w + x;
      const dr = r1 - r0;
      const dg = g1 - g0;
      const db = b1 - b0;
      const da = a1 - a0;
      if (dr * dr + dg * dg + db * db + da * da <= limit2) {
        const at = p * 4;
        out[at] = Math.round(sr / seen);
        out[at + 1] = Math.round(sg / seen);
        out[at + 2] = Math.round(sb / seen);
        out[at + 3] = Math.round(sa / seen);
        source[p] = PIXEL_STILL;
        still += 1;
      } else changed[p] = 1;
    }
  }

  // 3. Each patch with pixels that changed: the biggest, steadiest group of its versions is the background there.
  let rebuilt = 0;
  if (options.rebuild && count >= 2) {
    const size = Math.max(2, Math.round(options.patch));
    const cols = Math.ceil(w / size);
    const rows = Math.ceil(h / size);
    const needed = Math.max(0, Math.min(100, options.agreement)) / 100;
    const colourAt = (f: number, p: number): number => ((Math.floor(p / w) + ody[f]!) * w + (p % w) + odx[f]!) * 4;
    const differs = (f: number, g: number, p: number): boolean => {
      const df = frames[f]!.data;
      const dg = frames[g]!.data;
      const i = colourAt(f, p);
      const j = colourAt(g, p);
      const r = df[i]! - dg[j]!;
      const gr = df[i + 1]! - dg[j + 1]!;
      const b = df[i + 2]! - dg[j + 2]!;
      const a = df[i + 3]! - dg[j + 3]!;
      return r * r + gr * gr + b * b + a * a > limit2;
    };
    // Whether frame f's colour at p is within the tolerance of one of frame g's colours within a pixel of it.
    const nearIn = (f: number, g: number, p: number): boolean => {
      const df = frames[f]!.data;
      const dg = frames[g]!.data;
      const i = colourAt(f, p);
      const gx = (p % w) + odx[g]!;
      const gy = Math.floor(p / w) + ody[g]!;
      for (let y = Math.max(0, gy - 1); y <= Math.min(h - 1, gy + 1); y += 1) {
        for (let x = Math.max(0, gx - 1); x <= Math.min(w - 1, gx + 1); x += 1) {
          const j = (y * w + x) * 4;
          const r = df[i]! - dg[j]!;
          const gr = df[i + 1]! - dg[j + 1]!;
          const b = df[i + 2]! - dg[j + 2]!;
          const a = df[i + 3]! - dg[j + 3]!;
          if (r * r + gr * gr + b * b + a * a <= limit2) return true;
        }
      }
      return false;
    };
    // Two versions of a patch match at p if each has the other's colour within a pixel of it: an edge
    // that wavers by a pixel from frame to frame — compression noise, a camera lined up to the nearest
    // pixel — is the same edge, while a character in front, even a thin one, has colours the other
    // has nowhere near.
    const unlike = (f: number, g: number, p: number): boolean => differs(f, g, p) && !(nearIn(f, g, p) && nearIn(g, f, p));
    for (let row = 0; row < rows; row += 1) {
      yield { stage: 'patches', done: row, total: rows };
      for (let col = 0; col < cols; col += 1) {
        const x0 = col * size;
        const y0 = row * size;
        const x1 = Math.min(w, x0 + size);
        const y1 = Math.min(h, y0 + size);
        const pixels: number[] = [];
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (changed[y * w + x]) pixels.push(y * w + x);
        if (pixels.length === 0) continue;
        // The frames that see the whole patch, in the order they were read.
        const seen: number[] = [];
        for (let f = 0; f < count; f += 1) {
          if (x0 + odx[f]! >= 0 && y0 + ody[f]! >= 0 && x1 - 1 + odx[f]! < w && y1 - 1 + ody[f]! < h) seen.push(f);
        }
        if (seen.length < 2) continue;
        const step = Math.max(1, Math.ceil(pixels.length / PATCH_SAMPLES));
        const sample = pixels.filter((_, index) => index % step === 0);
        const allowed = Math.floor(sample.length * (1 - PATCH_SAME_SHARE) + 1e-9);
        // Group the versions: each joins the first group whose first version it matches, or starts one.
        const seeds: number[] = [];
        const groupOf = new Int32Array(seen.length);
        for (let i = 0; i < seen.length; i += 1) {
          const f = seen[i]!;
          let joined = -1;
          let nearest = 0;
          let nearestMisses = Infinity;
          for (let k = 0; k < seeds.length && joined < 0; k += 1) {
            let misses = 0;
            for (const p of sample) {
              if (unlike(f, seeds[k]!, p)) misses += 1;
              if (misses > allowed && misses >= nearestMisses) break;
            }
            if (misses <= allowed) joined = k;
            else if (misses < nearestMisses) {
              nearestMisses = misses;
              nearest = k;
            }
          }
          if (joined < 0) {
            if (seeds.length < MAX_PATCH_GROUPS) {
              seeds.push(f);
              joined = seeds.length - 1;
            } else joined = nearest;
          }
          groupOf[i] = joined;
        }
        // A group counts each of its frames, and half again for each frame read just after another of its own.
        const score = new Float64Array(seeds.length);
        const members = new Uint32Array(seeds.length);
        for (let i = 0; i < seen.length; i += 1) {
          const k = groupOf[i]!;
          members[k] = members[k]! + 1;
          score[k] = score[k]! + 1 + (i > 0 && groupOf[i - 1] === k && seen[i - 1] === seen[i]! - 1 ? 0.5 : 0);
        }
        let best = 0;
        for (let k = 1; k < seeds.length; k += 1) if (score[k]! > score[best]!) best = k;
        if (members[best]! / seen.length + 1e-9 < needed) continue;
        // Each changed pixel: the average of the group's frames that match its first version there.
        const seed = seeds[best]!;
        for (const p of pixels) {
          let n = 0;
          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;
          for (let i = 0; i < seen.length; i += 1) {
            if (groupOf[i] !== best) continue;
            const f = seen[i]!;
            if (f !== seed && differs(f, seed, p)) continue;
            const d = frames[f]!.data;
            const at = colourAt(f, p);
            sr += d[at]!;
            sg += d[at + 1]!;
            sb += d[at + 2]!;
            sa += d[at + 3]!;
            n += 1;
          }
          const at = p * 4;
          out[at] = Math.round(sr / n);
          out[at + 1] = Math.round(sg / n);
          out[at + 2] = Math.round(sb / n);
          out[at + 3] = Math.round(sa / n);
          source[p] = PIXEL_REBUILT;
          rebuilt += 1;
        }
      }
    }
  }
  const moved = offsets.reduce((most, offset) => Math.max(most, Math.hypot(offset.dx, offset.dy)), 0);
  return { image: { width: w, height: h, data: out }, source, offsets, stats: { frames: count, still, rebuilt, marked: 0, total, moved: Math.round(moved * 10) / 10 } };
}

/** `backgroundWork`, all at once. */
export function buildBackground(frames: readonly Bitmap[], options: BackgroundOptions, steadied?: readonly FrameOffset[]): BackgroundResult {
  return finish(backgroundWork(frames, options, steadied));
}

/* ---------------- or: by Voronoi areas ---------------- */

/** The settings the Voronoi areas algorithm is run with. */
export type VoronoiBackgroundOptions = Pick<VideoBackgroundFlowData, 'steady' | 'maxShift' | 'nodes' | 'colours' | 'moving'>;

/** One frame as areas of one colour: the cells of its Voronoi diagram that touch and share a colour, joined. */
export interface FrameAreas {
  /** The size the diagram was fitted at, and its pixels for each frame pixel across and down. */
  width: number;
  height: number;
  sx: number;
  sy: number;
  /** Each of its pixels' area. */
  area: Int32Array;
  /** Each area's palette entry, and its size in the diagram's pixels. */
  entries: Int32Array;
  sizes: Int32Array;
  /** How much each area changed against the other frames: the share of it they do not show in its colour, 0 to 1. */
  change: Float32Array;
}

export interface VoronoiAreas {
  /** What they were worked out with: the nodes, colours, and where the background sits in each frame. */
  key: string;
  palette: Rgba[];
  frames: FrameAreas[];
}

/** Pixels sampled from all the frames to find the palette. */
const PALETTE_SAMPLES = 60_000;
/** Rounds of nudging for the first frame's diagram, and for each after, which starts from the one before. */
const FIRST_FRAME_ROUNDS = 8;
const NEXT_FRAME_ROUNDS = 4;
/** Each frame's areas are compared with at most this many other frames, spread through the clip. */
const COMPARED_FRAMES = 16;
/** A background pixel is taken from the frames whose area there changed least: no more than this over the least. */
const CHANGE_MARGIN = 0.1;

/** What a set of areas was worked out with: the same key, the same areas. */
export function voronoiAreasKey(options: Pick<VoronoiBackgroundOptions, 'nodes' | 'colours'>, offsets: readonly FrameOffset[]): string {
  return JSON.stringify([Math.round(options.nodes), Math.round(options.colours), offsets.map((offset) => [offset.dx, offset.dy])]);
}

/**
 * A palette of `count` colours for every frame: k-means on pixels sampled
 * from all of them, started k-means++ from a seeded random number, so the
 * same frames give the same palette.
 */
export function* sharedPaletteWork(frames: readonly Bitmap[], count: number, seed = 7): Generator<BackgroundProgress, Rgba[]> {
  const random = seededRandom(seed);
  const perFrame = Math.ceil(PALETTE_SAMPLES / Math.max(1, frames.length));
  const values: number[] = [];
  for (const frame of frames) {
    const pixels = frame.width * frame.height;
    const stride = Math.max(1, Math.floor(pixels / perFrame));
    for (let p = Math.floor(random() * stride); p < pixels; p += stride) {
      values.push(frame.data[p * 4]!, frame.data[p * 4 + 1]!, frame.data[p * 4 + 2]!, frame.data[p * 4 + 3]!);
    }
  }
  const m = values.length / 4;
  const k = Math.max(1, Math.min(Math.round(count), m));
  if (m === 0) return [];
  const samples = Float32Array.from(values);
  const centres = new Float64Array(k * 4);
  const distance = (i: number, c: number) => {
    let d = 0;
    for (let ch = 0; ch < 4; ch += 1) d += (samples[i * 4 + ch]! - centres[c * 4 + ch]!) ** 2;
    return d;
  };
  // k-means++: each next centre a sample picked with a chance that grows with its distance from the nearest so far.
  const first = Math.floor(random() * m);
  for (let ch = 0; ch < 4; ch += 1) centres[ch] = samples[first * 4 + ch]!;
  const nearest = new Float64Array(m).fill(Number.POSITIVE_INFINITY);
  let made = 1;
  for (; made < k; made += 1) {
    let sum = 0;
    for (let i = 0; i < m; i += 1) {
      const d = distance(i, made - 1);
      if (d < nearest[i]!) nearest[i] = d;
      sum += nearest[i]!;
    }
    if (sum <= 0) break;
    let pick = random() * sum;
    let chosen = m - 1;
    for (let i = 0; i < m; i += 1) {
      pick -= nearest[i]!;
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    for (let ch = 0; ch < 4; ch += 1) centres[made * 4 + ch] = samples[chosen * 4 + ch]!;
  }
  // Lloyd's rounds: each sample to its nearest centre, each centre to the middle of its samples.
  const sums = new Float64Array(made * 5);
  for (let round = 0; round < 12; round += 1) {
    yield { stage: 'palette', done: round, total: 12 };
    sums.fill(0);
    for (let i = 0; i < m; i += 1) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < made; c += 1) {
        const d = distance(i, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      for (let ch = 0; ch < 4; ch += 1) sums[best * 5 + ch] = sums[best * 5 + ch]! + samples[i * 4 + ch]!;
      sums[best * 5 + 4] = sums[best * 5 + 4]! + 1;
    }
    let moved = 0;
    for (let c = 0; c < made; c += 1) {
      const n = sums[c * 5 + 4]!;
      if (n === 0) continue;
      for (let ch = 0; ch < 4; ch += 1) {
        const next = sums[c * 5 + ch]! / n;
        moved = Math.max(moved, Math.abs(next - centres[c * 4 + ch]!));
        centres[c * 4 + ch] = next;
      }
    }
    if (moved < 0.25) break;
  }
  const palette: Rgba[] = [];
  const seen = new Set<string>();
  for (let c = 0; c < made; c += 1) {
    const colour = { r: Math.round(centres[c * 4]!), g: Math.round(centres[c * 4 + 1]!), b: Math.round(centres[c * 4 + 2]!), a: Math.round(centres[c * 4 + 3]!) };
    const key = `${colour.r},${colour.g},${colour.b},${colour.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    palette.push(colour);
  }
  return palette;
}

/** A frame's diagram as areas: cells that touch and share a palette entry, joined. */
export function areasOfFit(fit: WorkFit): Pick<FrameAreas, 'area' | 'entries' | 'sizes' | 'change'> {
  const { width: w, height: h } = fit.picture;
  const n = fit.xs.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const join = (a: number, b: number) => {
    if (a === b || fit.entries[a] !== fit.entries[b]) return;
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = fit.owner[y * w + x]!;
      if (x + 1 < w) join(o, fit.owner[y * w + x + 1]!);
      if (y + 1 < h) join(o, fit.owner[(y + 1) * w + x]!);
    }
  }
  const number = new Int32Array(n).fill(-1);
  const entries: number[] = [];
  const sizes: number[] = [];
  const area = new Int32Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const r = root(fit.owner[p]!);
    if (number[r] === -1) {
      number[r] = entries.length;
      entries.push(fit.entries[r]!);
      sizes.push(0);
    }
    const a = number[r]!;
    area[p] = a;
    sizes[a] = sizes[a]! + 1;
  }
  return { area, entries: Int32Array.from(entries), sizes: Int32Array.from(sizes), change: new Float32Array(entries.length) };
}

/** The frames each frame is compared with: every other, or `most` spread through the clip. */
function comparedWith(f: number, count: number, most: number): number[] {
  if (count - 1 <= most) return Array.from({ length: count }, (_, g) => g).filter((g) => g !== f);
  const picked = new Set<number>();
  for (let k = 0; k < most; k += 1) {
    let g = Math.min(count - 1, Math.floor(((k + 0.5) * count) / most));
    if (g === f) g = g + 1 < count ? g + 1 : g - 1;
    picked.add(g);
  }
  return [...picked].sort((a, b) => a - b);
}

/** For each pixel of a frame's diagram, the palette entries within a pixel of it: bit e of `low` (e < 32) or of `high`. */
function entriesNear(frame: FrameAreas): { low: Uint32Array; high: Uint32Array } {
  const { width: w, height: h } = frame;
  const low = new Uint32Array(w * h);
  const high = new Uint32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const e = frame.entries[frame.area[y * w + x]!]!;
      const bit = (1 << (e & 31)) >>> 0;
      const into = e < 32 ? low : high;
      for (let v = Math.max(0, y - 1); v <= Math.min(h - 1, y + 1); v += 1) {
        for (let u = Math.max(0, x - 1); u <= Math.min(w - 1, x + 1); u += 1) into[v * w + u] = (into[v * w + u]! | bit) >>> 0;
      }
    }
  }
  return { low, high };
}

/**
 * How much each area of each frame changed. Against each frame it is compared
 * with — lined up by where the background sits in each — the share of its
 * pixels that frame does not show in its colour, within a pixel (so an edge
 * that wavers, or a thin line the diagram draws a little differently, is the
 * same); the middle of those is its change. An area that moved its own width,
 * or is gone, changed by 1; one that grew changed in the frames it grew into.
 * An area mostly out of sight in a frame is not compared with it; one
 * compared with none has not been seen to change.
 */
export function* areaChangeWork(frames: FrameAreas[], offsets: readonly FrameOffset[]): Generator<BackgroundProgress, void> {
  const count = frames.length;
  const near = frames.map(entriesNear);
  for (let f = 0; f < count; f += 1) {
    yield { stage: 'motion', done: f, total: count };
    const A = frames[f]!;
    const { width: w, height: h } = A;
    const nA = A.sizes.length;
    const samples: number[][] = Array.from({ length: nA }, () => []);
    const shown = new Int32Array(nA);
    const kept = new Int32Array(nA);
    for (const g of comparedWith(f, count, COMPARED_FRAMES)) {
      const B = frames[g]!;
      if (B.width !== w || B.height !== h) continue;
      const { low, high } = near[g]!;
      // Frame f's pixel shows the background frame g shows this far across and down from it.
      const su = Math.round((offsets[g]!.dx - offsets[f]!.dx) * A.sx);
      const sv = Math.round((offsets[g]!.dy - offsets[f]!.dy) * A.sy);
      shown.fill(0);
      kept.fill(0);
      for (let v = Math.max(0, -sv); v < Math.min(h, h - sv); v += 1) {
        for (let u = Math.max(0, -su); u < Math.min(w, w - su); u += 1) {
          const a = A.area[v * w + u]!;
          const e = A.entries[a]!;
          const q = (v + sv) * w + u + su;
          shown[a] = shown[a]! + 1;
          if ((((e < 32 ? low[q]! : high[q]!) >>> (e & 31)) & 1) === 1) kept[a] = kept[a]! + 1;
        }
      }
      for (let a = 0; a < nA; a += 1) {
        if (shown[a]! * 2 < A.sizes[a]!) continue;
        samples[a]!.push(1 - kept[a]! / shown[a]!);
      }
    }
    for (let a = 0; a < nA; a += 1) A.change[a] = samples[a]!.length > 0 ? median(samples[a]!) : 0;
  }
}

/**
 * Each frame as a Voronoi diagram in one shared palette, as areas, and how
 * much each area changed. Each frame's diagram starts from the one before's
 * nodes, moved by how far the camera moved, so what did not move is drawn the
 * same way.
 */
export function* voronoiAreasWork(frames: readonly Bitmap[], offsets: readonly FrameOffset[], options: Pick<VoronoiBackgroundOptions, 'nodes' | 'colours'>): Generator<BackgroundProgress, VoronoiAreas> {
  const key = voronoiAreasKey(options, offsets);
  const palette = yield* sharedPaletteWork(frames, options.colours);
  const count = frames.length;
  const out: FrameAreas[] = [];
  let start: Array<{ x: number; y: number }> | undefined;
  for (let f = 0; f < count; f += 1) {
    const picture = workPicture(frames[f]!, workPixelsFor(options.nodes));
    const run = fitWork(picture, { nodes: options.nodes, refine: start ? NEXT_FRAME_ROUNDS : FIRST_FRAME_ROUNDS, seed: 1, ...(start ? { start } : {}) }, palette);
    let fit: WorkFit;
    for (;;) {
      const next = run.next();
      if (next.done) {
        fit = next.value;
        break;
      }
      yield { stage: 'diagrams', done: f + next.value.done / Math.max(1, next.value.total), total: count };
    }
    out.push({ width: picture.width, height: picture.height, sx: picture.sx, sy: picture.sy, ...areasOfFit(fit) });
    // The next frame's diagram starts here: each node where it shows the same background in that frame.
    const next = offsets[f + 1];
    if (next) {
      const here = offsets[f]!;
      start = Array.from(fit.xs, (x, i) => ({ x: x / picture.sx + next.dx - here.dx, y: fit.ys[i]! / picture.sy + next.dy - here.dy }));
    }
  }
  yield* areaChangeWork(out, offsets);
  return { key, palette, frames: out };
}

/** A mask grown by one pixel all round. */
function grownByOne(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      for (let v = Math.max(0, y - 1); v <= Math.min(h - 1, y + 1); v += 1) for (let u = Math.max(0, x - 1); u <= Math.min(w - 1, x + 1); u += 1) out[v * w + u] = 1;
    }
  }
  return out;
}

/** Which areas of a frame are animated: those that changed by at least `moving` percent. */
export function animatedAreas(frame: FrameAreas, moving: number): Uint8Array {
  const threshold = Math.max(0, Math.min(100, moving)) / 100;
  return Uint8Array.from(frame.change, (change) => (change >= threshold - 1e-9 ? 1 : 0));
}

/** The middle of the first `n` values. */
function middleOf(values: Uint8Array, n: number): number {
  for (let i = 1; i < n; i += 1) {
    const v = values[i]!;
    let j = i - 1;
    while (j >= 0 && values[j]! > v) {
      values[j + 1] = values[j]!;
      j -= 1;
    }
    values[j + 1] = v;
  }
  return n % 2 === 1 ? values[(n - 1) >> 1]! : Math.round((values[n / 2 - 1]! + values[n / 2]!) / 2);
}

/**
 * The background by Voronoi areas (see the top of this file): each frame drawn
 * as a diagram in one shared palette, its areas of one colour found, those that
 * change by at least `moving` percent against the other frames taken to be
 * animated, and every background pixel the middle colour of the frames where
 * it is not in an animated area — grown by a pixel of the diagram, for the
 * edge a cell cuts across — and, of those, where its area changed least. `known`, when its key matches, is the areas worked
 * out before, so a change of `moving` alone does not draw the frames again.
 */
export function* voronoiBackgroundWork(
  frames: readonly Bitmap[],
  options: VoronoiBackgroundOptions,
  steadied?: readonly FrameOffset[],
  known?: VoronoiAreas | null,
): Generator<BackgroundProgress, BackgroundResult> {
  const first = frames[0];
  if (!first) return emptyResult();
  const { width: w, height: h } = first;
  const count = frames.length;
  if (frames.some((frame) => frame.width !== w || frame.height !== h)) throw new Error('the frames are not all the same size');
  const offsets: FrameOffset[] = steadied && steadied.length === count ? steadied.map((offset) => ({ ...offset })) : options.steady ? yield* steadyWork(frames, options.maxShift) : frames.map(() => ({ dx: 0, dy: 0 }));
  const key = voronoiAreasKey(options, offsets);
  const areas = known && known.key === key && known.frames.length === count ? known : yield* voronoiAreasWork(frames, offsets, options);

  let totalAreas = 0;
  let animatedCount = 0;
  const animated = areas.frames.map((frame) => {
    const moving = animatedAreas(frame, options.moving);
    totalAreas += moving.length;
    for (const one of moving) animatedCount += one;
    const mask = new Uint8Array(frame.width * frame.height);
    for (let p = 0; p < mask.length; p += 1) mask[p] = moving[frame.area[p]!]!;
    return grownByOne(mask, frame.width, frame.height);
  });
  // Where each frame pixel is in its diagram, across and down.
  const columns = areas.frames.map((frame) => Int32Array.from({ length: w }, (_, x) => Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.sx))));
  const rows = areas.frames.map((frame) => Int32Array.from({ length: h }, (_, y) => Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.sy))));

  const odx = Int32Array.from(offsets, (offset) => offset.dx);
  const ody = Int32Array.from(offsets, (offset) => offset.dy);
  const total = w * h;
  const out = new Uint8ClampedArray(total * 4);
  const source = new Uint8Array(total);
  const channels = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)] as const;
  const changes = new Float32Array(count);
  let still = 0;
  let rebuilt = 0;
  for (let y = 0; y < h; y += 1) {
    if (y % 8 === 0) yield { stage: 'combine', done: y, total: h };
    for (let x = 0; x < w; x += 1) {
      let seen = 0;
      let n = 0;
      let least = Number.POSITIVE_INFINITY;
      for (let f = 0; f < count; f += 1) {
        const fx = x + odx[f]!;
        const fy = y + ody[f]!;
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
        seen += 1;
        const frame = areas.frames[f]!;
        const q = rows[f]![fy]! * frame.width + columns[f]![fx]!;
        if (animated[f]![q]) continue;
        const at = (fy * w + fx) * 4;
        const d = frames[f]!.data;
        channels[0][n] = d[at]!;
        channels[1][n] = d[at + 1]!;
        channels[2][n] = d[at + 2]!;
        channels[3][n] = d[at + 3]!;
        const change = frame.change[frame.area[q]!]!;
        changes[n] = change;
        if (change < least) least = change;
        n += 1;
      }
      if (n === 0) continue;
      // Of those, the frames whose area here changed least: an area a character's edge joined, in a frame, changed more.
      let kept = 0;
      for (let i = 0; i < n; i += 1) {
        if (changes[i]! > least + CHANGE_MARGIN) continue;
        for (let c = 0; c < 4; c += 1) channels[c]![kept] = channels[c]![i]!;
        kept += 1;
      }
      const p = y * w + x;
      for (let c = 0; c < 4; c += 1) out[p * 4 + c] = middleOf(channels[c]!, kept);
      if (n === seen) {
        source[p] = PIXEL_STILL;
        still += 1;
      } else {
        source[p] = PIXEL_REBUILT;
        rebuilt += 1;
      }
    }
  }
  const moved = offsets.reduce((most, offset) => Math.max(most, Math.hypot(offset.dx, offset.dy)), 0);
  return {
    image: { width: w, height: h, data: out },
    source,
    offsets,
    stats: { frames: count, still, rebuilt, marked: 0, total, moved: Math.round(moved * 10) / 10, areas: { total: totalAreas, animated: animatedCount } },
    areas,
  };
}

/** `voronoiBackgroundWork`, all at once. */
export function buildVoronoiBackground(frames: readonly Bitmap[], options: VoronoiBackgroundOptions, steadied?: readonly FrameOffset[], known?: VoronoiAreas | null): BackgroundResult {
  return finish(voronoiBackgroundWork(frames, options, steadied, known));
}

/**
 * A frame's areas as a picture at the frame's size: each in its palette
 * colour, its edges dark, and the animated ones striped red.
 */
export function areasPicture(areas: VoronoiAreas, index: number, width: number, height: number, moving: number): Bitmap {
  const frame = areas.frames[index];
  const data = new Uint8ClampedArray(width * height * 4);
  if (!frame) return { width, height, data };
  const animated = animatedAreas(frame, moving);
  const column = Int32Array.from({ length: width }, (_, x) => Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.sx)));
  const row = Int32Array.from({ length: height }, (_, y) => Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.sy)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = frame.area[row[y]! * frame.width + column[x]!]!;
      const right = x + 1 < width ? frame.area[row[y]! * frame.width + column[x + 1]!]! : a;
      const down = y + 1 < height ? frame.area[row[y + 1]! * frame.width + column[x]!]! : a;
      const colour = areas.palette[frame.entries[a]!] ?? { r: 0, g: 0, b: 0, a: 255 };
      const at = (y * width + x) * 4;
      if (right !== a || down !== a) data.set([20, 20, 24, 255], at);
      else if (animated[a] && (x + y) % 8 < 3) data.set([255, 40, 60, 255], at);
      else data.set([colour.r, colour.g, colour.b, 255], at);
    }
  }
  return { width, height, data };
}

/** Which pixels a mark covers: 1 inside, in a frame this size. */
export function markMask(mark: BackgroundMark, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const points = mark.points;
  if (mark.kind === 'region') {
    const count = points.length / 2;
    if (count < 3) return mask;
    // Even-odd, by scanline through pixel centres.
    for (let y = 0; y < height; y += 1) {
      const cy = y + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const x1 = points[i * 2]!;
        const y1 = points[i * 2 + 1]!;
        const x2 = points[((i + 1) % count) * 2]!;
        const y2 = points[((i + 1) % count) * 2 + 1]!;
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) crossings.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil(crossings[k]! - 0.5));
        const to = Math.min(width - 1, Math.floor(crossings[k + 1]! - 0.5));
        for (let x = from; x <= to; x += 1) mask[y * width + x] = 1;
      }
    }
    return mask;
  }
  // A stroke: a disc at every point, and along every segment between them.
  const radius = Math.max(0.5, mark.radius);
  const r2 = radius * radius;
  const count = points.length / 2;
  for (let i = 0; i < count; i += 1) {
    const ax = points[i * 2]!;
    const ay = points[i * 2 + 1]!;
    const bx = i + 1 < count ? points[(i + 1) * 2]! : ax;
    const by = i + 1 < count ? points[(i + 1) * 2 + 1]! : ay;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radius));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + radius));
    const vx = bx - ax;
    const vy = by - ay;
    const length2 = vx * vx + vy * vy;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const t = length2 > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / length2)) : 0;
        const dx = px - t * vx;
        const dy = py - t * vy;
        if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Lay the marks over the background worked out from the frames: an include
 * takes its frame's pixels, an exclude clears them. A mark is drawn on its
 * frame, so it is moved by where the background sits in that frame.
 * `frameAt` finds the frame read nearest a time.
 */
export function applyMarks(result: BackgroundResult, marks: readonly BackgroundMark[], frameAt: (time: number) => { bitmap: Bitmap; offset: FrameOffset } | undefined): BackgroundResult {
  const { width, height } = result.image;
  const data = new Uint8ClampedArray(result.image.data);
  const source = new Uint8Array(result.source);
  const touched = new Uint8Array(width * height);
  for (const mark of marks) {
    const frame = frameAt(mark.time);
    const fits = frame && frame.bitmap.width === width && frame.bitmap.height === height;
    if (mark.mode === 'include' && !fits) continue;
    const offset = fits ? frame.offset : { dx: 0, dy: 0 };
    const mask = markMask(mark, width, height);
    for (let q = 0; q < mask.length; q += 1) {
      if (!mask[q]) continue;
      const x = (q % width) - offset.dx;
      const y = Math.floor(q / width) - offset.dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const p = y * width + x;
      const at = p * 4;
      touched[p] = 1;
      if (mark.mode === 'exclude') {
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
        data[at + 3] = 0;
        source[p] = PIXEL_CLEAR;
      } else {
        const from = frame!.bitmap.data;
        data[at] = from[q * 4]!;
        data[at + 1] = from[q * 4 + 1]!;
        data[at + 2] = from[q * 4 + 2]!;
        data[at + 3] = from[q * 4 + 3]!;
        source[p] = PIXEL_MARKED;
      }
    }
  }
  let marked = 0;
  for (const value of touched) marked += value;
  return { ...result, image: { width, height, data }, source, stats: { ...result.stats, marked } };
}

/**
 * Which of a frame's pixels show the background as built so far: 1 where the
 * background is filled in, for laying over the frame while it is marked.
 */
export function backgroundInFrame(result: BackgroundResult, offset: FrameOffset): Uint8Array {
  const { width, height, data } = result.image;
  const shown = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const by = y - offset.dy;
    if (by < 0 || by >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const bx = x - offset.dx;
      if (bx >= 0 && bx < width && data[(by * width + bx) * 4 + 3]! > 0) shown[y * width + x] = 1;
    }
  }
  return shown;
}

/** The frame read nearest a time. */
export function nearestFrame<T extends { time: number }>(frames: readonly T[], time: number): T | undefined {
  let best: T | undefined;
  for (const frame of frames) if (!best || Math.abs(frame.time - time) < Math.abs(best.time - time)) best = frame;
  return best;
}

const signed = (value: number): string => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0');

/** The report written beside the background: how it was built, and where the background sits in each frame. */
export function backgroundReport(data: VideoBackgroundFlowData, stats: BackgroundResult['stats'] | null, frames: readonly { time: number; offset: FrameOffset }[] = []): string {
  const lines = ['# Background', ''];
  if (!data.video || !stats) return `${lines.join('\n')}Not worked out yet: open the flow and press Read the frames.\n`;
  const sampling = data.sampling.mode === 'fps' ? `${data.sampling.fps} frame(s) a second` : `${data.sampling.total} frame(s) in all`;
  const share = (count: number) => `${((count / Math.max(1, stats.total)) * 100).toFixed(1)}%`;
  const clear = Math.max(0, stats.total - stats.still - stats.rebuilt);
  const voronoi = data.algorithm === 'voronoi';
  lines.push(
    `A ${data.video.duration.toFixed(2)}s video, ${data.video.width} × ${data.video.height}, read at ${data.frameSize?.width ?? '?'} × ${data.frameSize?.height ?? '?'} and sampled at ${sampling}: ${stats.frames} frame(s).`,
    '',
    data.steady
      ? stats.moved > 0
        ? `- Steadied: each frame lined up with the ones before it, up to ${data.maxShift} px a frame. The picture moved up to ${stats.moved} px; where the background sits in each frame is below.`
        : `- Steadied, up to ${data.maxShift} px a frame: the picture did not move.`
      : '- Not steadied: the frames are compared where they are.',
    ...(voronoi
      ? [
          `- By Voronoi areas: each frame drawn as a diagram of ${data.nodes} node(s) in the same ${data.colours} colour(s); cells of one colour that touch are an area${stats.areas ? ` — ${stats.areas.total.toLocaleString()} in all, ${stats.areas.animated.toLocaleString()} animated` : ''}, changing by ${data.moving}% or more against the areas of their colour in the other frames.`,
          `- Never in an animated area: ${stats.still.toLocaleString()} pixels (${share(stats.still)}). Each takes the middle colour of the frames.`,
          `- In an animated area in some frames: ${stats.rebuilt.toLocaleString()} pixels (${share(stats.rebuilt)}), each the middle colour of the frames where it was not.`,
        ]
      : [
          `- Never changed, within ${data.tolerance}: ${stats.still.toLocaleString()} pixels (${share(stats.still)}). Each takes its average colour.`,
          data.rebuild
            ? `- Changed, rebuilt from ${data.patch} px patches: ${stats.rebuilt.toLocaleString()} pixels (${share(stats.rebuilt)}), each from the biggest group of frames that show the same in its patch, where that is at least ${data.agreement}% of them.`
            : '- Changed: left clear (rebuilding from patches is off).',
        ]),
    `- Marked by hand: ${stats.marked.toLocaleString()} pixels (${share(stats.marked)}), in ${data.marks.length} region(s) and stroke(s).`,
    `- Clear before marking: ${clear.toLocaleString()} pixels (${share(clear)}).`,
    '',
    '`background.png` is clear wherever nothing could be put back and nothing was marked.',
    '',
  );
  if (data.steady && stats.moved > 0 && frames.length > 0) {
    lines.push('## Where the background sits in each frame', '', 'A frame’s pixel at (x + right, y + down) shows the background’s (x, y).', '', '| Frame at | Right | Down |', '|---|---|---|');
    for (const frame of frames.slice(0, 500)) lines.push(`| ${frame.time.toFixed(3)}s | ${signed(frame.offset.dx)} | ${signed(frame.offset.dy)} |`);
    if (frames.length > 500) lines.push(`| … ${frames.length - 500} more | | |`);
    lines.push('');
  }
  return lines.join('\n');
}
