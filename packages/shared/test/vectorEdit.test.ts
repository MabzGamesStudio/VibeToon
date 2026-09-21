import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VECTOR_TOOL_HINT,
  VECTOR_TOOL_LABEL,
  adopt,
  editState,
  emptyVectorEditFlowData,
  emptyVectorizeFlowData,
  imageOf,
  vectorizeState,
} from '../src/flows/vectorEdit';
import type { VectorImage } from '../src/flows/vector';

const image = (): VectorImage => ({
  width: 10,
  height: 10,
  shapes: [
    {
      id: 'p1',
      kind: 'polygon',
      color: '#ff0000',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    },
  ],
});

/* ---------------- the decomposition flow ---------------- */

test('a fresh decomposition has nothing and says so', () => {
  const fresh = emptyVectorizeFlowData();
  assert.equal(fresh.editor, 'vectorize');
  assert.equal(fresh.result, null);
  assert.equal(vectorizeState(fresh, 'abc'), 'none');
});

test('a decomposition goes stale when the picture under it changes', () => {
  // The same rule as every other flow here that reads pixels in the editor: a
  // changed image is reported rather than quietly described by an old answer.
  const done = { ...emptyVectorizeFlowData(), result: image(), imageHash: 'abc' };
  assert.equal(vectorizeState(done, 'abc'), 'ready');
  assert.equal(vectorizeState(done, 'def'), 'stale');
});

test('a decomposition with no hash to compare is taken as ready', () => {
  // Nothing to be stale against; refusing to run would be worse than trusting it.
  const done = { ...emptyVectorizeFlowData(), result: image() };
  assert.equal(vectorizeState(done, 'abc'), 'ready');
  assert.equal(vectorizeState({ ...done, imageHash: 'abc' }, undefined), 'ready');
});

/* ---------------- the editor flow ---------------- */

test('a fresh editor holds nothing, and reading it gives an empty image', () => {
  const fresh = emptyVectorEditFlowData();
  assert.equal(fresh.editor, 'vectorEdit');
  assert.equal(fresh.image, null);
  assert.equal(fresh.edits, 0);
  assert.deepEqual(imageOf(fresh).shapes, [], 'rather than throwing on a flow nobody has opened');
  assert.equal(editState(fresh, 'abc'), 'none');
});

test('taking the upstream in replaces what was being edited, and resets the count', () => {
  const started = adopt(emptyVectorEditFlowData(), image(), 'abc');
  assert.equal(started.image!.shapes.length, 1);
  assert.equal(started.edits, 0);
  assert.equal(started.sourceHash, 'abc');

  const worked = { ...started, edits: 12, selected: ['p1'] };
  const again = adopt(worked, image(), 'def');
  assert.equal(again.edits, 0, 'the edits are against the new one now');
  assert.deepEqual(again.selected, [], 'and nothing carries over selected');
  assert.equal(again.sourceHash, 'def');
});

test('edits are kept when the upstream changes, and the change is reported', () => {
  // The whole point of the flow: a decomposition is a starting guess and the
  // edits are the work. Throwing them away on an upstream re-run would make it
  // not worth using.
  const worked = { ...adopt(emptyVectorEditFlowData(), image(), 'abc'), edits: 30 };
  assert.equal(editState(worked, 'def'), 'stale');
  assert.equal(worked.image!.shapes.length, 1, 'still there');
  assert.equal(worked.edits, 30);
});

test('an editor with no hash to compare is ready rather than stale', () => {
  const worked = { ...emptyVectorEditFlowData(), image: image() };
  assert.equal(editState(worked, 'abc'), 'ready');
});

test('every tool is named and explained', () => {
  for (const tool of ['select', 'add', 'cut', 'erase'] as const) {
    assert.ok(VECTOR_TOOL_LABEL[tool].length > 2, tool);
    assert.ok(VECTOR_TOOL_HINT[tool].length > 25, `${tool} needs a real explanation`);
  }
  // The gesture is only discoverable if it is written down somewhere.
  assert.match(VECTOR_TOOL_HINT.select, /right-click/i);
});

test('adopting keeps the hash out when there is none to record', () => {
  const started = adopt(emptyVectorEditFlowData(), image(), undefined);
  assert.equal('sourceHash' in started, false, 'rather than storing undefined and comparing against it');
});
