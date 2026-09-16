import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addCorpusPart,
  emptyCorpusFlowData,
  includedParts,
  localPartText,
  moveCorpusPart,
  notePartRead,
  removeCorpusPart,
  samplePart,
  setCorpusIncluded,
  summariseCorpus,
  type CorpusFlowData,
  type CorpusPart,
} from '../src/flows/corpusFlow';
import { SAMPLE_CORPUS } from '../src/text/sampleCorpus';

function pasted(name: string, text: string): CorpusPart {
  return { id: `part_${name}`, name, kind: 'pasted', text, addedAt: '2026-01-01T00:00:00.000Z' };
}

function linked(name: string, url: string): CorpusPart {
  return { id: `part_${name}`, name, kind: 'url', url, addedAt: '2026-01-01T00:00:00.000Z' };
}

function empty(): CorpusFlowData {
  return { editor: 'corpus', parts: [], included: [], separator: '\n\n' };
}

/* ---------------- what a new flow is ---------------- */

test('a new corpus flow has something in it to read', () => {
  const data = emptyCorpusFlowData();
  assert.equal(data.parts.length, 1);
  assert.equal(data.included.length, 1, 'and it is switched on');
  assert.equal(data.parts[0]!.kind, 'builtin');
  assert.equal(localPartText(data.parts[0]!), SAMPLE_CORPUS, 'the built-in part carries the bundled sample');
});

/* ---------------- adding, removing, ticking ---------------- */

test('a part is added switched on, and removing it takes it out of the order too', () => {
  const one = pasted('one', 'The lamp is old.');
  const added = addCorpusPart(empty(), one);
  assert.deepEqual(added.included, [one.id]);
  assert.deepEqual(includedParts(added).map((part) => part.name), ['one']);

  const gone = removeCorpusPart(added, one.id);
  assert.deepEqual(gone.parts, [], 'the part is gone');
  assert.deepEqual(gone.included, [], 'and so is the reference to it, which would otherwise dangle');
});

test('unticking keeps the part but leaves it out of the output', () => {
  let data = addCorpusPart(addCorpusPart(empty(), pasted('one', 'a')), pasted('two', 'b'));
  data = setCorpusIncluded(data, 'part_one', false);

  assert.equal(data.parts.length, 2, 'nothing was thrown away');
  assert.deepEqual(includedParts(data).map((part) => part.name), ['two']);

  const back = setCorpusIncluded(data, 'part_one', true);
  assert.deepEqual(includedParts(back).map((part) => part.name), ['two', 'one'], 'and it comes back at the end');
});

test('ticking something already ticked changes nothing at all', () => {
  const data = addCorpusPart(empty(), pasted('one', 'a'));
  assert.equal(setCorpusIncluded(data, 'part_one', true), data, 'the same object, so nothing re-renders');
  assert.equal(setCorpusIncluded(data, 'part_one', false).included.length, 0);
});

/* ---------------- order, because order is the output ---------------- */

test('parts can be reordered, and the order is what gets written', () => {
  let data = empty();
  for (const name of ['a', 'b', 'c']) data = addCorpusPart(data, pasted(name, name));
  assert.deepEqual(includedParts(data).map((part) => part.name), ['a', 'b', 'c']);

  data = moveCorpusPart(data, 'part_c', -1);
  assert.deepEqual(includedParts(data).map((part) => part.name), ['a', 'c', 'b']);

  data = moveCorpusPart(data, 'part_a', 1);
  assert.deepEqual(includedParts(data).map((part) => part.name), ['c', 'a', 'b']);
});

test('a part cannot be moved off either end', () => {
  let data = empty();
  for (const name of ['a', 'b']) data = addCorpusPart(data, pasted(name, name));

  assert.equal(moveCorpusPart(data, 'part_a', -1), data, 'the first stays first');
  assert.equal(moveCorpusPart(data, 'part_b', 1), data, 'and the last stays last');
  assert.equal(moveCorpusPart(data, 'part_nope', 1), data, 'a part that is not there moves nowhere');
});

/* ---------------- what is stored, and what is not ---------------- */

test('a pasted part carries its text; an address carries only the address', () => {
  assert.equal(localPartText(pasted('one', 'The lamp is old.')), 'The lamp is old.');
  assert.equal(
    localPartText(linked('book', 'https://example.org/book.txt')),
    null,
    'which is what keeps a novel out of the project file',
  );
  assert.equal(localPartText(samplePart()), SAMPLE_CORPUS);
});

test('what a run found is remembered, so the editor can show a size without fetching', () => {
  const data = addCorpusPart(empty(), linked('book', 'https://example.org/book.txt'));
  const read = notePartRead(data, 'part_book', { bytes: 4096 });

  assert.equal(read.parts[0]!.lastBytes, 4096);
  assert.ok(read.parts[0]!.lastReadAt, 'and when');
  assert.equal(read.parts[0]!.lastError, undefined);

  const failed = notePartRead(read, 'part_book', { error: 'example.org answered 404' });
  assert.match(failed.parts[0]!.lastError ?? '', /404/);

  const recovered = notePartRead(failed, 'part_book', { bytes: 4096 });
  assert.equal(recovered.parts[0]!.lastError, undefined, 'a later success clears the old complaint');
});

/* ---------------- the summary the editor shows ---------------- */

test('the summary counts only what is included, and is honest about what it cannot know', () => {
  let data = empty();
  data = addCorpusPart(data, pasted('one', 'x'.repeat(100)));
  data = addCorpusPart(data, pasted('two', 'y'.repeat(50)));
  data = addCorpusPart(data, linked('book', 'https://example.org/book.txt'));

  const before = summariseCorpus(data);
  assert.equal(before.parts, 3);
  assert.equal(before.included, 3);
  assert.equal(before.bytes, 150, 'only what it can actually measure');
  assert.equal(before.unknown, 1, 'and it says the address has never been read');

  const read = notePartRead(data, 'part_book', { bytes: 900 });
  assert.equal(summariseCorpus(read).bytes, 1050);
  assert.equal(summariseCorpus(read).unknown, 0);

  const off = setCorpusIncluded(read, 'part_one', false);
  assert.equal(summariseCorpus(off).bytes, 950, 'an unticked part is not in the size either');
  assert.equal(summariseCorpus(off).parts, 3, 'though it is still in the flow');
});

test('parts that could not be read are counted as problems', () => {
  const data = notePartRead(
    addCorpusPart(empty(), linked('book', 'https://example.org/book.txt')),
    'part_book',
    { error: 'could not reach example.org' },
  );
  assert.equal(summariseCorpus(data).errors, 1);
});
