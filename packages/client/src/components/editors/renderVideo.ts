import { useEffect, useState } from 'react';
import { CLIP_FORMATS, type ClipFormat, type ClipFormatId, type CropRect, type VideoSegment } from '@vibetoon/shared';
import { openVideoFrames } from '../common/frames';
import { canEncodeExactly, finishRecording, startClip } from '../common/media';
import { loadVideo, releaseVideo, seek } from '../common/video';

/**
 * What to ask this browser's recorder for: the first of a format's types it
 * can record, or with no format the best WebM. Undefined when it cannot.
 */
export function recordingType(format?: ClipFormat): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const types = format ? format.recorderTypes : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * How this browser can write a format: frame by frame from the video's own
 * frames (`exact`), only by recording the page as the video plays
 * (`recorded`), or not at all.
 */
export type FormatSupport = 'exact' | 'recorded' | 'none';

let supportFound: Promise<Record<ClipFormatId, FormatSupport>> | null = null;

/** How every format can be written here, found once. */
export function formatSupport(): Promise<Record<ClipFormatId, FormatSupport>> {
  supportFound ??= Promise.all(
    CLIP_FORMATS.map(async (format) => [format.id, (await canEncodeExactly(format)) ? 'exact' : recordingType(format) ? 'recorded' : 'none'] as const),
  ).then((pairs) => Object.fromEntries(pairs) as Record<ClipFormatId, FormatSupport>);
  return supportFound;
}

export function useFormatSupport(): Record<ClipFormatId, FormatSupport> | null {
  const [support, setSupport] = useState<Record<ClipFormatId, FormatSupport> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void formatSupport().then((found) => {
      if (!cancelled) setSupport(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return support;
}

export interface RenderProgress {
  /** Seconds of the edit written so far, and in all. */
  done: number;
  total: number;
  clip: number;
}

interface Recorder {
  recorder: MediaRecorder;
  finished: Promise<Blob>;
}

function recorderFor(canvas: HTMLCanvasElement, fps: number, type: string, contentType: string): Recorder {
  const stream = canvas.captureStream(fps);
  // About a tenth of a bit per pixel per frame: clean for drawn footage.
  const bits = Math.round(Math.min(12_000_000, Math.max(1_000_000, canvas.width * canvas.height * fps * 0.12)));
  // A whole picture every half second: a recording otherwise has one only at
  // its start, and every seek into it decodes from there, slower the further in.
  // (Browsers that do not know the option ignore it.)
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bits, videoKeyFrameIntervalDuration: 500 } as MediaRecorderOptions);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: contentType }));
  });
  return { recorder, finished };
}

/**
 * Play one stretch of the video through the crop onto the canvas, from `start`
 * to `end`, while the recorder runs.
 *
 * The recorder keeps time by the clock, not by the video, so it runs only while
 * the video is really moving: it starts once the first frame after the seek is
 * on screen, pauses whenever the video waits to buffer or the page is hidden
 * (when the browser stops drawing), and stops at the end of the stretch.
 * Recording through a stall instead wrote the same picture for as long as it
 * lasted, and a clip came out longer than its shot, its frames no longer spread
 * evenly through it. The jump between segments is not recorded either.
 */
async function playThrough(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  crop: CropRect,
  segment: VideoSegment,
  recorder: MediaRecorder,
  onTime: (seconds: number) => void,
  stopped: () => boolean,
): Promise<void> {
  const draw = () => context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const record = () => {
    if (recorder.state === 'paused') recorder.resume();
    else if (recorder.state === 'inactive') recorder.start(250);
  };
  const hold = () => {
    if (recorder.state === 'recording') recorder.pause();
  };
  await seek(video, segment.start);
  draw();
  let moving = false;
  const onWaiting = () => {
    moving = false;
    hold();
  };
  const onVisibility = () => {
    if (document.hidden) {
      hold();
      video.pause();
    } else if (!stopped()) void video.play();
  };
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('stalled', onWaiting);
  document.addEventListener('visibilitychange', onVisibility);
  const next = (callback: () => void) => requestAnimationFrame(callback);
  // Each frame the video actually decodes, where the browser says so. Its
  // clock can run on while no new frame is decoded — a browser may stop
  // decoding a video it thinks nobody sees — so a moving clock alone is not
  // a moving picture: with frame callbacks, only a new frame counts.
  type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?(callback: () => void): number; cancelVideoFrameCallback?(handle: number): void };
  const framed = video as FrameVideo;
  const byFrame = typeof framed.requestVideoFrameCallback === 'function';
  let fresh = false;
  let frameHandle = 0;
  const onFrame = () => {
    fresh = true;
    frameHandle = framed.requestVideoFrameCallback!(onFrame);
  };
  if (byFrame) frameHandle = framed.requestVideoFrameCallback!(onFrame);
  try {
    if (!document.hidden) await video.play();
    await new Promise<void>((resolve) => {
      let last = video.currentTime;
      let movedAt = performance.now();
      const tick = () => {
        if (stopped() || video.ended || video.currentTime >= segment.end - 1e-3) {
          video.pause();
          resolve();
          return;
        }
        // Record only once the picture is actually moving on.
        const advanced = byFrame ? fresh : video.currentTime !== last;
        fresh = false;
        if (advanced && !video.paused && !document.hidden) {
          movedAt = performance.now();
          draw();
          if (!moving) {
            moving = true;
            record();
          } else if (recorder.state === 'paused') record();
        } else if (moving && performance.now() - movedAt > 100) {
          // Stuck without saying so: hold until it moves again.
          hold();
        }
        last = video.currentTime;
        onTime(video.currentTime - segment.start);
        next(tick);
      };
      next(tick);
      // A hidden page draws nothing: look again once it is shown.
      const wake = () => {
        if (!document.hidden) next(tick);
      };
      document.addEventListener('visibilitychange', wake, { once: true });
    });
  } finally {
    if (byFrame) framed.cancelVideoFrameCallback?.(frameHandle);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('stalled', onWaiting);
    document.removeEventListener('visibilitychange', onVisibility);
  }
  draw();
  if (recorder.state === 'inactive') recorder.start(250);
  hold();
}

/**
 * Record the kept segments of a video through a crop as it plays: the way
 * left for a browser that cannot encode a format frame by frame. Played at
 * normal speed, so it takes as long as the edit lasts, and a frame is caught
 * whenever the page draws one, so the frames are not evenly spaced.
 */
async function recordEdit(options: RenderOptions): Promise<Blob[]> {
  const type = recordingType(options.format);
  if (!type) throw new Error(options.format ? `this browser cannot record ${options.format.label}` : 'this browser cannot record video');
  const contentType = options.format?.contentType ?? 'video/webm';
  const video = await loadVideo(options.url);
  // In the page, if only just: a video the browser thinks nobody can see may
  // have its decoding stopped while its clock runs on, and it would record the
  // same frame over and over.
  Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', pointerEvents: 'none', zIndex: '-1' });
  document.body.appendChild(video);
  const canvas = document.createElement('canvas');
  canvas.width = options.crop.width;
  canvas.height = options.crop.height;
  const context = canvas.getContext('2d')!;
  const total = options.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  let before = 0;
  const blobs: Blob[] = [];
  try {
    if (options.mode === 'joined') {
      const { recorder, finished } = recorderFor(canvas, options.fps, type, contentType);
      for (const segment of options.segments) {
        if (options.stopped()) break;
        await playThrough(video, context, options.crop, segment, recorder, (seconds) => options.onProgress({ done: before + seconds, total, clip: 0 }), options.stopped);
        before += segment.end - segment.start;
      }
      if (recorder.state !== 'inactive') recorder.stop();
      blobs.push(await finished);
    } else {
      for (const [index, segment] of options.segments.entries()) {
        if (options.stopped()) break;
        const { recorder, finished } = recorderFor(canvas, options.fps, type, contentType);
        await playThrough(video, context, options.crop, segment, recorder, (seconds) => options.onProgress({ done: before + seconds, total, clip: index }), options.stopped);
        before += segment.end - segment.start;
        if (recorder.state !== 'inactive') recorder.stop();
        blobs.push(await finished);
      }
    }
  } finally {
    video.remove();
    releaseVideo(video);
  }
  return blobs;
}

export interface RenderOptions {
  url: string;
  segments: VideoSegment[];
  crop: CropRect;
  fps: number;
  mode: 'joined' | 'clips';
  /** What to write as; the best WebM when not given. */
  format?: ClipFormat;
  onProgress(progress: RenderProgress): void;
  stopped(): boolean;
}

export interface Rendered {
  blobs: Blob[];
  /** How it was written: frame by frame, or recorded as it played. */
  how: 'exact' | 'recorded';
  /** Whether the frames were decoded from the file, or shown in a video element to be drawn. */
  decoded: boolean;
}

/** The sides of a crop, made even: video needs them so. */
function evenSize(crop: CropRect): { width: number; height: number } {
  const width = Math.max(2, Math.round(crop.width));
  const height = Math.max(2, Math.round(crop.height));
  return { width: width - (width % 2), height: height - (height % 2) };
}

/**
 * Write the kept segments of a video through a crop: as one video, one after
 * another, or as a clip for each.
 *
 * Frame by frame wherever this browser can encode the format: frame `i` of a
 * segment is the frame the source shows in the middle of the `i`-th
 * 1/fps-long slot from its start — decoded from the file, or shown and drawn
 * where the file cannot be decoded here — and is written at exactly
 * `i / fps`. Nothing is dropped however slow the page is, the frames are
 * evenly spaced at the source's own rate, a segment of `n / fps` seconds has
 * `n` frames, and the file has its length in its header, an index and a whole
 * picture every second (see `startClip`). Otherwise it is recorded as it
 * plays, and the recording copied into a file with its length and an index.
 */
export async function renderEdit(options: RenderOptions): Promise<Rendered> {
  const format = options.format ?? CLIP_FORMATS[0]!;
  const size = evenSize(options.crop);
  if (await canEncodeExactly(format, size.width, size.height)) {
    const frames = await openVideoFrames(options.url);
    const fps = Math.max(1, options.fps);
    const total = options.segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
    const groups = options.mode === 'joined' ? [options.segments] : options.segments.map((segment) => [segment]);
    const blobs: Blob[] = [];
    let before = 0;
    try {
      for (const [clip, group] of groups.entries()) {
        if (options.stopped()) return { blobs: [], how: 'exact', decoded: frames.facts.exact };
        const writer = await startClip(format, size.width, size.height, fps);
        for (const segment of group) {
          const count = Math.max(1, Math.round((segment.end - segment.start) * fps));
          const times = Array.from({ length: count }, (_, index) => Math.min(frames.facts.duration, segment.start + (index + 0.5) / fps));
          const startedAt = writer.frames();
          await frames.read(
            times,
            async ({ image }) => {
              writer.context.drawImage(image, options.crop.x, options.crop.y, options.crop.width, options.crop.height, 0, 0, size.width, size.height);
              await writer.add();
              options.onProgress({ done: before + (writer.frames() - startedAt) / fps, total, clip });
            },
            options.stopped,
          );
          if (options.stopped()) {
            await writer.cancel();
            return { blobs: [], how: 'exact', decoded: frames.facts.exact };
          }
          // A time the file had no frame for keeps the last picture: the segment keeps its length.
          while (writer.frames() - startedAt < count) await writer.add();
          before += segment.end - segment.start;
        }
        blobs.push(await writer.finish());
      }
      return { blobs, how: 'exact', decoded: frames.facts.exact };
    } finally {
      frames.close();
    }
  }
  const recorded = await recordEdit({ ...options, format });
  return { blobs: await Promise.all(recorded.map((blob) => finishRecording(blob, format))), how: 'recorded', decoded: false };
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('the recording could not be read'));
    reader.readAsDataURL(blob);
  });
}
