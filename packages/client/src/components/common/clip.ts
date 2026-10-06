import { findTheEnd } from './video';
import { frameRateOf, gridFrameTimes, spanOfFacts, type VideoFacts } from '@vibetoon/shared';

/**
 * A video opened in a video element to have its frames taken out, one at a
 * time, each the frame shown at the time asked for — for a file this browser
 * cannot decode from its packets (see `media.ts`; `frames.ts` picks which).
 *
 * Three things a video element does not do on its own are done here:
 *
 * - **It is in the page.** A browser may stop decoding a video it thinks
 *   nobody sees, and then hands over the last frame it had, however far the
 *   clock has moved. So the element sits in the page, 2 px in a corner.
 * - **The clip says where its frames are.** Its first frame, its last frame
 *   and how long a frame lasts are found by showing them, not read from a
 *   header that a recorded clip often leaves without a length.
 * - **A frame is taken only once it is the one shown.** After a seek the
 *   picture is drawn only when the browser says a frame was presented.
 */
export interface ElementVideo {
  facts: VideoFacts;
  /** When each frame is shown, on the grid the measured frame rate makes. */
  frameTimes(): Promise<number[]>;
  /** The frame shown at each of `times`, handed to `use` one at a time, as the video element showing it. */
  read(times: readonly number[], use: (frame: { time: number; shownAt: number; image: CanvasImageSource }) => void | Promise<void>, stopped?: () => boolean): Promise<void>;
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

/**
 * Every frame the browser shows, counted, with the time of the last one —
 * kept running while the clip is open, so a read can tell a frame shown since
 * its seek began from one shown before.
 */
class Presented {
  count = 0;
  time = -1;
  private handle = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly video: FrameVideo) {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const watch = (_now: number, metadata: { mediaTime: number }) => {
      this.count += 1;
      this.time = metadata.mediaTime;
      const waiting = this.waiting;
      this.waiting = [];
      for (const wake of waiting) wake();
      this.handle = video.requestVideoFrameCallback!(watch);
    };
    this.handle = video.requestVideoFrameCallback(watch);
  }
  get supported(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function';
  }
  /** Resolves at the next frame shown, or after `timeout` ms. */
  next(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, timeout);
      this.waiting.push(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }
  stop(): void {
    this.video.cancelVideoFrameCallback?.(this.handle);
    for (const wake of this.waiting) wake();
    this.waiting = [];
  }
}

/**
 * Seek to `time`, and the time of the frame then shown.
 *
 * When the seek is done the picture is, by definition, the right one: the
 * last frame at or before `time`. In a clip recorded in a browser that may be
 * well before it — frames come when the page managed to draw one, not on an
 * even beat — so the frame's own time is reported, never insisted on. Waiting
 * for it to equal the time asked for is what went wrong before: the wait gave
 * up, and a frame shown late from the seek before was taken instead. Here the
 * wait is only for the frame to be shown (a moment after the seek, or not at
 * all when it was already showing), and each read has its frame before the
 * next seek begins, so nothing late can be taken for it.
 */
async function showAt(video: FrameVideo, shown: Presented, time: number): Promise<number> {
  const before = shown.count;
  const sought = once(video, 'seeked', 30_000);
  video.currentTime = time;
  if (!(await sought)) throw new Error(`the video did not reach ${time.toFixed(2)}s`);
  if (!shown.supported) return video.currentTime;
  if (shown.count === before) await shown.next(250);
  return shown.count > before ? shown.time : video.currentTime;
}

export async function openElementVideo(url: string): Promise<ElementVideo> {
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

    // Where the clip ends, found by reading to it: a header may give no
    // length, or only the first part's (see `findTheEnd`).
    const end = await findTheEnd(video);
    if (!(end > 0)) throw new Error('the video has no length');

    const shown = new Presented(video);
    // How long a frame lasts: play a moment and see the frames go by.
    const seen: number[] = [];
    await showAt(video, shown, 0);
    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle = 0;
      const watch = (_now: number, metadata: { mediaTime: number }) => {
        seen.push(metadata.mediaTime);
        if (seen.length < 16) handle = video.requestVideoFrameCallback!(watch);
      };
      handle = video.requestVideoFrameCallback(watch);
      try {
        await video.play();
        const until = performance.now() + Math.min(1500, end * 1000);
        while (seen.length < 16 && performance.now() < until && !video.ended) await new Promise((resolve) => window.setTimeout(resolve, 30));
      } catch {
        // Not allowed to play: the frame rate falls back below.
      }
      video.pause();
      video.cancelVideoFrameCallback?.(handle);
    }
    const fps = frameRateOf(seen, 30);
    const frame = 1 / fps;

    // The first frame and the last, as shown.
    const first = Math.max(0, await showAt(video, shown, 0));
    let last = await showAt(video, shown, Math.max(first, end - frame / 2));
    if (!(last >= first) || last > end) last = Math.max(first, end - frame);
    const facts: VideoFacts = {
      first,
      duration: Math.max(end, last + frame),
      last,
      frames: Math.floor((last - first) / frame + 1e-6) + 1,
      fps,
      width: video.videoWidth,
      height: video.videoHeight,
      exact: false,
    };

    return {
      facts,
      frameTimes: async () => gridFrameTimes(spanOfFacts(facts)),
      async read(times, use, stopped) {
        for (const time of times) {
          if (stopped?.()) return;
          // A quarter of a frame in, so a seek that rounds lands on this frame, not the one before.
          const shownAt = await showAt(video, shown, Math.min(end, time + frame / 4));
          await use({ time, shownAt, image: video });
        }
      },
      close() {
        shown.stop();
        close();
      },
    };
  } catch (reason) {
    close();
    throw reason;
  }
}
