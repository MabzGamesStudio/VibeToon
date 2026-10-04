import type { ClipFormat, CropRect, VideoSegment } from '@vibetoon/shared';
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
  /** What to record as; the best WebM when not given. */
  format?: ClipFormat;
  onProgress(progress: RenderProgress): void;
  stopped(): boolean;
}): Promise<Blob[]> {
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

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('the recording could not be read'));
    reader.readAsDataURL(blob);
  });
}
