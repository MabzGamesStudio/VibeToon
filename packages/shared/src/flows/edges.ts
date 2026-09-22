import type { Bitmap } from './cutout';
import type { Rgb } from './palette';

/**
 * Finding where a picture changes.
 *
 * The first decomposition grew regions by comparing colors, which asks each
 * pixel "are you near enough the one I started from" a few million times and
 * gets a different answer depending on where it started. Finding the **edges**
 * first inverts that: one pass says where the picture changes, and the regions
 * are then whatever those edges enclose. It is faster, it does not depend on a
 * starting pixel, and it puts the boundary where the contrast actually is rather
 * than wherever a tolerance happened to run out.
 */

export interface EdgeOptions {
  /**
   * How much contrast counts as an edge, in the OKLab-times-100 scale used
   * everywhere here. A gradient this steep across one pixel is a boundary.
   */
  edgeThreshold: number;
  /**
   * The weaker threshold. A pixel over this counts as an edge only if it joins
   * one that cleared the stronger one, which is what keeps a real boundary
   * unbroken where it briefly softens without letting noise become edges.
   */
  edgeFloor: number;
  /** Pixels at or below this alpha are transparent and belong to nothing. */
  alphaFloor: number;
}

export const DEFAULT_EDGE_OPTIONS: EdgeOptions = {
  edgeThreshold: 12,
  edgeFloor: 5,
  alphaFloor: 8,
};

export interface EdgeMap {
  width: number;
  height: number;
  /** How steeply the picture changes at each pixel. */
  magnitude: Float32Array;
  /** 1 where a boundary runs, 0 where it does not. One pixel wide. */
  edges: Uint8Array;
  /** 1 where the picture is not there at all. */
  clear: Uint8Array;
  /**
   * Every pixel in OKLab, kept rather than thrown away.
   *
   * The edge pass has to build these anyway, and the region pass that follows
   * asks "how far apart do these two pixels look" a few million times. Answering
   * that from raw bytes means three cube roots per pixel per question, which was
   * most of what the flow spent its time on; answering it from here is
   * subtraction.
   */
  lab: { lightness: Float32Array; greenRed: Float32Array; blueYellow: Float32Array };
}

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

/**
 * Canny, on OKLab.
 *
 * Gradient, then thin the ridges to one pixel, then join the weak parts of
 * strong boundaries. Each step earns its place:
 *
 * - **On OKLab**, because the gradient has to mean "how different does this
 *   look". In RGB a boundary between two blues reads as steeper than one
 *   between two greens that are plainly further apart, so one threshold cannot
 *   serve a whole picture.
 * - **Thinned**, because a gradient is a ridge several pixels wide and a
 *   boundary is a line. A fat boundary eats the regions either side of it, and
 *   on a thin stroke it eats the stroke.
 * - **Joined**, because a boundary that fades for a pixel and comes back is
 *   still one boundary, and a gap in it lets two regions bleed into one.
 */
export function detectEdges(image: Bitmap, options: EdgeOptions): EdgeMap {
  const { width, height, data } = image;
  const size = width * height;

  // OKLab once per pixel, into flat arrays. The same numbers are read nine
  // times over by the gradient, and recomputing a cube root nine times is most
  // of what a naive version of this spends its time on.
  const lightness = new Float32Array(size);
  const greenRed = new Float32Array(size);
  const blueYellow = new Float32Array(size);
  const clear = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) {
    const at = index * 4;
    if (data[at + 3]! <= options.alphaFloor) {
      clear[index] = 1;
      continue;
    }
    const lab = oklab(data[at]!, data[at + 1]!, data[at + 2]!);
    lightness[index] = lab.l;
    greenRed[index] = lab.a;
    blueYellow[index] = lab.b;
  }

  const magnitude = new Float32Array(size);
  const angle = new Float32Array(size);
  // Allocated once and written into, because a tuple per channel per pixel is
  // three million short-lived arrays on a picture this size.
  const gradient = new Float64Array(2);
  const channels = [lightness, greenRed, blueYellow];

  // Right to the border, not one pixel inside it. Skipping the outer ring leaves
  // a gap in every boundary that reaches the edge of the picture, and a region
  // only has to leak through one pixel to swallow its neighbour — two blocks
  // divided by a stroke came out as one region because the stroke stopped a
  // pixel short of the top. The samples are clamped instead, which reads the
  // border row twice and puts the boundary where it belongs.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      // The edge of the picture is a boundary in its own right, and so is the
      // edge of what is drawn on it.
      if (clear[index]) continue;

      let total = 0;
      for (const channel of channels) {
        sobel(channel, clear, width, height, x, y, gradient);
        total += gradient[0]! * gradient[0]! + gradient[1]! * gradient[1]!;
      }
      // Times 100, so the threshold is in the same units as every other
      // color distance in this project.
      magnitude[index] = Math.sqrt(total) * 100;
      sobel(lightness, clear, width, height, x, y, gradient);
      angle[index] = Math.atan2(gradient[1]!, gradient[0]!);
    }
  }

  // Thin the ridges: a pixel stays only if it is the steepest of its immediate
  // neighbours along the direction the picture is changing.
  const ridge = new Uint8Array(size);
  const reach = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : magnitude[y * width + x]!;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const here = magnitude[index]!;
      if (here < options.edgeFloor) continue;
      const [dx, dy] = step(angle[index]!);
      // Checked by coordinate rather than by flat index, so a neighbour off the
      // left of one row is not the right of the row above it.
      if (here >= reach(x - dx, y - dy) && here >= reach(x + dx, y + dy)) ridge[index] = 1;
    }
  }

  // Join: strong ridges seed, and weak ridges touching them are kept.
  const edges = new Uint8Array(size);
  const stack: number[] = [];
  for (let index = 0; index < size; index += 1) {
    if (ridge[index] && magnitude[index]! >= options.edgeThreshold) {
      edges[index] = 1;
      stack.push(index);
    }
  }
  while (stack.length > 0) {
    const index = stack.pop()!;
    const x = index % width;
    const y = (index - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (edges[next] || !ridge[next]) continue;
        edges[next] = 1;
        stack.push(next);
      }
    }
  }

  return { width, height, magnitude, edges, clear, lab: { lightness, greenRed, blueYellow } };
}

/**
 * Sobel on one channel, into `out` as [gx, gy].
 *
 * Written into rather than returned, and spelled out rather than looped, because
 * this runs three times per pixel and a tuple or a closure here is millions of
 * allocations on a picture of any size.
 */
function sobel(
  channel: Float32Array,
  clear: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Float64Array,
): void {
  // Clamped to the picture, so a pixel on the border has a full window and its
  // boundary is not cut off. Reading the border row twice makes the gradient
  // there the same as it would be one pixel in, which is the right answer: the
  // boundary carries on to the edge.
  const left = x > 0 ? x - 1 : 0;
  const right = x < width - 1 ? x + 1 : width - 1;
  const above = (y > 0 ? y - 1 : 0) * width;
  const middle = y * width;
  const below = (y < height - 1 ? y + 1 : height - 1) * width;

  // Transparency reads as a long way from whatever is beside it, so the
  // silhouette of a cut-out comes out as an edge without a special case.
  const away = channel[middle + x]! - 1;
  const topLeft = pick(channel, clear, above + left, away);
  const top = pick(channel, clear, above + x, away);
  const topRight = pick(channel, clear, above + right, away);
  const midLeft = pick(channel, clear, middle + left, away);
  const midRight = pick(channel, clear, middle + right, away);
  const bottomLeft = pick(channel, clear, below + left, away);
  const bottom = pick(channel, clear, below + x, away);
  const bottomRight = pick(channel, clear, below + right, away);

  out[0] =
    topLeft + 2 * midLeft + bottomLeft - topRight - 2 * midRight - bottomRight;
  out[1] = topLeft + 2 * top + topRight - bottomLeft - 2 * bottom - bottomRight;
}

function pick(
  channel: Float32Array,
  clear: Uint8Array,
  index: number,
  fallback: number,
): number {
  return clear[index] ? fallback : channel[index]!;
}

/** The gradient direction, snapped to one of the eight neighbours. */
function step(radians: number): [number, number] {
  const eighth = Math.round((radians * 4) / Math.PI) & 7;
  return [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ][eighth] as [number, number];
}

const cbrt = Math.cbrt;

/** sRGB to OKLab, on raw bytes, without allocating. */
function oklab(r8: number, g8: number, b8: number): { l: number; a: number; b: number } {
  const r = linear(r8 / 255);
  const g = linear(g8 / 255);
  const b = linear(b8 / 255);

  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/* ------------------------------------------------------------------ *
 * Regions
 * ------------------------------------------------------------------ */

export const CLEAR = -1;
export const UNCLAIMED = -2;

export interface GrownRegion {
  id: number;
  color: Rgb;
  pixels: number[];
  /** Region ids this one touches; `CLEAR` for transparency or the outside. */
  neighbours: Set<number>;
}

export interface GrownRegions {
  labels: Int32Array;
  regions: GrownRegion[];
  transparent: number;
  /** How many pixels the edge pass claimed, before they were handed back. */
  edgePixels: number;
  /** Regions folded into a neighbour for being under `minArea`. */
  folded: number;
}

/**
 * Grow regions out from the gaps between the edges, like the fill command.
 *
 * Nothing measures a pixel against the one the fill started from, which is the
 * whole difference from a tolerance. It stops at an edge, at transparency, and
 * where the picture takes a plain step from one pixel to the next — and that
 * last test is *local*, so a face shaded across twenty tones is one region
 * however far the shading travels, while a step from red to black stops the fill
 * dead however close to the seed it is.
 *
 * Both barriers are needed, and each covers what the other misses:
 *
 * - The **edge map** catches a soft boundary. An anti-aliased outline is a run
 *   of small steps, and the step test walks straight through it; the gradient
 *   over three pixels sees it plainly.
 * - The **step test** catches a thin bar. Canny finds a *step*, and a one-pixel
 *   line between two colors is not two steps three pixels apart — it is a single
 *   ridge, thinned to one pixel on whichever side happened to be steeper. Take
 *   the ridge out and the bar has nothing left to defend it; the step test gives
 *   it its own ground back.
 *
 * The edge pixels themselves are handed back afterwards. They were never
 * nothing: a stroke three pixels wide has boundaries down both sides and only
 * its middle survives the edge pass, so a region built from the gaps alone is a
 * third of its real width. Each edge pixel goes to whichever region beside it
 * its own color is nearest, which reconstructs the stroke and puts a blended
 * boundary pixel on the side it looks like.
 */
export function growRegions(
  image: Bitmap,
  map: EdgeMap,
  minArea: number,
  /** How big a step from one pixel to the next the fill will not cross. */
  stepLimit = DEFAULT_EDGE_OPTIONS.edgeThreshold,
): GrownRegions {
  const { width, height } = image;
  const size = width * height;
  const labels = new Int32Array(size).fill(UNCLAIMED);
  const regions: GrownRegion[] = [];
  let transparent = 0;
  let edgePixels = 0;

  for (let index = 0; index < size; index += 1) {
    if (map.clear[index]) {
      labels[index] = CLEAR;
      transparent += 1;
    } else if (map.edges[index]) {
      edgePixels += 1;
    }
  }

  const stack: number[] = [];
  for (let start = 0; start < size; start += 1) {
    if (labels[start] !== UNCLAIMED || map.edges[start]) continue;

    const id = regions.length;
    const pixels: number[] = [];
    stack.length = 0;
    stack.push(start);
    labels[start] = id;

    while (stack.length > 0) {
      const index = stack.pop()!;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const push = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const next = ny * width + nx;
        if (labels[next] !== UNCLAIMED || map.edges[next]) return;
        if (stepBetween(map, index, next) > stepLimit) return;
        labels[next] = id;
        stack.push(next);
      };
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }

    regions.push({ id, color: averageColor(image, pixels), pixels, neighbours: new Set() });
  }

  claimEdges(map, labels, regions, stepLimit);
  growLeftovers(image, map, labels, regions, stepLimit, width, height);

  // Drop the crumbs, and give their pixels to whoever is next to them, so a
  // dropped speck leaves a hole in nothing.
  const before = regions.filter((region) => region.pixels.length > 0).length;
  const kept = prune(image, labels, regions, minArea, width, height);
  findNeighbours(labels, kept, width, height);
  return { labels, regions: kept, transparent, edgePixels, folded: before - kept.length };
}

/**
 * Make regions of whatever the fill and the claim both left behind.
 *
 * A shape small enough or thin enough that *every* one of its pixels reads as a
 * boundary gets no seed from the fill, and `claimEdges` will not hand it to a
 * neighbour it looks nothing like — so without this pass it belongs to nothing
 * and quietly disappears. A two-pixel sliver on its own, and the black ring
 * round a shape, are both exactly that.
 *
 * They are flooded with the same local step test as the fill, so a leftover band
 * of one color is one region rather than a region per pixel.
 */
function growLeftovers(
  image: Bitmap,
  map: EdgeMap,
  labels: Int32Array,
  regions: GrownRegion[],
  stepLimit: number,
  width: number,
  height: number,
): void {
  const stack: number[] = [];
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] !== UNCLAIMED) continue;

    const id = regions.length;
    const pixels: number[] = [];
    stack.length = 0;
    stack.push(start);
    labels[start] = id;

    while (stack.length > 0) {
      const index = stack.pop()!;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (labels[next] !== UNCLAIMED) continue;
        if (stepBetween(map, index, next) > stepLimit) continue;
        labels[next] = id;
        stack.push(next);
      }
    }

    regions.push({ id, color: averageColor(image, pixels), pixels, neighbours: new Set() });
  }
}

/**
 * How far apart two pixels look, for the fill's local step test.
 *
 * Read straight out of the edge pass's OKLab, on the same times-100 scale as
 * `colorDistance`, so the fill's threshold and the edge threshold are the same
 * number in the same units — with no color conversion in the inner loop.
 */
function stepBetween(map: EdgeMap, one: number, two: number): number {
  return (
    100 *
    Math.hypot(
      map.lab.lightness[one]! - map.lab.lightness[two]!,
      map.lab.greenRed[one]! - map.lab.greenRed[two]!,
      map.lab.blueYellow[one]! - map.lab.blueYellow[two]!,
    )
  );
}

/** The mean color of a run of pixels. */
export function averageColor(image: Bitmap, pixels: readonly number[]): Rgb {
  if (pixels.length === 0) return { r: 0, g: 0, b: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (const index of pixels) {
    const at = index * 4;
    r += image.data[at]!;
    g += image.data[at + 1]!;
    b += image.data[at + 2]!;
  }
  return {
    r: Math.round(r / pixels.length),
    g: Math.round(g / pixels.length),
    b: Math.round(b / pixels.length),
  };
}

/**
 * Give each edge pixel to the region beside it that it looks most like — unless
 * it looks like neither of them.
 *
 * Done in rounds from the outside in, so a boundary two or three pixels thick is
 * peeled rather than left with an unclaimed core.
 *
 * The "unless" is the important half. Nearest-of-its-neighbours on its own is
 * not enough, because *something* is always nearest: a black outline whose every
 * pixel reads as an edge has only the red inside it to be near, and handing it
 * over turns the outline into more red — the ring and its inside come out as one
 * blob and the drawing loses its lines.
 *
 * So a pixel is only claimed when it is closer to a side than the sides are to
 * each other. A boundary pixel that is genuinely a blend of two colors sits
 * about half way between them, which passes; black between red and blue is
 * further from both than they are from one another, which fails, and it is left
 * for `growLeftovers` to make a region of its own. `stepLimit` is the floor, so
 * two nearly equal neighbours do not make every pixel between them suspicious.
 */
function claimEdges(
  map: EdgeMap,
  labels: Int32Array,
  regions: GrownRegion[],
  stepLimit: number,
): void {
  const { width, height } = map;
  const size = width * height;

  // Each round's region colors in OKLab, worked out once for the round rather
  // than once per pixel that looks at them.
  const seen = new Float32Array(regions.length * 3);
  const labelOf = new Int32Array(4);

  for (let round = 0; round < 12; round += 1) {
    for (let id = 0; id < regions.length; id += 1) {
      const color = regions[id]!.color;
      const lab = oklab(color.r, color.g, color.b);
      seen[id * 3] = lab.l;
      seen[id * 3 + 1] = lab.a;
      seen[id * 3 + 2] = lab.b;
    }
    const apart = (one: number, two: number) =>
      100 *
      Math.hypot(
        seen[one * 3]! - seen[two * 3]!,
        seen[one * 3 + 1]! - seen[two * 3 + 1]!,
        seen[one * 3 + 2]! - seen[two * 3 + 2]!,
      );

    const claims: number[] = [];
    for (let index = 0; index < size; index += 1) {
      if (labels[index] !== UNCLAIMED) continue;
      const x = index % width;
      const y = (index - x) / width;
      const own = { l: map.lab.lightness[index]!, a: map.lab.greenRed[index]!, b: map.lab.blueYellow[index]! };

      let found = 0;
      let best = -1;
      let nearest = Infinity;
      for (let side = 0; side < 4; side += 1) {
        const nx = x + (side === 0 ? 1 : side === 1 ? -1 : 0);
        const ny = y + (side === 2 ? 1 : side === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const label = labels[ny * width + nx]!;
        if (label < 0) continue;
        const distance =
          100 *
          Math.hypot(
            own.l - seen[label * 3]!,
            own.a - seen[label * 3 + 1]!,
            own.b - seen[label * 3 + 2]!,
          );
        labelOf[found] = label;
        found += 1;
        if (distance < nearest) {
          nearest = distance;
          best = label;
        }
      }
      if (best < 0) continue;

      // How far apart the sides are. A pixel between them may be at most that
      // far from the nearest of them and still read as one of their boundary.
      let spread = 0;
      for (let one = 0; one < found; one += 1) {
        for (let two = one + 1; two < found; two += 1) {
          if (labelOf[one] === labelOf[two]) continue;
          spread = Math.max(spread, apart(labelOf[one]!, labelOf[two]!));
        }
      }
      if (nearest > Math.max(stepLimit, spread)) continue;
      claims.push(index, best);
    }
    if (claims.length === 0) break;
    // Applied together, so the round does not depend on the order pixels are
    // visited in — a boundary claimed left-to-right would lean left.
    for (let at = 0; at < claims.length; at += 2) {
      const index = claims[at]!;
      const label = claims[at + 1]!;
      labels[index] = label;
      regions[label]!.pixels.push(index);
    }
  }
}

/** Fold anything too small to matter into whichever neighbour it touches most. */
function prune(
  image: Bitmap,
  labels: Int32Array,
  regions: GrownRegion[],
  minArea: number,
  width: number,
  height: number,
): GrownRegion[] {
  if (minArea <= 1) return regions.filter((region) => region.pixels.length > 0);

  const order = [...regions].sort((a, b) => a.pixels.length - b.pixels.length);
  for (const region of order) {
    if (region.pixels.length === 0 || region.pixels.length >= minArea) continue;

    const touching = new Map<number, number>();
    for (const index of region.pixels) {
      const x = index % width;
      const y = (index - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const label = labels[ny * width + nx]!;
        if (label < 0 || label === region.id) continue;
        touching.set(label, (touching.get(label) ?? 0) + 1);
      }
    }

    let host = -1;
    let most = 0;
    for (const [label, shared] of touching) {
      if (regions[label]!.pixels.length === 0) continue;
      if (shared > most) {
        most = shared;
        host = label;
      }
    }
    if (host < 0) continue;

    for (const index of region.pixels) {
      labels[index] = host;
      regions[host]!.pixels.push(index);
    }
    region.pixels = [];
  }

  const kept = regions.filter((region) => region.pixels.length > 0);
  for (const region of kept) region.color = averageColor(image, region.pixels);
  return kept;
}

function findNeighbours(
  labels: Int32Array,
  regions: GrownRegion[],
  width: number,
  height: number,
): void {
  const byId = new Map(regions.map((region) => [region.id, region]));
  for (const region of regions) region.neighbours.clear();

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]!;
    const region = label >= 0 ? byId.get(label) : undefined;
    if (!region) continue;
    const x = index % width;
    const y = (index - x) / width;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        region.neighbours.add(CLEAR);
        continue;
      }
      const other = labels[ny * width + nx]!;
      if (other !== label) region.neighbours.add(other < 0 ? CLEAR : other);
    }
  }
}
