import type { WordType } from '../types/text';

/**
 * The names of the shapes an English word takes: five for a verb, two for a
 * noun, three for an adjective or adverb.
 *
 * This file is only the vocabulary. *Which* spelling a word takes in each of
 * these forms is not worked out here, or anywhere else in this package — it is
 * looked up in a morphology dataset and stored on the lexeme. There used to be a
 * rule engine that guessed, and it was wrong often enough (`forgive` → `forgived`,
 * `cactus` → `cactu`) that guessing was removed rather than improved.
 */

export const VERB_FORMS = [
  'infinitive',
  'third_person_singular',
  'present_progressive',
  'past',
  'past_participle',
] as const;

export const NOUN_FORMS = ['singular', 'plural'] as const;
export const COMPARISON_FORMS = ['positive', 'comparative', 'superlative'] as const;

export type VariationKey =
  | (typeof VERB_FORMS)[number]
  | (typeof NOUN_FORMS)[number]
  | (typeof COMPARISON_FORMS)[number];

/** Which forms a word of each type has. Types not listed do not inflect. */
export const FORMS_FOR_TYPE: Partial<Record<WordType, readonly VariationKey[]>> = {
  verb: VERB_FORMS,
  noun: NOUN_FORMS,
  number: NOUN_FORMS,
  adjective: COMPARISON_FORMS,
  adverb: COMPARISON_FORMS,
};

export type Variations = Partial<Record<VariationKey, string>>;

export const FORM_LABEL: Record<VariationKey, string> = {
  infinitive: 'infinitive',
  third_person_singular: 'third person singular',
  present_progressive: 'present progressive',
  past: 'past',
  past_participle: 'past participle',
  singular: 'singular',
  plural: 'plural',
  positive: 'positive',
  comparative: 'comparative',
  superlative: 'superlative',
};

/** True when a word of this type has other forms at all. */
export function inflects(type: WordType): boolean {
  return FORMS_FOR_TYPE[type] !== undefined;
}

/** The form whose spelling is the word's plain, uninflected one. */
export const BASE_FORM: Partial<Record<WordType, VariationKey>> = {
  verb: 'infinitive',
  noun: 'singular',
  number: 'singular',
  adjective: 'positive',
  adverb: 'positive',
};

/** Which of a word's own forms a spelling is: `cats` in `{singular: cat, plural: cats}` is `plural`. */
export function formIn(variations: Variations | undefined, spelling: string): VariationKey | undefined {
  if (!variations) return undefined;
  const lower = spelling.toLowerCase();
  for (const [form, value] of Object.entries(variations) as Array<[VariationKey, string]>) {
    if (value.toLowerCase() === lower) return form;
  }
  return undefined;
}
