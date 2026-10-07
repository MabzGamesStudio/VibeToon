import type { VideoSampling } from './videoMatch';

/**
 * Which frames of a clip to read, from what the clip itself says.
 *
 * A clip's header is not to be trusted for this. A video recorded in a browser
 * often has no length in it at all; one cut from a longer video may start its
 * first frame at 0.04 s or at 12.5 s; and the length a header gives is the end
 * of the last frame, not the time of it, so reading "at the end" reads past
 * it. So the clip is probed first (see the editor's `openClip`): the time the
 * first frame is shown at, the time the last one is, and how long a frame
 * lasts, as the browser actually shows them. The times read are worked out
 * inside that, on the clip's own frames.
 */
export interface ClipSpan {
  /** When the first frame is shown, in the clip's own seconds. */
  first: number;
  /** When the last frame is shown. */
  last: number;
  /** How long one frame lasts. */
  frame: number;
}

/** The most frames a clip is read at. */
export const MAX_CLIP_FRAMES = 2000;

/** How long the clip plays for, from its first frame to the end of its last. */
export function clipLength(span: ClipSpan): number {
  return Math.max(0, span.last - span.first) + span.frame;
}

/** The clip's frame nearest a time, kept inside it. */
export function snapToClipFrame(span: ClipSpan, time: number): number {
  const frame = Math.max(1e-4, span.frame);
  const index = Math.round((Math.min(span.last, Math.max(span.first, time)) - span.first) / frame);
  return Math.min(span.last, Math.round((span.first + index * frame) * 1e6) / 1e6);
}

/** Where a clip's frames are, as the frames of a grid: the first, one every `frame`, to the last. */
export function gridFrameTimes(span: ClipSpan): number[] {
  if (!(span.frame > 0) || !(span.last >= span.first)) return [];
  const frames = Math.min(200_000, Math.floor((span.last - span.first) / span.frame + 1e-6) + 1);
  return Array.from({ length: frames }, (_, index) => Math.round((span.first + index * span.frame) * 1e6) / 1e6);
}

/**
 * The frames to read, out of the frames a clip has — each given by the time
 * it is shown, first to last:
 *
 * - **Frames in all**: that many, spread evenly through them by count, the
 *   first and the last both included.
 * - **Frames a second**: one every 1/fps seconds from the first frame, each
 *   the frame nearest that time.
 *
 * Only frames the clip has are picked, and each at most once: a clip asked for
 * more frames than it has gives each of its frames once, and a clip whose
 * frames are unevenly spaced (one a browser recorded as it played) gives its
 * own frames, never one frame twice for two times that fall in a long one.
 */
export function pickFrameTimes(frameTimes: readonly number[], sampling: VideoSampling): number[] {
  const count = frameTimes.length;
  if (count === 0) return [];
  const picked: number[] = [];
  if (sampling.mode === 'total') {
    const wanted = Math.max(1, Math.min(MAX_CLIP_FRAMES, Math.round(sampling.total), count));
    if (wanted === 1) return [frameTimes[Math.round((count - 1) / 2)]!];
    // At least a frame apart, so no two land on the same frame.
    for (let index = 0; index < wanted; index += 1) picked.push(frameTimes[Math.round((index * (count - 1)) / (wanted - 1))]!);
    return picked;
  }
  const step = 1 / Math.max(0.01, sampling.fps);
  const first = frameTimes[0]!;
  const last = frameTimes[count - 1]!;
  let at = 0;
  for (let index = 0; picked.length < MAX_CLIP_FRAMES; index += 1) {
    const time = first + index * step;
    if (time > last + 1e-6) break;
    // The nearest frame: the one at or before the time, or the next if that is nearer (or as near).
    while (at + 1 < count && frameTimes[at + 1]! <= time + 1e-9) at += 1;
    const after = at + 1 < count ? at + 1 : at;
    const nearest = frameTimes[after]! - time <= time - frameTimes[at]! + 1e-9 ? after : at;
    const chosen = frameTimes[nearest]!;
    if (picked.length === 0 || chosen > picked[picked.length - 1]!) picked.push(chosen);
  }
  return picked;
}

/**
 * The times to read, each on one of the clip's frames, first to last, for a
 * clip known only by its span: its frames taken to be on an even grid (see
 * `gridFrameTimes` and `pickFrameTimes`).
 */
export function clipFrameTimes(span: ClipSpan, sampling: VideoSampling): number[] {
  return pickFrameTimes(gridFrameTimes(span), sampling);
}

/**
 * What a video is, frame by frame, as read from it: when its first frame is
 * shown and its last, when the last one ends, how many frames it has and how
 * many a second. `exact` when read from the file's own packets; otherwise
 * measured by playing it, and the count worked out from the rate.
 */
export interface VideoFacts {
  first: number;
  /** When the last frame ends: the video's length. */
  duration: number;
  last: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  exact: boolean;
}

/** The span of a video's frames, from its facts. */
export function spanOfFacts(facts: VideoFacts): ClipSpan {
  return { first: facts.first, last: facts.last, frame: 1 / Math.max(1e-3, facts.fps) };
}

/** Frame rates video is made at; a measured rate within 3% of one is taken to be it. */
export const STANDARD_FRAME_RATES = [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120] as const;

/**
 * Frames a second, from the times of frames seen shown one after another.
 *
 * The middle gap decides it, not the smallest or the mean: a dropped frame
 * makes one gap twice as long, and a stutter one short, and either would throw
 * those off — one stray short gap once read a 30 fps clip as 71 fps. A rate
 * close to a standard one is taken to be it.
 */
export function frameRateOf(shownAt: readonly number[], fallback = 30): number {
  const gaps: number[] = [];
  for (let index = 1; index < shownAt.length; index += 1) {
    const gap = shownAt[index]! - shownAt[index - 1]!;
    if (gap > 1e-3 && gap < 1) gaps.push(gap);
  }
  if (gaps.length === 0) return fallback;
  gaps.sort((a, b) => a - b);
  const middle = gaps.length % 2 ? gaps[(gaps.length - 1) / 2]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2;
  return snapFrameRate(1 / middle);
}

/** A measured frame rate, as the standard rate it is near (within 3%), else to two places. */
export function snapFrameRate(rate: number): number {
  if (!(rate > 0) || !Number.isFinite(rate)) return 30;
  // The nearest standard rate, if it is close: 30 and 29.97 are both within 3% of each other.
  const nearest = [...STANDARD_FRAME_RATES].sort((a, b) => Math.abs(a - rate) - Math.abs(b - rate))[0]!;
  return Math.abs(nearest - rate) / nearest < 0.03 ? nearest : Math.round(rate * 100) / 100;
}

/** How long a frame lasts, from the same: one over `frameRateOf`. */
export function frameLengthOf(shownAt: readonly number[], fallback = 1 / 30): number {
  return 1 / frameRateOf(shownAt, 1 / fallback);
}
