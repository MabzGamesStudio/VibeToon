import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  drawnPlates,
  emptyDesignData,
  keyImagePort,
  newPlate,
  plateFileName,
  plateSetPort,
} from '../src/flows/design';
import { requireFlowKind } from '../src/registry/flowKinds';
import type { DesignFlowData, DesignPlate } from '../src/types/design';

const CHARACTER = requireFlowKind('animation.character.design');
const SET = requireFlowKind('animation.set.design');
const PROP = requireFlowKind('animation.prop.design');

function drawn(label: string): DesignPlate {
  return {
    ...newPlate(label),
    sketch: {
      width: 640,
      height: 360,
      updatedAt: '2026-01-01T00:00:00.000Z',
      strokes: [{ points: [0, 0, 10, 10], color: '#fff', width: 2 }],
    },
  };
}

/* ---------------- what a new sheet is ---------------- */

test('a design flow starts with plates, not a blank page', () => {
  const data = emptyDesignData(CHARACTER);
  assert.equal(data.editor, 'design');
  assert.deepEqual(
    data.plates.map((plate) => plate.label),
    ['Front', 'Three-quarter', 'Expressions'],
    'a character sheet starts with the views a character sheet has',
  );
  assert.ok(data.plates.every((plate) => plate.sketch === null), 'and none of them is drawn yet');
});

test('each kind of design flow starts with the plates that kind needs', () => {
  assert.deepEqual(emptyDesignData(SET).plates.map((plate) => plate.label), ['Key view', 'Plan']);
  assert.deepEqual(emptyDesignData(PROP).plates.map((plate) => plate.label), ['Key view', 'In use']);
});

test('the written fields the kind declares are all there, and empty', () => {
  const data = emptyDesignData(CHARACTER);
  assert.deepEqual(
    Object.keys(data.fields).sort(),
    (CHARACTER.fields ?? []).map((field) => field.id).sort(),
    'every field the editor will draw has a value to draw',
  );
  assert.ok(Object.values(data.fields).every((value) => value === ''));
});

test('every new plate is its own plate', () => {
  const ids = [newPlate().id, newPlate().id, newPlate('Front').id];
  assert.equal(new Set(ids).size, 3);
  assert.equal(newPlate().label, 'Plate', 'an unnamed plate still has a name');
});

/* ---------------- where a plate ends up ---------------- */

test('a design flow knows which port its picture and its sheet go to', () => {
  assert.ok(keyImagePort(CHARACTER), 'the first plate has somewhere to be written');
  assert.ok(keyImagePort(CHARACTER)!.kinds.includes('image'));
  assert.ok(plateSetPort(CHARACTER), 'and so does the sheet of all of them');
  assert.ok(plateSetPort(CHARACTER)!.kinds.includes('imageSet'));
});

test('a file name is stable, readable and ordered', () => {
  assert.equal(plateFileName(0, 'Front'), 'plate-001-front.png');
  assert.equal(plateFileName(1, 'Three-quarter'), 'plate-002-three-quarter.png');
  assert.equal(plateFileName(9, 'Key view'), 'plate-010-key-view.png');
  assert.equal(
    plateFileName(11, 'Expressions'),
    'plate-012-expressions.png',
    'padded, so ten sorts after nine rather than after one',
  );
});

test('a label that is not a file name is made into one', () => {
  assert.equal(plateFileName(0, '¾ view / angled!'), 'plate-001-view-angled.png');
  assert.equal(plateFileName(0, '   '), 'plate-001-plate.png', 'a label of nothing still makes a name');
  assert.equal(plateFileName(0, '!!!'), 'plate-001-plate.png');
  assert.ok(
    plateFileName(0, 'a'.repeat(80)).length < 60,
    'and a very long label is cut rather than making an unusable name',
  );
});

/* ---------------- which plates count as done ---------------- */

test('only a plate with something drawn on it is a plate', () => {
  const data: DesignFlowData = {
    editor: 'design',
    fields: {},
    plates: [drawn('Front'), newPlate('Three-quarter'), { ...newPlate('Plan'), sketch: { width: 1, height: 1, strokes: [], updatedAt: '2026-01-01T00:00:00.000Z' } }],
  };

  assert.deepEqual(
    drawnPlates(data).map((plate) => plate.label),
    ['Front'],
    'an untouched plate and a started-then-cleared one are both blank',
  );
});

test('a sheet with nothing drawn on it has no plates to write', () => {
  assert.deepEqual(drawnPlates(emptyDesignData(CHARACTER)), []);
});
