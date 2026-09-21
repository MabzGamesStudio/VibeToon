import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addBone,
  bindShapes,
  bindState,
  boundRigOf,
  centroid,
  deleteBone,
  emptyBindFlowData,
  fitRigTo,
  imageOfBinding,
  readBoundRig,
  renameBone,
  shapesFor,
  shapesInRegion,
  summariseBinding,
  unbindShapes,
  unboundShapes,
  type BindFlowData,
} from '../src/flows/rigBind';
import { emptyRigFlowData, restPose } from '../src/flows/rig';
import type { VectorImage, VectorPolygon } from '../src/flows/vector';

function square(id: string, x: number, y: number, size = 4): VectorPolygon {
  return {
    id,
    kind: 'polygon',
    color: '#ff0000',
    points: [
      { x, y },
      { x: x + size, y },
      { x: x + size, y: y + size },
      { x, y: y + size },
    ],
  };
}

const drawing: VectorImage = {
  width: 100,
  height: 100,
  shapes: [square('a', 0, 0), square('b', 20, 0), square('c', 0, 20)],
};

function started(): BindFlowData {
  return {
    ...emptyBindFlowData(),
    rig: emptyRigFlowData('human'),
    image: drawing,
    rigHash: 'r1',
    vectorHash: 'v1',
  };
}

/* ---------------- taking them in ---------------- */

test('a fresh binding holds nothing and says so', () => {
  const fresh = emptyBindFlowData();
  assert.equal(fresh.editor, 'bind');
  assert.equal(fresh.rig, null);
  assert.equal(bindState(fresh, 'r1', 'v1'), 'none');
  assert.deepEqual(imageOfBinding(fresh).shapes, [], 'rather than throwing on a flow nobody opened');
  assert.equal(boundRigOf(fresh), null);
});

test('either input changing makes it stale, and neither changing does not', () => {
  const data = started();
  assert.equal(bindState(data, 'r1', 'v1'), 'ready');
  assert.equal(bindState(data, 'r2', 'v1'), 'stale', 'the rig moved');
  assert.equal(bindState(data, 'r1', 'v2'), 'stale', 'the drawing moved');
});

/* ---------------- assigning ---------------- */

test('binding puts shapes on a bone, and unbinding takes them off', () => {
  let data = started();
  data = bindShapes(data, ['a', 'b'], 'hips');
  assert.deepEqual(shapesFor(data, 'hips').map((shape) => shape.id), ['a', 'b']);
  assert.deepEqual(unboundShapes(data).map((shape) => shape.id), ['c']);

  data = unbindShapes(data, ['a']);
  assert.deepEqual(shapesFor(data, 'hips').map((shape) => shape.id), ['b']);
});

test('a shape belongs to one bone, so binding it again moves it', () => {
  // Two owners would have to tear the shape when they move apart, and an outline
  // has to go somewhere whole.
  let data = bindShapes(started(), ['a'], 'hips');
  data = bindShapes(data, ['a'], 'spine');
  assert.deepEqual(shapesFor(data, 'hips'), []);
  assert.deepEqual(shapesFor(data, 'spine').map((shape) => shape.id), ['a']);
});

test('binding nothing changes nothing, and does not count as an edit', () => {
  const data = started();
  assert.equal(bindShapes(data, [], 'hips'), data);
  assert.equal(unbindShapes(data, ['nothing-here']), data);
});

test('a region takes in every shape whose middle is inside it', () => {
  // By centre, because asking someone to enclose an outline exactly is asking
  // them to do the binding twice.
  const inside = shapesInRegion(drawing, [
    { x: -5, y: -5 },
    { x: 15, y: -5 },
    { x: 15, y: 30 },
    { x: -5, y: 30 },
  ]);
  assert.deepEqual(inside, ['a', 'c'], 'the two on the left, not the one at x=20');
});

test('a region with too few points takes nothing', () => {
  assert.deepEqual(shapesInRegion(drawing, [{ x: 0, y: 0 }, { x: 10, y: 10 }]), []);
});

test('a shape’s middle is the middle of its points', () => {
  assert.deepEqual(centroid(square('x', 0, 0, 10)), { x: 5, y: 5 });
});

/* ---------------- editing the skeleton ---------------- */

test('a new bone hangs off the selected one and ends where it was pointed', () => {
  const data = started();
  const pose = restPose(data.rig!);
  const origin = pose.get('hips')!.to;

  const next = addBone(data, 'hips', 'Tail', { x: origin.x + 10, y: origin.y + 20 });
  const added = next.rig!.bones[next.rig!.bones.length - 1]!;
  assert.equal(added.name, 'Tail');
  assert.equal(added.parent, 'hips');
  // The offset is worked out from where the parent already is, so a bone can be
  // placed by pointing rather than by doing arithmetic about a hierarchy.
  assert.deepEqual(added.offset, { x: 10, y: 20 });
  assert.deepEqual(restPose(next.rig!).get(added.id)!.to, { x: origin.x + 10, y: origin.y + 20 });
});

test('a bone with no name gets one rather than being nameless', () => {
  const added = addBone(started(), 'hips', '   ', { x: 0, y: 0 });
  assert.equal(added.rig!.bones[added.rig!.bones.length - 1]!.name, 'New bone');
});

test('deleting a bone leaves its children where they are', () => {
  // Deleting a bone should take that bone away, not collapse everything below
  // it onto the origin.
  const data = started();
  const before = restPose(data.rig!);
  const forearm = before.get('left-forearm')!.to;

  const next = deleteBone(data, 'left-upper-arm');
  const after = restPose(next.rig!);
  assert.equal(next.rig!.bones.some((bone) => bone.id === 'left-upper-arm'), false);
  assert.deepEqual(after.get('left-forearm')!.to, forearm, 'the forearm did not move');
  assert.deepEqual(after.get('left-hand')!.to, before.get('left-hand')!.to);
});

test('shapes on a deleted bone move to its parent rather than vanishing', () => {
  let data = bindShapes(started(), ['a', 'b'], 'left-upper-arm');
  const parent = data.rig!.bones.find((bone) => bone.id === 'left-upper-arm')!.parent!;
  data = deleteBone(data, 'left-upper-arm');
  assert.deepEqual(shapesFor(data, parent).map((shape) => shape.id), ['a', 'b']);
});

test('a bone can be renamed', () => {
  const data = renameBone(started(), 'hips', 'Pelvis');
  assert.equal(data.rig!.bones.find((bone) => bone.id === 'hips')!.name, 'Pelvis');
});

/* ---------------- what comes out ---------------- */

test('what comes out is the rig, the drawing and the map between them', () => {
  const data = bindShapes(started(), ['a'], 'hips');
  const bound = boundRigOf(data)!;
  assert.equal(bound.rig.bones.length, data.rig!.bones.length);
  assert.equal(bound.image.shapes.length, 3);
  assert.deepEqual(bound.binding, { a: 'hips' });
});

test('reading one back drops any binding that points at nothing', () => {
  const read = readBoundRig({
    rig: emptyRigFlowData('human'),
    image: drawing,
    binding: { a: 'hips', b: 'no-such-bone', 'no-such-shape': 'hips' },
  })!;
  assert.deepEqual(read.binding, { a: 'hips' });
});

test('nonsense reads as nothing rather than throwing', () => {
  for (const junk of [null, 42, {}, { rig: {} }, { rig: { bones: [] } }]) {
    assert.equal(readBoundRig(junk), null, JSON.stringify(junk));
  }
});

/* ---------------- how it is going ---------------- */

test('the summary counts what is bound and warns about what is not', () => {
  const nothing = summariseBinding(started());
  assert.equal(nothing.bound, 0);
  assert.equal(nothing.unbound, 3);
  assert.ok(nothing.problems.some((problem) => /Nothing is bound/.test(problem)));

  const partly = summariseBinding(bindShapes(started(), ['a'], 'hips'));
  assert.equal(partly.bound, 1);
  assert.ok(
    partly.problems.some((problem) => /will stay put when the rig moves/.test(problem)),
    'an unbound shape is a thing worth being told about',
  );
});

test('bones carrying nothing are reported once something is bound', () => {
  const summary = summariseBinding(bindShapes(started(), ['a', 'b', 'c'], 'hips'));
  assert.equal(summary.unbound, 0);
  assert.ok(summary.empty > 0);
  assert.ok(summary.problems.some((problem) => /carry nothing/.test(problem)));
});

/* ---------------- laying the rig over the drawing ---------------- */

test('a rig is scaled and centred onto the drawing it will be bound to', () => {
  // The two were made in different spaces and neither knows it: a rig is about a
  // hundred rig units tall and hangs around the origin, a drawing is however many
  // pixels the picture was. Taken in as they are, the skeleton lands in a corner
  // and there is no bone to aim at — which makes binding impossible to do.
  const fitted = fitRigTo(emptyRigFlowData('human'), drawing);
  const placed = [...restPose(fitted).values()];
  const xs = placed.flatMap((place) => [place.from.x, place.to.x]);
  const ys = placed.flatMap((place) => [place.from.y, place.to.y]);

  assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= drawing.width, 'it fits across');
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= drawing.height, 'and down');

  // And it is centred rather than shoved into a corner.
  const middle = (values: number[]) => (Math.min(...values) + Math.max(...values)) / 2;
  assert.ok(Math.abs(middle(xs) - drawing.width / 2) < 1);
  assert.ok(Math.abs(middle(ys) - drawing.height / 2) < 1);
});

test('fitting keeps the rig’s proportions, and only moves and scales it', () => {
  const before = restPose(emptyRigFlowData('human'));
  const after = restPose(fitRigTo(emptyRigFlowData('human'), drawing));

  const span = (pose: typeof before) => {
    const values = [...pose.values()];
    const xs = values.flatMap((place) => [place.from.x, place.to.x]);
    const ys = values.flatMap((place) => [place.from.y, place.to.y]);
    return (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
  };
  assert.ok(Math.abs(span(after) - span(before)) < 1e-6, 'a scaled rig is the same shape');
});

test('fitting a rig to nothing leaves it alone rather than dividing by zero', () => {
  const rig = emptyRigFlowData('human');
  assert.equal(fitRigTo(rig, { width: 0, height: 0, shapes: [] }), rig);
});
