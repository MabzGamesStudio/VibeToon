import { newId } from '../ids';
import type { Lexeme, Lexicon, WordType } from '../types/text';
import { expandSenses, lexemeIdFor, type WordMeaning } from './senses';
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
  // Ids are handed out in count order so the commonest sense of a spelling keeps
  // the plain id that this corpus's own context links point at.
  const taken = new Set<string>();

  const lexemes: Lexeme[] = dataset.entries.flatMap((entry) => {
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

    return expandSenses(
      {
        spelling: entry.spelling,
        frequency: Math.round((Math.log1p(entry.count) / Math.log1p(maxCount)) * 100) / 100,
        contexts,
        stats: {
          count: entry.count,
          perMillion: Math.round((entry.count / total) * 1_000_000),
        },
      },
      meanings[entry.spelling],
      taken,
    );
  });

  return { lexemes };
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

/**
 * The meaning of a mark or a number, read off the token itself.
 *
 * This is the one thing that is settled without asking anything: `.` *is*
 * punctuation and `42` *is* a number, and neither has other forms. It is marked
 * `token` rather than `dictionary` so nothing here claims to be something a
 * dictionary said.
 */
export function meaningForToken(spelling: string): WordMeaning | undefined {
  const mark = PUNCTUATION_MEANINGS[spelling];
  if (mark) return { senses: [{ type: 'punctuation', description: mark }], source: 'token' };
  if (/^\d/.test(spelling)) {
    return {
      senses: [{ type: 'number', description: 'A number, kept as its own token.' }],
      source: 'token',
    };
  }
  return undefined;
}

/** True for tokens a dictionary could plausibly know. */
export function isLookupCandidate(spelling: string): boolean {
  return /^[a-z][a-z'’-]*$/i.test(spelling);
}
