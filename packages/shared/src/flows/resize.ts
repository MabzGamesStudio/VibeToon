import type { Bitmap } from './cutout';

/**
 * Making a picture bigger or smaller.
 *
 * Resampling is done in two passes, across and then down, each weighing the
 * source pixels near where a target pixel falls by a kernel:
 *
 * - **Nearest** takes the one pixel under it. Blocky, and exactly right for
 *   pixel art, whose pixels are the drawing.
 * - **Bilinear** blends the nearest two in each direction. Soft.
 * - **Bicubic** (Catmull-Rom) weighs four, and keeps edges crisper without
 *   ringing much. A good default for drawings.
 * - **Lanczos** weighs six, the sharpest, and can ring faintly beside hard edges.
 *
 * Shrinking widens the kernel by as much as the picture shrinks, so every source
 * pixel still counts toward some target pixel. Without that a picture shrunk to
 * a quarter samples one pixel in four and fine lines flicker in and out.
 *
 * Color is blended with alpha premultiplied, so a transparent pixel's color —
 * which is anything at all, usually black — never bleeds into the edge of the
 * shape beside it.
 */

export type ResizeMethod = 'nearest' | 'bilinear' | 'bicubic' | 'lanczos';

export const RESIZE_METHODS: ResizeMethod[] = ['nearest', 'bilinear', 'bicubic', 'lanczos'];

export const RESIZE_METHOD_LABEL: Record<ResizeMethod, string> = {
  nearest: 'Nearest (pixel art)',
  bilinear: 'Bilinear (soft)',
  bicubic: 'Bicubic (crisp)',
  lanczos: 'Lanczos (sharpest)',
};

export interface ResizeOptions {
  /** By a factor, or to a size in pixels. */
  mode: 'scale' | 'size';
  scale: number;
  width: number;
  height: number;
  /** In size mode, the height follows from the width and the picture's shape. */
  keepAspect: boolean;
  method: ResizeMethod;
}

export const DEFAULT_RESIZE_OPTIONS: ResizeOptions = {
  mode: 'scale',
  scale: 2,
  width: 512,
  height: 512,
  keepAspect: true,
  method: 'bicubic',
};

/** The largest side, and the most pixels, a resize will make. */
export const MAX_RESIZE_SIDE = 16384;
export const MAX_RESIZE_PIXELS = 64_000_000;

export interface ResizeFlowData {
  editor: 'resize';
  options: ResizeOptions;
  /** The picture it was last shown, noted so the generator can say what it did. */
  source?: { width: number; height: number; hash?: string };
}

export function emptyResizeFlowData(): ResizeFlowData {
  return { editor: 'resize', options: { ...DEFAULT_RESIZE_OPTIONS } };
}

/**
 * The size a picture comes out at: by the factor, or the size asked for, with
 * the height following the width when the shape is kept. Never below one pixel,
 * and shrunk as a whole (keeping its shape) to stay inside the limits.
 */
export function targetSize(source: { width: number; height: number }, options: ResizeOptions): { width: number; height: number } {
  let width: number;
  let height: number;
  if (options.mode === 'scale') {
    const scale = Math.max(0.001, options.scale);
    width = source.width * scale;
    height = source.height * scale;
  } else {
    width = Math.max(1, options.width);
    height = options.keepAspect ? (width * source.height) / Math.max(1, source.width) : Math.max(1, options.height);
  }
  const over = Math.max(width / MAX_RESIZE_SIDE, height / MAX_RESIZE_SIDE, Math.sqrt((width * height) / MAX_RESIZE_PIXELS), 1);
  return { width: Math.max(1, Math.round(width / over)), height: Math.max(1, Math.round(height / over)) };
}

/* ------------------------------------------------------------------ *
 * Kernels
 * ------------------------------------------------------------------ */

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

const KERNELS: Record<Exclude<ResizeMethod, 'nearest'>, { radius: number; weigh(x: number): number }> = {
  bilinear: { radius: 1, weigh: (x) => Math.max(0, 1 - Math.abs(x)) },
  bicubic: {
    radius: 2,
    weigh: (x) => {
      // Catmull-Rom: a = -0.5.
      const t = Math.abs(x);
      if (t < 1) return 1.5 * t * t * t - 2.5 * t * t + 1;
      if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2;
      return 0;
    },
  },
  lanczos: { radius: 3, weigh: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

interface Taps {
  /** For each target position, the first source index it reads. */
  start: Int32Array;
  count: Int32Array;
  /** `count` weights per target position, packed, each set summing to 1. */
  weights: Float32Array;
  stride: number;
}

/** Which source pixels each target pixel along one axis reads, and how much of each. */
function taps(from: number, to: number, method: Exclude<ResizeMethod, 'nearest'>): Taps {
  const kernel = KERNELS[method];
  const scale = to / from;
  // Shrinking stretches the kernel so every source pixel is read by someone.
  const spread = scale < 1 ? 1 / scale : 1;
  const radius = kernel.radius * spread;
  const stride = Math.ceil(radius) * 2 + 1;
  const start = new Int32Array(to);
  const count = new Int32Array(to);
  const weights = new Float32Array(to * stride);
  for (let i = 0; i < to; i += 1) {
    const centre = (i + 0.5) / scale - 0.5;
    const first = Math.max(0, Math.ceil(centre - radius));
    const last = Math.min(from - 1, Math.floor(centre + radius));
    let total = 0;
    let n = 0;
    for (let j = first; j <= last && n < stride; j += 1) {
      const w = kernel.weigh((j - centre) / spread);
      weights[i * stride + n] = w;
      total += w;
      n += 1;
    }
    if (n === 0 || Math.abs(total) < 1e-9) {
      // Nothing in reach: take the nearest pixel.
      start[i] = Math.min(from - 1, Math.max(0, Math.round(centre)));
      count[i] = 1;
      weights[i * stride] = 1;
      continue;
    }
    for (let k = 0; k < n; k += 1) weights[i * stride + k]! /= total;
    start[i] = first;
    count[i] = n;
  }
  return { start, count, weights, stride };
}

/* ------------------------------------------------------------------ *
 * Resampling
 * ------------------------------------------------------------------ */

/** The picture at a new size. */
export function resizeBitmap(bitmap: Bitmap, width: number, height: number, method: ResizeMethod): Bitmap {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const { width: sw, height: sh, data } = bitmap;
  if (sw === 0 || sh === 0) return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  if (w === sw && h === sh) return { width: w, height: h, data: new Uint8ClampedArray(data) };

  if (method === 'nearest') {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
      for (let x = 0; x < w; x += 1) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
        const from = (sy * sw + sx) * 4;
        const to = (y * w + x) * 4;
        out[to] = data[from]!;
        out[to + 1] = data[from + 1]!;
        out[to + 2] = data[from + 2]!;
        out[to + 3] = data[from + 3]!;
      }
    }
    return { width: w, height: h, data: out };
  }

  // Premultiplied, in floats.
  const source = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i += 1) {
    const a = data[i * 4 + 3]! / 255;
    source[i * 4] = data[i * 4]! * a;
    source[i * 4 + 1] = data[i * 4 + 1]! * a;
    source[i * 4 + 2] = data[i * 4 + 2]! * a;
    source[i * 4 + 3] = a;
  }

  // Across.
  const across = taps(sw, w, method);
  const middle = new Float32Array(w * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const row = y * sw;
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const first = across.start[x]!;
      const n = across.count[x]!;
      for (let k = 0; k < n; k += 1) {
        const weight = across.weights[x * across.stride + k]!;
        const at = (row + first + k) * 4;
        r += source[at]! * weight;
        g += source[at + 1]! * weight;
        b += source[at + 2]! * weight;
        a += source[at + 3]! * weight;
      }
      const to = (y * w + x) * 4;
      middle[to] = r;
      middle[to + 1] = g;
      middle[to + 2] = b;
      middle[to + 3] = a;
    }
  }

  // Down, and back out of premultiplied.
  const down = taps(sh, h, method);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const first = down.start[y]!;
    const n = down.count[y]!;
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < n; k += 1) {
        const weight = down.weights[y * down.stride + k]!;
        const at = ((first + k) * w + x) * 4;
        r += middle[at]! * weight;
        g += middle[at + 1]! * weight;
        b += middle[at + 2]! * weight;
        a += middle[at + 3]! * weight;
      }
      const to = (y * w + x) * 4;
      const alpha = Math.max(0, Math.min(1, a));
      if (alpha <= 1e-6) {
        out[to] = out[to + 1] = out[to + 2] = out[to + 3] = 0;
        continue;
      }
      out[to] = r / alpha;
      out[to + 1] = g / alpha;
      out[to + 2] = b / alpha;
      out[to + 3] = Math.round(alpha * 255);
    }
  }
  return { width: w, height: h, data: out };
}

export function summariseResize(source: { width: number; height: number } | undefined, options: ResizeOptions): string {
  if (!source) return 'No picture yet.';
  const size = targetSize(source, options);
  const factor = size.width / source.width;
  const way = factor > 1.0001 ? 'up' : factor < 0.9999 ? 'down' : 'unchanged';
  return `${source.width} × ${source.height} → ${size.width} × ${size.height} (${way === 'unchanged' ? 'same size' : `×${factor.toFixed(factor < 1 ? 3 : 2)} ${way}`}) · ${RESIZE_METHOD_LABEL[options.method]}`;
}
