import { hashString, newId } from '../ids';
import type { Lexeme, Lexicon, WordType } from '../types/text';
import { expandSenses, lexemeIdFor, type WordMeaning } from './senses';
import { sentenceSpans, tokenize, type TextToken } from './tokenize';

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
  /**
   * The words that turned up around this one, and how often each was taken as
   * a context: `[spelling, weight]`, strongest first. See {@link gatherContexts}.
   * Absent from datasets counted before contexts were gathered this way.
   */
  near?: Array<[string, number]>;
  /** How many contexts it can hold: the slots it started with, doubled as it filled up. */
  capacity?: number;
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
  /** Contexts a word can hold to begin with. */
  contextSlots: number;
  /**
   * When a word's contexts weigh this much per slot in all, its slots double: a
   * word the corpus uses a great deal has room for more company.
   */
  contextGrowAt: number;
  /** The chance a word right next to another is taken as its context. */
  adjacentChance: number;
  /** The chance a word elsewhere in the same sentence is. */
  sentenceChance: number;
  /** The chance a word nearby in the same paragraph is. */
  paragraphChance: number;
}

export const DEFAULT_EXTRACT_OPTIONS: CorpusExtractOptions = {
  maxWords: 1200,
  maxLinksPerWord: 16,
  minPairCount: 2,
  includePunctuation: true,
  contextSlots: 16,
  contextGrowAt: 8,
  adjacentChance: 0.9,
  sentenceChance: 0.25,
  paragraphChance: 0.05,
};

/** The most contexts a word can grow to hold. */
export const MAX_CONTEXT_SLOTS = 128;
/** How far either side, in words, the same-paragraph chance reaches. */
const PARAGRAPH_REACH = 40;
/**
 * A word taking up more of the corpus than this has its chance of being taken
 * as a context cut in proportion: `the`, at one word in twenty, is taken a
 * tenth as often as a word at one in five hundred. In a text too short to have
 * five hundred different words, the bar is an even share of the words it has.
 */
const COMMON_SHARE = 0.002;

function commonShare(distinct: number): number {
  return Math.max(COMMON_SHARE, 1 / Math.max(1, distinct));
}

function seededRng(seed: string): () => number {
  let state = Number.parseInt(hashString(seed), 16) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One word's contexts as they are gathered: weights, and room for more. */
interface ContextSlots {
  weights: Map<string, number>;
  capacity: number;
  total: number;
}

/**
 * Take `context` as one more context of a word.
 *
 * Already there, it weighs one more. A free slot takes it at a weight of one.
 * With every slot full, it may push out the weakest context there — the
 * lighter that one is, the likelier — or else it is not taken. And once the
 * contexts weigh `growAt` per slot in all, the slots double.
 */
function takeContext(slots: ContextSlots, context: string, growAt: number, rng: () => number): void {
  const had = slots.weights.get(context);
  if (had !== undefined) {
    slots.weights.set(context, had + 1);
    slots.total += 1;
  } else if (slots.weights.size < slots.capacity) {
    slots.weights.set(context, 1);
    slots.total += 1;
  } else {
    let weakest: string | undefined;
    let least = Number.POSITIVE_INFINITY;
    for (const [candidate, weight] of slots.weights) {
      if (weight < least) {
        least = weight;
        weakest = candidate;
      }
    }
    if (weakest === undefined || rng() >= 1 / (1 + least)) return;
    slots.weights.delete(weakest);
    slots.weights.set(context, 1);
    slots.total += 1 - least;
  }
  if (slots.capacity < MAX_CONTEXT_SLOTS && slots.total >= slots.capacity * growAt) {
    slots.capacity = Math.min(MAX_CONTEXT_SLOTS, slots.capacity * 2);
  }
}

/**
 * Gather every kept word's contexts: the words it keeps company with.
 *
 * Every other word near an occurrence of it gets a chance of being taken as a
 * context: a good one if it is right next to it, less if it is elsewhere in the
 * same sentence, and a small one if it is only in the same paragraph. That
 * chance is cut for a very common word, so `the` — near everything — is rarely
 * taken. A word that turns up near it twice gets two chances.
 *
 * Every draw is seeded from the corpus, so counting the same text again gives
 * the same contexts.
 */
export function gatherContexts(
  tokens: readonly TextToken[],
  counts: ReadonlyMap<string, number>,
  kept: ReadonlySet<string>,
  tokenCount: number,
  options: CorpusExtractOptions,
  seed: string,
): Map<string, ContextSlots> {
  const rng = seededRng(`${seed}:${tokenCount}`);
  const total = Math.max(1, tokenCount);
  const rarity = new Map<string, number>();
  const common = commonShare(counts.size);
  for (const key of kept) rarity.set(key, Math.min(1, common / ((counts.get(key) ?? 0) / total || 1)));

  const slots = new Map<string, ContextSlots>();
  const start = Math.max(1, Math.round(options.contextSlots));
  const growAt = Math.max(1, options.contextGrowAt);
  const chances = [options.adjacentChance, options.sentenceChance, options.paragraphChance].map((chance) =>
    Math.max(0, Math.min(1, chance)),
  );

  // Words only, as numbers, each with the sentence and paragraph it is in.
  const ids = new Map<string, number>();
  const keys: string[] = [];
  const word: number[] = [];
  const sentenceOf: number[] = [];
  const paragraphOf: number[] = [];
  sentenceSpans(tokens).forEach((span, sentence) => {
    for (let i = span.start; i < span.end; i += 1) {
      const token = tokens[i]!;
      if (token.kind !== 'word' && token.kind !== 'number') continue;
      let id = ids.get(token.key);
      if (id === undefined) {
        id = keys.length;
        ids.set(token.key, id);
        keys.push(token.key);
      }
      word.push(id);
      sentenceOf.push(sentence);
      paragraphOf.push(span.paragraph);
    }
  });
  // How likely each word is to be taken, before its distance: 0 for one not kept.
  const scale = new Float64Array(keys.length);
  keys.forEach((key, id) => {
    scale[id] = rarity.get(key) ?? 0;
  });

  const byId = new Map<number, ContextSlots>();
  for (let at = 0; at < word.length; at += 1) {
    const self = word[at]!;
    if (scale[self] === 0) continue;
    let own = byId.get(self);
    if (!own) {
      own = { weights: new Map(), capacity: start, total: 0 };
      byId.set(self, own);
    }
    const from = Math.max(0, at - PARAGRAPH_REACH);
    const to = Math.min(word.length - 1, at + PARAGRAPH_REACH);
    for (let other = from; other <= to; other += 1) {
      const near = word[other]!;
      if (near === self || paragraphOf[other] !== paragraphOf[at]) continue;
      const chance = scale[near]!;
      if (chance === 0) continue;
      const reach = sentenceOf[other] !== sentenceOf[at] ? 2 : other === at - 1 || other === at + 1 ? 0 : 1;
      if (rng() < chances[reach]! * chance) takeContext(own, keys[near]!, growAt, rng);
    }
  }
  for (const [id, own] of byId) slots.set(keys[id]!, own);
  return slots;
}

function sortedWeights(weights: Iterable<[string, number]>): Array<[string, number]> {
  return [...weights].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

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
  const tokens = tokenize(text);

  for (const token of tokens) {
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
  const contexts = gatherContexts(tokens, counts, keptKeys, tokenCount, options, name);

  const entries: CorpusEntryCounts[] = kept.map(([spelling, count]) => {
    const own = contexts.get(spelling);
    return {
      spelling,
      count,
      next: [...(pairs.get(spelling) ?? new Map<string, number>()).entries()]
        .filter(([target, pairTotal]) => keptKeys.has(target) && pairTotal >= options.minPairCount)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, Math.max(0, options.maxLinksPerWord)),
      // A mark is not company anyone keeps; it stays known by what follows it.
      ...(own || /^[a-z0-9]/i.test(spelling)
        ? {
            near: own ? sortedWeights(own.weights) : [],
            capacity: own?.capacity ?? Math.max(1, Math.round(options.contextSlots)),
          }
        : {}),
    };
  });

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
  near: Map<string, Map<string, number>>;
  capacity: Map<string, number>;
}

function emptyTally(): Tally {
  return { counts: new Map(), pairs: new Map(), near: new Map(), capacity: new Map() };
}

function tally(dataset: CorpusDataset, sign: 1 | -1, into: Tally): void {
  for (const entry of dataset.entries) {
    into.counts.set(entry.spelling, (into.counts.get(entry.spelling) ?? 0) + sign * entry.count);
    const row = into.pairs.get(entry.spelling) ?? new Map<string, number>();
    for (const [target, count] of entry.next) {
      row.set(target, (row.get(target) ?? 0) + sign * count);
    }
    into.pairs.set(entry.spelling, row);
    if (entry.near) {
      const around = into.near.get(entry.spelling) ?? new Map<string, number>();
      for (const [target, weight] of entry.near) around.set(target, (around.get(target) ?? 0) + sign * weight);
      into.near.set(entry.spelling, around);
    }
    // Taking a corpus out leaves the room its words had grown to.
    if (entry.capacity !== undefined && sign > 0) {
      into.capacity.set(entry.spelling, Math.max(into.capacity.get(entry.spelling) ?? 0, entry.capacity));
    }
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
    const around = tallied.near.get(spelling);
    const capacity = tallied.capacity.get(spelling);
    entries.push({
      spelling,
      count,
      next: [...(tallied.pairs.get(spelling) ?? new Map<string, number>()).entries()]
        .filter(([, pairTotal]) => pairTotal > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
      ...(around ? { near: sortedWeights([...around].filter(([, weight]) => weight > 0)) } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
    });
  }

  const present = new Set(entries.map((entry) => entry.spelling));
  for (const entry of entries) {
    entry.next = entry.next.filter(([target]) => present.has(target));
    if (entry.near) entry.near = entry.near.filter(([target]) => present.has(target));
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
  const tallied = emptyTally();
  for (const dataset of datasets) tally(dataset, 1, tallied);
  return fromTally(first, tallied, name, source);
}

/**
 * Take one dataset back out of another. Because both sides are counts,
 * `subtract(combine(a, b), b)` gives back `a` exactly — which is the point:
 * dropping a book from the master is not an approximation.
 */
export function subtractDataset(from: CorpusDataset, remove: CorpusDataset, name = from.name): CorpusDataset {
  const tallied = emptyTally();
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
  /**
   * Keep at most this many contexts per word. A word counted with contexts
   * gathered around it is held to the slots it grew to as well.
   */
  maxContexts: number;
}

export const DEFAULT_DERIVE_OPTIONS: DeriveLexiconOptions = {
  liftCeiling: 12,
  minWeight: 0.08,
  maxContexts: MAX_CONTEXT_SLOTS,
};

/** The words of a definition, each weighed by how likely a word that common would have been taken. */
function definitionWords(
  description: string,
  own: string,
  countOf: ReadonlyMap<string, number>,
  total: number,
): Map<string, number> {
  const words = new Map<string, number>();
  for (const token of tokenize(description)) {
    if (token.kind !== 'word' || token.key === own) continue;
    const count = countOf.get(token.key);
    if (!count) continue;
    const weight = Math.min(1, commonShare(countOf.size) / (count / total));
    words.set(token.key, (words.get(token.key) ?? 0) + weight);
  }
  return words;
}

/**
 * A word's contexts, weighted: each context's share of the word's company set
 * against its share of the corpus. Only a context that keeps this word's company
 * more than it turns up at all is kept, which is what stops a word being known
 * mostly by `the` and `and`.
 */
function weighNear(
  near: ReadonlyMap<string, number>,
  countOf: ReadonlyMap<string, number>,
  total: number,
  ceiling: number,
  options: DeriveLexiconOptions,
  limit: number,
): Array<{ id: string; weight: number }> {
  let sum = 0;
  for (const weight of near.values()) sum += weight;
  if (sum <= 0) return [];
  const contexts: Array<{ id: string; weight: number }> = [];
  for (const [target, weight] of near) {
    const count = countOf.get(target) ?? 0;
    if (count === 0) continue;
    const lift = weight / sum / (count / total);
    if (lift <= 1) continue;
    const scaled = Math.min(1, Math.log(lift) / Math.log(ceiling));
    if (scaled >= options.minWeight) contexts.push({ id: lexemeIdFor(target), weight: Math.round(scaled * 100) / 100 });
  }
  return contexts.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

/**
 * Counts in, lexicon out.
 *
 * - **frequency** is `log(1+count) / log(1+maxCount)`, so the most common word
 *   sits at 1 and the long tail stays usable rather than collapsing to zero the
 *   way a raw share of tokens would.
 * - **context weight** is lift: how much more of A's company B is than B is of
 *   the corpus — `share of A's contexts / share of all words` — compressed onto
 *   0..1 against `liftCeiling`. Only a lift above 1 is kept. Dividing by the
 *   word's own frequency is what stops `the` from being the strongest context of
 *   every word in the language.
 * - A word with a definition gets the definition's words as contexts too, sense
 *   by sense.
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

  // A dataset counted before contexts were gathered has only what follows each word.
  const followers = (entry: CorpusEntryCounts) =>
    entry.next
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

  const lexemes: Lexeme[] = dataset.entries.flatMap((entry) => {
    const limit = Math.max(0, Math.min(options.maxContexts, entry.capacity ?? options.maxContexts));
    const base = {
      spelling: entry.spelling,
      frequency: Math.round((Math.log1p(entry.count) / Math.log1p(maxCount)) * 100) / 100,
      contexts: entry.near ? weighNear(new Map(entry.near), countOf, total, ceiling, options, limit) : followers(entry),
      stats: {
        count: entry.count,
        perMillion: Math.round((entry.count / total) * 1_000_000),
      },
    };
    const senses = expandSenses(base, meanings[entry.spelling], taken);
    if (!entry.near) return senses;

    // Each sense is also known by the words of its own definition: `bank` the
    // river's edge keeps company with `river`, `bank` the lender with `money`.
    return senses.map((lexeme) => {
      if (!lexeme.description) return lexeme;
      const near = new Map(entry.near);
      for (const [word, weight] of definitionWords(lexeme.description, entry.spelling, countOf, total)) {
        near.set(word, (near.get(word) ?? 0) + weight);
      }
      return { ...lexeme, contexts: weighNear(near, countOf, total, ceiling, options, limit) };
    });
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
