import type { Bitmap } from './cutout';
import { fromHex, swatchDistance, swatchOf, toHex, type Rgb, type Rgba, type Swatch } from './palette';

/**
 * Filtering an image against a palette.
 *
 * Two jobs wear the same hat, so they are two modes rather than two flows. Both
 * are exact about what they write, because exactness is what they are for.
 *
 * **Keeping** answers "where is this color in my picture". Every pixel comes out
 * as one of two things: the source pixel exactly as it was, color and opacity,
 * if it is within the tolerance of a palette color — or fully transparent,
 * `(0, 0, 0, 0)`, if it is not (or if it was transparent to begin with, whatever
 * color numbers it carried). Nothing is recolored and nothing is faded: the
 * palette is the question, and the picture is the answer.
 *
 * **Snapping** answers "make this picture use only these colors". Every pixel
 * becomes exactly one palette entry — its color *and* its opacity, whichever
 * entry is nearest — so a palette of five colors and a transparent one gives a
 * picture with six RGBA values in it and no others. A transparent pixel snaps
 * like any other, to the entry that looks most like nothing: the palette's clear
 * entry, when it has one.
 *
 * Nearness counts opacity as well as color (see `swatchDistance`): an edge pixel
 * of red is nearest red, and becomes red or clear depending on which side of half
 * opacity it is — never a neighbouring color — and a clear pixel is nowhere near
 * black, whatever color numbers it happens to carry.
 *
 * There used to be a third, which removed the palette's colors instead of
 * keeping them. It is gone. It was the keep mode with the answer inverted, and
 * an inverted answer is a thing you can get by picking the other colors — while
 * having it as a mode meant every setting and every report had to say which way
 * round it was reading.
 */
export type FilterMode = 'keep' | 'snap';

export const FILTER_MODES: readonly FilterMode[] = ['keep', 'snap'];

export const FILTER_MODE_LABEL: Record<FilterMode, string> = {
  keep: 'Keep only palette colors',
  snap: 'Snap every pixel to the palette',
};

export const FILTER_MODE_HINT: Record<FilterMode, string> = {
  keep: 'A pixel within the tolerance of a palette color is kept exactly as it is, color and opacity. Every other pixel becomes fully transparent.',
  snap: 'Every pixel becomes exactly one of the palette colors, opacity included — whichever is nearest. Six colors in play means six values in the result, and no others.',
};

export interface PaletteFilterOptions {
  mode: FilterMode;
  /**
   * How far a pixel may be from a palette color and still count as it, in the
   * same OKLab-times-100 units the palette's own minimum distance uses, opacity
   * included.
   *
   * 0 means exactly — the same color at the same opacity — which is what flat
   * artwork wants: a drawing made from a palette contains those colors and no
   * others. Anything photographic needs room: the same red is a hundred slightly
   * different reds once it has been through a camera and a JPEG.
   *
   * `snap` ignores it, because every pixel has a nearest whatever the distance.
   */
  tolerance: number;
  /** Keep only these palette entries, by hex. Empty means all of them. */
  only: string[];
  /**
   * The smallest a chunk of one palette color may be after snapping, in pixels.
   *
   * A chunk is the pixels of one color that touch, corners included. One smaller
   * than this — a stray dot, a speck of noise, a fleck of the wrong color along
   * an edge — takes the color of a chunk it touches instead: whichever of those
   * neighbouring colors is closest to what its own pixels were. The transparent
   * entry counts like any other, so a pinhole in a shape closes and a speck in
   * empty space goes. 0 or 1 leaves every pixel as it snapped. `keep` ignores it.
   */
  minChunk: number;
}

export const DEFAULT_PALETTE_FILTER_OPTIONS: PaletteFilterOptions = {
  mode: 'keep',
  tolerance: 8,
  only: [],
  minChunk: 0,
};

export interface PaletteFilterFlowData {
  editor: 'paletteFilter';
  options: PaletteFilterOptions;
  /** The hash of the image the preview was last computed against. */
  imageHash?: string;
  /** The hash of the palette, so a changed palette shows as stale too. */
  paletteHash?: string;
}

export function emptyPaletteFilterFlowData(): PaletteFilterFlowData {
  return { editor: 'paletteFilter', options: { ...DEFAULT_PALETTE_FILTER_OPTIONS } };
}

/** A palette as this flow needs it: the colors and their opacity, in order. */
export interface FilterPalette {
  colors: Rgba[];
  hexes: string[];
}

/**
 * Read a palette out of what the Color Palette flow wrote. Tolerant of shape
 * because a palette may also be hand-written or come from another tool: an array
 * of hex strings, an array of objects with a `hex`, or the flow's own file.
 */
export function readPalette(json: unknown): FilterPalette {
  const hexes: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string') {
      const rgb = fromHex(value);
      if (rgb) hexes.push(toHex(rgb));
      return;
    }
    if (value && typeof value === 'object' && 'hex' in value) {
      const rgb = fromHex(String((value as { hex: unknown }).hex));
      if (rgb) hexes.push(toHex(rgb));
    }
  };

  if (Array.isArray(json)) {
    for (const entry of json) push(entry);
  } else if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    const list = record.entries ?? record.colors ?? record.palette;
    if (Array.isArray(list)) for (const entry of list) push(entry);
  }

  const unique = [...new Set(hexes)];
  return { hexes: unique, colors: unique.map((hex) => fromHex(hex)!) };
}

/** The entries actually in play, after `only`. */
export function activePalette(palette: FilterPalette, options: PaletteFilterOptions): FilterPalette {
  if (options.only.length === 0) return palette;
  const wanted = new Set(options.only.map((hex) => hex.toLowerCase()));
  const hexes = palette.hexes.filter((hex) => wanted.has(hex.toLowerCase()));
  return { hexes, colors: hexes.map((hex) => fromHex(hex)!) };
}

export interface Nearest {
  index: number;
  distance: number;
}

function nearestSwatch(swatch: Swatch, swatches: readonly Swatch[]): Nearest {
  let index = 0;
  let distance = Infinity;
  for (let candidate = 0; candidate < swatches.length; candidate += 1) {
    const measured = swatchDistance(swatch, swatches[candidate]!);
    if (measured < distance) {
      distance = measured;
      index = candidate;
    }
  }
  return { index, distance };
}

/** The palette entry closest to a color, opacity included, and how far away it is. */
export function nearestEntry(color: Rgb & { a?: number }, palette: FilterPalette): Nearest | null {
  if (palette.colors.length === 0) return null;
  return nearestSwatch(swatchOf(color), palette.colors.map(swatchOf));
}

export interface FilterReport {
  /** Pixels with any opacity at all — the part of the picture you can see. */
  considered: number;
  /**
   * Of those, the ones still visible afterwards: kept as they were by `keep`, or
   * given a visible palette color by `snap`.
   */
  kept: number;
  /** Of those, the ones made fully transparent. */
  dropped: number;
  /** Visible pixels that now look different, which only `snap` does. */
  recolored: number;
  /** Pixels that were fully transparent to begin with. */
  clearIn: number;
  /**
   * Transparent pixels that `snap` gave a visible color, because no clear entry
   * was in play to snap them to. Almost always a surprise, so it is reported.
   */
  filled: number;
  /** How many pixels landed on each palette entry, by hex. */
  perEntry: Array<{ hex: string; pixels: number }>;
  /** Chunks under the minimum chunk size that took a neighbour's color. */
  chunksMerged: number;
  /** The pixels in them. */
  chunkPixels: number;
  problems: string[];
}

/**
 * Run the filter.
 *
 * Nothing is multiplied, blended or rounded on the way: `snap` writes a palette
 * entry's four numbers, and `keep` writes the source pixel's four numbers or four
 * zeros. So the output can be checked by counting, which is how the tests check
 * it.
 */
export function filterImage(
  image: Bitmap,
  palette: FilterPalette,
  options: PaletteFilterOptions,
): { pixels: Uint8ClampedArray; report: FilterReport } {
  const active = activePalette(palette, options);
  // Zeros to start with, which is fully transparent — what `keep` leaves behind.
  const out = new Uint8ClampedArray(image.data.length);
  const report: FilterReport = {
    considered: 0,
    kept: 0,
    dropped: 0,
    recolored: 0,
    clearIn: 0,
    filled: 0,
    perEntry: active.hexes.map((hex) => ({ hex, pixels: 0 })),
    chunksMerged: 0,
    chunkPixels: 0,
    problems: [],
  };

  if (active.colors.length === 0) {
    report.problems.push(
      palette.hexes.length === 0
        ? 'The palette has no colors in it.'
        : 'Every palette color is switched off, so there is nothing to match against.',
    );
    // Returning the image untouched rather than a blank one: a filter with
    // nothing to filter by has no opinion, and a black rectangle looks like a bug.
    out.set(image.data);
    return { pixels: out, report };
  }

  const swatches = active.colors.map(swatchOf);
  const tolerance = Math.max(0, options.tolerance);
  /*
   * A cache pays for itself many times over: a drawing uses a few thousand
   * distinct values across a million pixels, and each lookup is a trip through
   * OKLab and a walk over every entry. Every fully transparent pixel is one key,
   * whatever color numbers it carries, because none of them show.
   */
  const cache = new Map<number, Nearest>();
  const clear = swatchOf({ r: 0, g: 0, b: 0, a: 0 });
  const keyOf = (index: number) => {
    const a = image.data[index + 3]!;
    return a === 0 ? -1 : ((image.data[index]! << 16) | (image.data[index + 1]! << 8) | image.data[index + 2]!) * 256 + a;
  };
  /** Which entry each pixel snapped to, for `snap`. */
  const assigned = options.mode === 'snap' ? new Int32Array(image.width * image.height) : null;

  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index]!;
    const g = image.data[index + 1]!;
    const b = image.data[index + 2]!;
    const a = image.data[index + 3]!;
    const key = a === 0 ? -1 : ((r << 16) | (g << 8) | b) * 256 + a;
    let near = cache.get(key);
    if (!near) {
      near = nearestSwatch(a === 0 ? clear : swatchOf({ r, g, b, a }), swatches);
      cache.set(key, near);
    }
    if (a === 0) report.clearIn += 1;
    else report.considered += 1;

    if (assigned) {
      assigned[index / 4] = near.index;
      continue;
    }

    if (near.distance <= tolerance) {
      // A pixel with no opacity is written as the one clear value, not with the
      // color numbers it happened to carry: they show nowhere, and leaving them
      // would fill the result with values that only look like one.
      if (a > 0) {
        out[index] = r;
        out[index + 1] = g;
        out[index + 2] = b;
        out[index + 3] = a;
        report.kept += 1;
      }
      report.perEntry[near.index]!.pixels += 1;
    } else if (a > 0) {
      report.dropped += 1;
    }
  }

  if (assigned) {
    if (options.minChunk > 1) {
      const merged = mergeSmallChunks(assigned, image.width, image.height, options.minChunk, (pixel, entry) => {
        const key = keyOf(pixel * 4);
        const source = key === -1 ? clear : swatchOf({ r: image.data[pixel * 4]!, g: image.data[pixel * 4 + 1]!, b: image.data[pixel * 4 + 2]!, a: image.data[pixel * 4 + 3]! });
        return swatchDistance(source, swatches[entry]!);
      });
      report.chunksMerged = merged.chunks;
      report.chunkPixels = merged.pixels;
    }
    for (let pixel = 0; pixel < assigned.length; pixel += 1) {
      const index = pixel * 4;
      const entry = assigned[pixel]!;
      const target = active.colors[entry]!;
      out[index] = target.r;
      out[index + 1] = target.g;
      out[index + 2] = target.b;
      out[index + 3] = target.a;
      report.perEntry[entry]!.pixels += 1;
      if (image.data[index + 3] === 0) {
        if (target.a > 0) report.filled += 1;
        continue;
      }
      if (target.a > 0) report.kept += 1;
      else report.dropped += 1;
      // Recolored unless it landed on a palette value it already exactly was.
      const near = cache.get(keyOf(index))!;
      if (near.distance > 1e-9 || near.index !== entry) report.recolored += 1;
    }
  }

  if (report.considered > 0 && report.kept === 0 && options.mode === 'keep') {
    report.problems.push(
      tolerance <= 0
        ? 'Nothing matched exactly. Raise the tolerance, or check the palette came from this image.'
        : 'Nothing matched. Raise the tolerance, or check the palette came from this image.',
    );
  }
  if (report.filled > 0) {
    report.problems.push(
      `${report.filled.toLocaleString()} transparent pixel(s) were given a color, because no transparent entry is in play to snap them to. Give the palette one — the Color Palette flow adds it for a picture with transparent pixels — or switch it back on.`,
    );
  }
  return { pixels: out, report };
}

/**
 * Give every chunk smaller than `min` the color of a chunk it touches.
 *
 * A chunk is the pixels of one entry that touch, corners included — so a line a
 * pixel wide drawn on the diagonal is one chunk, not a row of specks. Smallest
 * first, so a speck inside a speck is settled before the one around it is judged.
 * Of the entries the chunk touches, the one it takes is the one closest to what
 * its own pixels were (`cost`, summed over them): the next nearest color that is
 * actually there beside it, rather than whatever happens to surround it most.
 * Taking a neighbour's color joins the chunk to that neighbour, and to any other
 * chunk of that color it touched, so they grow together.
 *
 * A chunk with no neighbour of another color — the whole picture one color, say —
 * is left alone. `assigned` is changed in place.
 */
export function mergeSmallChunks(
  assigned: Int32Array,
  width: number,
  height: number,
  min: number,
  cost: (pixel: number, entry: number) => number,
): { chunks: number; pixels: number } {
  const count = width * height;
  const label = new Int32Array(count).fill(-1);
  const members: number[][] = [];
  const entryOf: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < count; start += 1) {
    if (label[start] !== -1) continue;
    const id = members.length;
    const entry = assigned[start]!;
    const pixels: number[] = [];
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop()!;
      pixels.push(at);
      const x = at % width;
      const y = (at - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (label[next] !== -1 || assigned[next] !== entry) continue;
          label[next] = id;
          stack.push(next);
        }
      }
    }
    members.push(pixels);
    entryOf.push(entry);
  }

  const parent = members.map((_, id) => id);
  const root = (id: number): number => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]!]!;
      id = parent[id]!;
    }
    return id;
  };

  let chunks = 0;
  let moved = 0;
  const small = members
    .map((pixels, id) => [pixels.length, id] as const)
    .filter(([size]) => size < min)
    .sort((one, two) => one[0] - two[0] || one[1] - two[1]);

  for (const [, id] of small) {
    if (root(id) !== id || members[id]!.length >= min) continue;
    const pixels = members[id]!;
    const entry = entryOf[id]!;

    // The chunks it touches, by entry, and how much border it shares with each.
    const touching = new Map<number, { roots: Set<number>; border: number }>();
    for (const at of pixels) {
      const x = at % width;
      const y = (at - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const other = root(label[ny * width + nx]!);
          if (other === id || entryOf[other] === entry) continue;
          const side = touching.get(entryOf[other]!) ?? { roots: new Set(), border: 0 };
          side.roots.add(other);
          side.border += 1;
          touching.set(entryOf[other]!, side);
        }
      }
    }
    if (touching.size === 0) continue;

    let best = -1;
    let bestCost = Infinity;
    let bestBorder = -1;
    for (const [candidate, side] of touching) {
      let total = 0;
      for (const at of pixels) total += cost(at, candidate);
      if (total < bestCost - 1e-9 || (Math.abs(total - bestCost) <= 1e-9 && side.border > bestBorder)) {
        best = candidate;
        bestCost = total;
        bestBorder = side.border;
      }
    }

    // Join it, and every chunk of that color it touched, into the biggest of them.
    const roots = [...touching.get(best)!.roots];
    const into = roots.reduce((big, other) => (members[other]!.length > members[big]!.length ? other : big));
    for (const at of pixels) assigned[at] = best;
    for (const other of [id, ...roots]) {
      if (other === into) continue;
      parent[other] = into;
      members[into] = members[into]!.concat(members[other]!);
      members[other] = [];
    }
    chunks += 1;
    moved += pixels.length;
  }
  return { chunks, pixels: moved };
}

export function summariseFilter(report: FilterReport, options: PaletteFilterOptions): string {
  if (report.considered === 0 && report.clearIn === 0) return 'Nothing to filter — the picture is empty.';
  if (report.considered === 0 && options.mode === 'keep') {
    return 'Nothing to filter — every pixel is already transparent.';
  }
  const share = (count: number) => `${((count / Math.max(1, report.considered)) * 100).toFixed(1)}%`;
  if (options.mode === 'snap') {
    const used = report.perEntry.filter((entry) => entry.pixels > 0).length;
    const parts = [
      `Every pixel is one of ${used} palette value(s)`,
      `${share(report.recolored)} of what shows was recolored`,
    ];
    if (report.dropped > 0) parts.push(`${share(report.dropped)} snapped to transparent`);
    if (report.filled > 0) parts.push(`${report.filled.toLocaleString()} transparent pixel(s) given a color`);
    if (report.chunksMerged > 0) {
      parts.push(`${report.chunksMerged.toLocaleString()} small chunk(s) (${report.chunkPixels.toLocaleString()} px) given a neighbour's color`);
    }
    return `${parts.join(', ')}.`;
  }
  return `${share(report.kept)} kept exactly as it was, ${share(report.dropped)} made transparent.`;
}
