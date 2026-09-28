/**
 * The word database and the knobs the random text flow runs on.
 *
 * A lexeme is one entry: a word, or a token like `.` `,` `'` or a number. Each
 * one carries how common it is in English and a list of other lexemes it tends
 * to sit near, weighted — `apple` pulls hard on `tree` and `red`, less on
 * `leaf`. Those weights are what steer the next word.
 */

export type WordType =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'pronoun'
  | 'determiner'
  | 'preposition'
  | 'conjunction'
  | 'interjection'
  | 'number'
  | 'punctuation'
  /**
   * Nobody has looked this word up yet, so what kind of word it is is not known.
   * It is deliberately not a guess: a database full of plausible-looking wrong
   * types is worse than one that says which words it has nothing on, because the
   * grammar flow trusts the type completely.
   */
  | 'unknown';

export const WORD_TYPES: readonly WordType[] = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'determiner',
  'preposition',
  'conjunction',
  'interjection',
  'number',
  'punctuation',
  'unknown',
];

export const WORD_TYPE_LABEL: Record<WordType, string> = {
  noun: 'Noun',
  verb: 'Verb',
  adjective: 'Adjective',
  adverb: 'Adverb',
  pronoun: 'Pronoun',
  determiner: 'Determiner',
  preposition: 'Preposition',
  conjunction: 'Conjunction',
  interjection: 'Interjection',
  number: 'Number',
  punctuation: 'Punctuation',
  unknown: 'Not looked up',
};

/** A weighted reference from one lexeme to another. */
export interface LexemeContext {
  /** Lexeme id this one pulls towards. */
  id: string;
  /** 0..1. 1 is `apple → tree`; 0.3 is `apple → leaf`. */
  weight: number;
}

export interface Lexeme {
  id: string;
  /** The word itself, or the token: `apple`, `.`, `'`, `42`. */
  spelling: string;
  type: WordType;
  /** 0..1 — how common the word is. Drives how often it turns up. */
  frequency: number;
  description: string;
  contexts: LexemeContext[];
  /**
   * The other spellings this word takes, keyed by form — `{singular: 'cat',
   * plural: 'cats'}`. Which keys are present depends on the word type: a verb has
   * five, a noun two, an adjective three, and a preposition none at all.
   *
   * Absent means no morphology dataset has been asked about this word yet, which
   * is not the same as the word having no other forms. Nothing here is ever
   * worked out from the spelling.
   */
  variations?: Record<string, string>;
  /**
   * Set when this entry is one of another entry's forms rather than a word the
   * corpus was counted for: `cats` carries the id of `cat`. The two share a type,
   * a description and a paradigm.
   */
  variantOf?: string;
  /** Which of `variations` this entry's spelling is: `plural`, `past`, and so on. */
  form?: string;
  /** Set when the entry was counted out of a corpus rather than written by hand. */
  stats?: {
    /** Times the token appears in the corpus behind this lexicon. */
    count: number;
    perMillion: number;
  };
}

export interface Lexicon {
  lexemes: Lexeme[];
}

/** How the target length is expressed. */
export type LengthMode = 'keep' | 'words' | 'characters' | 'wordPercent' | 'charPercent';

export const LENGTH_MODES: readonly LengthMode[] = [
  'keep',
  'words',
  'characters',
  'wordPercent',
  'charPercent',
];

export const LENGTH_MODE_LABEL: Record<LengthMode, string> = {
  keep: 'Keep the length it is',
  words: 'Word count',
  characters: 'Character count',
  wordPercent: 'Change in words (%)',
  charPercent: 'Change in characters (%)',
};

export interface LengthTarget {
  mode: LengthMode;
  /** Target word count when mode is `words`. */
  words: number;
  /** Target character count when mode is `characters`. */
  characters: number;
  /** Percent change, so 20 is a fifth longer and -15 is 15% shorter. */
  wordPercent: number;
  charPercent: number;
  /**
   * 0..1 — how much freedom the run has to miss the target. 0 lands on it
   * exactly; 0.5 allows roughly a quarter either way and lets a sentence finish
   * rather than stopping mid-clause.
   */
  temperature: number;
}

/**
 * What a run does with the text coming in:
 * - `within` keeps it and writes new words, phrases and fragments into it;
 * - `after` keeps it and writes on from its end (with nothing coming in, it
 *   writes from nothing);
 * - `alter` replaces some of its words, each with a word, a phrase or a fragment.
 */
export type RandomTextMode = 'within' | 'after' | 'alter';

export const RANDOM_TEXT_MODES: RandomTextMode[] = ['within', 'after', 'alter'];

/** The fewest and most words of something. */
export interface WordRange {
  min: number;
  max: number;
}

/** How often each size of new writing is chosen, where a run inserts or replaces. */
export interface UnitWeights {
  word: number;
  phrase: number;
  fragment: number;
}

/** A mode read off anything: a stored project, a connection rule. */
export function readTextMode(value: unknown): RandomTextMode | undefined {
  if (value === 'within' || value === 'insert' || value === 'inside') return 'within';
  if (value === 'after' || value === 'generate' || value === 'continue') return 'after';
  if (value === 'alter') return 'alter';
  return undefined;
}

export interface RandomTextOptions {
  mode: RandomTextMode;
  /** Same seed, same output — so a flow only goes stale when something real changes. */
  seed: string;
  length: LengthTarget;
  /** 0..1 — the share of input words a run is allowed to replace when altering. */
  alterTemperature: number;
  /** 0..1 — randomness of the pick. 0 always takes the best candidate, 1 is loose. */
  pickTemperature: number;
  /** How many previous tokens are allowed to pull on the next one. */
  contextWindow: number;
  /** 0..1 — how fast a token's pull fades across that window. */
  contextDecay: number;
  /** 0..1 — raw frequency versus context weight when scoring a candidate. */
  frequencyBias: number;
  /** 0..1 — how much a context read backwards (`tree` → `apple`) counts. */
  contextSymmetry: number;
  /** 0..1 — how strongly part-of-speech order is enforced. 0 is word soup. */
  grammarBias: number;
  /**
   * 0..1 — how strongly a wired-in grammar database drives the writing. At 0 it
   * is ignored; above that, sentences are written into shapes counted from a
   * corpus, and words are spelled in the form each slot asks for.
   */
  grammarWeight: number;
  /** Average words per sentence the punctuation aims for. */
  sentenceLength: number;
  /** The shortest and longest a written sentence may be, in words. */
  sentenceWords: WordRange;
  /** The size of a phrase written into the text or in place of a word. */
  phraseWords: WordRange;
  /** The size of a fragment: a clause set off by commas. */
  fragmentWords: WordRange;
  /** When writing into the text or replacing a word, how often each size is chosen. */
  units: UnitWeights;
}

export const DEFAULT_LENGTH_TARGET: LengthTarget = {
  mode: 'words',
  words: 80,
  characters: 400,
  wordPercent: 0,
  charPercent: 0,
  temperature: 0.25,
};

export const DEFAULT_RANDOM_TEXT_OPTIONS: RandomTextOptions = {
  mode: 'after',
  seed: 'vibetoon',
  length: { ...DEFAULT_LENGTH_TARGET },
  alterTemperature: 0.35,
  pickTemperature: 0.45,
  contextWindow: 3,
  contextDecay: 0.55,
  frequencyBias: 0.45,
  contextSymmetry: 0.5,
  grammarBias: 0.85,
  grammarWeight: 0.7,
  sentenceLength: 12,
  sentenceWords: { min: 4, max: 30 },
  phraseWords: { min: 2, max: 4 },
  fragmentWords: { min: 3, max: 7 },
  units: { word: 1, phrase: 0.5, fragment: 0.25 },
};

export interface TextFlowData {
  editor: 'text';
  /** Text to work from when nothing is wired into the flow's Text input. */
  input: string;
  /** The last run's result, kept so the editor shows what the artifact holds. */
  output: string;
  options: RandomTextOptions;
  lexicon: Lexicon;
}
