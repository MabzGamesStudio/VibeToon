import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UNBOUND_PART,
  adoptBound,
  emptyPartsFlowData,
  fileNameOf,
  majorityBone,
  moveShapesToPart,
  partById,
  partView,
  partsState,
  readRigParts,
  rigPartsFile,
  setPartImage,
  splitIntoParts,
  summariseParts,
} from '../src/flows/rigParts';
import { normaliseFlowData } from '../src/project/migrate';
import { matchBody } from './fixtures/matchBody';
import type { BoundRig } from '../src/flows/rigBind';

function body(): BoundRig {
  const bound = matchBody();
  // One shape bound to nothing, and one split between two bones.
  const loose = { id: 'loose', kind: 'polygon' as const, color: '#00ff00', points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }] };
  const sleeve = { id: 'sleeve', kind: 'polygon' as const, color: '#0000ff', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }] };
  return {
    ...bound,
    image: { ...bound.image, shapes: [...bound.image.shapes, loose, sleeve] },
    points: { ...bound.points, loose: [null, null, null], sleeve: ['left-upper-arm', 'left-forearm', 'left-forearm', null] },
  };
}

test('a shape goes to the bone that carries most of its points, or to none', () => {
  const bound = body();
  assert.equal(majorityBone(bound, bound.image.shapes.find((s) => s.id === 'sleeve')!), 'left-forearm');
  assert.equal(majorityBone(bound, bound.image.shapes.find((s) => s.id === 'loose')!), null);
  assert.equal(majorityBone(bound, bound.image.shapes.find((s) => s.id === 'part-head')!), 'head');
});

test('the drawing is split into one part per bone that carries anything, in the rig’s order, and one for the unbound', () => {
  const bound = body();
  const parts = splitIntoParts(bound);
  const ids = parts.map((part) => part.id);
  const rigOrder = bound.rig.bones.map((bone) => bone.id).filter((id) => ids.includes(id));
  assert.deepEqual(ids.slice(0, rigOrder.length), rigOrder);
  assert.equal(ids[ids.length - 1], UNBOUND_PART);
  const total = parts.reduce((sum, part) => sum + part.image.shapes.length, 0);
  assert.equal(total, bound.image.shapes.length, 'every shape in exactly one part');
  const head = parts.find((part) => part.id === 'head')!;
  assert.deepEqual(head.image.shapes.map((s) => s.id).sort(), ['eye-left', 'eye-right', 'hair', 'mouth', 'part-head']);
  assert.equal(head.image.width, bound.image.width, 'at the drawing’s size, so parts lie back over each other');
});

test('taking a binding in splits it and picks the first part; a changed binding is stale', () => {
  const data = adoptBound(emptyPartsFlowData(), body(), 'b1');
  assert.equal(data.current, data.parts[0]!.id);
  assert.equal(data.edits, 0);
  assert.equal(partsState(data, 'b1'), 'ready');
  assert.equal(partsState(data, 'b2'), 'stale');
  assert.equal(partsState(emptyPartsFlowData(), 'b1'), 'none');
});

test('a shape moved to another part keeps its place in the drawing’s order', () => {
  const data = adoptBound(emptyPartsFlowData(), body(), 'b1');
  const moved = moveShapesToPart(data, ['hair'], 'head', 'neck');
  assert.ok(!partById(moved, 'head')!.image.shapes.some((s) => s.id === 'hair'));
  const neck = partById(moved, 'neck')!.image.shapes.map((s) => s.id);
  assert.ok(neck.includes('hair'));
  const order = body().image.shapes.map((s) => s.id);
  assert.deepEqual(neck, [...neck].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  assert.equal(moved.edits, data.edits + 1);
  assert.equal(moveShapesToPart(data, ['hair'], 'head', 'head'), data, 'nowhere to go');
});

test('a shape can go to a bone that had no part, which then has one', () => {
  const bound = body();
  const data = adoptBound(emptyPartsFlowData(), bound, 'b1');
  const empty = bound.rig.bones.find((bone) => !data.parts.some((part) => part.id === bone.id));
  if (!empty) return; // every bone carries something in this body
  const moved = moveShapesToPart(data, ['loose'], UNBOUND_PART, empty.id);
  assert.equal(partById(moved, empty.id)!.name, empty.name);
});

test('a part’s shapes are replaced by an edit, and it can be framed on its own', () => {
  const data = adoptBound(emptyPartsFlowData(), body(), 'b1');
  const head = partById(data, 'head')!;
  const edited = setPartImage(data, 'head', { ...head.image, shapes: head.image.shapes.slice(0, 2) });
  assert.equal(partById(edited, 'head')!.image.shapes.length, 2);
  const view = partView(head)!;
  assert.ok(view.width < head.image.width, 'framed smaller than the whole drawing');
  assert.equal(partView({ ...head, image: { ...head.image, shapes: [] } }), null);
});

test('the file written has every part with its bone, its rest position and its shapes, and reads back', () => {
  const data = adoptBound(emptyPartsFlowData(), body(), 'b1');
  const file = rigPartsFile(data)!;
  assert.equal(file.kind, 'rigParts');
  const head = file.parts.find((part) => part.id === 'head')!;
  assert.equal(head.parent, 'neck');
  assert.ok(head.joint && head.bounds);
  const loose = file.parts.find((part) => part.id === UNBOUND_PART)!;
  assert.equal(loose.joint, null);
  assert.deepEqual(readRigParts(JSON.parse(JSON.stringify(file))), file);
  assert.equal(readRigParts({ kind: 'other' }), null);
  assert.equal(rigPartsFile(emptyPartsFlowData()), null);
});

test('file names are safe and never empty', () => {
  assert.equal(fileNameOf('Left Upper Arm', 'x'), 'left-upper-arm');
  assert.equal(fileNameOf('../../etc', 'x'), 'etc');
  assert.equal(fileNameOf('***', 'fallback'), 'fallback');
});

test('the summary counts parts, shapes and what is not bound; an old flow is filled in', () => {
  const data = adoptBound(emptyPartsFlowData(), body(), 'b1');
  assert.match(summariseParts(data), /part\(s\), \d+ shape\(s\) · 1 shape\(s\) not bound/);
  const old = normaliseFlowData({ editor: 'parts', bound: null } as never) as typeof data;
  assert.deepEqual([old.parts, old.selected, old.showOthers, old.edits, old.current], [[], [], true, 0, null]);
});
