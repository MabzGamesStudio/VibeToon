import { inflect } from '../text/inflect';
import type { WordMeaning } from '../text/corpus';
import { isLookupCandidate } from '../text/corpus';
import type { Lexeme, Lexicon } from '../types/text';

/**
 * A flow that takes a word database in and hands a better one out.
 *
 * The counting that builds a database knows how often a word appears and what
 * follows it, but not what kind of word it is — and word type is what decides
 * whether the grammar flow produces English or soup. That is what a dictionary
 * is for, and asking one is slow, rate-limited and occasionally refused, so it
 * belongs in a flow of its own rather than buried in the counting.
 *
 * The lookups happen in the editor, where there is a progress bar and a Stop
 * button; generating applies what has been learned. That way a run is instant
 * and repeatable, and a half-finished lookup is still worth generating.
 */
export interface DictionaryFlowOptions {
  /** Ask again about a word that already has an answer. */
  refresh: boolean;
  /** Skip words rarer than this, so a long tail does not cost a day. */
  minFrequency: number;
  /** Replace a type the incoming database already had. */
  overwriteTypes: boolean;
  /** Replace a description the incoming database already had. */
  overwriteDescriptions: boolean;
}

export const DEFAULT_DICTIONARY_OPTIONS: DictionaryFlowOptions = {
  refresh: false,
  minFrequency: 0,
  overwriteTypes: true,
  overwriteDescriptions: true,
};

export interface DictionaryFlowData {
  editor: 'dictionary';
  /** Which service this flow asks. Empty means whatever the studio is set to. */
  providerId: string;
  /** What has been learned, by spelling, so it survives the database being rebuilt. */
  meanings: Record<string, WordMeaning>;
  options: DictionaryFlowOptions;
}

export function emptyDictionaryFlowData(): DictionaryFlowData {
  return {
    editor: 'dictionary',
    providerId: '',
    meanings: {},
    options: { ...DEFAULT_DICTIONARY_OPTIONS },
  };
}

/** Words in this database still worth asking about, commonest first. */
export function wordsToLookUp(lexicon: Lexicon, data: DictionaryFlowData): string[] {
  const options = { ...DEFAULT_DICTIONARY_OPTIONS, ...data.options };
  return [...lexicon.lexemes]
    .filter((lexeme) => {
      if (!isLookupCandidate(lexeme.spelling)) return false;
      if (lexeme.frequency < options.minFrequency) return false;
      return options.refresh || data.meanings[lexeme.spelling] === undefined;
    })
    .sort((a, b) => b.frequency - a.frequency)
    .map((lexeme) => lexeme.spelling);
}

/**
 * Put what the dictionary said onto one word.
 *
 * A changed type changes which forms the word has — `saw` as a noun has a
 * plural, as a verb it has five tenses — so the variations are worked out again
 * rather than carried over from the type it used to be.
 */
export function applyMeaning(
  lexeme: Lexeme,
  meaning: WordMeaning | undefined,
  options: DictionaryFlowOptions,
): Lexeme {
  if (!meaning) return lexeme;

  const type = options.overwriteTypes && meaning.type ? meaning.type : lexeme.type;
  const description =
    options.overwriteDescriptions && meaning.description.trim()
      ? meaning.description.trim()
      : lexeme.description;
  if (type === lexeme.type && description === lexeme.description) return lexeme;

  const variations = type === lexeme.type ? lexeme.variations : inflect(lexeme.spelling, type);
  return {
    ...lexeme,
    type,
    description,
    ...(variations ? { variations } : {}),
  };
}

export interface DictionaryApplyResult {
  lexicon: Lexicon;
  /** Words whose type the dictionary changed. */
  retyped: number;
  /** Words that gained a description. */
  described: number;
  /** Words with an answer, of those that could have one. */
  answered: number;
  /** Words still without one. */
  unanswered: number;
}

/** Apply everything learned to a database, and say what it changed. */
export function applyMeaningsToLexicon(
  lexicon: Lexicon,
  data: DictionaryFlowData,
): DictionaryApplyResult {
  const options = { ...DEFAULT_DICTIONARY_OPTIONS, ...data.options };
  let retyped = 0;
  let described = 0;
  let answered = 0;
  let unanswered = 0;

  const lexemes = lexicon.lexemes.map((lexeme) => {
    const meaning = data.meanings[lexeme.spelling];
    if (isLookupCandidate(lexeme.spelling)) {
      if (meaning && meaning.source !== 'inferred') answered += 1;
      else unanswered += 1;
    }
    const next = applyMeaning(lexeme, meaning, options);
    if (next.type !== lexeme.type) retyped += 1;
    if (next.description !== lexeme.description && next.description) described += 1;
    return next;
  });

  return { lexicon: { lexemes }, retyped, described, answered, unanswered };
}

export interface DictionarySummary {
  known: number;
  fromDictionary: number;
  guessed: number;
}

export function summariseDictionary(data: DictionaryFlowData): DictionarySummary {
  const values = Object.values(data.meanings);
  return {
    known: values.length,
    fromDictionary: values.filter((meaning) => meaning.source === 'dictionary').length,
    guessed: values.filter((meaning) => meaning.source === 'inferred').length,
  };
}
