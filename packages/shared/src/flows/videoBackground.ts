import type { Bitmap } from './cutout';
import { DEFAULT_VIDEO_SAMPLING, type VideoSampling } from './videoMatch';

/**
 * The background of a video clip: what stays put while everything else moves.
 *
 * The clip is sampled into frames — so many a second, or so many in all — and
 * every pixel is looked at across all of them. Its colours are gathered into
 * groups of the same colour, within the **tolerance**, and the biggest group —
 * the colour it has most often — is the background there, as the average of
 * that group (so frames with something else in front are left out of it). If
 * the biggest group is less than the **agreement** share of the frames, no one
 * colour is common enough to be the background, and the pixel is left clear.
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
  /** The share of frames, in percent, the most common colour must have to be kept. */
  agreement: number;
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
export const DEFAULT_BACKGROUND_AGREEMENT = 50;
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

export interface BackgroundResult {
  image: Bitmap;
  /** 1 where a pixel's commonest colour had at least the agreement share of the frames. */
  kept: Uint8Array;
  /** For each pixel, the share of frames its commonest colour had, 0..255 for 0..1. */
  agreement: Uint8Array;
  stats: { frames: number; kept: number; marked: number; total: number };
}

/**
 * Each pixel's most common colour across the frames, where it is common
 * enough. All frames must be the same size.
 *
 * The colours a pixel has are grouped as they come: a colour joins the first
 * group whose average it is within `tolerance` of, or starts a new group. The
 * biggest group wins (the earliest, on a tie), and is counted again against its
 * final average, so the order the frames came in matters little.
 */
export function commonestBackground(frames: readonly Bitmap[], tolerance: number, agreement: number): BackgroundResult {
  const first = frames[0];
  if (!first) {
    return { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, kept: new Uint8Array(0), agreement: new Uint8Array(0), stats: { frames: 0, kept: 0, marked: 0, total: 0 } };
  }
  const { width, height } = first;
  const total = width * height;
  const count = frames.length;
  const out = new Uint8ClampedArray(total * 4);
  const kept = new Uint8Array(total);
  const shares = new Uint8Array(total);
  // Distances are compared squared, on the 0..255 channel scale.
  const limit = Math.max(0, tolerance) * 5.1;
  const limit2 = limit * limit + 1e-9;
  const needed = Math.max(0, Math.min(100, agreement)) / 100;
  // The groups for one pixel: running sums of their colours, and their sizes.
  const sums = new Float64Array(count * 4);
  const sizes = new Uint32Array(count);
  let keptCount = 0;
  for (let p = 0; p < total; p += 1) {
    const at = p * 4;
    let groups = 0;
    for (let f = 0; f < count; f += 1) {
      const d = frames[f]!.data;
      const r = d[at]!;
      const g = d[at + 1]!;
      const b = d[at + 2]!;
      const a = d[at + 3]!;
      let joined = -1;
      for (let k = 0; k < groups; k += 1) {
        const n = sizes[k]!;
        const dr = sums[k * 4]! / n - r;
        const dg = sums[k * 4 + 1]! / n - g;
        const db = sums[k * 4 + 2]! / n - b;
        const da = sums[k * 4 + 3]! / n - a;
        if (dr * dr + dg * dg + db * db + da * da <= limit2) {
          joined = k;
          break;
        }
      }
      if (joined < 0) {
        joined = groups;
        groups += 1;
        sums[joined * 4] = 0;
        sums[joined * 4 + 1] = 0;
        sums[joined * 4 + 2] = 0;
        sums[joined * 4 + 3] = 0;
        sizes[joined] = 0;
      }
      sums[joined * 4] = sums[joined * 4]! + r;
      sums[joined * 4 + 1] = sums[joined * 4 + 1]! + g;
      sums[joined * 4 + 2] = sums[joined * 4 + 2]! + b;
      sums[joined * 4 + 3] = sums[joined * 4 + 3]! + a;
      sizes[joined] = sizes[joined]! + 1;
    }
    let best = 0;
    for (let k = 1; k < groups; k += 1) if (sizes[k]! > sizes[best]!) best = k;
    const n = sizes[best]!;
    const mr = sums[best * 4]! / n;
    const mg = sums[best * 4 + 1]! / n;
    const mb = sums[best * 4 + 2]! / n;
    const ma = sums[best * 4 + 3]! / n;
    // Counted again against the group's final average, and averaged over those.
    let members = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    for (let f = 0; f < count; f += 1) {
      const d = frames[f]!.data;
      const dr = d[at]! - mr;
      const dg = d[at + 1]! - mg;
      const db = d[at + 2]! - mb;
      const da = d[at + 3]! - ma;
      if (dr * dr + dg * dg + db * db + da * da > limit2) continue;
      members += 1;
      sr += d[at]!;
      sg += d[at + 1]!;
      sb += d[at + 2]!;
      sa += d[at + 3]!;
    }
    if (members === 0) {
      members = n;
      sr = mr * n;
      sg = mg * n;
      sb = mb * n;
      sa = ma * n;
    }
    const share = members / count;
    shares[p] = Math.round(share * 255);
    if (share + 1e-9 < needed) continue;
    out[at] = Math.round(sr / members);
    out[at + 1] = Math.round(sg / members);
    out[at + 2] = Math.round(sb / members);
    out[at + 3] = Math.round(sa / members);
    kept[p] = 1;
    keptCount += 1;
  }
  return { image: { width, height, data: out }, kept, agreement: shares, stats: { frames: count, kept: keptCount, marked: 0, total } };
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
 * Lay the marks over the background worked out from the frames: an include takes its frame's
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
  const opaque = stats.kept;
  lines.push(
    `A ${data.video.duration.toFixed(2)}s video, ${data.video.width} × ${data.video.height}, read at ${data.frameSize?.width ?? '?'} × ${data.frameSize?.height ?? '?'} and sampled at ${sampling}: ${stats.frames} frame(s).`,
    '',
    `- One colour in at least ${data.agreement}% of the frames, within ${data.tolerance}: ${opaque.toLocaleString()} pixels (${share(opaque)}). Each takes that colour.`,
    `- Marked by hand: ${stats.marked.toLocaleString()} pixels (${share(stats.marked)}), in ${data.marks.length} region(s) and stroke(s).`,
    '',
    '`background.png` is clear wherever no colour was common enough and nothing was marked.',
    '',
  );
  return lines.join('\n');
}
