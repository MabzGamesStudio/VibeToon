import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDataset,
  emptyLexiconFlowData,
  fillTokenMeanings,
  includedDatasets,
  masterDataset,
  masterLexicon,
  removeDataset,
  replaceDatasetFor,
  sampleDataset,
  setIncluded,
  starterLexicon,
  summarise,
  wordsNeedingLookup,
} from '../src/flows/lexicon';
import { DEFAULT_EXTRACT_OPTIONS, extractCorpus, type CorpusDataset } from '../src/text/corpus';

const OPTIONS = { ...DEFAULT_EXTRACT_OPTIONS, minPairCount: 1 };

function corpus(text: string, name: string, reference?: string): CorpusDataset {
  return extractCorpus(
    text,
    name,
    reference ? { kind: 'flow', reference } : { kind: 'pasted' },
    OPTIONS,
  );
}

function empty() {
  return { ...emptyLexiconFlowData(), datasets: [], included: [] };
}

function countOf(dataset: CorpusDataset, spelling: string): number {
  return dataset.entries.find((entry) => entry.spelling === spelling)?.count ?? 0;
}

/* ---------------- what a new flow is ---------------- */

test('a new word database has the sample counted into it', () => {
  const data = emptyLexiconFlowData();
  assert.equal(data.datasets.length, 1);
  assert.deepEqual(data.included, [data.datasets[0]!.id], 'and it is switched on');
  assert.ok(masterDataset(data).tokenCount > 400);
  assert.ok(starterLexicon().lexemes.length > 100, 'so a Random Text flow can write immediately');
});

/* ---------------- adding, ticking, removing ---------------- */

test('a dataset is added switched on, or held back when asked', () => {
  const one = corpus('The lamp is old.', 'One');
  assert.deepEqual(addDataset(empty(), one).included, [one.id]);
  assert.deepEqual(addDataset(empty(), one, false).included, [], 'added but not counted in');
});

test('removing a dataset takes its id out of the order too', () => {
  const one = corpus('The lamp is old.', 'One');
  const gone = removeDataset(addDataset(empty(), one), one.id);
  assert.deepEqual(gone.datasets, []);
  assert.deepEqual(gone.included, [], 'nothing is left pointing at a dataset that is not there');
});

test('unticking keeps the corpus but takes its counts out of the master', () => {
  let data = addDataset(empty(), corpus('lamp lamp lamp', 'Lamps'));
  data = addDataset(data, corpus('gear gear', 'Gears'));
  assert.equal(countOf(masterDataset(data), 'lamp'), 3);

  const off = setIncluded(data, data.datasets[0]!.id, false);
  assert.equal(off.datasets.length, 2, 'the corpus is still there');
  assert.equal(countOf(masterDataset(off), 'lamp'), 0, 'but none of its words are');
  assert.equal(countOf(masterDataset(off), 'gear'), 2);
  assert.deepEqual(includedDatasets(off).map((dataset) => dataset.name), ['Gears']);
});

test('the master is the sum of what is ticked, and taking one out is exact', () => {
  const lamps = corpus('lamp lamp lamp', 'Lamps');
  const both = addDataset(addDataset(empty(), lamps), corpus('lamp gear', 'Mixed'));

  assert.equal(countOf(masterDataset(both), 'lamp'), 4, 'three plus one');

  const onlyLamps = setIncluded(both, both.datasets[1]!.id, false);
  assert.equal(
    countOf(masterDataset(onlyLamps), 'lamp'),
    countOf(lamps, 'lamp'),
    'what is left is exactly what the other corpus put in',
  );
});

/* ---------------- a corpus that arrives over a wire ---------------- */

test('a dataset from a wire replaces the one that wire brought last time', () => {
  const first = corpus('the kettle boils', 'Source', 'conn_1');
  let data = replaceDatasetFor(empty(), 'conn_1', first);
  assert.equal(data.datasets.length, 1, 'the first time, it is simply added');
  assert.deepEqual(data.included, [first.id]);

  const second = corpus('the kettle boils and sings', 'Source', 'conn_1');
  data = replaceDatasetFor(data, 'conn_1', second);
  assert.equal(data.datasets.length, 1, 'generating again replaces rather than adding another');
  assert.deepEqual(data.included, [second.id], 'and the new one is counted in, not the old id');
  assert.equal(countOf(masterDataset(data), 'kettle'), 1, 'so nothing is counted twice');
});

test('two wires keep two datasets of their own', () => {
  let data = replaceDatasetFor(empty(), 'conn_1', corpus('lamp', 'A', 'conn_1'));
  data = replaceDatasetFor(data, 'conn_2', corpus('gear', 'B', 'conn_2'));
  assert.equal(data.datasets.length, 2);

  data = replaceDatasetFor(data, 'conn_1', corpus('lamp lamp', 'A', 'conn_1'));
  assert.equal(data.datasets.length, 2, 'replacing one leaves the other alone');
  assert.equal(countOf(masterDataset(data), 'gear'), 1);
  assert.equal(countOf(masterDataset(data), 'lamp'), 2);
});

/* ---------------- what still needs looking up ---------------- */

test('marks and numbers are typed without a dictionary', () => {
  const data = fillTokenMeanings(addDataset(empty(), corpus('The lamp is 42 old.', 'One')));

  assert.equal(data.meanings['.']?.type, 'punctuation');
  assert.equal(data.meanings['42']?.type, 'number');
  assert.equal(data.meanings.lamp, undefined, 'a real word still needs asking about');
});

test('filling token meanings twice changes nothing the second time', () => {
  const once = fillTokenMeanings(addDataset(empty(), corpus('The lamp is old.', 'One')));
  assert.equal(fillTokenMeanings(once), once, 'the same object, so nothing re-renders');
});

test('what needs looking up is the real words with no answer yet', () => {
  const data = addDataset(empty(), corpus('The lamp is old.', 'One'));
  const needed = wordsNeedingLookup(data);

  assert.ok(needed.includes('lamp'));
  assert.ok(!needed.includes('.'), 'a full stop needs no dictionary');

  const answered = {
    ...data,
    meanings: { lamp: { type: 'noun' as const, description: 'A light.', source: 'dictionary' as const } },
  };
  assert.ok(!wordsNeedingLookup(answered).includes('lamp'), 'and one that has been answered drops out');
});

/* ---------------- the summary the editor shows ---------------- */

test('the summary counts what is there and what is still guessed', () => {
  const data = {
    ...addDataset(empty(), corpus('The lamp is old.', 'One')),
    meanings: { lamp: { type: 'noun' as const, description: 'A light.', source: 'dictionary' as const } },
  };
  const master = masterDataset(data);
  const summary = summarise(data, masterLexicon(data, master), master);

  assert.equal(summary.datasets, 1);
  assert.equal(summary.included, 1);
  assert.ok(summary.words > 0);
  assert.equal(summary.tokens, master.tokenCount);
  assert.equal(summary.defined, 1, 'lamp came from the dictionary');
  assert.equal(summary.undefined, wordsNeedingLookup(data, master).length);
});

test('a guessed answer is not counted as defined', () => {
  const data = {
    ...addDataset(empty(), corpus('The lamp is old.', 'One')),
    meanings: { lamp: { type: 'noun' as const, description: '', source: 'inferred' as const } },
  };
  const master = masterDataset(data);
  assert.equal(summarise(data, masterLexicon(data, master), master).defined, 0);
});

test('a database with nothing ticked is empty rather than broken', () => {
  const data = { ...emptyLexiconFlowData(), included: [] };
  const master = masterDataset(data);
  assert.equal(master.tokenCount, 0);
  assert.deepEqual(masterLexicon(data, master).lexemes, []);
  assert.deepEqual(wordsNeedingLookup(data, master), []);
});

test('the bundled sample is the same however it is reached', () => {
  assert.equal(sampleDataset().name, emptyLexiconFlowData().datasets[0]!.name);
});
