import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  applyMarks,
  backgroundFrameSize,
  backgroundReport,
  consistentBackground,
  emptyVideoBackgroundFlowData,
  markMask,
  nearestFrame,
  BACKGROUND_PIXEL_BUDGET,
} from '../src/flows/videoBackground';

const W = 20;
const H = 10;

/** A grey wall with a red box whose left edge is at `x`, three wide. */
function frame(x: number | null, noise = 0): Bitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let px = 0; px < W; px += 1) {
      const inBox = x !== null && px >= x && px < x + 3 && y >= 3 && y < 7;
      const grey = 120 + ((px + y) % 2 === 0 ? noise : -noise);
      data.set(inBox ? [220, 30, 30, 255] : [grey, grey, grey, 255], (y * W + px) * 4);
    }
  }
  return { width: W, height: H, data };
}

const alphaAt = (image: Bitmap, x: number, y: number) => image.data[(y * W + x) * 4 + 3]!;

test('what stays put in every frame is the background, and what moved is clear', () => {
  const frames = [frame(2), frame(8), frame(14)];
  const { image, consistent, stats } = consistentBackground(frames, 8);
  assert.equal(alphaAt(image, 0, 0), 255);
  assert.equal(image.data[0], 120, 'the wall’s own grey');
  for (const x of [2, 3, 4, 8, 9, 10, 14, 15, 16]) assert.equal(alphaAt(image, x, 5), 0, `(${x}, 5) had the box in a frame`);
  assert.equal(alphaAt(image, 6, 5), 255, 'a gap the box never passed');
  assert.equal(stats.consistent, W * H - 9 * 4);
  assert.equal(consistent[0], 1);
});

test('the tolerance decides how much change still counts as the same', () => {
  // The wall flickers by ±6 between frames.
  const frames = [frame(null, 0), frame(null, 6), frame(null, -6)];
  assert.equal(consistentBackground(frames, 2).stats.consistent, 0, 'too strict: nothing agrees');
  assert.equal(consistentBackground(frames, 8).stats.consistent, W * H, 'loose enough: all of it does');
});

test('the colour kept is the middle one, so one odd frame does not tint it', () => {
  const odd = frame(null);
  odd.data[0] = 150; // one pixel brighter in one frame, within tolerance
  const { image } = consistentBackground([frame(null), odd, frame(null)], 20);
  assert.equal(image.data[0], 120);
});

test('a region marked on a frame puts that frame’s pixels into the background', () => {
  const frames = [frame(2), frame(8), frame(14)];
  const base = consistentBackground(frames, 8);
  // In the first frame the box is at 2..4; draw round 8..10 — clear wall there.
  const marked = applyMarks(base, [{ id: 'r', kind: 'region', time: 0, mode: 'include', points: [8, 3, 11, 3, 11, 7, 8, 7] }], () => frames[0]);
  for (const x of [8, 9, 10]) assert.equal(alphaAt(marked.image, x, 5), 255, `(${x}, 5) is back`);
  assert.equal(marked.image.data[(5 * W + 9) * 4], 120, 'as the wall, from that frame');
  assert.equal(alphaAt(marked.image, 3, 5), 0, 'outside the region is untouched');
  assert.equal(marked.stats.marked, 12);
  assert.equal(alphaAt(base.image, 9, 5), 0, 'and the background it was laid on is not changed');
});

test('a painted stroke includes, and the eraser takes out', () => {
  const frames = [frame(2), frame(14)];
  const base = consistentBackground(frames, 8);
  const painted = applyMarks(
    base,
    [
      { id: 'a', kind: 'stroke', time: 1, mode: 'include', radius: 1.5, points: [3, 5] },
      { id: 'b', kind: 'stroke', time: 1, mode: 'exclude', radius: 0.6, points: [0.5, 0.5] },
    ],
    () => frames[1],
  );
  assert.equal(alphaAt(painted.image, 3, 5), 255);
  assert.equal(alphaAt(painted.image, 0, 0), 0, 'erased');
});

test('a stroke covers the path between its points, a region its inside', () => {
  const stroke = markMask({ id: 's', kind: 'stroke', time: 0, mode: 'include', radius: 1, points: [2, 5, 17, 5] }, W, H);
  for (let x = 2; x <= 16; x += 1) assert.equal(stroke[5 * W + x], 1);
  assert.equal(stroke[0], 0);
  const region = markMask({ id: 'r', kind: 'region', time: 0, mode: 'include', points: [0, 0, 4, 0, 4, 4, 0, 4] }, W, H);
  assert.equal(region.reduce((sum, value) => sum + value, 0), 16);
  assert.equal(markMask({ id: 'x', kind: 'region', time: 0, mode: 'include', points: [0, 0, 4, 4] }, W, H).some(Boolean), false, 'two points is no region');
});

test('frames are read small enough to hold them all', () => {
  const small = backgroundFrameSize({ width: 640, height: 360 }, 24);
  assert.deepEqual(small, { width: 640, height: 360 });
  const many = backgroundFrameSize({ width: 3840, height: 2160 }, 300);
  assert.ok(many.width * many.height * 300 <= BACKGROUND_PIXEL_BUDGET * 1.01);
  assert.ok(Math.abs(many.height / many.width - 2160 / 3840) < 0.01, 'keeping its shape');
  assert.ok(backgroundFrameSize({ width: 4000, height: 1000 }, 1).width <= 1280);
});

test('the nearest frame read is used for a mark, and the report says what was kept', () => {
  const frames = [{ time: 0 }, { time: 0.5 }, { time: 1 }];
  assert.equal(nearestFrame(frames, 0.7)?.time, 0.5);
  const data = { ...emptyVideoBackgroundFlowData(), video: { duration: 2, width: 20, height: 10 }, frameSize: { width: 20, height: 10 } };
  const stats = consistentBackground([frame(2), frame(8)], 8).stats;
  assert.match(backgroundReport(data, stats), /The same in every frame, within 8: 176 pixels \(88\.0%\)/);
  assert.match(backgroundReport(emptyVideoBackgroundFlowData(), null), /Not worked out yet/);
});
