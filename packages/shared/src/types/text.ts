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
  | 'punctuation';

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
   * The other spellings this word takes, keyed by form. Which keys are present
   * depends on the word type: a verb has five, a noun two, an adjective three,
   * and a preposition none at all.
   */
  variations?: Record<string, string>;
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

export interface RandomTextOptions {
  /** `generate` writes new text; `alter` rewrites the text coming in. */
  mode: 'generate' | 'alter';
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
  mode: 'generate',
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
