import { colorDistance, type Rgb } from './palette';

/**
 * Cutting a subject out of an image.
 *
 * The rule the whole flow follows: **the mask is derived, never painted.** What
 * is stored is a list of things you did — seeds you dropped, lines you cut — and
 * the mask is recomputed from that list every time. So a seed is a real object
 * that can be selected and deleted, and deleting it takes its region with it.
 *
 * Painting into a bitmap would be simpler and would make every action
 * permanent: twenty clicks in, the only way to undo the third is to start
 * again. That is the tool people give up on, so it is not this one.
 */

/** A click that includes a region, or one that takes a region back out. */
export type SeedMode = 'include' | 'exclude';

export interface Seed {
  id: string;
  mode: SeedMode;
  /** In image pixels, so a seed survives zooming and resizing the editor. */
  x: number;
  y: number;
  /**
   * How different a neighbouring pixel may be and still be the same region,
   * measured in OKLab distance. Per seed, because the edge of a face and the
   * edge of a sky need different answers.
   */
  tolerance: number;
  /** Off when the seed is kept but not applied, for trying without deleting. */
  muted?: boolean;
}

/** A line that cuts the outline, whatever the pixels underneath say. */
export interface CutLine {
  id: string;
  /** Flat `x, y, x, y…` in image pixels. Two points is a straight line. */
  points: number[];
  /** Smooth through the points rather than joining them with corners. */
  curved: boolean;
  /**
   * How wide the cut is, in pixels. A cut is a barrier a fill cannot cross, and
   * a one-pixel barrier leaks through diagonal gaps, so this is at least 1.
   */
  width: number;
  /**
   * A cut normally only blocks the fill. `erase` also clears what it covers, for
   * slicing a limb off something already included.
   */
  mode: 'block' | 'erase';
  muted?: boolean;
}

export type CutObject = (Seed & { type: 'seed' }) | (CutLine & { type: 'line' });

export interface CutoutOptions {
  /**
   * Default tolerance for a new seed. The one number people actually turn, so
   * it is on the toolbar rather than buried per object.
   */
  tolerance: number;
  /**
   * Grow or shrink the mask's edge, in pixels. A fill on a photograph stops a
   * pixel or two short of the true edge because the edge is blended; growing by
   * one takes the halo back.
   */
  grow: number;
  /** Soften the edge by this many pixels, so a cutout does not look cut out. */
  feather: number;
  /** Treat diagonal neighbours as connected. Off keeps thin gaps as barriers. */
  diagonal: boolean;
  /**
   * Drop included islands smaller than this many pixels. A fill on a noisy
   * photograph finds hundreds of one-pixel specks; nobody wants those.
   */
  minIsland: number;
}

export const DEFAULT_CUTOUT_OPTIONS: CutoutOptions = {
  tolerance: 12,
  grow: 0,
  feather: 0,
  diagonal: false,
  minIsland: 0,
};

export interface CutoutFlowData {
  editor: 'cutout';
  options: CutoutOptions;
  seeds: Seed[];
  lines: CutLine[];
  /** Ids of whatever is selected, so Delete knows what to remove. */
  selected: string[];
  /** The hash of the image the objects were placed against. */
  imageHash?: string;
  /** Size of that image, so a stored seed can be checked against it. */
  imageWidth?: number;
  imageHeight?: number;
}

export function emptyCutoutFlowData(): CutoutFlowData {
  return {
    editor: 'cutout',
    options: { ...DEFAULT_CUTOUT_OPTIONS },
    seeds: [],
    lines: [],
    selected: [],
  };
}

/* ---------------- the objects ---------------- */

export function objectsOf(data: CutoutFlowData): CutObject[] {
  return [
    ...data.seeds.map((seed) => ({ ...seed, type: 'seed' as const })),
    ...data.lines.map((line) => ({ ...line, type: 'line' as const })),
  ];
}

export function findObject(data: CutoutFlowData, id: string): CutObject | undefined {
  return objectsOf(data).find((object) => object.id === id);
}

/** Remove whatever is selected. The mask is recomputed, so regions go with them. */
export function deleteSelected(data: CutoutFlowData): CutoutFlowData {
  const gone = new Set(data.selected);
  if (gone.size === 0) return data;
  return {
    ...data,
    seeds: data.seeds.filter((seed) => !gone.has(seed.id)),
    lines: data.lines.filter((line) => !gone.has(line.id)),
    selected: [],
  };
}

export function deleteObject(data: CutoutFlowData, id: string): CutoutFlowData {
  return {
    ...data,
    seeds: data.seeds.filter((seed) => seed.id !== id),
    lines: data.lines.filter((line) => line.id !== id),
    selected: data.selected.filter((candidate) => candidate !== id),
  };
}

/** Click to select, shift-click to add. */
export function selectObject(data: CutoutFlowData, id: string, add = false): CutoutFlowData {
  if (!add) return { ...data, selected: [id] };
  return {
    ...data,
    selected: data.selected.includes(id)
      ? data.selected.filter((candidate) => candidate !== id)
      : [...data.selected, id],
  };
}

export function setSeed(data: CutoutFlowData, id: string, over: Partial<Seed>): CutoutFlowData {
  return { ...data, seeds: data.seeds.map((seed) => (seed.id === id ? { ...seed, ...over } : seed)) };
}

export function setLine(data: CutoutFlowData, id: string, over: Partial<CutLine>): CutoutFlowData {
  return { ...data, lines: data.lines.map((line) => (line.id === id ? { ...line, ...over } : line)) };
}

/** Ordinal names, so the object list reads as "Include 2" rather than an id. */
export function labelOf(data: CutoutFlowData, object: CutObject): string {
  if (object.type === 'seed') {
    const peers = data.seeds.filter((seed) => seed.mode === object.mode);
    const index = peers.findIndex((seed) => seed.id === object.id) + 1;
    return `${object.mode === 'include' ? 'Include' : 'Exclude'} ${index}`;
  }
  const index = data.lines.findIndex((line) => line.id === object.id) + 1;
  return `${object.mode === 'erase' ? 'Erase' : 'Cut'} ${index}`;
}

/* ---------------- geometry ---------------- */

/**
 * Points along a line, ready to walk. A curved line is smoothed through its
 * points with a centripetal Catmull-Rom spline, which passes through every point
 * it is given — a Bézier would pull away from them, and a line you drew that
 * does not go where you put it is not a tool you can aim.
 */
export function linePoints(line: CutLine, samplesPerSegment = 12): Array<{ x: number; y: number }> {
  const raw: Array<{ x: number; y: number }> = [];
  for (let index = 0; index + 1 < line.points.length; index += 2) {
    raw.push({ x: line.points[index]!, y: line.points[index + 1]! });
  }
  if (raw.length < 2 || !line.curved) return raw;

  const out: Array<{ x: number; y: number }> = [raw[0]!];
  for (let index = 0; index + 1 < raw.length; index += 1) {
    const p0 = raw[index - 1] ?? raw[index]!;
    const p1 = raw[index]!;
    const p2 = raw[index + 1]!;
    const p3 = raw[index + 2] ?? p2;
    for (let step = 1; step <= samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment;
      out.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  return out;
}

function catmullRom(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  const at = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) };
}

/* ---------------- the mask ---------------- */

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, four bytes a pixel, exactly as a canvas hands it over. */
  data: Uint8ClampedArray;
}

/** 0 outside, 255 inside, in between only where the edge was feathered. */
export interface Mask {
  width: number;
  height: number;
  alpha: Uint8ClampedArray;
}

function pixelAt(image: Bitmap, index: number): Rgb {
  const at = index * 4;
  return { r: image.data[at]!, g: image.data[at + 1]!, b: image.data[at + 2]! };
}

/**
 * Paint the cut lines into a barrier map. A fill may not cross one, which is what
 * makes a line able to separate two regions the pixels think are the same — the
 * shadow under an arm joining it to the body is the everyday case.
 */
export function blockedBy(lines: CutLine[], width: number, height: number): Uint8Array {
  const blocked = new Uint8Array(width * height);
  for (const line of lines) {
    if (line.muted) continue;
    const points = linePoints(line);
    const radius = Math.max(0.5, line.width / 2);
    for (let index = 0; index + 1 < points.length; index += 1) {
      stampSegment(blocked, width, height, points[index]!, points[index + 1]!, radius);
    }
    // A single point still marks its own spot, so a one-click cut is not silent.
    if (points.length === 1) stampDisc(blocked, width, height, points[0]!.x, points[0]!.y, radius);
  }
  return blocked;
}

function stampSegment(
  target: Uint8Array,
  width: number,
  height: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
): void {
  const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  const steps = Math.max(1, Math.ceil(span));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    stampDisc(target, width, height, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius);
  }
}

function stampDisc(
  target: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
): void {
  const from = Math.floor(-radius);
  const to = Math.ceil(radius);
  for (let dy = from; dy <= to; dy += 1) {
    for (let dx = from; dx <= to; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      target[y * width + x] = 1;
    }
  }
}

/**
 * Flood out from one seed, taking every neighbour within `tolerance` of the seed
 * pixel's colour and stopping at a cut line.
 *
 * Tolerance is measured against the **seed colour**, not against each pixel's
 * neighbour. Comparing neighbour to neighbour lets a gradient walk the whole
 * image one indistinguishable step at a time, which is the classic way a magic
 * wand "selects everything" and the reason people stop trusting one.
 */
export function floodFrom(
  image: Bitmap,
  seed: { x: number; y: number; tolerance: number },
  blocked: Uint8Array,
  diagonal: boolean,
  into?: Uint8Array,
): Uint8Array {
  const { width, height } = image;
  const filled = into ?? new Uint8Array(width * height);
  const x0 = Math.round(seed.x);
  const y0 = Math.round(seed.y);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return filled;

  const start = y0 * width + x0;
  if (blocked[start]) return filled;

  const target = pixelAt(image, start);
  const seen = new Uint8Array(width * height);
  // An explicit stack rather than recursion: a region can be a million pixels,
  // and a recursive fill overflows the stack on a photograph.
  const stack: number[] = [start];
  seen[start] = 1;

  while (stack.length > 0) {
    const index = stack.pop()!;
    if (blocked[index]) continue;
    if (colorDistance(pixelAt(image, index), target) > seed.tolerance) continue;
    filled[index] = 1;

    const x = index % width;
    const y = (index - x) / width;
    const push = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const next = ny * width + nx;
      if (seen[next]) return;
      seen[next] = 1;
      stack.push(next);
    };
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
    if (diagonal) {
      push(x + 1, y + 1);
      push(x - 1, y + 1);
      push(x + 1, y - 1);
      push(x - 1, y - 1);
    }
  }
  return filled;
}

export interface MaskReport {
  /** Pixels in the finished mask. */
  inside: number;
  /** What each seed contributed, in the order they were applied. */
  seeds: Array<{ id: string; mode: SeedMode; pixels: number; label: string }>;
  /** Islands dropped for being smaller than `minIsland`. */
  islandsDropped: number;
  problems: string[];
}

/**
 * Build the mask from the object list.
 *
 * Order matters and is the order the objects were made in: an exclude after an
 * include takes a bite out of it, and an include after that puts some back. That
 * is what clicking feels like, so it is what the list means.
 */
export function buildMask(
  image: Bitmap,
  data: CutoutFlowData,
): { mask: Mask; report: MaskReport } {
  const { width, height } = image;
  const size = width * height;
  const inside = new Uint8Array(size);
  const blocked = blockedBy(data.lines, width, height);
  const report: MaskReport = { inside: 0, seeds: [], islandsDropped: 0, problems: [] };

  const scratch = new Uint8Array(size);
  for (const seed of data.seeds) {
    if (seed.muted) continue;
    if (seed.x < 0 || seed.y < 0 || seed.x >= width || seed.y >= height) {
      report.problems.push(`${labelOf(data, { ...seed, type: 'seed' })} is outside the image.`);
      continue;
    }
    scratch.fill(0);
    floodFrom(image, seed, blocked, data.options.diagonal, scratch);
    let pixels = 0;
    for (let index = 0; index < size; index += 1) {
      if (!scratch[index]) continue;
      pixels += 1;
      inside[index] = seed.mode === 'include' ? 1 : 0;
    }
    report.seeds.push({
      id: seed.id,
      mode: seed.mode,
      pixels,
      label: labelOf(data, { ...seed, type: 'seed' }),
    });
    if (pixels === 0) {
      report.problems.push(
        `${labelOf(data, { ...seed, type: 'seed' })} caught nothing — it is on a cut line, or its tolerance is 0.`,
      );
    }
  }

  // An erase line cuts through whatever it covers, after every fill has run.
  for (const line of data.lines) {
    if (line.muted || line.mode !== 'erase') continue;
    const cut = blockedBy([line], width, height);
    for (let index = 0; index < size; index += 1) if (cut[index]) inside[index] = 0;
  }

  if (data.options.minIsland > 0) {
    report.islandsDropped = dropIslands(inside, width, height, data.options.minIsland, data.options.diagonal);
  }

  const grown = data.options.grow === 0 ? inside : grow(inside, width, height, data.options.grow);
  for (let index = 0; index < size; index += 1) if (grown[index]) report.inside += 1;

  const alpha = new Uint8ClampedArray(size);
  for (let index = 0; index < size; index += 1) alpha[index] = grown[index] ? 255 : 0;
  const mask: Mask =
    data.options.feather > 0
      ? { width, height, alpha: feather(alpha, width, height, data.options.feather) }
      : { width, height, alpha };

  if (report.inside === 0 && data.seeds.length > 0) {
    report.problems.push('Nothing is included. Every fill was either empty or excluded again.');
  }
  return { mask, report };
}

/** Remove included blobs below `minPixels`, and say how many went. */
function dropIslands(
  inside: Uint8Array,
  width: number,
  height: number,
  minPixels: number,
  diagonal: boolean,
): number {
  const size = width * height;
  const seen = new Uint8Array(size);
  let dropped = 0;
  for (let start = 0; start < size; start += 1) {
    if (!inside[start] || seen[start]) continue;
    const blob: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      blob.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const push = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const next = ny * width + nx;
        if (seen[next] || !inside[next]) return;
        seen[next] = 1;
        stack.push(next);
      };
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
      if (diagonal) {
        push(x + 1, y + 1);
        push(x - 1, y + 1);
        push(x + 1, y - 1);
        push(x - 1, y - 1);
      }
    }
    if (blob.length < minPixels) {
      for (const index of blob) inside[index] = 0;
      dropped += 1;
    }
  }
  return dropped;
}

/** Grow (positive) or shrink (negative) the mask by a number of pixels. */
export function grow(inside: Uint8Array, width: number, height: number, by: number): Uint8Array {
  let current = inside;
  const rounds = Math.min(64, Math.abs(Math.round(by)));
  const outward = by > 0;
  for (let round = 0; round < rounds; round += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const self = current[index] === 1;
        // Growing: a pixel joins if any neighbour is in. Shrinking: it leaves if
        // any neighbour is out — including past the border, so the edge of the
        // image erodes like any other edge.
        let neighbour = false;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          const off = nx < 0 || ny < 0 || nx >= width || ny >= height;
          const value = off ? 0 : current[ny * width + nx]!;
          if (outward ? value === 1 : value === 0) {
            neighbour = true;
            break;
          }
        }
        next[index] = outward ? (self || neighbour ? 1 : 0) : self && !neighbour ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

/**
 * Blur the mask's edge. A box blur run three times, which is close enough to a
 * Gaussian for an alpha channel and far cheaper — this runs on every change.
 */
export function feather(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const r = Math.min(32, Math.max(1, Math.round(radius)));
  let current = alpha;
  for (let pass = 0; pass < 3; pass += 1) {
    current = boxBlur(current, width, height, r);
  }
  return current;
}

function boxBlur(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const horizontal = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        total += source[y * width + nx]!;
        count += 1;
      }
      horizontal[y * width + x] = total / count;
    }
  }
  const out = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        total += horizontal[ny * width + x]!;
        count += 1;
      }
      out[y * width + x] = total / count;
    }
  }
  return out;
}

/** Apply a mask to an image, giving RGBA with everything outside transparent. */
export function applyMask(image: Bitmap, mask: Mask): Uint8ClampedArray {
  const out = new Uint8ClampedArray(image.data.length);
  for (let index = 0; index < mask.alpha.length; index += 1) {
    const at = index * 4;
    const alpha = mask.alpha[index]!;
    out[at] = image.data[at]!;
    out[at + 1] = image.data[at + 1]!;
    out[at + 2] = image.data[at + 2]!;
    // Multiplied by the source alpha, so cutting out of an already-transparent
    // image cannot make a pixel more opaque than it started.
    out[at + 3] = (alpha * image.data[at + 3]!) / 255;
  }
  return out;
}

/** The tight box around what is included, for trimming the written file. */
export function maskBounds(mask: Mask): { x: number; y: number; width: number; height: number } | null {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.alpha[y * mask.width + x]! === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function summariseCutout(data: CutoutFlowData, report: MaskReport | null): string {
  const includes = data.seeds.filter((seed) => seed.mode === 'include' && !seed.muted).length;
  const excludes = data.seeds.filter((seed) => seed.mode === 'exclude' && !seed.muted).length;
  const cuts = data.lines.filter((line) => !line.muted).length;
  const parts = [
    `${includes} include${includes === 1 ? '' : 's'}`,
    `${excludes} exclude${excludes === 1 ? '' : 's'}`,
    `${cuts} cut${cuts === 1 ? '' : 's'}`,
  ];
  if (report && data.imageWidth && data.imageHeight) {
    const share = (report.inside / (data.imageWidth * data.imageHeight)) * 100;
    parts.push(`${share.toFixed(1)}% of the image kept`);
  }
  return parts.join(' · ');
}
