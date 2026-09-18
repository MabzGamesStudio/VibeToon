/**
 * TEMPORARY — tests for the Random Text flow's type/variant debug view.
 * Delete alongside `src/text/tokenGloss.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLexiconIndex, formOfLexeme, formsState, variationsOf } from '../src/text/lexicon';
import { glossToken, glossTokens, summariseGloss } from '../src/text/tokenGloss';
import { tokenize } from '../src/text/tokenize';
import type { Lexeme, Lexicon, WordType } from '../src/types/text';

/**
 * Forms are written out rather than derived, because that is now the only way
 * they ever arrive: a morphology dataset supplies them and they are stored on the
 * entry. Nothing in this package works them out from a spelling.
 */
function word(spelling: string, type: WordType, variations?: Record<string, string>): Lexeme {
  return {
    id: `lex_${spelling}`,
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
    word('cats', 'noun', { singular: 'cat', plural: 'cats' }),
    word('lamp', 'noun', { singular: 'lamp', plural: 'lamps' }),
    word('walked', 'verb', {
      infinitive: 'walk',
      third_person_singular: 'walks',
      present_progressive: 'walking',
      past: 'walked',
      past_participle: 'walked',
    }),
    word('old', 'adjective', { positive: 'old', comparative: 'older', superlative: 'oldest' }),
    word('on', 'preposition'),
    // In the database, but nobody has asked a dictionary about it.
    word('turns', 'unknown'),
    // A noun whose forms the dataset had nothing for. Not the same as `the`.
    word('quern', 'noun'),
    { id: 'lex_stop', spelling: '.', type: 'punctuation', frequency: 0.9, description: '', contexts: [] },
  ],
};

function gloss(text: string) {
  return glossTokens(tokenize(text), LEXICON);
}

/* ---------------- what a word turns into ---------------- */

test('a word becomes its type and the form its spelling is', () => {
  assert.equal(gloss('cats')[0]!.label, 'noun:plural', 'cats is a plural noun');
  assert.equal(gloss('lamp')[0]!.label, 'noun:singular');
  assert.equal(gloss('walked')[0]!.label, 'verb:past');
  assert.equal(gloss('old')[0]!.label, 'adjective:positive');
});

test('a word whose type has no forms is just its type', () => {
  const determiner = gloss('the')[0]!;
  assert.equal(determiner.label, 'determiner');
  assert.equal(determiner.hasVariants, false, 'and it says so, which is the point of the view');

  assert.equal(gloss('on')[0]!.hasVariants, false);
  assert.equal(gloss('cats')[0]!.hasVariants, true);
});

test('punctuation is shown as the mark it is', () => {
  const stop = gloss('lamp.')[1]!;
  assert.equal(stop.label, 'punctuation:.');
  assert.equal(stop.hasVariants, false);
  assert.equal(stop.unknown, false);
});

test('a word the database has never seen is marked, not guessed at', () => {
  const unknown = gloss('flywheel')[0]!;
  assert.equal(unknown.label, '?:flywheel', 'the word itself is kept so it can be recognised');
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.hasVariants, false);
});

/**
 * Three quite different reasons a word shows no forms, and the view has to tell
 * them apart or it is useless: the type has none, the type was never established,
 * or the dataset was asked and had nothing.
 */
test('a word nobody has looked up is distinguished from one that does not inflect', () => {
  const notLookedUp = gloss('turns')[0]!;
  assert.equal(notLookedUp.label, 'unknown');
  assert.equal(notLookedUp.notLookedUp, true);
  assert.equal(notLookedUp.unknown, false, 'it is in the database — it just has no type yet');
  assert.equal(notLookedUp.hasVariants, false);

  const determiner = gloss('the')[0]!;
  assert.equal(determiner.notLookedUp, false);
  assert.equal(determiner.formsMissing, false, 'a determiner is not missing anything');
});

test('a word whose forms the dataset had none of says so', () => {
  const missing = gloss('quern')[0]!;
  assert.equal(missing.label, 'noun', 'the type is known; only the forms are not');
  assert.equal(missing.formsMissing, true);
  assert.equal(missing.hasVariants, false);
  assert.equal(missing.notLookedUp, false);
});

test('a line break survives as a line break', () => {
  const glosses = gloss('lamp\n\ncats');
  assert.ok(glosses.some((item) => item.label.includes('\n')), 'so the shape of the text is still readable');
});

test('the gloss carries the whole form set, for a tooltip', () => {
  const cats = gloss('cats')[0]!;
  assert.deepEqual(cats.variations, { singular: 'cat', plural: 'cats' });
  assert.equal(cats.form, 'plural');
  assert.equal(cats.type, 'noun');
  assert.equal(gloss('the')[0]!.variations, undefined);
});

/* ---------------- the count under the view ---------------- */

test('the summary says how many words have variants at all', () => {
  const summary = summariseGloss(gloss('The cats walked on the old lamp.'));

  assert.equal(summary.words, 7, 'seven words; the full stop is not one');
  assert.equal(summary.withVariants, 4, 'cats, walked, old, lamp');
  assert.equal(summary.withoutVariants, 3, 'the, on, the');
  assert.equal(summary.unknown, 0);
  assert.equal(summary.notLookedUp, 0);
  assert.equal(summary.formsMissing, 0);
});

test('unknown words are counted separately from words that simply do not inflect', () => {
  const summary = summariseGloss(gloss('The flywheel spins.'));
  assert.equal(summary.unknown, 2, 'flywheel and spins are both absent from this database');
  assert.equal(summary.withoutVariants, 1, 'the');
});

test('the summary separates the three reasons a word shows no forms', () => {
  const summary = summariseGloss(gloss('The turns quern on flywheel.'));
  assert.equal(summary.withoutVariants, 2, 'the and on have no forms because their types have none');
  assert.equal(summary.notLookedUp, 1, 'turns');
  assert.equal(summary.formsMissing, 1, 'quern');
  assert.equal(summary.unknown, 1, 'flywheel');
  assert.equal(summary.withVariants, 0);
});

/* ---------------- the helpers underneath, which are not temporary ---------------- */

test('forms are read off the entry and never worked out from the spelling', () => {
  const bare: Lexeme = {
    id: 'lex_bare',
    spelling: 'dogs',
    type: 'noun',
    frequency: 0.3,
    description: '',
    contexts: [],
  };
  assert.equal(variationsOf(bare), undefined, 'a noun with no stored forms has none to show');
  assert.equal(formOfLexeme(bare), undefined);
  assert.equal(
    formsState(bare),
    'not-looked-up',
    'and the reason is that nothing has supplied them, not that nouns lack forms',
  );
});

test('a type that does not inflect reports nothing, for a different reason', () => {
  const determiner = word('the', 'determiner');
  assert.equal(variationsOf(determiner), undefined);
  assert.equal(formOfLexeme(determiner), undefined);
  assert.equal(formsState(determiner), 'does-not-inflect');
});

test('an entry that names its own form is believed over a search of the set', () => {
  const stated = word('walked', 'verb', { past: 'walked', past_participle: 'walked' });
  assert.equal(formOfLexeme(stated), 'past', 'the first match, when nothing says otherwise');
  assert.equal(formOfLexeme({ ...stated, form: 'past_participle' }), 'past_participle');
});

test('glossing one token at a time gives the same answer as glossing them all', () => {
  const index = buildLexiconIndex(LEXICON);
  const tokens = tokenize('The cats walked.');
  assert.deepEqual(
    tokens.map((token) => glossToken(token, index)),
    glossTokens(tokens, LEXICON),
  );
});
