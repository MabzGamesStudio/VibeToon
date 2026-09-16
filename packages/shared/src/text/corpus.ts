import { newId } from '../ids';
import type { Lexeme, Lexicon, WordType } from '../types/text';
import { inflect } from './inflect';
import { tokenize, type TextToken } from './tokenize';

/**
 * A corpus dataset is raw counts, never weights. That is what makes the set
 * algebra exact: two datasets combine by adding counts and come apart by
 * subtracting them, and every derived number — frequency, context weight — is
 * recomputed from whatever counts are left.
 */
export interface CorpusSource {
  kind: 'pasted' | 'url' | 'builtin' | 'flow';
  /** URL, built-in id, or the name of the flow the text came from. */
  reference?: string;
}

export interface CorpusEntryCounts {
  spelling: string;
  count: number;
  /** Tokens seen immediately after this one: `[spelling, count]`, strongest first. */
  next: Array<[string, number]>;
}

export interface CorpusExtractOptions {
  /** Keep this many distinct tokens, the most common first. */
  maxWords: number;
  /** Keep this many following-token links per entry. */
  maxLinksPerWord: number;
  /** A pair has to turn up this often to be worth keeping. */
  minPairCount: number;
  /** Count `.` `,` and the rest as tokens of their own. */
  includePunctuation: boolean;
}

export const DEFAULT_EXTRACT_OPTIONS: CorpusExtractOptions = {
  maxWords: 1200,
  maxLinksPerWord: 16,
  minPairCount: 2,
  includePunctuation: true,
};

export interface CorpusDataset {
  id: string;
  name: string;
  source: CorpusSource;
  createdAt: string;
  /** Tokens counted, after filtering. */
  tokenCount: number;
  /** Distinct tokens seen, before pruning. */
  distinctCount: number;
  /** Pairs counted, before pruning. */
  pairCount: number;
  entries: CorpusEntryCounts[];
  options: CorpusExtractOptions;
}

function countable(token: TextToken, options: CorpusExtractOptions): boolean {
  if (token.kind === 'break') return false;
  if (token.kind === 'punctuation') return options.includePunctuation;
  return true;
}

/**
 * Walk the text and count two things: how often each token appears, and how
 * often each token is followed by each other token. A paragraph break ends the
 * chain — the last word of a heading does not lead into the first word of what
 * follows it — but sentence punctuation does not, because `yesterday → .` and
 * `. → the` are exactly what teaches the generator where sentences end.
 */
export function extractCorpus(
  text: string,
  name: string,
  source: CorpusSource,
  options: CorpusExtractOptions = DEFAULT_EXTRACT_OPTIONS,
): CorpusDataset {
  const counts = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  let tokenCount = 0;
  let pairCount = 0;
  let previous: string | null = null;

  for (const token of tokenize(text)) {
    if (token.kind === 'break') {
      // A blank line breaks the chain; a single wrapped line does not.
      if (token.text.length > 1) previous = null;
      continue;
    }
    if (!countable(token, options)) {
      previous = null;
      continue;
    }

    const key = token.key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    tokenCount += 1;

    if (previous !== null) {
      const row = pairs.get(previous) ?? new Map<string, number>();
      row.set(key, (row.get(key) ?? 0) + 1);
      pairs.set(previous, row);
      pairCount += 1;
    }
    previous = key;
  }

  const distinctCount = counts.size;
  const kept = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(1, options.maxWords));
  const keptKeys = new Set(kept.map(([spelling]) => spelling));

  const entries: CorpusEntryCounts[] = kept.map(([spelling, count]) => ({
    spelling,
    count,
    next: [...(pairs.get(spelling) ?? new Map<string, number>()).entries()]
      .filter(([target, pairTotal]) => keptKeys.has(target) && pairTotal >= options.minPairCount)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(0, options.maxLinksPerWord)),
  }));

  return {
    id: newId('corpus'),
    name,
    source,
    createdAt: new Date().toISOString(),
    tokenCount,
    distinctCount,
    pairCount,
    entries,
    options,
  };
}

/* ------------------------------------------------------------------ *
 * Set algebra over datasets
 * ------------------------------------------------------------------ */

function emptyLike(name: string, source: CorpusSource, options: CorpusExtractOptions): CorpusDataset {
  return {
    id: newId('corpus'),
    name,
    source,
    createdAt: new Date().toISOString(),
    tokenCount: 0,
    distinctCount: 0,
    pairCount: 0,
    entries: [],
    options,
  };
}

interface Tally {
  counts: Map<string, number>;
  pairs: Map<string, Map<string, number>>;
}

function tally(dataset: CorpusDataset, sign: 1 | -1, into: Tally): void {
  for (const entry of dataset.entries) {
    into.counts.set(entry.spelling, (into.counts.get(entry.spelling) ?? 0) + sign * entry.count);
    const row = into.pairs.get(entry.spelling) ?? new Map<string, number>();
    for (const [target, count] of entry.next) {
      row.set(target, (row.get(target) ?? 0) + sign * count);
    }
    into.pairs.set(entry.spelling, row);
  }
}

function fromTally(base: CorpusDataset, tallied: Tally, name: string, source: CorpusSource): CorpusDataset {
  const entries: CorpusEntryCounts[] = [];
  let tokenCount = 0;

  for (const [spelling, count] of [...tallied.counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )) {
    // Subtraction can take a count to zero; that word is simply gone.
    if (count <= 0) continue;
    tokenCount += count;
    entries.push({
      spelling,
      count,
      next: [...(tallied.pairs.get(spelling) ?? new Map<string, number>()).entries()]
        .filter(([, pairTotal]) => pairTotal > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    });
  }

  const present = new Set(entries.map((entry) => entry.spelling));
  for (const entry of entries) {
    entry.next = entry.next.filter(([target]) => present.has(target));
  }

  return {
    ...base,
    id: newId('corpus'),
    name,
    source,
    createdAt: new Date().toISOString(),
    tokenCount,
    distinctCount: entries.length,
    pairCount: entries.reduce((sum, entry) => sum + entry.next.reduce((n, [, c]) => n + c, 0), 0),
    entries,
  };
}

/** Add datasets together. The result is what extracting their texts as one would give. */
export function combineDatasets(
  datasets: readonly CorpusDataset[],
  name = 'Combined',
  source: CorpusSource = { kind: 'builtin', reference: 'combined' },
): CorpusDataset {
  const first = datasets[0];
  if (!first) return emptyLike(name, source, DEFAULT_EXTRACT_OPTIONS);
  const tallied: Tally = { counts: new Map(), pairs: new Map() };
  for (const dataset of datasets) tally(dataset, 1, tallied);
  return fromTally(first, tallied, name, source);
}

/**
 * Take one dataset back out of another. Because both sides are counts,
 * `subtract(combine(a, b), b)` gives back `a` exactly — which is the point:
 * dropping a book from the master is not an approximation.
 */
export function subtractDataset(from: CorpusDataset, remove: CorpusDataset, name = from.name): CorpusDataset {
  const tallied: Tally = { counts: new Map(), pairs: new Map() };
  tally(from, 1, tallied);
  tally(remove, -1, tallied);
  return fromTally(from, tallied, name, from.source);
}

/* ------------------------------------------------------------------ *
 * Deriving a lexicon
 * ------------------------------------------------------------------ */

export interface DeriveLexiconOptions {
  /**
   * How much lift a link needs before it counts as a full-strength context.
   * Lift is how much more often B follows A than B turns up at all, so this is
   * "twelve times more likely than chance is as strong as it gets".
   */
  liftCeiling: number;
  /** Drop links weaker than this after weighting, 0..1. */
  minWeight: number;
  /** Keep at most this many contexts per word. */
  maxContexts: number;
}

export const DEFAULT_DERIVE_OPTIONS: DeriveLexiconOptions = {
  liftCeiling: 12,
  minWeight: 0.08,
  maxContexts: 12,
};

/** Type and description for a spelling, from the dictionary or inferred. */
export interface WordMeaning {
  type: WordType;
  description: string;
  /** Where it came from, so the editor can show what still needs looking up. */
  source: 'dictionary' | 'inferred' | 'manual';
}

export function lexemeIdFor(spelling: string): string {
  const slug = /[a-z0-9]/i.test(spelling)
    ? spelling.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : `p${[...spelling].map((character) => character.charCodeAt(0).toString(16)).join('')}`;
  return `lex_${slug}`;
}

/**
 * Counts in, lexicon out.
 *
 * - **frequency** is `log(1+count) / log(1+maxCount)`, so the most common word
 *   sits at 1 and the long tail stays usable rather than collapsing to zero the
 *   way a raw share of tokens would.
 * - **context weight** is lift: how much more often B follows A than B turns up
 *   at all — `P(B|A) / P(B)` — compressed onto 0..1 against `liftCeiling`.
 *   Dividing by the word's own frequency is what stops `the` from being the
 *   strongest context of every word in the language.
 */
export function deriveLexicon(
  dataset: CorpusDataset,
  meanings: Record<string, WordMeaning>,
  options: DeriveLexiconOptions = DEFAULT_DERIVE_OPTIONS,
): Lexicon {
  const total = Math.max(1, dataset.tokenCount);
  const maxCount = dataset.entries.reduce((max, entry) => Math.max(max, entry.count), 1);
  const countOf = new Map(dataset.entries.map((entry) => [entry.spelling, entry.count]));
  const ceiling = Math.max(1.0001, options.liftCeiling);

  const lexemes: Lexeme[] = dataset.entries.map((entry) => {
    const meaning = meanings[entry.spelling];
    const contexts = entry.next
      .map(([target, pairCount]) => {
        const targetCount = countOf.get(target) ?? 0;
        if (targetCount === 0) return null;
        const conditional = pairCount / entry.count;
        const overall = targetCount / total;
        const lift = conditional / overall;
        const weight = Math.min(1, Math.log1p(Math.max(0, lift)) / Math.log1p(ceiling));
        return weight >= options.minWeight
          ? { id: lexemeIdFor(target), weight: Math.round(weight * 100) / 100 }
          : null;
      })
      .filter((context): context is { id: string; weight: number } => context !== null)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, options.maxContexts);

    const type = meaning?.type ?? inferWordType(entry.spelling);
    const variations = inflect(entry.spelling, type);

    return {
      id: lexemeIdFor(entry.spelling),
      spelling: entry.spelling,
      type,
      frequency: Math.round((Math.log1p(entry.count) / Math.log1p(maxCount)) * 100) / 100,
      description: meaning?.description ?? '',
      contexts,
      ...(variations ? { variations } : {}),
      stats: {
        count: entry.count,
        perMillion: Math.round((entry.count / total) * 1_000_000),
      },
    };
  });

  return { lexemes };
}

/* ------------------------------------------------------------------ *
 * Guessing a word type without a dictionary
 * ------------------------------------------------------------------ */

const FUNCTION_WORDS: Record<string, WordType> = {
  the: 'determiner', a: 'determiner', an: 'determiner', this: 'determiner', that: 'determiner',
  these: 'determiner', those: 'determiner', my: 'determiner', your: 'determiner', his: 'determiner',
  her: 'determiner', its: 'determiner', our: 'determiner', their: 'determiner', some: 'determiner',
  any: 'determiner', no: 'determiner', every: 'determiner', each: 'determiner', another: 'determiner',
  i: 'pronoun', you: 'pronoun', he: 'pronoun', she: 'pronoun', it: 'pronoun', we: 'pronoun',
  they: 'pronoun', me: 'pronoun', him: 'pronoun', us: 'pronoun', them: 'pronoun', who: 'pronoun',
  whom: 'pronoun', which: 'pronoun', what: 'pronoun', myself: 'pronoun', himself: 'pronoun',
  herself: 'pronoun', itself: 'pronoun', themselves: 'pronoun', something: 'pronoun', nothing: 'pronoun',
  anything: 'pronoun', everything: 'pronoun', someone: 'pronoun', nobody: 'pronoun', everyone: 'pronoun',
  of: 'preposition', in: 'preposition', on: 'preposition', at: 'preposition', to: 'preposition',
  from: 'preposition', with: 'preposition', without: 'preposition', by: 'preposition', for: 'preposition',
  about: 'preposition', into: 'preposition', onto: 'preposition', over: 'preposition', under: 'preposition',
  through: 'preposition', between: 'preposition', against: 'preposition', across: 'preposition',
  behind: 'preposition', before: 'preposition', after: 'preposition', during: 'preposition',
  above: 'preposition', below: 'preposition', beside: 'preposition', within: 'preposition',
  upon: 'preposition', toward: 'preposition', towards: 'preposition', among: 'preposition',
  and: 'conjunction', but: 'conjunction', or: 'conjunction', nor: 'conjunction', so: 'conjunction',
  yet: 'conjunction', because: 'conjunction', although: 'conjunction', though: 'conjunction',
  while: 'conjunction', if: 'conjunction', unless: 'conjunction', until: 'conjunction',
  when: 'conjunction', where: 'conjunction', as: 'conjunction', than: 'conjunction',
  is: 'verb', am: 'verb', are: 'verb', was: 'verb', were: 'verb', be: 'verb', been: 'verb',
  being: 'verb', have: 'verb', has: 'verb', had: 'verb', do: 'verb', does: 'verb', did: 'verb',
  will: 'verb', would: 'verb', can: 'verb', could: 'verb', shall: 'verb', should: 'verb',
  may: 'verb', might: 'verb', must: 'verb',
  not: 'adverb', very: 'adverb', too: 'adverb', also: 'adverb', only: 'adverb', just: 'adverb',
  still: 'adverb', again: 'adverb', never: 'adverb', always: 'adverb', often: 'adverb',
  here: 'adverb', there: 'adverb', now: 'adverb', then: 'adverb', once: 'adverb', how: 'adverb',
  why: 'adverb', well: 'adverb', more: 'adverb', most: 'adverb', much: 'adverb',
  oh: 'interjection', ah: 'interjection', yes: 'interjection', hello: 'interjection',
};

/**
 * The fallback when the dictionary cannot be reached or has never heard of a
 * word. It is a guess, and the editor says so, so nothing here pretends to be
 * something a dictionary said.
 */
export function inferWordType(spelling: string): WordType {
  const word = spelling.toLowerCase();
  if (!/[a-z0-9]/i.test(word)) return 'punctuation';
  if (/^\d/.test(word)) return 'number';

  const known = FUNCTION_WORDS[word];
  if (known) return known;

  if (/(ly)$/.test(word) && word.length > 4) return 'adverb';
  if (/(ing|ed|ise|ize|ate|ify)$/.test(word) && word.length > 4) return 'verb';
  if (/(ous|ful|ish|able|ible|ive|less|est|al)$/.test(word) && word.length > 4) return 'adjective';
  if (/(ness|tion|sion|ment|ity|ship|hood|ance|ence|ism|er|or|ist)$/.test(word) && word.length > 4) {
    return 'noun';
  }
  return 'noun';
}

/** Word types the dictionary API reports, mapped onto the ones a lexeme can be. */
const PART_OF_SPEECH: Record<string, WordType> = {
  noun: 'noun',
  verb: 'verb',
  adjective: 'adjective',
  adverb: 'adverb',
  pronoun: 'pronoun',
  preposition: 'preposition',
  conjunction: 'conjunction',
  interjection: 'interjection',
  exclamation: 'interjection',
  determiner: 'determiner',
  article: 'determiner',
  numeral: 'number',
  number: 'number',
  abbreviation: 'noun',
};

export function wordTypeFromPartOfSpeech(partOfSpeech: string | undefined): WordType | undefined {
  if (!partOfSpeech) return undefined;
  return PART_OF_SPEECH[partOfSpeech.trim().toLowerCase()];
}

/** Descriptions for the marks, which no dictionary will define. */
export const PUNCTUATION_MEANINGS: Record<string, string> = {
  '.': 'Ends a sentence.',
  ',': 'Separates parts of one.',
  '?': 'Ends a question.',
  '!': 'Ends something said loudly.',
  ';': 'Joins two sentences that could stand alone.',
  ':': 'Introduces what follows.',
  "'": 'Apostrophe or quote.',
  '"': 'Quotation mark.',
  '—': 'Dash: an aside, or an interruption.',
  '-': 'Hyphen.',
  '(': 'Opens an aside.',
  ')': 'Closes one.',
};

export function meaningForToken(spelling: string): WordMeaning | undefined {
  const mark = PUNCTUATION_MEANINGS[spelling];
  if (mark) return { type: 'punctuation', description: mark, source: 'inferred' };
  if (/^\d/.test(spelling)) {
    return { type: 'number', description: 'A number, kept as its own token.', source: 'inferred' };
  }
  return undefined;
}

/** True for tokens a dictionary could plausibly know. */
export function isLookupCandidate(spelling: string): boolean {
  return /^[a-z][a-z'’-]*$/i.test(spelling);
}
