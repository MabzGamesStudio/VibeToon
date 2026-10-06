import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipFrameTimes, clipLength, frameLengthOf, snapToClipFrame } from '../src/flows/clipFrames';

const SPAN = { first: 0.04, last: 2.44, frame: 0.04 }; // a 25 fps clip whose first frame is at 0.04 s

test('frames in all are spread from the first frame to the last, both included, on the clip’s frames', () => {
  const times = clipFrameTimes(SPAN, { mode: 'total', fps: 2, total: 5 });
  assert.deepEqual(times, [0.04, 0.64, 1.24, 1.84, 2.44]);
  for (const time of times) assert.ok(Math.abs(((time - SPAN.first) / SPAN.frame) % 1) < 1e-6 || Math.abs(((time - SPAN.first) / SPAN.frame) % 1 - 1) < 1e-6);
});

test('frames a second step from the first frame while there are frames', () => {
  const times = clipFrameTimes(SPAN, { mode: 'fps', fps: 2, total: 5 });
  // Every half second from 0.04 s, each on the nearest frame: 0.54 s is between 0.52 and 0.56, and rounds up.
  assert.deepEqual(times, [0.04, 0.56, 1.04, 1.56, 2.04]);
  assert.equal(snapToClipFrame(SPAN, 0.53), 0.52);
  assert.ok(times.every((time) => time >= SPAN.first && time <= SPAN.last));
});

test('a short clip asked for more frames than it has gives each frame once', () => {
  const short = { first: 0, last: 0.1, frame: 1 / 30 };
  const times = clipFrameTimes(short, { mode: 'total', fps: 2, total: 40 });
  assert.equal(times.length, 4);
  assert.equal(new Set(times).size, 4);
});

test('one frame is read from the middle; a broken span reads nothing', () => {
  assert.deepEqual(clipFrameTimes(SPAN, { mode: 'total', fps: 2, total: 1 }), [1.24]);
  assert.deepEqual(clipFrameTimes({ first: 1, last: 0, frame: 0.04 }, { mode: 'total', fps: 2, total: 5 }), []);
});

test('the length runs to the end of the last frame; the frame length ignores dropped frames', () => {
  assert.ok(Math.abs(clipLength(SPAN) - 2.44) < 1e-9);
  assert.ok(Math.abs(frameLengthOf([0, 0.0333, 0.0667, 0.1333, 0.1667]) - 1 / 30) < 0.002);
  assert.equal(frameLengthOf([0.5]), 1 / 30, 'nothing to go on: the fallback');
});

test('the frame rate is the middle gap, snapped to a standard rate; drops and stutters do not move it', async () => {
  const { frameRateOf } = await import('../src/flows/clipFrames');
  const at30 = Array.from({ length: 12 }, (_, i) => i / 30);
  assert.equal(frameRateOf(at30), 30);
  // A dropped frame (one gap doubled) and a stutter (one gap short).
  const rough = [0, 1 / 30, 2 / 30, 4 / 30, 5 / 30, 5.4 / 30, 6 / 30, 7 / 30, 8 / 30];
  assert.equal(frameRateOf(rough), 30);
  assert.equal(frameRateOf(Array.from({ length: 10 }, (_, i) => i / 23.976)), 23.976);
  assert.equal(frameRateOf(Array.from({ length: 10 }, (_, i) => i / 60)), 60);
  assert.equal(frameRateOf([0.2]), 30, 'nothing to go on');
});

test('frames are picked from the frames a clip has, never one twice, however unevenly they come', async () => {
  const { pickFrameTimes, gridFrameTimes, spanOfFacts } = await import('../src/flows/clipFrames');
  // A clip a browser recorded as it played: frames bunched, then a half-second gap.
  const uneven = [0, 0.065, 0.13, 0.131, 0.2, 0.68, 0.75, 0.81, 0.9, 1.0];
  const all = pickFrameTimes(uneven, { mode: 'total', fps: 2, total: 40 });
  assert.deepEqual(all, uneven, 'asked for more than there are: each frame once');
  const five = pickFrameTimes(uneven, { mode: 'total', fps: 2, total: 5 });
  assert.equal(new Set(five).size, 5);
  assert.deepEqual([five[0], five[4]], [0, 1.0], 'the first and the last');
  // Ten a second across the gap: the frame nearest each time, and the long one only once.
  const tenASecond = pickFrameTimes(uneven, { mode: 'fps', fps: 10, total: 5 });
  assert.equal(new Set(tenASecond).size, tenASecond.length);
  assert.ok(tenASecond.every((time) => uneven.includes(time)));
  assert.ok(tenASecond.filter((time) => time > 0.2 && time < 0.68).length === 0, 'there is no frame in the gap to give');
  // A clip written frame by frame at 30 fps: its facts make the same grid.
  const facts = { first: 0, duration: 3, last: 3 - 1 / 30, frames: 90, fps: 30, width: 64, height: 36, exact: true };
  const grid = gridFrameTimes(spanOfFacts(facts));
  assert.equal(grid.length, 90);
  assert.ok(Math.abs(grid[89]! - (3 - 1 / 30)) < 1e-6);
  assert.deepEqual(pickFrameTimes([], { mode: 'total', fps: 2, total: 5 }), []);
});
