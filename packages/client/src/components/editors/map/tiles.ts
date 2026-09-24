import type { KmRect, MapElement, MapLayers, PaintStroke, WorldMapFlowData } from '@vibetoon/shared';
import type { WorkerReply, WorkerRequest } from './mapWorker';

/** Tiles are this many pixels square. */
export const TILE = 256;

/** The scale a tile level is drawn at: km a pixel, a power of two. */
export const levelPixel = (level: number) => 2 ** level;

/** The level to draw a view at: the finest whose pixels are no bigger than the screen's, so nothing is blurred up. */
export const levelFor = (pixel: number) => Math.floor(Math.log2(pixel));

export interface TileEntry {
  canvas: HTMLCanvasElement;
  version: number;
  box: KmRect;
}

type Spec = Extract<WorkerRequest, { type: 'spec' }>;

/** Settlement kinds whose fields and streets change the ground round them. */
const SHAPES_GROUND = new Set(['place/city', 'place/town', 'place/village', 'place/hamlet', 'geo/urban_area']);

const tileBox = (level: number, tx: number, ty: number): KmRect => {
  const span = TILE * levelPixel(level);
  return { x0: tx * span, y0: ty * span, x1: (tx + 1) * span, y1: (ty + 1) * span };
};

const overlaps = (a: KmRect, b: KmRect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function strokeBox(stroke: PaintStroke): KmRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let index = 0; index + 1 < stroke.points.length; index += 2) {
    x0 = Math.min(x0, stroke.points[index]!);
    x1 = Math.max(x1, stroke.points[index]!);
    y0 = Math.min(y0, stroke.points[index + 1]!);
    y1 = Math.max(y1, stroke.points[index + 1]!);
  }
  // A little over the radius: relief shading reads the pixel beside it.
  const pad = stroke.radius * 1.05 + 0.01;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

function settlementBox(element: MapElement): KmRect {
  const reach = (element.size / 2000) * 7;
  return { x0: element.x - reach, y0: element.y - reach, x1: element.x + reach, y1: element.y + reach };
}

/**
 * The ground as tiles: drawn by a pool of workers, kept in a cache, and
 * redrawn only where something changed.
 *
 * A change to the settings or the regions is a change to everywhere. A paint
 * stroke is a change only under it, and a settlement only round it — so while
 * painting, the tiles the brush has not been near stay as they are, and only a
 * few are redrawn each time the stroke grows.
 */
export class MapTiles {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private cache = new Map<string, TileEntry>();
  private flying = new Map<string, number>();
  private queue: Array<{ key: string; level: number; tx: number; ty: number }> = [];
  private version = 0;
  private changes: Array<{ version: number; box: KmRect | null }> = [];
  private last: { key: string; strokes: PaintStroke[]; settlements: MapElement[] } | null = null;
  private spec: Spec | null = null;

  constructor(private onTile: () => void) {
    const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    for (let index = 0; index < count; index += 1) {
      const worker = new Worker(new URL('./mapWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerReply>) => this.receive(index, event.data);
      this.workers.push(worker);
      this.busy.push(false);
    }
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.cache.clear();
  }

  /** Tell the tiles what the map now is; works out what that changed. */
  setSpec(data: Pick<WorldMapFlowData, 'settings' | 'patches' | 'strokes' | 'elements'>, layers: Pick<MapLayers, 'relief' | 'climate'>): void {
    const settlements = data.elements.filter((element) => SHAPES_GROUND.has(element.type));
    const key = JSON.stringify([data.settings, data.patches, layers.relief, layers.climate]);
    const last = this.last;
    let changed: Array<KmRect | null> = [];
    if (!last || last.key !== key) changed = [null];
    else {
      // Strokes: any added, removed, or grown since.
      const before = new Map(last.strokes.map((stroke) => [stroke.id, stroke]));
      const after = new Map(data.strokes.map((stroke) => [stroke.id, stroke]));
      for (const stroke of data.strokes) {
        const was = before.get(stroke.id);
        if (!was || was.points.length !== stroke.points.length || was.paint !== stroke.paint || was.radius !== stroke.radius) changed.push(strokeBox(stroke));
      }
      for (const stroke of last.strokes) if (!after.has(stroke.id)) changed.push(strokeBox(stroke));
      // Settlements: any moved, resized, added or removed.
      const fingerprint = (element: MapElement) => `${element.type}:${element.x}:${element.y}:${element.size}`;
      const placesBefore = new Map(last.settlements.map((element) => [element.id, element]));
      const placesAfter = new Map(settlements.map((element) => [element.id, element]));
      for (const element of settlements) {
        const was = placesBefore.get(element.id);
        if (!was || fingerprint(was) !== fingerprint(element)) {
          changed.push(settlementBox(element));
          if (was) changed.push(settlementBox(was));
        }
      }
      for (const element of last.settlements) if (!placesAfter.has(element.id)) changed.push(settlementBox(element));
    }
    this.last = { key, strokes: data.strokes, settlements };
    if (changed.length === 0) return;

    this.version += 1;
    for (const box of changed) this.changes.push({ version: this.version, box });
    if (changed.includes(null)) this.changes = [{ version: this.version, box: null }];
    this.spec = {
      type: 'spec',
      version: this.version,
      data: { settings: data.settings, patches: data.patches, strokes: data.strokes, elements: settlements },
      layers: { relief: layers.relief, climate: layers.climate },
    };
    for (const worker of this.workers) worker.postMessage(this.spec);
    this.flying.clear();
  }

  /** Whether a drawn tile still shows the map as it is. */
  valid(entry: TileEntry): boolean {
    if (entry.version === this.version) return true;
    for (const change of this.changes) {
      if (change.version <= entry.version) continue;
      if (!change.box || overlaps(change.box, entry.box)) return false;
    }
    return true;
  }

  get(level: number, tx: number, ty: number): TileEntry | undefined {
    const entry = this.cache.get(`${level}/${tx}/${ty}`);
    if (entry && entry.version !== this.version && this.valid(entry)) entry.version = this.version;
    return entry;
  }

  /** Ask for the tiles in view, nearest the middle first; anything no longer wanted is dropped from the queue. */
  want(tiles: Array<{ level: number; tx: number; ty: number }>): void {
    this.queue = tiles
      .map((tile) => ({ ...tile, key: `${tile.level}/${tile.tx}/${tile.ty}` }))
      .filter(({ key, level, tx, ty }) => {
        const entry = this.get(level, tx, ty);
        if (entry && this.valid(entry)) return false;
        return this.flying.get(key) !== this.version;
      });
    this.pump();
  }

  private pump(): void {
    if (!this.spec) return;
    for (let index = 0; index < this.workers.length; index += 1) {
      if (this.busy[index]) continue;
      const next = this.queue.shift();
      if (!next) return;
      const box = tileBox(next.level, next.tx, next.ty);
      this.busy[index] = true;
      this.flying.set(next.key, this.version);
      const request: WorkerRequest = {
        type: 'tile',
        key: next.key,
        version: this.version,
        x0: box.x0,
        y0: box.y0,
        pixel: levelPixel(next.level),
        size: TILE,
      };
      this.workers[index]!.postMessage(request);
    }
  }

  private receive(index: number, reply: WorkerReply): void {
    this.busy[index] = false;
    if (this.flying.get(reply.key) === reply.version) this.flying.delete(reply.key);
    const [level, tx, ty] = reply.key.split('/').map(Number) as [number, number, number];
    const canvas = document.createElement('canvas');
    canvas.width = reply.size;
    canvas.height = reply.size;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(reply.pixels), reply.size, reply.size), 0, 0);
    const existing = this.cache.get(reply.key);
    // An older drawing never replaces a newer one.
    if (!existing || existing.version <= reply.version) {
      this.cache.delete(reply.key);
      this.cache.set(reply.key, { canvas, version: reply.version, box: tileBox(level, tx, ty) });
    }
    // Least recently drawn go first once there are too many to keep.
    while (this.cache.size > 320) this.cache.delete(this.cache.keys().next().value!);
    this.onTile();
    this.pump();
  }

  /** How many tiles are still to come — for a "drawing…" note. */
  get outstanding(): number {
    return this.queue.length + this.busy.filter(Boolean).length;
  }
}
