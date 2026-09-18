/**
 * TEMPORARY — tests for the Random Text flow's type/variant debug view.
 * Delete alongside `src/text/tokenGloss.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formOfLexeme, variationsOf } from '../src/text/lexicon';
import { glossToken, glossTokens, summariseGloss } from '../src/text/tokenGloss';
import { tokenize } from '../src/text/tokenize';
import { buildLexiconIndex } from '../src/text/lexicon';
import { inflect } from '../src/text/inflect';
import type { Lexeme, Lexicon, WordType } from '../src/types/text';

function word(spelling: string, type: WordType): Lexeme {
  const variations = inflect(spelling, type);
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
    word('cats', 'noun'),
    word('lamp', 'noun'),
    word('walked', 'verb'),
    word('old', 'adjective'),
    word('on', 'preposition'),
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
});

test('unknown words are counted separately from words that simply do not inflect', () => {
  const summary = summariseGloss(gloss('The flywheel turns.'));
  assert.equal(summary.unknown, 2, 'flywheel and turns are both absent from this database');
  assert.equal(summary.withoutVariants, 1, 'the');
});

/* ---------------- the helpers underneath, which are not temporary ---------------- */

test('a lexeme without stored variations still reports its forms', () => {
  const bare: Lexeme = {
    id: 'lex_bare',
    spelling: 'dogs',
    type: 'noun',
    frequency: 0.3,
    description: '',
    contexts: [],
  };
  assert.deepEqual(variationsOf(bare), { singular: 'dog', plural: 'dogs' }, 'worked out on the spot');
  assert.equal(formOfLexeme(bare), 'plural');
});

test('a type that does not inflect reports nothing rather than an empty set', () => {
  assert.equal(variationsOf(word('the', 'determiner')), undefined);
  assert.equal(formOfLexeme(word('the', 'determiner')), undefined);
});

test('glossing one token at a time gives the same answer as glossing them all', () => {
  const index = buildLexiconIndex(LEXICON);
  const tokens = tokenize('The cats walked.');
  assert.deepEqual(
    tokens.map((token) => glossToken(token, index)),
    glossTokens(tokens, LEXICON),
  );
});
