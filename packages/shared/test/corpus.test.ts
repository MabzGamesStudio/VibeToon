import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DERIVE_OPTIONS,
  DEFAULT_EXTRACT_OPTIONS,
  combineDatasets,
  deriveLexicon,
  extractCorpus,
  isLookupCandidate,
  meaningForToken,
  subtractDataset,
  wordTypeFromPartOfSpeech,
  type CorpusDataset,
} from '../src/text/corpus';
import { buildLexiconIndex } from '../src/text/lexicon';
import { lexemeIdFor, type WordMeaning } from '../src/text/senses';

const OPTIONS = { ...DEFAULT_EXTRACT_OPTIONS, minPairCount: 1, maxWords: 200 };

function extract(text: string, name = 'test'): CorpusDataset {
  return extractCorpus(text, name, { kind: 'pasted' }, OPTIONS);
}

function entry(dataset: CorpusDataset, spelling: string) {
  return dataset.entries.find((candidate) => candidate.spelling === spelling);
}

function linkCount(dataset: CorpusDataset, from: string, to: string): number {
  return entry(dataset, from)?.next.find(([target]) => target === to)?.[1] ?? 0;
}

/* ---------------- counting ---------------- */

test('a corpus is counted into tokens and the pairs they make', () => {
  const dataset = extract('The lamp is old. The lamp is brass.');
  assert.equal(dataset.tokenCount, 10, 'eight words and two full stops, counted with their repeats');
  assert.equal(entry(dataset, 'the')?.count, 2);
  assert.equal(entry(dataset, 'lamp')?.count, 2);
  assert.equal(linkCount(dataset, 'the', 'lamp'), 2);
  assert.equal(linkCount(dataset, 'lamp', 'is'), 2);
  assert.equal(linkCount(dataset, 'is', 'old'), 1);
  assert.equal(linkCount(dataset, 'old', '.'), 1, 'punctuation is a token like any other');
  assert.equal(linkCount(dataset, '.', 'the'), 1, 'and the chain runs through a full stop');
});

test('a blank line breaks the chain, a wrapped line does not', () => {
  const across = extract('a heading\n\nthe lamp');
  assert.equal(linkCount(across, 'heading', 'the'), 0, 'nothing links across a paragraph break');

  const wrapped = extract('the quiet\nlamp');
  assert.equal(linkCount(wrapped, 'quiet', 'lamp'), 1, 'a single line break is just a wrap');
});

test('punctuation can be left out of the counting entirely', () => {
  const dataset = extractCorpus('The lamp is old. The lamp is brass.', 'x', { kind: 'pasted' }, {
    ...OPTIONS,
    includePunctuation: false,
  });
  assert.equal(entry(dataset, '.'), undefined);
  assert.equal(linkCount(dataset, 'old', 'the'), 0, 'the chain stops at a dropped token');
});

test('pruning keeps the common words and the pairs worth keeping', () => {
  const text = 'a b a b a b a c d e f g h';
  const dataset = extractCorpus(text, 'x', { kind: 'pasted' }, {
    ...OPTIONS,
    maxWords: 3,
    minPairCount: 2,
  });
  assert.deepEqual(
    dataset.entries.map((candidate) => candidate.spelling),
    ['a', 'b', 'c'],
    'the three most common survive',
  );
  assert.equal(dataset.distinctCount, 8, 'what was thrown away is still reported');
  assert.equal(linkCount(dataset, 'a', 'b'), 3);
  assert.equal(linkCount(dataset, 'a', 'c'), 0, 'a pair seen once is below the floor');
});

/* ---------------- set algebra ---------------- */

const ONE = 'the lamp is old. the lamp is old.';
const TWO = 'the gear is brass. the gear turns.';

test('datasets add up', () => {
  const a = extract(ONE, 'one');
  const b = extract(TWO, 'two');
  const master = combineDatasets([a, b], 'master');

  assert.equal(master.tokenCount, a.tokenCount + b.tokenCount);
  assert.equal(entry(master, 'the')?.count, 4);
  assert.equal(entry(master, 'lamp')?.count, 2);
  assert.equal(entry(master, 'gear')?.count, 2);
  assert.equal(linkCount(master, 'the', 'lamp'), 2);
  assert.equal(linkCount(master, 'the', 'gear'), 2);
});

test('taking a dataset back out leaves exactly what it was', () => {
  const odyssey = extract(ONE, 'odyssey');
  const gatsby = extract(TWO, 'gatsby');
  const master = combineDatasets([odyssey, gatsby], 'master');

  const withoutOdyssey = subtractDataset(master, odyssey, 'gatsby only');
  assert.equal(withoutOdyssey.tokenCount, gatsby.tokenCount);
  assert.deepEqual(
    withoutOdyssey.entries.map((candidate) => [candidate.spelling, candidate.count]).sort(),
    gatsby.entries.map((candidate) => [candidate.spelling, candidate.count]).sort(),
    'the counts are identical, not merely close',
  );
  for (const candidate of gatsby.entries) {
    for (const [target, count] of candidate.next) {
      assert.equal(
        linkCount(withoutOdyssey, candidate.spelling, target),
        count,
        `${candidate.spelling} → ${target}`,
      );
    }
  }
  assert.equal(entry(withoutOdyssey, 'lamp'), undefined, 'words only the removed book had are gone');
});

test('subtracting everything leaves nothing behind', () => {
  const a = extract(ONE, 'one');
  const empty = subtractDataset(a, a, 'none');
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.tokenCount, 0);
});

test('combining nothing is an empty dataset, not a crash', () => {
  const empty = combineDatasets([], 'master');
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.tokenCount, 0);
});

/* ---------------- derivation ---------------- */

test('frequency follows how often a word turns up', () => {
  const dataset = extract('the the the the lamp lamp gear');
  const lexicon = deriveLexicon(dataset, {});
  const byName = new Map(lexicon.lexemes.map((lexeme) => [lexeme.spelling, lexeme]));

  assert.equal(byName.get('the')!.frequency, 1, 'the most common word tops out at 1');
  assert.ok(byName.get('lamp')!.frequency < 1);
  assert.ok(byName.get('lamp')!.frequency > byName.get('gear')!.frequency);
  assert.equal(byName.get('the')!.stats?.count, 4);
  assert.equal(byName.get('gear')!.stats?.perMillion, Math.round((1 / 7) * 1_000_000));
});

test('a context is weighted by lift, so a common word is not everyone’s strongest link', () => {
  // `beetle` only ever follows `brass`; `the` follows everything.
  const text = [
    'the brass beetle sat.',
    'the lamp sat.',
    'the gear sat.',
    'the floor sat.',
    'the door sat.',
    'the brass beetle sat.',
  ].join(' ');
  const lexicon = deriveLexicon(extract(text), {});
  const brass = lexicon.lexemes.find((lexeme) => lexeme.spelling === 'brass')!;
  const strongest = brass.contexts[0]!;
  assert.equal(strongest.id, lexemeIdFor('beetle'), 'the specific follower wins');

  const fullStop = lexicon.lexemes.find((lexeme) => lexeme.spelling === '.')!;
  const toThe = fullStop.contexts.find((context) => context.id === lexemeIdFor('the'));
  assert.ok(toThe, '`. → the` is still a link');
  assert.ok(toThe!.weight < 1, 'but a word that follows everything is not full strength');
});

test('derived contexts always point at words that are in the lexicon', () => {
  const dataset = extract('the lamp is old. the gear is brass. a door opens.');
  const lexicon = deriveLexicon(dataset, {});
  const index = buildLexiconIndex(lexicon);
  for (const lexeme of lexicon.lexemes) {
    for (const context of lexeme.contexts) {
      assert.ok(index.byId.has(context.id), `${lexeme.spelling} → ${context.id}`);
      assert.ok(context.weight > 0 && context.weight <= 1);
    }
  }
  assert.deepEqual(
    [...new Set(lexicon.lexemes.map((lexeme) => lexeme.id))].length,
    lexicon.lexemes.length,
    'ids are unique, so nothing shadows anything else',
  );
});

test('what the dictionary said is used, and anything it was not asked about stays unknown', () => {
  const meanings: Record<string, WordMeaning> = {
    lamp: {
      senses: [{ type: 'noun', description: 'A light you can move.' }],
      source: 'dictionary',
    },
  };
  const lexicon = deriveLexicon(extract('the lamp flickers quietly.'), meanings);
  const byName = new Map(lexicon.lexemes.map((lexeme) => [lexeme.spelling, lexeme]));

  assert.equal(byName.get('lamp')!.type, 'noun');
  assert.equal(byName.get('lamp')!.description, 'A light you can move.');
  assert.equal(byName.get('the')!.type, 'unknown', 'not even a function word is assumed');
  assert.equal(byName.get('quietly')!.type, 'unknown', 'and a suffix is not a fair guess');
  assert.equal(byName.get('quietly')!.description, '');
});

test('a spelling with several meanings becomes several entries', () => {
  const meanings: Record<string, WordMeaning> = {
    light: {
      senses: [
        { type: 'noun', description: 'What lets you see.', variations: { singular: 'light', plural: 'lights' } },
        {
          type: 'verb',
          description: 'To set burning.',
          variations: { infinitive: 'light', past: 'lit', past_participle: 'lit' },
        },
        { type: 'adjective', description: 'Not heavy.' },
      ],
      source: 'dictionary',
    },
  };
  const lexicon = deriveLexicon(extract('the light is light. light the light.'), meanings);
  const rows = lexicon.lexemes.filter((lexeme) => lexeme.spelling === 'light');

  assert.equal(rows.length, 3, 'a noun, a verb and an adjective');
  assert.deepEqual(rows.map((row) => row.type), ['noun', 'verb', 'adjective']);
  assert.deepEqual(
    rows.map((row) => row.description),
    ['What lets you see.', 'To set burning.', 'Not heavy.'],
  );

  // The commonest sense keeps the plain id, because the context links counted
  // out of the corpus point at it and know nothing about senses.
  assert.equal(rows[0]!.id, lexemeIdFor('light'));
  assert.equal(new Set(rows.map((row) => row.id)).size, 3, 'and the ids do not collide');

  // The counting could not tell the senses apart, so each carries the same count.
  assert.equal(new Set(rows.map((row) => row.stats?.count)).size, 1);
});

test('tighter derivation settings cut the weak links', () => {
  const dataset = extract('the lamp is old. the gear is brass. the door is open. the floor is cold.');
  const loose = deriveLexicon(dataset, {}, { ...DEFAULT_DERIVE_OPTIONS, minWeight: 0, maxContexts: 20 });
  const tight = deriveLexicon(dataset, {}, { ...DEFAULT_DERIVE_OPTIONS, minWeight: 0.6, maxContexts: 2 });
  const links = (lexicon: { lexemes: Array<{ contexts: unknown[] }> }) =>
    lexicon.lexemes.reduce((sum, lexeme) => sum + lexeme.contexts.length, 0);
  assert.ok(links(tight) < links(loose));
  assert.ok(tight.lexemes.every((lexeme) => lexeme.contexts.length <= 2));
});

/* ---------------- word types ---------------- */

test('the dictionary’s part of speech maps onto a word type', () => {
  assert.equal(wordTypeFromPartOfSpeech('noun'), 'noun');
  assert.equal(wordTypeFromPartOfSpeech('Adjective'), 'adjective');
  assert.equal(wordTypeFromPartOfSpeech('exclamation'), 'interjection');
  assert.equal(wordTypeFromPartOfSpeech('article'), 'determiner');
  assert.equal(wordTypeFromPartOfSpeech('gerund'), undefined, 'anything unknown is left to the caller');
});

test('tokens a dictionary cannot help with are handled here', () => {
  assert.equal(meaningForToken('.')?.senses[0]?.type, 'punctuation');
  assert.equal(meaningForToken('.')?.source, 'token', 'read off the token, not from a dictionary');
  assert.equal(meaningForToken('42')?.senses[0]?.type, 'number');
  assert.equal(meaningForToken('lamp'), undefined, 'a real word is the dictionary’s job');
  assert.equal(isLookupCandidate('lamp'), true);
  assert.equal(isLookupCandidate("don't"), true);
  assert.equal(isLookupCandidate('42'), false);
  assert.equal(isLookupCandidate('—'), false);
});

/**
 * There used to be an `inferWordType` here that read a type off a word's ending —
 * `-ly` is an adverb, `-ness` is a noun, everything else is a noun. It was wrong
 * often enough to be worse than nothing, because the grammar flow trusts the type
 * completely and has no way to tell a guess from an answer.
 */
test('a word nobody has looked up gets no type rather than a guessed one', () => {
  const dataset = extract('The quietly careless happiness turning.');
  const lexicon = deriveLexicon(dataset, {});
  const words = lexicon.lexemes.filter((lexeme) => /[a-z]/.test(lexeme.spelling));

  assert.ok(words.length >= 5);
  assert.deepEqual(
    [...new Set(words.map((lexeme) => lexeme.type))],
    ['unknown'],
    'every one of them, including the ones a suffix rule would have been confident about',
  );
  assert.ok(
    words.every((lexeme) => lexeme.variations === undefined),
    'and no forms either, since forms follow from the type',
  );
});
