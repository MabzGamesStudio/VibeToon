import { useEffect, useState } from 'react';
import { clipLength, frameLengthOf, snapToClipFrame, type Bitmap, type ClipSpan } from '@vibetoon/shared';

/**
 * A video clip opened to have its frames taken out, one at a time, each the
 * frame shown at the time asked for.
 *
 * Three things a video element does not do on its own are done here:
 *
 * - **It is in the page.** A browser may stop decoding a video it thinks
 *   nobody sees, and then hands over the last frame it had, however far the
 *   clock has moved. So the element sits in the page, 2 px in a corner.
 * - **The clip says where its frames are.** Its first frame, its last frame
 *   and how long a frame lasts are found by showing them (`span`), not read
 *   from a header that a recorded clip often leaves without a length.
 * - **A frame is taken only once it is the one shown.** After a seek the
 *   picture is drawn only when the browser says a frame was presented, and
 *   that frame's own time is checked against the time asked for; a frame
 *   that is not the one asked for is sought again.
 */
export interface OpenClip {
  span: ClipSpan;
  width: number;
  height: number;
  /** The frame shown at `time`, at this size, and the time it was shown at. */
  frame(time: number, width: number, height: number): Promise<{ bitmap: Bitmap; shownAt: number }>;
  /** The same frame, small, as a JPEG for showing. */
  thumbnail(width: number, height: number, quality?: number): string;
  close(): void;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(callback: (now: number, metadata: { mediaTime: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

/** Wait for an event, or give up after a while. */
function once(target: EventTarget, name: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (happened: boolean) => {
      target.removeEventListener(name, onEvent);
      window.clearTimeout(timer);
      resolve(happened);
    };
    const onEvent = () => done(true);
    const timer = window.setTimeout(() => done(false), timeout);
    target.addEventListener(name, onEvent);
  });
}

/** The next frame the browser presents, and its time; null if none comes. */
function presented(video: FrameVideo, timeout: number): Promise<number | null> {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const handle = video.requestVideoFrameCallback!((_now, metadata) => {
      window.clearTimeout(timer);
      resolve(metadata.mediaTime);
    });
    const timer = window.setTimeout(() => {
      video.cancelVideoFrameCallback?.(handle);
      resolve(null);
    }, timeout);
  });
}

/** Seek, and the time of the frame that is then shown (or, failing that, where the clock is). */
async function showAt(video: FrameVideo, time: number): Promise<number> {
  const shown = presented(video, 400);
  const sought = once(video, 'seeked', 4000);
  video.currentTime = time;
  await sought;
  return (await shown) ?? video.currentTime;
}

export async function openClip(url: string): Promise<OpenClip> {
  const video = document.createElement('video') as FrameVideo;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', pointerEvents: 'none', zIndex: '-1' });
  document.body.appendChild(video);
  const close = () => {
    video.removeAttribute('src');
    video.load();
    video.remove();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('this browser cannot play this video'));
      video.src = url;
    });

    // Where the clip ends: a recorded clip often says nothing until it has been
    // read to the end, and seeking past the end makes it find out.
    if (!Number.isFinite(video.duration)) {
      const known = new Promise<void>((resolve) => {
        const check = () => {
          if (!Number.isFinite(video.duration)) return;
          video.removeEventListener('durationchange', check);
          resolve();
        };
        video.addEventListener('durationchange', check);
      });
      video.currentTime = 1e101;
      await Promise.race([known, new Promise((resolve) => window.setTimeout(resolve, 8000))]);
    }
    const end = Number.isFinite(video.duration) ? video.duration : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (!(end > 0)) throw new Error('the video has no length');

    // How long a frame lasts: play a moment and see the frames go by.
    const seen: number[] = [];
    await showAt(video, 0);
    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle = 0;
      const watch = (_now: number, metadata: { mediaTime: number }) => {
        seen.push(metadata.mediaTime);
        if (seen.length < 12) handle = video.requestVideoFrameCallback!(watch);
      };
      handle = video.requestVideoFrameCallback(watch);
      try {
        await video.play();
        const until = performance.now() + Math.min(1500, end * 1000);
        while (seen.length < 12 && performance.now() < until && !video.ended) await new Promise((resolve) => window.setTimeout(resolve, 30));
      } catch {
        // Not allowed to play: the frame length falls back below.
      }
      video.pause();
      video.cancelVideoFrameCallback?.(handle);
    }
    const frame = frameLengthOf(seen, 1 / 30);

    // The first frame and the last, as shown.
    const first = Math.max(0, await showAt(video, 0));
    let last = await showAt(video, Math.max(first, end - frame / 2));
    if (!(last >= first) || last > end) last = Math.max(first, end - frame);
    const span: ClipSpan = { first, last, frame };

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const draw = (width: number, height: number) => {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      context.drawImage(video, 0, 0, width, height);
    };

    return {
      span,
      width: video.videoWidth,
      height: video.videoHeight,
      async frame(time, width, height) {
        const wanted = snapToClipFrame(span, time);
        // A quarter of a frame in, so a seek that rounds lands on this frame, not the one before.
        let shownAt = await showAt(video, Math.min(end, wanted + frame / 4));
        if (Math.abs(shownAt - wanted) > frame * 0.6) {
          // Not the frame asked for: try once more, from the middle of it.
          shownAt = await showAt(video, Math.min(end, wanted + frame / 2));
        }
        draw(width, height);
        const pixels = context.getImageData(0, 0, width, height);
        return { bitmap: { width, height, data: pixels.data }, shownAt };
      },
      thumbnail(width, height, quality = 0.6) {
        const thumb = document.createElement('canvas');
        thumb.width = width;
        thumb.height = height;
        thumb.getContext('2d')!.drawImage(video, 0, 0, width, height);
        return thumb.toDataURL('image/jpeg', quality);
      },
      close,
    };
  } catch (reason) {
    close();
    throw reason;
  }
}

export interface ClipProbe {
  span: ClipSpan;
  /** The clip's length, first frame to the end of the last, and its size. */
  meta: { duration: number; width: number; height: number };
}

/** A clip's span and size, probed once for each URL. */
export function useClipProbe(url: string | null): { probe: ClipProbe | null; error: string | null } {
  const [probe, setProbe] = useState<ClipProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProbe(null);
    setError(null);
    if (!url) return undefined;
    let cancelled = false;
    openClip(url)
      .then((clip) => {
        if (!cancelled) setProbe({ span: clip.span, meta: { duration: clipLength(clip.span), width: clip.width, height: clip.height } });
        clip.close();
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return { probe, error };
}
