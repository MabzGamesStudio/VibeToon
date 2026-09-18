/**
 * TEMPORARY — a debugging aid for the Random Text flow.
 *
 * Reads a run's output back against the word database and says what each token
 * *is* rather than what it says: `cats` becomes `noun:plural`. It exists to make
 * two invisible things visible — whether a word's type is right, and whether it
 * has variations at all — because both decide what the grammar flow can do with
 * it, and neither shows up in the finished text.
 *
 * To remove: delete this file, its export from `index.ts`, its test, and the
 * `gloss` toggle in `TextEditor.tsx`. Nothing else imports it.
 */
import type { Lexicon, WordType } from '../types/text';
import { buildLexiconIndex, formOfLexeme, formsState, variationsOf, type LexiconIndex } from './lexicon';
import type { TextToken } from './tokenize';

export interface TokenGloss {
  /** `noun:plural`, `punctuation:.`, `determiner`, `?:flywheel`. */
  label: string;
  /** Whether the forms of this word are known. */
  hasVariants: boolean;
  /** The word database has no entry for this token at all. */
  unknown: boolean;
  /**
   * The database has the word but nobody has looked it up, so its type — and so
   * its forms — are not known. Different from a determiner, which has no forms
   * because determiners do not have any.
   */
  notLookedUp: boolean;
  /** The word's type has other forms, but the forms dataset had none for it. */
  formsMissing: boolean;
  type?: WordType;
  /** Which form the spelling is, when that can be worked out. */
  form?: string;
  /** Every form the word takes, for a tooltip. */
  variations?: Record<string, string>;
}

export function glossToken(token: TextToken, index: LexiconIndex): TokenGloss {
  const blank = { hasVariants: false, unknown: false, notLookedUp: false, formsMissing: false };
  if (token.kind === 'break') return { ...blank, label: token.text };
  if (token.kind === 'punctuation') {
    return { ...blank, label: `punctuation:${token.text}`, type: 'punctuation' };
  }

  const lexeme = index.bySpelling.get(token.key)?.[0];
  if (!lexeme) {
    // Written by the run but absent from the database: nothing can be said about
    // its type, which is itself worth seeing.
    return { ...blank, label: `?:${token.text}`, unknown: true };
  }

  const variations = variationsOf(lexeme);
  const form = formOfLexeme(lexeme);
  const state = formsState(lexeme);
  return {
    label: form ? `${lexeme.type}:${form}` : lexeme.type,
    hasVariants: state === 'known',
    unknown: false,
    notLookedUp: lexeme.type === 'unknown',
    formsMissing: state === 'not-looked-up' && lexeme.type !== 'unknown',
    type: lexeme.type,
    ...(form ? { form } : {}),
    ...(variations ? { variations } : {}),
  };
}

export function glossTokens(tokens: readonly TextToken[], lexicon: Lexicon): TokenGloss[] {
  const index = buildLexiconIndex(lexicon);
  return tokens.map((token) => glossToken(token, index));
}

export interface GlossSummary {
  words: number;
  /** Words whose forms are known. */
  withVariants: number;
  /** Words whose type has no forms at all: determiners, prepositions. */
  withoutVariants: number;
  /** Words the database has never seen. */
  unknown: number;
  /** Words in the database that no dictionary has been asked about. */
  notLookedUp: number;
  /** Words that should have forms, and for which the dataset had none. */
  formsMissing: number;
}

export function summariseGloss(glosses: readonly TokenGloss[]): GlossSummary {
  const words = glosses.filter((gloss) => gloss.type !== 'punctuation' && !/^\s+$/.test(gloss.label));
  return {
    words: words.length,
    withVariants: words.filter((gloss) => gloss.hasVariants).length,
    withoutVariants: words.filter(
      (gloss) => !gloss.hasVariants && !gloss.unknown && !gloss.notLookedUp && !gloss.formsMissing,
    ).length,
    unknown: words.filter((gloss) => gloss.unknown).length,
    notLookedUp: words.filter((gloss) => gloss.notLookedUp).length,
    formsMissing: words.filter((gloss) => gloss.formsMissing).length,
  };
}
