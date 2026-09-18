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
import { buildLexiconIndex, formOfLexeme, variationsOf, type LexiconIndex } from './lexicon';
import type { TextToken } from './tokenize';

export interface TokenGloss {
  /** `noun:plural`, `punctuation:.`, `determiner`, `?`. */
  label: string;
  /** Whether this word's type inflects at all. A determiner never does. */
  hasVariants: boolean;
  /** The word database has no entry for this token. */
  unknown: boolean;
  type?: WordType;
  /** Which form the spelling is, when that can be worked out. */
  form?: string;
  /** Every form the word takes, for a tooltip. */
  variations?: Record<string, string>;
}

export function glossToken(token: TextToken, index: LexiconIndex): TokenGloss {
  if (token.kind === 'break') {
    return { label: token.text, hasVariants: false, unknown: false };
  }
  if (token.kind === 'punctuation') {
    return { label: `punctuation:${token.text}`, hasVariants: false, unknown: false, type: 'punctuation' };
  }

  const lexeme = index.bySpelling.get(token.key)?.[0];
  if (!lexeme) {
    // Written by the run but absent from the database: nothing can be said about
    // its type, which is itself worth seeing.
    return { label: `?:${token.text}`, hasVariants: false, unknown: true };
  }

  const variations = variationsOf(lexeme);
  const form = formOfLexeme(lexeme);
  return {
    label: form ? `${lexeme.type}:${form}` : lexeme.type,
    hasVariants: variations !== undefined,
    unknown: false,
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
  /** Words whose type inflects, and which therefore carry variations. */
  withVariants: number;
  /** Words whose type has no forms at all: determiners, prepositions. */
  withoutVariants: number;
  /** Words the database has never seen. */
  unknown: number;
}

export function summariseGloss(glosses: readonly TokenGloss[]): GlossSummary {
  const words = glosses.filter((gloss) => gloss.type !== 'punctuation' && gloss.label !== '\n');
  return {
    words: words.length,
    withVariants: words.filter((gloss) => gloss.hasVariants).length,
    withoutVariants: words.filter((gloss) => !gloss.hasVariants && !gloss.unknown).length,
    unknown: words.filter((gloss) => gloss.unknown).length,
  };
}
