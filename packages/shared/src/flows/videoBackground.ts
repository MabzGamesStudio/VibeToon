import type { Bitmap } from './cutout';
import { DEFAULT_VIDEO_SAMPLING, type VideoSampling } from './videoMatch';

/**
 * The background of a video clip: what stays put while everything else moves.
 *
 * The clip is sampled into frames — so many a second, or so many in all — and
 * every pixel is looked at across all of them. Where it is the same in every
 * frame, within the **tolerance**, it is background, and takes the middle of
 * the colours it had (the median, channel by channel, so one odd frame does not
 * tint it). Where it is not, something passed in front of it, and it is left
 * clear.
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
  /** How much a pixel may change between frames and still be background, 0..100. */
  tolerance: number;
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
/** Frames are read no wider than this. */
export const MAX_BACKGROUND_WIDTH = 1280;
/** Every frame is held at once to take medians, so this many pixels in all, frames times area. */
export const BACKGROUND_PIXEL_BUDGET = 40_000_000;

export function emptyVideoBackgroundFlowData(): VideoBackgroundFlowData {
  return {
    editor: 'videoBackground',
    sampling: { ...DEFAULT_VIDEO_SAMPLING, mode: 'total', total: 24 },
    tolerance: DEFAULT_BACKGROUND_TOLERANCE,
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

/** Colour distance between two pixels, 0..100 (black against white is 100). */
function distance(a: ArrayLike<number>, i: number, r: number, g: number, b: number, alpha: number): number {
  const dr = a[i]! - r;
  const dg = a[i + 1]! - g;
  const db = a[i + 2]! - b;
  const da = a[i + 3]! - alpha;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 5.1;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
}

export interface BackgroundResult {
  image: Bitmap;
  /** 1 where a pixel stayed within the tolerance in every frame. */
  consistent: Uint8Array;
  stats: { frames: number; consistent: number; marked: number; total: number };
}

/**
 * The pixels every frame agrees on. All frames must be the same size.
 */
export function consistentBackground(frames: readonly Bitmap[], tolerance: number): BackgroundResult {
  const first = frames[0];
  if (!first) {
    return { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, consistent: new Uint8Array(0), stats: { frames: 0, consistent: 0, marked: 0, total: 0 } };
  }
  const { width, height } = first;
  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  const consistent = new Uint8Array(total);
  const limit = Math.max(0, tolerance);
  const channel: number[] = new Array(frames.length);
  let kept = 0;
  for (let p = 0; p < total; p += 1) {
    const at = p * 4;
    const colour = [0, 0, 0, 0];
    for (let c = 0; c < 4; c += 1) {
      for (let f = 0; f < frames.length; f += 1) channel[f] = frames[f]!.data[at + c]!;
      colour[c] = median(channel.slice(0, frames.length));
    }
    let agrees = true;
    for (let f = 0; f < frames.length && agrees; f += 1) {
      if (distance(frames[f]!.data, at, colour[0]!, colour[1]!, colour[2]!, colour[3]!) > limit) agrees = false;
    }
    if (!agrees) continue;
    out[at] = colour[0]!;
    out[at + 1] = colour[1]!;
    out[at + 2] = colour[2]!;
    out[at + 3] = colour[3]!;
    consistent[p] = 1;
    kept += 1;
  }
  return { image: { width, height, data: out }, consistent, stats: { frames: frames.length, consistent: kept, marked: 0, total } };
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
 * Lay the marks over the consistent background: an include takes its frame's
 * pixels, an exclude clears them. `frameAt` finds the frame read nearest a time.
 */
export function applyMarks(result: BackgroundResult, marks: readonly BackgroundMark[], frameAt: (time: number) => Bitmap | undefined): BackgroundResult {
  const { width, height } = result.image;
  const data = new Uint8ClampedArray(result.image.data);
  const touched = new Uint8Array(width * height);
  for (const mark of marks) {
    const frame = frameAt(mark.time);
    if (mark.mode === 'include' && (!frame || frame.width !== width || frame.height !== height)) continue;
    const mask = markMask(mark, width, height);
    for (let p = 0; p < mask.length; p += 1) {
      if (!mask[p]) continue;
      const at = p * 4;
      touched[p] = 1;
      if (mark.mode === 'exclude') {
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
        data[at + 3] = 0;
      } else {
        data[at] = frame!.data[at]!;
        data[at + 1] = frame!.data[at + 1]!;
        data[at + 2] = frame!.data[at + 2]!;
        data[at + 3] = frame!.data[at + 3]!;
      }
    }
  }
  let marked = 0;
  for (const value of touched) marked += value;
  return { ...result, image: { width, height, data }, stats: { ...result.stats, marked } };
}

/** The frame read nearest a time. */
export function nearestFrame<T extends { time: number }>(frames: readonly T[], time: number): T | undefined {
  let best: T | undefined;
  for (const frame of frames) if (!best || Math.abs(frame.time - time) < Math.abs(best.time - time)) best = frame;
  return best;
}

export function backgroundReport(data: VideoBackgroundFlowData, stats: BackgroundResult['stats'] | null): string {
  const lines = ['# Background', ''];
  if (!data.video || !stats) return `${lines.join('\n')}Not worked out yet: open the flow and press Read the frames.\n`;
  const sampling = data.sampling.mode === 'fps' ? `${data.sampling.fps} frame(s) a second` : `${data.sampling.total} frame(s) in all`;
  const share = (count: number) => `${((count / Math.max(1, stats.total)) * 100).toFixed(1)}%`;
  const opaque = stats.consistent;
  lines.push(
    `A ${data.video.duration.toFixed(2)}s video, ${data.video.width} × ${data.video.height}, read at ${data.frameSize?.width ?? '?'} × ${data.frameSize?.height ?? '?'} and sampled at ${sampling}: ${stats.frames} frame(s).`,
    '',
    `- The same in every frame, within ${data.tolerance}: ${opaque.toLocaleString()} pixels (${share(opaque)}).`,
    `- Marked by hand: ${stats.marked.toLocaleString()} pixels (${share(stats.marked)}), in ${data.marks.length} region(s) and stroke(s).`,
    '',
    '`background.png` is clear wherever something moved and nothing was marked.',
    '',
  );
  return lines.join('\n');
}
