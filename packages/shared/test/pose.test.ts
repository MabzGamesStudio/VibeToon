import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_IK_OPTIONS,
  POSE_MODE_HINT,
  POSE_MODE_LABEL,
  chainUp,
  clearPose,
  emptyPoseFlowData,
  poseEffort,
  poseState,
  posedBones,
  posedImage,
  solveIk,
  summarisePose,
  turnBone,
  type PoseFlowData,
} from '../src/flows/pose';
import { emptyRigFlowData, restPose } from '../src/flows/rig';
import type { BoundRig } from '../src/flows/rigBind';
import type { VectorImage, VectorPolygon } from '../src/flows/vector';

const rig = emptyRigFlowData('human');

const patch: VectorPolygon = {
  id: 'p',
  kind: 'polygon',
  color: '#ff0000',
  points: [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
  ],
};

const image: VectorImage = { width: 100, height: 100, shapes: [patch] };

function bound(binding: Record<string, string> = {}): BoundRig {
  return { rig, image, binding };
}

/* ---------------- forward kinematics ---------------- */

test('with nothing turned, the pose is the rest pose', () => {
  const placed = posedBones(rig, {});
  const rest = restPose(rig);
  assert.equal(placed.size, rest.size);
  for (const [id, place] of placed) {
    assert.deepEqual(place.to, rest.get(id)!.to, id);
    assert.equal(place.angle, 0);
  }
});

test('turning a joint moves everything below it', () => {
  // Which is what a skeleton is for: the shoulder moves and the arm comes along.
  const before = posedBones(rig, {});
  const after = posedBones(rig, { 'left-upper-arm': 45 });

  assert.deepEqual(after.get('hips')!.to, before.get('hips')!.to, 'and nothing above it');
  for (const id of ['left-forearm', 'left-hand']) {
    assert.notDeepEqual(after.get(id)!.to, before.get(id)!.to, `${id} should have come along`);
  }
});

test('a turn is added to everything inherited from above', () => {
  const placed = posedBones(rig, { 'left-upper-arm': 30, 'left-forearm': 20 });
  assert.equal(placed.get('left-upper-arm')!.angle, 30);
  assert.equal(placed.get('left-forearm')!.angle, 50, 'its own turn plus the arm’s');
  assert.equal(placed.get('left-forearm')!.own, 20, 'while its own is what the pose stores');
});

test('turning a joint a full circle puts it back where it was', () => {
  const rest = posedBones(rig, {}).get('left-hand')!.to;
  const round = posedBones(rig, { 'left-upper-arm': 360 }).get('left-hand')!.to;
  assert.ok(Math.abs(round.x - rest.x) < 1e-9 && Math.abs(round.y - rest.y) < 1e-9);
});

test('an angle for a bone that is not there is ignored rather than throwing', () => {
  const placed = posedBones(rig, { 'no-such-bone': 90 });
  assert.equal(placed.size, rig.bones.length);
});

/* ---------------- the chain ---------------- */

test('the chain runs up from a bone towards the root', () => {
  assert.deepEqual(chainUp(rig, 'left-hand', 3).map((bone) => bone.id), [
    'left-hand',
    'left-forearm',
    'left-upper-arm',
  ]);
  assert.equal(chainUp(rig, 'left-hand', 1).length, 1);
  assert.deepEqual(chainUp(rig, 'nowhere', 3), []);
});

test('the chain stops at the root rather than running off the end', () => {
  assert.ok(chainUp(rig, 'left-hand', 99).length < 99);
});

/* ---------------- inverse kinematics ---------------- */

test('dragging a tip somewhere it can reach gets it there', () => {
  const rest = posedBones(rig, {});
  const shoulder = rest.get('left-upper-arm')!.from;
  // Comfortably inside the arm's length.
  const target = { x: shoulder.x - 10, y: shoulder.y + 10 };

  const solved = solveIk(rig, {}, 'left-hand', target, { ...DEFAULT_IK_OPTIONS, iterations: 40 });
  assert.equal(solved.reached, true, `ended ${solved.distance.toFixed(2)} away`);
  const tip = posedBones(rig, solved.pose).get('left-hand')!.to;
  assert.ok(Math.hypot(tip.x - target.x, tip.y - target.y) <= 0.5);
});

test('a target out of reach falls short, and says so rather than pretending', () => {
  const rest = posedBones(rig, {});
  const shoulder = rest.get('left-upper-arm')!.from;
  const far = { x: shoulder.x + 400, y: shoulder.y };

  const solved = solveIk(rig, {}, 'left-hand', far, { ...DEFAULT_IK_OPTIONS, iterations: 30 });
  assert.equal(solved.reached, false);
  assert.ok(solved.distance > 1, 'it is honestly far away');
});

test('a solve never hands back a pose worse than the one it started from', () => {
  // It tries nudges to break out of a stall, and a nudge is a guess.
  const rest = posedBones(rig, {});
  const hand = rest.get('left-hand')!.to;
  const target = { x: hand.x + 200, y: hand.y + 200 };
  const before = Math.hypot(hand.x - target.x, hand.y - target.y);

  const solved = solveIk(rig, {}, 'left-hand', target, { ...DEFAULT_IK_OPTIONS, iterations: 20 });
  assert.ok(solved.distance <= before + 1e-6, `${solved.distance} is worse than ${before}`);
});

test('the solver obeys joint limits, and can be told not to', () => {
  const rest = posedBones(rig, {});
  const shoulder = rest.get('left-upper-arm')!.from;
  const awkward = { x: shoulder.x + 25, y: shoulder.y + 6 };

  const held = solveIk(rig, {}, 'left-hand', awkward, {
    ...DEFAULT_IK_OPTIONS,
    iterations: 40,
    respectLimits: true,
  });
  const free = solveIk(rig, {}, 'left-hand', awkward, {
    ...DEFAULT_IK_OPTIONS,
    iterations: 40,
    respectLimits: false,
  });
  assert.ok(free.distance <= held.distance + 1e-6, 'ignoring limits cannot do worse');

  // And with limits on, no joint has gone outside what it allows.
  const elbow = held.pose['left-forearm'] ?? 0;
  assert.ok(elbow >= 0 && elbow <= 145, `the elbow bent to ${elbow}, which it cannot`);
});

test('solving the same drag twice gives the same pose', () => {
  const target = { x: -20, y: -10 };
  const once = solveIk(rig, {}, 'left-hand', target, DEFAULT_IK_OPTIONS);
  const twice = solveIk(rig, {}, 'left-hand', target, DEFAULT_IK_OPTIONS);
  assert.deepEqual(twice.pose, once.pose);
});

test('only the joints allowed to move are moved', () => {
  const solved = solveIk(rig, {}, 'left-hand', { x: -20, y: -10 }, {
    ...DEFAULT_IK_OPTIONS,
    chainLength: 2,
  });
  const turned = Object.keys(solved.pose).filter((id) => Math.abs(solved.pose[id]!) > 0.01);
  for (const id of turned) {
    assert.ok(['left-hand', 'left-forearm'].includes(id), `${id} should not have moved`);
  }
});

/* ---------------- moving the drawing ---------------- */

test('a bound shape moves with its bone', () => {
  const placed = posedImage(bound({ p: 'left-upper-arm' }), { 'left-upper-arm': 90 });
  assert.notDeepEqual(placed.shapes[0]!.points, patch.points);
});

test('an unbound shape stays where it was drawn', () => {
  // Visible, and therefore fixable. Dropping it silently would not be.
  const placed = posedImage(bound({}), { 'left-upper-arm': 90 });
  assert.deepEqual(placed.shapes[0]!.points, patch.points);
});

test('a shape does not move when its bone does not', () => {
  const placed = posedImage(bound({ p: 'left-upper-arm' }), {});
  for (const [index, point] of placed.shapes[0]!.points.entries()) {
    assert.ok(Math.abs(point.x - patch.points[index]!.x) < 1e-9);
    assert.ok(Math.abs(point.y - patch.points[index]!.y) < 1e-9);
  }
});

test('a shape keeps its size and colour when it moves', () => {
  const placed = posedImage(bound({ p: 'left-upper-arm' }), { 'left-upper-arm': 37 });
  const moved = placed.shapes[0]!;
  assert.equal(moved.color, patch.color);
  assert.equal(moved.points.length, patch.points.length);

  const side = (points: typeof patch.points) => Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y);
  assert.ok(Math.abs(side(moved.points) - side(patch.points)) < 1e-9, 'rotation is not a resize');
});

/* ---------------- the flow ---------------- */

test('a fresh pose flow holds nothing and starts at rest', () => {
  const fresh = emptyPoseFlowData();
  assert.equal(fresh.editor, 'pose');
  assert.equal(fresh.bound, null);
  assert.deepEqual(fresh.pose, {});
  assert.equal(fresh.mode, 'forward');
  assert.equal(poseState(fresh, 'x'), 'none');
});

test('turning a joint through the flow keeps it inside its limits', () => {
  const data: PoseFlowData = { ...emptyPoseFlowData(), bound: bound() };
  // The elbow bends one way only.
  assert.equal(turnBone(data, 'left-forearm', -90).pose['left-forearm'], 0);
  assert.equal(turnBone(data, 'left-forearm', 60).pose['left-forearm'], 60);

  const loose = { ...data, ik: { ...data.ik, respectLimits: false } };
  assert.equal(turnBone(loose, 'left-forearm', -90).pose['left-forearm'], -90);
});

test('going back to rest clears every angle', () => {
  const data: PoseFlowData = { ...emptyPoseFlowData(), bound: bound(), pose: { hips: 20 } };
  assert.deepEqual(clearPose(data).pose, {});
  assert.equal(poseEffort({ a: 10, b: -5 }), 15);
});

test('both ways of moving it are named and explained', () => {
  for (const mode of ['forward', 'inverse'] as const) {
    assert.ok(POSE_MODE_LABEL[mode].length > 3, mode);
    assert.ok(POSE_MODE_HINT[mode].length > 30, mode);
  }
});

test('the summary says what is there and how much of it has moved', () => {
  const data: PoseFlowData = {
    ...emptyPoseFlowData(),
    bound: bound({ p: 'hips' }),
    pose: { hips: 20, spine: 0 },
  };
  const text = summarisePose(data);
  assert.match(text, /bone\(s\)/);
  assert.match(text, /1 shape\(s\) bound/);
  assert.match(text, /1 joint\(s\) turned/, 'an angle of zero is not a turn');
  assert.equal(summarisePose(emptyPoseFlowData()), 'Nothing to pose yet.');
});
