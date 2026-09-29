import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bitmap } from '@vibetoon/shared';

/** A video element ready to be read from, at a URL, its length known. */
export async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = await new Promise<HTMLVideoElement>((resolve, reject) => {
    const element = document.createElement('video');
    element.muted = true;
    element.preload = 'auto';
    element.playsInline = true;
    element.crossOrigin = 'anonymous';
    element.onloadeddata = () => resolve(element);
    element.onerror = () => reject(new Error('the video could not be read in this browser'));
    element.src = url;
  });
  // A video recorded in a browser often does not say how long it is until it
  // has been read to the end; seeking past the end makes it find out.
  if (!Number.isFinite(video.duration)) {
    await new Promise<void>((resolve) => {
      const known = () => {
        if (!Number.isFinite(video.duration)) return;
        video.removeEventListener('durationchange', known);
        resolve();
      };
      video.addEventListener('durationchange', known);
      video.currentTime = 1e101;
    });
    await seek(video, 0);
  }
  return video;
}

export function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-3 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** Let go of a video's file, so the browser can drop it. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute('src');
  video.load();
}

/** Reads frames of one video at a fixed size, one at a time. */
export class FrameReader {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  constructor(
    readonly video: HTMLVideoElement,
    readonly width: number,
    readonly height: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** The frame at a time, as pixels. Never at or past the end, which is often black. */
  async read(time: number): Promise<Bitmap> {
    const at = Math.max(0, Math.min(time, this.video.duration - 1e-3));
    await seek(this.video, at);
    this.context.clearRect(0, 0, this.width, this.height);
    this.context.drawImage(this.video, 0, 0, this.width, this.height);
    const pixels = this.context.getImageData(0, 0, this.width, this.height);
    return { width: this.width, height: this.height, data: pixels.data };
  }

  /** The frame at a time, as a small JPEG for showing. */
  async thumbnail(time: number, quality = 0.7): Promise<string> {
    const at = Math.max(0, Math.min(time, this.video.duration - 1e-3));
    await seek(this.video, at);
    this.context.drawImage(this.video, 0, 0, this.width, this.height);
    return this.canvas.toDataURL('image/jpeg', quality);
  }
}

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

/** A video's length and size, read once for each URL. */
export function useVideoMeta(url: string | null): { meta: VideoMeta | null; error: string | null } {
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMeta(null);
    setError(null);
    if (!url) return undefined;
    let cancelled = false;
    loadVideo(url)
      .then((video) => {
        if (!cancelled) setMeta({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
        releaseVideo(video);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return { meta, error };
}

/**
 * Small pictures of a video's frames, read on their own video element as they
 * are asked for. `want` replaces what is waiting to be read with the frames
 * wanted now — the ones in view — so a zoom or pan does not wait on frames no
 * longer shown. What was read is kept, by frame, until the URL or size changes.
 */
export function useFrameThumbnails(
  url: string | null,
  width: number,
  height: number,
  fps: number,
): { thumbs: Record<number, string>; want: (frames: readonly number[]) => void } {
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const known = useRef<Record<number, string>>({});
  const queue = useRef<number[]>([]);
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    known.current = {};
    queue.current = [];
    setThumbs({});
    if (!url || !(width > 0) || !(height > 0)) return undefined;
    let stopped = false;
    let video: HTMLVideoElement | null = null;
    void (async () => {
      try {
        video = await loadVideo(url);
        const reader = new FrameReader(video, Math.round(width), Math.round(height));
        let batch: Record<number, string> = {};
        const flush = () => {
          const add = batch;
          batch = {};
          if (!stopped && Object.keys(add).length > 0) setThumbs((current) => ({ ...current, ...add }));
        };
        while (!stopped) {
          const frame = queue.current.shift();
          if (frame === undefined) {
            flush();
            await new Promise<void>((resolve) => (wake.current = resolve));
            wake.current = null;
            continue;
          }
          if (known.current[frame]) continue;
          // A little into the frame, so the frame shown is that one and not the one before.
          const picture = await reader.thumbnail((frame + 0.25) / Math.max(1, fps));
          known.current[frame] = picture;
          batch[frame] = picture;
          if (Object.keys(batch).length >= 6) flush();
        }
      } catch {
        // Pictures are a nicety: the timeline works without them.
      }
    })();
    return () => {
      stopped = true;
      wake.current?.();
      if (video) releaseVideo(video);
    };
  }, [url, width, height, fps]);

  const want = useCallback((frames: readonly number[]) => {
    queue.current = frames.filter((frame) => !known.current[frame]);
    if (queue.current.length > 0) wake.current?.();
  }, []);
  return { thumbs, want };
}

/** A button that uploads a video onto a flow's own Video port. */
export function VideoUpload({
  replace,
  onFile,
}: {
  replace: boolean;
  onFile(file: File): void;
}): JSX.Element {
  return (
    <label className="vt-btn is-small">
      {replace ? 'Replace the video' : 'Upload a video'}
      <input
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        }}
      />
    </label>
  );
}

/**
 * Hand a chosen file to `send` as it is. It is not read into the page first: a
 * video turned into a data URL can be longer than a browser can hold.
 */
export function useFileUpload(send: (fileName: string, data: Blob) => Promise<unknown> | void, onError: (message: string) => void): (file: File) => void {
  return useCallback(
    (file: File) => {
      if (file.size === 0) {
        onError('That file is empty.');
        return;
      }
      void send(file.name, file);
    },
    [onError, send],
  );
}

export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
