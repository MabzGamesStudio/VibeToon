import type { Bitmap } from './cutout';
import { colorDistance, fromHex, toHex, type Rgb } from './palette';

/**
 * Filtering an image against a palette.
 *
 * Three different jobs wear the same hat, so they are three modes rather than
 * three flows: keeping only what is on-palette, removing what is, and snapping
 * everything to the nearest palette entry. The first two answer "where is this
 * colour in my picture", the third is what makes a photograph look drawn.
 */
export type FilterMode = 'keep' | 'remove' | 'snap';

export const FILTER_MODES: readonly FilterMode[] = ['keep', 'remove', 'snap'];

export const FILTER_MODE_LABEL: Record<FilterMode, string> = {
  keep: 'Keep only palette colours',
  remove: 'Remove palette colours',
  snap: 'Snap every pixel to the palette',
};

export const FILTER_MODE_HINT: Record<FilterMode, string> = {
  keep: 'A pixel within the tolerance of some palette colour stays; everything else goes transparent.',
  remove: 'The other way round: a pixel near a palette colour goes transparent. For dropping a background you sampled.',
  snap: 'Nothing goes transparent. Every pixel is replaced by the palette colour nearest to it.',
};

export interface PaletteFilterOptions {
  mode: FilterMode;
  /**
   * How close a pixel must be to a palette colour to count as that colour, in
   * the same OKLab-times-100 units the palette's own minimum distance uses.
   * Ignored by `snap`, which has no threshold — every pixel has a nearest.
   */
  tolerance: number;
  /**
   * Soften the decision at the boundary. Within `softness` of the threshold a
   * pixel is partly transparent rather than wholly in or out, which stops a
   * filtered photograph looking like it was cut with scissors.
   */
  softness: number;
  /** Keep only these palette entries, by hex. Empty means all of them. */
  only: string[];
  /**
   * Snap the alpha channel too, so a soft edge becomes a hard one. What you want
   * when the result is going to be indexed colour or a sprite.
   */
  hardAlpha: boolean;
}

export const DEFAULT_PALETTE_FILTER_OPTIONS: PaletteFilterOptions = {
  mode: 'keep',
  tolerance: 18,
  softness: 4,
  only: [],
  hardAlpha: false,
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

/** A palette as this flow needs it: just the colours, in order. */
export interface FilterPalette {
  colors: Rgb[];
  hexes: string[];
}

/**
 * Read a palette out of what the Colour Palette flow wrote. Tolerant of shape
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

/** The palette entry closest to a colour, and how far away it is. */
export function nearestEntry(color: Rgb, palette: FilterPalette): Nearest | null {
  if (palette.colors.length === 0) return null;
  let index = 0;
  let distance = Infinity;
  for (let candidate = 0; candidate < palette.colors.length; candidate += 1) {
    const measured = colorDistance(color, palette.colors[candidate]!);
    if (measured < distance) {
      distance = measured;
      index = candidate;
    }
  }
  return { index, distance };
}

export interface FilterReport {
  /** Pixels that were opaque enough to be considered at all. */
  considered: number;
  /** Pixels left with any opacity. */
  kept: number;
  /** Pixels made fully transparent. */
  dropped: number;
  /** Pixels whose colour was changed, which only `snap` does. */
  recoloured: number;
  /** How many pixels landed on each palette entry, by hex. */
  perEntry: Array<{ hex: string; pixels: number }>;
  problems: string[];
}

/**
 * Run the filter.
 *
 * A pixel that is already transparent is left alone in every mode: this flow
 * takes the cutout flow's output as its input, and re-deciding pixels that were
 * deliberately cut away would undo that work.
 */
export function filterImage(
  image: Bitmap,
  palette: FilterPalette,
  options: PaletteFilterOptions,
): { pixels: Uint8ClampedArray; report: FilterReport } {
  const active = activePalette(palette, options);
  const out = new Uint8ClampedArray(image.data.length);
  const report: FilterReport = {
    considered: 0,
    kept: 0,
    dropped: 0,
    recoloured: 0,
    perEntry: active.hexes.map((hex) => ({ hex, pixels: 0 })),
    problems: [],
  };

  if (active.colors.length === 0) {
    report.problems.push(
      palette.hexes.length === 0
        ? 'The palette has no colours in it.'
        : 'Every palette colour is switched off, so there is nothing to match against.',
    );
    // Returning the image untouched rather than a blank one: a filter with
    // nothing to filter by has no opinion, and a black rectangle looks like a bug.
    out.set(image.data);
    return { pixels: out, report };
  }

  // A cache pays for itself many times over: a drawing uses a few thousand
  // distinct colours across a million pixels, and each lookup is a walk over the
  // whole palette in OKLab.
  const cache = new Map<number, { index: number; distance: number }>();

  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3]!;
    out[index] = image.data[index]!;
    out[index + 1] = image.data[index + 1]!;
    out[index + 2] = image.data[index + 2]!;

    if (alpha === 0) {
      out[index + 3] = 0;
      continue;
    }
    report.considered += 1;

    const r = image.data[index]!;
    const g = image.data[index + 1]!;
    const b = image.data[index + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let near = cache.get(key);
    if (!near) {
      near = nearestEntry({ r, g, b }, active)!;
      cache.set(key, near);
    }

    if (options.mode === 'snap') {
      const target = active.colors[near.index]!;
      if (target.r !== r || target.g !== g || target.b !== b) report.recoloured += 1;
      out[index] = target.r;
      out[index + 1] = target.g;
      out[index + 2] = target.b;
      out[index + 3] = alpha;
      report.kept += 1;
      report.perEntry[near.index]!.pixels += 1;
      continue;
    }

    const onPalette = weigh(near.distance, options.tolerance, options.softness);
    const weight = options.mode === 'keep' ? onPalette : 1 - onPalette;
    const next = options.hardAlpha ? (weight >= 0.5 ? alpha : 0) : alpha * weight;
    out[index + 3] = next;
    if (next > 0) {
      report.kept += 1;
      if (options.mode === 'keep') report.perEntry[near.index]!.pixels += 1;
    } else {
      report.dropped += 1;
    }
  }

  if (report.considered > 0 && report.kept === 0) {
    report.problems.push(
      options.mode === 'keep'
        ? 'Nothing matched. Raise the tolerance, or check the palette came from this image.'
        : 'Everything matched, so everything was removed. Lower the tolerance.',
    );
  }
  return { pixels: out, report };
}

/**
 * 1 well inside the tolerance, 0 well outside, and a ramp between. With softness
 * 0 it is a step, which is what you want for flat art and wrong for a photograph.
 */
export function weigh(distance: number, tolerance: number, softness: number): number {
  if (softness <= 0) return distance <= tolerance ? 1 : 0;
  if (distance <= tolerance - softness) return 1;
  if (distance >= tolerance + softness) return 0;
  return (tolerance + softness - distance) / (2 * softness);
}

export function summariseFilter(report: FilterReport, options: PaletteFilterOptions): string {
  if (report.considered === 0) return 'Nothing to filter — every pixel is already transparent.';
  const share = (count: number) => `${((count / report.considered) * 100).toFixed(1)}%`;
  if (options.mode === 'snap') {
    return `${share(report.recoloured)} of the image was recoloured; nothing was made transparent.`;
  }
  return `${share(report.kept)} kept, ${share(report.dropped)} made transparent.`;
}
