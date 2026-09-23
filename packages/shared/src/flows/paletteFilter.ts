import type { Bitmap } from './cutout';
import { colorDistance, fromHex, toHex, type Rgb, type Rgba } from './palette';

/**
 * Filtering an image against a palette.
 *
 * Two jobs wear the same hat, so they are two modes rather than two flows.
 *
 * **Keeping** answers "where is this color in my picture". A pixel that matches
 * a palette entry stays exactly as it was — the same color it always had, the
 * same opacity — and everything else goes transparent. It does not recolor
 * anything: the palette is the question, and the picture is the answer.
 *
 * **Snapping** answers "make this picture use only these colors". Every pixel
 * becomes the palette entry it is nearest, including that entry's opacity, so a
 * palette with a see-through color can fade part of a picture by naming it.
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
  keep: 'A pixel that matches a palette color is kept exactly as it is; everything else goes transparent.',
  snap: 'Nothing goes transparent for not matching. Every pixel becomes the palette color nearest to it, opacity and all.',
};

export interface PaletteFilterOptions {
  mode: FilterMode;
  /**
   * How far a pixel may be from a palette color and still count as it, in the
   * same OKLab-times-100 units the palette's own minimum distance uses.
   *
   * 0 means exactly, which is what flat artwork wants — a drawing made from a
   * palette contains those colors and no others. Anything photographic needs
   * room: the same red is a hundred slightly different reds once it has been
   * through a camera and a JPEG.
   *
   * `snap` ignores it, because every pixel has a nearest whatever the distance.
   */
  tolerance: number;
  /** Keep only these palette entries, by hex. Empty means all of them. */
  only: string[];
}

export const DEFAULT_PALETTE_FILTER_OPTIONS: PaletteFilterOptions = {
  mode: 'keep',
  tolerance: 8,
  only: [],
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

/** The palette entry closest to a color, and how far away it is. */
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
  /** Pixels whose color was changed, which only `snap` does. */
  recolored: number;
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
    recolored: 0,
    perEntry: active.hexes.map((hex) => ({ hex, pixels: 0 })),
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

  // A cache pays for itself many times over: a drawing uses a few thousand
  // distinct colors across a million pixels, and each lookup is a walk over the
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
      /*
       * The entry's opacity as well as its color.
       *
       * Which is the whole of what an opacity in a palette is for: naming a
       * see-through color and snapping to it is how you fade part of a picture
       * by saying which part. Multiplied by what the pixel already had, so a
       * half-faded edge snapped to a half-faded color does not come back solid.
       */
      const target = active.colors[near.index]!;
      if (target.r !== r || target.g !== g || target.b !== b) report.recolored += 1;
      out[index] = target.r;
      out[index + 1] = target.g;
      out[index + 2] = target.b;
      out[index + 3] = Math.round((alpha * target.a) / 255);
      if (out[index + 3]! > 0) report.kept += 1;
      else report.dropped += 1;
      report.perEntry[near.index]!.pixels += 1;
      continue;
    }

    /*
     * Kept exactly as it was, or gone.
     *
     * The pixel is not recolored to the entry it matched — it already *is* that
     * color, to within the tolerance, and replacing it would throw away the
     * shading that made the tolerance necessary in the first place.
     */
    if (near.distance <= options.tolerance) {
      out[index + 3] = alpha;
      report.kept += 1;
      report.perEntry[near.index]!.pixels += 1;
    } else {
      out[index + 3] = 0;
      report.dropped += 1;
    }
  }

  if (report.considered > 0 && report.kept === 0 && options.mode === 'keep') {
    report.problems.push(
      options.tolerance <= 0
        ? 'Nothing matched exactly. Raise the tolerance, or check the palette came from this image.'
        : 'Nothing matched. Raise the tolerance, or check the palette came from this image.',
    );
  }
  return { pixels: out, report };
}

export function summariseFilter(report: FilterReport, options: PaletteFilterOptions): string {
  if (report.considered === 0) return 'Nothing to filter — every pixel is already transparent.';
  const share = (count: number) => `${((count / report.considered) * 100).toFixed(1)}%`;
  if (options.mode === 'snap') {
    const faded = report.dropped > 0 ? `, ${share(report.dropped)} faded away by a see-through entry` : '';
    return `${share(report.recolored)} of the image was recolored${faded}.`;
  }
  return `${share(report.kept)} kept as it was, ${share(report.dropped)} made transparent.`;
}
