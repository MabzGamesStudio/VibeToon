/// <reference lib="webworker" />
import { compileTerrain, renderGround, type MapLayers, type Terrain, type WorldMapFlowData } from '@vibetoon/shared';

/**
 * Draws map tiles off the main thread.
 *
 * Every pixel of ground is a few dozen noise lookups, so a screenful is a second
 * of work — enough to make panning stutter if done where the pointer is
 * handled. Several of these run at once, each holding the map's terrain built
 * once per change, and hand back finished pixels.
 */

export type WorkerRequest =
  | {
      type: 'spec';
      version: number;
      data: Pick<WorldMapFlowData, 'settings' | 'patches' | 'strokes' | 'elements'>;
      layers: Pick<MapLayers, 'relief' | 'climate'>;
    }
  | { type: 'tile'; key: string; version: number; x0: number; y0: number; pixel: number; size: number };

export interface WorkerReply {
  key: string;
  version: number;
  size: number;
  pixels: ArrayBuffer;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
let terrain: Terrain | null = null;
let layers: Pick<MapLayers, 'relief' | 'climate'> = { relief: true, climate: false };
let version = -1;

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'spec') {
    terrain = compileTerrain(message.data);
    layers = message.layers;
    version = message.version;
    return;
  }
  if (!terrain) return;
  const pixels = renderGround(terrain, message.x0, message.y0, message.pixel, message.size, message.size, layers);
  const reply: WorkerReply = { key: message.key, version, size: message.size, pixels: pixels.buffer as ArrayBuffer };
  scope.postMessage(reply, [reply.pixels]);
};
