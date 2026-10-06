import type { Bitmap } from './cutout';
import { bestShift, brightnessLevels, levelCount, type BackgroundProgress, type FrameOffset } from './videoBackground';
import { DEFAULT_VIDEO_SAMPLING, type VideoSampling } from './videoMatch';

/**
 * What moves in front of a background: a video's frames with the background
 * taken out, so only the characters are left, on clear.
 *
 * The background is the picture Video Background made from the same clip (or
 * any picture of the scene with nothing in front). The video is sampled into
 * frames, so many a second or so many in all, read at the background's size,
 * and each frame is worked on in four steps:
 *
 * 1. **Lined up.** A camera that shakes or pans moves the scene in the frame;
 *    the frame is lined up with the background — the shift that matches it
 *    best, searched near where the frame before sat — so the background's
 *    pixel behind each of the frame's is known. The background's own clear
 *    pixels are left out of the match.
 * 2. **Taken apart.** A frame pixel is background where its colour is within
 *    the **tolerance** of the background's there, or of one of its neighbours
 *    (an edge that wavers by a pixel is not something moving). Anything else is
 *    in front. Where the background is clear — nothing could be put back there —
 *    there is nothing to compare: the pixel is kept, or cleared, as **where the
 *    background is clear** says. Where a camera move shows a strip past the
 *    background's edge, the background's nearest edge pixel stands in.
 * 3. **Tidied.** Pieces in front smaller than the **speck** size are dropped —
 *    compression noise, a flicker — and holes in what is kept no bigger than
 *    **fill holes** are filled: a character's shirt the colour of the wall
 *    behind it is still the character.
 * 4. **Grown** by a pixel or two, so the soft edge where a character meets the
 *    background comes with it.
 *
 * Each frame comes out the size it was read at, the character's own pixels
 * where something was in front and clear everywhere else.
 */

export interface VideoForegroundFlowData {
  editor: 'videoForeground';
  sampling: VideoSampling;
  /** Line each frame up with the background before comparing them. */
  steady: boolean;
  /** The most the picture may move from one frame read to the next, in pixels. */
  maxShift: number;
  /** How far a colour may be from the background's and still be the background, 0..100. */
  tolerance: number;
  /** Pieces in front smaller than this many pixels are dropped. */
  speck: number;
  /** Holes in what is kept up to this many pixels are filled. */
  holes: number;
  /** What is kept is grown by this many pixels. */
  grow: number;
  /** Where the background is clear: keep the frame's pixels, or clear them. */
  unknown: 'keep' | 'clear';
  /** The video and the background the frames were read from. */
  video?: { hash?: string; duration: number; width: number; height: number };
  background?: { hash?: string; width: number; height: number };
  /** The frame shown, by time; null shows the first. */
  current: number | null;
  /** What is shown of it. */
  view: 'cutout' | 'frame' | 'mask';
}

export const DEFAULT_FOREGROUND_TOLERANCE = 10;
export const DEFAULT_FOREGROUND_SPECK = 40;
export const DEFAULT_FOREGROUND_HOLES = 300;
export const DEFAULT_FOREGROUND_GROW = 1;
/** Every frame read is held at once, so this many pixels in all, frames times area. */
export const FOREGROUND_PIXEL_BUDGET = 60_000_000;

export function emptyVideoForegroundFlowData(): VideoForegroundFlowData {
  return {
    editor: 'videoForeground',
    sampling: { ...DEFAULT_VIDEO_SAMPLING, mode: 'total', total: 24 },
    steady: true,
    maxShift: 24,
    tolerance: DEFAULT_FOREGROUND_TOLERANCE,
    speck: DEFAULT_FOREGROUND_SPECK,
    holes: DEFAULT_FOREGROUND_HOLES,
    grow: DEFAULT_FOREGROUND_GROW,
    unknown: 'keep',
    current: null,
    view: 'cutout',
  };
}

export type ForegroundOptions = Pick<VideoForegroundFlowData, 'steady' | 'maxShift' | 'tolerance' | 'speck' | 'holes' | 'grow' | 'unknown'>;

/** How many frames fit in the budget at the background's size. */
export function foregroundFrameLimit(width: number, height: number): number {
  return Math.max(1, Math.floor(FOREGROUND_PIXEL_BUDGET / Math.max(1, width * height)));
}

/* ---------------- 1. lining up ---------------- */

export interface ForegroundProgress {
  stage: 'steady' | 'apart';
  done: number;
  total: number;
}

/**
 * Where the background sits in each frame (see `FrameOffset`): each frame
 * matched against the background itself, searched near where the frame
 * before sat and no further than `maxShift` from it, so the search follows a
 * pan from frame to frame. The background's clear pixels are left out of the
 * match.
 */
export function* alignToBackgroundWork(background: Bitmap, frames: readonly Bitmap[], maxShift: number): Generator<ForegroundProgress, FrameOffset[]> {
  const offsets: FrameOffset[] = frames.map(() => ({ dx: 0, dy: 0 }));
  if (frames.length === 0 || !(maxShift > 0)) return offsets;
  const levels = levelCount(background.width, background.height);
  const ref = brightnessLevels(background, levels, true);
  let guess: FrameOffset = { dx: 0, dy: 0 };
  for (let f = 0; f < frames.length; f += 1) {
    yield { stage: 'steady', done: f, total: frames.length };
    const frame = frames[f]!;
    if (frame.width !== background.width || frame.height !== background.height) continue;
    // The first frame is looked for over twice the reach: nothing before it says where it is.
    offsets[f] = bestShift(ref, brightnessLevels(frame, levels), guess, f === 0 ? maxShift * 2 : maxShift);
    guess = offsets[f]!;
  }
  return offsets;
}

/* ---------------- 2–4. one frame ---------------- */

export interface ForegroundFrame {
  /** The frame's pixels where something is in front, clear elsewhere. */
  image: Bitmap;
  /** 1 where something is in front. */
  mask: Uint8Array;
  offset: FrameOffset;
  stats: {
    /** Pixels kept. */
    kept: number;
    total: number;
    /** Separate pieces kept. */
    pieces: number;
    /** Pixels with no background to compare with. */
    unknown: number;
  };
}

/** Label the 1s of a mask in 8-connected pieces; returns each pixel's piece (0 for none) and the pieces' sizes. */
export function labelPieces(mask: Uint8Array, width: number, height: number, eight = true): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(width * height);
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    const label = sizes.length;
    let size = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size += 1;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (!eight && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack.push(q);
          }
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * One frame with the background taken out (see the top of this file). `frame`
 * and `background` are the same size; `offset` is where the background sits
 * in the frame.
 */
export function foregroundOf(frame: Bitmap, background: Bitmap, offset: FrameOffset, options: ForegroundOptions): ForegroundFrame {
  const { width: w, height: h } = frame;
  if (background.width !== w || background.height !== h) throw new Error('the frame and the background are not the same size');
  const f = frame.data;
  const b = background.data;
  const limit = Math.max(0, options.tolerance) * 5.1;
  const limit2 = limit * limit + 1e-9;
  const mask = new Uint8Array(w * h);
  let unknown = 0;
  // 2. In front where no background colour within a pixel is near the frame's.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const q = y * w + x;
      // Past the background's edge (a camera move shows a strip it never saw): its nearest edge pixel stands in.
      const bx = Math.min(w - 1, Math.max(0, x - offset.dx));
      const by = Math.min(h - 1, Math.max(0, y - offset.dy));
      const at = q * 4;
      let seen = false;
      let near = false;
      for (let ny = Math.max(0, by - 1); ny <= Math.min(h - 1, by + 1) && !near; ny += 1) {
        for (let nx = Math.max(0, bx - 1); nx <= Math.min(w - 1, bx + 1); nx += 1) {
          const j = (ny * w + nx) * 4;
          if (b[j + 3]! < 128) continue;
          // Only the pixel behind it counts as seeing the background; its neighbours only forgive a wavering edge.
          if (nx === bx && ny === by) seen = true;
          const dr = f[at]! - b[j]!;
          const dg = f[at + 1]! - b[j + 1]!;
          const db = f[at + 2]! - b[j + 2]!;
          if (dr * dr + dg * dg + db * db <= limit2) {
            near = true;
            break;
          }
        }
      }
      if (!seen) {
        // Nothing behind it to compare with (unless a neighbour matched anyway).
        if (near) continue;
        unknown += 1;
        if (options.unknown === 'keep') mask[q] = 1;
        continue;
      }
      if (!near) mask[q] = 1;
    }
  }
  // 3. Specks out, holes filled.
  const speck = Math.max(0, Math.round(options.speck));
  if (speck > 1) {
    const { labels, sizes } = labelPieces(mask, w, h);
    for (let p = 0; p < mask.length; p += 1) if (mask[p] && sizes[labels[p]!]! < speck) mask[p] = 0;
  }
  const holes = Math.max(0, Math.round(options.holes));
  if (holes > 0) {
    const open = new Uint8Array(w * h);
    for (let p = 0; p < open.length; p += 1) open[p] = mask[p] ? 0 : 1;
    const { labels, sizes } = labelPieces(open, w, h, false);
    const edge = new Set<number>();
    for (let x = 0; x < w; x += 1) {
      edge.add(labels[x]!);
      edge.add(labels[(h - 1) * w + x]!);
    }
    for (let y = 0; y < h; y += 1) {
      edge.add(labels[y * w]!);
      edge.add(labels[y * w + w - 1]!);
    }
    for (let p = 0; p < open.length; p += 1) {
      const label = labels[p]!;
      if (label && !edge.has(label) && sizes[label]! <= holes) mask[p] = 1;
    }
  }
  // 4. Grown, a pixel at a time, as a square.
  let grown = mask;
  for (let step = 0; step < Math.max(0, Math.round(options.grow)); step += 1) {
    const next = new Uint8Array(grown);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (grown[y * w + x]) continue;
        let touch = false;
        for (let dy = -1; dy <= 1 && !touch; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx >= 0 && nx < w && grown[ny * w + nx]) {
              touch = true;
              break;
            }
          }
        }
        if (touch) next[y * w + x] = 1;
      }
    }
    grown = next;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  let kept = 0;
  for (let p = 0; p < grown.length; p += 1) {
    if (!grown[p]) continue;
    out[p * 4] = f[p * 4]!;
    out[p * 4 + 1] = f[p * 4 + 1]!;
    out[p * 4 + 2] = f[p * 4 + 2]!;
    out[p * 4 + 3] = 255;
    kept += 1;
  }
  const pieces = kept > 0 ? labelPieces(grown, w, h).sizes.length - 1 : 0;
  return { image: { width: w, height: h, data: out }, mask: grown, offset, stats: { kept, total: w * h, pieces, unknown } };
}

/**
 * Every frame with the background taken out: lined up first (unless `offsets`
 * are given, worked out before, or steadying is off), then each frame in turn.
 * A generator, yielding as it goes, so a page can run it a slice at a time.
 */
export function* foregroundWork(
  background: Bitmap,
  frames: readonly Bitmap[],
  options: ForegroundOptions,
  offsets?: readonly FrameOffset[],
): Generator<ForegroundProgress | BackgroundProgress, ForegroundFrame[]> {
  const lined =
    offsets && offsets.length === frames.length
      ? offsets.map((offset) => ({ ...offset }))
      : options.steady
        ? yield* alignToBackgroundWork(background, frames, options.maxShift)
        : frames.map(() => ({ dx: 0, dy: 0 }));
  const out: ForegroundFrame[] = [];
  for (let f = 0; f < frames.length; f += 1) {
    yield { stage: 'apart', done: f, total: frames.length };
    out.push(foregroundOf(frames[f]!, background, lined[f]!, options));
  }
  return out;
}

/** `foregroundWork`, all at once. */
export function buildForeground(background: Bitmap, frames: readonly Bitmap[], options: ForegroundOptions, offsets?: readonly FrameOffset[]): ForegroundFrame[] {
  const work = foregroundWork(background, frames, options, offsets);
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

/* ---------------- what is written ---------------- */

/**
 * A frame's file name: its place in the order and the time it is from —
 * `frame-0003-at-1.250s.png` — so a flow that reads the folder knows both
 * without anything beside it.
 */
export function foregroundFrameName(index: number, time: number): string {
  return `frame-${String(index + 1).padStart(4, '0')}-at-${Math.max(0, time).toFixed(3)}s.png`;
}

/** A frame's place and time, from a name made by `foregroundFrameName`; the place from any name with a number in it. */
export function readFrameName(name: string): { index: number; time: number | null } {
  const full = /frame-(\d+)-at-(\d+(?:\.\d+)?)s\.png$/i.exec(name);
  if (full) return { index: Number(full[1]) - 1, time: Number(full[2]) };
  const number = /(\d+)(?!.*\d)/.exec(name);
  return { index: number ? Number(number[1]) - 1 : 0, time: null };
}

export interface ForegroundSummary {
  time: number;
  offset: FrameOffset;
  kept: number;
  total: number;
  pieces: number;
}

/** foreground.json: each frame's file, time, where the background sat in it, and how much was kept. */
export function foregroundFile(data: VideoForegroundFlowData, frames: readonly ForegroundSummary[]): string {
  return `${JSON.stringify(
    {
      kind: 'foreground',
      version: 1,
      video: data.video ?? null,
      size: data.background ? { width: data.background.width, height: data.background.height } : null,
      settings: { tolerance: data.tolerance, speck: data.speck, holes: data.holes, grow: data.grow, unknown: data.unknown, steady: data.steady, maxShift: data.maxShift },
      frames: frames.map((frame, index) => ({
        file: foregroundFrameName(index, frame.time),
        time: Math.round(frame.time * 1000) / 1000,
        offset: frame.offset,
        kept: frame.kept,
        share: Math.round((frame.kept / Math.max(1, frame.total)) * 10_000) / 10_000,
        pieces: frame.pieces,
      })),
    },
    null,
    2,
  )}\n`;
}

/** The report, in words. */
export function foregroundReport(data: VideoForegroundFlowData, frames: readonly ForegroundSummary[]): string {
  const lines = ['# Foreground', ''];
  if (!data.video || frames.length === 0) return `${lines.join('\n')}Not worked out yet: open the flow and press Read the frames.\n`;
  const sampling = data.sampling.mode === 'fps' ? `${data.sampling.fps} frame(s) a second` : `${data.sampling.total} frame(s) in all`;
  const share = (kept: number, total: number) => `${((kept / Math.max(1, total)) * 100).toFixed(1)}%`;
  const kept = frames.reduce((sum, frame) => sum + frame.kept, 0);
  const total = frames.reduce((sum, frame) => sum + frame.total, 0);
  const moved = frames.reduce((most, frame) => Math.max(most, Math.hypot(frame.offset.dx, frame.offset.dy)), 0);
  lines.push(
    `A ${data.video.duration.toFixed(2)}s video, ${data.video.width} × ${data.video.height}, read at the background's ${data.background?.width ?? '?'} × ${data.background?.height ?? '?'} and sampled at ${sampling}: ${frames.length} frame(s).`,
    '',
    data.steady ? `- Lined up with the background, up to ${data.maxShift} px a frame: the picture moved up to ${moved.toFixed(1)} px.` : '- Not lined up: the frames are compared where they are.',
    `- In front where the colour is more than ${data.tolerance} from the background's; pieces under ${data.speck} px dropped, holes up to ${data.holes} px filled, grown by ${data.grow} px. Where the background is clear: ${data.unknown === 'keep' ? 'kept' : 'cleared'}.`,
    `- Kept: ${share(kept, total)} of the pixels over all the frames.`,
    '',
    '| Frame | At | Kept | Pieces | Right | Down |',
    '|---|---|---|---|---|---|',
    ...frames.map((frame, index) => `| ${foregroundFrameName(index, frame.time)} | ${frame.time.toFixed(3)}s | ${share(frame.kept, frame.total)} | ${frame.pieces} | ${frame.offset.dx} | ${frame.offset.dy} |`),
    '',
  );
  return lines.join('\n');
}

export function summariseForeground(data: VideoForegroundFlowData): string {
  if (!data.video) return 'No frames read yet.';
  const sampling = data.sampling.mode === 'fps' ? `${data.sampling.fps} a second` : `${data.sampling.total} in all`;
  return `${data.video.width} × ${data.video.height} video, frames ${sampling}, tolerance ${data.tolerance}`;
}
