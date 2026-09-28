import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_RESIZE_OPTIONS,
  MAX_RESIZE_SIDE,
  RESIZE_METHODS,
  emptyResizeFlowData,
  resizeBitmap,
  summariseResize,
  targetSize,
  type ResizeOptions,
} from '../src/flows/resize';
import { normaliseFlowData } from '../src/project/migrate';
import type { Bitmap } from '../src/flows/cutout';

const options = (over: Partial<ResizeOptions>): ResizeOptions => ({ ...DEFAULT_RESIZE_OPTIONS, ...over });

function solid(width: number, height: number, rgba: [number, number, number, number]): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(rgba, i * 4);
  return { width, height, data };
}

const px = (bitmap: Bitmap, x: number, y: number) => Array.from(bitmap.data.slice((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4));

test('the size comes from the factor, or from the size asked for with the shape kept', () => {
  assert.deepEqual(targetSize({ width: 100, height: 50 }, options({ mode: 'scale', scale: 2 })), { width: 200, height: 100 });
  assert.deepEqual(targetSize({ width: 100, height: 50 }, options({ mode: 'scale', scale: 0.25 })), { width: 25, height: 13 });
  assert.deepEqual(targetSize({ width: 100, height: 50 }, options({ mode: 'size', width: 40, height: 999, keepAspect: true })), { width: 40, height: 20 });
  assert.deepEqual(targetSize({ width: 100, height: 50 }, options({ mode: 'size', width: 40, height: 7, keepAspect: false })), { width: 40, height: 7 });
  assert.deepEqual(targetSize({ width: 3, height: 3 }, options({ mode: 'scale', scale: 0.01 })), { width: 1, height: 1 }, 'never below a pixel');
});

test('a resize never goes past the limits, and keeps its shape when held back', () => {
  const huge = targetSize({ width: 4000, height: 2000 }, options({ mode: 'scale', scale: 8 }));
  assert.ok(huge.width <= MAX_RESIZE_SIDE);
  assert.ok(Math.abs(huge.width / huge.height - 2) < 0.01);
});

test('nearest copies pixels: a checkerboard doubled is the same checkerboard in 2 × 2 blocks', () => {
  const board = solid(2, 2, [0, 0, 0, 255]);
  board.data.set([255, 255, 255, 255], 4);
  board.data.set([255, 255, 255, 255], 8);
  const big = resizeBitmap(board, 4, 4, 'nearest');
  assert.deepEqual(px(big, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(px(big, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(px(big, 2, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(big, 3, 3), [0, 0, 0, 255]);
});

test('a flat color stays exactly that color at any size, with every method', () => {
  const flat = solid(7, 5, [200, 100, 50, 255]);
  for (const method of RESIZE_METHODS) {
    for (const [w, h] of [[21, 15], [3, 2], [7, 5]] as const) {
      const out = resizeBitmap(flat, w, h, method);
      assert.equal(out.width, w);
      assert.equal(out.height, h);
      for (let i = 0; i < w * h; i += 1) assert.deepEqual(Array.from(out.data.slice(i * 4, i * 4 + 4)), [200, 100, 50, 255], `${method} ${w}×${h}`);
    }
  }
});

test('shrinking takes every pixel into account: a fine stripe becomes a mid grey, not black or white', () => {
  const stripes = solid(64, 8, [0, 0, 0, 255]);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 64; x += 2) stripes.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
  for (const method of ['bilinear', 'bicubic', 'lanczos'] as const) {
    const small = resizeBitmap(stripes, 8, 1, method);
    for (let x = 1; x < 7; x += 1) {
      const [r] = px(small, x, 0);
      assert.ok(Math.abs(r! - 128) < 20, `${method} at ${x}: ${r}`);
    }
  }
});

test('transparent pixels do not bleed their color into the edge beside them', () => {
  const half = solid(4, 1, [255, 0, 0, 255]);
  half.data.set([0, 0, 0, 0], 8);
  half.data.set([0, 0, 0, 0], 12);
  const big = resizeBitmap(half, 16, 1, 'bilinear');
  for (let x = 0; x < 16; x += 1) {
    const [r, g, b, a] = px(big, x, 0);
    if (a! > 10) assert.ok(r! > 240 && g! < 10 && b! < 10, `pixel ${x}: ${r},${g},${b},${a}`);
  }
  const edge = px(big, 8, 0);
  assert.ok(edge[3]! > 0 && edge[3]! < 255, 'and the edge fades rather than stepping');
});

test('enlarging smoothly: a step between two colors is blended by bicubic, kept hard by nearest', () => {
  const step = solid(2, 1, [0, 0, 0, 255]);
  step.data.set([255, 255, 255, 255], 4);
  const smooth = resizeBitmap(step, 8, 1, 'bicubic');
  const middle = px(smooth, 3, 0)[0]!;
  assert.ok(middle > 10 && middle < 245, `blended ${middle}`);
  const hard = resizeBitmap(step, 8, 1, 'nearest');
  assert.deepEqual([px(hard, 3, 0)[0], px(hard, 4, 0)[0]], [0, 255]);
});

test('the same size is a copy, not the same array', () => {
  const flat = solid(3, 3, [1, 2, 3, 4]);
  const out = resizeBitmap(flat, 3, 3, 'lanczos');
  assert.deepEqual(Array.from(out.data), Array.from(flat.data));
  assert.notEqual(out.data, flat.data);
});

test('a fresh flow and one stored before a setting existed both have every setting', () => {
  assert.deepEqual(emptyResizeFlowData().options, DEFAULT_RESIZE_OPTIONS);
  const old = normaliseFlowData({ editor: 'resize', options: { scale: 3 } } as never) as ReturnType<typeof emptyResizeFlowData>;
  assert.equal(old.options.scale, 3);
  assert.equal(old.options.method, DEFAULT_RESIZE_OPTIONS.method);
});

test('the summary says which way and how far', () => {
  assert.match(summariseResize({ width: 100, height: 50 }, options({ scale: 2 })), /100 × 50 → 200 × 100 \(×2\.00 up\)/);
  assert.match(summariseResize({ width: 100, height: 50 }, options({ scale: 0.5 })), /×0\.500 down/);
  assert.match(summariseResize(undefined, DEFAULT_RESIZE_OPTIONS), /No picture/);
});
