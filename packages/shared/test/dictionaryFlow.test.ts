import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DICTIONARY_OPTIONS,
  applySense,
  applyMeaningsToLexicon,
  emptyDictionaryFlowData,
  summariseDictionary,
  wordsToLookUp,
  type DictionaryFlowData,
} from '../src/flows/dictionary';
import { lexemeIdFor, type WordMeaning, type WordSense } from '../src/text/senses';
import type { Lexeme, Lexicon, WordType } from '../src/types/text';

function word(spelling: string, type: WordType, frequency = 0.5, description = ''): Lexeme {
  return { id: lexemeIdFor(spelling), spelling, type, frequency, description, contexts: [] };
}

/** One sense, as a dataset and a dictionary between them would supply it. */
function sense(type: WordType, description: string, variations?: Record<string, string>): WordSense {
  return { type, description, ...(variations ? { variations } : {}) };
}

function meaning(...senses: WordSense[]): WordMeaning {
  return { senses, source: 'dictionary' };
}

/** The forms of `walk`, as AGID gives them. Nothing here derives them. */
const WALK_FORMS = {
  infinitive: 'walk',
  third_person_singular: 'walks',
  present_progressive: 'walking',
  past: 'walked',
  past_participle: 'walked',
};

function flow(over: Partial<DictionaryFlowData> = {}): DictionaryFlowData {
  return { ...emptyDictionaryFlowData(), ...over };
}

/** No forms and no senses, so a test can say which of those it is about. */
function bare(over: Partial<DictionaryFlowData> = {}): DictionaryFlowData {
  return flow({
    ...over,
    options: { ...DEFAULT_DICTIONARY_OPTIONS, addVariants: false, ...over.options },
  });
}

const LEXICON: Lexicon = {
  lexemes: [
    word('the', 'unknown', 1),
    word('walk', 'unknown', 0.6),
    word('lamp', 'unknown', 0.4),
    word('quietly', 'unknown', 0.05),
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
  const answered = flow({ meanings: { walk: meaning(sense('verb', 'To move on foot.')) } });
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

test('a spelling that is already several entries is asked about once', () => {
  const split: Lexicon = {
    lexemes: [word('light', 'noun', 0.5), { ...word('light', 'verb', 0.5), id: 'lex_light~verb' }],
  };
  assert.deepEqual(wordsToLookUp(split, flow()), ['light']);
});

test('a row that is a form of another word is never asked about', () => {
  const withForm: Lexicon = {
    lexemes: [
      word('walk', 'verb', 0.6),
      { ...word('walked', 'verb', 0), variantOf: lexemeIdFor('walk'), form: 'past' },
    ],
  };
  const asked = wordsToLookUp(withForm, flow());
  assert.deepEqual(asked, ['walk'], 'its type and description came with it from the word it is a form of');
});

/* ---------------- what an answer does to one word ---------------- */

test('a changed type brings the right forms with it, and drops the wrong ones', () => {
  const noun = { ...word('walk', 'noun'), variations: { singular: 'walk', plural: 'walks' } };
  const asVerb = applySense(noun, sense('verb', 'To move on foot.', WALK_FORMS), DEFAULT_DICTIONARY_OPTIONS);

  assert.equal(asVerb.type, 'verb');
  assert.equal(asVerb.description, 'To move on foot.');
  assert.deepEqual(asVerb.variations, WALK_FORMS, 'the verb paradigm, from the dataset');
  assert.equal(asVerb.variations?.past, 'walked');
});

test('a retype the answer has no forms for leaves the word with none, not the old ones', () => {
  const noun = { ...word('walk', 'noun'), variations: { singular: 'walk', plural: 'walks' } };
  const asVerb = applySense(noun, sense('verb', 'To move on foot.'), DEFAULT_DICTIONARY_OPTIONS);
  assert.equal(asVerb.type, 'verb');
  assert.equal(
    asVerb.variations,
    undefined,
    'a noun’s singular and plural are not a verb’s five tenses',
  );
});

test('a word whose type did not change keeps the forms the answer carries', () => {
  const lamp = word('lamp', 'noun');
  const forms = { singular: 'lamp', plural: 'lamps' };
  const same = applySense(lamp, sense('noun', 'A source of light.', forms), DEFAULT_DICTIONARY_OPTIONS);
  assert.deepEqual(same.variations, forms);
});

test('overwriting can be turned off for types, descriptions, or both', () => {
  const lamp = word('lamp', 'noun', 0.4, 'What I wrote about it myself.');
  const answer = sense('verb', 'From the dictionary.');

  const keepType = applySense(lamp, answer, { ...DEFAULT_DICTIONARY_OPTIONS, overwriteTypes: false });
  assert.equal(keepType.type, 'noun', 'the database keeps the type it had');
  assert.equal(keepType.description, 'From the dictionary.');

  const keepDescription = applySense(lamp, answer, {
    ...DEFAULT_DICTIONARY_OPTIONS,
    overwriteDescriptions: false,
  });
  assert.equal(keepDescription.type, 'verb');
  assert.equal(keepDescription.description, 'What I wrote about it myself.');

  const keepBoth = applySense(lamp, answer, {
    ...DEFAULT_DICTIONARY_OPTIONS,
    overwriteTypes: false,
    overwriteDescriptions: false,
  });
  assert.equal(keepBoth.type, 'noun');
  assert.equal(keepBoth.description, 'What I wrote about it myself.');
});

test('an empty definition does not wipe one the database already had', () => {
  const lamp = word('lamp', 'noun', 0.4, 'Something worth keeping.');
  const blank = applySense(lamp, sense('noun', '   '), DEFAULT_DICTIONARY_OPTIONS);
  assert.equal(blank.description, 'Something worth keeping.');
});

/* ---------------- a spelling with more than one meaning ---------------- */

test('a spelling with several meanings becomes several entries', () => {
  const data = bare({
    meanings: {
      light: meaning(
        sense('noun', 'What lets you see.'),
        sense('verb', 'To set burning.'),
        sense('adjective', 'Not heavy.'),
      ),
    },
  });
  const result = applyMeaningsToLexicon({ lexemes: [word('light', 'unknown', 0.7)] }, data);
  const rows = result.lexicon.lexemes;

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.type), ['noun', 'verb', 'adjective']);
  assert.equal(result.split, 2, 'two entries beyond the one that came in');
  assert.equal(rows[0]!.id, lexemeIdFor('light'), 'the first keeps the id the context links point at');
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  assert.deepEqual(
    rows.map((row) => row.frequency),
    [0.7, 0.7, 0.7],
    'the counting could not tell the senses apart, and does not pretend to have',
  );
});

test('applying twice does not split a spelling twice', () => {
  const data = bare({
    meanings: { light: meaning(sense('noun', 'What lets you see.'), sense('verb', 'To set burning.')) },
  });
  const once = applyMeaningsToLexicon({ lexemes: [word('light', 'unknown', 0.7)] }, data);
  const twice = applyMeaningsToLexicon(once.lexicon, data);

  assert.equal(twice.lexicon.lexemes.length, 2, 'the rows it made last time are the rows it fills in now');
  assert.equal(twice.split, 0);
  assert.deepEqual(
    twice.lexicon.lexemes.map((row) => row.id),
    once.lexicon.lexemes.map((row) => row.id),
    'and the ids are stable, so nothing pointing at them breaks',
  );
});

/**
 * The answers are keyed by spelling, and a spelling an earlier run already split
 * has several rows. Applying the answer once per row wrote the row for `watches`
 * the verb out twice, with the same id both times — which React then refuses to
 * render, and which makes the ids stop being ids.
 */
test('a spelling that is already split is applied to once, not once per row', () => {
  const already: Lexicon = {
    lexemes: [
      { ...word('watches', 'verb', 0.5, 'Looks at for a while.') },
      { ...word('watches', 'noun', 0.5, 'Things worn to tell the time.'), id: 'lex_watches~noun' },
    ],
  };
  // The dictionary only reports the verb this time.
  const data = bare({ meanings: { watches: meaning(sense('verb', 'From the dictionary.')) } });
  const result = applyMeaningsToLexicon(already, data);
  const ids = result.lexicon.lexemes.map((row) => row.id);

  assert.equal(new Set(ids).size, ids.length, 'every id is used once');
  assert.equal(result.lexicon.lexemes.length, 2, 'two rows in, two rows out');
  assert.equal(result.split, 0, 'and nothing was split that was already split');

  const verb = result.lexicon.lexemes.find((row) => row.type === 'verb')!;
  assert.equal(verb.description, 'From the dictionary.');
  const noun = result.lexicon.lexemes.find((row) => row.type === 'noun')!;
  assert.equal(
    noun.description,
    'Things worn to tell the time.',
    'and the sense the answer did not mention is left alone rather than dropped',
  );
});

test('a whole database keeps its ids unique through a run', () => {
  // Two spellings already split, two forms already derived, one word answered.
  const messy: Lexicon = {
    lexemes: [
      word('light', 'noun', 0.7, 'What lets you see.'),
      { ...word('light', 'verb', 0.7, 'To set burning.'), id: 'lex_light~verb' },
      { ...word('lights', 'noun', 0), id: 'lex_lights', variantOf: lexemeIdFor('light'), form: 'plural' },
      word('walk', 'unknown', 0.6),
      word('walks', 'unknown', 0.3),
    ],
  };
  const data = flow({
    meanings: {
      light: meaning(
        sense('noun', 'What lets you see.', { singular: 'light', plural: 'lights' }),
        sense('verb', 'To set burning.', { infinitive: 'light', past: 'lit', past_participle: 'lit' }),
      ),
      walk: meaning(sense('verb', 'To move on foot.', WALK_FORMS)),
    },
  });
  const ids = applyMeaningsToLexicon(messy, data).lexicon.lexemes.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `${ids.length} rows, ${new Set(ids).size} distinct ids`);
});

test('splitting can be turned off, and then only the first meaning is kept', () => {
  const data = bare({
    meanings: { light: meaning(sense('noun', 'What lets you see.'), sense('verb', 'To set burning.')) },
    options: { ...DEFAULT_DICTIONARY_OPTIONS, addVariants: false, splitSenses: false },
  });
  const result = applyMeaningsToLexicon({ lexemes: [word('light', 'unknown', 0.7)] }, data);
  assert.equal(result.lexicon.lexemes.length, 1);
  assert.equal(result.lexicon.lexemes[0]!.type, 'noun');
  assert.equal(result.split, 0);
});

/* ---------------- a row per form ---------------- */

test('every form of a word gets an entry of its own', () => {
  const data = flow({ meanings: { walk: meaning(sense('verb', 'To move on foot.', WALK_FORMS)) } });
  const result = applyMeaningsToLexicon({ lexemes: [word('walk', 'unknown', 0.6)] }, data);
  const bySpelling = new Map(result.lexicon.lexemes.map((row) => [row.spelling, row]));

  // Four rows, not five: `walked` is both the past and the past participle.
  assert.equal(result.variants, 3, 'walks, walking and walked');
  assert.deepEqual([...bySpelling.keys()].sort(), ['walk', 'walked', 'walking', 'walks']);

  const walking = bySpelling.get('walking')!;
  assert.equal(walking.type, 'verb', 'sharing the type of the word it is a form of');
  assert.equal(walking.description, 'To move on foot.', 'and its description');
  assert.equal(walking.form, 'present_progressive');
  assert.equal(walking.variantOf, lexemeIdFor('walk'));
  assert.deepEqual(walking.variations, WALK_FORMS, 'it knows the whole family it belongs to');
  assert.equal(walking.frequency, 0, 'the corpus never contained it, and it does not claim otherwise');
  assert.equal(walking.stats?.count, 0);
});

test('a form the corpus did count keeps its own count and links', () => {
  const counted: Lexicon = {
    lexemes: [
      word('walk', 'unknown', 0.6),
      { ...word('walked', 'unknown', 0.5), contexts: [{ id: lexemeIdFor('the'), weight: 0.4 }] },
    ],
  };
  const data = flow({ meanings: { walk: meaning(sense('verb', 'To move on foot.', WALK_FORMS)) } });
  const result = applyMeaningsToLexicon(counted, data);
  const walked = result.lexicon.lexemes.find((row) => row.spelling === 'walked')!;

  assert.equal(walked.frequency, 0.5, 'the only measurement in the database is not overwritten');
  assert.equal(walked.contexts.length, 1);
  assert.equal(walked.stats?.count, undefined, 'and nothing invents one for it');
  assert.deepEqual(walked.variations, WALK_FORMS, 'and it is joined up to its family');
  assert.equal(walked.variantOf, lexemeIdFor('walk'), 'as a form of walk, which is what it is');
  assert.equal(walked.type, 'verb', 'adopted from the word it is a form of, not guessed from the ending');
  assert.equal(walked.form, 'past', 'the first form that named it; it is also the past participle');
  assert.equal(result.linkedVariants, 1, 'one row joined up, not one per form that names it');

  // And the whole family is present exactly once each.
  assert.deepEqual(
    result.lexicon.lexemes.map((row) => row.spelling).sort(),
    ['walk', 'walked', 'walking', 'walks'],
  );
});

test('forms can be turned off without losing the spelling they enable', () => {
  const data = bare({ meanings: { walk: meaning(sense('verb', 'To move on foot.', WALK_FORMS)) } });
  const result = applyMeaningsToLexicon({ lexemes: [word('walk', 'unknown', 0.6)] }, data);

  assert.equal(result.lexicon.lexemes.length, 1);
  assert.equal(result.variants, 0);
  assert.deepEqual(
    result.lexicon.lexemes[0]!.variations,
    WALK_FORMS,
    'the forms are still on the word, so a grammar slot can still be spelled',
  );
});

test('a form of one sense does not become a row under another sense’s type', () => {
  const data = flow({
    meanings: {
      light: meaning(
        sense('noun', 'What lets you see.', { singular: 'light', plural: 'lights' }),
        sense('verb', 'To set burning.', { infinitive: 'light', past: 'lit', past_participle: 'lit' }),
      ),
    },
  });
  const result = applyMeaningsToLexicon({ lexemes: [word('light', 'unknown', 0.7)] }, data);
  const rows = result.lexicon.lexemes;

  const lights = rows.find((row) => row.spelling === 'lights')!;
  const lit = rows.find((row) => row.spelling === 'lit')!;
  assert.equal(lights.type, 'noun', 'the plural belongs to the noun');
  assert.equal(lit.type, 'verb', 'and the past to the verb');
});

/* ---------------- what it does to a whole database ---------------- */

test('applying to a database says what it changed', () => {
  const data = bare({
    meanings: {
      walk: meaning(sense('verb', 'To move on foot.')),
      quietly: meaning(sense('adverb', 'In a quiet manner.')),
      the: meaning(sense('determiner', 'Denoting a particular thing.')),
    },
  });
  const result = applyMeaningsToLexicon(LEXICON, data);

  assert.equal(result.retyped, 3, 'three words went from unknown to a real type');
  assert.equal(result.described, 3);
  assert.equal(result.lexicon.lexemes.find((lexeme) => lexeme.spelling === 'walk')!.type, 'verb');
  assert.equal(result.lexicon.lexemes.length, LEXICON.lexemes.length, 'nothing is added or dropped');
  assert.equal(LEXICON.lexemes[1]!.type, 'unknown', 'and the database going in is not modified');
});

test('a word whose forms no dataset had is counted, not quietly ignored', () => {
  const data = bare({ meanings: { lamp: meaning(sense('noun', 'A source of light.')) } });
  const result = applyMeaningsToLexicon({ lexemes: [word('lamp', 'unknown', 0.4)] }, data);
  assert.equal(result.formless, 1, 'a noun ought to have a plural, and this one has none');

  const withForms = bare({
    meanings: { lamp: meaning(sense('noun', 'A source of light.', { singular: 'lamp', plural: 'lamps' })) },
  });
  assert.equal(applyMeaningsToLexicon({ lexemes: [word('lamp', 'unknown', 0.4)] }, withForms).formless, 0);
});

test('the count of what is still unanswered ignores marks and numbers', () => {
  const result = applyMeaningsToLexicon(LEXICON, bare({ meanings: { walk: meaning(sense('verb', 'x')) } }));
  assert.equal(result.answered, 1);
  assert.equal(result.unanswered, 3, 'the, lamp and quietly — not the full stop or the number');
});

test('a word the dictionary had no entry for is not counted as an answer', () => {
  const absent = bare({ meanings: { lamp: { senses: [], source: 'none' as const } } });
  const result = applyMeaningsToLexicon(LEXICON, absent);
  assert.equal(result.answered, 0, 'being told “no entry” is not being told what the word is');
  assert.equal(
    result.lexicon.lexemes.find((lexeme) => lexeme.spelling === 'lamp')!.type,
    'unknown',
    'and it stays unknown rather than being guessed at',
  );

  const summary = summariseDictionary(absent);
  assert.equal(summary.known, 1);
  assert.equal(summary.fromDictionary, 0);
  assert.equal(summary.absent, 1);
});

test('the summary counts senses as well as spellings', () => {
  const data = flow({
    meanings: {
      light: meaning(
        sense('noun', 'What lets you see.', { singular: 'light', plural: 'lights' }),
        sense('verb', 'To set burning.'),
      ),
      lamp: meaning(sense('noun', 'A source of light.')),
    },
  });
  const summary = summariseDictionary(data);

  assert.equal(summary.known, 2, 'two spellings');
  assert.equal(summary.senses, 3, 'three senses between them');
  assert.equal(summary.multiSense, 1, 'only light has more than one');
  assert.equal(summary.withForms, 1, 'and only light has any forms');
});

test('a new flow knows nothing and follows the studio', () => {
  const data = emptyDictionaryFlowData();
  assert.deepEqual(data.meanings, {});
  assert.equal(data.providerId, '', 'no service of its own until one is picked');
  assert.equal(data.morphologyId, '', 'nor a forms dataset');
  assert.deepEqual(data.options, DEFAULT_DICTIONARY_OPTIONS);
});
