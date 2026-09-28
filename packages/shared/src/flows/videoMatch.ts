import { DEFAULT_RIG_MATCH_OPTIONS, wrapAngle, type RigFit, type RigMatchOptions } from './rigMatch';
import type { BoundRig } from './rigBind';
import { inputsForPort } from '../graph/graph';
import type { ArtifactRef } from '../types/artifacts';
import type { FlowNode, Project } from '../types/project';

/**
 * Finding a bound rig in every frame of a video, to make a rig animation.
 *
 * The video is sampled — so many frames a second, or so many frames in all —
 * and the Rig Match is run on each sampled frame with the same settings. A
 * frame found with the body in it starts its search where the last frame left
 * the body, since a character moves little between frames; a frame after one
 * where it was lost searches the whole picture again.
 *
 * Every frame gets a confidence. Where it falls below the threshold the
 * character is taken to be absent (off screen, hidden, a cut to another shot)
 * and the animation is split there: the result is a list of **segments**, each
 * a run of frames the body was found in, each a rig animation of its own.
 *
 * Frames are read and matched in the editor, where a video can be decoded and
 * the match run in a worker. What is stored is each frame's fit — a placement
 * and a pose — and the server writes the animation from those.
 */

export type VideoSamplingMode = 'fps' | 'total';

export interface VideoSampling {
  /** By frames a second of video, or by how many frames in all. */
  mode: VideoSamplingMode;
  fps: number;
  total: number;
}

export const DEFAULT_VIDEO_SAMPLING: VideoSampling = { mode: 'fps', fps: 6, total: 24 };

/** The most frames one video is sampled into, however it is set. */
export const MAX_VIDEO_FRAMES = 600;

/** Below this confidence a frame is taken not to have the character in it. */
export const DEFAULT_VIDEO_THRESHOLD = 0.3;

/**
 * The times to sample, in seconds, for a video this long.
 *
 * By rate: every 1/fps seconds from the start. By total: that many frames
 * spread evenly, the first at the start. Either way never at the very end,
 * which is so often a black frame, and never more than `MAX_VIDEO_FRAMES`.
 */
export function frameTimes(duration: number, sampling: VideoSampling): number[] {
  if (!(duration > 0)) return [];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  if (sampling.mode === 'total') {
    const count = Math.max(1, Math.min(MAX_VIDEO_FRAMES, Math.round(sampling.total)));
    return Array.from({ length: count }, (_, index) => round((index * duration) / count));
  }
  const fps = Math.max(0.01, sampling.fps);
  const count = Math.max(1, Math.min(MAX_VIDEO_FRAMES, Math.ceil(duration * fps - 1e-9)));
  return Array.from({ length: count }, (_, index) => round(index / fps)).filter((time) => time < duration);
}

/** What one sampled frame came to. */
export interface VideoFrame {
  /** Seconds into the video. */
  time: number;
  /** Where the body was found, or null if the match failed outright. */
  fit: RigFit | null;
  /** The whole body's confidence, 0..1. */
  confidence: number;
  /** Each part's confidence, when it had features to judge it by. */
  parts?: Record<string, number | null>;
  /** Searched from the frame before, rather than across the whole picture. */
  followed?: boolean;
}

export interface VideoMatchFlowData {
  editor: 'videoMatch';
  /** The body, taken in from upstream. */
  bound: BoundRig | null;
  boundHash?: string;
  /** The video the frames were read from, and its size. */
  video?: { hash: string; duration: number; width: number; height: number };
  /** The size the frames were matched at: fits are in these pixels. */
  frameSize?: { width: number; height: number };
  options: RigMatchOptions;
  sampling: VideoSampling;
  /** Frames below this confidence split the animation. */
  threshold: number;
  frames: VideoFrame[];
  matchedAt?: string;
  /** What is shown while it plays. */
  showVideo: boolean;
  showBody: boolean;
  showSkeleton: boolean;
  bodyOpacity: number;
}

export function emptyVideoMatchFlowData(): VideoMatchFlowData {
  return {
    editor: 'videoMatch',
    bound: null,
    options: { ...DEFAULT_RIG_MATCH_OPTIONS },
    sampling: { ...DEFAULT_VIDEO_SAMPLING },
    threshold: DEFAULT_VIDEO_THRESHOLD,
    frames: [],
    showVideo: false,
    showBody: true,
    showSkeleton: true,
    bodyOpacity: 1,
  };
}

/**
 * Where the flow stands against what is wired in.
 *
 * `partial` is a match stopped part way; `stale` is a body or a video other
 * than the one the frames were matched with, or sampling settings that would
 * pick other frames.
 */
export function videoMatchState(
  data: VideoMatchFlowData,
  boundHash: string | undefined,
  videoHash: string | undefined,
): 'none' | 'unmatched' | 'partial' | 'stale' | 'ready' {
  if (!data.bound) return 'none';
  if (boundHash && data.boundHash && boundHash !== data.boundHash) return 'stale';
  if (data.frames.length === 0 || !data.video) return 'unmatched';
  if (videoHash && data.video.hash !== videoHash) return 'stale';
  const times = frameTimes(data.video.duration, data.sampling);
  const matched = new Set(data.frames.map((frame) => frame.time));
  if (data.frames.some((frame) => !times.includes(frame.time))) return 'stale';
  return times.every((time) => matched.has(time)) ? 'ready' : 'partial';
}

/* ------------------------------------------------------------------ *
 * Segments
 * ------------------------------------------------------------------ */

export interface AnimationSegment {
  /** Indexes into the frames, in time order. */
  frames: number[];
  start: number;
  end: number;
  /** Its frames' mean confidence. */
  confidence: number;
}

/** Is the body in this frame, as far as the threshold goes? */
export function frameFound(frame: VideoFrame, threshold: number): boolean {
  return frame.fit !== null && frame.confidence >= threshold;
}

/**
 * The runs of frames the body was found in. A frame below the threshold ends
 * one; the next frame found starts another.
 */
export function segmentsOf(frames: readonly VideoFrame[], threshold: number): AnimationSegment[] {
  const order = frames.map((frame, index) => ({ frame, index })).sort((a, b) => a.frame.time - b.frame.time);
  const segments: AnimationSegment[] = [];
  let run: number[] = [];
  const close = () => {
    if (run.length === 0) return;
    const chosen = run.map((index) => frames[index]!);
    segments.push({
      frames: run,
      start: chosen[0]!.time,
      end: chosen[chosen.length - 1]!.time,
      confidence: chosen.reduce((sum, frame) => sum + frame.confidence, 0) / chosen.length,
    });
    run = [];
  };
  for (const { frame, index } of order) {
    if (frameFound(frame, threshold)) run.push(index);
    else close();
  }
  close();
  return segments;
}

/* ------------------------------------------------------------------ *
 * Playing it back
 * ------------------------------------------------------------------ */

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const turn = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;

/**
 * A fit between two others: placement, turns and sizes each the given share
 * of the way from one to the other, turns the short way round.
 */
export function blendFits(a: RigFit, b: RigFit, t: number): RigFit {
  const k = Math.max(0, Math.min(1, t));
  const keys = (x: Record<string, number>, y: Record<string, number>) => new Set([...Object.keys(x), ...Object.keys(y)]);
  const angles: Record<string, number> = {};
  for (const key of keys(a.angles, b.angles)) angles[key] = turn(a.angles[key] ?? 0, b.angles[key] ?? 0, k);
  const sizes: Record<string, number> = {};
  for (const key of keys(a.sizes, b.sizes)) sizes[key] = lerp(a.sizes[key] ?? 1, b.sizes[key] ?? 1, k);
  // Both fits turn the body about their own pivot; the blend uses the first's.
  return {
    pivot: a.pivot,
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    scale: lerp(a.scale, b.scale, k),
    rotation: turn(a.rotation, b.rotation, k),
    angles,
    sizes,
  };
}

/**
 * The body at a moment of the video: blended between the frames either side
 * inside the segment it falls in, or null where no segment is — the
 * character is not there.
 */
export function fitAt(
  frames: readonly VideoFrame[],
  segments: readonly AnimationSegment[],
  time: number,
  /** How long a segment of one frame, or the last frame of one, holds. */
  hold = 0,
): { fit: RigFit; segment: number } | null {
  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s]!;
    if (time < segment.start || time > segment.end + hold) continue;
    const list = segment.frames.map((index) => frames[index]!);
    for (let k = 0; k < list.length - 1; k += 1) {
      const a = list[k]!;
      const b = list[k + 1]!;
      if (time >= a.time && time <= b.time) {
        const span = b.time - a.time;
        return { fit: blendFits(a.fit!, b.fit!, span > 0 ? (time - a.time) / span : 0), segment: s };
      }
    }
    return { fit: list[list.length - 1]!.fit!, segment: s };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * What it writes
 * ------------------------------------------------------------------ */

export interface RigAnimationKey {
  time: number;
  confidence: number;
  placement: { x: number; y: number; scale: number; rotation: number; pivot: { x: number; y: number } };
  /** Each bone's own turn, as a Pose flow stores it. */
  pose: Record<string, number>;
  sizes: Record<string, number>;
}

export interface RigAnimation {
  kind: 'rigAnimation';
  version: 1;
  /** The frame size the placements are in. */
  picture: { width: number; height: number };
  video: { duration: number; width: number; height: number; sampled: number };
  sampling: VideoSampling;
  threshold: number;
  bones: Array<{ id: string; name: string; parent: string | null }>;
  segments: Array<{ start: number; end: number; confidence: number; keys: RigAnimationKey[] }>;
  /** Frames the body was not found in. */
  dropped: number;
}

const r = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

export function rigAnimationOf(data: VideoMatchFlowData): RigAnimation | null {
  if (!data.bound || !data.video || data.frames.length === 0) return null;
  const segments = segmentsOf(data.frames, data.threshold);
  const kept = segments.reduce((sum, segment) => sum + segment.frames.length, 0);
  return {
    kind: 'rigAnimation',
    version: 1,
    picture: data.frameSize ?? { width: data.video.width, height: data.video.height },
    video: { duration: data.video.duration, width: data.video.width, height: data.video.height, sampled: data.frames.length },
    sampling: data.sampling,
    threshold: data.threshold,
    bones: data.bound.rig.bones.map((bone) => ({ id: bone.id, name: bone.name, parent: bone.parent ?? null })),
    segments: segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      confidence: r(segment.confidence),
      keys: segment.frames.map((index) => {
        const frame = data.frames[index]!;
        const fit = frame.fit!;
        return {
          time: frame.time,
          confidence: r(frame.confidence),
          placement: { x: r(fit.x, 2), y: r(fit.y, 2), scale: r(fit.scale, 4), rotation: r(fit.rotation, 2), pivot: { x: r(fit.pivot.x, 2), y: r(fit.pivot.y, 2) } },
          pose: Object.fromEntries(Object.entries(fit.angles).filter(([, angle]) => Math.abs(angle) > 1e-6).map(([id, angle]) => [id, r(angle, 2)])),
          sizes: Object.fromEntries(Object.entries(fit.sizes).filter(([, size]) => Math.abs(size - 1) > 1e-6).map(([id, size]) => [id, r(size, 3)])),
        };
      }),
    })),
    dropped: data.frames.length - kept,
  };
}

/** Read a rig animation back, as written. */
export function readRigAnimation(json: unknown): RigAnimation | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Partial<RigAnimation>;
  if (record.kind !== 'rigAnimation' || !Array.isArray(record.segments) || !Array.isArray(record.bones)) return null;
  return record as RigAnimation;
}

export function summariseVideoMatch(data: VideoMatchFlowData): string {
  if (!data.bound) return 'Nothing taken in yet.';
  if (data.frames.length === 0) return `${data.bound.rig.bones.length} bone(s) · no frames matched yet`;
  const segments = segmentsOf(data.frames, data.threshold);
  const found = segments.reduce((sum, segment) => sum + segment.frames.length, 0);
  const seconds = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  return `${data.frames.length} frame(s) matched · body found in ${found} · ${segments.length} segment(s), ${seconds.toFixed(1)}s of animation`;
}

/**
 * The video a flow works on: the one wired in, or failing that the one
 * uploaded onto its own Video port.
 */
export function videoSourceOf(project: Project, node: FlowNode): { artifact: ArtifactRef; wired: boolean } | undefined {
  const wired = inputsForPort(project, node.id, 'video').find((input) => input.artifact)?.artifact;
  if (wired) return { artifact: wired, wired: true };
  const own = node.outputs.find((ref) => ref.port === 'source');
  return own ? { artifact: own, wired: false } : undefined;
}

/** The report, in words. */
export function videoMatchReport(data: VideoMatchFlowData): string {
  const lines: string[] = ['# Rig animation', ''];
  if (!data.bound || !data.video) return `${lines.join('\n')}Not matched yet.\n`;
  const segments = segmentsOf(data.frames, data.threshold);
  const sampling = data.sampling.mode === 'fps' ? `${data.sampling.fps} frame(s) a second` : `${data.sampling.total} frame(s) in all`;
  lines.push(
    `A ${data.video.duration.toFixed(2)}s video, ${data.video.width} × ${data.video.height}, sampled at ${sampling}: ${data.frames.length} frame(s) matched.`,
    `Frames below ${Math.round(data.threshold * 100)}% confidence are taken not to show the character, and split the animation.`,
    '',
    '| Segment | From | To | Frames | Confidence |',
    '| --- | --- | --- | --- | --- |',
    ...segments.map(
      (segment, index) =>
        `| ${index + 1} | ${segment.start.toFixed(2)}s | ${segment.end.toFixed(2)}s | ${segment.frames.length} | ${Math.round(segment.confidence * 100)}% |`,
    ),
    '',
  );
  const dropped = data.frames.filter((frame) => !frameFound(frame, data.threshold));
  if (dropped.length > 0) {
    lines.push(`Dropped ${dropped.length} frame(s): ${dropped.map((frame) => `${frame.time.toFixed(2)}s (${Math.round(frame.confidence * 100)}%)`).join(', ')}.`, '');
  } else lines.push('No frame was dropped.', '');
  return lines.join('\n');
}
