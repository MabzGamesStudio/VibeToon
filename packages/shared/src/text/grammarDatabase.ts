import { newId } from '../ids';
import type { Lexeme, Lexicon, WordType } from '../types/text';
import type { CorpusSource } from './corpus';
import { formIn, type VariationKey } from './forms';
import { buildLexiconIndex, type LexiconIndex } from './lexicon';
import { isSentenceEnd, sentenceSpans, tokenize, type TextToken } from './tokenize';

/**
 * A grammar database is the shapes sentences take, counted.
 *
 * Where a word database says which words follow which, this says which *kinds*
 * of word follow which: `determiner adjective noun verb:past punctuation:.` and
 * how often that shape turned up. The word database supplies the types and the
 * forms; the corpus supplies the order.
 */
export interface GrammarSlot {
  type: WordType;
  /** For a word that inflects: which form it was in. */
  form?: VariationKey;
  /** For punctuation: which mark. */
  mark?: string;
}

export interface GrammarPattern {
  slots: GrammarSlot[];
  count: number;
}

export interface GrammarExtractOptions {
  /** Sentences longer than this are counted, and their length is, but their shape is not kept. */
  maxSentenceSlots: number;
  /** Shortest and longest run of slots kept as a phrase. */
  phraseMin: number;
  phraseMax: number;
  /**
   * Keep this many of each kind of pattern, commonest first. Sentence shapes are
   * shared out between sentence lengths in proportion to how often each length
   * was written, so the long tail of one-off long sentences is not squeezed out
   * by the few short ones that repeat exactly.
   */
  maxPatterns: number;
  /** A pattern has to turn up this often to be kept. */
  minCount: number;
  /** Include the word form in a slot (`verb:past`), or only the type (`verb`). */
  useForms: boolean;
}

export const DEFAULT_GRAMMAR_OPTIONS: GrammarExtractOptions = {
  maxSentenceSlots: 40,
  phraseMin: 2,
  phraseMax: 5,
  maxPatterns: 1500,
  minCount: 2,
  useForms: true,
};

export interface GrammarStats {
  sentences: number;
  fragments: number;
  tokens: number;
  /** Tokens whose type came from the word database rather than a guess. */
  tagged: number;
  /** Tokens the word database had never seen. */
  unknown: number;
}

export interface GrammarDataset {
  id: string;
  name: string;
  source: CorpusSource;
  createdAt: string;
  stats: GrammarStats;
  /** `[signature, count]`, commonest first. */
  sentences: Array<[string, number]>;
  fragments: Array<[string, number]>;
  phrases: Array<[string, number]>;
  /**
   * `[words, sentences]`: how many of the corpus's sentences had each number of
   * words, counting every sentence read (not only the ones whose shape was
   * kept). The generator draws a sentence's length from this first, so short
   * sentences come up as often as the corpus wrote them. Older datasets lack it.
   */
  lengths?: Array<[number, number]>;
  options: GrammarExtractOptions;
}

/* ------------------------------------------------------------------ *
 * Signatures
 * ------------------------------------------------------------------ */

export function slotSignature(slot: GrammarSlot): string {
  if (slot.type === 'punctuation') return `punctuation:${slot.mark ?? '.'}`;
  return slot.form ? `${slot.type}:${slot.form}` : slot.type;
}

export function patternSignature(slots: readonly GrammarSlot[]): string {
  return slots.map(slotSignature).join(' ');
}

export function parseSlot(signature: string): GrammarSlot {
  const [type, detail] = signature.split(':');
  if (type === 'punctuation') return { type: 'punctuation', mark: detail ?? '.' };
  return { type: (type ?? 'noun') as WordType, ...(detail ? { form: detail as VariationKey } : {}) };
}

export function parsePattern(signature: string): GrammarSlot[] {
  return signature.split(' ').filter(Boolean).map(parseSlot);
}

/* ------------------------------------------------------------------ *
 * Tagging
 * ------------------------------------------------------------------ */

export interface TaggedToken {
  token: TextToken;
  slot: GrammarSlot;
  /** The lexeme the word database matched, when it had one. */
  lexeme?: Lexeme;
}

/**
 * Work out what each token is.
 *
 * The word database is the only authority here — that is the whole reason the
 * grammar flow takes one. Both the type and the form come off the entry it
 * matched: the form is which of that entry's own spellings this token is, which
 * is why a word database with its variants filled in produces a far more
 * detailed grammar than one without.
 *
 * A token the database has never seen is tagged `unknown` rather than guessed at.
 * It still takes a place in the pattern, so an unfamiliar word does not break the
 * sentence it sits in — it just does not pretend to be a noun.
 */
export function tagTokens(
  tokens: readonly TextToken[],
  index: LexiconIndex,
  useForms: boolean,
): TaggedToken[] {
  return tokens
    .filter((token) => token.kind !== 'break')
    .map((token) => {
      if (token.kind === 'punctuation') {
        return { token, slot: { type: 'punctuation' as WordType, mark: token.text } };
      }

      const lexeme = index.bySpelling.get(token.key)?.[0];
      const type = lexeme?.type ?? 'unknown';
      const form = useForms ? formIn(lexeme?.variations, token.key) : undefined;
      return {
        token,
        slot: { type, ...(form ? { form } : {}) },
        ...(lexeme ? { lexeme } : {}),
      };
    });
}

/** Marks that end a clause without ending the sentence. */
const CLAUSE_BREAKS = new Set([',', ';', ':', '—', '--']);

/**
 * Quote marks and brackets are left out of every shape. They are not grammar,
 * and a shape that opened a quote in one sentence and closed it in another
 * would write unbalanced quotes.
 */
const ENCLOSING = new Set(['"', '“', '”', '‘', '’', "'", '(', ')', '[', ']', '{', '}', '«', '»']);

function isEnclosing(entry: TaggedToken): boolean {
  return entry.token.kind === 'punctuation' && ENCLOSING.has(entry.token.text[0] ?? '');
}

/** Words in a run of tagged tokens: what a sentence's length is counted in. */
export function wordsIn(slots: readonly GrammarSlot[]): number {
  return slots.reduce((sum, slot) => sum + (slot.type === 'punctuation' ? 0 : 1), 0);
}

/**
 * `CHAPTER IV.`, `THE END.` and a bare section number are headings, not
 * sentences: every word is in capitals or a roman numeral, or there is no word.
 */
function isHeading(tokens: readonly TextToken[]): boolean {
  const words = tokens.filter((token) => token.kind === 'word');
  return words.every(
    (token) => /^[IVXLC]+$/.test(token.text) || (token.text.length > 1 && token.text === token.text.toUpperCase()),
  );
}

export interface TaggedSentence {
  entries: TaggedToken[];
  /** Ended by its own full stop, rather than cut off by a paragraph break. */
  closed: boolean;
}

/**
 * The text's sentences, tagged. A sentence runs from one full stop to the next:
 * `Mr.` and an initial do not end one, a closing quote after the full stop stays
 * with it, and a blank line cuts off whatever was running, so a heading does not
 * run on into the paragraph under it.
 */
export function taggedSentences(
  tokens: readonly TextToken[],
  index: LexiconIndex,
  useForms: boolean,
): TaggedSentence[] {
  const sentences: TaggedSentence[] = [];
  for (const span of sentenceSpans(tokens)) {
    const slice = tokens.slice(span.start, span.end);
    if (isHeading(slice)) continue;
    const entries = tagTokens(slice, index, useForms).filter((entry) => !isEnclosing(entry));
    if (!entries.some((entry) => entry.token.kind !== 'punctuation')) continue;
    sentences.push({ entries, closed: span.closed });
  }
  return sentences;
}

/** A sentence broken at its commas and its joining words. */
function splitFragments(sentence: readonly TaggedToken[]): TaggedToken[][] {
  const fragments: TaggedToken[][] = [];
  let current: TaggedToken[] = [];
  for (const entry of sentence) {
    const isBreak =
      (entry.token.kind === 'punctuation' && CLAUSE_BREAKS.has(entry.token.text)) ||
      entry.slot.type === 'conjunction';
    if (isBreak) {
      if (current.length > 0) fragments.push(current);
      current = [];
      continue;
    }
    if (isSentenceEnd(entry.token)) continue;
    current.push(entry);
  }
  if (current.length > 0) fragments.push(current);
  return fragments.filter((fragment) => fragment.length > 1);
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

function topCounts(
  counts: Map<string, number>,
  options: GrammarExtractOptions,
  minCount = options.minCount,
): Array<[string, number]> {
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort(byCount)
    .slice(0, options.maxPatterns);
}

function byCount(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
}

/** The fewest shapes kept of any sentence length the corpus used at all. */
const MIN_PER_LENGTH = 3;

/**
 * Sentence shapes, shared out between lengths. Each length gets a share of
 * `maxPatterns` in proportion to how many sentences had it, and at least a few,
 * and fills it commonest first.
 */
function sentenceShapes(
  counts: Map<string, number>,
  lengths: Map<number, number>,
  options: GrammarExtractOptions,
): Array<[string, number]> {
  const byLength = new Map<number, Array<[string, number]>>();
  for (const entry of counts) {
    const words = wordsIn(parsePattern(entry[0]));
    const list = byLength.get(words) ?? [];
    list.push(entry);
    byLength.set(words, list);
  }
  const total = [...lengths.values()].reduce((sum, count) => sum + count, 0) || 1;
  const kept: Array<[string, number]> = [];
  for (const [words, list] of byLength) {
    const quota = Math.max(MIN_PER_LENGTH, Math.round((options.maxPatterns * (lengths.get(words) ?? 0)) / total));
    kept.push(...list.sort(byCount).slice(0, quota));
  }
  return kept.sort(byCount);
}

function sortedLengths(lengths: Map<number, number>): Array<[number, number]> {
  return [...lengths.entries()].filter(([, count]) => count > 0).sort((a, b) => a[0] - b[0]);
}

/**
 * Read a corpus against a word database and count the shapes it makes: whole
 * sentences, the fragments they are built from, and every short run of slots
 * inside those fragments.
 */
export function extractGrammar(
  text: string,
  lexicon: Lexicon,
  name: string,
  source: CorpusSource,
  options: GrammarExtractOptions = DEFAULT_GRAMMAR_OPTIONS,
): GrammarDataset {
  const index = buildLexiconIndex(lexicon);
  const sentences = taggedSentences(tokenize(text), index, options.useForms);

  const sentenceCounts = new Map<string, number>();
  const fragmentCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  const lengths = new Map<number, number>();
  const stats: GrammarStats = { sentences: 0, fragments: 0, tokens: 0, tagged: 0, unknown: 0 };

  const bump = (counts: Map<string, number>, signature: string) => {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  };

  for (const sentence of sentences) {
    for (const entry of sentence.entries) {
      stats.tokens += 1;
      if (entry.lexeme) stats.tagged += 1;
      else if (entry.token.kind !== 'punctuation') stats.unknown += 1;
    }

    // Only a run that ended in its own full stop is a whole sentence: a title,
    // a list item or the text's last unfinished line is not a shape to copy.
    if (sentence.closed) {
      stats.sentences += 1;
      const slots = sentence.entries.map((entry) => entry.slot);
      const words = wordsIn(slots);
      lengths.set(words, (lengths.get(words) ?? 0) + 1);
      if (slots.length <= options.maxSentenceSlots) bump(sentenceCounts, patternSignature(slots));
    }

    for (const fragment of splitFragments(sentence.entries)) {
      stats.fragments += 1;
      bump(fragmentCounts, patternSignature(fragment.map((entry) => entry.slot)));

      const slots = fragment.map((entry) => entry.slot);
      for (let size = options.phraseMin; size <= options.phraseMax; size += 1) {
        for (let start = 0; start + size <= slots.length; start += 1) {
          bump(phraseCounts, patternSignature(slots.slice(start, start + size)));
        }
      }
    }
  }

  return {
    id: newId('grammar'),
    name,
    source,
    createdAt: new Date().toISOString(),
    stats,
    // A whole sentence shape repeating at all is meaningful, so sentences are
    // kept even when they were only seen once.
    sentences: sentenceShapes(sentenceCounts, lengths, options),
    fragments: topCounts(fragmentCounts, options),
    phrases: topCounts(phraseCounts, options),
    lengths: sortedLengths(lengths),
    options,
  };
}

/* ------------------------------------------------------------------ *
 * Set algebra, the same way corpora combine
 * ------------------------------------------------------------------ */

function tallyInto(into: Map<string, number>, entries: Array<[string, number]>, sign: 1 | -1): void {
  for (const [signature, count] of entries) {
    into.set(signature, (into.get(signature) ?? 0) + sign * count);
  }
}

function lengthTally(into: Map<number, number>, dataset: GrammarDataset, sign: 1 | -1): void {
  for (const [words, count] of datasetLengths(dataset)) into.set(words, (into.get(words) ?? 0) + sign * count);
}

/**
 * A dataset's sentence lengths. One read before lengths were counted has only
 * its kept shapes to go on, which undercounts long sentences but is the best
 * there is.
 */
export function datasetLengths(dataset: Pick<GrammarDataset, 'lengths' | 'sentences'>): Array<[number, number]> {
  if (dataset.lengths) return dataset.lengths;
  const lengths = new Map<number, number>();
  for (const [signature, count] of dataset.sentences) {
    const words = wordsIn(parsePattern(signature));
    lengths.set(words, (lengths.get(words) ?? 0) + count);
  }
  return sortedLengths(lengths);
}

function positive(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function combineGrammar(datasets: readonly GrammarDataset[], name = 'Master'): GrammarDataset {
  const first = datasets[0];
  const sentences = new Map<string, number>();
  const fragments = new Map<string, number>();
  const phrases = new Map<string, number>();
  const lengths = new Map<number, number>();
  const stats: GrammarStats = { sentences: 0, fragments: 0, tokens: 0, tagged: 0, unknown: 0 };

  for (const dataset of datasets) {
    lengthTally(lengths, dataset, 1);
    tallyInto(sentences, dataset.sentences, 1);
    tallyInto(fragments, dataset.fragments, 1);
    tallyInto(phrases, dataset.phrases, 1);
    stats.sentences += dataset.stats.sentences;
    stats.fragments += dataset.stats.fragments;
    stats.tokens += dataset.stats.tokens;
    stats.tagged += dataset.stats.tagged;
    stats.unknown += dataset.stats.unknown;
  }

  return {
    id: newId('grammar'),
    name,
    source: { kind: 'builtin', reference: 'combined' },
    createdAt: new Date().toISOString(),
    stats,
    sentences: positive(sentences),
    fragments: positive(fragments),
    phrases: positive(phrases),
    lengths: sortedLengths(lengths),
    options: first?.options ?? DEFAULT_GRAMMAR_OPTIONS,
  };
}

export function subtractGrammar(from: GrammarDataset, remove: GrammarDataset): GrammarDataset {
  const sentences = new Map<string, number>();
  const fragments = new Map<string, number>();
  const phrases = new Map<string, number>();
  const lengths = new Map<number, number>();
  lengthTally(lengths, from, 1);
  lengthTally(lengths, remove, -1);
  tallyInto(sentences, from.sentences, 1);
  tallyInto(sentences, remove.sentences, -1);
  tallyInto(fragments, from.fragments, 1);
  tallyInto(fragments, remove.fragments, -1);
  tallyInto(phrases, from.phrases, 1);
  tallyInto(phrases, remove.phrases, -1);

  return {
    ...from,
    id: newId('grammar'),
    createdAt: new Date().toISOString(),
    stats: {
      sentences: Math.max(0, from.stats.sentences - remove.stats.sentences),
      fragments: Math.max(0, from.stats.fragments - remove.stats.fragments),
      tokens: Math.max(0, from.stats.tokens - remove.stats.tokens),
      tagged: Math.max(0, from.stats.tagged - remove.stats.tagged),
      unknown: Math.max(0, from.stats.unknown - remove.stats.unknown),
    },
    sentences: positive(sentences),
    fragments: positive(fragments),
    phrases: positive(phrases),
    lengths: sortedLengths(lengths),
  };
}

/* ------------------------------------------------------------------ *
 * What the generator asks of it
 * ------------------------------------------------------------------ */

/** A grammar database in the form the generator uses: patterns and a phrase index. */
export interface GrammarModel {
  sentences: GrammarPattern[];
  /** Sentence shapes by how many words they have. */
  byLength: Map<number, GrammarPattern[]>;
  /**
   * How many of the corpus's sentences had each length, for the lengths there
   * are shapes of. A length with no shape kept lends its sentences to the
   * nearest length that has one.
   */
  lengthWeights: Map<number, number>;
  fragments: GrammarPattern[];
  /** `types of the last n-1 slots` -> `next slot signature` -> count. */
  continuations: Map<string, Map<string, number>>;
  totalSentences: number;
}

export function buildGrammarModel(dataset: GrammarDataset | null): GrammarModel | null {
  if (!dataset) return null;
  const sentences = dataset.sentences.map(([signature, count]) => ({
    slots: parsePattern(signature),
    count,
  }));
  const fragments = dataset.fragments.map(([signature, count]) => ({
    slots: parsePattern(signature),
    count,
  }));

  const byLength = new Map<number, GrammarPattern[]>();
  for (const pattern of sentences) {
    const words = wordsIn(pattern.slots);
    if (words === 0) continue;
    const list = byLength.get(words) ?? [];
    list.push(pattern);
    byLength.set(words, list);
  }
  const available = [...byLength.keys()].sort((a, b) => a - b);
  const lengthWeights = new Map<number, number>();
  for (const [words, count] of datasetLengths(dataset)) {
    const nearest = nearestOf(available, words);
    if (nearest !== undefined) lengthWeights.set(nearest, (lengthWeights.get(nearest) ?? 0) + count);
  }

  const continuations = new Map<string, Map<string, number>>();
  for (const [signature, count] of dataset.phrases) {
    const slots = signature.split(' ').filter(Boolean);
    if (slots.length < 2) continue;
    const key = slots.slice(0, -1).join(' ');
    const next = slots[slots.length - 1]!;
    const row = continuations.get(key) ?? new Map<string, number>();
    row.set(next, (row.get(next) ?? 0) + count);
    continuations.set(key, row);
  }

  return {
    sentences,
    byLength,
    lengthWeights,
    fragments,
    continuations,
    totalSentences: sentences.reduce((sum, pattern) => sum + pattern.count, 0),
  };
}

function nearestOf(sorted: readonly number[], value: number): number | undefined {
  let best: number | undefined;
  for (const candidate of sorted) {
    if (best === undefined || Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  }
  return best;
}

/**
 * How well a slot would continue what has just been written, as a 0..1 score.
 * Looks for the longest run of recent slots the grammar has seen, so a phrase
 * the corpus used often pulls harder than one it used once.
 */
export function continuationScore(
  model: GrammarModel,
  recent: readonly GrammarSlot[],
  candidate: GrammarSlot,
): number {
  const signature = slotSignature(candidate);
  const bare = candidate.type;

  for (let size = Math.min(recent.length, 4); size >= 1; size -= 1) {
    const key = recent.slice(recent.length - size).map(slotSignature).join(' ');
    const row = model.continuations.get(key);
    if (!row) continue;
    const total = [...row.values()].reduce((sum, count) => sum + count, 0);
    if (total === 0) continue;
    const hit = row.get(signature) ?? 0;
    // A type-only match still counts: `verb` following a determiner is unusual
    // whichever tense it is in.
    const loose = hit > 0 ? 0 : [...row.entries()].filter(([key2]) => key2.startsWith(`${bare}:`)).reduce((sum, [, count]) => sum + count, 0);
    const share = (hit + loose * 0.6) / total;
    if (share > 0) return Math.min(1, share * (1 + size / 4));
  }
  return 0;
}

export interface SentenceBounds {
  /** Fewest and most words a sentence may have. */
  min: number;
  max: number;
}

function draw<T>(items: readonly T[], weights: readonly number[], rng: () => number): T | undefined {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (items.length === 0) return undefined;
  if (total <= 0) return items[0];
  let roll = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Pick a sentence shape to write into, in two draws.
 *
 * First the sentence's length, straight from how often the corpus wrote
 * sentences of each length. Then a shape of that length, weighted by how often
 * it turned up, sharpened by `temperature`. Drawing the length first matters:
 * short shapes repeat word for word far more than long ones do, so weighting
 * whole shapes by count alone makes one-word sentences many times commoner than
 * the corpus had them.
 *
 * `bounds` keeps the length within a range; when the database has no shape in
 * it, the nearest length it does have is used.
 */
export function pickSentencePattern(
  model: GrammarModel,
  rng: () => number,
  temperature: number,
  bounds?: SentenceBounds,
): GrammarPattern | undefined {
  const exponent = 1 / Math.max(0.05, Math.min(1, temperature));
  if (model.byLength.size === 0) {
    const patterns = model.fragments;
    return draw(patterns, patterns.map((pattern) => pattern.count ** exponent), rng);
  }

  const lengths = [...model.byLength.keys()].sort((a, b) => a - b);
  const min = bounds ? Math.max(1, Math.min(bounds.min, bounds.max)) : 1;
  const max = bounds ? Math.max(bounds.min, bounds.max) : Number.POSITIVE_INFINITY;
  let inRange = lengths.filter((words) => words >= min && words <= max);
  if (inRange.length === 0) {
    const nearest = nearestOf(lengths, lengths[0]! > max ? max : min);
    inRange = nearest === undefined ? [] : [nearest];
  }
  const words = draw(inRange, inRange.map((length) => model.lengthWeights.get(length) ?? 1), rng);
  const patterns = words === undefined ? [] : (model.byLength.get(words) ?? []);
  return draw(patterns, patterns.map((pattern) => pattern.count ** exponent), rng);
}

/** The slot a lexeme fills as it stands: its type, and which form its spelling is. */
export function slotForLexeme(lexeme: Lexeme): GrammarSlot {
  if (lexeme.type === 'punctuation') return { type: 'punctuation', mark: lexeme.spelling };
  const form = formIn(lexeme.variations, lexeme.spelling);
  return { type: lexeme.type, ...(form ? { form } : {}) };
}

/**
 * Put a word into the shape a slot asks for: the slot wants a past tense verb,
 * the lexeme is `walk`, the text gets `walked`.
 *
 * `walked` is only available if it is on the entry, put there by a morphology
 * dataset. When it is not, the word goes in as it is rather than being bent into
 * shape by rule — a sentence with an uninflected word in it reads oddly, but a
 * sentence containing `forgived` reads as a bug, and it would be one.
 */
export function spellForSlot(lexeme: Lexeme, slot: GrammarSlot): string {
  if (!slot.form) return lexeme.spelling;
  const spelling = lexeme.variations?.[slot.form];
  return spelling && spelling.trim() ? spelling : lexeme.spelling;
}
