import { newId } from '../ids';
import type { Lexeme, Lexicon, WordType } from '../types/text';
import type { CorpusSource } from './corpus';
import { inferWordType } from './corpus';
import { formOf, inflect, lemmaOf, type VariationKey } from './inflect';
import { buildLexiconIndex, type LexiconIndex } from './lexicon';
import { isSentenceEnd, tokenize, type TextToken } from './tokenize';

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
  /** Sentences longer than this are counted but not kept as a pattern. */
  maxSentenceSlots: number;
  /** Shortest and longest run of slots kept as a phrase. */
  phraseMin: number;
  phraseMax: number;
  /** Keep this many of each kind of pattern, commonest first. */
  maxPatterns: number;
  /** A pattern has to turn up this often to be kept. */
  minCount: number;
  /** Include the word form in a slot (`verb:past`), or only the type (`verb`). */
  useForms: boolean;
}

export const DEFAULT_GRAMMAR_OPTIONS: GrammarExtractOptions = {
  maxSentenceSlots: 24,
  phraseMin: 2,
  phraseMax: 5,
  maxPatterns: 600,
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
 * Work out what each token is. The word database is the authority on type —
 * that is the whole reason the grammar flow takes one — and the form comes from
 * the inflection rules. A word the database has never seen is still tagged, by
 * guess, so an unfamiliar word does not break the sentence it sits in.
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
      const type = lexeme?.type ?? inferWordType(token.key);
      const form = useForms ? formOf(token.key, type) : undefined;
      return {
        token,
        slot: { type, ...(form ? { form } : {}) },
        ...(lexeme ? { lexeme } : {}),
      };
    });
}

/** Marks that end a clause without ending the sentence. */
const CLAUSE_BREAKS = new Set([',', ';', ':', '—', '--']);

function splitSentences(tagged: readonly TaggedToken[]): TaggedToken[][] {
  const sentences: TaggedToken[][] = [];
  let current: TaggedToken[] = [];
  for (const entry of tagged) {
    current.push(entry);
    if (isSentenceEnd(entry.token)) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sentences.push(current);
  return sentences.filter((sentence) => sentence.some((entry) => entry.token.kind !== 'punctuation'));
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
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, options.maxPatterns);
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
  const tagged = tagTokens(tokenize(text), index, options.useForms);

  const sentenceCounts = new Map<string, number>();
  const fragmentCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  const stats: GrammarStats = { sentences: 0, fragments: 0, tokens: 0, tagged: 0, unknown: 0 };

  for (const entry of tagged) {
    stats.tokens += 1;
    if (entry.lexeme) stats.tagged += 1;
    else if (entry.token.kind !== 'punctuation') stats.unknown += 1;
  }

  const bump = (counts: Map<string, number>, signature: string) => {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  };

  for (const sentence of splitSentences(tagged)) {
    stats.sentences += 1;
    if (sentence.length <= options.maxSentenceSlots) {
      bump(sentenceCounts, patternSignature(sentence.map((entry) => entry.slot)));
    }

    for (const fragment of splitFragments(sentence)) {
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
    sentences: topCounts(sentenceCounts, options, 1),
    fragments: topCounts(fragmentCounts, options),
    phrases: topCounts(phraseCounts, options),
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
  const stats: GrammarStats = { sentences: 0, fragments: 0, tokens: 0, tagged: 0, unknown: 0 };

  for (const dataset of datasets) {
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
    options: first?.options ?? DEFAULT_GRAMMAR_OPTIONS,
  };
}

export function subtractGrammar(from: GrammarDataset, remove: GrammarDataset): GrammarDataset {
  const sentences = new Map<string, number>();
  const fragments = new Map<string, number>();
  const phrases = new Map<string, number>();
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
  };
}

/* ------------------------------------------------------------------ *
 * What the generator asks of it
 * ------------------------------------------------------------------ */

/** A grammar database in the form the generator uses: patterns and a phrase index. */
export interface GrammarModel {
  sentences: GrammarPattern[];
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
    fragments,
    continuations,
    totalSentences: sentences.reduce((sum, pattern) => sum + pattern.count, 0),
  };
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

/** Pick a sentence shape to write into, weighted by how often the corpus used it. */
export function pickSentencePattern(
  model: GrammarModel,
  rng: () => number,
  temperature: number,
): GrammarPattern | undefined {
  const patterns = model.sentences.length > 0 ? model.sentences : model.fragments;
  if (patterns.length === 0) return undefined;

  const exponent = 1 / Math.max(0.05, Math.min(1, temperature));
  const weights = patterns.map((pattern) => pattern.count ** exponent);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return patterns[0];

  let roll = rng() * total;
  for (let i = 0; i < patterns.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return patterns[i];
  }
  return patterns[patterns.length - 1];
}

/** The slot a lexeme fills as it stands: its type, and which form its spelling is. */
export function slotForLexeme(lexeme: Lexeme): GrammarSlot {
  if (lexeme.type === 'punctuation') return { type: 'punctuation', mark: lexeme.spelling };
  const form = lexeme.variations
    ? (Object.entries(lexeme.variations).find(([, spelling]) => spelling === lexeme.spelling)?.[0] as
        | VariationKey
        | undefined)
    : formOf(lexeme.spelling, lexeme.type);
  return { type: lexeme.type, ...(form ? { form } : {}) };
}

/**
 * Put a word into the shape a slot asks for: the slot wants a past tense verb,
 * the lexeme is `walk`, the text gets `walked`.
 */
export function spellForSlot(lexeme: Lexeme, slot: GrammarSlot): string {
  if (!slot.form) return lexeme.spelling;
  const variations = lexeme.variations ?? inflect(lemmaOf(lexeme.spelling, lexeme.type), lexeme.type);
  const spelling = variations?.[slot.form];
  return spelling && spelling.trim() ? spelling : lexeme.spelling;
}
