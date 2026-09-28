import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FACE_FEATURES,
  assignShapes,
  composeFeature,
  composeHead,
  emptyFaceFlowData,
  facePartsFile,
  featureKind,
  featureShapes,
  identifyFace,
  makeHead,
  reidentify,
  setFeature,
  setHeadImage,
  summariseFace,
  swapChoices,
  type FaceFlowData,
} from '../src/flows/face';
import { allPoints, boundsOf } from '../src/flows/vector';
import { normaliseFlowData } from '../src/project/migrate';
import { splitIntoParts } from '../src/flows/rigParts';
import { faceDrawing } from './fixtures/faceDrawing';
import { matchBody } from './fixtures/matchBody';

const box = (shapes: ReturnType<typeof composeFeature>) => boundsOf(shapes.flatMap((shape) => allPoints(shape)));

function twoHeads(): FaceFlowData {
  const a = makeHead('a', 'Ann', faceDrawing('a-'), { node: 'n', part: null });
  const b = makeHead('b', 'Bo', faceDrawing('b-', 200, 0.8, '#2050c0'), { node: 'n', part: null });
  return { ...emptyFaceFlowData(), heads: [a, b], current: 'a' };
}

test('every feature of a cartoon head is found: face, hair, ears, brows, eyes with pupils, nose, mouth with teeth', () => {
  assert.deepEqual(identifyFace(faceDrawing()), {
    face: 'face',
    hair: 'hair',
    'ear-l': 'ear-left',
    'ear-r': 'ear-right',
    'eye-l': 'eye-left',
    'eye-r': 'eye-right',
    'pupil-l': 'eye-left',
    'pupil-r': 'eye-right',
    'brow-l': 'brow-left',
    'brow-r': 'brow-right',
    mouth: 'mouth',
    teeth: 'mouth',
    nose: 'nose',
  });
});

test('found the same wherever the head is and however big', () => {
  const moved = identifyFace(faceDrawing('', 150, 1.6));
  assert.equal(moved['eye-l'], 'eye-left');
  assert.equal(moved.mouth, 'mouth');
  assert.equal(moved.hair, 'hair');
});

test('the head part of a bound body: its face, hair band, eyes and mouth', () => {
  const head = splitIntoParts(matchBody()).find((part) => part.id === 'head')!;
  assert.deepEqual(identifyFace(head.image), { 'part-head': 'face', hair: 'hair', 'eye-left': 'eye-left', 'eye-right': 'eye-right', mouth: 'mouth' });
});

test('a face missing features finds what is there and nothing else', () => {
  const drawing = faceDrawing();
  const noEyes = { ...drawing, shapes: drawing.shapes.filter((shape) => !/^(eye|pupil)/.test(shape.id)) };
  const found = identifyFace(noEyes);
  assert.ok(!Object.values(found).includes('eye-left'));
  assert.equal(found.mouth, 'mouth');
  assert.deepEqual(identifyFace({ width: 10, height: 10, shapes: [] }), {});
});

test('shapes can be given to another feature, or to none; finding again forgets that', () => {
  const data = twoHeads();
  const given = assignShapes(data, 'a', ['a-nose'], 'mouth');
  assert.equal(given.heads[0]!.assign['a-nose'], 'mouth');
  assert.equal(given.edits, data.edits + 1);
  const none = assignShapes(given, 'a', ['a-nose'], null);
  assert.equal(none.heads[0]!.assign['a-nose'], undefined);
  assert.equal(reidentify(none, 'a').heads[0]!.assign['a-nose'], 'nose');
});

test('a hidden feature is left out of the face; the rest is drawn back to front', () => {
  const data = setFeature(twoHeads(), 'a', 'hair', { hidden: true });
  const head = composeHead(data, data.heads[0]!);
  assert.ok(!head.shapes.some((shape) => shape.id === 'a-hair'));
  assert.equal(head.shapes.length, faceDrawing().shapes.length - 1);
  const ids = head.shapes.map((shape) => shape.id);
  assert.ok(ids.indexOf('a-face') < ids.indexOf('a-eye-l'), 'the face under the eyes');
});

test('a swapped feature is the other head’s, fitted to where this one’s was', () => {
  const data = setFeature(twoHeads(), 'a', 'eye-left', { swap: { head: 'b', feature: 'eye-left' } });
  const swapped = composeFeature(data, data.heads[0]!, 'eye-left');
  assert.ok(swapped.every((shape) => shape.id.startsWith('b~')), 'the other head’s shapes, with ids of their own');
  assert.equal(swapped[0]!.color, '#2050c0');
  const own = box(featureShapes(data.heads[0]!, 'eye-left'));
  const got = box(swapped);
  assert.ok(Math.abs(got.x + got.width / 2 - (own.x + own.width / 2)) < 0.5, 'same middle');
  assert.ok(Math.abs(got.width - own.width) < 1, 'same size');
});

test('a feature can be swapped in where the head had none, placed as it sat on its own face', () => {
  let data = twoHeads();
  data = assignShapes(data, 'a', ['a-nose'], null);
  data = setFeature(data, 'a', 'nose', { swap: { head: 'b', feature: 'nose' } });
  const nose = box(composeFeature(data, data.heads[0]!, 'nose'));
  const face = box(featureShapes(data.heads[0]!, 'face'));
  assert.ok(Math.abs(nose.x + nose.width / 2 - (face.x + face.width / 2)) < 2, 'in the middle of this face');
});

test('a feature can be nudged and sized about its middle', () => {
  const data = setFeature(twoHeads(), 'a', 'mouth', { dx: 5, dy: -3, scale: 2 });
  const own = box(featureShapes(data.heads[0]!, 'mouth'));
  const got = box(composeFeature(data, data.heads[0]!, 'mouth'));
  assert.ok(Math.abs(got.x + got.width / 2 - (own.x + own.width / 2 + 5)) < 0.1);
  assert.ok(Math.abs(got.width - own.width * 2) < 0.1);
});

test('swap choices are the same kind of feature, from any head, never itself', () => {
  const choices = swapChoices(twoHeads(), 'a', 'eye-left');
  assert.ok(choices.every((choice) => featureKind(choice.feature) === 'eye'));
  assert.ok(!choices.some((choice) => choice.head === 'a' && choice.feature === 'eye-left'));
  assert.ok(choices.some((choice) => choice.head === 'a' && choice.feature === 'eye-right'), 'the other eye of the same head');
  assert.ok(choices.some((choice) => choice.head === 'b'));
});

test('editing a head’s shapes forgets the features of shapes that are gone', () => {
  const data = twoHeads();
  const head = data.heads[0]!;
  const edited = setHeadImage(data, 'a', { ...head.image, shapes: head.image.shapes.filter((shape) => shape.id !== 'a-nose') });
  assert.ok(!('a-nose' in edited.heads[0]!.assign));
});

test('the file written has every feature of every head, as set', () => {
  const data = setFeature(twoHeads(), 'a', 'hair', { hidden: true });
  const file = facePartsFile(data);
  assert.equal(file.heads.length, 2);
  const hair = file.heads[0]!.features.find((feature) => feature.id === 'hair')!;
  assert.equal(hair.hidden, true);
  assert.deepEqual(hair.shapes, []);
  assert.equal(file.heads[0]!.features.length, FACE_FEATURES.length);
  assert.match(summariseFace(data), /Ann: 10 of 10 features, 1 hidden/);
  const old = normaliseFlowData({ editor: 'face' } as never) as FaceFlowData;
  assert.deepEqual([old.heads, old.isolate, old.paint, old.edits], [[], null, null, 0]);
});
