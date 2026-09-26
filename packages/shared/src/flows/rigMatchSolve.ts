import type { Bitmap } from './cutout';
import { fillInto, strokeInto, type Box } from './fit';
import { fromHex } from './palette';
import { boneById, rootBones, type Bone } from './rig';
import type { BoundRig } from './rigBind';
import {
  DEFAULT_RIG_MATCH_OPTIONS,
  bodyBounds,
  bodyPivot,
  fitSignature,
  fittedBones,
  jointLimits,
  restFit,
  wrapAngle,
  type MatchFeature,
  type MatchReport,
  type PartScore,
  type RigFit,
  type RigMatchOptions,
} from './rigMatch';
import { holesOf, type VectorImage, type VectorPoint } from './vector';

/**
 * Finding a bound rig's body in a picture, by small features.
 *
 * 1. **The body's features.** The drawing is painted at rest and each body part
 *    gives small square patches of itself — more for a big part, fewer for a
 *    hand — picked where there is most to see: edges, markings, the outline.
 * 2. **The picture's features.** Patches the same way, all over the picture,
 *    each taken at a range of sizes and turned through a range of angles, so
 *    that a body drawn bigger or leaning is still found.
 * 3. **Comparing.** Every patch becomes a short list of numbers — its embedding:
 *    for each cell of a 4 × 4 grid, the color in OKLab, how much of the cell is
 *    covered, and how much edge there is — and two patches are alike as far as
 *    those numbers are. A body patch is only judged where the body *is*: its
 *    empty corners say nothing about the picture's background.
 * 4. **Placing the body.** Each good match says where the whole body would be —
 *    this patch of chest found here, this big, turned this far — and the
 *    placement most matches agree on wins.
 * 5. **Fitting each part.** From the root down, each part is turned (inside
 *    its joint's range) and sized to where its own features, and the parts
 *    below it, match best. Twice, and the body's placement is tightened between.
 * 6. **Confidence.** Each feature's match where it ended up, measured against
 *    how alike it is to the picture at large: a patch of skin that matches
 *    everywhere is no evidence, one that matches only here is.
 *
 * Deterministic: the same body, picture and settings give the same fit.
 */

/* ------------------------------------------------------------------ *
 * Painting a drawing into pixels
 * ------------------------------------------------------------------ */

export interface PaintOptions {
  /** Where each point of the drawing lands in the bitmap. */
  map?: (point: VectorPoint) => VectorPoint;
  /** How much wider strokes are drawn than their width says. */
  lineScale?: number;
  opacity?: number;
  /** Filled with the index of the top shape covering each pixel, -1 where none does. */
  owners?: Int32Array;
  /** Only these shapes, by id. */
  only?: ReadonlySet<string>;
}

/**
 * Paint a vector drawing over a bitmap, shape by shape in order, compositing
 * each over what is already there.
 */
export function paintVector(target: Bitmap, image: VectorImage, options: PaintOptions = {}): void {
  const { width, height, data } = target;
  const map = options.map ?? ((point: VectorPoint) => point);
  const opacity = options.opacity ?? 1;
  const lineScale = options.lineScale ?? 1;
  image.shapes.forEach((shape, index) => {
    if (options.only && !options.only.has(shape.id)) return;
    const color = fromHex(shape.color);
    if (!color) return;
    const points = shape.points.map(map);
    if (points.length === 0) return;
    const holes = holesOf(shape).map((hole) => hole.map(map));
    const pad = shape.kind === 'line' ? (shape.width * lineScale) / 2 + 2 : 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    const x0 = Math.max(0, Math.floor(minX - pad));
    const y0 = Math.max(0, Math.floor(minY - pad));
    const x1 = Math.min(width, Math.ceil(maxX + pad) + 1);
    const y1 = Math.min(height, Math.ceil(maxY + pad) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    const box: Box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const cover = new Uint8Array(box.width * box.height);
    if (shape.kind === 'polygon') fillInto(points, box, cover, holes);
    else strokeInto(shape.closed && points.length > 2 ? [...points, points[0]!] : points, shape.width * lineScale, box, cover);

    const shapeAlpha = (color.a ?? 255) / 255;
    for (let y = 0; y < box.height; y += 1) {
      for (let x = 0; x < box.width; x += 1) {
        const covered = cover[y * box.width + x]!;
        if (covered === 0) continue;
        const at = (y0 + y) * width + (x0 + x);
        if (options.owners && covered >= 128) options.owners[at] = index;
        const alpha = (covered / 255) * opacity * shapeAlpha;
        const byte = at * 4;
        const under = data[byte + 3]! / 255;
        const out = alpha + under * (1 - alpha);
        if (out <= 0) continue;
        data[byte] = (color.r * alpha + data[byte]! * under * (1 - alpha)) / out;
        data[byte + 1] = (color.g * alpha + data[byte + 1]! * under * (1 - alpha)) / out;
        data[byte + 2] = (color.b * alpha + data[byte + 2]! * under * (1 - alpha)) / out;
        data[byte + 3] = out * 255;
      }
    }
  });
}

export function blankBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) };
}

/* ------------------------------------------------------------------ *
 * Planes: the picture as numbers a patch can be read from
 * ------------------------------------------------------------------ */

/**
 * A picture read once into what a patch is made of: OKLab color, multiplied by
 * opacity so a half-covered pixel blends with nothing rather than with black,
 * and the opacity itself.
 */
export interface Planes {
  width: number;
  height: number;
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  alpha: Float32Array;
}

const LINEAR = new Float32Array(256);
for (let index = 0; index < 256; index += 1) {
  const value = index / 255;
  LINEAR[index] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function planesOf(bitmap: Bitmap): Planes {
  const { width, height, data } = bitmap;
  const size = width * height;
  const L = new Float32Array(size);
  const A = new Float32Array(size);
  const B = new Float32Array(size);
  const alpha = new Float32Array(size);
  for (let at = 0; at < size; at += 1) {
    const byte = at * 4;
    const opacity = data[byte + 3]! / 255;
    alpha[at] = opacity;
    if (opacity === 0) continue;
    const lr = LINEAR[data[byte]!]!;
    const lg = LINEAR[data[byte + 1]!]!;
    const lb = LINEAR[data[byte + 2]!]!;
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    L[at] = (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * opacity;
    A[at] = (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s) * opacity;
    B[at] = (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s) * opacity;
  }
  return { width, height, L, A, B, alpha };
}

/** Half the size, each pixel the average of four. */
function halve(planes: Planes): Planes {
  const width = Math.max(1, Math.floor(planes.width / 2));
  const height = Math.max(1, Math.floor(planes.height / 2));
  const out: Planes = {
    width,
    height,
    L: new Float32Array(width * height),
    A: new Float32Array(width * height),
    B: new Float32Array(width * height),
    alpha: new Float32Array(width * height),
  };
  for (let y = 0; y < height; y += 1) {
    const top = Math.min(planes.height - 1, y * 2);
    const bottom = Math.min(planes.height - 1, y * 2 + 1);
    for (let x = 0; x < width; x += 1) {
      const left = Math.min(planes.width - 1, x * 2);
      const right = Math.min(planes.width - 1, x * 2 + 1);
      const a = top * planes.width + left;
      const b = top * planes.width + right;
      const c = bottom * planes.width + left;
      const d = bottom * planes.width + right;
      const at = y * width + x;
      out.L[at] = (planes.L[a]! + planes.L[b]! + planes.L[c]! + planes.L[d]!) / 4;
      out.A[at] = (planes.A[a]! + planes.A[b]! + planes.A[c]! + planes.A[d]!) / 4;
      out.B[at] = (planes.B[a]! + planes.B[b]! + planes.B[c]! + planes.B[d]!) / 4;
      out.alpha[at] = (planes.alpha[a]! + planes.alpha[b]! + planes.alpha[c]! + planes.alpha[d]!) / 4;
    }
  }
  return out;
}

/**
 * A picture at several sizes, each half the last.
 *
 * A patch is read from the size at which its samples are about a pixel apart,
 * so every sample is the average of what lies around it rather than one pixel
 * picked out of many — and so a patch reads the same whether the body is drawn
 * small or large, which is the whole of what makes size a thing a match can find.
 */
export interface Pyramid {
  levels: Planes[];
  width: number;
  height: number;
  /** Whether the picture has transparent parts worth comparing outlines against. */
  transparent: boolean;
}

export function pyramidOf(bitmap: Bitmap): Pyramid {
  const base = planesOf(bitmap);
  let clear = 0;
  for (let at = 0; at < base.alpha.length; at += 1) if (base.alpha[at]! < 0.98) clear += 1;
  const levels = [base];
  while (levels.length < 6) {
    const last = levels[levels.length - 1]!;
    if (Math.min(last.width, last.height) < 16) break;
    levels.push(halve(last));
  }
  return { levels, width: base.width, height: base.height, transparent: clear > base.alpha.length * 0.02 };
}

/** A change of this much OKLab from one pixel to the next is a full edge. */
const EDGE_FULL = 0.08;

/** How much edge each pixel has, 0..1 — for choosing where the body's features go. */
export function edgeMap(planes: Planes): Float32Array {
  const { width, height, L, A, B, alpha } = planes;
  const edge = new Float32Array(width * height);
  const straight = (plane: Float32Array, at: number) => (alpha[at]! > 1e-4 ? plane[at]! / alpha[at]! : 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      const left = x > 0 ? at - 1 : at;
      const right = x < width - 1 ? at + 1 : at;
      const up = y > 0 ? at - width : at;
      const down = y < height - 1 ? at + width : at;
      const both = Math.min(alpha[left]!, alpha[right]!, alpha[up]!, alpha[down]!);
      let change = 0;
      if (both > 0.05) {
        for (const plane of [L, A, B]) {
          const dx = (straight(plane, right) - straight(plane, left)) / 2;
          const dy = (straight(plane, down) - straight(plane, up)) / 2;
          change += dx * dx + dy * dy;
        }
      }
      const ax = (alpha[right]! - alpha[left]!) / 2;
      const ay = (alpha[down]! - alpha[up]!) / 2;
      change += (ax * ax + ay * ay) * 0.25;
      edge[at] = Math.min(1, Math.sqrt(change) / EDGE_FULL);
    }
  }
  return edge;
}

/** A smaller copy, each pixel the average of the ones it covers — opacity-weighted, so edges do not darken. */
export function shrinkBitmap(bitmap: Bitmap, factor: number): Bitmap {
  if (factor >= 1) return bitmap;
  const width = Math.max(1, Math.round(bitmap.width * factor));
  const height = Math.max(1, Math.round(bitmap.height * factor));
  const out = blankBitmap(width, height);
  const stepX = bitmap.width / width;
  const stepY = bitmap.height / height;
  for (let y = 0; y < height; y += 1) {
    const top = Math.floor(y * stepY);
    const bottom = Math.max(top + 1, Math.floor((y + 1) * stepY));
    for (let x = 0; x < width; x += 1) {
      const left = Math.floor(x * stepX);
      const right = Math.max(left + 1, Math.floor((x + 1) * stepX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const byte = (sy * bitmap.width + sx) * 4;
          const weight = bitmap.data[byte + 3]!;
          r += bitmap.data[byte]! * weight;
          g += bitmap.data[byte + 1]! * weight;
          b += bitmap.data[byte + 2]! * weight;
          a += weight;
          n += 1;
        }
      }
      const byte = (y * width + x) * 4;
      if (a > 0) {
        out.data[byte] = r / a;
        out.data[byte + 1] = g / a;
        out.data[byte + 2] = b / a;
      }
      out.data[byte + 3] = a / n;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Patches and their embeddings
 * ------------------------------------------------------------------ */

/** Cells across a patch, and samples across a cell. */
const GRID = 4;
const SUB = 3;
const SIDE = GRID * SUB;
const CELLS = GRID * GRID;
/** Samples a patch. */
export const SAMPLES = SIDE * SIDE;
/** Numbers a cell: L, a, b, coverage, edge. */
const PER_CELL = 5;
/** Numbers an embedding. */
export const EMBEDDING_SIZE = CELLS * PER_CELL;
/** Numbers a read patch: L, a, b, coverage per sample. */
export const LATTICE_SIZE = SAMPLES * 4;

const LATTICE = new Float32Array(SIDE);
for (let index = 0; index < SIDE; index += 1) LATTICE[index] = ((index + 0.5) / SIDE) * 2 - 1;
const CELL_OF = new Uint8Array(SAMPLES);
for (let j = 0; j < SIDE; j += 1) {
  for (let i = 0; i < SIDE; i += 1) CELL_OF[j * SIDE + i] = Math.floor(j / SUB) * GRID + Math.floor(i / SUB);
}

/**
 * Read one square patch — `radius` from its middle to its edge, turned `angle`
 * degrees — on a 12 × 12 lattice turned with it: straight OKLab color and
 * coverage at each sample, into `out` from `at`.
 *
 * Turned with the patch, so a patch taken turned reads the picture in the
 * patch's own frame: that is what lets a leaning arm in the picture match an
 * upright one in the drawing.
 */
export function readPatch(pyramid: Pyramid, cx: number, cy: number, radius: number, angle: number, out: Float32Array, at = 0): void {
  const spacing = (radius * 2) / SIDE;
  const level = Math.max(0, Math.min(pyramid.levels.length - 1, Math.floor(Math.log2(Math.max(1, spacing)))));
  const planes = pyramid.levels[level]!;
  const { width, height, L, A, B, alpha } = planes;
  const shrink = 1 / 2 ** level;
  const turn = (angle * Math.PI) / 180;
  const cos = Math.cos(turn) * radius;
  const sin = Math.sin(turn) * radius;
  for (let j = 0; j < SIDE; j += 1) {
    const v = LATTICE[j]!;
    for (let i = 0; i < SIDE; i += 1) {
      const u = LATTICE[i]!;
      const sample = at + (j * SIDE + i) * 4;
      const x = (cx + u * cos - v * sin) * shrink - 0.5;
      const y = (cy + u * sin + v * cos) * shrink - 0.5;
      if (x < -0.5 || y < -0.5 || x > width - 0.5 || y > height - 0.5) {
        out[sample] = 0;
        out[sample + 1] = 0;
        out[sample + 2] = 0;
        out[sample + 3] = 0;
        continue;
      }
      const cxp = Math.max(0, Math.min(width - 1, x));
      const cyp = Math.max(0, Math.min(height - 1, y));
      const fx = Math.min(width - 2 < 0 ? 0 : width - 2, Math.floor(cxp));
      const fy = Math.min(height - 2 < 0 ? 0 : height - 2, Math.floor(cyp));
      const tx = width > 1 ? cxp - fx : 0;
      const ty = height > 1 ? cyp - fy : 0;
      const p00 = fy * width + fx;
      const p10 = width > 1 ? p00 + 1 : p00;
      const p01 = height > 1 ? p00 + width : p00;
      const p11 = width > 1 ? p01 + 1 : p01;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const covered = alpha[p00]! * w00 + alpha[p10]! * w10 + alpha[p01]! * w01 + alpha[p11]! * w11;
      if (covered > 1e-4) {
        out[sample] = (L[p00]! * w00 + L[p10]! * w10 + L[p01]! * w01 + L[p11]! * w11) / covered;
        out[sample + 1] = (A[p00]! * w00 + A[p10]! * w10 + A[p01]! * w01 + A[p11]! * w11) / covered;
        out[sample + 2] = (B[p00]! * w00 + B[p10]! * w10 + B[p01]! * w01 + B[p11]! * w11) / covered;
      } else {
        out[sample] = 0;
        out[sample + 1] = 0;
        out[sample + 2] = 0;
      }
      out[sample + 3] = covered;
    }
  }
}

/** A change of this much OKLab between neighbouring samples is a full edge. */
const LATTICE_EDGE_FULL = 0.06;

/**
 * How much edge there is at each sample of a read patch, 0..1: how fast color
 * or coverage changes from one sample to the next.
 *
 * Measured on the lattice rather than on the picture's pixels, so an outline
 * is the same width in a patch whatever size the body is drawn at.
 */
export function patchEdges(patch: Float32Array, out: Float32Array, at = 0, into = 0): void {
  const value = (i: number, j: number, channel: number) => patch[at + (j * SIDE + i) * 4 + channel]!;
  for (let j = 0; j < SIDE; j += 1) {
    const up = Math.max(0, j - 1);
    const down = Math.min(SIDE - 1, j + 1);
    const spanY = down - up;
    for (let i = 0; i < SIDE; i += 1) {
      const left = Math.max(0, i - 1);
      const right = Math.min(SIDE - 1, i + 1);
      const spanX = right - left;
      let change = 0;
      const colorX = Math.min(value(left, j, 3), value(right, j, 3));
      const colorY = Math.min(value(i, up, 3), value(i, down, 3));
      for (let channel = 0; channel < 3; channel += 1) {
        const dx = ((value(right, j, channel) - value(left, j, channel)) / spanX) * colorX;
        const dy = ((value(i, down, channel) - value(i, up, channel)) / spanY) * colorY;
        change += dx * dx + dy * dy;
      }
      const ax = (value(right, j, 3) - value(left, j, 3)) / spanX;
      const ay = (value(i, down, 3) - value(i, up, 3)) / spanY;
      change += (ax * ax + ay * ay) * 0.25;
      out[into + j * SIDE + i] = Math.min(1, Math.sqrt(change) / LATTICE_EDGE_FULL);
    }
  }
}

/**
 * The embedding of a read patch: for each of the 4 × 4 cells, its color, how
 * much of it is covered, and how much edge it has. `mask`, when given, is how
 * much each sample belongs to the part the patch describes — color and
 * coverage then come from those samples only.
 */
export function embedPatch(
  patch: Float32Array,
  edges: Float32Array,
  mask: Float32Array | null,
  out: Float32Array,
  at: number,
  patchAt = 0,
  edgesAt = 0,
  maskAt = 0,
): void {
  for (let index = 0; index < EMBEDDING_SIZE; index += 1) out[at + index] = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const cell = at + CELL_OF[sample]! * PER_CELL;
    const base = patchAt + sample * 4;
    const weight = mask ? mask[maskAt + sample]! : patch[base + 3]!;
    out[cell] = out[cell]! + patch[base]! * weight;
    out[cell + 1] = out[cell + 1]! + patch[base + 1]! * weight;
    out[cell + 2] = out[cell + 2]! + patch[base + 2]! * weight;
    out[cell + 3] = out[cell + 3]! + weight;
    out[cell + 4] = out[cell + 4]! + edges[edgesAt + sample]!;
  }
  const samples = SUB * SUB;
  for (let cell = 0; cell < CELLS; cell += 1) {
    const base = at + cell * PER_CELL;
    const covered = out[base + 3]!;
    if (covered > 1e-4) {
      out[base] = out[base]! / covered;
      out[base + 1] = out[base + 1]! / covered;
      out[base + 2] = out[base + 2]! / covered;
    }
    out[base + 3] = covered / samples;
    out[base + 4] = out[base + 4]! / samples;
  }
}

/** A color this far apart (OKLab, squared) or more is simply different. */
const COLOR_CAP = 0.09;
/** How quickly color difference costs likeness. */
const COLOR_SCALE = 0.015;
const EDGE_WEIGHT = 3;

/**
 * How alike a body feature's embedding and a picture patch's are, 0 to 1 —
 * the quick comparison, cell by cell, used to find where each feature might be.
 *
 * Only where the body feature has its own part: color is compared cell by
 * cell, weighted by how much of the cell is that part, and a cell of body over
 * empty picture counts as far apart as colors get. Edges are compared in the
 * same cells, so an outline or a marking has to be where the drawing has it.
 */
export function likeness(body: Float32Array, bodyAt: number, picture: Float32Array, pictureAt: number): number {
  let weight = 0;
  let color = 0;
  let edges = 0;
  for (let cell = 0; cell < CELLS; cell += 1) {
    const r = bodyAt + cell * PER_CELL;
    const covered = body[r + 3]!;
    if (covered <= 0.02) continue;
    const g = pictureAt + cell * PER_CELL;
    const there = picture[g + 3]!;
    const dl = body[r]! - picture[g]!;
    const da = body[r + 1]! - picture[g + 1]!;
    const db = body[r + 2]! - picture[g + 2]!;
    const apart = Math.min(COLOR_CAP, dl * dl + da * da + db * db);
    // Only coverage the picture lacks counts against it: a cell half covered
    // by the part matches a cell half covered in the picture.
    const missing = Math.max(0, covered - there);
    color += (covered - missing) * apart + missing * COLOR_CAP;
    const de = body[r + 4]! - picture[g + 4]!;
    edges += covered * de * de;
    weight += covered;
  }
  if (weight < 0.05) return 0;
  return Math.exp(-(color / weight / COLOR_SCALE + (EDGE_WEIGHT * edges) / weight));
}

/**
 * How alike a body feature and a patch of the picture are, sample by sample —
 * the exact comparison, used to judge a pose. Color where the feature's own
 * part is, edges on the part and just outside it.
 */
export function fineLikeness(body: BodyModel, feature: number, patch: Float32Array, edges: Float32Array): number {
  const maskAt = feature * SAMPLES;
  const patchAt = feature * LATTICE_SIZE;
  let weight = 0;
  let color = 0;
  let edgeWeight = 0;
  let edge = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const mine = body.masks[maskAt + sample]!;
    if (mine > 0) {
      const b = patchAt + sample * 4;
      const t = sample * 4;
      const there = patch[t + 3]!;
      const expected = Math.max(1e-3, body.patches[b + 3]!);
      const dl = body.patches[b]! - patch[t]!;
      const da = body.patches[b + 1]! - patch[t + 1]!;
      const db = body.patches[b + 2]! - patch[t + 2]!;
      const apart = Math.min(COLOR_CAP, dl * dl + da * da + db * db);
      // As covered as the body is there counts as covered: an outline's
      // half-covered samples are matched by the same half in the picture.
      const missing = Math.max(0, expected - there) / expected;
      color += mine * ((1 - missing) * apart + missing * COLOR_CAP);
      weight += mine;
    }
    const counts = body.edgeWeights[maskAt + sample]!;
    if (counts > 0) {
      const d = body.edges[maskAt + sample]! - edges[sample]!;
      edge += counts * d * d;
      edgeWeight += counts;
    }
  }
  if (weight < 1) return 0;
  return Math.exp(-(color / weight / COLOR_SCALE + (edgeWeight > 0 ? (EDGE_WEIGHT * edge) / edgeWeight : 0)));
}

/* ------------------------------------------------------------------ *
 * The body's features
 * ------------------------------------------------------------------ */

export interface BodyFeature {
  bone: string;
  /** Where it is in the bound rig's space, at rest. */
  x: number;
  y: number;
  /** How much it counts, 0.5 to 1: more when the patch is mostly its own part. */
  weight: number;
}

export interface BodyModel {
  features: BodyFeature[];
  /** Their embeddings, `EMBEDDING_SIZE` numbers each. */
  embeddings: Float32Array;
  /** Each feature's patch as read, `LATTICE_SIZE` numbers each. */
  patches: Float32Array;
  /** How much each sample of each patch is the feature's own part, `SAMPLES` each. */
  masks: Float32Array;
  /** Edge at each sample, and how much each sample's edge counts (its own part, and just outside it). */
  edges: Float32Array;
  edgeWeights: Float32Array;
  /** Patch radius in the bound rig's units. */
  radius: number;
  pivot: VectorPoint;
  /** How much of the body each part covers, in rig units squared. */
  areas: Map<string, number>;
  /** The body painted at rest, for showing what was taken. */
  paint: Bitmap;
  /** Rig units to the painted body's pixels. */
  paintScale: number;
  paintOrigin: VectorPoint;
}

/** The body is painted this many pixels across its longer side. */
const BODY_PIXELS = 256;
/** A feature patch's radius, as a share of the body's longer side. */
export const FEATURE_RADIUS = 0.075;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Paint the body at rest and take its features.
 *
 * Each pixel of the painting belongs to a part: the part of the shape on top
 * there, or — for a shape whose points follow several bones, an arm drawn as
 * one polygon — whichever of those bones is nearest. Each part then gives
 * `features` patches, scaled by the square root of how big the part is against
 * the average, never fewer than two; they are picked greedily where the most
 * edge is, spaced apart so they do not all describe the same corner.
 */
export function bodyModel(bound: BoundRig, featuresPerPart: number): BodyModel {
  const box = bodyBounds(bound);
  const longest = Math.max(box.width, box.height, 1e-6);
  const scale = BODY_PIXELS / longest;
  const pad = Math.ceil(BODY_PIXELS * 0.12);
  const width = Math.ceil(box.width * scale) + pad * 2;
  const height = Math.ceil(box.height * scale) + pad * 2;
  const origin = { x: box.x - pad / scale, y: box.y - pad / scale };
  const toPaint = (point: VectorPoint): VectorPoint => ({ x: (point.x - origin.x) * scale, y: (point.y - origin.y) * scale });

  const paint = blankBitmap(width, height);
  const owners = new Int32Array(width * height).fill(-1);
  const only = new Set(Object.keys(bound.points));
  paintVector(paint, bound.image, { map: toPaint, lineScale: scale, owners, only });
  const pyramid = pyramidOf(paint);
  const edgeAt = edgeMap(pyramid.levels[0]!);

  // Which bone each painted pixel belongs to.
  const bones = bound.rig.bones;
  const boneIndex = new Map(bones.map((bone, index) => [bone.id, index]));
  const rest = restPoseOf(bound);
  const segments = bones.map((bone) => {
    const place = rest.get(bone.id)!;
    const from = toPaint(place.from);
    const to = toPaint(place.to);
    return [from.x, from.y, to.x, to.y] as const;
  });
  const bonesOfShape = bound.image.shapes.map((shape) => {
    const list = bound.points[shape.id];
    return list ? [...new Set(list.filter((id): id is string => id !== null && boneIndex.has(id)))].map((id) => boneIndex.get(id)!) : [];
  });
  const part = new Int16Array(width * height).fill(-1);
  const areas = new Float64Array(bones.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      const shape = owners[at]!;
      if (shape < 0) continue;
      const candidates = bonesOfShape[shape]!;
      if (candidates.length === 0) continue;
      let best = candidates[0]!;
      if (candidates.length > 1) {
        let nearest = Infinity;
        for (const candidate of candidates) {
          const s = segments[candidate]!;
          const distance = distanceToSegment(x + 0.5, y + 0.5, s[0], s[1], s[2], s[3]);
          if (distance < nearest) {
            nearest = distance;
            best = candidate;
          }
        }
      }
      part[at] = best;
      areas[best] = areas[best]! + 1;
    }
  }

  const radiusPx = Math.max(4, BODY_PIXELS * FEATURE_RADIUS);
  const present = [...areas].filter((area) => area > 0);
  const meanArea = present.length > 0 ? present.reduce((sum, area) => sum + area, 0) / present.length : 1;
  const perPart = Math.max(1, Math.round(featuresPerPart));

  const features: BodyFeature[] = [];
  const stride = 3;
  bones.forEach((bone, index) => {
    const area = areas[index]!;
    if (area < 6) return;
    const count = Math.max(2, Math.min(perPart * 3, Math.round(perPart * Math.sqrt(area / meanArea))));
    // Candidates on a lattice, scored by the edge around them.
    const candidates: Array<{ x: number; y: number; score: number }> = [];
    for (let y = 1; y < height - 1; y += stride) {
      for (let x = 1; x < width - 1; x += stride) {
        if (part[y * width + x] !== index) continue;
        let around = 0;
        for (let dy = -2; dy <= 2; dy += 1) {
          const row = Math.min(height - 1, Math.max(0, y + dy * 2)) * width;
          for (let dx = -2; dx <= 2; dx += 1) around += edgeAt[row + Math.min(width - 1, Math.max(0, x + dx * 2))]!;
        }
        candidates.push({ x: x + 0.5, y: y + 0.5, score: around / 25 + 0.15 });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    const picked: Array<{ x: number; y: number }> = [];
    for (const spacing of [0.9, 0.45, 0.2]) {
      for (const candidate of candidates) {
        if (picked.length >= count) break;
        const gap = spacing * radiusPx;
        if (picked.some((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) < gap)) continue;
        picked.push(candidate);
      }
      if (picked.length >= count) break;
    }
    for (const point of picked) {
      // How much of its patch is its own part.
      let own = 0;
      let samples = 0;
      for (let j = -3; j <= 3; j += 1) {
        for (let i = -3; i <= 3; i += 1) {
          const sx = Math.round(point.x + (i / 3) * radiusPx);
          const sy = Math.round(point.y + (j / 3) * radiusPx);
          samples += 1;
          if (sx >= 0 && sy >= 0 && sx < width && sy < height && part[sy * width + sx] === index) own += 1;
        }
      }
      features.push({
        bone: bone.id,
        x: point.x / scale + origin.x,
        y: point.y / scale + origin.y,
        weight: 0.5 + (0.5 * own) / samples,
      });
    }
  });

  /*
   * Each feature's patch, read the same way a picture's is, with a mask of the
   * samples that are its own part.
   *
   * The rest of the patch is not background — it is other parts, which will be
   * somewhere else once the body has moved. A patch of shin taken at rest has
   * the other shin beside it; in the picture that leg has stepped away, and a
   * patch that expected it there would never match its own shin. So another
   * part's samples are left out, as unknown, rather than compared. Edges are
   * kept whoever makes them — they are what is seen — but only counted on the
   * part and just outside it, where its own outline is.
   */
  const n = features.length;
  const embeddings = new Float32Array(n * EMBEDDING_SIZE);
  const patches = new Float32Array(n * LATTICE_SIZE);
  const masks = new Float32Array(n * SAMPLES);
  const edges = new Float32Array(n * SAMPLES);
  const edgeWeights = new Float32Array(n * SAMPLES);
  const spacing = (radiusPx * 2) / SIDE;
  const reach = Math.max(0, Math.floor(spacing / 2));
  features.forEach((feature, index) => {
    const at = toPaint(feature);
    const own = boneIndex.get(feature.bone)!;
    readPatch(pyramid, at.x, at.y, radiusPx, 0, patches, index * LATTICE_SIZE);
    patchEdges(patches, edges, index * LATTICE_SIZE, index * SAMPLES);
    for (let j = 0; j < SIDE; j += 1) {
      for (let i = 0; i < SIDE; i += 1) {
        const sx = Math.floor(at.x + LATTICE[i]! * radiusPx);
        const sy = Math.floor(at.y + LATTICE[j]! * radiusPx);
        let mine = 0;
        let seen = 0;
        for (let dy = -reach; dy <= reach; dy += 1) {
          for (let dx = -reach; dx <= reach; dx += 1) {
            const x = sx + dx;
            const y = sy + dy;
            seen += 1;
            if (x >= 0 && y >= 0 && x < width && y < height && part[y * width + x] === own) mine += 1;
          }
        }
        masks[index * SAMPLES + j * SIDE + i] = mine / seen;
      }
    }
    for (let j = 0; j < SIDE; j += 1) {
      for (let i = 0; i < SIDE; i += 1) {
        let most = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const x = i + dx;
            const y = j + dy;
            if (x >= 0 && y >= 0 && x < SIDE && y < SIDE) most = Math.max(most, masks[index * SAMPLES + y * SIDE + x]!);
          }
        }
        edgeWeights[index * SAMPLES + j * SIDE + i] = most;
      }
    }
    embedPatch(patches, edges, masks, embeddings, index * EMBEDDING_SIZE, index * LATTICE_SIZE, index * SAMPLES, index * SAMPLES);
  });

  const areaByBone = new Map<string, number>();
  bones.forEach((bone, index) => {
    if (areas[index]! > 0) areaByBone.set(bone.id, areas[index]! / (scale * scale));
  });

  return {
    features,
    embeddings,
    patches,
    masks,
    edges,
    edgeWeights,
    radius: radiusPx / scale,
    pivot: bodyPivot(bound),
    areas: areaByBone,
    paint,
    paintScale: scale,
    paintOrigin: origin,
  };
}

function restPoseOf(bound: BoundRig) {
  const bones = fittedBones(bound.rig, { pivot: { x: 0, y: 0 }, x: 0, y: 0, scale: 1, rotation: 0, angles: {}, sizes: {} });
  const out = new Map<string, { from: VectorPoint; to: VectorPoint }>();
  for (const [id, bone] of bones) out.set(id, { from: bone.restFrom, to: bone.to });
  return out;
}

/* ------------------------------------------------------------------ *
 * The picture
 * ------------------------------------------------------------------ */

/** The picture is worked on at most this many pixels across its longer side. */
const PICTURE_PIXELS = 384;

export interface PictureModel {
  pyramid: Pyramid;
  /** Working pixels per pixel of the picture as it is. */
  factor: number;
  width: number;
  height: number;
}

export function pictureModel(bitmap: Bitmap): PictureModel {
  const factor = Math.min(1, PICTURE_PIXELS / Math.max(bitmap.width, bitmap.height, 1));
  return { pyramid: pyramidOf(shrinkBitmap(bitmap, factor)), factor, width: bitmap.width, height: bitmap.height };
}

/**
 * Where the body most likely is before anything is matched: over whatever is
 * not transparent, if the picture has transparency, and otherwise filling it.
 */
export function firstGuess(bound: BoundRig, picture: PictureModel): RigFit {
  const planes = picture.pyramid.levels[0]!;
  const transparent = picture.pyramid.transparent;
  let area = { x: 0, y: 0, width: planes.width, height: planes.height };
  if (transparent) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < planes.height; y += 1) {
      for (let x = 0; x < planes.width; x += 1) {
        if (planes.alpha[y * planes.width + x]! < 0.5) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX > minX && maxY > minY) area = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
  const fit = restFit(bound, { width: area.width, height: area.height }, transparent ? 0.01 : 0.05);
  return { ...fit, x: (area.x + fit.x) / picture.factor, y: (area.y + fit.y) / picture.factor, scale: fit.scale / picture.factor };
}

/* ------------------------------------------------------------------ *
 * The picture's features
 * ------------------------------------------------------------------ */

export interface PictureFeatures {
  count: number;
  /** Middle, radius (working pixels) and angle of each. */
  x: Float32Array;
  y: Float32Array;
  radius: Float32Array;
  angle: Float32Array;
  embeddings: Float32Array;
  sizes: number[];
  angles: number[];
}

/** Most picture features taken, so a big range does not run out of memory. */
const MOST_PICTURE_FEATURES = 60000;

/** The sizes features are taken at, as multiples of the first guess: geometric, from 1/range to range. */
export function featureSizes(range: number): number[] {
  const span = Math.max(1, range);
  if (span <= 1.001) return [1];
  const steps = Math.max(1, Math.min(4, Math.ceil(Math.log(span) / Math.log(1.3))));
  const out: number[] = [];
  for (let step = -steps; step <= steps; step += 1) out.push(span ** (step / steps));
  return out;
}

/** The angles features are turned to, degrees, about a middle angle. */
export function featureAngles(range: number, middle = 0): number[] {
  const span = Math.max(0, Math.min(180, range));
  if (span < 1) return [middle];
  const step = span >= 30 ? 15 : Math.max(5, span / 2);
  const out: number[] = [];
  const count = Math.floor(span / step + 1e-9);
  for (let index = -count; index <= count; index += 1) {
    const angle = wrapAngle(middle + index * step);
    // Round the circle once: -180 and 180 are the same patch.
    if (!out.some((existing) => Math.abs(wrapAngle(existing - angle)) < 1e-6)) out.push(angle);
  }
  return out;
}

export function pictureFeatures(
  picture: PictureModel,
  radius: number,
  options: Pick<RigMatchOptions, 'scaleRange' | 'angleRange'>,
  middleAngle = 0,
  most = MOST_PICTURE_FEATURES,
): PictureFeatures {
  const planes = picture.pyramid.levels[0]!;
  const transparent = picture.pyramid.transparent;
  const sizes = featureSizes(options.scaleRange);
  const angles = featureAngles(options.angleRange, middleAngle);
  let step = Math.max(2, radius * 0.6);
  const positionsFor = (gap: number) => Math.ceil(planes.width / gap) * Math.ceil(planes.height / gap);
  while (positionsFor(step) * sizes.length * angles.length > most) step *= 1.15;

  const positions: Array<[number, number]> = [];
  for (let y = step / 2; y < planes.height; y += step) {
    for (let x = step / 2; x < planes.width; x += step) {
      // Nothing to find where the picture is empty all round.
      if (transparent && planes.alpha[Math.floor(y) * planes.width + Math.floor(x)]! < 0.02) {
        let near = false;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const sx = Math.floor(x + dx * radius);
          const sy = Math.floor(y + dy * radius);
          if (sx >= 0 && sy >= 0 && sx < planes.width && sy < planes.height && planes.alpha[sy * planes.width + sx]! > 0.02) near = true;
        }
        if (!near) continue;
      }
      positions.push([x, y]);
    }
  }
  const count = positions.length * sizes.length * angles.length;
  const out: PictureFeatures = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    radius: new Float32Array(count),
    angle: new Float32Array(count),
    embeddings: new Float32Array(count * EMBEDDING_SIZE),
    sizes,
    angles,
  };
  const patch = new Float32Array(LATTICE_SIZE);
  const edges = new Float32Array(SAMPLES);
  let index = 0;
  for (const [x, y] of positions) {
    for (const size of sizes) {
      for (const angle of angles) {
        out.x[index] = x;
        out.y[index] = y;
        out.radius[index] = radius * size;
        out.angle[index] = angle;
        readPatch(picture.pyramid, x, y, radius * size, angle, patch);
        patchEdges(patch, edges);
        embedPatch(patch, edges, null, out.embeddings, index * EMBEDDING_SIZE);
        index += 1;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** The best few places each body feature was found, and how alike it is to the picture on average. */
interface Candidates {
  /** Picture feature indices, best first, `KEEP` per body feature (-1 where fewer). */
  best: Int32Array;
  likeness: Float32Array;
  /** Mean likeness to every picture feature: what "found anywhere" looks like. */
  background: Float32Array;
  top: Float32Array;
}

const KEEP = 6;

function compare(body: BodyModel, picture: PictureFeatures, progress: (fraction: number) => void): Candidates {
  const n = body.features.length;
  const best = new Int32Array(n * KEEP).fill(-1);
  const likes = new Float32Array(n * KEEP);
  const background = new Float32Array(n);
  const top = new Float32Array(n);
  const order = new Uint8Array(CELLS);
  const covered = new Float32Array(CELLS);
  for (let f = 0; f < n; f += 1) {
    const bodyAt = f * EMBEDDING_SIZE;
    // The feature's own cells, most covered first, so a poor match shows early.
    let total = 0;
    let cells = 0;
    for (let cell = 0; cell < CELLS; cell += 1) covered[cell] = body.embeddings[bodyAt + cell * PER_CELL + 3]!;
    const ranked = [...Array(CELLS).keys()].filter((cell) => covered[cell]! > 0.02).sort((a, b) => covered[b]! - covered[a]!);
    for (const cell of ranked) {
      order[cells] = cell;
      cells += 1;
      total += covered[cell]!;
    }
    const base = f * KEEP;
    if (total < 0.05) continue;
    let sum = 0;
    let sampled = 0;
    for (let g = 0; g < picture.count; g += 1) {
      const pictureAt = g * EMBEDDING_SIZE;
      // What a match must beat to be kept: its cost may not pass this.
      const floor = likes[base + KEEP - 1]!;
      const counted = g % 4 === 0;
      const limit = counted || floor <= 0 ? Infinity : -Math.log(floor) * total;
      let cost = 0;
      for (let at = 0; at < cells; at += 1) {
        const cell = order[at]!;
        const r = bodyAt + cell * PER_CELL;
        const q = pictureAt + cell * PER_CELL;
        const weight = covered[cell]!;
        const there = picture.embeddings[q + 3]!;
        const dl = body.embeddings[r]! - picture.embeddings[q]!;
        const da = body.embeddings[r + 1]! - picture.embeddings[q + 1]!;
        const db = body.embeddings[r + 2]! - picture.embeddings[q + 2]!;
        const apart = Math.min(COLOR_CAP, dl * dl + da * da + db * db);
        const de = body.embeddings[r + 4]! - picture.embeddings[q + 4]!;
        const missing = Math.max(0, weight - there);
        cost += ((weight - missing) * apart + missing * COLOR_CAP) / COLOR_SCALE + weight * EDGE_WEIGHT * de * de;
        if (cost > limit) break;
      }
      if (cost > limit) continue;
      const alike = Math.exp(-cost / total);
      if (counted) {
        sum += alike;
        sampled += 1;
      }
      if (alike <= floor) continue;
      // Insert, best first.
      let slot = KEEP - 1;
      while (slot > 0 && likes[base + slot - 1]! < alike) {
        likes[base + slot] = likes[base + slot - 1]!;
        best[base + slot] = best[base + slot - 1]!;
        slot -= 1;
      }
      likes[base + slot] = alike;
      best[base + slot] = g;
    }
    background[f] = sampled > 0 ? sum / sampled : 0;
    top[f] = likes[base]!;
    if (f % 8 === 7) progress((f + 1) / n);
  }
  return { best, likeness: likes, background, top };
}

/** Where each body feature lands under a fit: middle, radius and angle, in the fit's own pixels. */
export interface PlacedFeatures {
  x: Float32Array;
  y: Float32Array;
  radius: Float32Array;
  angle: Float32Array;
}

export function placeFeatures(bound: BoundRig, body: BodyModel, fit: RigFit, only?: readonly number[]): PlacedFeatures {
  const n = body.features.length;
  const out: PlacedFeatures = { x: new Float32Array(n), y: new Float32Array(n), radius: new Float32Array(n), angle: new Float32Array(n) };
  const bones = fittedBones(bound.rig, fit);
  const g = (fit.rotation * Math.PI) / 180;
  const gcos = Math.cos(g) * fit.scale;
  const gsin = Math.sin(g) * fit.scale;
  const place = (index: number) => {
    const feature = body.features[index]!;
    const bone = bones.get(feature.bone);
    if (!bone) return;
    const turn = (bone.posedAngle * Math.PI) / 180;
    const cos = Math.cos(turn) * bone.size;
    const sin = Math.sin(turn) * bone.size;
    const dx = feature.x - bone.restFrom.x;
    const dy = feature.y - bone.restFrom.y;
    const gx = bone.posedFrom.x + dx * cos - dy * sin - fit.pivot.x;
    const gy = bone.posedFrom.y + dx * sin + dy * cos - fit.pivot.y;
    out.x[index] = fit.x + gx * gcos - gy * gsin;
    out.y[index] = fit.y + gx * gsin + gy * gcos;
    out.radius[index] = body.radius * fit.scale * bone.size;
    out.angle[index] = bone.angle;
  };
  if (only) for (const index of only) place(index);
  else for (let index = 0; index < n; index += 1) place(index);
  return out;
}

interface Scorer {
  /** Each feature's likeness where the fit puts it. */
  likenessAt(fit: RigFit, features?: readonly number[]): Float32Array;
}

/** A fit in the picture's pixels, moved into the working pixels the picture is matched in. */
function workingFit(fit: RigFit, factor: number): RigFit {
  return { ...fit, x: fit.x * factor, y: fit.y * factor, scale: fit.scale * factor };
}

function scorer(bound: BoundRig, body: BodyModel, picture: PictureModel): Scorer {
  const patch = new Float32Array(LATTICE_SIZE);
  const edges = new Float32Array(SAMPLES);
  return {
    likenessAt(fit, only) {
      const placed = placeFeatures(bound, body, workingFit(fit, picture.factor), only);
      const out = new Float32Array(body.features.length);
      const indices = only ?? body.features.map((_, index) => index);
      for (const index of indices) {
        if (placed.radius[index] === 0) continue;
        readPatch(picture.pyramid, placed.x[index]!, placed.y[index]!, placed.radius[index]!, placed.angle[index]!, patch);
        patchEdges(patch, edges);
        out[index] = fineLikeness(body, index, patch, edges);
      }
      return out;
    },
  };
}

function weightedMean(values: Float32Array, body: BodyModel, indices: readonly number[], weights?: readonly number[]): number {
  let sum = 0;
  let total = 0;
  indices.forEach((index, at) => {
    const weight = body.features[index]!.weight * (weights?.[at] ?? 1);
    sum += values[index]! * weight;
    total += weight;
  });
  return total > 0 ? sum / total : 0;
}

/**
 * The mean of the best-matching share of the features, by weight.
 *
 * For placing the whole body before its parts are fitted: an arm raised in the
 * picture and hanging at rest in the body matches nowhere, and an average over
 * every feature would drag the whole body towards a compromise with it. The
 * trunk matches well wherever the body really is, so the best part of the
 * evidence is what decides the placement.
 */
function robustMean(values: Float32Array, body: BodyModel, share = 0.6): number {
  const order = body.features.map((_, index) => index).sort((a, b) => values[b]! - values[a]!);
  const total = body.features.reduce((sum, feature) => sum + feature.weight, 0);
  let taken = 0;
  let sum = 0;
  for (const index of order) {
    if (taken >= total * share) break;
    const weight = body.features[index]!.weight;
    sum += values[index]! * weight;
    taken += weight;
  }
  return taken > 0 ? sum / taken : 0;
}

/* ------------------------------------------------------------------ *
 * The whole match
 * ------------------------------------------------------------------ */

export interface MatchProgress {
  stage: string;
  /** 0..1 over the whole match. */
  fraction: number;
}

export interface MatchInput {
  bound: BoundRig;
  picture: Bitmap;
  options?: Partial<RigMatchOptions>;
  /**
   * Start from this fit rather than from a guess: the body is not searched for
   * across the picture, only tightened from here. For after placing it roughly
   * by hand.
   */
  from?: RigFit;
  onProgress?(progress: MatchProgress): void;
  /** Cached work from an earlier call with the same body and picture. */
  cache?: MatchCache;
  /** Told the fit after each stage, for looking into a match. */
  onStage?(stage: string, fit: RigFit): void;
}

/** What can be kept between matches of the same body against the same picture. */
export interface MatchCache {
  key?: string;
  body?: BodyModel;
  picture?: PictureModel;
  /** Each body feature's likeness to the picture at large, from the last match, by the settings it was made with. */
  background?: { key: string; values: Float32Array };
}

const backgroundKey = (options: RigMatchOptions) => `${options.features}|${options.scaleRange}|${options.angleRange}`;

export interface MatchResult {
  fit: RigFit;
  report: MatchReport;
}

/**
 * Find the body in the picture.
 *
 * Throws when there is nothing to match: no bound shapes, or an empty picture.
 */
export function matchRig(input: MatchInput): MatchResult {
  const started = Date.now();
  const options: RigMatchOptions = { ...DEFAULT_RIG_MATCH_OPTIONS, ...input.options };
  const say = (stage: string, fraction: number) => input.onProgress?.({ stage, fraction: Math.max(0, Math.min(1, fraction)) });
  const notes: string[] = [];

  say('Painting the body', 0);
  const { body, picture } = prepare(input, options);
  if (body.features.length === 0) throw new Error('The body gave no features: nothing in the drawing is bound to a bone.');
  const score = scorer(input.bound, body, picture);
  const all = body.features.map((_, index) => index);

  // The guess, and the size a feature is in the picture at that guess.
  let fit: RigFit = input.from ? { ...input.from, pivot: body.pivot } : firstGuess(input.bound, picture);
  if (input.from) fit = rebasePivot(fit, input.from.pivot, body.pivot);
  const radius = body.radius * fit.scale * picture.factor;

  say('Taking the picture’s features', 0.06);
  const features = pictureFeatures(picture, radius, options, input.from ? fit.rotation : 0);
  if (features.count === 0) throw new Error('The picture gave no features to match against.');

  say('Comparing features', 0.2);
  const candidates = compare(body, features, (fraction) => say('Comparing features', 0.2 + fraction * 0.45));
  if (input.cache) input.cache.background = { key: backgroundKey(options), values: candidates.background };

  say('Placing the body', 0.66);
  const placed = placeBody(body, features, candidates, picture, fit, options, score, Boolean(input.from));
  let agreeing = placed.agreeing;
  if (placed.fit) fit = { ...placed.fit, angles: fit.angles, sizes: fit.sizes };
  else if (!input.from) notes.push('Too few features agreed on where the body is, so the search started from the middle of the picture.');
  input.onStage?.('placed', fit);

  input.onStage?.('start', fit);
  say('Fitting each part', 0.72);
  fit = fitParts(input.bound, body, fit, options, score, (fraction) => say('Fitting each part', 0.72 + fraction * 0.26));

  say('Measuring confidence', 0.98);
  const report = judge(input.bound, body, fit, candidates.background, score);
  const matchedAt = score.likenessAt(fit);
  if (input.from || agreeing === 0) agreeing = countAgreeing(input.bound, body, features, candidates, fit, picture);
  if (all.length > 0 && weightedMean(matchedAt, body, all) < 0.2) {
    notes.push('The body matches the picture poorly everywhere. Is this the same character, drawn the same way?');
  }
  say('Done', 1);
  return {
    fit,
    report: {
      ...report,
      rigFeatures: body.features.length,
      imageFeatures: features.count,
      agreeing,
      ms: Date.now() - started,
      at: new Date().toISOString(),
      notes,
    },
  };
}

/**
 * Score a fit without moving it — for a fit adjusted by hand.
 */
export function scoreFit(input: Omit<MatchInput, 'from'> & { fit: RigFit }): MatchReport {
  const started = Date.now();
  const options: RigMatchOptions = { ...DEFAULT_RIG_MATCH_OPTIONS, ...input.options };
  const { body, picture } = prepare(input, options);
  const fit = rebasePivot(input.fit, input.fit.pivot, body.pivot);
  const score = scorer(input.bound, body, picture);
  // What each feature is judged against: the last match's, if it was made
  // with these settings, and otherwise a sample of the picture taken the same way.
  let background = input.cache?.background?.key === backgroundKey(options) ? input.cache.background.values : null;
  let imageFeatures = 0;
  if (!background || background.length !== body.features.length) {
    const radius = body.radius * fit.scale * picture.factor;
    const sample = pictureFeatures(picture, radius, options, 0, 6000);
    imageFeatures = sample.count;
    const values = new Float32Array(body.features.length);
    body.features.forEach((_, f) => {
      let sum = 0;
      for (let g = 0; g < sample.count; g += 1) sum += likeness(body.embeddings, f * EMBEDDING_SIZE, sample.embeddings, g * EMBEDDING_SIZE);
      values[f] = sample.count > 0 ? sum / sample.count : 0;
    });
    background = values;
    if (input.cache) input.cache.background = { key: backgroundKey(options), values };
  }
  const report = judge(input.bound, body, fit, background, score);
  return { ...report, rigFeatures: body.features.length, imageFeatures, agreeing: 0, ms: Date.now() - started, at: new Date().toISOString(), notes: [] };
}

function prepare(input: Pick<MatchInput, 'bound' | 'picture' | 'cache'>, options: RigMatchOptions): { body: BodyModel; picture: PictureModel } {
  if (input.picture.width === 0 || input.picture.height === 0) throw new Error('The picture is empty.');
  const key = `${options.features}`;
  const cache = input.cache;
  const body = cache?.body && cache.key === key ? cache.body : bodyModel(input.bound, options.features);
  const picture = cache?.picture ?? pictureModel(input.picture);
  if (cache) {
    cache.key = key;
    cache.body = body;
    cache.picture = picture;
  }
  return { body, picture };
}

/** The same placement, described about a different pivot. */
function rebasePivot(fit: RigFit, from: VectorPoint, to: VectorPoint): RigFit {
  if (from.x === to.x && from.y === to.y) return { ...fit, pivot: { ...to } };
  const turn = (fit.rotation * Math.PI) / 180;
  const dx = (to.x - from.x) * fit.scale;
  const dy = (to.y - from.y) * fit.scale;
  return { ...fit, pivot: { ...to }, x: fit.x + dx * Math.cos(turn) - dy * Math.sin(turn), y: fit.y + dx * Math.sin(turn) + dy * Math.cos(turn) };
}

/* ------------------------------------------------------------------ *
 * Placing the body
 * ------------------------------------------------------------------ */

interface Hypothesis {
  x: number;
  y: number;
  /** Working pixels per rig unit. */
  scale: number;
  rotation: number;
  votes: number;
}

/**
 * Every good match says where the body is: the body feature at `p`, found at
 * `q` this big and turned this far, puts the body's pivot at a known point.
 * Each such placement is scored by how many other features' matches it agrees
 * with, the best few are scored again properly — every feature's likeness where
 * the placement puts it — and the winner is tightened by small steps.
 */
function placeBody(
  body: BodyModel,
  features: PictureFeatures,
  candidates: Candidates,
  picture: PictureModel,
  guess: RigFit,
  options: RigMatchOptions,
  score: Scorer,
  nearGuess: boolean,
): { fit: RigFit | null; agreeing: number } {
  const n = body.features.length;
  const hypotheses: Hypothesis[] = [];
  const pivot = body.pivot;
  const working = workingFit(guess, picture.factor);
  const bodySize = body.radius / FEATURE_RADIUS;
  const closeTo = (h: Hypothesis) =>
    Math.hypot(h.x - working.x, h.y - working.y) <= bodySize * working.scale * 0.35 &&
    Math.abs(wrapAngle(h.rotation - working.rotation)) <= Math.max(10, options.angleRange / 3) &&
    Math.abs(Math.log(h.scale / working.scale)) <= Math.log(1.35);
  // What a placement may be: turned and sized within the ranges asked for.
  const turnLimit = options.angleRange;
  const middleTurn = nearGuess ? working.rotation : 0;
  const clampHypothesis = (h: Hypothesis): Hypothesis => ({
    ...h,
    rotation: middleTurn + Math.max(-turnLimit, Math.min(turnLimit, wrapAngle(h.rotation - middleTurn))),
    scale: Math.max((working.scale / options.scaleRange) * 0.95, Math.min(working.scale * options.scaleRange * 1.05, h.scale)),
  });
  const hypothesisOf = (f: number, g: number): Hypothesis => {
    const feature = body.features[f]!;
    const scale = features.radius[g]! / body.radius;
    const rotation = features.angle[g]!;
    const turn = (rotation * Math.PI) / 180;
    const dx = (feature.x - pivot.x) * scale;
    const dy = (feature.y - pivot.y) * scale;
    return {
      x: features.x[g]! - (dx * Math.cos(turn) - dy * Math.sin(turn)),
      y: features.y[g]! - (dx * Math.sin(turn) + dy * Math.cos(turn)),
      scale,
      rotation,
      votes: 0,
    };
  };
  for (let f = 0; f < n; f += 1) {
    const top = candidates.likeness[f * KEEP]!;
    for (let k = 0; k < KEEP; k += 1) {
      const g = candidates.best[f * KEEP + k]!;
      const alike = candidates.likeness[f * KEEP + k]!;
      if (g < 0 || alike < Math.max(0.12, top * 0.6)) continue;
      const h = hypothesisOf(f, g);
      // Refining from a placement made by hand looks only near it.
      if (nearGuess && !closeTo(h)) continue;
      hypotheses.push(h);
    }
  }
  if (hypotheses.length === 0) return { fit: null, agreeing: 0 };

  // Votes: for each hypothesis, each body feature adds its best agreeing match.
  const angleTolerance = Math.max(12, features.angles.length > 1 ? Math.abs(features.angles[1]! - features.angles[0]!) : 12);
  const vote = (h: Hypothesis): { votes: number; agreeing: number } => {
    let votes = 0;
    let agreeing = 0;
    const turn = (h.rotation * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const reach = body.radius * h.scale;
    for (let f = 0; f < n; f += 1) {
      const feature = body.features[f]!;
      const dx = (feature.x - pivot.x) * h.scale;
      const dy = (feature.y - pivot.y) * h.scale;
      const px = h.x + dx * cos - dy * sin;
      const py = h.y + dx * sin + dy * cos;
      let bestVote = 0;
      for (let k = 0; k < KEEP; k += 1) {
        const g = candidates.best[f * KEEP + k]!;
        if (g < 0) break;
        if (Math.abs(wrapAngle(features.angle[g]! - h.rotation)) > angleTolerance) continue;
        if (Math.abs(Math.log(features.radius[g]! / (body.radius * h.scale))) > 0.3) continue;
        const d = Math.hypot(features.x[g]! - px, features.y[g]! - py);
        if (d > reach) continue;
        const v = candidates.likeness[f * KEEP + k]! * Math.exp(-(d * d) / (2 * (0.45 * reach) ** 2));
        if (v > bestVote) bestVote = v;
      }
      votes += bestVote * feature.weight;
      if (bestVote > 0.05) agreeing += 1;
    }
    return { votes, agreeing };
  };
  for (const h of hypotheses) h.votes = vote(h).votes;
  hypotheses.sort((a, b) => b.votes - a.votes);

  /*
   * Each placement is only as exact as the steps the picture's features were
   * taken at — every fifteen degrees, every quarter size — so the best few are
   * each refined by least squares: the placement that best carries the agreeing
   * features' positions in the body onto where they were found, solved outright.
   * Positions are not stepped, and there are many of them, so the placement
   * comes out between the steps, where the body really is.
   */
  const refine = (h: Hypothesis): Hypothesis => {
    let current = h;
    for (let round = 0; round < 3; round += 1) {
      const turn = (current.rotation * Math.PI) / 180;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const reach = body.radius * current.scale * (round === 0 ? 1 : 0.6);
      let sw = 0;
      let px = 0;
      let py = 0;
      let qx = 0;
      let qy = 0;
      const pairs: Array<[number, number, number, number, number]> = [];
      for (let f = 0; f < n; f += 1) {
        const feature = body.features[f]!;
        const dx = (feature.x - pivot.x) * current.scale;
        const dy = (feature.y - pivot.y) * current.scale;
        const ex = current.x + dx * cos - dy * sin;
        const ey = current.y + dx * sin + dy * cos;
        let pick = -1;
        let pickWeight = 0;
        for (let k = 0; k < KEEP; k += 1) {
          const g = candidates.best[f * KEEP + k]!;
          if (g < 0) break;
          if (Math.abs(wrapAngle(features.angle[g]! - current.rotation)) > angleTolerance) continue;
          if (Math.abs(Math.log(features.radius[g]! / (body.radius * current.scale))) > 0.3) continue;
          const d = Math.hypot(features.x[g]! - ex, features.y[g]! - ey);
          if (d > reach) continue;
          const weight = candidates.likeness[f * KEEP + k]! * feature.weight * Math.exp(-(d * d) / (2 * (0.5 * reach) ** 2));
          if (weight > pickWeight) {
            pickWeight = weight;
            pick = g;
          }
        }
        if (pick < 0) continue;
        pairs.push([feature.x - pivot.x, feature.y - pivot.y, features.x[pick]!, features.y[pick]!, pickWeight]);
        sw += pickWeight;
        px += (feature.x - pivot.x) * pickWeight;
        py += (feature.y - pivot.y) * pickWeight;
        qx += features.x[pick]! * pickWeight;
        qy += features.y[pick]! * pickWeight;
      }
      if (pairs.length < 3 || sw <= 0) break;
      px /= sw;
      py /= sw;
      qx /= sw;
      qy /= sw;
      let a = 0;
      let b = 0;
      let spread = 0;
      for (const [x, y, u, v, w] of pairs) {
        const cx = x - px;
        const cy = y - py;
        const cu = u - qx;
        const cv = v - qy;
        a += w * (cx * cu + cy * cv);
        b += w * (cx * cv - cy * cu);
        spread += w * (cx * cx + cy * cy);
      }
      if (spread <= 1e-9) break;
      const rotation = Math.atan2(b, a);
      const scale = Math.hypot(a, b) / spread;
      if (!(scale > 0)) break;
      const next: Hypothesis = {
        scale,
        rotation: wrapAngle((rotation * 180) / Math.PI),
        // The pivot is the body's origin here, so it lands where the means say.
        x: qx - scale * (px * Math.cos(rotation) - py * Math.sin(rotation)),
        y: qy - scale * (px * Math.sin(rotation) + py * Math.cos(rotation)),
        votes: current.votes,
      };
      if (Math.abs(Math.log(next.scale / h.scale)) > 0.5) break;
      current = next;
    }
    return current;
  };

  // The best few, distinct, refined and scored properly.
  const shortlist: Hypothesis[] = [];
  for (const h of hypotheses) {
    if (shortlist.length >= 8) break;
    if (shortlist.some((s) => Math.hypot(s.x - h.x, s.y - h.y) < body.radius * h.scale * 0.5 && Math.abs(wrapAngle(s.rotation - h.rotation)) < 8 && Math.abs(Math.log(s.scale / h.scale)) < 0.1)) continue;
    shortlist.push(h);
  }
  for (const h of [...shortlist]) shortlist.push(clampHypothesis(refine(h)));
  const fitOf = (h: Hypothesis): RigFit => ({
    ...guess,
    pivot,
    x: h.x / picture.factor,
    y: h.y / picture.factor,
    scale: h.scale / picture.factor,
    rotation: wrapAngle(h.rotation),
  });
  const dense = (fit: RigFit) => robustMean(score.likenessAt(fit), body);
  let best: { fit: RigFit; value: number } | null = null;
  for (const h of shortlist) {
    const fit = fitOf(h);
    const value = dense(fit);
    if (!best || value > best.value) best = { fit, value };
  }
  const start = dense(guess);
  if (nearGuess && (!best || best.value < start)) best = { fit: guess, value: start };
  if (!best || best.value < start * 0.9) return { fit: null, agreeing: 0 };

  // Tighten by small steps: position, size, turn.
  const minScale = (guess.scale / options.scaleRange) * 0.9;
  const maxScale = guess.scale * options.scaleRange * 1.1;
  let current = best;
  for (const round of [1, 0.5, 0.25]) {
    const stepXY = body.radius * current.fit.scale * 0.3 * round;
    const stepScale = 1 + 0.06 * round;
    const stepTurn = 4 * round;
    let improved = true;
    let guard = 0;
    while (improved && guard < 12) {
      improved = false;
      guard += 1;
      const tries: RigFit[] = [
        { ...current.fit, x: current.fit.x + stepXY },
        { ...current.fit, x: current.fit.x - stepXY },
        { ...current.fit, y: current.fit.y + stepXY },
        { ...current.fit, y: current.fit.y - stepXY },
        { ...current.fit, scale: Math.min(maxScale, current.fit.scale * stepScale) },
        { ...current.fit, scale: Math.max(minScale, current.fit.scale / stepScale) },
        { ...current.fit, rotation: wrapAngle(current.fit.rotation + stepTurn) },
        { ...current.fit, rotation: wrapAngle(current.fit.rotation - stepTurn) },
      ];
      for (const attempt of tries) {
        if (Math.abs(wrapAngle(attempt.rotation - middleTurn)) > options.angleRange + 1e-6) continue;
        const value = dense(attempt);
        if (value > current.value + 1e-5) {
          current = { fit: attempt, value };
          improved = true;
        }
      }
    }
  }
  const agreeing = vote({ x: current.fit.x * picture.factor, y: current.fit.y * picture.factor, scale: current.fit.scale * picture.factor, rotation: current.fit.rotation, votes: 0 }).agreeing;
  return { fit: current.fit, agreeing };
}

/** Body features whose best match anywhere in the picture is where the fit put them. */
function countAgreeing(bound: BoundRig, body: BodyModel, features: PictureFeatures, candidates: Candidates, fit: RigFit, picture: PictureModel): number {
  const placed = placeFeatures(bound, body, workingFit(fit, picture.factor));
  let agreeing = 0;
  body.features.forEach((_, f) => {
    const g = candidates.best[f * KEEP]!;
    if (g < 0 || placed.radius[f] === 0) return;
    if (Math.hypot(features.x[g]! - placed.x[f]!, features.y[g]! - placed.y[f]!) <= placed.radius[f]! * 1.5) agreeing += 1;
  });
  return agreeing;
}

/* ------------------------------------------------------------------ *
 * Fitting each part
 * ------------------------------------------------------------------ */

/** The bones below a bone, it included, nearest first. */
function subtree(bones: readonly Bone[], id: string): string[] {
  const out = [id];
  for (let index = 0; index < out.length; index += 1) {
    for (const bone of bones) if (bone.parent === out[index]) out.push(bone.id);
  }
  return out;
}

/**
 * From the root down, each part is turned and sized to where its features
 * match best — its own, and those of the parts just below it at less weight,
 * which is what lets a part with little of its own to see (a neck under a
 * chin) still be placed by where it carries the next part. A small pull back
 * towards rest, stronger for a stiffer joint, keeps a part nothing can be seen
 * of from wandering.
 *
 * Three passes: a sweep of every angle the joint allows, then closer in
 * around what each found once everything below it has been placed, then
 * closer still. The body's placement is tightened after the first, now the
 * parts are roughly right.
 */
function fitParts(
  bound: BoundRig,
  body: BodyModel,
  start: RigFit,
  options: RigMatchOptions,
  score: Scorer,
  progress: (fraction: number) => void,
): RigFit {
  const bones = bound.rig.bones;
  const roots = new Set(rootBones(bound.rig).map((bone) => bone.id));
  const order: Bone[] = [];
  const queue = [...rootBones(bound.rig)];
  while (queue.length > 0) {
    const bone = queue.shift()!;
    order.push(bone);
    for (const child of bones) if (child.parent === bone.id) queue.push(child);
  }
  const featuresOf = new Map<string, number[]>();
  body.features.forEach((feature, index) => featuresOf.set(feature.bone, [...(featuresOf.get(feature.bone) ?? []), index]));
  const childrenOf = (id: string) => bones.filter((bone) => bone.parent === id).map((bone) => bone.id);
  const partSpan = Math.sqrt(Math.max(1, options.scaleRange));
  const moving = order.filter((bone) => !roots.has(bone.id) && subtree(bones, bone.id).some((id) => (featuresOf.get(id)?.length ?? 0) > 0));

  /** A part's features, and the parts' below it: nearer ones count more, and more when it has little of its own. */
  const judgedBy = (id: string): { indices: number[]; weights: number[] } => {
    const indices: number[] = [];
    const weights: number[] = [];
    const own = featuresOf.get(id) ?? [];
    for (const index of own) {
      indices.push(index);
      weights.push(1);
    }
    const reach = own.length >= 3 ? 1 : 3;
    let level = [id];
    for (let depth = 1; depth <= reach; depth += 1) {
      level = level.flatMap(childrenOf);
      const weight = (own.length >= 3 ? 0.3 : 0.6) * 0.6 ** (depth - 1);
      for (const child of level) {
        for (const index of featuresOf.get(child) ?? []) {
          indices.push(index);
          weights.push(weight);
        }
      }
    }
    return { indices, weights };
  };

  /** How far a joint may turn: the range asked for, inside the joint's own limits when those are kept. */
  const rangeOf = (bone: Bone) => {
    const limits = options.keepLimits ? jointLimits(bound.rig, bone) : { min: -180, max: 180 };
    return { lo: Math.max(limits.min, -options.angleRange), hi: Math.min(limits.max, options.angleRange) };
  };

  let fit = { ...start, angles: { ...start.angles }, sizes: { ...start.sizes } };
  /*
   * Sweep every angle, settle the body's placement on the parts that match,
   * close in, and then — with every part now roughly where it is — settle the
   * placement again on all of them and close in once more.
   */
  const passes: Array<'sweep' | 'near' | 'fine' | 'place' | 'place-all'> = ['place', 'sweep', 'place', 'near', 'fine', 'place-all', 'near', 'fine'];
  const totalSteps = passes.reduce((sum, pass) => sum + (pass.startsWith('place') ? 1 : moving.length), 0);
  let steps = 0;

  const fitOne = (bone: Bone, pass: 'sweep' | 'near' | 'fine') => {
    const { indices, weights } = judgedBy(bone.id);
    if (indices.length === 0) return;
    const { lo, hi } = rangeOf(bone);
    if (hi < lo) return;
    const stiffness = bone.angles?.stiffness ?? 0.5;
    // A part with nothing of its own to see is held nearer rest: it is placed
    // only by where it carries the next part, and that is the next part's to say.
    const hold = (featuresOf.get(bone.id)?.length ?? 0) === 0 ? 4 : 1;
    const children = childrenOf(bone.id).map((id) => boneById(bound.rig, id)!).filter(Boolean);
    const value = (angle: number, size: number, counter = 0) => {
      const angles = { ...fit.angles, [bone.id]: angle };
      for (const child of children) angles[child.id] = (fit.angles[child.id] ?? 0) - counter;
      const candidate = { ...fit, angles, sizes: { ...fit.sizes, [bone.id]: size } };
      const pull = 0.04 * stiffness * hold * (angle / 90) ** 2 + 0.08 * Math.log(size) ** 2;
      return weightedMean(score.likenessAt(candidate, indices), body, indices, weights) - pull;
    };
    let best = { angle: fit.angles[bone.id] ?? 0, size: fit.sizes[bone.id] ?? 1, counter: 0, value: -Infinity };
    best.value = value(best.angle, best.size);
    const tryOne = (angle: number, size: number, counter = 0) => {
      const clamped = Math.max(lo, Math.min(hi, angle));
      const sized = Math.max(1 / partSpan, Math.min(partSpan, size));
      // The children turned back as far as this turned, where they may turn that far.
      const turn = clamped - (fit.angles[bone.id] ?? 0);
      const back = counter !== 0 ? turn : 0;
      if (back !== 0) {
        for (const child of children) {
          const { lo: childLo, hi: childHi } = rangeOf(child);
          const wanted = (fit.angles[child.id] ?? 0) - back;
          if (wanted < childLo || wanted > childHi) return;
        }
      }
      const scored = value(clamped, sized, back);
      if (scored > best.value + 1e-6) best = { angle: clamped, size: sized, counter: back, value: scored };
    };
    const sizesAround = (middle: number, spread: number) =>
      partSpan > 1.001 ? [middle / spread ** 2, middle / spread, middle, middle * spread, middle * spread ** 2] : [1];
    if (pass === 'sweep') {
      const step = Math.min(6, Math.max(2, (hi - lo) / 40));
      for (let angle = lo; angle <= hi + 1e-9; angle += step) tryOne(angle, best.size);
      for (let angle = best.angle - step; angle <= best.angle + step + 1e-9; angle += step / 3) tryOne(angle, best.size);
      for (const size of sizesAround(best.size, partSpan ** 0.5)) tryOne(best.angle, size);
    } else if (pass === 'near') {
      const middle = best;
      for (let angle = middle.angle - 15; angle <= middle.angle + 15 + 1e-9; angle += 2.5) {
        tryOne(angle, middle.size);
        // Turning this joint while turning the next ones back moves them
        // without turning them: the way out of a turn shared wrongly between a
        // joint and the one below it, which no single joint can undo.
        if (children.length > 0) tryOne(angle, middle.size, 1);
      }
      for (const size of sizesAround(best.size, partSpan ** 0.25)) tryOne(best.angle, size, best.counter !== 0 ? 1 : 0);
    } else {
      const middle = best;
      for (let angle = middle.angle - 3; angle <= middle.angle + 3 + 1e-9; angle += 0.75) {
        for (const size of sizesAround(middle.size, partSpan ** 0.1).slice(1, 4)) {
          tryOne(angle, size);
          if (children.length > 0) tryOne(angle, size, 1);
        }
      }
    }
    const angles = { ...fit.angles, [bone.id]: best.angle };
    for (const child of children) if (best.counter !== 0) angles[child.id] = (fit.angles[child.id] ?? 0) - best.counter;
    fit = { ...fit, angles, sizes: { ...fit.sizes, [bone.id]: best.size } };
  };

  for (const pass of passes) {
    if (pass === 'place' || pass === 'place-all') {
      fit = tightenPlacement(body, fit, score, options, pass === 'place');
      steps += 1;
      progress(steps / totalSteps);
      continue;
    }
    for (const bone of moving) {
      fitOne(bone, pass);
      steps += 1;
      progress(steps / totalSteps);
    }
  }
  // Tidy: drop turns and sizes that are rest.
  const angles = Object.fromEntries(Object.entries(fit.angles).filter(([, angle]) => Math.abs(angle) > 0.05).map(([id, angle]) => [id, Math.round(angle * 10) / 10]));
  const sizes = Object.fromEntries(Object.entries(fit.sizes).filter(([, size]) => Math.abs(size - 1) > 0.005).map(([id, size]) => [id, Math.round(size * 1000) / 1000]));
  return { ...fit, angles, sizes };
}

function tightenPlacement(body: BodyModel, start: RigFit, score: Scorer, options: RigMatchOptions, robust: boolean): RigFit {
  const all = body.features.map((_, index) => index);
  const dense = (fit: RigFit) => (robust ? robustMean(score.likenessAt(fit), body) : weightedMean(score.likenessAt(fit), body, all));
  let current = { fit: start, value: dense(start) };
  for (const round of [0.5, 0.2]) {
    const stepXY = body.radius * current.fit.scale * 0.3 * round;
    const stepScale = 1 + 0.05 * round;
    const stepTurn = 3 * round;
    for (let pass = 0; pass < 6; pass += 1) {
      let improved = false;
      for (const attempt of [
        { ...current.fit, x: current.fit.x + stepXY },
        { ...current.fit, x: current.fit.x - stepXY },
        { ...current.fit, y: current.fit.y + stepXY },
        { ...current.fit, y: current.fit.y - stepXY },
        { ...current.fit, scale: current.fit.scale * stepScale },
        { ...current.fit, scale: current.fit.scale / stepScale },
        { ...current.fit, rotation: wrapAngle(current.fit.rotation + stepTurn) },
        { ...current.fit, rotation: wrapAngle(current.fit.rotation - stepTurn) },
      ]) {
        if (Math.abs(attempt.rotation) > options.angleRange + 1e-6 && Math.abs(attempt.rotation) > Math.abs(current.fit.rotation)) continue;
        const value = dense(attempt);
        if (value > current.value + 1e-5) {
          current = { fit: attempt, value };
          improved = true;
        }
      }
      if (!improved) break;
    }
  }
  return current.fit;
}

/* ------------------------------------------------------------------ *
 * Confidence
 * ------------------------------------------------------------------ */

/**
 * How sure the fit is, feature by feature, part by part, and overall.
 *
 * A feature's likeness where the fit put it counts only as far as it beats the
 * feature's likeness to the picture at large: `(where − anywhere) / (1 − anywhere)`.
 * A plain patch of skin is alike to a good deal of any picture of that person,
 * so finding it is weak evidence; a patch with an eye in it is alike to almost
 * nothing else, so finding it is strong.
 */
function judge(
  bound: BoundRig,
  body: BodyModel,
  fit: RigFit,
  background: Float32Array,
  score: Scorer,
): Omit<MatchReport, 'rigFeatures' | 'imageFeatures' | 'agreeing' | 'ms' | 'at' | 'notes'> {
  const at = score.likenessAt(fit);
  const placed = placeFeatures(bound, body, fit);
  const features: MatchFeature[] = [];
  const perPart = new Map<string, { sum: number; weight: number; alike: number; count: number }>();
  body.features.forEach((feature, index) => {
    const alike = at[index]!;
    const base = Math.min(0.95, background[index] ?? 0);
    const confidence = Math.max(0, Math.min(1, (alike - base) / (1 - base)));
    const part = perPart.get(feature.bone) ?? { sum: 0, weight: 0, alike: 0, count: 0 };
    part.sum += confidence * feature.weight;
    part.weight += feature.weight;
    part.alike += alike;
    part.count += 1;
    perPart.set(feature.bone, part);
    if (placed.radius[index] === 0) return;
    features.push({
      bone: feature.bone,
      x: Math.round(placed.x[index]! * 10) / 10,
      y: Math.round(placed.y[index]! * 10) / 10,
      r: Math.round(placed.radius[index]! * 10) / 10,
      similarity: Math.round(alike * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
    });
  });
  const parts: Record<string, PartScore> = {};
  let sum = 0;
  let total = 0;
  for (const bone of bound.rig.bones) {
    const part = perPart.get(bone.id);
    if (!part || part.weight === 0) {
      parts[bone.id] = { confidence: null, similarity: 0, features: 0 };
      continue;
    }
    const confidence = part.sum / part.weight;
    parts[bone.id] = {
      confidence: Math.round(confidence * 1000) / 1000,
      similarity: Math.round((part.alike / part.count) * 1000) / 1000,
      features: part.count,
    };
    const area = body.areas.get(bone.id) ?? 1;
    sum += confidence * area;
    total += area;
  }
  return {
    confidence: total > 0 ? Math.round((sum / total) * 1000) / 1000 : 0,
    parts,
    features,
    forFit: fitSignature(fit),
  };
}
