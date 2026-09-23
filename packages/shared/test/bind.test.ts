import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addBone,
  bindNodes,
  bindState,
  boundRigOf,
  deleteBone,
  emptyBindFlowData,
  fitRigTo,
  imageOfBinding,
  intoDrawing,
  moveImage,
  moveJoint,
  moveRig,
  nodeKey,
  nodesFor,
  nodesInRegion,
  nodesNear,
  nodesOf,
  placedImage,
  readBoundRig,
  renameBone,
  shareOf,
  summariseBinding,
  unbindNodes,
  zoomImage,
  zoomRig,
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

/* ---------------- nodes ---------------- */

/** Every node of a shape, by key. */
const keysOf = (id: string) => drawing.shapes.find((shape) => shape.id === id)!.points.map(nodeKey);

/** Two squares side by side that share an edge, the way a decomposition's shapes do. */
const touching: VectorImage = {
  width: 100,
  height: 100,
  shapes: [square('left', 0, 0), square('right', 4, 0)],
};

test('a node is a place: points of two shapes in the same place are one node', () => {
  const nodes = nodesOf(touching);
  assert.equal(nodes.length, 6, 'eight points, two pairs of them shared');
  const shared = nodes.filter((node) => node.uses === 2).map((node) => node.key).sort();
  assert.deepEqual(shared, ['4,0', '4,4']);
});

test('binding puts nodes on a bone, and unbinding takes them off', () => {
  let data = started();
  data = bindNodes(data, [...keysOf('a'), ...keysOf('b')], 'hips');
  assert.equal(nodesFor(data, 'hips').length, 8);
  data = unbindNodes(data, keysOf('a'));
  assert.deepEqual(nodesFor(data, 'hips').sort(), [...keysOf('b')].sort());
});

test('a node follows one bone, so binding it again moves it', () => {
  let data = bindNodes(started(), keysOf('a'), 'hips');
  data = bindNodes(data, keysOf('a'), 'spine');
  assert.deepEqual(nodesFor(data, 'hips'), []);
  assert.equal(nodesFor(data, 'spine').length, 4);
});

test('binding nothing new changes nothing, and does not count as an edit', () => {
  const data = started();
  assert.equal(bindNodes(data, [], 'hips'), data);
  assert.equal(unbindNodes(data, ['nothing-here']), data);
  const once = bindNodes(data, keysOf('a'), 'hips');
  assert.equal(bindNodes(once, keysOf('a'), 'hips'), once, 'already there');
});

test('a shape is shared between bones by its points', () => {
  // Half of square a on the hips and half on the spine: a shape can bend now.
  const [first, second, third, fourth] = keysOf('a');
  let data = bindNodes(started(), [first!, second!], 'hips');
  data = bindNodes(data, [third!, fourth!], 'spine');
  const a = drawing.shapes[0]!;
  assert.equal(shareOf(data, a, 'hips'), 0.5);
  assert.equal(shareOf(data, a, 'spine'), 0.5);
  assert.equal(summariseBinding(data).bending, 1);
});

test('the brush takes in the nodes within its reach, nearest first', () => {
  const nodes = nodesOf(drawing);
  assert.deepEqual(nodesNear(nodes, { x: 1, y: 1 }, 1.5), ['0,0']);
  assert.deepEqual(nodesNear(nodes, { x: 2, y: 0 }, 2.5), ['0,0', '4,0']);
  assert.deepEqual(nodesNear(nodes, { x: 50, y: 50 }, 5), []);
});

test('an area takes in exactly the nodes inside it', () => {
  // A node is a point, so it is in or out — no deciding a half-enclosed shape.
  const nodes = nodesOf(drawing);
  const inside = nodesInRegion(nodes, [
    { x: -1, y: -1 },
    { x: 2, y: -1 },
    { x: 2, y: 30 },
    { x: -1, y: 30 },
  ]);
  assert.deepEqual(inside.sort(), ['0,0', '0,20', '0,24', '0,4'], 'the left-hand edges of a and c only');
});

test('an area with too few points takes nothing', () => {
  assert.deepEqual(nodesInRegion(nodesOf(drawing), [{ x: 0, y: 0 }, { x: 10, y: 10 }]), []);
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

test('nodes on a deleted bone move to its parent rather than vanishing', () => {
  let data = bindNodes(started(), [...keysOf('a'), ...keysOf('b')], 'left-upper-arm');
  const parent = data.rig!.bones.find((bone) => bone.id === 'left-upper-arm')!.parent!;
  data = deleteBone(data, 'left-upper-arm');
  assert.equal(nodesFor(data, parent).length, 8);
  assert.deepEqual(nodesFor(data, 'left-upper-arm'), []);
});

test('a bone can be renamed', () => {
  const data = renameBone(started(), 'hips', 'Pelvis');
  assert.equal(data.rig!.bones.find((bone) => bone.id === 'hips')!.name, 'Pelvis');
});

/* ---------------- what comes out ---------------- */

test('what comes out is the rig, the drawing, and the bone each point follows', () => {
  const [first, second] = keysOf('a');
  const data = bindNodes(started(), [first!, second!], 'hips');
  const bound = boundRigOf(data)!;
  assert.equal(bound.rig.bones.length, data.rig!.bones.length);
  assert.equal(bound.image.shapes.length, 3);
  assert.deepEqual(bound.points, { a: ['hips', 'hips', null, null] }, 'and nothing for shapes with no bound point');
});

test('a node shared by two shapes is bound in both', () => {
  const data = bindNodes({ ...started(), image: touching }, ['4,0', '4,4'], 'hips');
  const bound = boundRigOf(data)!;
  assert.deepEqual(bound.points.left, [null, 'hips', 'hips', null]);
  assert.deepEqual(bound.points.right, ['hips', null, null, 'hips']);
});

test('reading one back drops any bone that points at nothing', () => {
  const read = readBoundRig({
    rig: emptyRigFlowData('human'),
    image: drawing,
    points: { a: ['hips', 'no-such-bone', null, 'hips'], b: ['hips'], 'no-such-shape': ['hips'] },
  })!;
  assert.deepEqual(read.points, { a: ['hips', null, null, 'hips'] }, 'and a list the wrong length is not trusted');
});

test('a bound rig written when binding was by shape reads back point by point', () => {
  const read = readBoundRig({
    rig: emptyRigFlowData('human'),
    image: drawing,
    binding: { a: 'hips', b: 'no-such-bone', 'no-such-shape': 'hips' },
  })!;
  assert.deepEqual(read.points, { a: ['hips', 'hips', 'hips', 'hips'] });
});

test('nonsense reads as nothing rather than throwing', () => {
  for (const junk of [null, 42, {}, { rig: {} }, { rig: { bones: [] } }]) {
    assert.equal(readBoundRig(junk), null, JSON.stringify(junk));
  }
});

/* ---------------- how it is going ---------------- */

test('the summary counts what is bound and warns about what is not', () => {
  const nothing = summariseBinding(started());
  assert.equal(nothing.nodes, 12);
  assert.equal(nothing.bound, 0);
  assert.equal(nothing.unbound, 12);
  assert.ok(nothing.problems.some((problem) => /Nothing is bound/.test(problem)));

  const partly = summariseBinding(bindNodes(started(), keysOf('a'), 'hips'));
  assert.equal(partly.bound, 4);
  assert.ok(
    partly.problems.some((problem) => /will stay put when the rig moves/.test(problem)),
    'an unbound node is a thing worth being told about',
  );
});

test('a shape with some points bound and some not is warned about, because it will stretch', () => {
  const [first] = keysOf('a');
  const summary = summariseBinding(bindNodes(started(), [first!], 'hips'));
  assert.equal(summary.stretching, 1);
  assert.ok(summary.problems.some((problem) => /will stretch between them/.test(problem)));
});

test('bones carrying nothing are reported once something is bound', () => {
  const all = nodesOf(drawing).map((node) => node.key);
  const summary = summariseBinding(bindNodes(started(), all, 'hips'));
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

/* ---------------- placing the two of them ---------------- */

const placed = (over: Partial<BindFlowData> = {}): BindFlowData => ({
  ...emptyBindFlowData(),
  rig: fitRigTo(emptyRigFlowData('human'), drawing),
  image: drawing,
  ...over,
});

test('a drawing left where it arrived is the drawing that arrived', () => {
  const data = placed();
  assert.deepEqual(placedImage(data).shapes, drawing.shapes);
  assert.equal(placedImage(data), imageOfBinding(data), 'and not even copied');
});

test('the drawing can be moved out from under the skeleton', () => {
  const data = moveImage(placed(), { x: 10, y: -4 });
  const moved = placedImage(data).shapes[0]!;
  assert.deepEqual(moved.points[0], { x: drawing.shapes[0]!.points[0]!.x + 10, y: drawing.shapes[0]!.points[0]!.y - 4 });
  assert.equal(intoDrawing(data, moved.points[0]!).x, drawing.shapes[0]!.points[0]!.x, 'and read back');
});

test('zooming the drawing keeps the point it was zoomed about where it was', () => {
  // Which is the whole difference between a zoom control that is usable for
  // lining something up and one that pushes the thing you are aiming at off the
  // edge with every step.
  const about = { x: 40, y: 40 };
  const data = zoomImage(placed(), 2, about);
  const there = placedImage(data);
  const back = intoDrawing(data, about);
  assert.ok(Math.abs(back.x - about.x) < 1e-9 && Math.abs(back.y - about.y) < 1e-9);
  assert.equal(there.shapes.length, drawing.shapes.length);
});

test('a stroke gets thicker when the drawing is zoomed, because a width is a width', () => {
  const withLine: VectorImage = {
    ...drawing,
    shapes: [
      ...drawing.shapes,
      { id: 'l1', kind: 'line', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], curved: false, closed: false },
    ],
  };
  const data = zoomImage(placed({ image: withLine }), 2, { x: 0, y: 0 });
  const line = placedImage(data).shapes.find((shape) => shape.id === 'l1')!;
  assert.equal(line.kind, 'line');
  assert.equal((line as { width: number }).width, 6);
});

test('the skeleton can be moved and zoomed without touching the drawing', () => {
  const start = placed();
  const before = restPose(start.rig!);

  const shifted = moveRig(start, { x: 20, y: 5 });
  const after = restPose(shifted.rig!);
  const id = start.rig!.bones[0]!.id;
  assert.equal(after.get(id)!.from.x - before.get(id)!.from.x, 20);
  assert.equal(after.get(id)!.from.y - before.get(id)!.from.y, 5);
  assert.deepEqual(placedImage(shifted).shapes, drawing.shapes, 'the drawing did not move');
});

test('zooming the skeleton makes it bigger, not one bone longer', () => {
  const start = placed();
  const grown = zoomRig(start, 2, { x: 0, y: 0 });
  for (let index = 0; index < start.rig!.bones.length; index += 1) {
    const was = start.rig!.bones[index]!.offset;
    const now = grown.rig!.bones[index]!.offset;
    assert.ok(Math.abs(now.x - was.x * 2) < 1e-9 && Math.abs(now.y - was.y * 2) < 1e-9);
  }
});

test('a joint can be put anywhere, and what hangs off it comes along', () => {
  const start = placed();
  const rig = start.rig!;
  const parent = rig.bones.find((bone) => rig.bones.some((child) => child.parent === bone.id))!;
  const child = rig.bones.find((bone) => bone.parent === parent.id)!;

  const before = restPose(rig);
  const gap = {
    x: before.get(child.id)!.to.x - before.get(parent.id)!.to.x,
    y: before.get(child.id)!.to.y - before.get(parent.id)!.to.y,
  };

  const target = { x: 12, y: 34 };
  const moved = moveJoint(start, parent.id, target);
  const after = restPose(moved.rig!);
  assert.ok(Math.abs(after.get(parent.id)!.to.x - target.x) < 1e-9, 'the joint went where it was put');
  assert.ok(Math.abs(after.get(parent.id)!.to.y - target.y) < 1e-9);
  assert.ok(
    Math.abs(after.get(child.id)!.to.x - (target.x + gap.x)) < 1e-9,
    'and what hangs off it kept its own shape',
  );
});

test('what goes downstream is the drawing where it was put', () => {
  const data = bindNodes(moveImage(placed(), { x: 7, y: 7 }), keysOf('a'), 'anything');
  const bound = boundRigOf(data)!;
  assert.deepEqual(bound.image.shapes[0]!.points[0], {
    x: drawing.shapes[0]!.points[0]!.x + 7,
    y: drawing.shapes[0]!.points[0]!.y + 7,
  });
  assert.equal(bound.rig, data.rig, 'and the skeleton as it stands');
});

test('the frame grows to hold a drawing zoomed past the edge of it', () => {
  // A frame left at the old size clips it everywhere downstream: the posing flow
  // would show three quarters of a character and no reason why.
  // The drawing's furthest shape reaches 24 of a 100-wide frame, so it takes a
  // good deal of zoom before any of it is actually over the edge.
  const data = zoomImage(placed(), 8, { x: 0, y: 0 });
  const grown = placedImage(data);
  assert.ok(grown.width > drawing.width, `${grown.width} against ${drawing.width}`);
  const far = Math.max(...grown.shapes.flatMap((shape) => shape.points.map((point) => point.x)));
  assert.ok(grown.width >= far, 'and holds the furthest point of it');
});
