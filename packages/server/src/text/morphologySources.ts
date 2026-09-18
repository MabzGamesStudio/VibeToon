/**
 * Where the forms of a word come from.
 *
 * No dictionary API returns inflections. Free Dictionary, Wiktionary's REST
 * endpoint, Datamuse, Merriam-Webster and Wordnik all answer "what kind of word
 * is this and what does it mean" and none of them answer "what is its past
 * tense". So the forms come from a morphology *dataset* instead: one file,
 * downloaded once, indexed locally, and thereafter answered from disk.
 *
 * Both sources here are free, need no key and no registration, and are the
 * reference datasets in this area rather than anybody's guess. They disagree in
 * places, which is why both are offered: AGID is generated from a large word list
 * and errs towards listing a form, so it has `beautifuler`; SPECIALIST is a
 * curated medical-NLP lexicon and errs towards leaving one out, so `beautiful`
 * has no comparative in it at all. Neither is wrong so much as differently
 * cautious.
 *
 * What is *not* here is a rule engine. There used to be one, and it produced
 * `forgived`, `understanded` and — via a plural-stripping rule that could not
 * tell `cactus` from `bonus` — the non-word `cactu`. Guessing was removed rather
 * than improved.
 */
import { gunzipSync } from 'node:zlib';
import type { VariationKey, Variations } from '@vibetoon/shared';

/**
 * Which set of forms a word has. A dataset cannot always tell an adjective from
 * an adverb — AGID files both under `A` — but it does not need to: they take the
 * same three forms, and the dictionary is what says which of the two a word is.
 */
export type MorphFamily = 'noun' | 'verb' | 'comparable';

/** One word's complete set of spellings, as a dataset gives them. */
export interface Paradigm {
  lemma: string;
  family: MorphFamily;
  forms: Variations;
  /**
   * False when the dataset found the forms but could not confirm the word is of
   * this kind — AGID writes that as `N?` rather than `N`.
   *
   * It is what settles an ambiguous lookup. `crises` is listed as the plural of
   * `crisis`, and also of `cris` and `crise`, which are not words: the difference
   * is that only `crisis` carries a confirmed part of speech. Without this the
   * answer depends on which of the three the index happened to see first, and
   * `crises` gets a singular of `cris`.
   */
  certain: boolean;
}

export interface MorphologySource {
  id: string;
  label: string;
  /** What it is, where it came from, and what it is cautious about. */
  note: string;
  /** Where to read about it. */
  homeUrl: string;
  /** The file to download. */
  url: string;
  gzip: boolean;
  /** Roughly how big the download is, so a slow connection is not a surprise. */
  approxBytes: number;
  /** Turn the whole file into paradigms. Lines it cannot read are skipped. */
  parse(text: string): Paradigm[];
}

/* ------------------------------------------------------------------ *
 * AGID
 * ------------------------------------------------------------------ */

/**
 * `<word><sp><pos>[?]:<sp><inflected forms>`, forms separated by ` | ` and
 * alternatives within a form by `, `. Each alternative may carry tags and a
 * variant level: `cactus N: cacti, cactuses 1, cactus 1.1`.
 *
 * Only clean alternatives are taken. A `!` means the dataset thinks the form
 * belongs to a *different* word, `~` and `<` mean it is only probably an
 * inflection of this one, and `?` means it was not in the word list at all —
 * each of those is the dataset guessing, which is the thing being avoided. A
 * variant level of 2 means archaic, obscure, or "looked plausible but I found no
 * evidence", so those go too; level 0 and 1 stay, 0 first.
 */
const AGID_ENTRY = /^([A-Za-z][A-Za-z'’-]*)([~<!?]*)(?:\s+([\d.]+))?(?:\s+\{[^}]*\})?$/;

interface AgidAlternative {
  spelling: string;
  level: number;
}

function readAgidSlot(slot: string): string | undefined {
  const accepted: AgidAlternative[] = [];
  for (const raw of slot.split(',')) {
    const match = AGID_ENTRY.exec(raw.trim());
    if (!match) continue;
    const [, spelling, tags, level] = match;
    if (tags) continue;
    const parsed = level === undefined ? 0 : Number.parseFloat(level);
    if (!Number.isFinite(parsed) || Math.floor(parsed) >= 2) continue;
    accepted.push({ spelling: spelling!, level: parsed });
  }
  accepted.sort((a, b) => a.level - b.level);
  return accepted[0]?.spelling;
}

/**
 * `be` is the one word whose entry does not follow the pattern, and it is far too
 * common to skip. AGID documents its eight fields as: past 1st & 3rd singular,
 * past 2nd singular & plural, past participle, present participle, present 1st
 * singular, 2nd singular, 3rd singular, plural present.
 */
function readAgidBe(slots: string[]): Variations | undefined {
  if (slots.length !== 8) return undefined;
  const at = (index: number) => readAgidSlot(slots[index] ?? '');
  const forms: Variations = { infinitive: 'be' };
  const third = at(6);
  const progressive = at(3);
  const past = at(0);
  const participle = at(2);
  if (third) forms.third_person_singular = third;
  if (progressive) forms.present_progressive = progressive;
  if (past) forms.past = past;
  if (participle) forms.past_participle = participle;
  return forms;
}

export function parseAgid(text: string): Paradigm[] {
  const paradigms: Paradigm[] = [];

  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const space = head.lastIndexOf(' ');
    if (space < 0) continue;
    const lemma = head.slice(0, space).trim().toLowerCase();
    // A `?` after the part of speech means the word's own part of speech was not
    // in AGID's database, only its forms were. The forms are still the dataset's,
    // so they are kept — but an entry without the `?` is better evidence, and
    // that is what tells `crisis` from `cris`.
    const tagged = head.slice(space + 1).trim();
    const certain = !tagged.endsWith('?');
    const pos = tagged.replace('?', '').trim();
    if (!lemma) continue;
    const slots = line.slice(colon + 1).split('|').map((slot) => slot.trim());

    if (pos === 'N') {
      const plural = readAgidSlot(slots[0] ?? '');
      if (!plural) continue;
      paradigms.push({ lemma, family: 'noun', forms: { singular: lemma, plural }, certain });
      continue;
    }

    if (pos === 'A') {
      const comparative = readAgidSlot(slots[0] ?? '');
      const superlative = readAgidSlot(slots[1] ?? '');
      if (!comparative && !superlative) continue;
      paradigms.push({
        lemma,
        family: 'comparable',
        forms: {
          positive: lemma,
          ...(comparative ? { comparative } : {}),
          ...(superlative ? { superlative } : {}),
        },
        certain,
      });
      continue;
    }

    if (pos !== 'V') continue;

    if (lemma === 'be') {
      const forms = readAgidBe(slots);
      if (forms) paradigms.push({ lemma, family: 'verb', forms, certain });
      continue;
    }

    // Four fields spell the past participle out; three mean it is the same
    // spelling as the past. Anything else is one of the handful of hand-written
    // oddities, and a wrong reading of it is worse than no entry.
    const order: VariationKey[][] =
      slots.length === 4
        ? [['past'], ['past_participle'], ['present_progressive'], ['third_person_singular']]
        : slots.length === 3
          ? [['past', 'past_participle'], ['present_progressive'], ['third_person_singular']]
          : [];
    if (order.length === 0) continue;

    const forms: Variations = { infinitive: lemma };
    let any = false;
    order.forEach((keys, index) => {
      const spelling = readAgidSlot(slots[index] ?? '');
      if (!spelling) return;
      for (const key of keys) forms[key] = spelling;
      any = true;
    });
    if (any) paradigms.push({ lemma, family: 'verb', forms, certain });
  }

  return paradigms;
}

/* ------------------------------------------------------------------ *
 * SPECIALIST, via LemmInflect's lookup table
 * ------------------------------------------------------------------ */

/**
 * `word,pos,form[,form...]` with `/` between alternatives and an empty field
 * where a verb's past participle matches its past. `beautiful,adj,,` is the
 * dataset saying, deliberately, that `beautiful` has no inflected comparative.
 */
const SPECIALIST_FAMILY: Record<string, MorphFamily> = {
  noun: 'noun',
  verb: 'verb',
  adj: 'comparable',
  adv: 'comparable',
};

function firstAlternative(field: string | undefined): string | undefined {
  const spelling = (field ?? '').split('/')[0]?.trim();
  return spelling ? spelling : undefined;
}

export function parseSpecialist(text: string): Paradigm[] {
  const paradigms: Paradigm[] = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [word, pos, ...fields] = line.split(',');
    const lemma = (word ?? '').trim().toLowerCase();
    const family = SPECIALIST_FAMILY[(pos ?? '').trim()];
    if (!lemma || !family) continue;

    if (family === 'noun') {
      const plural = firstAlternative(fields[0]);
      if (!plural) continue;
      paradigms.push({ lemma, family, forms: { singular: lemma, plural }, certain: true });
      continue;
    }

    if (family === 'comparable') {
      const comparative = firstAlternative(fields[0]);
      const superlative = firstAlternative(fields[1]);
      if (!comparative && !superlative) continue;
      paradigms.push({
        lemma,
        family,
        forms: {
          positive: lemma,
          ...(comparative ? { comparative } : {}),
          ...(superlative ? { superlative } : {}),
        },
        certain: true,
      });
      continue;
    }

    const past = firstAlternative(fields[0]);
    const participle = firstAlternative(fields[1]) ?? past;
    const progressive = firstAlternative(fields[2]);
    const third = firstAlternative(fields[3]);
    if (!past && !progressive && !third) continue;
    paradigms.push({
      lemma,
      family,
      forms: {
        infinitive: lemma,
        ...(third ? { third_person_singular: third } : {}),
        ...(progressive ? { present_progressive: progressive } : {}),
        ...(past ? { past } : {}),
        ...(participle ? { past_participle: participle } : {}),
      },
      // Every row in a curated lexicon states its part of speech outright.
      certain: true,
    });
  }

  return paradigms;
}

export const MORPHOLOGY_SOURCES: MorphologySource[] = [
  {
    id: 'agid',
    label: 'AGID',
    note: 'Kevin Atkinson’s Automatically Generated Inflection Database, the reference set in this area — 112,000 words, no key, public domain. Broad: it lists a form wherever its word list had one, so a few of them (`beautifuler`) are words nobody writes. Forms it marks as doubtful are not taken.',
    homeUrl: 'http://wordlist.aspell.net/other',
    url: 'https://raw.githubusercontent.com/en-wl/wordlist/master/agid/infl.txt',
    gzip: false,
    approxBytes: 3_400_000,
    parse: parseAgid,
  },
  {
    id: 'specialist',
    label: 'NIH SPECIALIST',
    note: 'The inflection table from the NIH’s SPECIALIST Lexicon, as shipped with LemmInflect — 40,000 words, no key. Narrower and more careful than AGID: where a word has no genuinely inflected form it says so rather than coining one. The better choice if wrong forms bother you more than missing ones.',
    homeUrl: 'https://lhncbc.nlm.nih.gov/LSG/Projects/lexicon/current/web/index.html',
    url: 'https://raw.githubusercontent.com/bjascob/LemmInflect/master/lemminflect/resources/infl_lu.csv.gz',
    gzip: true,
    approxBytes: 275_000,
    parse: parseSpecialist,
  },
];

export const DEFAULT_MORPHOLOGY = 'agid';

export function morphologySourceById(id: string): MorphologySource | undefined {
  return MORPHOLOGY_SOURCES.find((source) => source.id === id);
}

/** Which family of forms a word type takes, or nothing when it does not inflect. */
export function familyForType(type: string): MorphFamily | undefined {
  switch (type) {
    case 'noun':
    case 'number':
      return 'noun';
    case 'verb':
      return 'verb';
    case 'adjective':
    case 'adverb':
      return 'comparable';
    default:
      return undefined;
  }
}

export function decompress(buffer: Buffer, gzip: boolean): string {
  return (gzip ? gunzipSync(buffer) : buffer).toString('utf8');
}
