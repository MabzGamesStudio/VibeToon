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

/**
 * A color with an opacity.
 *
 * Kept apart from `Rgb` rather than folded into it, because most of what this
 * project does with color has nothing to say about opacity — a region's average,
 * the distance between two hues — and a field that is `255` everywhere it is
 * read is a field nobody maintains.
 */
export interface Rgba extends Rgb {
  /** 0 for see-through, 255 for solid. */
  a: number;
}

/** A color the image contained, and how many pixels of it there were. */
export interface ColorCount extends Rgb {
  count: number;
  /**
   * The opacity of the pixel this row is named after, 0..255. Absent when that
   * pixel is solid, which most are.
   *
   * A row is named after the commonest exact pixel among those that rounded
   * together — color *and* opacity — so it is a value the picture really holds,
   * and a filter looking for exactly this value finds it.
   */
  a?: number;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * `#rrggbb`, or `#rrggbbaa` when there is an opacity worth writing down.
 *
 * Solid colors keep the six-digit form they have always had, so nothing that
 * reads a palette — or a drawing's shape colors, which have no opacity at all —
 * sees anything new. Eight digits appear only when something is actually
 * see-through, where the alternative is a palette that silently forgets it.
 */
export function toHex({ r, g, b, a }: Rgb & { a?: number }): string {
  const channels = [r, g, b];
  if (a !== undefined && clampByte(a) < 255) channels.push(a);
  return `#${channels.map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): Rgba | undefined {
  const match = /^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return undefined;
  const digits = match[1]!;
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) : 255,
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

/**
 * How far a fully transparent pixel is from a solid one of the same color, on the
 * same 0..100 scale as `colorDistance` — about as far as red is from orange.
 */
export const OPACITY_SPAN = 50;

/**
 * A color ready to be compared: where it sits in OKLab, and how opaque it is.
 * Worked out once per color rather than once per comparison, because a filter
 * compares every distinct color in a picture against every palette entry.
 */
export interface Swatch {
  lab: Oklab;
  /** 0..1. */
  opacity: number;
}

export function swatchOf(color: Rgb & { a?: number }): Swatch {
  return { lab: toOklab(color), opacity: Math.max(0, Math.min(255, color.a ?? 255)) / 255 };
}

/**
 * How far apart two colors are, opacity included, on the same 0..100 scale as
 * `colorDistance`.
 *
 * Color and opacity are two separate questions and are measured separately: the
 * distance between the colors, and `OPACITY_SPAN` for every step from clear to
 * solid, put together like the two sides of a right angle. Two solid colors are
 * exactly as far apart as they always were.
 *
 * Kept separate on purpose. Comparing how two colors *look* — laid over black and
 * over white — is the obvious alternative, and it gets anti-aliased edges wrong:
 * a half-transparent yellow over black is a dark olive, which looks more like a
 * green than like yellow, so snapping gave every soft yellow edge a green fringe.
 * Measured apart, an edge pixel is always nearest its own color, and becomes it
 * or clear depending on which side of half opacity it is.
 *
 * A clear pixel shows nothing, so its color numbers mean nothing: against a clear
 * one, only opacity counts. Two clear pixels are 0 apart whatever numbers they
 * carry, and clear is never mistaken for black.
 */
export function swatchDistance(one: Swatch, two: Swatch): number {
  const opacity = OPACITY_SPAN * Math.abs(one.opacity - two.opacity);
  if (one.opacity === 0 || two.opacity === 0) return opacity;
  return Math.hypot(labDistance(one.lab, two.lab), opacity);
}

export function rgbaDistance(one: Rgb & { a?: number }, two: Rgb & { a?: number }): number {
  return swatchDistance(swatchOf(one), swatchOf(two));
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
  /**
   * Which way the image was counted. Absent on counts made before pixels were
   * read exactly and named by their commonest exact value — those still work, but
   * a color can be a step off what the picture holds, so the flow asks for the
   * image to be read again.
   */
  counting?: number;
}

/** The current way of counting. See `ImageHistogram.counting`. */
export const COUNTING_VERSION = 2;

/** Counted the old way: still usable, but worth reading again. */
export function histogramOutdated(histogram: ImageHistogram | undefined): boolean {
  return histogram !== undefined && (histogram.counting ?? 1) < COUNTING_VERSION;
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
 * `#ffffff` rather than drifting to `#f8f8f8`. It is a key for grouping and
 * never a color in its own right — see `countColors` for what a group is named.
 */
export function quantise(channel: number, precision: number): number {
  const bits = Math.max(1, Math.min(8, Math.round(precision)));
  if (bits >= 8) return clampByte(channel);
  const levels = (1 << bits) - 1;
  const step = 255 / levels;
  return clampByte(Math.round(Math.round(clampByte(channel) / step) * step));
}

export interface CountedPixels {
  /** One row per rounded color, commonest first. */
  colors: ColorCount[];
  /** Pixels that were counted. */
  counted: number;
  /** Pixels skipped for being too transparent to have a color. */
  transparent: number;
}

/**
 * Count the colors of an image, every `stride`th pixel.
 *
 * Pixels are **grouped** by their rounded color but **named** by an exact one:
 * each row is the commonest color that really occurs among the pixels that
 * rounded together. Rounding is how a photographed wall becomes one color rather
 * than a hundred thousand, and it is only for grouping. Naming a group after its
 * rounded value would put a color into the palette that the picture does not
 * contain — `#dc2828` rounds to `#de2929` at five bits — and then a filter asking
 * for pixels that are *exactly* a palette color would find none at all, on the
 * very flat artwork that exact matching exists for.
 *
 * The name includes opacity: it is the commonest exact *RGBA* value. A red drawn
 * solid with soft edges is named after its solid pixels, which are most of it,
 * and a pane of glass drawn at half opacity is named at half opacity. Opacity is
 * not part of the grouping key, though — the edge pixels of that red are the
 * same red, fading, and belong to it rather than to a palette entry of their own.
 */
export function countColors(
  pixels: ArrayLike<number>,
  options: { precision: number; alphaFloor: number; stride?: number },
): CountedPixels {
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const total = Math.floor(pixels.length / 4);
  const groups = new Map<number, { count: number; exact: Map<number, number> }>();
  let counted = 0;
  let transparent = 0;

  for (let index = 0; index < total; index += stride) {
    const at = index * 4;
    const alpha = pixels[at + 3]!;
    if (alpha < options.alphaFloor) {
      transparent += 1;
      continue;
    }
    const r = pixels[at]!;
    const g = pixels[at + 1]!;
    const b = pixels[at + 2]!;
    const key =
      (quantise(r, options.precision) << 16) | (quantise(g, options.precision) << 8) | quantise(b, options.precision);
    // RGBA as one number. Multiplied rather than shifted, because a shift into
    // the top bit of a 32-bit int turns the number negative.
    const exact = ((r << 16) | (g << 8) | b) * 256 + alpha;

    let group = groups.get(key);
    if (!group) {
      group = { count: 0, exact: new Map() };
      groups.set(key, group);
    }
    group.count += 1;
    group.exact.set(exact, (group.exact.get(exact) ?? 0) + 1);
    counted += 1;
  }

  const colors: ColorCount[] = [];
  for (const group of groups.values()) {
    // Ties go to the lower value, so the same image always names a group the
    // same way whatever order its pixels were met in.
    let name = -1;
    let most = 0;
    for (const [value, count] of group.exact) {
      if (count > most || (count === most && value < name)) {
        name = value;
        most = count;
      }
    }
    const alpha = name % 256;
    const rgb = Math.floor(name / 256);
    colors.push({
      r: (rgb >> 16) & 255,
      g: (rgb >> 8) & 255,
      b: rgb & 255,
      count: group.count,
      // Left off when the color is solid, which most are: writing `a: 255`
      // against every color in a photograph is a lot of flow file for nothing.
      ...(alpha < 255 ? { a: alpha } : {}),
    });
  }
  colors.sort((one, two) => two.count - one.count || toHex(one).localeCompare(toHex(two)));
  return { colors, counted, transparent };
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
  /**
   * Give the pixels under `alphaFloor` an entry of their own: fully transparent,
   * `#00000000`. On top of `count`, so asking for five colors from a cut-out
   * picture gives five colors and the clear around them.
   */
  transparent: boolean;
}

export const DEFAULT_PALETTE_OPTIONS: PaletteOptions = {
  count: 6,
  minDistance: 12,
  seed: 'vibetoon',
  temperature: 0,
  precision: 5,
  alphaFloor: 8,
  minShare: 0,
  transparent: true,
};

/** The one transparent entry a palette can have. */
export const CLEAR_HEX = '#00000000';

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
  /** How opaque this color is, 0..255. Read from the image and editable. */
  a: number;
  /** Put in by hand rather than read out of the image, so it stands for no pixels. */
  byHand?: boolean;
  /** The entry that stands for the image's transparent pixels. */
  clear?: boolean;
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
  swatch: Swatch;
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
    const swatch = swatchOf(color);
    let nearest: Bucket | undefined;
    let nearestAt = Infinity;
    for (const bucket of buckets) {
      const distance = swatchDistance(swatch, bucket.swatch);
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
    buckets.push({ seed: color, swatch, members: [color], count: color.count });
  }

  const colored = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  // The clear entry, when there is one, is part of the picture as much as any
  // color, so shares are of the whole image and still add up to it.
  const clear = options.transparent && histogram.transparent > 0 ? histogram.transparent : 0;
  const pixels = colored + clear;
  const floor = Math.max(0, Math.min(1, options.minShare)) * Math.max(1, colored);
  const kept = buckets.filter((bucket, index) => index === 0 || bucket.count >= floor);
  const rng = createRng(`${options.seed}|${count}|${minDistance}|${options.temperature}`);

  const entries: PaletteEntry[] = kept.map((bucket) => {
    const chosen = pickFromBucket(bucket, options.temperature, rng);
    // The opacity of the pixel the entry is named after — an exact value the
    // picture holds, like its color — rather than an average of the group, which
    // would be a value no pixel has.
    const opacity = chosen.a ?? bucket.seed.a ?? 255;
    return {
      r: chosen.r,
      g: chosen.g,
      b: chosen.b,
      a: opacity,
      hex: toHex({ ...chosen, a: opacity }),
      count: bucket.count,
      share: pixels > 0 ? bucket.count / pixels : 0,
      members: bucket.members.length,
      // The bucket's identity is its color, not its color and its opacity: an
      // edit made to an entry should still find it after the picture behind it
      // has faded.
      modeHex: toHex({ r: bucket.seed.r, g: bucket.seed.g, b: bucket.seed.b }),
      shifted: Math.round(rgbaDistance({ ...chosen, a: opacity }, bucket.seed) * 10) / 10,
      nearest: 0,
    };
  });

  if (clear > 0) {
    entries.push({
      r: 0,
      g: 0,
      b: 0,
      a: 0,
      hex: CLEAR_HEX,
      count: clear,
      share: clear / pixels,
      members: 0,
      modeHex: CLEAR_HEX,
      shifted: 0,
      nearest: 0,
      clear: true,
    });
  }

  // Each entry's nearest neighbour, which is how you see whether the minimum
  // distance is actually being met. Opacity counts: clear is not black.
  for (const entry of entries) {
    let nearest = Infinity;
    for (const other of entries) {
      if (other === entry) continue;
      nearest = Math.min(nearest, rgbaDistance(entry, other));
    }
    entry.nearest = Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : 0;
  }

  const colors = entries.filter((entry) => !entry.clear).length;
  const shortfall =
    colors < count
      ? `The image has ${colors} color${colors === 1 ? '' : 's'} at least ${minDistance.toFixed(
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
function pickFromBucket(bucket: Bucket, temperature: number, rng: () => number): Rgb & { a?: number } {
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
  // A blend is a new color, so it carries the opacity of the color it moved away
  // from rather than a blend of two opacities.
  return { ...mixOklab(bucket.seed, target, heat), ...(bucket.seed.a !== undefined ? { a: bucket.seed.a } : {}) };
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

/**
 * What was done to the palette by hand, after the image was read.
 *
 * Kept separate from the palette itself, and applied on top of it every time, so
 * that turning a setting or reading the picture again re-derives the palette
 * without throwing the hand work away. A palette stored as a flat list of colors
 * could not do that: the first change of `count` would either wipe the edits or
 * ignore the image.
 *
 * Edits are keyed by the **bucket** an entry came out of — its commonest color,
 * which is what `modeHex` holds — rather than by its position in the list.
 * Position is not identity. Ask for four colors instead of eight and entry three
 * is a different color than it was, so an edit stored against "3" would quietly
 * apply to something you never chose. A bucket key either still exists, and the
 * edit lands on the color you made it for, or it does not, and the edit waits
 * inert until it does.
 */
export interface PaletteEdits {
  /** Entries changed by hand, keyed by the bucket they came out of. */
  changed: Record<string, string>;
  /** Entries taken out by hand, keyed the same way. */
  removed: string[];
  /** Colors put in by hand, which no bucket in the image stands behind. */
  added: string[];
}

export const NO_PALETTE_EDITS: PaletteEdits = { changed: {}, removed: [], added: [] };

export interface PaletteFlowData {
  editor: 'palette';
  options: PaletteOptions;
  /** The counted image, read in the editor. Absent until one has been read. */
  histogram?: ImageHistogram;
  /** Changes made by hand, applied on top of whatever the settings derive. */
  edits: PaletteEdits;
}

export function emptyPaletteFlowData(): PaletteFlowData {
  return {
    editor: 'palette',
    options: { ...DEFAULT_PALETTE_OPTIONS },
    edits: { changed: {}, removed: [], added: [] },
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

/**
 * Apply the hand edits to a derived palette.
 *
 * Removals first, then changes, then additions on the end — so a color you put in
 * is never dropped by a removal meant for the bucket it happens to match, and a
 * change is never applied to something already gone.
 */
export function applyEdits(palette: Palette, edits: PaletteEdits = NO_PALETTE_EDITS): Palette {
  const removed = new Set(
    edits.removed.map((hex) => fromHex(hex)).filter((rgb): rgb is Rgba => rgb !== undefined).map(toHex),
  );

  const entries: PaletteEntry[] = palette.entries
    .filter((entry) => !removed.has(entry.modeHex))
    .map((entry) => {
      const override = fromHex(edits.changed[entry.modeHex] ?? '');
      if (!override) return entry;
      return {
        ...entry,
        ...override,
        hex: toHex(override),
        // Still measured from the bucket's commonest color, so the editor can say
        // how far from the picture you have taken it.
        shifted: Math.round(rgbaDistance(override, fromHex(entry.modeHex) ?? entry) * 10) / 10,
      };
    });

  for (const hex of edits.added) {
    const rgb = fromHex(hex);
    if (!rgb) continue;
    entries.push({
      ...rgb,
      hex: toHex(rgb),
      // No pixels stand behind a color put in by hand, and saying so is the point:
      // it keeps `covers` honest about how much of the image the palette accounts
      // for, rather than crediting an invented color with a share of it.
      count: 0,
      share: 0,
      members: 0,
      modeHex: toHex({ r: rgb.r, g: rgb.g, b: rgb.b }),
      shifted: 0,
      nearest: 0,
      byHand: true,
    });
  }

  return { ...palette, entries: withNearest(entries) };
}

/**
 * Each entry's nearest neighbour, recomputed.
 *
 * Worth doing again after an edit rather than carrying the derived figure over:
 * this number is how the editor answers "is the minimum distance actually being
 * met", and two colors you chose by hand can sit far closer together than any
 * bucketing would have put them.
 */
function withNearest(entries: PaletteEntry[]): PaletteEntry[] {
  return entries.map((entry) => {
    let nearest = Infinity;
    for (const other of entries) {
      if (other === entry) continue;
      nearest = Math.min(nearest, rgbaDistance(entry, other));
    }
    return { ...entry, nearest: Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : 0 };
  });
}

export interface PaletteSummary {
  colors: number;
  /** The closest two entries are, so you can see the minimum being met. */
  closest: number;
  /** The share of the image the palette accounts for, 0..1. */
  covered: number;
  /** Derived entries whose color was changed by hand. */
  changed: number;
  /** Derived entries taken out by hand. */
  removed: number;
  /** Colors put in by hand. */
  added: number;
  /**
   * Edits stored against a bucket the current settings no longer produce. They are
   * kept, not lost, and come back if the settings come back — but they are doing
   * nothing now, which is worth saying rather than leaving someone to wonder why
   * a change they made has no effect.
   */
  waiting: number;
}

export function summarisePalette(palette: Palette, data: PaletteFlowData): PaletteSummary {
  const edits = data.edits ?? NO_PALETTE_EDITS;
  const closest = palette.entries.reduce(
    (min, entry) => (entry.nearest > 0 ? Math.min(min, entry.nearest) : min),
    Infinity,
  );
  const buckets = new Set(palette.entries.map((entry) => entry.modeHex));
  const applies = (hex: string) => {
    const rgb = fromHex(hex);
    return rgb !== undefined && buckets.has(toHex(rgb));
  };

  const changed = Object.keys(edits.changed).filter(
    (key) => fromHex(edits.changed[key] ?? '') !== undefined && buckets.has(key),
  ).length;
  const removed = edits.removed.filter((hex) => fromHex(hex) !== undefined).length;
  const added = edits.added.filter((hex) => fromHex(hex) !== undefined).length;

  return {
    colors: palette.entries.length,
    closest: Number.isFinite(closest) ? closest : 0,
    covered: palette.entries.reduce((sum, entry) => sum + entry.share, 0),
    changed,
    removed,
    added,
    waiting:
      Object.keys(edits.changed).filter((key) => !applies(key)).length +
      edits.removed.filter((hex) => !applies(hex)).length,
  };
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

/**
 * Change one entry's color.
 *
 * A color put in by hand is edited where it stands, in `added`, rather than
 * gaining an override of its own — two records for one color would let them
 * disagree. Pass an empty string to put a derived entry back to what was counted.
 */
export function changeColor(edits: PaletteEdits, entry: PaletteEntry, hex: string): PaletteEdits {
  const rgb = fromHex(hex);

  if (entry.byHand) {
    if (!rgb) return edits;
    const at = edits.added.findIndex((value) => sameColor(value, entry.hex));
    if (at < 0) return edits;
    const added = [...edits.added];
    added[at] = toHex(rgb);
    return { ...edits, added };
  }

  const changed = { ...edits.changed };
  if (rgb) changed[entry.modeHex] = toHex(rgb);
  else delete changed[entry.modeHex];
  return { ...edits, changed };
}

/** Take one entry out. A color put in by hand is simply forgotten. */
export function removeColor(edits: PaletteEdits, entry: PaletteEntry): PaletteEdits {
  if (entry.byHand) {
    return { ...edits, added: edits.added.filter((value) => !sameColor(value, entry.hex)) };
  }
  if (edits.removed.some((value) => sameColor(value, entry.modeHex))) return edits;
  // The override goes with it. Keeping a change for an entry that is no longer
  // there would come back to life the moment the removal was undone.
  const changed = { ...edits.changed };
  delete changed[entry.modeHex];
  return { ...edits, changed, removed: [...edits.removed, entry.modeHex] };
}

/** Put a removed entry back, by the bucket it came from. */
export function restoreColor(edits: PaletteEdits, modeHex: string): PaletteEdits {
  return { ...edits, removed: edits.removed.filter((value) => !sameColor(value, modeHex)) };
}

/** Add a color of your own. Refuses one the palette already has. */
export function addColor(edits: PaletteEdits, hex: string): PaletteEdits {
  const rgb = fromHex(hex);
  if (!rgb) return edits;
  const value = toHex(rgb);
  if (edits.added.some((other) => sameColor(other, value))) return edits;
  return { ...edits, added: [...edits.added, value] };
}

function sameColor(one: string, two: string): boolean {
  const a = fromHex(one);
  const b = fromHex(two);
  return a !== undefined && b !== undefined && toHex(a) === toHex(b);
}
