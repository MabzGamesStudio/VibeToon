import { useCallback, useEffect, useState } from 'react';
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

/** Read a file as a data URL and hand it to `send`. */
export function useFileUpload(send: (fileName: string, data: string) => Promise<void> | void, onError: (message: string) => void): (file: File) => void {
  return useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => void send(file.name, String(reader.result));
      reader.onerror = () => onError('That file could not be read.');
      reader.readAsDataURL(file);
    },
    [onError, send],
  );
}

export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
