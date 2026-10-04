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

/**
 * The times to read, each on one of the clip's frames, first to last.
 *
 * - **Frames in all**: that many, spread evenly from the first frame to the
 *   last, both included — so the whole clip is covered, ends and all.
 * - **Frames a second**: one every 1/fps seconds from the first frame, while
 *   there are frames.
 *
 * Two that land on the same frame are read once: a short clip asked for more
 * frames than it has gives each of its frames once.
 */
export function clipFrameTimes(span: ClipSpan, sampling: VideoSampling): number[] {
  if (!(span.frame > 0) || !(span.last >= span.first)) return [];
  const frames = Math.floor((span.last - span.first) / span.frame + 1e-6) + 1;
  const wanted: number[] = [];
  if (sampling.mode === 'total') {
    const count = Math.max(1, Math.min(MAX_CLIP_FRAMES, Math.round(sampling.total), frames));
    if (count === 1) wanted.push((span.first + span.last) / 2);
    else for (let index = 0; index < count; index += 1) wanted.push(span.first + ((span.last - span.first) * index) / (count - 1));
  } else {
    const step = 1 / Math.max(0.01, sampling.fps);
    for (let time = span.first; time <= span.last + 1e-6 && wanted.length < MAX_CLIP_FRAMES; time += step) wanted.push(time);
  }
  const times: number[] = [];
  for (const time of wanted) {
    const snapped = snapToClipFrame(span, time);
    if (times.length === 0 || snapped - times[times.length - 1]! > span.frame / 2) times.push(snapped);
  }
  return times;
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
  const rate = 1 / middle;
  // The nearest standard rate, if it is close: 30 and 29.97 are both within 3% of each other.
  const nearest = [...STANDARD_FRAME_RATES].sort((a, b) => Math.abs(a - rate) - Math.abs(b - rate))[0]!;
  const standard = Math.abs(nearest - rate) / nearest < 0.03 ? nearest : undefined;
  return standard ?? Math.round(rate * 100) / 100;
}

/** How long a frame lasts, from the same: one over `frameRateOf`. */
export function frameLengthOf(shownAt: readonly number[], fallback = 1 / 30): number {
  return 1 / frameRateOf(shownAt, 1 / fallback);
}
