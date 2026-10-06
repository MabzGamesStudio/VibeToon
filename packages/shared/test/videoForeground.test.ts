import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  alignToBackgroundWork,
  buildForeground,
  emptyVideoForegroundFlowData,
  foregroundFile,
  foregroundFrameLimit,
  foregroundFrameName,
  foregroundOf,
  foregroundReport,
  foregroundWork,
  labelPieces,
  readFrameName,
  type ForegroundOptions,
} from '../src/flows/videoForeground';

const W = 64;
const H = 48;
const plain: ForegroundOptions = { steady: false, maxShift: 0, tolerance: 10, speck: 0, holes: 0, grow: 0, unknown: 'keep' };

/** A scene with something to line up on: blocks of colour. */
function scene(width: number, height: number, seed = 3): Bitmap {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cols = Math.ceil(width / 8);
  const blocks = Array.from({ length: Math.ceil(height / 8) * cols }, () => [random() * 200 + 20, random() * 200 + 20, random() * 200 + 20]);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const block = blocks[Math.floor(y / 8) * cols + Math.floor(x / 8)]!;
      data.set([block[0]!, block[1]!, block[2]!, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** What a camera at (sx, sy) sees of a scene, with boxes in front. */
function view(world: Bitmap, sx: number, sy: number, boxes: Array<{ x: number; y: number; w: number; h: number; colour: [number, number, number] }> = []): Bitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const from = ((y + sy) * world.width + (x + sx)) * 4;
      const box = boxes.find((one) => x >= one.x && x < one.x + one.w && y >= one.y && y < one.y + one.h);
      data.set(box ? [...box.colour, 255] : world.data.subarray(from, from + 4), (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}

const world = scene(W + 20, H + 20);
const background = view(world, 10, 10);
const kept = (mask: Uint8Array) => mask.reduce((sum, value) => sum + value, 0);

test('a new Video Foreground reads 24 frames, lines them up, and keeps what it cannot compare', () => {
  const data = emptyVideoForegroundFlowData();
  assert.equal(data.editor, 'videoForeground');
  assert.deepEqual([data.sampling.mode, data.sampling.total], ['total', 24]);
  assert.equal(data.steady, true);
  assert.equal(data.unknown, 'keep');
  assert.ok(foregroundFrameLimit(1280, 720) >= 24, 'two dozen 720p frames fit');
});

test('only what is in front of the background is kept, in its own colours; the rest is clear', () => {
  const frame = view(world, 10, 10, [{ x: 20, y: 10, w: 10, h: 16, colour: [250, 20, 200] }]);
  const out = foregroundOf(frame, background, { dx: 0, dy: 0 }, plain);
  assert.equal(kept(out.mask), 160);
  assert.equal(out.stats.kept, 160);
  assert.equal(out.stats.pieces, 1);
  assert.deepEqual([...out.image.data.slice((15 * W + 25) * 4, (15 * W + 25) * 4 + 4)], [250, 20, 200, 255]);
  assert.equal(out.image.data[3], 0, 'the background is clear');
});

test('a colour within the tolerance of the background is the background, and an edge that wavers a pixel is too', () => {
  const noisy = view(world, 10, 10);
  for (let p = 0; p < W * H; p += 1) noisy.data[p * 4] = Math.min(255, noisy.data[p * 4]! + 12);
  assert.equal(foregroundOf(noisy, background, { dx: 0, dy: 0 }, plain).stats.kept, 0, 'a little noise everywhere is not something in front');
  assert.ok(foregroundOf(noisy, background, { dx: 0, dy: 0 }, { ...plain, tolerance: 1 }).stats.kept > W * H * 0.9, 'unless the tolerance says it is');
  // The whole picture a pixel off: every block edge wavers, and none of it is taken for a character.
  const shifted = view(world, 11, 10);
  assert.equal(foregroundOf(shifted, background, { dx: 0, dy: 0 }, plain).stats.kept, 0);
});

test('specks are dropped, holes filled, and what is kept is grown', () => {
  const frame = view(world, 10, 10, [
    { x: 10, y: 10, w: 2, h: 2, colour: [255, 255, 0] },
    { x: 30, y: 10, w: 12, h: 12, colour: [0, 255, 255] },
  ]);
  // A hole in the big one: the background shows through its middle.
  for (let y = 14; y < 18; y += 1) for (let x = 34; x < 38; x += 1) frame.data.set(background.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * W + x) * 4);
  assert.equal(foregroundOf(frame, background, { dx: 0, dy: 0 }, plain).stats.kept, 4 + 144 - 16);
  const tidy = foregroundOf(frame, background, { dx: 0, dy: 0 }, { ...plain, speck: 10, holes: 20 });
  assert.equal(tidy.stats.kept, 144, 'the 4-pixel speck gone, the 16-pixel hole filled');
  assert.equal(tidy.stats.pieces, 1);
  const grown = foregroundOf(frame, background, { dx: 0, dy: 0 }, { ...plain, speck: 10, holes: 20, grow: 1 });
  assert.equal(grown.stats.kept, 14 * 14, 'a pixel all round');
});

test('where the background is clear there is nothing to compare: kept or cleared as asked', () => {
  const holed = { ...background, data: new Uint8ClampedArray(background.data) };
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) holed.data[(y * W + x) * 4 + 3] = 0;
  const frame = view(world, 10, 10);
  assert.equal(foregroundOf(frame, holed, { dx: 0, dy: 0 }, plain).stats.unknown > 0, true);
  const keep = foregroundOf(frame, holed, { dx: 0, dy: 0 }, plain).stats.kept;
  const clear = foregroundOf(frame, holed, { dx: 0, dy: 0 }, { ...plain, unknown: 'clear' }).stats.kept;
  assert.ok(keep >= 64 && keep <= 100, `${keep}: the clear corner, but for its edge that a neighbour matches`);
  assert.equal(clear, 0);
});

test('a shaking camera is followed: each frame is lined up with the background, and only the character is kept', () => {
  const shakes = [
    [10, 10],
    [12, 9],
    [8, 12],
    [11, 11],
    [9, 8],
  ] as const;
  const frames = shakes.map(([sx, sy], index) => view(world, sx, sy, [{ x: 8 + index * 9, y: 14, w: 8, h: 14, colour: [250, 30, 30] }]));
  const work = alignToBackgroundWork(background, frames, 6);
  let next = work.next();
  while (!next.done) next = work.next();
  // A camera further right sees the background further left: the background's (x, y) is the frame's (x - 2, y + 1).
  assert.deepEqual(next.value, shakes.map(([sx, sy]) => ({ dx: 10 - sx, dy: 10 - sy })));
  const out = buildForeground(background, frames, { ...plain, steady: true, maxShift: 6, unknown: 'clear' });
  for (const [index, frame] of out.entries()) assert.equal(frame.stats.kept, 8 * 14, `frame ${index}: the box and nothing else`);
  const unsteady = buildForeground(background, frames, { ...plain, unknown: 'clear' });
  assert.ok(unsteady[1]!.stats.kept > 8 * 14 * 3, 'not lined up, the shaken scene is taken for something in front');
});

test('the work runs a slice at a time, and offsets worked out before are used as they are', () => {
  const frames = [view(world, 10, 10), view(world, 11, 10)];
  const work = foregroundWork(background, frames, { ...plain, steady: true, maxShift: 4 });
  const stages = new Set<string>();
  let next = work.next();
  while (!next.done) {
    stages.add(next.value.stage);
    next = work.next();
  }
  assert.deepEqual([...stages].sort(), ['apart', 'steady']);
  assert.deepEqual(next.value[1]!.offset, { dx: -1, dy: 0 });
  const given = buildForeground(background, frames, { ...plain, steady: true, maxShift: 4 }, [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  assert.deepEqual(given[1]!.offset, { dx: 0, dy: 0 });
});

test('frames are named for their place and time, and the name reads back', () => {
  assert.equal(foregroundFrameName(0, 0), 'frame-0001-at-0.000s.png');
  assert.equal(foregroundFrameName(11, 1.25), 'frame-0012-at-1.250s.png');
  assert.deepEqual(readFrameName('frame-0012-at-1.250s.png'), { index: 11, time: 1.25 });
  assert.deepEqual(readFrameName('shots/frame-007.png'), { index: 6, time: null }, 'another flow’s frames: the place, no time');
});

test('pieces are labelled 8-connected, or 4-connected when asked', () => {
  const mask = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(labelPieces(mask, 3, 3).sizes.length - 1, 1, 'corner to corner is one piece');
  assert.equal(labelPieces(mask, 3, 3, false).sizes.length - 1, 3);
});

test('the report and foreground.json say what each frame kept and where it sat', () => {
  const data = { ...emptyVideoForegroundFlowData(), video: { duration: 2, width: 64, height: 48 }, background: { width: 64, height: 48 } };
  const frames = [
    { time: 0, offset: { dx: 0, dy: 0 }, kept: 160, total: W * H, pieces: 1 },
    { time: 0.5, offset: { dx: -2, dy: 1 }, kept: 300, total: W * H, pieces: 2 },
  ];
  const report = foregroundReport(data, frames);
  assert.match(report, /2 frame\(s\)/);
  assert.match(report, /\| frame-0002-at-0\.500s\.png \| 0\.500s \| 9\.8% \| 2 \| -2 \| 1 \|/);
  assert.match(foregroundReport(emptyVideoForegroundFlowData(), []), /Not worked out yet/);
  const json = JSON.parse(foregroundFile(data, frames));
  assert.equal(json.kind, 'foreground');
  assert.deepEqual(json.frames[1], { file: 'frame-0002-at-0.500s.png', time: 0.5, offset: { dx: -2, dy: 1 }, kept: 300, share: 0.0977, pieces: 2 });
});
