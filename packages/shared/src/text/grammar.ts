import type { WordType } from '../types/text';

/**
 * How readily one kind of word follows another. This is a blunt instrument —
 * English grammar it is not — but it is enough to keep `the quiet kitchen` from
 * coming out as `the the quiet of`, and the flow's `grammarBias` option turns it
 * off entirely for anyone who wants pure word soup.
 */
export type FollowFrom = WordType | 'start';

const DEFAULT_FOLLOW = 0.08;

const FOLLOW: Record<FollowFrom, Partial<Record<WordType, number>>> = {
  start: {
    determiner: 0.9,
    pronoun: 0.8,
    noun: 0.7,
    adjective: 0.5,
    adverb: 0.4,
    verb: 0.3,
    interjection: 0.3,
    number: 0.3,
    preposition: 0.2,
    conjunction: 0.1,
    punctuation: 0.02,
  },
  determiner: { noun: 1, adjective: 0.9, number: 0.5, adverb: 0.2, punctuation: 0.02 },
  adjective: { noun: 1, adjective: 0.5, punctuation: 0.25, adverb: 0.12, conjunction: 0.2 },
  noun: {
    verb: 0.8,
    punctuation: 0.8,
    preposition: 0.8,
    conjunction: 0.5,
    noun: 0.35,
    adverb: 0.3,
    adjective: 0.1,
    pronoun: 0.05,
    determiner: 0.05,
    number: 0.05,
  },
  pronoun: { verb: 1, adverb: 0.4, punctuation: 0.3, preposition: 0.2, noun: 0.1 },
  verb: {
    determiner: 0.75,
    preposition: 0.8,
    noun: 0.7,
    adverb: 0.7,
    pronoun: 0.6,
    punctuation: 0.5,
    adjective: 0.5,
    number: 0.3,
    verb: 0.3,
    conjunction: 0.2,
  },
  adverb: { verb: 0.9, adjective: 0.7, punctuation: 0.4, adverb: 0.25, determiner: 0.3, preposition: 0.3 },
  preposition: { determiner: 1, noun: 0.8, pronoun: 0.6, adjective: 0.5, number: 0.4, punctuation: 0.02 },
  conjunction: { determiner: 0.8, noun: 0.7, pronoun: 0.7, verb: 0.6, adjective: 0.5, adverb: 0.3, punctuation: 0.02 },
  number: { noun: 1, punctuation: 0.4, preposition: 0.2, conjunction: 0.2 },
  interjection: { punctuation: 0.9, pronoun: 0.4, determiner: 0.3, noun: 0.2 },
  punctuation: {
    determiner: 0.8,
    pronoun: 0.8,
    noun: 0.7,
    conjunction: 0.5,
    adverb: 0.4,
    adjective: 0.4,
    verb: 0.4,
    number: 0.3,
    preposition: 0.3,
    interjection: 0.2,
    punctuation: 0.02,
  },
};

export function followWeight(from: FollowFrom | undefined, to: WordType): number {
  const row = FOLLOW[from ?? 'start'];
  return row[to] ?? DEFAULT_FOLLOW;
}
