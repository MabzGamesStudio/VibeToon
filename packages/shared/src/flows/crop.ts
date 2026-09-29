import type { Bitmap } from './cutout';

/**
 * Cutting a picture down to part of it.
 *
 * Two ways to say which part:
 *
 * - **By hand**: a box drawn on the picture, moved and resized by its handles
 *   or typed in.
 * - **To the solid pixels**: for a picture with transparency — a cut-out
 *   character, a sprite on a clear sheet — the box is the smallest one that
 *   holds every pixel solid enough to count, so the subject is boxed and
 *   centred with nothing round it. A margin can be kept round it, which may
 *   reach past the picture's edge; what is outside is clear.
 *
 * Boxes are in the picture's own pixels, whole pixels only, `x`/`y` the top
 * left. The result is always at least one pixel.
 */

export type CropMode = 'manual' | 'opaque';

export const CROP_MODES: CropMode[] = ['opaque', 'manual'];

export const CROP_MODE_LABEL: Record<CropMode, string> = {
  opaque: 'To the solid pixels',
  manual: 'By hand',
};

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropFlowData {
  editor: 'crop';
  mode: CropMode;
  /** The box drawn by hand; null means the whole picture. */
  rect: CropRect | null;
  /** A pixel counts as solid when its alpha is above this, 0..254. */
  threshold: number;
  /** Clear pixels kept round the solid box, on every side. */
  padding: number;
  /** Keep the box square, growing the short side about its middle. */
  square: boolean;
  /** The picture it was last shown, so the generator can say what it did. */
  source?: { width: number; height: number; hash?: string };
}

export const DEFAULT_CROP_THRESHOLD = 0;
export const MAX_CROP_PADDING = 4096;

export function emptyCropFlowData(): CropFlowData {
  return { editor: 'crop', mode: 'opaque', rect: null, threshold: DEFAULT_CROP_THRESHOLD, padding: 0, square: false };
}

/** A box of whole pixels, at least one across, with its corners in order. */
export function normaliseRect(rect: CropRect): CropRect {
  const left = Math.round(Math.min(rect.x, rect.x + rect.width));
  const top = Math.round(Math.min(rect.y, rect.y + rect.height));
  const right = Math.round(Math.max(rect.x, rect.x + rect.width));
  const bottom = Math.round(Math.max(rect.y, rect.y + rect.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** A box kept inside a picture of this size: moved in where it can be, cut where it cannot. */
export function clampRect(rect: CropRect, size: { width: number; height: number }): CropRect {
  const box = normaliseRect(rect);
  const width = Math.min(box.width, size.width);
  const height = Math.min(box.height, size.height);
  return {
    x: Math.max(0, Math.min(size.width - width, box.x)),
    y: Math.max(0, Math.min(size.height - height, box.y)),
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

/** Does any pixel let something through? */
export function hasTransparency(bitmap: Bitmap): boolean {
  for (let i = 3; i < bitmap.data.length; i += 4) if (bitmap.data[i]! < 255) return true;
  return false;
}

/**
 * The smallest box holding every pixel whose alpha is above `threshold`, or
 * null when there is none: a picture that is clear all over.
 */
export function opaqueBounds(bitmap: Bitmap, threshold = DEFAULT_CROP_THRESHOLD): CropRect | null {
  const { width, height, data } = bitmap;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    let row = y * width * 4 + 3;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1, row += 4) {
      if (data[row]! > threshold) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    if (first < left) left = first;
    if (last > right) right = last;
    if (y < top) top = y;
    bottom = y;
  }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Grow the short side so the box is square, about its own middle. */
export function squared(rect: CropRect): CropRect {
  const side = Math.max(rect.width, rect.height);
  return {
    x: rect.x - Math.floor((side - rect.width) / 2),
    y: rect.y - Math.floor((side - rect.height) / 2),
    width: side,
    height: side,
  };
}

/**
 * The box this flow cuts out of a picture this size (and, for the solid mode,
 * these pixels). By hand, it is kept inside the picture; to the solid pixels,
 * the margin — and squaring — may take it past the edge, where it is clear.
 */
export function cropRectFor(data: CropFlowData, bitmap: Bitmap): CropRect {
  const whole = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  if (data.mode === 'manual') {
    const box = data.rect ? clampRect(data.rect, bitmap) : whole;
    return data.square ? squared(box) : box;
  }
  const solid = opaqueBounds(bitmap, data.threshold) ?? whole;
  const pad = Math.max(0, Math.min(MAX_CROP_PADDING, Math.round(data.padding)));
  const padded = { x: solid.x - pad, y: solid.y - pad, width: solid.width + pad * 2, height: solid.height + pad * 2 };
  return data.square ? squared(padded) : padded;
}

/** Cut `rect` out of a picture. Anything the box reaches past the picture's edge is clear. */
export function cropBitmap(bitmap: Bitmap, rect: CropRect): Bitmap {
  const box = normaliseRect(rect);
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  const fromX = Math.max(0, box.x);
  const toX = Math.min(bitmap.width, box.x + box.width);
  if (toX > fromX) {
    for (let y = Math.max(0, box.y); y < Math.min(bitmap.height, box.y + box.height); y += 1) {
      const source = (y * bitmap.width + fromX) * 4;
      const target = ((y - box.y) * box.width + (fromX - box.x)) * 4;
      out.set(bitmap.data.subarray(source, source + (toX - fromX) * 4), target);
    }
  }
  return { width: box.width, height: box.height, data: out };
}

/** Move a box by a drag, keeping it inside the picture. */
export function moveRect(rect: CropRect, by: { x: number; y: number }, size: { width: number; height: number }): CropRect {
  return clampRect({ ...rect, x: rect.x + by.x, y: rect.y + by.y }, size);
}

/** Which edges a handle moves: `n`, `se`, … */
export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const CROP_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Drag one handle of a box to `to`, in picture pixels. The opposite side stays
 * where it is; dragging past it flips the box rather than turning it inside out.
 */
export function dragHandle(rect: CropRect, handle: CropHandle, to: { x: number; y: number }, size: { width: number; height: number }): CropRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  const x = Math.max(0, Math.min(size.width, Math.round(to.x)));
  const y = Math.max(0, Math.min(size.height, Math.round(to.y)));
  if (handle.includes('w')) left = x;
  if (handle.includes('e')) right = x;
  if (handle.includes('n')) top = y;
  if (handle.includes('s')) bottom = y;
  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, size);
}

/** What the crop comes to, in words. */
export function summariseCrop(source: { width: number; height: number } | undefined, rect: CropRect | null, mode: CropMode): string {
  if (!source || !rect) return 'No picture yet.';
  const kept = Math.round(((rect.width * rect.height) / Math.max(1, source.width * source.height)) * 100);
  return `${source.width} × ${source.height} → ${rect.width} × ${rect.height} from (${rect.x}, ${rect.y}) · ${CROP_MODE_LABEL[mode].toLowerCase()} · ${kept}% of the area`;
}

/** The box as written beside the picture, for flows that want to know where it came from. */
export function cropBoxFile(source: { width: number; height: number }, rect: CropRect, mode: CropMode): string {
  return `${JSON.stringify({ kind: 'crop', version: 1, mode, source: { width: source.width, height: source.height }, box: rect }, null, 2)}\n`;
}
