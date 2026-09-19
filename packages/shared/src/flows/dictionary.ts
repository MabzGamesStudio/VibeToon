import { isLookupCandidate } from '../text/corpus';
import {
  allocateLexemeId,
  expandVariants,
  sensesOf,
  type WordMeaning,
  type WordSense,
} from '../text/senses';
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
 * This flow is also where a word's *forms* arrive, from a morphology dataset
 * rather than a dictionary — no dictionary API returns inflections, and working
 * them out by rule was wrong too often to keep.
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
  /**
   * Give a spelling with several meanings an entry per meaning: `light` becomes a
   * noun, a verb and an adjective, each with its own description. Off, only the
   * first sense the service reported is kept.
   */
  splitSenses: boolean;
  /**
   * Give every form of a word an entry of its own, so `cat` also puts `cats` in
   * the database. Off, the forms are still stored on the word they belong to and
   * still used for spelling; they just do not get rows.
   */
  addVariants: boolean;
}

export const DEFAULT_DICTIONARY_OPTIONS: DictionaryFlowOptions = {
  refresh: false,
  minFrequency: 0,
  overwriteTypes: true,
  overwriteDescriptions: true,
  splitSenses: true,
  addVariants: true,
};

export interface DictionaryFlowData {
  editor: 'dictionary';
  /** Which service this flow asks. Empty means whatever the studio is set to. */
  providerId: string;
  /** Which morphology dataset the forms come from. Empty means the studio's choice. */
  morphologyId: string;
  /** What has been learned, by spelling, so it survives the database being rebuilt. */
  meanings: Record<string, WordMeaning>;
  options: DictionaryFlowOptions;
}

export function emptyDictionaryFlowData(): DictionaryFlowData {
  return {
    editor: 'dictionary',
    providerId: '',
    morphologyId: '',
    meanings: {},
    options: { ...DEFAULT_DICTIONARY_OPTIONS },
  };
}

/** Words in this database still worth asking about, commonest first. */
export function wordsToLookUp(lexicon: Lexicon, data: DictionaryFlowData): string[] {
  const options = { ...DEFAULT_DICTIONARY_OPTIONS, ...data.options };
  const seen = new Set<string>();
  return [...lexicon.lexemes]
    .filter((lexeme) => {
      // A form that was added from another word's paradigm is not a word this
      // flow needs to ask about: its type and description came with it.
      if (lexeme.variantOf) return false;
      if (!isLookupCandidate(lexeme.spelling)) return false;
      if (lexeme.frequency < options.minFrequency) return false;
      if (seen.has(lexeme.spelling)) return false;
      seen.add(lexeme.spelling);
      return options.refresh || data.meanings[lexeme.spelling] === undefined;
    })
    .sort((a, b) => b.frequency - a.frequency)
    .map((lexeme) => lexeme.spelling);
}

/** The senses to build entries from, honouring the split setting. */
function sensesToApply(meaning: WordMeaning | undefined, options: DictionaryFlowOptions): WordSense[] {
  const senses = sensesOf(meaning);
  return options.splitSenses ? senses : senses.slice(0, 1);
}

/**
 * Put one sense onto one entry.
 *
 * A changed type changes which forms the word has — `saw` as a noun has a plural,
 * as a verb it has five tenses — so the paradigm has to follow the type. Keeping
 * the old one across a retype is how a noun ends up listing five tenses; taking
 * the sense's when the entry kept its own type is how a verb ends up with a
 * plural.
 */
export function applySense(
  lexeme: Lexeme,
  sense: WordSense,
  options: DictionaryFlowOptions,
): Lexeme {
  const type = options.overwriteTypes && sense.type !== 'unknown' ? sense.type : lexeme.type;
  const description =
    options.overwriteDescriptions && sense.description.trim()
      ? sense.description.trim()
      : lexeme.description;

  const variations =
    type === sense.type
      ? sense.variations
      : type === lexeme.type
        ? lexeme.variations
        : // Retyped to something neither the entry nor the answer describes: no
          // forms is right, because the wrong ones would be believed.
          undefined;

  const next: Lexeme = { ...lexeme, type, description };
  if (variations && Object.keys(variations).length > 0) next.variations = variations;
  else delete next.variations;
  delete next.form;
  delete next.variantOf;
  return next;
}

export interface DictionaryApplyResult {
  lexicon: Lexicon;
  /** Words whose type the dictionary changed. */
  retyped: number;
  /** Words that gained a description. */
  described: number;
  /** Extra entries added because a spelling turned out to have several meanings. */
  split: number;
  /** Entries added because they are a form of another word. */
  variants: number;
  /** Forms the corpus had already counted, now joined up with their paradigm. */
  linkedVariants: number;
  /** Words with an answer, of those that could have one. */
  answered: number;
  /** Words still without one. */
  unanswered: number;
  /** Words whose forms no morphology dataset could supply. */
  formless: number;
}

/**
 * Apply everything learned to a database, and say what it changed.
 *
 * One entry can become several here, which is the point: a spelling is not a
 * word. Entries the database already holds keep their ids so the context links
 * pointing at them survive; the extra senses take new ones.
 */
export function applyMeaningsToLexicon(
  lexicon: Lexicon,
  data: DictionaryFlowData,
): DictionaryApplyResult {
  const options = { ...DEFAULT_DICTIONARY_OPTIONS, ...data.options };
  let retyped = 0;
  let described = 0;
  let split = 0;
  let answered = 0;
  let unanswered = 0;
  let formless = 0;

  const taken = new Set(lexicon.lexemes.map((lexeme) => lexeme.id));

  /*
   * Grouped by spelling, because that is how the answers are keyed.
   *
   * Walking the rows instead looks simpler and is wrong: a spelling that an
   * earlier run already split has several rows, and each of them would have the
   * whole answer applied to it, so the row for `watches` the verb got written out
   * once for itself and again when the row for `watches` the noun came round.
   * Both copies carried the same id.
   */
  const groups = new Map<string, Lexeme[]>();
  const order: string[] = [];
  for (const lexeme of lexicon.lexemes) {
    const existing = groups.get(lexeme.spelling);
    if (existing) existing.push(lexeme);
    else {
      groups.set(lexeme.spelling, [lexeme]);
      order.push(lexeme.spelling);
    }
  }

  const lexemes: Lexeme[] = [];
  const rebuilt = new Set<string>();

  for (const spelling of order) {
    const rows = groups.get(spelling)!;
    const roots = rows.filter((row) => !row.variantOf);
    const forms = rows.filter((row) => row.variantOf);

    const meaning = data.meanings[spelling];
    const senses = meaning ? sensesToApply(meaning, options) : [];
    const real = senses.filter((sense) => sense.type !== 'unknown' || sense.description.trim());

    if (isLookupCandidate(spelling) && roots.length > 0) {
      if (meaning && meaning.source !== 'none' && real.length > 0) answered += 1;
      else unanswered += 1;
    }

    /*
     * Nothing was learned about this word, so every row of it is left exactly as
     * it is.
     *
     * This matters more than it looks: a word database arriving here already has
     * types, descriptions and forms on most of its rows, put there by an earlier
     * run or by hand. Running the words this flow *has* answers for must not reset
     * everything else to unknown and strip its forms.
     */
    if (real.length === 0) {
      lexemes.push(...rows);
      for (const row of forms) rebuilt.add(row.id);
      continue;
    }

    // The forms are rebuilt below from whatever the words they belong to now say.
    for (const row of forms) {
      lexemes.push(row);
      rebuilt.add(row.id);
    }

    const claimed = new Set<string>();
    for (const [index, sense] of real.entries()) {
      // The row whose type this sense already is claims it; failing that the
      // first sense takes the first row, so the corpus's links keep their target.
      const owner =
        roots.find((row) => row.type === sense.type && !claimed.has(row.id)) ??
        (index === 0 ? roots.find((row) => !claimed.has(row.id)) : undefined);
      if (owner) claimed.add(owner.id);
      else split += 1;

      const base = owner ?? { ...roots[0]!, id: allocateLexemeId(spelling, sense.type, taken) };
      const next = applySense(base, sense, options);
      if (next.type !== base.type) retyped += 1;
      if (next.description !== base.description && next.description) described += 1;
      if (sense.type !== 'unknown' && !next.variations) formless += 1;
      lexemes.push(next);
    }

    // A row for a sense this answer did not mention is left alone rather than
    // dropped: the flow improves a database, it does not prune one.
    for (const row of roots) {
      if (!claimed.has(row.id)) lexemes.push(row);
    }
  }

  /*
   * A derived row whose word has moved on is dropped. `walks` was the plural of
   * `walk` while `walk` was a noun; now that `walk` is a verb it is the third
   * person singular, and the old row describes nothing. Only rows the corpus never
   * counted go — one with a count of its own is a word in its own right, and it
   * just stops claiming to be a form.
   */
  const byId = new Map(lexemes.map((lexeme) => [lexeme.id, lexeme]));
  const kept = lexemes.filter((lexeme) => {
    if (!lexeme.variantOf || !rebuilt.has(lexeme.id)) return true;
    const root = byId.get(lexeme.variantOf);
    if (root && root.type === lexeme.type) return true;
    if ((lexeme.stats?.count ?? 0) > 0 || lexeme.frequency > 0) {
      delete lexeme.variantOf;
      delete lexeme.form;
      return true;
    }
    return false;
  });

  if (!options.addVariants) {
    return {
      lexicon: { lexemes: kept },
      retyped,
      described,
      split,
      variants: 0,
      linkedVariants: 0,
      answered,
      unanswered,
      formless,
    };
  }

  const expanded = expandVariants({ lexemes: kept });
  return {
    lexicon: expanded.lexicon,
    retyped,
    described,
    split,
    variants: expanded.added,
    linkedVariants: expanded.linked,
    answered,
    unanswered,
    formless,
  };
}

export interface DictionarySummary {
  /** Spellings with an answer of some kind. */
  known: number;
  /** Spellings a dictionary defined. */
  fromDictionary: number;
  /** Spellings a dictionary was asked about and had no entry for. */
  absent: number;
  /** Senses held across all spellings — more than `known` when words have several. */
  senses: number;
  /** Spellings with more than one sense. */
  multiSense: number;
  /** Spellings whose forms a morphology dataset supplied. */
  withForms: number;
}

export function summariseDictionary(data: DictionaryFlowData): DictionarySummary {
  const values = Object.values(data.meanings);
  return {
    known: values.length,
    fromDictionary: values.filter((meaning) => meaning.source === 'dictionary').length,
    absent: values.filter((meaning) => meaning.source === 'none').length,
    senses: values.reduce((sum, meaning) => sum + meaning.senses.length, 0),
    multiSense: values.filter((meaning) => meaning.senses.length > 1).length,
    withForms: values.filter((meaning) =>
      meaning.senses.some((sense) => sense.variations && Object.keys(sense.variations).length > 0),
    ).length,
  };
}
