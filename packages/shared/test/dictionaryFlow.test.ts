import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DICTIONARY_OPTIONS,
  applyMeaning,
  applyMeaningsToLexicon,
  emptyDictionaryFlowData,
  summariseDictionary,
  wordsToLookUp,
  type DictionaryFlowData,
} from '../src/flows/dictionary';
import type { WordMeaning } from '../src/text/corpus';
import type { Lexeme, Lexicon, WordType } from '../src/types/text';

function word(spelling: string, type: WordType, frequency = 0.5, description = ''): Lexeme {
  return { id: `lex_${spelling}`, spelling, type, frequency, description, contexts: [] };
}

function meaning(type: WordType, description: string, source: WordMeaning['source'] = 'dictionary'): WordMeaning {
  return { type, description, source };
}

function flow(over: Partial<DictionaryFlowData> = {}): DictionaryFlowData {
  return { ...emptyDictionaryFlowData(), ...over };
}

const LEXICON: Lexicon = {
  lexemes: [
    word('the', 'determiner', 1),
    word('walk', 'noun', 0.6),
    word('lamp', 'noun', 0.4),
    word('quietly', 'noun', 0.05),
    word('.', 'punctuation', 0.9),
    word('42', 'number', 0.02),
  ],
};

/* ---------------- which words are worth asking about ---------------- */

test('marks and numbers are never asked about', () => {
  const asked = wordsToLookUp(LEXICON, flow());
  assert.ok(!asked.includes('.'), 'a full stop needs no dictionary');
  assert.ok(!asked.includes('42'));
  assert.deepEqual(asked, ['the', 'walk', 'lamp', 'quietly'], 'and the commonest are asked first');
});

test('a word already answered is not asked again, unless it is meant to be', () => {
  const answered = flow({ meanings: { walk: meaning('verb', 'To move on foot.') } });
  assert.ok(!wordsToLookUp(LEXICON, answered).includes('walk'));

  const refresh = flow({
    meanings: answered.meanings,
    options: { ...DEFAULT_DICTIONARY_OPTIONS, refresh: true },
  });
  assert.ok(wordsToLookUp(LEXICON, refresh).includes('walk'), 'refresh asks the lot again');
});

test('the rare tail can be left out, which is most of a database', () => {
  const lean = flow({ options: { ...DEFAULT_DICTIONARY_OPTIONS, minFrequency: 0.3 } });
  assert.deepEqual(wordsToLookUp(LEXICON, lean), ['the', 'walk', 'lamp'], 'quietly at 0.05 is below the floor');
});

/* ---------------- what an answer does to a word ---------------- */

test('a changed type brings the right variations with it', () => {
  const noun = word('walk', 'noun');
  const asVerb = applyMeaning(noun, meaning('verb', 'To move on foot.'), DEFAULT_DICTIONARY_OPTIONS);

  assert.equal(asVerb.type, 'verb');
  assert.equal(asVerb.description, 'To move on foot.');
  assert.deepEqual(
    Object.keys(asVerb.variations ?? {}).sort(),
    ['infinitive', 'past', 'past_participle', 'present_progressive', 'third_person_singular'],
    'the forms are worked out again for the type it now is, not carried over',
  );
  assert.equal(asVerb.variations?.past, 'walked');
});

test('a word whose type did not change keeps the variations it had', () => {
  const lamp = { ...word('lamp', 'noun'), variations: { singular: 'lamp', plural: 'lamps' } };
  const same = applyMeaning(lamp, meaning('noun', 'A source of light.'), DEFAULT_DICTIONARY_OPTIONS);
  assert.equal(same.variations, lamp.variations, 'nothing is recomputed for no reason');
});

test('overwriting can be turned off for types, descriptions, or both', () => {
  const lamp = word('lamp', 'noun', 0.4, 'What I wrote about it myself.');
  const answer = meaning('verb', 'From the dictionary.');

  const keepType = applyMeaning(lamp, answer, { ...DEFAULT_DICTIONARY_OPTIONS, overwriteTypes: false });
  assert.equal(keepType.type, 'noun', 'the database keeps the type it had');
  assert.equal(keepType.description, 'From the dictionary.');

  const keepDescription = applyMeaning(lamp, answer, {
    ...DEFAULT_DICTIONARY_OPTIONS,
    overwriteDescriptions: false,
  });
  assert.equal(keepDescription.type, 'verb');
  assert.equal(keepDescription.description, 'What I wrote about it myself.');

  const keepBoth = applyMeaning(lamp, answer, {
    ...DEFAULT_DICTIONARY_OPTIONS,
    overwriteTypes: false,
    overwriteDescriptions: false,
  });
  assert.equal(keepBoth, lamp, 'and with neither, the word comes back untouched');
});

test('a word with no answer is left exactly as it was', () => {
  const lamp = word('lamp', 'noun');
  assert.equal(applyMeaning(lamp, undefined, DEFAULT_DICTIONARY_OPTIONS), lamp);
});

test('an empty definition does not wipe one the database already had', () => {
  const lamp = word('lamp', 'noun', 0.4, 'Something worth keeping.');
  const blank = applyMeaning(lamp, meaning('noun', '   '), DEFAULT_DICTIONARY_OPTIONS);
  assert.equal(blank.description, 'Something worth keeping.');
});

/* ---------------- what it does to a whole database ---------------- */

test('applying to a database says what it changed', () => {
  const data = flow({
    meanings: {
      walk: meaning('verb', 'To move on foot.'),
      quietly: meaning('adverb', 'In a quiet manner.'),
      the: meaning('determiner', 'Denoting a particular thing.'),
    },
  });
  const result = applyMeaningsToLexicon(LEXICON, data);

  assert.equal(result.retyped, 2, 'walk became a verb and quietly an adverb');
  assert.equal(result.described, 3);
  assert.equal(result.lexicon.lexemes.find((lexeme) => lexeme.spelling === 'walk')!.type, 'verb');
  assert.equal(result.lexicon.lexemes.length, LEXICON.lexemes.length, 'nothing is added or dropped');
  assert.equal(LEXICON.lexemes[1]!.type, 'noun', 'and the database going in is not modified');
});

test('the count of what is still unanswered ignores marks and numbers', () => {
  const result = applyMeaningsToLexicon(LEXICON, flow({ meanings: { walk: meaning('verb', 'x') } }));
  assert.equal(result.answered, 1);
  assert.equal(result.unanswered, 3, 'the, lamp and quietly — not the full stop or the number');
});

test('a guessed answer is not counted as an answer', () => {
  const guessed = flow({ meanings: { lamp: meaning('noun', '', 'inferred') } });
  const result = applyMeaningsToLexicon(LEXICON, guessed);
  assert.equal(result.answered, 0, 'a guess is what we had before we asked');

  const summary = summariseDictionary(guessed);
  assert.equal(summary.known, 1);
  assert.equal(summary.fromDictionary, 0);
  assert.equal(summary.guessed, 1);
});

test('a new flow knows nothing and follows the studio', () => {
  const data = emptyDictionaryFlowData();
  assert.deepEqual(data.meanings, {});
  assert.equal(data.providerId, '', 'no service of its own until one is picked');
  assert.deepEqual(data.options, DEFAULT_DICTIONARY_OPTIONS);
});
