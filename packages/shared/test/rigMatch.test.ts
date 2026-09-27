import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restPose } from '../src/flows/rig';
import { posedImage } from '../src/flows/pose';
import {
  DEFAULT_RIG_MATCH_OPTIONS,
  bodyPivot,
  dragJoint,
  emptyRigMatchFlowData,
  fitSignature,
  fittedBones,
  fittedBoundRig,
  fittedImage,
  outOfPicture,
  placeInPicture,
  reportIsCurrent,
  resetPart,
  restFit,
  rigMatchState,
  rotateBody,
  scaleBody,
  summariseRigMatch,
  turnPart,
  type RigFit,
} from '../src/flows/rigMatch';
import {
  EMBEDDING_SIZE,
  LATTICE_SIZE,
  SAMPLES,
  blankBitmap,
  bodyModel,
  embedPatch,
  featureAngles,
  fineLikeness,
  featureSizes,
  likeness,
  matchRig,
  paintVector,
  patchEdges,
  pyramidOf,
  readPatch,
  scoreFit,
  type MatchCache,
} from '../src/flows/rigMatchSolve';
import type { Bitmap } from '../src/flows/cutout';
import { matchBody } from './fixtures/matchBody';

const bound = matchBody();
const pivot = bodyPivot(bound);

const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual.toFixed(2)} is not within ${tolerance} of ${expected}`);

/** A picture with the body in it, posed as `truth`, over a background. */
function pictureOf(truth: RigFit | null, width: number, height: number, background: 'noise' | 'clear' | 'stripes'): Bitmap {
  const picture = blankBitmap(width, height);
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let at = 0; at < width * height; at += 1) {
    const x = at % width;
    const y = Math.floor(at / width);
    if (background === 'clear') continue;
    if (background === 'stripes') {
      const band = ((x + y) >> 4) & 1;
      picture.data.set(band ? [230, 220, 90, 255] : [120, 110, 200, 255], at * 4);
    } else {
      const v = 190 + random() * 40;
      picture.data.set([v, v - 10, v - 30, 255], at * 4);
    }
  }
  if (truth) paintVector(picture, fittedImage(bound, truth, { width, height }));
  return picture;
}

/** How far the fit puts each joint from where the truth has it, in the picture's pixels. */
function jointErrors(fit: RigFit, truth: RigFit): { worst: number; mean: number } {
  const want = fittedBones(bound.rig, truth);
  const got = fittedBones(bound.rig, fit);
  let worst = 0;
  let sum = 0;
  for (const [id, bone] of want) {
    const other = got.get(id)!;
    const distance = Math.hypot(bone.to.x - other.to.x, bone.to.y - other.to.y);
    worst = Math.max(worst, distance);
    sum += distance;
  }
  return { worst, mean: sum / want.size };
}

/* ------------------------------------------------------------------ *
 * The fit
 * ------------------------------------------------------------------ */

test('a fit at rest places the rest pose: moved, sized and turned about the pivot', () => {
  const fit: RigFit = { ...restFit(bound, { width: 800, height: 600 }), rotation: 30 };
  const rest = restPose(bound.rig);
  for (const [id, bone] of fittedBones(bound.rig, fit)) {
    const expected = placeInPicture(fit, rest.get(id)!.to);
    near(bone.to.x, expected.x, 1e-6, `${id} x`);
    near(bone.to.y, expected.y, 1e-6, `${id} y`);
  }
  // The pivot lands where the fit says, and a point goes there and back.
  const landed = placeInPicture(fit, pivot);
  near(landed.x, fit.x, 1e-9, 'pivot x');
  const back = outOfPicture(fit, placeInPicture(fit, { x: 17, y: -40 }));
  near(back.x, 17, 1e-9, 'round trip x');
  near(back.y, -40, 1e-9, 'round trip y');
});

test('turning a part takes everything below it along, and sizing it pushes them out', () => {
  const fit = restFit(bound, { width: 400, height: 400 });
  const turned = { ...fit, angles: { 'left-upper-arm': 90 } };
  const before = fittedBones(bound.rig, fit);
  const after = fittedBones(bound.rig, turned);
  // The shoulder stays; the elbow and the hand move.
  near(after.get('left-upper-arm')!.from.x, before.get('left-upper-arm')!.from.x, 1e-9, 'shoulder x');
  assert.ok(Math.hypot(after.get('left-hand')!.to.x - before.get('left-hand')!.to.x, after.get('left-hand')!.to.y - before.get('left-hand')!.to.y) > 20);
  const sized = fittedBones(bound.rig, { ...fit, sizes: { 'left-upper-arm': 1.5 } });
  const length = (bone: { from: { x: number; y: number }; to: { x: number; y: number } }) => Math.hypot(bone.to.x - bone.from.x, bone.to.y - bone.from.y);
  near(length(sized.get('left-upper-arm')!), length(before.get('left-upper-arm')!) * 1.5, 1e-6, 'upper arm length');
  near(length(sized.get('left-forearm')!), length(before.get('left-forearm')!), 1e-6, 'forearm keeps its own size');
});

test('the drawing moves with its bones, and the fitted rig stands in the fitted pose', () => {
  const fit: RigFit = { ...restFit(bound, { width: 500, height: 500 }), rotation: -10, angles: { 'right-upper-arm': -60, head: 12 }, sizes: { 'right-forearm': 1.2 } };
  const drawing = fittedImage(bound, fit, { width: 500, height: 500 });
  assert.equal(drawing.width, 500);
  const cuff = drawing.shapes.find((shape) => shape.id === 'cuff-right')!;
  const original = bound.image.shapes.find((shape) => shape.id === 'cuff-right')!;
  // Moved as the forearm moved: not where a plain placement would put it.
  const plain = placeInPicture(fit, original.points[0]!);
  assert.ok(Math.hypot(cuff.points[0]!.x - plain.x, cuff.points[0]!.y - plain.y) > 5);

  // Re-made in the picture, its rest pose is the fit, so a Pose flow carries on from here.
  const rebuilt = fittedBoundRig(bound, fit, { width: 500, height: 500 });
  const fitted = fittedBones(bound.rig, fit);
  for (const [id, place] of restPose(rebuilt.rig)) {
    near(place.to.x, fitted.get(id)!.to.x, 1e-6, `${id} rest x`);
    near(place.to.y, fitted.get(id)!.to.y, 1e-6, `${id} rest y`);
  }
  const asPosed = posedImage(rebuilt, {});
  assert.deepEqual(asPosed.shapes.map((shape) => shape.points[0]), drawing.shapes.map((shape) => shape.points[0]));
});

test('adjusting by hand: dragging a joint turns and sizes its part, a root moves the body, limits hold', () => {
  const fit = restFit(bound, { width: 400, height: 400 });
  const bones = fittedBones(bound.rig, fit);
  const elbow = bones.get('left-upper-arm')!;
  // Straight out to the side, half as long again.
  const reach = Math.hypot(elbow.to.x - elbow.from.x, elbow.to.y - elbow.from.y) * 1.5;
  const target = { x: elbow.from.x - reach, y: elbow.from.y };
  const dragged = dragJoint(bound.rig, fit, 'left-upper-arm', target, false);
  const moved = fittedBones(bound.rig, dragged).get('left-upper-arm')!;
  near(moved.to.x, target.x, 1e-6, 'elbow x');
  near(moved.to.y, target.y, 1e-6, 'elbow y');
  near(dragged.sizes['left-upper-arm']!, 1.5, 1e-6, 'size');

  const hips = fittedBones(bound.rig, fit).get('hips')!;
  const shifted = dragJoint(bound.rig, fit, 'hips', { x: hips.to.x + 30, y: hips.to.y - 10 }, true);
  near(shifted.x, fit.x + 30, 1e-9, 'root drag moves the body');
  near(shifted.y, fit.y - 10, 1e-9, 'root drag moves the body');

  // The forearm cannot bend backwards past its joint's limit.
  const bent = turnPart(bound.rig, fit, 'left-forearm', -90, true);
  assert.equal(bent.angles['left-forearm'], 0);
  assert.equal(turnPart(bound.rig, fit, 'left-forearm', -90, false).angles['left-forearm'], -90);
  assert.deepEqual(resetPart(dragged, 'left-upper-arm').angles, {});
});

test('sizing and turning the whole body about a point keep that point still', () => {
  const fit = restFit(bound, { width: 400, height: 400 });
  const about = { x: 120, y: 80 };
  const inside = outOfPicture(fit, about);
  for (const next of [scaleBody(fit, fit.scale * 1.7, about), rotateBody(fit, 40, about)]) {
    const there = placeInPicture(next, inside);
    near(there.x, about.x, 1e-6, 'x');
    near(there.y, about.y, 1e-6, 'y');
  }
});

/* ------------------------------------------------------------------ *
 * The features
 * ------------------------------------------------------------------ */

test('the picture’s features span the size and angle ranges asked for', () => {
  const sizes = featureSizes(2);
  near(Math.min(...sizes), 0.5, 1e-9, 'smallest');
  near(Math.max(...sizes), 2, 1e-9, 'largest');
  assert.ok(sizes.includes(1));
  assert.deepEqual(featureSizes(1), [1]);
  const angles = featureAngles(45);
  assert.deepEqual(angles, [-45, -30, -15, 0, 15, 30, 45]);
  assert.deepEqual(featureAngles(0), [0]);
  // All the way round, once: -180 and 180 are the same patch.
  assert.equal(featureAngles(180).length, 24);
});

test('the features slider takes more of the body, more from bigger parts, none from parts not seen', () => {
  const few = bodyModel(bound, 4);
  const many = bodyModel(bound, 16);
  assert.ok(many.features.length > few.features.length * 2, `${many.features.length} vs ${few.features.length}`);
  const count = (id: string) => many.features.filter((feature) => feature.bone === id).length;
  assert.ok(count('chest') > count('left-hand'), 'the chest gives more than a hand');
  // The hip bone's blob is drawn entirely under the spine and thighs.
  assert.equal(count('hips'), 0);
});

test('a feature read back where it was taken matches itself; moved half a patch, or onto empty picture, it does not', () => {
  const body = bodyModel(bound, 8);
  const pyramid = pyramidOf(body.paint);
  const patch = new Float32Array(LATTICE_SIZE);
  const edges = new Float32Array(SAMPLES);
  const embedding = new Float32Array(EMBEDDING_SIZE);
  const feature = body.features.findIndex((one) => one.bone === 'head');
  const at = body.features[feature]!;
  const x = (at.x - body.paintOrigin.x) * body.paintScale;
  const y = (at.y - body.paintOrigin.y) * body.paintScale;
  const radius = body.radius * body.paintScale;
  const read = (cx: number, cy: number, angle = 0) => {
    readPatch(pyramid, cx, cy, radius, angle, patch);
    patchEdges(patch, edges);
    return fineLikeness(body, feature, patch, edges);
  };
  assert.ok(read(x, y) > 0.99, `in place: ${read(x, y)}`);
  assert.ok(read(x + radius, y) < 0.6, `half a patch over: ${read(x + radius, y)}`);
  assert.ok(read(x, y, 30) < 0.6, `turned: ${read(x, y, 30)}`);
  assert.ok(read(2, 2) < 0.05, `empty corner: ${read(2, 2)}`);
  // The quick comparison agrees on which is which.
  readPatch(pyramid, x, y, radius, 0, patch);
  patchEdges(patch, edges);
  embedPatch(patch, edges, null, embedding, 0);
  const here = likeness(body.embeddings, feature * EMBEDDING_SIZE, embedding, 0);
  readPatch(pyramid, 2, 2, radius, 0, patch);
  patchEdges(patch, edges);
  embedPatch(patch, edges, null, embedding, 0);
  assert.ok(here > likeness(body.embeddings, feature * EMBEDDING_SIZE, embedding, 0) + 0.3);
});

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

test('a posed body in a busy picture is found: placed, turned and sized, part by part', () => {
  const truth: RigFit = {
    pivot,
    x: 250,
    y: 230,
    scale: 0.75,
    rotation: 10,
    angles: { 'left-upper-arm': 50, 'right-upper-arm': -45, 'left-forearm': 40, 'right-leg-thigh': -25, head: 10 },
    sizes: {},
  };
  const picture = pictureOf(truth, 480, 440, 'noise');
  const stages: string[] = [];
  const { fit, report } = matchRig({ bound, picture, onProgress: (step) => stages.push(step.stage) });
  near(fit.x, truth.x, 6, 'x');
  near(fit.y, truth.y, 6, 'y');
  near(fit.scale, truth.scale, 0.05, 'scale');
  near(fit.rotation, truth.rotation, 4, 'rotation');
  const { worst, mean } = jointErrors(fit, truth);
  assert.ok(mean < 4, `mean joint error ${mean.toFixed(1)}px`);
  assert.ok(worst < 14, `worst joint error ${worst.toFixed(1)}px`);
  near(fit.angles['right-upper-arm'] ?? 0, -45, 8, 'right upper arm');
  assert.ok(report.confidence > 0.45, `confidence ${report.confidence}`);
  assert.ok((report.parts.chest?.confidence ?? 0) > 0.5);
  assert.equal(report.parts.hips?.confidence, null, 'a part with no features has no confidence');
  assert.ok(report.features.length === report.rigFeatures);
  assert.ok(stages.includes('Comparing features') && stages.includes('Fitting each part'));
});

test('a cut-out picture — the body on transparency — is found by its outline and colors', () => {
  const truth: RigFit = { pivot, x: 180, y: 210, scale: 0.9, rotation: -8, angles: { 'left-upper-arm': -70, 'right-upper-arm': 70, 'left-leg-thigh': -35 }, sizes: {} };
  const picture = pictureOf(truth, 360, 420, 'clear');
  const { fit } = matchRig({ bound, picture });
  near(fit.rotation, -8, 4, 'rotation');
  near(fit.scale, 0.9, 0.06, 'scale');
  assert.ok(jointErrors(fit, truth).mean < 5);
});

test('with no range of size or angle, the body is neither turned nor sized', () => {
  const truth: RigFit = { pivot, x: 200, y: 200, scale: 0.7, rotation: 0, angles: { 'left-upper-arm': 40 }, sizes: {} };
  const picture = pictureOf(truth, 400, 400, 'stripes');
  const { fit } = matchRig({ bound, picture, options: { scaleRange: 1, angleRange: 0, features: 6 } });
  assert.equal(fit.rotation, 0);
  assert.deepEqual(fit.angles, {});
  assert.deepEqual(fit.sizes, {});
});

test('a picture without the body in it says so: no confidence, and a note', () => {
  const picture = pictureOf(null, 360, 360, 'noise');
  const { report } = matchRig({ bound, picture, options: { features: 6 } });
  assert.ok(report.confidence < 0.1, `confidence ${report.confidence}`);
  assert.ok(report.notes.some((note) => /poorly/.test(note)));
});

test('refining from a placement made by hand, and re-scoring a fit moved by hand', () => {
  const truth: RigFit = { pivot, x: 210, y: 200, scale: 0.7, rotation: 5, angles: { 'right-upper-arm': -40 }, sizes: {} };
  const picture = pictureOf(truth, 420, 400, 'stripes');
  const cache: MatchCache = {};
  // Placed roughly, a little off.
  const rough: RigFit = { ...truth, x: truth.x + 8, y: truth.y - 6, rotation: 0, angles: {} };
  const { fit, report } = matchRig({ bound, picture, from: rough, cache });
  assert.ok(jointErrors(fit, truth).mean < 4);
  // The same fit re-scored says the same; the fit moved away scores lower.
  const again = scoreFit({ bound, picture, fit, cache });
  near(again.confidence, report.confidence, 0.02, 'same confidence');
  const away = scoreFit({ bound, picture, fit: { ...fit, x: fit.x + 25 }, cache });
  assert.ok(away.confidence < report.confidence - 0.15, `${away.confidence} vs ${report.confidence}`);
});

/* ------------------------------------------------------------------ *
 * The flow's state
 * ------------------------------------------------------------------ */

test('the flow knows when it has nothing, has not matched, is stale, and when a report is out of date', () => {
  const data = emptyRigMatchFlowData();
  assert.deepEqual(data.options, DEFAULT_RIG_MATCH_OPTIONS);
  assert.equal(rigMatchState(data, 'b', 'i'), 'none');
  const taken = { ...data, bound, boundHash: 'b' };
  assert.equal(rigMatchState(taken, 'b', 'i'), 'unmatched');
  assert.match(summariseRigMatch(taken), /not matched yet/);
  const fit = restFit(bound, { width: 300, height: 300 });
  const matched = {
    ...taken,
    fit,
    imageHash: 'i',
    report: { confidence: 0.8, parts: {}, features: [], rigFeatures: 1, imageFeatures: 1, agreeing: 1, ms: 1, at: '', forFit: fitSignature(fit), notes: [] },
  };
  assert.equal(rigMatchState(matched, 'b', 'i'), 'ready');
  assert.equal(rigMatchState(matched, 'b', 'other'), 'stale');
  assert.equal(rigMatchState(matched, 'changed', 'i'), 'stale');
  assert.ok(reportIsCurrent(matched));
  assert.match(summariseRigMatch(matched), /80%/);
  const moved = { ...matched, fit: { ...fit, x: fit.x + 10 } };
  assert.equal(reportIsCurrent(moved), false);
  assert.match(summariseRigMatch(moved), /by hand/);
});
