import type { Lexeme, Lexicon, WordType } from '../types/text';
import { BASE_FORM, formIn, type Variations } from './forms';

/**
 * Turning what a dictionary said into rows of a word database.
 *
 * Two things happen here, and both of them make one spelling into several
 * entries:
 *
 * - **Senses.** A spelling is not a word. `light` is a noun, a verb and an
 *   adjective, and it means something different in each; one row holding the
 *   first of those and throwing the rest away is why a grammar flow would
 *   confidently put `light` where only a noun fits. Every sense a dictionary
 *   reports becomes its own entry, with its own type and its own description.
 *
 * - **Forms.** `cat` and `cats` are the same word, but they are different
 *   spellings, and a database you can read and correct should have a row for
 *   each. So every form in a sense's paradigm becomes an entry too — sharing the
 *   type, the description and the paradigm of the word it is a form of.
 *
 * Nothing here invents anything. A paradigm arrives already looked up in a
 * morphology dataset; a sense arrives already answered by a dictionary. A word
 * neither of them knows stays `unknown`, and says so.
 */

/** Type and description for one of the things a spelling can be. */
export interface WordSense {
  type: WordType;
  description: string;
  /**
   * Every spelling this sense takes, keyed by form, from a morphology dataset.
   * Absent when the dataset has not been asked or has no paradigm for the word —
   * which is not the same as the word having no other forms.
   */
  variations?: Variations;
}

/**
 * What is known about one spelling.
 *
 * `source` says who said so, because that is the difference between a fact and a
 * gap: `token` is read off the token itself — `.` is punctuation and `42` is a
 * number, and no dictionary is needed to confirm either — and `none` records that
 * a dictionary was asked and had nothing, so it is not asked again.
 */
export interface WordMeaning {
  senses: WordSense[];
  source: 'dictionary' | 'manual' | 'token' | 'none';
  /** When it was learned, so an old answer can be told from a fresh one. */
  fetchedAt?: string;
}

export function lexemeIdFor(spelling: string): string {
  const slug = /[a-z0-9]/i.test(spelling)
    ? spelling.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : `p${[...spelling].map((character) => character.charCodeAt(0).toString(16)).join('')}`;
  return `lex_${slug}`;
}

/**
 * An id for one entry, preferring the plain one derived from the spelling.
 *
 * The plain id matters: context links counted out of a corpus point at
 * `lexemeIdFor(word)` and know nothing about senses, so the first sense of a
 * spelling has to keep it or every link into that word breaks. The rest take a
 * suffix.
 */
export function allocateLexemeId(spelling: string, type: WordType, taken: Set<string>): string {
  const base = lexemeIdFor(spelling);
  for (const candidate of [base, `${base}~${type}`]) {
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}~${type}~${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

const UNKNOWN_SENSE: WordSense = { type: 'unknown', description: '' };

/** The senses to build entries from: what was learned, or one honest blank. */
export function sensesOf(meaning: WordMeaning | undefined): WordSense[] {
  const senses = meaning?.senses.filter((sense) => sense.type) ?? [];
  return senses.length > 0 ? senses : [UNKNOWN_SENSE];
}

/**
 * One entry per sense of a spelling.
 *
 * The shared parts — how common it is, what it sits next to, how often it was
 * counted — are the same on every sense, because the counting that produced them
 * could not tell the senses apart. That is honest rather than convenient: the
 * corpus saw `light` four hundred times without recording which `light` it was.
 */
export function expandSenses(
  base: Omit<Lexeme, 'id' | 'type' | 'description' | 'variations'>,
  meaning: WordMeaning | undefined,
  taken: Set<string>,
): Lexeme[] {
  return sensesOf(meaning).map((sense) => {
    const variations = sense.variations;
    const form = formIn(variations, base.spelling);
    return {
      ...base,
      id: allocateLexemeId(base.spelling, sense.type, taken),
      type: sense.type,
      description: sense.description.trim(),
      ...(variations && Object.keys(variations).length > 0 ? { variations } : {}),
      ...(form ? { form } : {}),
    };
  });
}

export interface VariantExpansion {
  lexicon: Lexicon;
  /** Forms that became new entries because nothing in the database had them. */
  added: number;
  /**
   * Forms the database already held — counted from the corpus in their own
   * right. They keep their counts and links and gain the paradigm, and the
   * description, of the word they are a form of.
   */
  linked: number;
  /**
   * Of those, the ones that were still `unknown` and have been given the type of
   * the word they turn out to be a form of.
   */
  adopted: number;
}

function sameSpelling(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Give every form of every word an entry of its own.
 *
 * A form the corpus already counted is left where it is: it has a real count and
 * real context links, and overwriting those with a derived entry would throw away
 * the only measurements in the database. It is only filled in — the paradigm it
 * belongs to, and a description if it had none.
 *
 * A form the corpus never saw is added with a count of nought, because that is
 * what it was: the text did not contain it. It is there to be read and corrected,
 * not to be picked — generation spells a slot from the paradigm of the word it
 * chose, so a form does not need a frequency of its own to be reachable.
 *
 * The awkward case is a form the corpus counted but nobody looked up, which is
 * most of them: the text contained `walked` four times, and its type is still
 * unknown. Adding a second, typed `walked` beside it would leave the only real
 * measurement in the database on the row the grammar cannot use. So an `unknown`
 * row is *adopted* instead — given the type of the word it turns out to be a form
 * of. That is not a guess: the dataset says `walked` is the past of `walk`, and
 * the dictionary says this `walk` is a verb.
 */
export function expandVariants(lexicon: Lexicon): VariantExpansion {
  const keyOf = (spelling: string, type: WordType) => `${spelling.toLowerCase()}|${type}`;
  const taken = new Set(lexicon.lexemes.map((lexeme) => lexeme.id));

  const result: Lexeme[] = lexicon.lexemes.map((lexeme) => ({ ...lexeme }));
  const byKey = new Map(result.map((lexeme) => [keyOf(lexeme.spelling, lexeme.type), lexeme]));
  const added: Lexeme[] = [];
  let linked = 0;
  let adopted = 0;

  for (const lexeme of result) {
    // A form does not have forms of its own: `cats` would otherwise re-derive
    // `cat` and the pair would keep rediscovering each other.
    if (lexeme.variantOf) continue;
    const variations = lexeme.variations;
    if (!variations || lexeme.type === 'unknown') continue;

    // Only the word a paradigm is *of* expands it. Without this the row that got
    // there first in the array becomes the root, so which of `walk` and `walked`
    // is the base form would depend on how common each happened to be.
    const base = BASE_FORM[lexeme.type];
    const lemma = base ? variations[base] : undefined;
    if (lemma && !sameSpelling(lemma, lexeme.spelling)) continue;

    for (const [form, spelling] of Object.entries(variations)) {
      if (!spelling.trim() || sameSpelling(spelling, lexeme.spelling)) continue;

      const sameType = byKey.get(keyOf(spelling, lexeme.type));
      const untyped = sameType ? undefined : byKey.get(keyOf(spelling, 'unknown'));
      const existing = sameType ?? untyped;

      if (existing) {
        if (existing.id === lexeme.id) continue;
        // `walked` is both the past and the past participle of `walk`. It is one
        // row either way, and it keeps the first form that named it.
        if (existing.variantOf === lexeme.id) continue;
        if (untyped) {
          byKey.delete(keyOf(spelling, 'unknown'));
          existing.type = lexeme.type;
          adopted += 1;
        }
        existing.variations = variations;
        existing.variantOf = lexeme.id;
        existing.form = form;
        if (!existing.description) existing.description = lexeme.description;
        byKey.set(keyOf(spelling, existing.type), existing);
        linked += 1;
        continue;
      }

      const variant: Lexeme = {
        id: allocateLexemeId(spelling, lexeme.type, taken),
        spelling,
        type: lexeme.type,
        frequency: 0,
        description: lexeme.description,
        contexts: [],
        variations,
        variantOf: lexeme.id,
        form,
        stats: { count: 0, perMillion: 0 },
      };
      byKey.set(keyOf(spelling, lexeme.type), variant);
      added.push(variant);
    }
  }

  return { lexicon: { lexemes: [...result, ...added] }, added: added.length, linked, adopted };
}

/** The other entries that are the same spelling read a different way. */
export function otherSenses(lexicon: Lexicon, lexeme: Lexeme): Lexeme[] {
  return lexicon.lexemes.filter(
    (candidate) =>
      candidate.id !== lexeme.id &&
      !candidate.variantOf &&
      !lexeme.variantOf &&
      sameSpelling(candidate.spelling, lexeme.spelling),
  );
}

/** The entries that are forms of this one, plus the one it is a form of. */
export function formFamily(lexicon: Lexicon, lexeme: Lexeme): Lexeme[] {
  const rootId = lexeme.variantOf ?? lexeme.id;
  return lexicon.lexemes.filter(
    (candidate) => candidate.id !== lexeme.id && (candidate.id === rootId || candidate.variantOf === rootId),
  );
}

/* ------------------------------------------------------------------ *
 * Reading what older projects stored
 * ------------------------------------------------------------------ */

/** What a project saved before a spelling could have more than one meaning. */
interface LegacyMeaning {
  type?: WordType;
  description?: string;
  source?: 'dictionary' | 'inferred' | 'manual' | 'token' | 'none';
  senses?: WordSense[];
  fetchedAt?: string;
}

/**
 * Bring a stored meanings table up to date.
 *
 * Two things change on the way through. A single type and description becomes a
 * list of one sense. And anything that was *inferred* — guessed from the word's
 * ending by code that no longer exists — is thrown away rather than carried
 * forward, because a guess dressed as an answer is the thing this release is
 * getting rid of. The word goes back to being unlooked-up and will be asked about
 * on the next run, which is the honest state for it to be in.
 *
 * Marks and numbers are the exception: `.` was only ever tagged `inferred`
 * because there was nothing better to call it, so they come through as `token`.
 */
export function normaliseMeanings(stored: Record<string, unknown> | undefined): {
  meanings: Record<string, WordMeaning>;
  /** How many guessed entries were discarded, for the run log to mention. */
  discarded: number;
  changed: boolean;
} {
  const meanings: Record<string, WordMeaning> = {};
  let discarded = 0;
  let changed = false;

  for (const [spelling, value] of Object.entries(stored ?? {})) {
    const legacy = value as LegacyMeaning;
    if (Array.isArray(legacy.senses)) {
      const source = legacy.source;
      meanings[spelling] = {
        senses: legacy.senses,
        source: source === undefined || source === 'inferred' ? 'dictionary' : source,
        ...(legacy.fetchedAt ? { fetchedAt: legacy.fetchedAt } : {}),
      };
      if (source === 'inferred') changed = true;
      continue;
    }

    changed = true;
    const type = legacy.type;
    if (!type) continue;
    const isToken = type === 'punctuation' || type === 'number';
    if (legacy.source === 'inferred' && !isToken) {
      discarded += 1;
      continue;
    }
    const source = legacy.source;
    meanings[spelling] = {
      senses: [{ type, description: legacy.description ?? '' }],
      source:
        source === undefined || source === 'inferred' ? (isToken ? 'token' : 'dictionary') : source,
      ...(legacy.fetchedAt ? { fetchedAt: legacy.fetchedAt } : {}),
    };
  }

  return { meanings, discarded, changed };
}
