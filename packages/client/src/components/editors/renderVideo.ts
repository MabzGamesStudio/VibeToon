import type { CropRect, VideoSegment } from '@vibetoon/shared';
import { loadVideo, releaseVideo, seek } from '../common/video';

/** The best WebM this browser can record. */
export function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
}

export interface RenderProgress {
  /** Seconds of the edit recorded so far, and in all. */
  done: number;
  total: number;
  clip: number;
}

interface Recorder {
  recorder: MediaRecorder;
  finished: Promise<Blob>;
}

function recorderFor(canvas: HTMLCanvasElement, fps: number, type: string): Recorder {
  const stream = canvas.captureStream(fps);
  // About a tenth of a bit per pixel per frame: clean for drawn footage.
  const bits = Math.round(Math.min(12_000_000, Math.max(1_000_000, canvas.width * canvas.height * fps * 0.12)));
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bits });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  });
  return { recorder, finished };
}

/**
 * Play one stretch of the video through the crop onto the canvas, from `start`
 * to `end`, while the recorder runs. The recorder is paused while seeking, so
 * the jump between segments is not recorded.
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
  await seek(video, segment.start);
  draw();
  if (recorder.state === 'paused') recorder.resume();
  else if (recorder.state === 'inactive') recorder.start(250);
  await video.play();
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (stopped() || video.ended || video.currentTime >= segment.end - 1e-3) {
        video.pause();
        resolve();
        return;
      }
      draw();
      onTime(video.currentTime - segment.start);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  draw();
  recorder.pause();
}

/**
 * Record the kept segments of a video through a crop: as one video, one after
 * another, or as a clip for each. Played at normal speed, so it takes as long
 * as the edit lasts.
 */
export async function renderEdit(options: {
  url: string;
  segments: VideoSegment[];
  crop: CropRect;
  fps: number;
  mode: 'joined' | 'clips';
  onProgress(progress: RenderProgress): void;
  stopped(): boolean;
}): Promise<Blob[]> {
  const type = recordingType();
  if (!type) throw new Error('this browser cannot record video');
  const video = await loadVideo(options.url);
  const canvas = document.createElement('canvas');
  canvas.width = options.crop.width;
  canvas.height = options.crop.height;
  const context = canvas.getContext('2d')!;
  const total = options.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  let before = 0;
  const blobs: Blob[] = [];
  try {
    if (options.mode === 'joined') {
      const { recorder, finished } = recorderFor(canvas, options.fps, type);
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
        const { recorder, finished } = recorderFor(canvas, options.fps, type);
        await playThrough(video, context, options.crop, segment, recorder, (seconds) => options.onProgress({ done: before + seconds, total, clip: index }), options.stopped);
        before += segment.end - segment.start;
        if (recorder.state !== 'inactive') recorder.stop();
        blobs.push(await finished);
      }
    }
  } finally {
    releaseVideo(video);
  }
  return blobs;
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('the recording could not be read'));
    reader.readAsDataURL(blob);
  });
}
