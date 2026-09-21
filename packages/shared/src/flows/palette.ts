import { createRng } from '../text/generate';

/**
 * A color palette, counted out of an image.
 *
 * The idea is the mode rather than an average: the colors a picture actually
 * uses most, not the colors you get by averaging it (which is how palettes end
 * up as five shades of mud). Every pixel is counted, the counts are sorted, and
 * the commonest colors are taken in order.
 *
 * What makes that work is the minimum distance. Take the top five counts off a
 * photograph of a sky and you get five almost identical blues, because a
 * gradient is thousands of near-neighbours. So a color that is closer than
 * `minDistance` to one already chosen is not a new palette entry — it joins that
 * entry's bucket, and the bucket keeps its own tally. One bucket is one mode of
 * the image, and the palette is one color picked out of each.
 */

/* ------------------------------------------------------------------ *
 * Color, and how far apart two of them are
 * ------------------------------------------------------------------ */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A color the image contained, and how many pixels of it there were. */
export interface ColorCount extends Rgb {
  count: number;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return undefined;
  const digits = match[1]!;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** sRGB's transfer curve. Averaging or measuring gamma-encoded values is wrong. */
function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/**
 * sRGB to OKLab.
 *
 * Distance has to be measured somewhere perceptual, or the numbers do not mean
 * what the eye means. In plain RGB, `#0000ff` and `#000080` sit 128 apart while
 * `#00ff00` and `#00ff80` — obviously different greens — sit the same 128 apart,
 * so one minimum distance cannot serve both. OKLab is built so that equal
 * distances look equally different, including in the blues, which is where the
 * older CIE Lab noticeably fails.
 *
 * Björn Ottosson's matrices, https://bottosson.github.io/posts/oklab/.
 */
export function toOklab({ r, g, b }: Rgb): Oklab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * How far apart two colors look, on a scale where 100 is roughly black to white.
 *
 * It is the straight-line distance in OKLab, times 100 so the numbers are worth
 * typing into a slider. Two colors a human would call the same are under about
 * 2; navy and royal blue are around 20; red and green are past 70.
 */
export function colorDistance(a: Rgb, b: Rgb): number {
  const first = toOklab(a);
  const second = toOklab(b);
  return (
    100 *
    Math.hypot(first.L - second.L, first.a - second.a, first.b - second.b)
  );
}

/* ------------------------------------------------------------------ *
 * What was read out of the image
 * ------------------------------------------------------------------ */

/**
 * The counted colors of one image.
 *
 * Reading the image happens in the editor, where the browser can decode a PNG, a
 * JPEG, a WebP or a GIF without this project carrying a decoder for each. What is
 * kept is only the tally, which is a few thousand rows rather than a few million
 * pixels — and it is kept in the flow, so generating is instant and repeatable
 * and does not need the image again.
 *
 * `hash` is the artifact's hash at the time it was read. When the image changes,
 * the hash stops matching and the editor and the run both say the count is stale
 * rather than quietly describing the old picture.
 */
export interface ImageHistogram {
  /** Where it was read from, for the report. */
  source: string;
  /** Artifact hash when it was read, so a changed image is visible. */
  hash: string;
  width: number;
  height: number;
  /** Pixels counted. Fully transparent ones are not among them. */
  pixels: number;
  /** Pixels skipped for being too transparent to have a color. */
  transparent: number;
  /** Bits kept per channel when rounding colors together before counting. */
  precision: number;
  /** Distinct colors after rounding, commonest first. */
  colors: ColorCount[];
  readAt: string;
}

/**
 * Round a color so that near-identical pixels count as the same color.
 *
 * Without this the mode is meaningless for anything photographic: a photograph
 * of a red wall contains a hundred thousand slightly different reds, each seen
 * once or twice, and the "commonest color" is then whichever one happened to
 * repeat. Rounding to 5 bits a channel gives 32 levels each, which is coarse
 * enough for a wall to be one color and fine enough that a palette entry is
 * still the color you can see in the picture.
 *
 * The rounded value is expanded back across the full range, so pure white stays
 * `#ffffff` rather than drifting to `#f8f8f8`.
 */
export function quantise(channel: number, precision: number): number {
  const bits = Math.max(1, Math.min(8, Math.round(precision)));
  if (bits >= 8) return clampByte(channel);
  const levels = (1 << bits) - 1;
  const step = 255 / levels;
  return clampByte(Math.round(Math.round(clampByte(channel) / step) * step));
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface PaletteOptions {
  /** How many colors the palette has. */
  count: number;
  /**
   * How far apart two palette colors must look, 0..100. Anything closer joins
   * the bucket of the color already chosen instead of becoming an entry of its
   * own. 0 takes the raw top counts, gradients and all.
   */
  minDistance: number;
  /** Same seed, same palette. Rerolling is an edit you can see. */
  seed: string;
  /**
   * 0..1 — how far from each bucket's commonest color the entry may wander.
   *
   * At 0 every entry is the modal color of its bucket. Above that the entry
   * moves towards another member of the same bucket, picked by how often it
   * appears, so a warm grey can come out as the slightly warmer grey next to it.
   * It never leaves the bucket, so a palette color is always a color the image
   * actually contains.
   */
  temperature: number;
  /** Bits kept per channel when counting. 5 is 32 levels each. */
  precision: number;
  /** Ignore pixels this transparent, 0..255. 0 counts every pixel. */
  alphaFloor: number;
  /** Drop a bucket holding less than this share of the image, 0..1. */
  minShare: number;
}

export const DEFAULT_PALETTE_OPTIONS: PaletteOptions = {
  count: 6,
  minDistance: 12,
  seed: 'vibetoon',
  temperature: 0,
  precision: 5,
  alphaFloor: 8,
  minShare: 0,
};

/* ------------------------------------------------------------------ *
 * The palette
 * ------------------------------------------------------------------ */

export interface PaletteEntry {
  hex: string;
  r: number;
  g: number;
  b: number;
  /** Pixels in this bucket — the whole mode, not just the one color shown. */
  count: number;
  /** That count as a share of the pixels counted, 0..1. */
  share: number;
  /** Distinct counted colors that fell into this bucket. */
  members: number;
  /** The bucket's commonest color, which is what temperature moved away from. */
  modeHex: string;
  /** How far the entry ended up from that, on the same 0..100 scale. */
  shifted: number;
  /** How far this entry is from its nearest neighbour in the palette. */
  nearest: number;
}

export interface Palette {
  entries: PaletteEntry[];
  /** Pixels the buckets account for, which is all of them. */
  pixels: number;
  /** Distinct counted colors that went in. */
  distinct: number;
  /** Buckets that were dropped for holding too small a share. */
  dropped: number;
  /**
   * Set when the image simply does not contain `count` colors far enough apart:
   * a two-tone drawing cannot yield eight entries at a distance of 30.
   */
  shortfall?: string;
}

interface Bucket {
  seed: ColorCount;
  lab: Oklab;
  members: ColorCount[];
  count: number;
}

function labDistance(a: Oklab, b: Oklab): number {
  return 100 * Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

/**
 * Counts in, palette out.
 *
 * One pass over the counted colors, commonest first. Each one either joins the
 * nearest bucket it is close enough to, or starts a bucket of its own. Because
 * the walk is in count order, a bucket is always seeded by its own commonest
 * color — which is what makes the seed the mode of that bucket and not just
 * whichever color happened to be met first.
 *
 * Once the palette is full, a color with no bucket near it still has to go
 * somewhere, so it joins the nearest one regardless of distance. That keeps the
 * shares honest: they always add up to the whole image.
 */
export function derivePalette(
  histogram: ImageHistogram,
  overrides: Partial<PaletteOptions> = {},
): Palette {
  const options = { ...DEFAULT_PALETTE_OPTIONS, ...overrides };
  const count = Math.max(1, Math.round(options.count));
  const minDistance = Math.max(0, options.minDistance);

  const sorted = [...histogram.colors].sort(
    (a, b) => b.count - a.count || toHex(a).localeCompare(toHex(b)),
  );
  const buckets: Bucket[] = [];

  for (const color of sorted) {
    const lab = toOklab(color);
    let nearest: Bucket | undefined;
    let nearestAt = Infinity;
    for (const bucket of buckets) {
      const distance = labDistance(lab, bucket.lab);
      if (distance < nearestAt) {
        nearestAt = distance;
        nearest = bucket;
      }
    }

    if (nearest && (nearestAt < minDistance || buckets.length >= count)) {
      nearest.members.push(color);
      nearest.count += color.count;
      continue;
    }
    buckets.push({ seed: color, lab, members: [color], count: color.count });
  }

  const pixels = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const floor = Math.max(0, Math.min(1, options.minShare)) * Math.max(1, pixels);
  const kept = buckets.filter((bucket, index) => index === 0 || bucket.count >= floor);
  const rng = createRng(`${options.seed}|${count}|${minDistance}|${options.temperature}`);

  const entries: PaletteEntry[] = kept.map((bucket) => {
    const chosen = pickFromBucket(bucket, options.temperature, rng);
    return {
      ...chosen,
      hex: toHex(chosen),
      count: bucket.count,
      share: pixels > 0 ? bucket.count / pixels : 0,
      members: bucket.members.length,
      modeHex: toHex(bucket.seed),
      shifted: Math.round(colorDistance(chosen, bucket.seed) * 10) / 10,
      nearest: 0,
    };
  });

  // Each entry's nearest neighbour, which is how you see whether the minimum
  // distance is actually being met.
  for (const entry of entries) {
    let nearest = Infinity;
    for (const other of entries) {
      if (other === entry) continue;
      nearest = Math.min(nearest, colorDistance(entry, other));
    }
    entry.nearest = Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : 0;
  }

  const shortfall =
    entries.length < count
      ? `The image has ${entries.length} color${entries.length === 1 ? '' : 's'} at least ${minDistance.toFixed(
          0,
        )} apart, not ${count}. Lower the minimum distance, or ask for fewer.`
      : undefined;

  return {
    entries,
    pixels,
    distinct: histogram.colors.length,
    dropped: buckets.length - kept.length,
    ...(shortfall ? { shortfall } : {}),
  };
}

/**
 * Which color of a bucket the palette shows.
 *
 * At temperature 0 it is the bucket's commonest color. Above that the entry
 * moves towards another member, chosen by how often that member appears, by the
 * fraction the temperature asks for. Interpolating in OKLab rather than RGB
 * means the intermediate colors stay in the family — an RGB midpoint between
 * two blues can pass through grey.
 */
function pickFromBucket(bucket: Bucket, temperature: number, rng: () => number): Rgb {
  const heat = Math.max(0, Math.min(1, temperature));
  if (heat === 0 || bucket.members.length < 2) return { ...bucket.seed };

  const others = bucket.members.filter((member) => member !== bucket.seed);
  const total = others.reduce((sum, member) => sum + member.count, 0);
  if (total <= 0) return { ...bucket.seed };

  let roll = rng() * total;
  let target = others[others.length - 1]!;
  for (const member of others) {
    roll -= member.count;
    if (roll <= 0) {
      target = member;
      break;
    }
  }
  return mixOklab(bucket.seed, target, heat);
}

/** Blend two colors the way the eye reads a blend, and come back to sRGB. */
export function mixOklab(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  const a = toOklab(from);
  const b = toOklab(to);
  return fromOklab({
    L: a.L + (b.L - a.L) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

function fromGamma(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

export function fromOklab({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: clampByte(255 * fromGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clampByte(255 * fromGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clampByte(255 * fromGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

export interface PaletteFlowData {
  editor: 'palette';
  options: PaletteOptions;
  /** The counted image, read in the editor. Absent until one has been read. */
  histogram?: ImageHistogram;
  /**
   * Entries pinned by hand, by index, so a palette you like survives a change to
   * the settings. A pinned entry is used as it is and takes no part in bucketing.
   */
  pinned: Record<string, string>;
}

export function emptyPaletteFlowData(): PaletteFlowData {
  return {
    editor: 'palette',
    options: { ...DEFAULT_PALETTE_OPTIONS },
    pinned: {},
  };
}

/** Whether the counted image still describes the artifact that is wired in. */
export function histogramState(
  data: PaletteFlowData,
  artifactHash: string | undefined,
): 'none' | 'stale' | 'fresh' {
  if (!data.histogram) return 'none';
  if (!artifactHash || data.histogram.hash !== artifactHash) return 'stale';
  return 'fresh';
}

/** Apply the pinned overrides to a derived palette, by position. */
export function applyPinned(palette: Palette, pinned: Record<string, string>): Palette {
  const entries = palette.entries.map((entry, index) => {
    const override = fromHex(pinned[String(index)] ?? '');
    if (!override) return entry;
    return {
      ...entry,
      ...override,
      hex: toHex(override),
      shifted: Math.round(colorDistance(override, entry) * 10) / 10,
    };
  });
  return { ...palette, entries };
}

export interface PaletteSummary {
  colors: number;
  /** The closest two entries are, so you can see the minimum being met. */
  closest: number;
  /** The share of the image the palette accounts for, 0..1. */
  covered: number;
  pinned: number;
}

export function summarisePalette(palette: Palette, data: PaletteFlowData): PaletteSummary {
  const closest = palette.entries.reduce(
    (min, entry) => (entry.nearest > 0 ? Math.min(min, entry.nearest) : min),
    Infinity,
  );
  return {
    colors: palette.entries.length,
    closest: Number.isFinite(closest) ? closest : 0,
    covered: palette.entries.reduce((sum, entry) => sum + entry.share, 0),
    pinned: Object.keys(data.pinned).filter((key) => fromHex(data.pinned[key] ?? '')).length,
  };
}
