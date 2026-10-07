import { useEffect, useState } from 'react';
import type { VideoFacts } from '@vibetoon/shared';
import { openElementVideo } from './clip';
import { openExactVideo, readVideoFacts } from './media';

/**
 * A video opened to take frames out of, whichever way this browser can:
 * decoded from the file's own packets where it can (exact: every frame the
 * file holds, at the time it holds it), or else shown frame by frame in a
 * video element (see `clip.ts`). Both hand over the frame shown at a time.
 */
export interface VideoFrames {
  facts: VideoFacts;
  /** When each frame is shown, first to last. */
  frameTimes(): Promise<number[]>;
  /**
   * The frame shown at each of `times` (ascending), handed to `use` one at a
   * time as a picture to draw from before `use` returns.
   */
  read(times: readonly number[], use: (frame: { time: number; shownAt: number; image: CanvasImageSource }) => void | Promise<void>, stopped?: () => boolean): Promise<void>;
  close(): void;
}

export async function openVideoFrames(url: string): Promise<VideoFrames> {
  try {
    return await openExactVideo(url);
  } catch {
    // This browser cannot decode it from the file: show it instead.
    return openElementVideo(url);
  }
}

/** A video's facts, exact where this browser can read them from the file, else measured by playing it. */
export async function videoFacts(url: string): Promise<VideoFacts> {
  const exact = await readVideoFacts(url);
  if (exact) return exact;
  const element = await openElementVideo(url);
  element.close();
  return element.facts;
}

/** A video's facts, read once for each URL. */
export function useVideoMeta(url: string | null): { meta: VideoFacts | null; error: string | null } {
  const [meta, setMeta] = useState<VideoFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMeta(null);
    setError(null);
    if (!url) return undefined;
    let cancelled = false;
    videoFacts(url)
      .then((facts) => {
        if (!cancelled) setMeta(facts);
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

/** A video's facts and the time of each of its frames, read once for each URL. */
export function useVideoFrameTimes(url: string | null): { probe: { facts: VideoFacts; times: number[]; url: string } | null; error: string | null } {
  const [probe, setProbe] = useState<{ facts: VideoFacts; times: number[]; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProbe(null);
    setError(null);
    if (!url) return undefined;
    let cancelled = false;
    void (async () => {
      let frames: VideoFrames | null = null;
      try {
        frames = await openVideoFrames(url);
        const times = await frames.frameTimes();
        if (!cancelled) setProbe({ facts: frames.facts, times, url });
      } catch (reason) {
        if (!cancelled) setError((reason as Error).message);
      } finally {
        frames?.close();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  return { probe, error };
}
