import { clipAt, totalDuration, type PlayClip } from './playClips';

export interface RecordOptions {
  width: number;
  height: number;
  fps: number;
  /** Burn the dialog in under the picture. */
  captions: boolean;
  onProgress?(fraction: number): void;
  /** Stops the recording early and rejects. */
  signal?: AbortSignal;
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationSec: number;
}

const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function recordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    CANDIDATE_TYPES.some((type) => MediaRecorder.isTypeSupported(type))
  );
}

function pickMimeType(): string {
  return CANDIDATE_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm';
}

/** Wrap a caption to the frame width and draw it along the bottom. */
function drawCaption(ctx: CanvasRenderingContext2D, caption: string, width: number, height: number): void {
  const lines = caption.split('\n').flatMap((line) => wrap(ctx, line, width * 0.86));
  if (lines.length === 0) return;
  const size = Math.round(height / 22);
  const lineHeight = size * 1.3;
  const bottom = height - size * 0.9;

  ctx.save();
  ctx.font = `${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = Math.max(2, size / 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, index) => {
    const y = bottom - (lines.length - 1 - index) * lineHeight;
    ctx.strokeText(line, width / 2, y);
    ctx.fillText(line, width / 2, y);
  });
  ctx.restore();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text.trim()) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Record a cut to a video file in the browser. The frames come off a canvas the
 * same code paints the player with, so this is a real render of the same cut —
 * and it means a machine with no video tooling installed can still produce a
 * file at the end of the pipeline.
 *
 * Capture is real time: a 30 second animatic takes 30 seconds to record.
 */
export async function recordClips(clips: readonly PlayClip[], options: RecordOptions): Promise<Recording> {
  if (!recordingSupported()) throw new Error('This browser cannot record a canvas to video.');
  const durationSec = totalDuration(clips);
  if (clips.length === 0 || durationSec <= 0) throw new Error('There is nothing to record.');

  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not open a drawing context.');

  const mimeType = pickMimeType();
  const stream = canvas.captureStream(options.fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: Math.round(options.width * options.height * 4),
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('The recorder stopped unexpectedly.'));
  });

  // Paint the first frame before starting so the file never opens on a blank.
  const first = clipAt(clips, 0);
  if (first) first.clip.render(canvas);

  recorder.start(200);
  const startedAt = performance.now();

  const paint = (clipIndex: number): void => {
    const current = clips[clipIndex];
    if (!current) return;
    current.render(canvas);
    if (options.captions && current.caption) {
      drawCaption(ctx, current.caption, canvas.width, canvas.height);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const step = () => {
      if (options.signal?.aborted) {
        reject(new Error('Recording cancelled.'));
        return;
      }
      const elapsed = (performance.now() - startedAt) / 1000;
      const current = clipAt(clips, Math.min(elapsed, durationSec - 0.0001));
      // Repaint every frame even when the picture has not changed: a canvas
      // capture stream only emits a frame when the canvas is dirty, so a long
      // held shot would otherwise record as a gap and cut the video short.
      if (current) paint(current.index);
      options.onProgress?.(Math.min(1, elapsed / durationSec));
      if (elapsed >= durationSec) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }).catch((error: Error) => {
    recorder.stop();
    throw error;
  });

  // Hold the last frame long enough for the encoder to take it, so the file
  // ends where the cut ends.
  paint(clips.length - 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  recorder.stop();
  for (const track of stream.getTracks()) track.stop();
  await finished;

  return { blob: new Blob(chunks, { type: mimeType }), mimeType, durationSec };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.readAsDataURL(blob);
  });
}

/** `video/webm;codecs=vp9` -> `webm`. */
export function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  return 'webm';
}
