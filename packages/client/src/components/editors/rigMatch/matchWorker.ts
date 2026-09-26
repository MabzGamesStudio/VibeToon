/// <reference lib="webworker" />
import { matchRig, scoreFit, type BoundRig, type MatchCache, type MatchReport, type RigFit, type RigMatchOptions } from '@vibetoon/shared';

/**
 * Runs a rig match off the main thread.
 *
 * A match compares a couple of hundred features of the body against tens of
 * thousands of the picture's — a few seconds of arithmetic that would freeze
 * the editor if done where the pointer is handled. Progress comes back as it
 * goes, so the editor can say which stage it is at.
 *
 * What was worked out about a body and a picture is kept between requests with
 * the same key, so scoring a fit adjusted by hand afterwards is quick.
 */

export type MatchRequest =
  | {
      type: 'match';
      id: number;
      key: string;
      bound: BoundRig;
      picture: { width: number; height: number; pixels: ArrayBuffer };
      options: RigMatchOptions;
      from?: RigFit;
    }
  | {
      type: 'score';
      id: number;
      key: string;
      bound: BoundRig;
      picture: { width: number; height: number; pixels: ArrayBuffer };
      options: RigMatchOptions;
      fit: RigFit;
    };

export type MatchReply =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | { type: 'done'; id: number; fit: RigFit; report: MatchReport }
  | { type: 'scored'; id: number; report: MatchReport }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let cache: { key: string; value: MatchCache } | null = null;

scope.onmessage = (event: MessageEvent<MatchRequest>) => {
  const request = event.data;
  if (!cache || cache.key !== request.key) cache = { key: request.key, value: {} };
  const picture = { width: request.picture.width, height: request.picture.height, data: new Uint8ClampedArray(request.picture.pixels) };
  try {
    if (request.type === 'match') {
      let last = 0;
      const result = matchRig({
        bound: request.bound,
        picture,
        options: request.options,
        ...(request.from ? { from: request.from } : {}),
        cache: cache.value,
        onProgress: ({ stage, fraction }) => {
          // Not every step: a message a percent is plenty to draw a bar from.
          if (fraction - last < 0.01 && fraction < 1) return;
          last = fraction;
          scope.postMessage({ type: 'progress', id: request.id, stage, fraction } satisfies MatchReply);
        },
      });
      scope.postMessage({ type: 'done', id: request.id, fit: result.fit, report: result.report } satisfies MatchReply);
    } else {
      const report = scoreFit({ bound: request.bound, picture, options: request.options, fit: request.fit, cache: cache.value });
      scope.postMessage({ type: 'scored', id: request.id, report } satisfies MatchReply);
    }
  } catch (error) {
    scope.postMessage({ type: 'error', id: request.id, message: (error as Error).message } satisfies MatchReply);
  }
};
