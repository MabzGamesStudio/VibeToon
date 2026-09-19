import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleGrammarDataset } from '../src/flows/grammar';
import { starterLexicon } from '../src/flows/lexicon';
import { runRandomText } from '../src/text/generate';
import {
  DEFAULT_GRAMMAR_OPTIONS,
  buildGrammarModel,
  combineGrammar,
  continuationScore,
  extractGrammar,
  parsePattern,
  patternSignature,
  slotForLexeme,
  spellForSlot,
  subtractGrammar,
  type GrammarDataset,
  type GrammarExtractOptions,
} from '../src/text/grammarDatabase';
import { DEFAULT_RANDOM_TEXT_OPTIONS, type Lexeme, type Lexicon, type RandomTextOptions } from '../src/types/text';

/**
 * A word database small enough to know by heart, so a pattern can be checked
 * slot by slot. The grammar reads types off these entries rather than guessing,
 * which is the whole reason the flow takes a word database as an input.
 */
function word(spelling: string, type: Lexeme['type'], variations?: Record<string, string>): Lexeme {
  return {
    id: `lex_${spelling === '.' ? 'stop' : spelling === ',' ? 'comma' : spelling}`,
    spelling,
    type,
    frequency: 0.5,
    description: '',
    contexts: [],
    ...(variations ? { variations } : {}),
  };
}

const LEXICON: Lexicon = {
  lexemes: [
    word('the', 'determiner'),
    word('lamp', 'noun', { singular: 'lamp', plural: 'lamps' }),
    word('gear', 'noun', { singular: 'gear', plural: 'gears' }),
    word('is', 'verb', {
      infinitive: 'be',
      third_person_singular: 'is',
      present_progressive: 'being',
      past: 'was',
      past_participle: 'been',
    }),
    word('old', 'adjective', { positive: 'old', comparative: 'older', superlative: 'oldest' }),
    word('and', 'conjunction'),
    word('.', 'punctuation'),
    word(',', 'punctuation'),
  ],
};

const OPTIONS: GrammarExtractOptions = { ...DEFAULT_GRAMMAR_OPTIONS, minCount: 2 };

function extract(text: string, name = 'test', options = OPTIONS): GrammarDataset {
  return extractGrammar(text, LEXICON, name, { kind: 'pasted' }, options);
}

function countOf(entries: Array<[string, number]>, signature: string): number {
  return entries.find(([candidate]) => candidate === signature)?.[1] ?? 0;
}

const CLAUSE = 'determiner noun:singular verb:third_person_singular adjective:positive';
const SENTENCE = `${CLAUSE} punctuation:.`;

/* ---------------- what a corpus is read into ---------------- */

test('a sentence is counted as the shape its words make', () => {
  const dataset = extract('The lamp is old. The gear is old.');

  assert.equal(countOf(dataset.sentences, SENTENCE), 2, 'both sentences have the same shape');
  assert.equal(dataset.stats.sentences, 2);
  assert.equal(dataset.stats.tokens, 10, 'eight words and two full stops');
  assert.equal(dataset.stats.tagged, 8, 'the word database knew every word; a mark needs no looking up');
  assert.equal(dataset.stats.unknown, 0);
});

test('a word the database has never seen is still tagged, by guess', () => {
  const dataset = extract('The flywheel is old. The flywheel is old.');
  assert.equal(dataset.stats.unknown, 2, 'and it is reported as a guess');
  assert.ok(dataset.sentences.length > 0, 'so the sentence around it is still counted');
});

test('a fragment is a clause on its own, without the joining words', () => {
  const dataset = extract('The lamp is old and the gear is old. The lamp is old and the gear is old.');

  assert.equal(countOf(dataset.fragments, CLAUSE), 4, 'two clauses in each of two sentences');
  assert.equal(
    countOf(dataset.fragments, `${CLAUSE} conjunction ${CLAUSE}`),
    0,
    'the conjunction is where the sentence was cut, so it is in no fragment',
  );
  assert.equal(dataset.stats.fragments, 4);
});

test('a comma cuts a clause the same way a conjunction does', () => {
  const dataset = extract('The lamp is old, the gear is old. The lamp is old, the gear is old.');
  assert.equal(countOf(dataset.fragments, CLAUSE), 4);
});

test('phrases are every short run inside a fragment', () => {
  const dataset = extract('The lamp is old. The gear is old.', 'test', {
    ...OPTIONS,
    phraseMin: 2,
    phraseMax: 3,
  });

  assert.equal(countOf(dataset.phrases, 'determiner noun:singular'), 2);
  assert.equal(countOf(dataset.phrases, 'verb:third_person_singular adjective:positive'), 2);
  assert.equal(countOf(dataset.phrases, 'determiner noun:singular verb:third_person_singular'), 2);
  assert.equal(
    countOf(dataset.phrases, 'determiner noun:singular verb:third_person_singular adjective:positive'),
    0,
    'four slots is past the longest phrase asked for',
  );
  assert.ok(
    dataset.phrases.every(([signature]) => !signature.includes('punctuation:.')),
    'the full stop belongs to the sentence, not to a phrase inside it',
  );
});

test('the word form can be left out of a pattern', () => {
  const loose = extract('The lamp is old. The gear is old.', 'test', { ...OPTIONS, useForms: false });
  assert.equal(
    countOf(loose.sentences, 'determiner noun verb adjective punctuation:.'),
    2,
    'only the types are kept',
  );
  assert.equal(countOf(loose.sentences, SENTENCE), 0);
});

test('a shape seen once is kept as a sentence but not as a phrase', () => {
  const dataset = extract('The lamp is old.');
  assert.equal(countOf(dataset.sentences, SENTENCE), 1, 'a whole sentence repeating at all is worth keeping');
  assert.deepEqual(dataset.phrases, [], 'a run seen once is below the floor');
});

test('a sentence longer than the ceiling is counted but not kept', () => {
  const dataset = extract('The lamp is old. The lamp is old.', 'test', { ...OPTIONS, maxSentenceSlots: 3 });
  assert.equal(dataset.stats.sentences, 2, 'it was still read');
  assert.deepEqual(dataset.sentences, [], 'but five slots is past the ceiling');
});

/* ---------------- combining and taking back out ---------------- */

const FIRST = 'The lamp is old. The lamp is old. The gear is old.';
const SECOND = 'The gear is old, the lamp is old. The gear is old, the lamp is old.';

test('combining adds the counts of both corpora together', () => {
  const a = extract(FIRST, 'first');
  const b = extract(SECOND, 'second');
  const master = combineGrammar([a, b]);

  assert.equal(
    countOf(master.sentences, SENTENCE),
    countOf(a.sentences, SENTENCE) + countOf(b.sentences, SENTENCE),
  );
  assert.equal(master.stats.tokens, a.stats.tokens + b.stats.tokens);
  assert.equal(master.stats.sentences, a.stats.sentences + b.stats.sentences);
});

test('taking a corpus back out leaves exactly what the other one put in', () => {
  const a = extract(FIRST, 'first');
  const b = extract(SECOND, 'second');
  const left = subtractGrammar(combineGrammar([a, b]), a);

  assert.deepEqual(left.sentences, b.sentences, 'sentence counts match the corpus that is left');
  assert.deepEqual(left.fragments, b.fragments);
  assert.deepEqual(left.phrases, b.phrases);
  assert.deepEqual(left.stats, b.stats, 'and so does what was read');
});

test('taking out the only corpus leaves nothing', () => {
  const a = extract(FIRST, 'first');
  const left = subtractGrammar(combineGrammar([a]), a);
  assert.deepEqual(left.sentences, []);
  assert.deepEqual(left.fragments, []);
  assert.deepEqual(left.phrases, []);
  assert.equal(left.stats.tokens, 0);
});

/* ---------------- what the generator reads off it ---------------- */

test('a pattern survives being written down and read back', () => {
  const slots = parsePattern(SENTENCE);
  assert.equal(patternSignature(slots), SENTENCE);
  assert.deepEqual(slots[0], { type: 'determiner' });
  assert.deepEqual(slots[1], { type: 'noun', form: 'singular' });
  assert.deepEqual(slots[4], { type: 'punctuation', mark: '.' });
});

/** A determiner is followed by a noun three times over and an adjective twice. */
const MIXED = [
  'The lamp is old. The lamp is old. The lamp is old.',
  'The old gear is old. The old gear is old.',
].join(' ');

const DETERMINER = { type: 'determiner' as const };
const NOUN = { type: 'noun' as const, form: 'singular' as const };

test('the model knows which slot tends to follow which', () => {
  const model = buildGrammarModel(extract(MIXED));
  assert.ok(model, 'a dataset builds a model');

  const noun = continuationScore(model!, [DETERMINER], NOUN);
  const adjective = continuationScore(model!, [DETERMINER], { type: 'adjective', form: 'positive' });

  assert.ok(noun > 0 && adjective > 0, 'both followed a determiner in this corpus');
  assert.ok(noun > adjective, 'but the one it did more often pulls harder');
  assert.equal(
    continuationScore(model!, [DETERMINER], { type: 'preposition' }),
    0,
    'and a preposition never followed one at all',
  );
});

test('a run the corpus has never seen falls back to a shorter one', () => {
  const model = buildGrammarModel(extract(MIXED))!;
  assert.equal(
    continuationScore(model, [{ type: 'interjection' }, DETERMINER], NOUN),
    continuationScore(model, [DETERMINER], NOUN),
    'the unfamiliar run is dropped and the familiar tail is read instead',
  );
  assert.equal(
    continuationScore(model, [{ type: 'interjection' }], NOUN),
    0,
    'with nothing familiar left there is nothing to go on',
  );
});

test('a slot in the wrong form still counts for something', () => {
  const model = buildGrammarModel(extract('The lamp is old. The gear is old.'))!;
  const past = continuationScore(model, [DETERMINER, NOUN], {
    type: 'verb',
    form: 'past',
  });
  const present = continuationScore(model, [DETERMINER, NOUN], {
    type: 'verb',
    form: 'third_person_singular',
  });
  assert.ok(past > 0, 'a verb in the wrong tense is still a verb');
  assert.ok(present > past, 'but the tense the corpus used pulls harder');
});

test('an empty grammar builds no model', () => {
  assert.equal(buildGrammarModel(null), null);
});

/* ---------------- fitting a word to a slot ---------------- */

test('a word is spelled the way the slot asks for', () => {
  const lamp = LEXICON.lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;
  assert.equal(spellForSlot(lamp, { type: 'noun', form: 'plural' }), 'lamps');
  assert.equal(spellForSlot(lamp, { type: 'noun' }), 'lamp', 'a slot with no form takes the word as it is');

  const is = LEXICON.lexemes.find((lexeme) => lexeme.spelling === 'is')!;
  assert.equal(spellForSlot(is, { type: 'verb', form: 'past' }), 'was');
  assert.equal(spellForSlot(is, { type: 'verb', form: 'infinitive' }), 'be');
});

/**
 * This used to say the opposite: a word with no stored forms was run through a
 * rule engine, so `walks` came back as `walked`. The engine also turned `forgive`
 * into `forgived`, and a generator confidently writing a non-word is worse than
 * one leaving a verb in the wrong tense — the second reads as a rough draft, the
 * first reads as a bug, because it is one.
 */
test('a word with no forms of its own goes in as it is, rather than being guessed at', () => {
  const walks: Lexeme = {
    id: 'lex_walks',
    spelling: 'walks',
    type: 'verb',
    frequency: 0.4,
    description: '',
    contexts: [],
  };
  assert.equal(spellForSlot(walks, { type: 'verb', form: 'past' }), 'walks');
  assert.equal(spellForSlot(walks, { type: 'verb', form: 'present_progressive' }), 'walks');

  // Give it the paradigm a dataset would have supplied, and it inflects.
  const known: Lexeme = {
    ...walks,
    variations: { infinitive: 'walk', past: 'walked', present_progressive: 'walking' },
  };
  assert.equal(spellForSlot(known, { type: 'verb', form: 'past' }), 'walked');
  assert.equal(spellForSlot(known, { type: 'verb', form: 'present_progressive' }), 'walking');
});

test('a form the word does not have leaves the spelling alone', () => {
  const must: Lexeme = {
    id: 'lex_must',
    spelling: 'must',
    type: 'verb',
    frequency: 0.4,
    description: '',
    contexts: [],
  };
  assert.equal(spellForSlot(must, { type: 'verb', form: 'present_progressive' }), 'must');
});

test('the slot a word already fills is read off its spelling', () => {
  const lamps: Lexeme = {
    id: 'lex_lamps',
    spelling: 'lamps',
    type: 'noun',
    frequency: 0.3,
    description: '',
    contexts: [],
    variations: { singular: 'lamp', plural: 'lamps' },
  };
  assert.deepEqual(slotForLexeme(lamps), { type: 'noun', form: 'plural' });
  assert.deepEqual(slotForLexeme(LEXICON.lexemes.find((lexeme) => lexeme.spelling === '.')!), {
    type: 'punctuation',
    mark: '.',
  });
});

/* ---------------- and what it does to the writing ---------------- */

const STARTER = starterLexicon();
const SAMPLE_GRAMMAR = sampleGrammarDataset(STARTER);

function options(overrides: Partial<RandomTextOptions> = {}): RandomTextOptions {
  return {
    ...DEFAULT_RANDOM_TEXT_OPTIONS,
    ...overrides,
    length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, ...(overrides.length ?? {}) },
  };
}

test('the sample corpus reads into a grammar database worth writing with', () => {
  assert.ok(SAMPLE_GRAMMAR.sentences.length > 0, 'it found sentence shapes');
  assert.ok(SAMPLE_GRAMMAR.phrases.length > 20, `${SAMPLE_GRAMMAR.phrases.length} phrase shapes`);
  const words = SAMPLE_GRAMMAR.stats.tagged + SAMPLE_GRAMMAR.stats.unknown;
  assert.ok(
    SAMPLE_GRAMMAR.stats.tagged / words > 0.9,
    'and the word database types nearly every word, because both came from the same corpus',
  );
});

test('a wired grammar database writes into its sentence shapes', () => {
  const result = runRandomText({
    input: '',
    options: options({
      mode: 'generate',
      seed: 'grammar-on',
      grammarWeight: 0.8,
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 40 },
    }),
    lexicon: STARTER,
    grammar: SAMPLE_GRAMMAR,
  });

  assert.ok(result.stats.patternsUsed > 0, `${result.stats.patternsUsed} shapes were taken from the grammar`);
  assert.ok(result.text.trim().length > 0);
  assert.deepEqual(result.warnings, []);
});

test('with no grammar wired in, or none wanted, nothing is taken from it', () => {
  const without = runRandomText({
    input: '',
    options: options({ mode: 'generate', seed: 'grammar-off', grammarWeight: 0.8 }),
    lexicon: STARTER,
  });
  assert.equal(without.stats.patternsUsed, 0, 'there is no grammar to take a shape from');

  const ignored = runRandomText({
    input: '',
    options: options({ mode: 'generate', seed: 'grammar-off', grammarWeight: 0 }),
    lexicon: STARTER,
    grammar: SAMPLE_GRAMMAR,
  });
  assert.equal(ignored.stats.patternsUsed, 0, 'and at zero weight it is wired in but unused');
  assert.equal(
    ignored.text,
    without.text,
    'so the writing is the same as if it had never been connected',
  );
});

test('the grammar changes what gets written', () => {
  const settings = {
    mode: 'generate' as const,
    seed: 'same-seed',
    length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words' as const, words: 30 },
  };
  const plain = runRandomText({ input: '', options: options({ ...settings, grammarWeight: 0 }), lexicon: STARTER });
  const shaped = runRandomText({
    input: '',
    options: options({ ...settings, grammarWeight: 0.8 }),
    lexicon: STARTER,
    grammar: SAMPLE_GRAMMAR,
  });
  assert.notEqual(shaped.text, plain.text, 'the same seed writes something different through a grammar');
});

test('altering text leans on the grammar too', () => {
  const input = 'The lamp is warm and the gear turns in the workshop.';
  const settings = { mode: 'alter' as const, seed: 'alter-seed', alterTemperature: 0.6 };
  const plain = runRandomText({ input, options: options({ ...settings, grammarWeight: 0 }), lexicon: STARTER });
  const shaped = runRandomText({
    input,
    options: options({ ...settings, grammarWeight: 0.9 }),
    lexicon: STARTER,
    grammar: SAMPLE_GRAMMAR,
  });
  assert.notEqual(shaped.text, plain.text, 'a wired grammar changes which words it reaches for');
});

test('a grammar database with no sentence shapes says so', () => {
  const empty: GrammarDataset = { ...SAMPLE_GRAMMAR, sentences: [], fragments: [], phrases: [] };
  const result = runRandomText({
    input: '',
    options: options({ mode: 'generate', seed: 'empty-grammar', grammarWeight: 0.8 }),
    lexicon: STARTER,
    grammar: empty,
  });
  assert.ok(
    result.warnings.some((warning) => warning.includes('no sentence shapes')),
    'the run warns rather than writing as if it had one',
  );
});
