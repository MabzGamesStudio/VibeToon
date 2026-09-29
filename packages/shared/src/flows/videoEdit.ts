import { clampRect, type CropRect } from './crop';

/**
 * Cutting a video: crop it, split it into segments, and delete the segments
 * that are not wanted.
 *
 * The video is a row of **segments** end to end, from its start to its end.
 * Splitting cuts the segment under a time in two, at the frame nearest it;
 * each segment is kept or deleted; two neighbours can be joined back into one.
 * The **crop** is a box in the video's own pixels, the same for every frame.
 *
 * What comes out is either **one video**, the kept segments one after another,
 * or **a clip for each** kept segment. Either way it is the crop of the video.
 * Nothing here decodes or encodes video: the editor plays the video through
 * the crop and records it, and the edit — which segments, what crop — is
 * written beside it as `edit.json`, so it can be redone elsewhere.
 */

export interface VideoSegment {
  start: number;
  end: number;
  deleted: boolean;
}

export type VideoEditOutput = 'joined' | 'clips';

export interface VideoEditFlowData {
  editor: 'videoEdit';
  /** The video the edit was made on. */
  video?: { hash?: string; duration: number; width: number; height: number };
  /** In the video's pixels; null is the whole frame. */
  crop: CropRect | null;
  /** End to end, in order; empty is the whole video as one segment. */
  segments: VideoSegment[];
  output: VideoEditOutput;
  /** Frames a second the result is recorded at, and what a split snaps to. */
  fps: number;
  selected: number | null;
  /** The edit the files on the ports were rendered from, to tell when they are behind. */
  rendered?: string;
  /** The shot cuts found in the video, by time, and which video they were found in. */
  shots?: { hash?: string; cuts: number[] };
}

export const DEFAULT_EDIT_FPS = 30;

export function emptyVideoEditFlowData(): VideoEditFlowData {
  return { editor: 'videoEdit', crop: null, segments: [], output: 'joined', fps: DEFAULT_EDIT_FPS, selected: null };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The segments, tidied to cover the whole video, for a video this long. */
export function editSegments(data: Pick<VideoEditFlowData, 'segments'>, duration: number): VideoSegment[] {
  if (!(duration > 0)) return [];
  const sorted = [...data.segments].filter((segment) => segment.end > segment.start && segment.start < duration).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [{ start: 0, end: round(duration), deleted: false }];
  // End to end: each starts where the last ended, the first at 0, the last at the end.
  const out: VideoSegment[] = [];
  sorted.forEach((segment, index) => {
    const start = index === 0 ? 0 : out[index - 1]!.end;
    const end = index === sorted.length - 1 ? round(duration) : round(Math.max(start, Math.min(duration, sorted[index + 1]!.start)));
    out.push({ start, end, deleted: segment.deleted });
  });
  return out.filter((segment) => segment.end > segment.start);
}

/** The time a frame starts at, for the frame nearest `time`. */
export function snapToFrame(time: number, fps: number): number {
  const rate = Math.max(1, fps);
  return round(Math.round(time * rate) / rate);
}

/**
 * The start of the frame `by` frames on from the one `time` is in, kept
 * inside the video: stepping frame by frame.
 */
export function stepFrame(time: number, fps: number, by: number, duration: number): number {
  const rate = Math.max(1, fps);
  const last = Math.max(0, Math.ceil(duration * rate - 1e-6) - 1);
  const frame = Math.max(0, Math.min(last, Math.floor(time * rate + 1e-6) + by));
  return round(frame / rate);
}

/** Split the segment under `time` at the frame nearest it. A split on an edge does nothing. */
export function splitSegmentAt(data: VideoEditFlowData, time: number): VideoEditFlowData {
  const duration = data.video?.duration ?? 0;
  const segments = editSegments(data, duration);
  const at = snapToFrame(time, data.fps);
  const index = segments.findIndex((segment) => at > segment.start && at < segment.end);
  if (index < 0) return data;
  const segment = segments[index]!;
  const minimum = 0.5 / Math.max(1, data.fps);
  if (at - segment.start < minimum || segment.end - at < minimum) return data;
  const next = [...segments.slice(0, index), { ...segment, end: at }, { ...segment, start: at }, ...segments.slice(index + 1)];
  return { ...data, segments: next, selected: index + 1 };
}

/** Delete a segment, or keep it again. */
export function toggleSegment(data: VideoEditFlowData, index: number): VideoEditFlowData {
  const segments = editSegments(data, data.video?.duration ?? 0);
  if (!segments[index]) return data;
  return { ...data, segments: segments.map((segment, at) => (at === index ? { ...segment, deleted: !segment.deleted } : segment)) };
}

/** Join a segment to the one after it. The joined segment is kept if either was. */
export function joinSegments(data: VideoEditFlowData, index: number): VideoEditFlowData {
  const segments = editSegments(data, data.video?.duration ?? 0);
  const first = segments[index];
  const second = segments[index + 1];
  if (!first || !second) return data;
  const joined = { start: first.start, end: second.end, deleted: first.deleted && second.deleted };
  return { ...data, segments: [...segments.slice(0, index), joined, ...segments.slice(index + 2)], selected: index };
}

export function keptSegments(data: VideoEditFlowData): VideoSegment[] {
  return editSegments(data, data.video?.duration ?? 0).filter((segment) => !segment.deleted);
}

export function editedDuration(data: VideoEditFlowData): number {
  return round(keptSegments(data).reduce((sum, segment) => sum + segment.end - segment.start, 0));
}

/**
 * Where playing the edit is in the source, `time` seconds in: which kept
 * segment, and the time in the video. Past the end, null.
 */
export function sourceTimeAt(data: VideoEditFlowData, time: number): { segment: number; time: number } | null {
  let left = time;
  const kept = keptSegments(data);
  for (let index = 0; index < kept.length; index += 1) {
    const segment = kept[index]!;
    const length = segment.end - segment.start;
    if (left < length) return { segment: index, time: round(segment.start + Math.max(0, left)) };
    left -= length;
  }
  return null;
}

/** Where to go on from `time` when playing the edit: the same time, or the start of the next kept segment, or null at the end. */
export function playOnFrom(data: VideoEditFlowData, time: number): number | null {
  for (const segment of keptSegments(data)) {
    if (time < segment.end - 1e-3) return Math.max(time, segment.start);
  }
  return null;
}

/**
 * The crop, in whole pixels, inside the video, with even sides: most video
 * encoders want a width and height divisible by two.
 */
export function videoCropRect(data: VideoEditFlowData): CropRect | null {
  if (!data.video) return null;
  const size = { width: data.video.width, height: data.video.height };
  const box = clampRect(data.crop ?? { x: 0, y: 0, width: size.width, height: size.height }, size);
  const even = (value: number) => Math.max(2, value - (value % 2));
  return { x: box.x, y: box.y, width: Math.min(even(box.width), size.width), height: Math.min(even(box.height), size.height) };
}

/** A key for an edit: when it changes, what was rendered is out of date. */
export function editKey(data: VideoEditFlowData): string {
  return JSON.stringify({ video: data.video?.hash, crop: videoCropRect(data), keep: keptSegments(data), output: data.output, fps: data.fps });
}

export function clipName(index: number, extension = 'webm'): string {
  return `clip-${String(index + 1).padStart(2, '0')}.${extension}`;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

/** `edit.json`: the edit, so it can be redone from the source. */
export function editFile(data: VideoEditFlowData): string {
  const kept = keptSegments(data);
  return `${JSON.stringify(
    {
      kind: 'videoEdit',
      version: 1,
      source: data.video ? { duration: data.video.duration, width: data.video.width, height: data.video.height } : null,
      crop: videoCropRect(data),
      output: data.output,
      fps: data.fps,
      keep: kept.map((segment, index) => ({ start: segment.start, end: segment.end, ...(data.output === 'clips' ? { clip: clipName(index) } : {}) })),
      deleted: editSegments(data, data.video?.duration ?? 0)
        .filter((segment) => segment.deleted)
        .map((segment) => ({ start: segment.start, end: segment.end })),
      duration: editedDuration(data),
    },
    null,
    2,
  )}\n`;
}

export function summariseEdit(data: VideoEditFlowData): string {
  if (!data.video) return 'No video yet.';
  const segments = editSegments(data, data.video.duration);
  const kept = segments.filter((segment) => !segment.deleted).length;
  const crop = videoCropRect(data);
  const cropped = crop && (crop.width !== data.video.width || crop.height !== data.video.height) ? ` · cropped to ${crop.width} × ${crop.height}` : '';
  return `${clock(data.video.duration)} → ${clock(editedDuration(data))} · ${kept} of ${segments.length} segment(s) kept${cropped} · ${data.output === 'joined' ? 'one video' : `${kept} clip(s)`}`;
}

/** Split at every shot cut, as found in the video. Cuts on an edge already change nothing. */
export function splitAtCuts(data: VideoEditFlowData, cuts: readonly number[]): VideoEditFlowData {
  let next = data;
  for (const cut of cuts) next = splitSegmentAt(next, cut);
  return next === data ? data : { ...next, selected: null };
}

/** The shot cuts found in this edit's video, if they were found in the video it has now. */
export function editShotCuts(data: VideoEditFlowData): number[] {
  if (!data.shots || !data.video || data.shots.hash !== data.video.hash) return [];
  return data.shots.cuts.filter((cut) => cut > 0 && cut < data.video!.duration);
}

/* ---------------- the timeline's view ---------------- */

/** The stretch of the video the timeline shows, in seconds. */
export interface EditView {
  from: number;
  to: number;
}

/** The shortest stretch the timeline zooms in to: a few frames. */
export function minEditSpan(duration: number, fps: number): number {
  return Math.min(Math.max(duration, 1e-3), 12 / Math.max(1, fps));
}

/** A view kept inside the video and no shorter than the least span, its length kept where it can be. */
export function clampEditView(view: EditView, duration: number, fps: number): EditView {
  if (!(duration > 0)) return { from: 0, to: 0 };
  const span = Math.min(duration, Math.max(minEditSpan(duration, fps), view.to - view.from));
  const from = Math.max(0, Math.min(duration - span, view.from));
  return { from, to: from + span };
}

/**
 * Zoom by `factor` (more than 1 zooms in) about a time, which stays where it
 * is on the timeline.
 */
export function zoomEditView(view: EditView, duration: number, fps: number, about: number, factor: number): EditView {
  const span = view.to - view.from;
  if (!(span > 0) || !(factor > 0)) return clampEditView(view, duration, fps);
  const next = Math.min(duration, Math.max(minEditSpan(duration, fps), span / factor));
  const at = Math.max(view.from, Math.min(view.to, about));
  const from = at - ((at - view.from) / span) * next;
  return clampEditView({ from, to: from + next }, duration, fps);
}

/** Slide the view along by `by` seconds, keeping it inside the video. */
export function panEditView(view: EditView, duration: number, fps: number, by: number): EditView {
  return clampEditView({ from: view.from + by, to: view.to + by }, duration, fps);
}

/** A view that has the time in it: the same one if it does, else moved just enough, with a margin. */
export function editViewShowing(view: EditView, duration: number, fps: number, time: number): EditView {
  const span = view.to - view.from;
  if (time >= view.from && time <= view.to) return view;
  const margin = span * 0.1;
  return clampEditView(time < view.from ? { from: time - margin, to: time - margin + span } : { from: time + margin - span, to: time + margin }, duration, fps);
}

/**
 * Where the ruler's marks go: a round step (1, 2 or 5 of a power of ten
 * seconds, or whole frames when zoomed right in) that leaves at least `gap`
 * pixels between marks.
 */
export function rulerTicks(view: EditView, pixels: number, fps: number, gap = 70): { step: number; ticks: number[] } {
  const span = view.to - view.from;
  if (!(span > 0) || !(pixels > 0)) return { step: 0, ticks: [] };
  const wanted = (span * gap) / pixels;
  const frame = 1 / Math.max(1, fps);
  let step: number;
  if (wanted <= frame) step = frame;
  else {
    const power = 10 ** Math.floor(Math.log10(wanted));
    step = [1, 2, 5, 10].map((unit) => unit * power).find((candidate) => candidate >= wanted) ?? 10 * power;
    // Below a second, keep marks on whole frames.
    if (step < 1) step = Math.max(frame, Math.round(step / frame) * frame);
  }
  const ticks: number[] = [];
  for (let k = Math.ceil(view.from / step - 1e-9); k * step <= view.to + 1e-9 && ticks.length < 1000; k += 1) ticks.push(round(k * step) + 0);
  return { step, ticks };
}

/**
 * The frames the filmstrip shows: one tile every so many frames — a power of
 * two, so the tiles of one zoom are among the next's and are not read again —
 * about `tile` pixels apart across the view.
 */
export function filmstripFrames(view: EditView, pixels: number, tile: number, fps: number, duration: number): { every: number; frames: number[] } {
  const span = view.to - view.from;
  if (!(span > 0) || !(pixels > 0) || !(tile > 0)) return { every: 1, frames: [] };
  const rate = Math.max(1, fps);
  const perTile = (span * tile * rate) / pixels;
  const every = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, perTile))));
  const last = Math.max(0, Math.ceil(duration * rate - 1e-6) - 1);
  const frames: number[] = [];
  const first = Math.max(0, Math.floor((view.from * rate) / every) * every);
  for (let frame = first; frame <= last && frame / rate < view.to && frames.length < 500; frame += every) frames.push(frame);
  return { every, frames };
}
