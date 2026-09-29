import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampRect,
  cropBitmap,
  cropBoxFile,
  cropRectFor,
  dragHandle,
  emptyCropFlowData,
  hasTransparency,
  moveRect,
  normaliseRect,
  opaqueBounds,
  squared,
  summariseCrop,
} from '../src/flows/crop';
import type { Bitmap } from '../src/flows/cutout';

/** A clear picture with a solid block from (x0,y0) to (x1,y1), inclusive. */
function sprite(width: number, height: number, x0: number, y0: number, x1: number, y1: number, alpha = 255): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = x * 10;
      data[at + 1] = y * 10;
      data[at + 2] = 200;
      data[at + 3] = alpha;
    }
  }
  return { width, height, data };
}

function solid(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

test('the solid box is the smallest one holding every solid pixel', () => {
  assert.deepEqual(opaqueBounds(sprite(20, 10, 4, 2, 9, 6)), { x: 4, y: 2, width: 6, height: 5 });
  assert.equal(opaqueBounds(sprite(8, 8, 0, 0, 0, 0, 0)), null, 'a clear picture has no solid box');
});

test('a faint pixel only counts when it is above the threshold', () => {
  const picture = sprite(10, 10, 2, 2, 7, 7);
  // A faint halo pixel at the corner.
  picture.data[3] = 20;
  assert.deepEqual(opaqueBounds(picture, 0), { x: 0, y: 0, width: 8, height: 8 });
  assert.deepEqual(opaqueBounds(picture, 40), { x: 2, y: 2, width: 6, height: 6 });
});

test('cropping to the solid pixels boxes the subject, with a margin that may reach past the edge', () => {
  const picture = sprite(20, 10, 0, 2, 9, 6);
  const data = { ...emptyCropFlowData(), padding: 2 };
  const rect = cropRectFor(data, picture);
  assert.deepEqual(rect, { x: -2, y: 0, width: 14, height: 9 });
  const out = cropBitmap(picture, rect);
  assert.equal(out.width, 14);
  // The margin past the left edge is clear; the subject starts two pixels in.
  assert.equal(out.data[(2 * 14 + 0) * 4 + 3], 0);
  assert.equal(out.data[(2 * 14 + 2) * 4 + 3], 255);
  assert.equal(out.data[(2 * 14 + 2) * 4], 0, 'the first solid pixel is the one at x = 0');
});

test('cropped pixels are the picture’s own, in place', () => {
  const picture = sprite(12, 12, 3, 4, 8, 9);
  const out = cropBitmap(picture, { x: 3, y: 4, width: 6, height: 6 });
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      const from = ((y + 4) * 12 + (x + 3)) * 4;
      const to = (y * 6 + x) * 4;
      assert.deepEqual([...out.data.subarray(to, to + 4)], [...picture.data.subarray(from, from + 4)]);
    }
  }
});

test('a box drawn by hand is kept inside the picture', () => {
  const data = { ...emptyCropFlowData(), mode: 'manual' as const, rect: { x: 15, y: -3, width: 10, height: 6 } };
  assert.deepEqual(cropRectFor(data, solid(20, 10)), { x: 10, y: 0, width: 10, height: 6 });
  assert.deepEqual(cropRectFor({ ...data, rect: null }, solid(20, 10)), { x: 0, y: 0, width: 20, height: 10 }, 'no box is the whole picture');
});

test('a box drawn backwards is put the right way round, at least a pixel', () => {
  assert.deepEqual(normaliseRect({ x: 10, y: 8, width: -4, height: -3 }), { x: 6, y: 5, width: 4, height: 3 });
  assert.deepEqual(normaliseRect({ x: 2.4, y: 2.6, width: 0, height: 0 }), { x: 2, y: 3, width: 1, height: 1 });
  assert.deepEqual(clampRect({ x: 0, y: 0, width: 50, height: 50 }, { width: 20, height: 10 }), { x: 0, y: 0, width: 20, height: 10 });
});

test('square grows the short side about its middle', () => {
  assert.deepEqual(squared({ x: 10, y: 20, width: 10, height: 4 }), { x: 10, y: 17, width: 10, height: 10 });
  const data = { ...emptyCropFlowData(), square: true };
  const rect = cropRectFor(data, sprite(30, 30, 10, 12, 19, 15));
  assert.equal(rect.width, rect.height);
});

test('dragging a handle moves only its own sides, and past the other side flips the box', () => {
  const size = { width: 100, height: 100 };
  const box = { x: 20, y: 20, width: 40, height: 30 };
  assert.deepEqual(dragHandle(box, 'se', { x: 70, y: 80 }, size), { x: 20, y: 20, width: 50, height: 60 });
  assert.deepEqual(dragHandle(box, 'n', { x: 999, y: 10 }, size), { x: 20, y: 10, width: 40, height: 40 });
  assert.deepEqual(dragHandle(box, 'w', { x: 90, y: 0 }, size), { x: 60, y: 20, width: 30, height: 30 });
  assert.deepEqual(moveRect(box, { x: 100, y: -5 }, size), { x: 60, y: 15, width: 40, height: 30 });
});

test('transparency is noticed, and a solid picture has none', () => {
  assert.equal(hasTransparency(solid(4, 4)), false);
  assert.equal(hasTransparency(sprite(4, 4, 0, 0, 1, 1)), true);
});

test('the box file and the summary say what was cut', () => {
  const file = JSON.parse(cropBoxFile({ width: 20, height: 10 }, { x: 1, y: 2, width: 3, height: 4 }, 'manual'));
  assert.deepEqual(file.box, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(file.kind, 'crop');
  assert.match(summariseCrop({ width: 20, height: 10 }, { x: 1, y: 2, width: 10, height: 5 }, 'opaque'), /20 × 10 → 10 × 5.*25%/);
});
