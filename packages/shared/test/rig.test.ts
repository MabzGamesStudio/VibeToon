import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mirrorAxis,
  moveRigJoint,
  DEFAULT_RIG_OPTIONS,
  RIG_KINDS,
  boneById,
  boneLength,
  chainById,
  changeRigKind,
  childrenOf,
  effectiveAngles,
  effectiveStretch,
  emptyRigFlowData,
  mirrorIdOf,
  resetBone,
  restPose,
  rigProblems,
  rigTemplate,
  rootBones,
  setBoneLimits,
  setChain,
  summariseRig,
  type RigKind,
} from '../src/flows/rig';

/* ---------------- the skeletons themselves ---------------- */

test('every character type builds a skeleton that hangs together', () => {
  for (const kind of RIG_KINDS) {
    const data = emptyRigFlowData(kind);
    const ids = new Set(data.bones.map((bone) => bone.id));

    assert.equal(ids.size, data.bones.length, `${kind}: two bones share an id`);
    assert.ok(data.bones.length >= 2, `${kind}: ${data.bones.length} bones is not a skeleton`);
    assert.equal(rootBones(data).length, 1, `${kind}: should have exactly one root`);
    assert.equal(
      restPose(data).size,
      data.bones.length,
      `${kind}: some bones are not reachable from the root`,
    );
    assert.deepEqual(rigProblems(data), [], `${kind}: ${JSON.stringify(rigProblems(data))}`);
    assert.ok(rigTemplate(kind).note.length > 20, `${kind}: says nothing about itself`);
  }
});

test('the character type is the whole of the structure, not a label', () => {
  const counts = Object.fromEntries(
    RIG_KINDS.map((kind) => [kind, emptyRigFlowData(kind).bones.length]),
  ) as Record<RigKind, number>;

  // Choosing `octopus` is forty-two bones in eight chains; choosing `human` is a
  // different skeleton, not the same one renamed.
  assert.ok(counts.octopus > counts.human, `octopus ${counts.octopus} vs human ${counts.human}`);
  assert.equal(emptyRigFlowData('octopus').chains.length, 8, 'one chain per arm');
  assert.equal(emptyRigFlowData('human').chains.length, 0, 'a person has no tentacles');
  assert.equal(emptyRigFlowData('snake').chains.length, 1, 'and a snake is all one');
  assert.equal(new Set(Object.values(counts)).size > 4, true, 'the types are genuinely different shapes');
});

test('a human has the joints you would look for, hung off each other correctly', () => {
  const data = emptyRigFlowData('human');
  assert.ok(boneById(data, 'hips'), 'the root is the hips');
  assert.equal(boneById(data, 'left-forearm')?.parent, 'left-upper-arm');
  assert.equal(boneById(data, 'left-leg-shin')?.parent, 'left-leg-thigh');
  assert.deepEqual(
    childrenOf(data, 'left-upper-arm').map((bone) => bone.id),
    ['left-forearm'],
  );
  assert.equal(boneById(data, 'left-hand')?.side, 'left');

  // An elbow and a knee bend one way. Getting this wrong is what makes a rig
  // look broken, so it is asserted rather than assumed.
  const elbow = effectiveAngles(boneById(data, 'left-forearm')!, undefined);
  assert.equal(elbow.min, 0, 'an elbow does not bend backwards');
  assert.ok(elbow.max > 90);
  const knee = effectiveAngles(boneById(data, 'left-leg-shin')!, undefined);
  assert.equal(knee.max, 0, 'nor does a knee bend forwards');
  assert.ok(knee.min < -90);
});

test('the rest pose is worked out from the hierarchy, and moving a parent moves its children', () => {
  const data = emptyRigFlowData('human');
  const posed = restPose(data);

  assert.deepEqual(posed.get('hips')?.from, { x: 0, y: 0 }, 'the root starts at the origin');
  // A bone's start is its parent's end, which is the invariant the whole pose
  // rests on.
  for (const bone of data.bones) {
    if (!bone.parent) continue;
    assert.deepEqual(
      posed.get(bone.id)?.from,
      posed.get(bone.parent)?.to,
      `${bone.id} does not start where ${bone.parent} ends`,
    );
  }

  const moved = {
    ...data,
    bones: data.bones.map((bone) => (bone.id === 'spine' ? { ...bone, offset: { x: 0, y: -40 } } : bone)),
  };
  const before = posed.get('head')!.to.y;
  const after = restPose(moved).get('head')!.to.y;
  assert.equal(after, before - 26, 'lengthening the spine carried the head with it');
});

/* ---------------- what a joint may do ---------------- */

test('stretch is a range and a cost, and the rig can scale all of it at once', () => {
  const data = emptyRigFlowData('human');
  const arm = boneById(data, 'left-upper-arm')!;
  assert.ok(arm.stretch.max > 1, 'a limb can stretch a little by default');

  const rubber = effectiveStretch(arm, { ...DEFAULT_RIG_OPTIONS, squashAndStretch: 4 });
  assert.ok(rubber.max > arm.stretch.max, `${rubber.max} should be past ${arm.stretch.max}`);
  assert.ok(rubber.min < arm.stretch.min, 'and it squashes further too');

  const rigid = effectiveStretch(arm, { ...DEFAULT_RIG_OPTIONS, squashAndStretch: 0 });
  assert.deepEqual([rigid.min, rigid.max], [1, 1], 'at 0 nothing stretches at all');
  assert.equal(rigid.stiffness, arm.stretch.stiffness, 'the cost is the bone’s own either way');
});

test('looseness scales every angle without touching which way a joint bends', () => {
  const data = emptyRigFlowData('human');
  const elbow = boneById(data, 'left-forearm')!;
  const loose = effectiveAngles(elbow, undefined, { ...DEFAULT_RIG_OPTIONS, looseness: 2 });
  const tight = effectiveAngles(elbow, undefined, { ...DEFAULT_RIG_OPTIONS, looseness: 0.5 });

  assert.equal(loose.max, elbow.angles!.max * 2);
  assert.equal(tight.max, elbow.angles!.max * 0.5);
  assert.equal(loose.min, 0, 'and an elbow still only bends one way at any looseness');
});

/* ---------------- chains ---------------- */

/**
 * The reason a chain exists at all. Eight joints in a tentacle are one behaviour,
 * not eight decisions, so they read their angles off the chain's floppiness.
 */
test('a chain bone reads its angles off the chain, so one slider moves the lot', () => {
  const data = emptyRigFlowData('octopus');
  const chain = chainById(data, 'arm-1')!;
  const bones = chain.bones.map((id) => boneById(data, id)!);

  assert.ok(bones.every((bone) => bone.angles === undefined), 'no chain bone carries its own angles');
  const loose = bones.map((bone) => effectiveAngles(bone, chain).max);
  assert.ok(loose.every((span) => span > 0), `${loose.join(', ')} — a floppy arm moves`);

  const welded = setChain(data, 'arm-1', { floppiness: 0 });
  const stiff = chainById(welded, 'arm-1')!;
  for (const bone of bones) {
    const angles = effectiveAngles(bone, stiff);
    assert.equal(angles.max, 0, `${bone.id} should be welded at floppiness 0`);
    assert.equal(angles.stiffness, 1, 'and maximally stiff');
  }
});

test('taper makes the tip of a tentacle looser than its base', () => {
  const data = emptyRigFlowData('octopus');
  const chain = { ...chainById(data, 'arm-1')!, floppiness: 0.8, taper: 1 };
  const spans = chain.bones.map((id) => effectiveAngles(boneById(data, id)!, chain).max);

  for (let index = 1; index < spans.length; index += 1) {
    assert.ok(spans[index]! > spans[index - 1]!, `${spans.join(' < ')} should increase towards the tip`);
  }

  // With no taper the whole chain is equally floppy, which is the other thing
  // somebody might want.
  const even = chain.bones.map((id) => effectiveAngles(boneById(data, id)!, { ...chain, taper: 0 }).max);
  assert.equal(new Set(even).size, 1, `${even.join(' ')} should all be the same`);
});

test('a chain joint can be pinned by hand, and let go again', () => {
  const data = emptyRigFlowData('octopus');
  const chain = chainById(data, 'arm-1')!;
  const id = chain.bones[2]!;
  assert.equal(boneById(data, id)!.angles, undefined);

  const pinned = setBoneLimits(data, id, { angles: { min: -5, max: 5, stiffness: 0.9 } });
  assert.deepEqual(effectiveAngles(boneById(pinned, id)!, chain), { min: -5, max: 5, stiffness: 0.9 });
  // And the rest of the chain still follows the chain.
  assert.ok(effectiveAngles(boneById(pinned, chain.bones[3]!)!, chain).max > 5);

  const released = setBoneLimits(pinned, id, { angles: null });
  assert.equal(boneById(released, id)!.angles, undefined, 'back to following the chain');
});

test('a bone with neither its own angles nor a chain is locked rather than left free', () => {
  // This is a broken template rather than a pose, so it should not quietly become
  // a joint that can do anything.
  const orphan = { id: 'x', name: 'X', offset: { x: 0, y: 10 }, stretch: { min: 1, max: 1, stiffness: 1 } };
  assert.deepEqual(effectiveAngles(orphan, undefined), { min: 0, max: 0, stiffness: 1 });
});

/* ---------------- editing ---------------- */

test('an edit to one side mirrors onto the other, and can be told not to', () => {
  const data = emptyRigFlowData('human');
  assert.equal(mirrorIdOf('left-forearm'), 'right-forearm');
  assert.equal(mirrorIdOf('right-leg-shin'), 'left-leg-shin');
  assert.equal(mirrorIdOf('spine'), undefined, 'a spine has no twin');

  const mirrored = setBoneLimits(data, 'left-forearm', { angles: { max: 90 } });
  assert.equal(boneById(mirrored, 'left-forearm')!.angles!.max, 90);
  assert.equal(boneById(mirrored, 'right-forearm')!.angles!.max, 90, 'the twin followed');
  assert.equal(boneById(mirrored, 'left-forearm')!.angles!.min, 0, 'and the rest of the limits are untouched');

  const alone = setBoneLimits(
    { ...data, options: { ...data.options, mirror: false } },
    'left-forearm',
    { angles: { max: 90 } },
  );
  assert.equal(boneById(alone, 'right-forearm')!.angles!.max, 145, 'with mirroring off, only one side moved');
});

test('editing a rig never touches the rig it was given', () => {
  const data = emptyRigFlowData('human');
  const before = JSON.stringify(data);
  setBoneLimits(data, 'left-forearm', { angles: { max: 1 }, stretch: { max: 3 } });
  setChain(emptyRigFlowData('octopus'), 'arm-1', { floppiness: 0 });
  assert.equal(JSON.stringify(data), before);
});

test('a bone can be put back to what its character type says', () => {
  const data = emptyRigFlowData('human');
  const original = boneById(data, 'left-forearm')!;
  const changed = setBoneLimits(data, 'left-forearm', {
    angles: { min: -200, max: 200 },
    stretch: { max: 9 },
  });
  assert.notDeepEqual(boneById(changed, 'left-forearm'), original);
  assert.deepEqual(boneById(resetBone(changed, 'left-forearm'), 'left-forearm'), original);
  assert.deepEqual(resetBone(data, 'no-such-bone'), data, 'and a name it does not know is a no-op');
});

/* ---------------- swapping the type ---------------- */

test('swapping character type keeps the edits that still mean something', () => {
  const human = setBoneLimits(emptyRigFlowData('human'), 'head', { stretch: { max: 1.9, min: 0.5, stiffness: 0.2 } });
  const quadruped = changeRigKind(human, 'quadruped');

  assert.equal(quadruped.kind, 'quadruped');
  assert.equal(boneById(quadruped, 'head')!.stretch.max, 1.9, 'a head is a head in both skeletons');
  assert.equal(boneById(quadruped, 'left-forearm'), undefined, 'and an arm is not a foreleg');
  assert.ok(boneById(quadruped, 'tail-1'), 'the new bones arrived');
  assert.deepEqual(rigProblems(quadruped), []);

  // Going back gives the arms again, still with the head's edit.
  const back = changeRigKind(quadruped, 'human');
  assert.ok(boneById(back, 'left-forearm'));
  assert.equal(boneById(back, 'head')!.stretch.max, 1.9);
});

test('a chain’s floppiness survives a swap when the chain does', () => {
  const floppy = setChain(emptyRigFlowData('quadruped'), 'tail', { floppiness: 0.1, taper: 0 });
  const bird = changeRigKind(floppy, 'bird');
  assert.equal(chainById(bird, 'tail')!.floppiness, 0.1, 'a bird has a tail too');
  assert.equal(chainById(bird, 'tail')!.bones.length, 3, 'but the bird’s own number of bones in it');
});

/* ---------------- what is wrong with it ---------------- */

test('the problems a rig can have are named in animator’s terms', () => {
  const data = emptyRigFlowData('human');

  const backwards = setBoneLimits(data, 'spine', { angles: { min: 20, max: -20 } });
  assert.ok(
    rigProblems(backwards).some((problem) => /runs backwards/.test(problem.message)),
    JSON.stringify(rigProblems(backwards)),
  );

  // The one that wastes an afternoon: the character starts the shot already
  // outside its own limits.
  const offPose = setBoneLimits(data, 'spine', { angles: { min: 10, max: 40 } });
  assert.ok(rigProblems(offPose).some((problem) => /rest pose is outside/.test(problem.message)));

  const inverted = setBoneLimits(data, 'spine', { stretch: { min: -0.5, max: 1 } });
  assert.ok(rigProblems(inverted).some((problem) => /squash to nothing/.test(problem.message)));

  const orphaned = { ...data, bones: data.bones.map((bone) => (bone.id === 'spine' ? { ...bone, parent: 'nope' } : bone)) };
  const found = rigProblems(orphaned).map((problem) => problem.message).join(' | ');
  assert.match(found, /is not in the rig/);
  // A bone whose parent has gone is treated as a root of its own so the editor
  // can still draw it — the dangling name is the problem to report, not the
  // half of the skeleton hanging off it.
  assert.equal(restPose(orphaned).size, orphaned.bones.length);
});

test('a loop in the hierarchy is caught rather than hung on', () => {
  // `restPose` walks down from the roots, so a cycle is not infinite recursion —
  // it is bones that never get visited, which is what this reports.
  const data = emptyRigFlowData('human');
  const looped = {
    ...data,
    bones: data.bones.map((bone) => (bone.id === 'hips' ? { ...bone, parent: 'head' } : bone)),
  };
  assert.ok(restPose(looped).size < looped.bones.length);
  assert.ok(
    rigProblems(looped).some((problem) => /not reachable from a root/.test(problem.message)),
    JSON.stringify(rigProblems(looped)),
  );
});

test('a summary says what an animator needs to know before opening it', () => {
  const human = summariseRig(emptyRigFlowData('human'));
  assert.equal(human.kind, 'human');
  assert.equal(human.bones, emptyRigFlowData('human').bones.length);
  assert.equal(human.chains, 0);
  assert.equal(human.chained, 0);
  assert.equal(human.problems, 0);
  assert.ok(human.height > 50, `${human.height} units tall`);
  assert.ok(human.span > human.height, 'more bone than height, since limbs go sideways');
  assert.ok(human.stretchy > 0);

  const octopus = summariseRig(emptyRigFlowData('octopus'));
  assert.equal(octopus.chains, 8);
  assert.equal(octopus.chained, 40, 'eight arms of five');

  // Welding every chain shows up as welded joints rather than silently.
  let stiff = emptyRigFlowData('octopus');
  for (const chain of stiff.chains) stiff = setChain(stiff, chain.id, { floppiness: 0 });
  assert.equal(summariseRig(stiff).welded, 40);
});

test('a bone’s length is the length of its offset, and only the root may have none', () => {
  for (const kind of RIG_KINDS) {
    const data = emptyRigFlowData(kind);
    for (const bone of data.bones) {
      if (!bone.parent) continue;
      assert.ok(boneLength(bone) > 0, `${kind}/${bone.id} has no length`);
    }
  }
  assert.equal(boneLength({ id: 'a', name: 'A', offset: { x: 3, y: 4 }, stretch: { min: 1, max: 1, stiffness: 1 } }), 5);
});

/* ---------------- moving joints ---------------- */

test('moving a joint moves that bone’s end, and everything hanging off it comes along', () => {
  const rig = emptyRigFlowData('human');
  const before = restPose(rig);
  const elbow = before.get('left-upper-arm')!.to;
  const moved = moveRigJoint({ ...rig, options: { ...rig.options, mirrorMoves: false } }, 'left-upper-arm', {
    x: elbow.x - 5,
    y: elbow.y + 2,
  });
  const after = restPose(moved);
  assert.deepEqual(after.get('left-upper-arm')!.to, { x: elbow.x - 5, y: elbow.y + 2 });
  assert.deepEqual(after.get('left-upper-arm')!.from, before.get('left-upper-arm')!.from, 'the shoulder stays');
  const hand = before.get('left-forearm')!.to;
  assert.deepEqual(after.get('left-forearm')!.to, { x: hand.x - 5, y: hand.y + 2 }, 'the forearm came with it');
  assert.deepEqual(after.get('right-upper-arm'), before.get('right-upper-arm'), 'and the other arm did not');
});

test('with symmetric moves on, the twin moves the mirrored way', () => {
  const rig = emptyRigFlowData('human');
  assert.equal(rig.options.mirrorMoves, true, 'on by default');
  const before = restPose(rig);
  const elbow = before.get('left-upper-arm')!.to;
  const twin = before.get('right-upper-arm')!.to;
  const after = restPose(moveRigJoint(rig, 'left-upper-arm', { x: elbow.x - 5, y: elbow.y - 3 }));
  assert.deepEqual(after.get('right-upper-arm')!.to, { x: twin.x + 5, y: twin.y - 3 }, 'out and up, on its own side');
});

test('the mirror is read off the rig: a side-on skeleton moves its twin the same way', () => {
  assert.equal(mirrorAxis(emptyRigFlowData('human')), 'x');
  assert.equal(mirrorAxis(emptyRigFlowData('fish')), 'y');
  assert.equal(mirrorAxis(emptyRigFlowData('quadruped')), 'none');
  const horse = emptyRigFlowData('quadruped');
  const bone = horse.bones.find((entry) => entry.id.startsWith('left-'))!;
  const twin = boneById(horse, mirrorIdOf(bone.id)!)!;
  const end = restPose(horse).get(bone.id)!.to;
  const moved = moveRigJoint(horse, bone.id, { x: end.x + 4, y: end.y + 1 });
  assert.deepEqual(boneById(moved, twin.id)!.offset, { x: twin.offset.x + 4, y: twin.offset.y + 1 });
});

test('a twin keeps its own shape: only the move is mirrored, not the other bone', () => {
  const rig = emptyRigFlowData('human');
  const lifted = { ...rig, bones: rig.bones.map((bone) => (bone.id === 'right-upper-arm' ? { ...bone, offset: { x: 6, y: 10 } } : bone)) };
  const end = restPose(lifted).get('left-upper-arm')!.to;
  const moved = moveRigJoint(lifted, 'left-upper-arm', { x: end.x, y: end.y + 2 });
  assert.deepEqual(boneById(moved, 'right-upper-arm')!.offset, { x: 6, y: 12 });
});

test('a bone with no twin moves on its own', () => {
  const rig = emptyRigFlowData('human');
  const root = rig.bones.find((bone) => !bone.parent)!;
  const end = restPose(rig).get(root.id)!.to;
  const moved = moveRigJoint(rig, root.id, { x: end.x + 1, y: end.y });
  assert.equal(moved.bones.filter((bone, index) => bone !== rig.bones[index]).length, 1);
});
