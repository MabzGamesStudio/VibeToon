import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLengthRule, applyRulesToOptions, emptyTextData, resolveTextRun } from '../src/flows/text';
import { defaultRulesForConnection } from '../src/project/factory';
import { parseRules } from '../src/rules/parseRules';
import { createRng, runRandomText } from '../src/text/generate';
import { buildLexiconIndex, lexiconStats, mergeLexicons } from '../src/text/lexicon';
import { starterLexicon } from '../src/flows/lexicon';
import { countWordTokens, renderTokens, tokenize } from '../src/text/tokenize';
import { DEFAULT_RANDOM_TEXT_OPTIONS, type Lexicon, type RandomTextOptions } from '../src/types/text';

const LEXICON = starterLexicon();

function options(overrides: Partial<RandomTextOptions> = {}): RandomTextOptions {
  return {
    ...DEFAULT_RANDOM_TEXT_OPTIONS,
    ...overrides,
    length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, ...(overrides.length ?? {}) },
  };
}

/* ---------------- tokenizer ---------------- */

test('text survives a round trip through tokens', () => {
  const source =
    "Mabz drags the lamp round, hard. It didn't work yesterday, and the well-known gear turned 3 times.";
  assert.equal(renderTokens(tokenize(source)), source);
});

test('punctuation, contractions and numbers are separate token kinds', () => {
  const tokens = tokenize("It's 42, isn't it?");
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.text}`),
    ['word:It’s'.replace('’', "'"), 'number:42', 'punctuation:,', "word:isn't", 'word:it', 'punctuation:?'],
  );
});

test('sentences are capitalised when rendered', () => {
  const tokens = tokenize('the lamp ticks . the gear stops .');
  assert.equal(renderTokens(tokens), 'The lamp ticks. The gear stops.');
});

/* ---------------- the starter database ---------------- */

test('the starter database is counted out of the sample corpus and holds together', () => {
  const stats = lexiconStats(LEXICON);
  assert.deepEqual(stats.duplicateIds, [], 'ids are unique');
  assert.deepEqual(stats.danglingRefs, [], 'every context points at a word that is present');
  assert.ok(stats.total > 120, `${stats.total} words is enough to write with`);
  assert.ok(stats.contextEdges > 200, `${stats.contextEdges} links`);

  const index = buildLexiconIndex(LEXICON);
  assert.ok(index.bySpelling.has('.'), 'punctuation is counted as a token of its own');
  assert.ok(
    LEXICON.lexemes.every((lexeme) => (lexeme.stats?.count ?? 0) > 0),
    'every entry carries the count it came from',
  );
  const commonest = [...LEXICON.lexemes].sort((a, b) => b.frequency - a.frequency)[0]!;
  assert.equal(commonest.spelling, 'the', 'and frequency follows the corpus');
});

/* ---------------- determinism ---------------- */

test('the same seed always writes the same text', () => {
  const run = () => runRandomText({ input: '', lexicon: LEXICON, options: options({ seed: 'rain' }) }).text;
  assert.equal(run(), run());
});

test('a different seed writes different text', () => {
  const a = runRandomText({ input: '', lexicon: LEXICON, options: options({ seed: 'rain' }) }).text;
  const b = runRandomText({ input: '', lexicon: LEXICON, options: options({ seed: 'gear' }) }).text;
  assert.notEqual(a, b);
});

test('the seeded generator is stable and spread out', () => {
  const rng = createRng('vibetoon');
  const draws = Array.from({ length: 500 }, () => rng());
  assert.ok(draws.every((value) => value >= 0 && value < 1));
  const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
  assert.equal(createRng('vibetoon')(), draws[0]);
});

/* ---------------- length ---------------- */

test('a word count target is hit inside its tolerance', () => {
  for (const seed of ['a', 'b', 'c', 'd']) {
    const result = runRandomText({
      input: '',
      lexicon: LEXICON,
      options: options({ seed, length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 60, temperature: 0.2 } }),
    });
    const plan = result.stats.plan!;
    assert.ok(
      Math.abs(result.stats.outputWords - plan.target) <= plan.tolerance,
      `seed ${seed}: ${result.stats.outputWords} words against ${plan.target} ±${plan.tolerance}`,
    );
  }
});

test('zero length temperature lands on the number exactly', () => {
  const result = runRandomText({
    input: '',
    lexicon: LEXICON,
    options: options({ seed: 'exact', length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 32, temperature: 0 } }),
  });
  assert.equal(result.stats.outputWords, 32);
  assert.equal(result.stats.onTarget, true);
});

test('a character count target is hit inside its tolerance', () => {
  const result = runRandomText({
    input: '',
    lexicon: LEXICON,
    options: options({
      seed: 'chars',
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'characters', characters: 300, temperature: 0.15 },
    }),
  });
  const plan = result.stats.plan!;
  assert.equal(plan.metric, 'characters');
  assert.ok(
    Math.abs(result.stats.outputCharacters - 300) <= plan.tolerance,
    `${result.stats.outputCharacters} characters against 300 ±${plan.tolerance}`,
  );
});

const INPUT =
  'Mabz drags the lamp round to point at a small brass machine. The gear turns half a tooth and stops. It did it yesterday, twice.';

test('a percentage grows and shrinks the text it is given', () => {
  const grown = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({
      mode: 'alter',
      seed: 'grow',
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'wordPercent', wordPercent: 50, temperature: 0.1 },
    }),
  });
  assert.ok(grown.stats.outputWords > grown.stats.inputWords * 1.3, `${grown.stats.outputWords} words`);
  assert.ok(grown.stats.added > 0);

  const shrunk = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({
      mode: 'alter',
      seed: 'shrink',
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'wordPercent', wordPercent: -40, temperature: 0.1 },
    }),
  });
  assert.ok(shrunk.stats.outputWords < shrunk.stats.inputWords * 0.75, `${shrunk.stats.outputWords} words`);
  assert.ok(shrunk.stats.removed > 0);
});

test('a character percentage works on characters', () => {
  const result = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({
      mode: 'alter',
      seed: 'cp',
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'charPercent', charPercent: -30, temperature: 0.1 },
    }),
  });
  assert.equal(result.stats.plan?.metric, 'characters');
  assert.ok(result.stats.outputCharacters < result.stats.inputCharacters * 0.8);
});

test('keeping the length leaves the word count alone', () => {
  const result = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({ mode: 'alter', seed: 'keep', length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'keep' } }),
  });
  assert.equal(result.stats.plan, null);
  assert.equal(result.stats.outputWords, result.stats.inputWords);
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 0);
});

/* ---------------- altering ---------------- */

test('alter temperature decides how much of the text is rewritten', () => {
  const base = { mode: 'keep' as const };
  const none = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({ mode: 'alter', seed: 'x', alterTemperature: 0, length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, ...base } }),
  });
  assert.equal(none.text, INPUT, 'nothing changes at zero');
  assert.equal(none.stats.replaced, 0);

  const words = countWordTokens(tokenize(INPUT));
  const some = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({ mode: 'alter', seed: 'x', alterTemperature: 0.5, length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, ...base } }),
  });
  const most = runRandomText({
    input: INPUT,
    lexicon: LEXICON,
    options: options({ mode: 'alter', seed: 'x', alterTemperature: 1, length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, ...base } }),
  });

  assert.ok(some.stats.replaced > words * 0.25 && some.stats.replaced < words * 0.75, `${some.stats.replaced}/${words}`);
  assert.ok(most.stats.replaced > some.stats.replaced);
  assert.ok(most.stats.replaced > words * 0.8, `${most.stats.replaced}/${words}`);
});

test('altering keeps punctuation and reports words it does not know', () => {
  const result = runRandomText({
    input: 'The quixotic gizmo waits, then stops.',
    lexicon: LEXICON,
    options: options({
      mode: 'alter',
      seed: 'unknown',
      alterTemperature: 0,
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'keep' },
    }),
  });
  // The database holds base forms, so inflections count as unknown too — the
  // report says so rather than pretending to have understood them.
  assert.ok(result.stats.unknownWords.includes('quixotic'));
  assert.ok(result.stats.unknownWords.includes('gizmo'));
  assert.match(result.text, /,/);
  assert.match(result.text, /\.$/);
});

/* ---------------- context ---------------- */

function riggedLexicon(): Lexicon {
  // Three nouns of identical frequency; only the context weights differ.
  return {
    lexemes: [
      { id: 'a', spelling: 'alpha', type: 'noun', frequency: 0.5, description: '', contexts: [{ id: 'b', weight: 1 }] },
      { id: 'b', spelling: 'beta', type: 'noun', frequency: 0.5, description: '', contexts: [] },
      { id: 'c', spelling: 'gamma', type: 'noun', frequency: 0.5, description: '', contexts: [] },
      { id: 'd', spelling: 'delta', type: 'noun', frequency: 0.5, description: '', contexts: [] },
    ],
  };
}

function countFollowing(text: string, word: string, follower: string): { hits: number; total: number } {
  const tokens = tokenize(text).filter((token) => token.kind === 'word');
  let hits = 0;
  let total = 0;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i]!.key !== word) continue;
    total += 1;
    if (tokens[i + 1]!.key === follower) hits += 1;
  }
  return { hits, total };
}

test('a strong context makes that word the likely next one', () => {
  const result = runRandomText({
    input: '',
    lexicon: riggedLexicon(),
    options: options({
      seed: 'ctx',
      grammarBias: 0,
      frequencyBias: 0.2,
      pickTemperature: 0.5,
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 300, temperature: 0 },
    }),
  });
  const { hits, total } = countFollowing(result.text, 'alpha', 'beta');
  assert.ok(total > 20, `alpha appeared ${total} times`);
  assert.ok(hits / total > 0.6, `beta followed alpha ${hits}/${total} times`);
});

test('with no context window the weights stop mattering', () => {
  const result = runRandomText({
    input: '',
    lexicon: riggedLexicon(),
    options: options({
      seed: 'ctx',
      grammarBias: 0,
      frequencyBias: 0.2,
      contextWindow: 0,
      pickTemperature: 1,
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 300, temperature: 0 },
    }),
  });
  const { hits, total } = countFollowing(result.text, 'alpha', 'beta');
  assert.ok(total > 20);
  assert.ok(hits / total < 0.55, `beta followed alpha ${hits}/${total} times, which should be near chance`);
});

test('a wider window lets a word two back still pull', () => {
  const lexicon = riggedLexicon();
  const wide = runRandomText({
    input: '',
    lexicon,
    options: options({
      seed: 'w',
      grammarBias: 0,
      frequencyBias: 0,
      contextWindow: 3,
      contextDecay: 1,
      pickTemperature: 0.6,
      length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 240, temperature: 0 },
    }),
  });
  const tokens = tokenize(wide.text).filter((token) => token.kind === 'word');
  let twoBack = 0;
  let opportunities = 0;
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (tokens[i]!.key !== 'alpha') continue;
    opportunities += 1;
    if (tokens[i + 2]!.key === 'beta') twoBack += 1;
  }
  assert.ok(opportunities > 10);
  assert.ok(twoBack / opportunities > 0.3, `beta two after alpha ${twoBack}/${opportunities}`);
});

/* ---------------- rules and resolution ---------------- */

test('length rules parse every written form', () => {
  const base = DEFAULT_RANDOM_TEXT_OPTIONS;
  assert.equal(applyLengthRule(base, 'keep').length.mode, 'keep');

  const words = applyLengthRule(base, '120 words').length;
  assert.equal(words.mode, 'words');
  assert.equal(words.words, 120);

  const chars = applyLengthRule(base, 'characters 900').length;
  assert.equal(chars.mode, 'characters');
  assert.equal(chars.characters, 900);

  const grow = applyLengthRule(base, '+20%').length;
  assert.equal(grow.mode, 'wordPercent');
  assert.equal(grow.wordPercent, 20);

  const shrinkChars = applyLengthRule(base, '-15% characters').length;
  assert.equal(shrinkChars.mode, 'charPercent');
  assert.equal(shrinkChars.charPercent, -15);
});

test('connection rules override the flow’s own options', () => {
  const next = applyRulesToOptions(
    DEFAULT_RANDOM_TEXT_OPTIONS,
    parseRules('length: +25%\nalter: 0.6\ntemperature: 0.2\ncontext window: 5\nseed: rain\nkeep: the names'),
  );
  assert.equal(next.length.mode, 'wordPercent');
  assert.equal(next.length.wordPercent, 25);
  assert.equal(next.alterTemperature, 0.6);
  assert.equal(next.mode, 'alter', 'saying how much to alter implies altering');
  assert.equal(next.pickTemperature, 0.2);
  assert.equal(next.contextWindow, 5);
  assert.equal(next.seed, 'rain');
  assert.equal(next.sentenceLength, DEFAULT_RANDOM_TEXT_OPTIONS.sentenceLength, 'untouched settings stay');
});

test('a run prefers upstream text and merges every lexicon it is handed', () => {
  const data = emptyTextData();
  data.input = 'local text that should be ignored';
  const extra: Lexicon = {
    lexemes: [
      { id: 'x1', spelling: 'zeppelin', type: 'noun', frequency: 0.2, description: 'A big one.', contexts: [] },
    ],
  };

  const resolved = resolveTextRun(data, [
    { port: 'text', label: 'Dialog → Text', rules: 'alter: 0.4', text: 'upstream text' },
    { port: 'lexicon', label: 'Shared → Word database', rules: '', lexicon: extra },
  ]);

  assert.equal(resolved.input, 'upstream text');
  assert.equal(resolved.options.alterTemperature, 0.4);
  assert.equal(resolved.lexicon.lexemes.length, data.lexicon.lexemes.length + 1);
  assert.ok(resolved.lexicon.lexemes.some((lexeme) => lexeme.spelling === 'zeppelin'));
  assert.ok(resolved.notes.some((note) => /Merged 1 word/.test(note)));
});

test('merging a lexicon keeps local words and unions their contexts', () => {
  const base: Lexicon = {
    lexemes: [
      { id: 'l1', spelling: 'apple', type: 'noun', frequency: 0.4, description: 'Local.', contexts: [{ id: 'l2', weight: 0.5 }] },
      { id: 'l2', spelling: 'tree', type: 'noun', frequency: 0.5, description: '', contexts: [] },
    ],
  };
  const incoming: Lexicon = {
    lexemes: [
      { id: 'r1', spelling: 'apple', type: 'noun', frequency: 0.8, description: 'Incoming.', contexts: [{ id: 'r2', weight: 0.9 }] },
      { id: 'r2', spelling: 'red', type: 'adjective', frequency: 0.5, description: '', contexts: [] },
    ],
  };

  const merged = mergeLexicons(base, incoming);
  assert.equal(merged.lexemes.length, 3, 'apple is matched, red is added');
  const apple = merged.lexemes.find((lexeme) => lexeme.spelling === 'apple')!;
  assert.equal(apple.id, 'l1', 'the local entry keeps its id, so local references still resolve');
  assert.equal(apple.frequency, 0.8);
  assert.equal(apple.contexts.length, 2, 'both context edges survive');
  assert.deepEqual(lexiconStats(merged).danglingRefs, []);
});

test('a new wire is seeded with rules that mean something to the flow it lands on', () => {
  // Dialog → Storyboard: the dialog flow's own suggestion is the right one.
  assert.match(
    defaultRulesForConnection({ kind: 'story.dialog', portId: 'dialog' }, { kind: 'animation.storyboard', portId: 'dialog' }),
    /panel per: beat/,
  );
  // Dialog → Random Text: panel rules would be noise, so the target's win.
  const toText = defaultRulesForConnection({ kind: 'story.dialog', portId: 'dialog' }, { kind: 'text.random', portId: 'text' });
  assert.match(toText, /alter: /);
  assert.doesNotMatch(toText, /panel per/);
  // A wire onto a different port of the same flow gets nothing of the sort.
  assert.doesNotMatch(defaultRulesForConnection({ kind: 'text.random', portId: 'lexicon' }, { kind: 'text.random', portId: 'lexicon' }), /alter:/);
  // Nothing suggested either way is an empty box, not a wrong one.
  assert.equal(defaultRulesForConnection({ kind: 'brainstorm.tone', portId: 'tone' }, { kind: 'world.design', portId: 'tone' }), '');
});
