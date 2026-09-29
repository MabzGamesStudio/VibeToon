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
