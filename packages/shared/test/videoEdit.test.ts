import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clipName,
  editFile,
  editKey,
  editedDuration,
  emptyVideoEditFlowData,
  joinSegments,
  keptSegments,
  playOnFrom,
  editSegments,
  snapToFrame,
  sourceTimeAt,
  splitSegmentAt,
  summariseEdit,
  toggleSegment,
  videoCropRect,
  clampEditView,
  editShotCuts,
  editViewShowing,
  filmstripFrames,
  panEditView,
  rulerTicks,
  splitAtCuts,
  stepFrame,
  frameIndex,
  frameStart,
  nearestFrameStart,
  zoomEditView,
  type VideoEditFlowData,
} from '../src/flows/videoEdit';

/** A 10 second, 640 × 360 video, at 25 frames a second. */
function edit(over: Partial<VideoEditFlowData> = {}): VideoEditFlowData {
  return { ...emptyVideoEditFlowData(), video: { hash: 'v1', duration: 10, width: 640, height: 360 }, fps: 25, ...over };
}

test('an untouched video is one segment, the whole of it', () => {
  assert.deepEqual(editSegments(edit(), 10), [{ start: 0, end: 10, deleted: false }]);
  assert.deepEqual(editSegments(edit(), 0), [], 'no video, no segments');
});

test('splitting cuts the segment under a time in two, at the nearest frame', () => {
  const once = splitSegmentAt(edit(), 3.013);
  assert.deepEqual(editSegments(once, 10), [
    { start: 0, end: 3, deleted: false },
    { start: 3, end: 10, deleted: false },
  ]);
  assert.equal(once.selected, 1);
  const twice = splitSegmentAt(once, 7.5);
  assert.equal(editSegments(twice, 10).length, 3);
  assert.equal(splitSegmentAt(twice, 3), twice, 'a split on an edge does nothing');
  assert.equal(splitSegmentAt(twice, 0), twice);
  assert.equal(snapToFrame(1.019, 25), 1, 'frames are 0.04s apart: 1.019 is nearest 1.00');
  assert.equal(snapToFrame(1.03, 25), 1.04);
});

test('deleting a segment leaves it out, and it can be kept again', () => {
  const cut = toggleSegment(splitSegmentAt(splitSegmentAt(edit(), 2), 6), 1);
  assert.deepEqual(keptSegments(cut), [
    { start: 0, end: 2, deleted: false },
    { start: 6, end: 10, deleted: false },
  ]);
  assert.equal(editedDuration(cut), 6);
  assert.equal(editedDuration(toggleSegment(cut, 1)), 10);
});

test('joining two segments makes one, kept if either was', () => {
  const cut = toggleSegment(splitSegmentAt(splitSegmentAt(edit(), 2), 6), 1);
  const joined = joinSegments(cut, 0);
  assert.deepEqual(editSegments(joined, 10), [
    { start: 0, end: 6, deleted: false },
    { start: 6, end: 10, deleted: false },
  ]);
  const bothGone = joinSegments(toggleSegment(toggleSegment(splitSegmentAt(edit(), 5), 0), 1), 0);
  assert.deepEqual(editSegments(bothGone, 10), [{ start: 0, end: 10, deleted: true }]);
  assert.equal(joinSegments(joined, 1), joined, 'nothing after the last');
});

test('segments are tidied to run end to end over the whole video', () => {
  const messy = edit({
    segments: [
      { start: 4, end: 20, deleted: true },
      { start: 0.5, end: 3, deleted: false },
    ],
  });
  assert.deepEqual(editSegments(messy, 10), [
    { start: 0, end: 4, deleted: false },
    { start: 4, end: 10, deleted: true },
  ]);
});

test('playing the edit maps its time back into the video, skipping what was deleted', () => {
  const cut = toggleSegment(splitSegmentAt(splitSegmentAt(edit(), 2), 6), 1);
  assert.deepEqual(sourceTimeAt(cut, 1), { segment: 0, time: 1 });
  assert.deepEqual(sourceTimeAt(cut, 2.5), { segment: 1, time: 6.5 });
  assert.equal(sourceTimeAt(cut, 6), null, 'past the end of the edit');
  assert.equal(playOnFrom(cut, 3), 6, 'from inside a deleted segment, on to the next kept one');
  assert.equal(playOnFrom(cut, 7), 7);
  assert.equal(playOnFrom(cut, 9.9995), null);
});

test('the crop is kept inside the video, with even sides', () => {
  assert.deepEqual(videoCropRect(edit()), { x: 0, y: 0, width: 640, height: 360 });
  assert.deepEqual(videoCropRect(edit({ crop: { x: 600, y: 10, width: 101, height: 51 } })), { x: 539, y: 10, width: 100, height: 50 });
  assert.equal(videoCropRect(emptyVideoEditFlowData()), null);
});

test('the edit key changes with anything that changes what is rendered, and not with what is selected', () => {
  const base = edit();
  assert.equal(editKey(base), editKey({ ...base, selected: 3 }));
  assert.notEqual(editKey(base), editKey(splitSegmentAt(base, 5)), 'a split alone changes the clips');
  assert.notEqual(editKey(base), editKey({ ...base, output: 'clips' }));
  assert.notEqual(editKey(base), editKey({ ...base, crop: { x: 0, y: 0, width: 320, height: 180 } }));
});

test('the edit file lists what was kept, what went, and the clip each became', () => {
  const cut = { ...toggleSegment(splitSegmentAt(splitSegmentAt(edit(), 2), 6), 1), output: 'clips' as const };
  const file = JSON.parse(editFile(cut));
  assert.deepEqual(file.keep, [
    { start: 0, end: 2, clip: 'clip-01.webm' },
    { start: 6, end: 10, clip: 'clip-02.webm' },
  ]);
  assert.deepEqual(file.deleted, [{ start: 2, end: 6 }]);
  assert.equal(file.duration, 6);
  assert.equal(clipName(9), 'clip-10.webm');
  assert.match(summariseEdit(cut), /0:10\.00 → 0:06\.00 · 2 of 3 segment\(s\) kept · 2 clip\(s\)/);
});

test('left and right step a frame at a time, and stop at the ends', () => {
  assert.equal(stepFrame(1, 25, 1, 10), 1.04);
  assert.equal(stepFrame(1.03, 25, 1, 10), 1.04, 'from inside a frame, to the start of the next');
  assert.equal(stepFrame(1.03, 25, -1, 10), 0.96, 'and back to the start of the one before');
  assert.equal(stepFrame(0, 25, -1, 10), 0);
  assert.equal(stepFrame(9.99, 25, 1, 10), 9.96, 'the last frame starts a frame before the end');
  assert.equal(stepFrame(5, 25, 25, 10), 6, 'a second on');
});

test('stepping on and on moves a frame each time, whatever the rate', () => {
  for (const fps of [24, 25, 29.97, 30, 60]) {
    let time = 0;
    for (let step = 1; step <= 200; step += 1) {
      time = stepFrame(time, fps, 1, 60);
      assert.equal(frameIndex(time, fps), step, `${fps} fps, step ${step}: at ${time}`);
    }
    // Even when the player hands the time back rounded to the millisecond.
    time = Math.round(stepFrame(0, fps, 91, 60) * 1000) / 1000;
    assert.equal(frameIndex(stepFrame(time, fps, 1, 60), fps), 92, `${fps} fps from a rounded time`);
  }
  assert.equal(stepFrame(91 / 30, 30, 1, 10), frameStart(92, 30));
  assert.ok(frameStart(91, 30) >= 91 / 30 - 1e-6, 'a frame is shown from its exact start, not a hair before');
  assert.equal(nearestFrameStart(3.02, 30), frameStart(91, 30));
});

test('shot cuts found in the video split it, and only for that video', () => {
  const found = edit({ shots: { hash: 'v1', cuts: [2.5, 4.2, 0, 11] } });
  assert.deepEqual(editShotCuts(found), [2.5, 4.2], 'inside the video only');
  assert.deepEqual(editShotCuts({ ...found, shots: { hash: 'old', cuts: [2.5] } }), [], 'cuts from another video are not shown');
  const split = splitAtCuts(found, editShotCuts(found));
  assert.deepEqual(
    editSegments(split, 10).map((segment) => [segment.start, segment.end]),
    [
      [0, 2.52],
      [2.52, 4.2],
      [4.2, 10],
    ],
    'on the frame nearest each cut',
  );
  assert.equal(splitAtCuts(split, [4.2]), split, 'splitting on an edge again changes nothing');
});

test('the timeline zooms about a time, which stays put, and pans inside the video', () => {
  const whole = { from: 0, to: 10 };
  const zoomed = zoomEditView(whole, 10, 25, 5, 2);
  assert.deepEqual(zoomed, { from: 2.5, to: 7.5 }, 'about the middle');
  const aboutTwo = zoomEditView(whole, 10, 25, 2, 4);
  assert.ok(Math.abs((2 - aboutTwo.from) / (aboutTwo.to - aboutTwo.from) - 0.2) < 1e-9, 'the time is as far across as before');
  assert.deepEqual(zoomEditView(zoomed, 10, 25, 5, 0.1), whole, 'out no further than the whole video');
  const tight = zoomEditView(whole, 10, 25, 5, 1000);
  assert.ok(Math.abs(tight.to - tight.from - 12 / 25) < 1e-9, 'in no further than a few frames');
  assert.deepEqual(panEditView(zoomed, 10, 25, 4), { from: 5, to: 10 }, 'not past the end');
  assert.deepEqual(panEditView(zoomed, 10, 25, -4), { from: 0, to: 5 }, 'nor before the start');
  assert.deepEqual(clampEditView({ from: -3, to: 20 }, 10, 25), whole);
  assert.deepEqual(editViewShowing(zoomed, 10, 25, 6), zoomed, 'a time in view leaves it alone');
  const followed = editViewShowing(zoomed, 10, 25, 8);
  assert.ok(followed.from < 8 && followed.to > 8 && Math.abs(followed.to - followed.from - 5) < 1e-9, 'a time out of view brings it in, the same length');
});

test('ruler marks and filmstrip frames fit the zoom', () => {
  const ruler = rulerTicks({ from: 0, to: 10 }, 700, 25);
  assert.equal(ruler.step, 1);
  assert.deepEqual(ruler.ticks.slice(0, 3), [0, 1, 2]);
  const close = rulerTicks({ from: 1, to: 1.4 }, 700, 25);
  assert.ok(Math.abs(close.step - 0.04) < 1e-9, 'zoomed right in, every frame');
  const strip = filmstripFrames({ from: 0, to: 10 }, 800, 80, 25, 10);
  assert.equal(strip.every, 32, '25 frames a tile, rounded up to a power of two');
  assert.deepEqual(strip.frames.slice(0, 3), [0, 32, 64]);
  const closer = filmstripFrames({ from: 2, to: 4 }, 800, 80, 25, 10);
  assert.ok(closer.frames.every((frame) => frame % closer.every === 0));
  assert.ok(strip.every % closer.every === 0, 'the tiles zoomed out are among those zoomed in');
});
