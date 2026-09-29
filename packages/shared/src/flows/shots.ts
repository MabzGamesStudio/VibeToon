import type { Bitmap } from './cutout';
import { DEFAULT_VIDEO_SAMPLING, frameTimes, type VideoSampling } from './videoMatch';

/**
 * Splitting a video into its shots.
 *
 * Every frame is boiled down to an **embedding**: a small picture of it (8 × 8,
 * colour) and a histogram of its colours. Two frames of one shot have much the
 * same of both; a cut changes both at once. Their **difference** is a number
 * from 0 (the same) to 1 (nothing alike).
 *
 * The video is read at a coarse step — so many frames a second, or so many in
 * all. Wherever two neighbouring samples differ by more than the threshold,
 * there is a cut somewhere between them, and a **binary search** finds the
 * frame: halve the gap, see which side the middle frame looks like, keep the
 * half the change is in, until the two frames either side of it are next to
 * each other. A cut anywhere in a two-second gap at 24 frames a second is found
 * in six looks.
 *
 * A shot shorter than the **minimum shot length** is joined to the neighbour
 * it is least unlike: a flash frame or a dissolve's middle is not a shot.
 *
 * What comes out is the shots' time segments. After that they are yours: join a
 * shot to the next, or split one at a frame.
 */

/** A frame, boiled down. */
export interface FrameEmbedding {
  /** 8 × 8 × RGB, each 0..1. */
  thumb: Float32Array;
  /** 64 colour bins (4 × 4 × 4), summing to 1. */
  histogram: Float32Array;
}

export const THUMB_SIDE = 8;
const BINS = 4;

/** Boil a frame down to its embedding. Clear pixels count for nothing. */
export function embedFrame(frame: Bitmap): FrameEmbedding {
  const { width, height, data } = frame;
  const thumb = new Float32Array(THUMB_SIDE * THUMB_SIDE * 3);
  const weights = new Float32Array(THUMB_SIDE * THUMB_SIDE);
  const histogram = new Float32Array(BINS * BINS * BINS);
  let counted = 0;
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(THUMB_SIDE - 1, Math.floor((y * THUMB_SIDE) / height));
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const alpha = data[at + 3]! / 255;
      if (alpha === 0) continue;
      const r = data[at]!;
      const g = data[at + 1]!;
      const b = data[at + 2]!;
      const cell = cellY * THUMB_SIDE + Math.min(THUMB_SIDE - 1, Math.floor((x * THUMB_SIDE) / width));
      thumb[cell * 3] = thumb[cell * 3]! + (r / 255) * alpha;
      thumb[cell * 3 + 1] = thumb[cell * 3 + 1]! + (g / 255) * alpha;
      thumb[cell * 3 + 2] = thumb[cell * 3 + 2]! + (b / 255) * alpha;
      weights[cell] = weights[cell]! + alpha;
      const bin = ((r * BINS) >> 8) * BINS * BINS + ((g * BINS) >> 8) * BINS + ((b * BINS) >> 8);
      histogram[bin] = histogram[bin]! + alpha;
      counted += alpha;
    }
  }
  for (let cell = 0; cell < weights.length; cell += 1) {
    const weight = weights[cell]!;
    if (weight > 0) for (let c = 0; c < 3; c += 1) thumb[cell * 3 + c] = thumb[cell * 3 + c]! / weight;
  }
  if (counted > 0) for (let bin = 0; bin < histogram.length; bin += 1) histogram[bin] = histogram[bin]! / counted;
  return { thumb, histogram };
}

/**
 * How unlike two frames are, 0..1: half from where the colours are (the small
 * pictures, mean difference) and half from which colours there are (the
 * histograms, half their L1 distance). A camera move shifts the first and not
 * the second; a cut changes both.
 */
export function frameDifference(a: FrameEmbedding, b: FrameEmbedding): number {
  let spatial = 0;
  for (let i = 0; i < a.thumb.length; i += 1) spatial += Math.abs(a.thumb[i]! - b.thumb[i]!);
  spatial /= a.thumb.length;
  let colour = 0;
  for (let i = 0; i < a.histogram.length; i += 1) colour += Math.abs(a.histogram[i]! - b.histogram[i]!);
  colour /= 2;
  return Math.min(1, spatial * 0.5 + colour * 0.5);
}

export interface ShotOptions {
  /** How unlike two samples must be for a cut between them, 0..1. */
  threshold: number;
  /** The shortest a shot can be, in seconds. */
  minShot: number;
  /** The video's frame rate: what the search narrows the cut down to. */
  fps: number;
}

export const DEFAULT_SHOT_OPTIONS: ShotOptions = { threshold: 0.3, minShot: 0.5, fps: 24 };

export interface DetectedCut {
  /** The first frame of the new shot, and its time. */
  frame: number;
  time: number;
  /** How unlike the frames either side of it are. */
  difference: number;
}

export interface ShotDetection {
  cuts: DetectedCut[];
  /** Every sample read, and how unlike the one before it was. */
  samples: Array<{ time: number; difference: number }>;
  /** How many frames were looked at in all, samples and searches. */
  looks: number;
}

/**
 * Find the cuts in a video, given a way to look at the frame at any time.
 *
 * `look` is asked for frames at the sampling times first, then at the frames
 * a binary search between two samples wants.
 */
export async function detectShots(
  duration: number,
  sampling: VideoSampling,
  input: Partial<ShotOptions>,
  look: (time: number) => Promise<FrameEmbedding>,
  progress?: (done: number, total: number) => void,
): Promise<ShotDetection> {
  const options = normaliseShotOptions(input);
  const times = frameTimes(duration, sampling);
  const lastFrame = Math.max(0, Math.ceil(duration * options.fps) - 1);
  const frameOf = (time: number) => Math.max(0, Math.min(lastFrame, Math.round(time * options.fps)));
  const timeOf = (frame: number) => Math.round((frame / options.fps) * 1000) / 1000;
  let looks = 0;
  const seen = new Map<number, FrameEmbedding>();
  const lookAt = async (frame: number) => {
    const known = seen.get(frame);
    if (known) return known;
    looks += 1;
    const embedding = await look(timeOf(frame));
    seen.set(frame, embedding);
    return embedding;
  };

  const frames = [...new Set(times.map(frameOf))].sort((a, b) => a - b);
  const embeddings: FrameEmbedding[] = [];
  const samples: ShotDetection['samples'] = [];
  for (let i = 0; i < frames.length; i += 1) {
    embeddings.push(await lookAt(frames[i]!));
    samples.push({ time: timeOf(frames[i]!), difference: i === 0 ? 0 : frameDifference(embeddings[i - 1]!, embeddings[i]!) });
    progress?.(i + 1, frames.length);
  }

  const cuts: DetectedCut[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    if (samples[i]!.difference < options.threshold) continue;
    const before = embeddings[i - 1]!;
    const after = embeddings[i]!;
    let lo = frames[i - 1]!;
    let hi = frames[i]!;
    // lo looks like the shot before, hi like the one after; the cut is the
    // first frame that looks like hi.
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const middle = await lookAt(mid);
      if (frameDifference(middle, before) <= frameDifference(middle, after)) lo = mid;
      else hi = mid;
    }
    const difference = frameDifference(await lookAt(lo), await lookAt(hi));
    cuts.push({ frame: hi, time: timeOf(hi), difference: Math.max(difference, samples[i]!.difference) });
  }

  return { cuts: dropShortShots(cuts, duration, options.minShot), samples, looks };
}

/**
 * Join every shot shorter than `minShot` to a neighbour: the cut taken away is
 * the weaker of its two, so it goes with the shot it is least unlike. The
 * shortest shots go first.
 */
export function dropShortShots(cuts: DetectedCut[], duration: number, minShot: number): DetectedCut[] {
  const kept = [...cuts].sort((a, b) => a.time - b.time);
  for (;;) {
    const bounds = [0, ...kept.map((cut) => cut.time), duration];
    let shortest = -1;
    let length = Infinity;
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const span = bounds[i + 1]! - bounds[i]!;
      if (span < minShot - 1e-9 && span < length) {
        shortest = i;
        length = span;
      }
    }
    if (shortest < 0 || kept.length === 0) return kept;
    // The shot from bounds[shortest] to bounds[shortest+1] is bounded by cut
    // shortest-1 (its start) and cut shortest (its end).
    const startCut = shortest - 1 >= 0 ? kept[shortest - 1] : undefined;
    const endCut = shortest < kept.length ? kept[shortest] : undefined;
    const drop = !startCut ? shortest : !endCut ? shortest - 1 : startCut.difference <= endCut.difference ? shortest - 1 : shortest;
    kept.splice(drop, 1);
  }
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

export interface Shot {
  start: number;
  end: number;
}

export interface ShotsFlowData {
  editor: 'shots';
  sampling: VideoSampling;
  options: ShotOptions;
  /** The video the shots were found in. */
  video?: { hash?: string; duration: number; width: number; height: number };
  /** Where each shot after the first starts, in seconds, in order. */
  cuts: number[];
  /** The cuts as found, before any were joined or added by hand, and how strong each was. */
  detected: DetectedCut[];
  /** Changes made by hand since the shots were found. */
  edits: number;
  /** The shot selected in the editor. */
  selected: number | null;
  /**
   * Write each shot as a video of its own, on the Shot clips port: a folder
   * that goes into a flow taking one video as a batch, a shot at a time.
   */
  clips: boolean;
  /** The shots the clips on the port were recorded from, to tell when they are behind. */
  recorded?: string;
}

export function emptyShotsFlowData(): ShotsFlowData {
  return {
    editor: 'shots',
    sampling: { ...DEFAULT_VIDEO_SAMPLING, fps: 2 },
    options: { ...DEFAULT_SHOT_OPTIONS },
    cuts: [],
    detected: [],
    edits: 0,
    selected: null,
    clips: false,
  };
}

/** A shot's clip file: `shot-01.webm`, `shot-02.webm`, … */
export function shotClipName(index: number, extension = 'webm'): string {
  return `shot-${String(index + 1).padStart(2, '0')}.${extension}`;
}

/** A key for the shots as cut: when it changes, the clips recorded from them are behind. */
export function shotsKey(data: ShotsFlowData): string {
  return JSON.stringify({ video: data.video?.hash, cuts: data.cuts });
}

export function normaliseShotOptions(input: Partial<ShotOptions>): ShotOptions {
  const merged = { ...DEFAULT_SHOT_OPTIONS, ...input };
  return {
    threshold: Math.max(0.01, Math.min(1, merged.threshold)),
    minShot: Math.max(0, merged.minShot),
    fps: Math.max(1, Math.min(240, merged.fps)),
  };
}

/** The shots, from the cuts and the video's length. */
export function shotsOf(cuts: readonly number[], duration: number): Shot[] {
  const bounds = [0, ...[...cuts].filter((cut) => cut > 0 && cut < duration).sort((a, b) => a - b), duration];
  const shots: Shot[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    if (bounds[i + 1]! > bounds[i]!) shots.push({ start: bounds[i]!, end: bounds[i + 1]! });
  }
  return shots;
}

/** Join a shot to the one after it. */
export function joinShots(data: ShotsFlowData, index: number): ShotsFlowData {
  const cuts = [...data.cuts].sort((a, b) => a - b);
  if (index < 0 || index >= cuts.length) return data;
  cuts.splice(index, 1);
  return { ...data, cuts, edits: data.edits + 1, selected: Math.min(index, cuts.length) };
}

/** Split a shot at a time, snapped to the nearest frame. A split on a shot's edge does nothing. */
export function splitShotAt(data: ShotsFlowData, time: number): ShotsFlowData {
  const duration = data.video?.duration ?? 0;
  const frame = Math.round(time * data.options.fps);
  const at = Math.round((frame / data.options.fps) * 1000) / 1000;
  if (!(at > 0) || at >= duration) return data;
  if (data.cuts.some((cut) => Math.abs(cut - at) < 0.5 / data.options.fps)) return data;
  const cuts = [...data.cuts, at].sort((a, b) => a - b);
  return { ...data, cuts, edits: data.edits + 1, selected: cuts.indexOf(at) + 1 };
}

/** Take a detection's cuts as the shots, forgetting what was done by hand. */
export function adoptDetection(
  data: ShotsFlowData,
  detection: ShotDetection,
  video: NonNullable<ShotsFlowData['video']>,
): ShotsFlowData {
  return { ...data, video, cuts: detection.cuts.map((cut) => cut.time), detected: detection.cuts, edits: 0, selected: null };
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

export function formatClock(seconds: number): string {
  return clock(seconds);
}

/** `shots.json`: the shots' time segments, and their frames. */
export function shotsFile(data: ShotsFlowData): string {
  const duration = data.video?.duration ?? 0;
  const fps = data.options.fps;
  const shots = shotsOf(data.cuts, duration).map((shot, index) => ({
    index: index + 1,
    start: shot.start,
    end: shot.end,
    duration: Math.round((shot.end - shot.start) * 1000) / 1000,
    startFrame: Math.round(shot.start * fps),
    endFrame: Math.max(Math.round(shot.start * fps), Math.round(shot.end * fps) - 1),
  }));
  return `${JSON.stringify(
    {
      kind: 'shots',
      version: 1,
      video: data.video ? { duration, width: data.video.width, height: data.video.height, fps } : null,
      shots,
    },
    null,
    2,
  )}\n`;
}

export function shotsReport(data: ShotsFlowData): string {
  const duration = data.video?.duration ?? 0;
  if (!data.video) return '# Shots\n\nNot split yet: open the flow and press Find the shots.\n';
  const shots = shotsOf(data.cuts, duration);
  const strength = new Map(data.detected.map((cut) => [cut.time, cut.difference]));
  const lines = [
    '# Shots',
    '',
    `A ${duration.toFixed(2)}s video, ${data.video.width} × ${data.video.height}, in **${shots.length}** shot(s).`,
    `Cuts are where frames differ by ${Math.round(data.options.threshold * 100)}% or more, found to the frame at ${data.options.fps} fps; no shot is shorter than ${data.options.minShot}s.`,
    data.edits > 0 ? `${data.edits} change(s) made by hand since.` : '',
    '',
    '| Shot | From | To | Length | Cut into it |',
    '| --- | --- | --- | --- | --- |',
    ...shots.map((shot, index) => {
      const into = index === 0 ? '—' : strength.has(shot.start) ? `${Math.round(strength.get(shot.start)! * 100)}%` : 'by hand';
      return `| ${index + 1} | ${clock(shot.start)} | ${clock(shot.end)} | ${(shot.end - shot.start).toFixed(2)}s | ${into} |`;
    }),
    '',
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}

export function summariseShots(data: ShotsFlowData): string {
  if (!data.video) return 'Not split yet.';
  const shots = shotsOf(data.cuts, data.video.duration);
  return `${shots.length} shot(s) in ${data.video.duration.toFixed(2)}s${data.edits > 0 ? ` · ${data.edits} change(s) by hand` : ''}`;
}
