import type { WordType } from '../types/text';

/**
 * English inflection: the spellings one word takes on.
 *
 * The set of forms and their names follow the convention used by
 * github.com/BryanKoo/english-inflection — five for a verb, two for a noun,
 * three for an adjective or adverb — so a lexeme built here lines up with that
 * vocabulary. The rules and tables below are written for this project.
 *
 * It is rule-based and therefore wrong sometimes: English spelling is not a
 * function of English spelling. The irregular tables cover the words that turn
 * up most, and anything it gets wrong can be corrected on the lexeme itself.
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

/* ------------------------------------------------------------------ *
 * Shared spelling helpers
 * ------------------------------------------------------------------ */

const VOWELS = 'aeiou';
const SIBILANT = /(s|x|z|ch|sh|ss)$/;

function isVowel(character: string | undefined): boolean {
  return character !== undefined && VOWELS.includes(character);
}

/** `stop` doubles its last letter, `visit` does not: consonant-vowel-consonant, one syllable. */
function doublesFinalConsonant(word: string): boolean {
  if (word.length < 3) return false;
  const [third, second, last] = [word.at(-3)!, word.at(-2)!, word.at(-1)!];
  if (isVowel(last) || 'wxy'.includes(last)) return false;
  if (!isVowel(second) || isVowel(third)) return false;
  // Only a stressed final syllable doubles; one-syllable words always are.
  return countSyllables(word) === 1;
}

/** Vowel groups, near enough for deciding `big → bigger` against `careful → more careful`. */
export function countSyllables(word: string): number {
  const groups = word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function endsInConsonantY(word: string): boolean {
  return word.endsWith('y') && !isVowel(word.at(-2));
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

/** `[third person, progressive, past, past participle]`, `null` where a form does not exist. */
type IrregularVerb = [string, string, string | null, string | null, string | null];

const IRREGULAR_VERBS: Record<string, IrregularVerb> = {
  be: ['be', 'is', 'being', 'was', 'been'],
  have: ['have', 'has', 'having', 'had', 'had'],
  do: ['do', 'does', 'doing', 'did', 'done'],
  say: ['say', 'says', 'saying', 'said', 'said'],
  go: ['go', 'goes', 'going', 'went', 'gone'],
  get: ['get', 'gets', 'getting', 'got', 'gotten'],
  make: ['make', 'makes', 'making', 'made', 'made'],
  know: ['know', 'knows', 'knowing', 'knew', 'known'],
  think: ['think', 'thinks', 'thinking', 'thought', 'thought'],
  take: ['take', 'takes', 'taking', 'took', 'taken'],
  see: ['see', 'sees', 'seeing', 'saw', 'seen'],
  come: ['come', 'comes', 'coming', 'came', 'come'],
  give: ['give', 'gives', 'giving', 'gave', 'given'],
  find: ['find', 'finds', 'finding', 'found', 'found'],
  tell: ['tell', 'tells', 'telling', 'told', 'told'],
  feel: ['feel', 'feels', 'feeling', 'felt', 'felt'],
  leave: ['leave', 'leaves', 'leaving', 'left', 'left'],
  run: ['run', 'runs', 'running', 'ran', 'run'],
  begin: ['begin', 'begins', 'beginning', 'began', 'begun'],
  write: ['write', 'writes', 'writing', 'wrote', 'written'],
  sit: ['sit', 'sits', 'sitting', 'sat', 'sat'],
  stand: ['stand', 'stands', 'standing', 'stood', 'stood'],
  lose: ['lose', 'loses', 'losing', 'lost', 'lost'],
  pay: ['pay', 'pays', 'paying', 'paid', 'paid'],
  meet: ['meet', 'meets', 'meeting', 'met', 'met'],
  set: ['set', 'sets', 'setting', 'set', 'set'],
  lead: ['lead', 'leads', 'leading', 'led', 'led'],
  understand: ['understand', 'understands', 'understanding', 'understood', 'understood'],
  speak: ['speak', 'speaks', 'speaking', 'spoke', 'spoken'],
  read: ['read', 'reads', 'reading', 'read', 'read'],
  spend: ['spend', 'spends', 'spending', 'spent', 'spent'],
  grow: ['grow', 'grows', 'growing', 'grew', 'grown'],
  win: ['win', 'wins', 'winning', 'won', 'won'],
  teach: ['teach', 'teaches', 'teaching', 'taught', 'taught'],
  buy: ['buy', 'buys', 'buying', 'bought', 'bought'],
  bring: ['bring', 'brings', 'bringing', 'brought', 'brought'],
  build: ['build', 'builds', 'building', 'built', 'built'],
  send: ['send', 'sends', 'sending', 'sent', 'sent'],
  fall: ['fall', 'falls', 'falling', 'fell', 'fallen'],
  cut: ['cut', 'cuts', 'cutting', 'cut', 'cut'],
  put: ['put', 'puts', 'putting', 'put', 'put'],
  let: ['let', 'lets', 'letting', 'let', 'let'],
  keep: ['keep', 'keeps', 'keeping', 'kept', 'kept'],
  hold: ['hold', 'holds', 'holding', 'held', 'held'],
  hear: ['hear', 'hears', 'hearing', 'heard', 'heard'],
  mean: ['mean', 'means', 'meaning', 'meant', 'meant'],
  become: ['become', 'becomes', 'becoming', 'became', 'become'],
  break: ['break', 'breaks', 'breaking', 'broke', 'broken'],
  eat: ['eat', 'eats', 'eating', 'ate', 'eaten'],
  drink: ['drink', 'drinks', 'drinking', 'drank', 'drunk'],
  drive: ['drive', 'drives', 'driving', 'drove', 'driven'],
  choose: ['choose', 'chooses', 'choosing', 'chose', 'chosen'],
  catch: ['catch', 'catches', 'catching', 'caught', 'caught'],
  draw: ['draw', 'draws', 'drawing', 'drew', 'drawn'],
  sell: ['sell', 'sells', 'selling', 'sold', 'sold'],
  sing: ['sing', 'sings', 'singing', 'sang', 'sung'],
  swim: ['swim', 'swims', 'swimming', 'swam', 'swum'],
  wear: ['wear', 'wears', 'wearing', 'wore', 'worn'],
  throw: ['throw', 'throws', 'throwing', 'threw', 'thrown'],
  forget: ['forget', 'forgets', 'forgetting', 'forgot', 'forgotten'],
  fly: ['fly', 'flies', 'flying', 'flew', 'flown'],
  ride: ['ride', 'rides', 'riding', 'rode', 'ridden'],
  rise: ['rise', 'rises', 'rising', 'rose', 'risen'],
  shake: ['shake', 'shakes', 'shaking', 'shook', 'shaken'],
  steal: ['steal', 'steals', 'stealing', 'stole', 'stolen'],
  tear: ['tear', 'tears', 'tearing', 'tore', 'torn'],
  wake: ['wake', 'wakes', 'waking', 'woke', 'woken'],
  blow: ['blow', 'blows', 'blowing', 'blew', 'blown'],
  freeze: ['freeze', 'freezes', 'freezing', 'froze', 'frozen'],
  beat: ['beat', 'beats', 'beating', 'beat', 'beaten'],
  forbid: ['forbid', 'forbids', 'forbidding', 'forbade', 'forbidden'],
  forsake: ['forsake', 'forsakes', 'forsaking', 'forsook', 'forsaken'],
  hit: ['hit', 'hits', 'hitting', 'hit', 'hit'],
  hurt: ['hurt', 'hurts', 'hurting', 'hurt', 'hurt'],
  sleep: ['sleep', 'sleeps', 'sleeping', 'slept', 'slept'],
  sweep: ['sweep', 'sweeps', 'sweeping', 'swept', 'swept'],
  shut: ['shut', 'shuts', 'shutting', 'shut', 'shut'],
  // Modals: no third person -s, no progressive, some have no past at all.
  can: ['can', 'can', null, 'could', null],
  will: ['will', 'will', null, 'would', null],
  shall: ['shall', 'shall', null, 'should', null],
  may: ['may', 'may', null, 'might', null],
  must: ['must', 'must', null, null, null],
};

/**
 * Prefixes that leave the verb underneath them intact: `forgive` conjugates like
 * `give`, `understand` like `stand`, `rewrite` like `write`. Listing the
 * prefixes is a great deal shorter, and more complete, than listing every
 * prefixed form of every irregular verb.
 */
const VERB_PREFIXES = [
  'be',
  'dis',
  'fore',
  'for',
  'mis',
  'out',
  'over',
  're',
  'un',
  'under',
  'up',
  'with',
];

/** `forgave` back to `forgive`: the stem is reversed, then the prefix restored. */
function prefixedLemma(word: string): string | undefined {
  for (const prefix of VERB_PREFIXES) {
    if (!word.startsWith(prefix)) continue;
    const stem = word.slice(prefix.length);
    if (stem.length < 2) continue;
    const base = REVERSE_VERBS.get(stem);
    // Only when the prefixed form really is irregular, so `rendered` is not read
    // as `re` + `ndered`.
    if (base && prefixedIrregular(`${prefix}${base}`)) return `${prefix}${base}`;
  }
  return undefined;
}

/** The irregular pattern a prefixed verb inherits, if it inherits one. */
function prefixedIrregular(verb: string): IrregularVerb | undefined {
  for (const prefix of VERB_PREFIXES) {
    if (!verb.startsWith(prefix)) continue;
    const stem = verb.slice(prefix.length);
    // `do` and `go` are two letters, so two is the floor. Anything shorter has
    // no verb in it; anything that decomposes wrongly — `forbid` into `bid` —
    // is listed above, and the table is consulted first.
    if (stem.length < 2) continue;
    const base = IRREGULAR_VERBS[stem];
    if (!base) continue;
    const [, third, progressive, past, participle] = base;
    return [
      verb,
      `${prefix}${third}`,
      progressive ? `${prefix}${progressive}` : null,
      past ? `${prefix}${past}` : null,
      participle ? `${prefix}${participle}` : null,
    ];
  }
  return undefined;
}

export function conjugate(infinitive: string): Variations {
  const verb = infinitive.toLowerCase();
  const irregular = IRREGULAR_VERBS[verb] ?? prefixedIrregular(verb);
  if (irregular) {
    const [base, third, progressive, past, participle] = irregular;
    return {
      infinitive: base,
      third_person_singular: third,
      ...(progressive ? { present_progressive: progressive } : {}),
      ...(past ? { past } : {}),
      ...(participle ? { past_participle: participle } : {}),
    };
  }

  const third = SIBILANT.test(verb)
    ? `${verb}es`
    : endsInConsonantY(verb)
      ? `${verb.slice(0, -1)}ies`
      : verb.endsWith('o')
        ? `${verb}es`
        : `${verb}s`;

  const progressive = verb.endsWith('ie')
    ? `${verb.slice(0, -2)}ying`
    : verb.endsWith('e') && !verb.endsWith('ee') && !verb.endsWith('ye') && !verb.endsWith('oe')
      ? `${verb.slice(0, -1)}ing`
      : doublesFinalConsonant(verb)
        ? `${verb}${verb.at(-1)}ing`
        : `${verb}ing`;

  const past = verb.endsWith('e')
    ? `${verb}d`
    : endsInConsonantY(verb)
      ? `${verb.slice(0, -1)}ied`
      : doublesFinalConsonant(verb)
        ? `${verb}${verb.at(-1)}ed`
        : `${verb}ed`;

  return {
    infinitive: verb,
    third_person_singular: third,
    present_progressive: progressive,
    past,
    past_participle: past,
  };
}

/* ------------------------------------------------------------------ *
 * Nouns
 * ------------------------------------------------------------------ */

const IRREGULAR_PLURALS: Record<string, string> = {
  man: 'men',
  woman: 'women',
  child: 'children',
  person: 'people',
  foot: 'feet',
  tooth: 'teeth',
  goose: 'geese',
  mouse: 'mice',
  louse: 'lice',
  ox: 'oxen',
  die: 'dice',
  penny: 'pence',
  cactus: 'cacti',
  focus: 'foci',
  fungus: 'fungi',
  nucleus: 'nuclei',
  syllabus: 'syllabi',
  analysis: 'analyses',
  basis: 'bases',
  crisis: 'crises',
  thesis: 'theses',
  phenomenon: 'phenomena',
  criterion: 'criteria',
  datum: 'data',
  medium: 'media',
  index: 'indices',
  appendix: 'appendices',
};

/** Same spelling either way. */
const UNCHANGING_NOUNS = new Set([
  'sheep',
  'fish',
  'deer',
  'moose',
  'salmon',
  'trout',
  'swine',
  'series',
  'species',
  'aircraft',
  'spacecraft',
  'offspring',
  'means',
  'news',
  'scissors',
  'trousers',
]);

/**
 * Singular nouns that end in `s`.
 *
 * `cactus` is not the plural of `cactu`, but stripping the `s` produces a stem
 * that pluralises straight back to `cactus`, so the guard that normally catches
 * a bad de-pluralisation waves it through. The `-us`, `-is` and `-ss` endings
 * are a reliable rule; the rest are common enough to be worth naming.
 */
const SINGULAR_IN_S = new Set([
  'lens',
  'gas',
  'atlas',
  'bias',
  'canvas',
  'alias',
  'iris',
  'bus',
  'plus',
  'yes',
  'gallows',
  'lens',
]);

/** True when a word ending in `s` is already singular and must not be stripped. */
function isSingularInS(word: string): boolean {
  if (!word.endsWith('s')) return false;
  // A known singular whose plural is irregular: `cactus`, `analysis`, `focus`.
  if (IRREGULAR_PLURALS[word] !== undefined) return true;
  if (SINGULAR_IN_S.has(word)) return true;
  // `-ss` is never a plural ending; `-us` and `-is` almost never are.
  return word.endsWith('ss') || word.endsWith('us') || word.endsWith('is');
}

/** `-f` words that just take an s. */
const F_KEEPERS = new Set(['roof', 'chief', 'belief', 'chef', 'cliff', 'proof', 'reef', 'safe', 'grief']);
/** `-o` words that take `-es`. */
const O_TAKES_ES = new Set(['potato', 'tomato', 'hero', 'echo', 'veto', 'torpedo', 'embargo', 'volcano']);

export function pluralize(singular: string): string {
  const noun = singular.toLowerCase();
  if (UNCHANGING_NOUNS.has(noun)) return noun;
  const irregular = IRREGULAR_PLURALS[noun];
  if (irregular) return irregular;

  if (SIBILANT.test(noun)) return `${noun}es`;
  if (endsInConsonantY(noun)) return `${noun.slice(0, -1)}ies`;
  if (noun.endsWith('o')) return O_TAKES_ES.has(noun) ? `${noun}es` : `${noun}s`;
  if (noun.endsWith('fe')) return `${noun.slice(0, -2)}ves`;
  if (noun.endsWith('f') && !F_KEEPERS.has(noun)) return `${noun.slice(0, -1)}ves`;
  return `${noun}s`;
}

/* ------------------------------------------------------------------ *
 * Adjectives and adverbs
 * ------------------------------------------------------------------ */

const IRREGULAR_COMPARISONS: Record<string, [string, string]> = {
  good: ['better', 'best'],
  well: ['better', 'best'],
  bad: ['worse', 'worst'],
  badly: ['worse', 'worst'],
  ill: ['worse', 'worst'],
  far: ['farther', 'farthest'],
  little: ['less', 'least'],
  much: ['more', 'most'],
  many: ['more', 'most'],
  old: ['older', 'oldest'],
  late: ['later', 'latest'],
};

/**
 * Short words take `-er`; longer ones take `more`. Adverbs in `-ly` always take
 * `more`, which is why `quickly` does not become `quicklier`.
 */
export function compare(positive: string, type: WordType = 'adjective'): Variations {
  const word = positive.toLowerCase();
  const irregular = IRREGULAR_COMPARISONS[word];
  if (irregular) {
    return { positive: word, comparative: irregular[0], superlative: irregular[1] };
  }

  const periphrastic =
    (type === 'adverb' && word.endsWith('ly')) ||
    countSyllables(word) > 2 ||
    (countSyllables(word) === 2 && !/(y|le|er|ow)$/.test(word));

  if (periphrastic) {
    return { positive: word, comparative: `more ${word}`, superlative: `most ${word}` };
  }

  const stem = endsInConsonantY(word)
    ? `${word.slice(0, -1)}i`
    : word.endsWith('e')
      ? word.slice(0, -1)
      : doublesFinalConsonant(word)
        ? `${word}${word.at(-1)}`
        : word;

  return { positive: word, comparative: `${stem}er`, superlative: `${stem}est` };
}

/* ------------------------------------------------------------------ *
 * The lexeme's view
 * ------------------------------------------------------------------ */

/**
 * Every spelling a word takes, keyed by form. Returns undefined for word types
 * that do not inflect — a preposition is a preposition.
 */
export function inflect(spelling: string, type: WordType): Variations | undefined {
  const word = spelling.toLowerCase().trim();
  if (!word || !/^[a-z][a-z'-]*$/.test(word)) return undefined;

  switch (type) {
    case 'verb':
      return conjugate(lemmaOf(word, 'verb'));
    case 'noun':
    case 'number': {
      const singular = lemmaOf(word, 'noun');
      return { singular, plural: pluralize(singular) };
    }
    case 'adjective':
    case 'adverb':
      return compare(lemmaOf(word, type), type);
    default:
      return undefined;
  }
}

/** Which form a spelling is, given its type. `walks` is a third person singular. */
export function formOf(spelling: string, type: WordType): VariationKey | undefined {
  const variations = inflect(spelling, type);
  if (!variations) return undefined;
  const word = spelling.toLowerCase();
  for (const [key, value] of Object.entries(variations) as Array<[VariationKey, string]>) {
    if (value === word) return key;
  }
  return undefined;
}

const REVERSE_VERBS = new Map<string, string>();
for (const [base, forms] of Object.entries(IRREGULAR_VERBS)) {
  for (const form of forms) if (form) REVERSE_VERBS.set(form, base);
}
const REVERSE_PLURALS = new Map<string, string>(
  Object.entries(IRREGULAR_PLURALS).map(([singular, plural]) => [plural, singular]),
);
const REVERSE_COMPARISONS = new Map<string, string>();
for (const [base, [comparative, superlative]] of Object.entries(IRREGULAR_COMPARISONS)) {
  // First base wins: `better` belongs to `good`, not to `well`, unless the word
  // is being read as an adverb.
  if (!REVERSE_COMPARISONS.has(comparative)) REVERSE_COMPARISONS.set(comparative, base);
  if (!REVERSE_COMPARISONS.has(superlative)) REVERSE_COMPARISONS.set(superlative, base);
}

/** The same comparatives, read as adverbs: `better` is `well` here. */
const ADVERB_COMPARISONS: Record<string, string> = {
  better: 'well',
  best: 'well',
  worse: 'badly',
  worst: 'badly',
  more: 'much',
  most: 'much',
};

/** Undo an inflection: `walking` and `walked` are both `walk`. */
export function lemmaOf(spelling: string, type: WordType): string {
  const word = spelling.toLowerCase();

  if (type === 'verb') {
    const irregular = REVERSE_VERBS.get(word);
    if (irregular) return irregular;
    const prefixed = prefixedLemma(word);
    if (prefixed) return prefixed;
    for (const candidate of undoVerbSuffix(word)) {
      if (conjugateContains(candidate, word)) return candidate;
    }
    return word;
  }

  if (type === 'noun' || type === 'number') {
    if (UNCHANGING_NOUNS.has(word)) return word;
    const irregular = REVERSE_PLURALS.get(word);
    if (irregular) return irregular;
    // Checked after the reverse table, so a real plural like `crises` still
    // resolves to `crisis` rather than being mistaken for a singular.
    if (isSingularInS(word)) return word;
    for (const candidate of undoPluralSuffix(word)) {
      if (pluralize(candidate) === word) return candidate;
    }
    return word;
  }

  if (type === 'adjective' || type === 'adverb') {
    if (type === 'adverb' && ADVERB_COMPARISONS[word]) return ADVERB_COMPARISONS[word]!;
    const irregular = REVERSE_COMPARISONS.get(word);
    if (irregular) return irregular;
    for (const candidate of undoComparisonSuffix(word)) {
      const forms = compare(candidate, type);
      if (forms.comparative === word || forms.superlative === word) return candidate;
    }
    return word;
  }

  return word;
}

function conjugateContains(candidate: string, word: string): boolean {
  const forms = conjugate(candidate);
  return Object.values(forms).includes(word);
}

/** Candidate stems for a possibly-inflected verb, best first. */
function undoVerbSuffix(word: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value.length > 1 && !out.includes(value)) out.push(value);
  };

  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    // `stopping` has to try `stop` before `stopp`: both spell the progressive
    // the same way, and only one of them is a word.
    if (stem.length > 1 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
    push(stem);
    push(`${stem}e`);
    if (stem.endsWith('y')) push(`${stem.slice(0, -1)}ie`);
  }
  if (word.endsWith('ied')) push(`${word.slice(0, -3)}y`);
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    if (stem.length > 1 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
    push(stem);
    push(`${stem}e`);
  }
  if (word.endsWith('ies')) push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) {
    push(word.slice(0, -2));
    push(word.slice(0, -1));
  }
  if (word.endsWith('s')) push(word.slice(0, -1));
  return out;
}

function undoPluralSuffix(word: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value.length > 1 && !out.includes(value)) out.push(value);
  };
  if (word.endsWith('ies')) push(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves')) {
    // `knives` is `knife`, `leaves` is `leaf`: -ives almost always came from -ife.
    const stem = word.slice(0, -3);
    if (word.endsWith('ives')) {
      push(`${stem}fe`);
      push(`${stem}f`);
    } else {
      push(`${stem}f`);
      push(`${stem}fe`);
    }
  }
  if (word.endsWith('es')) {
    push(word.slice(0, -2));
    push(word.slice(0, -1));
  }
  if (word.endsWith('s')) push(word.slice(0, -1));
  return out;
}

function undoComparisonSuffix(word: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value.length > 1 && !out.includes(value)) out.push(value);
  };
  const more = word.match(/^(?:more|most)\s+(.+)$/);
  if (more?.[1]) push(more[1]);
  if (word.endsWith('iest')) push(`${word.slice(0, -4)}y`);
  if (word.endsWith('ier')) push(`${word.slice(0, -3)}y`);
  if (word.endsWith('est')) {
    const stem = word.slice(0, -3);
    if (stem.length > 1 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
    push(stem);
    push(`${stem}e`);
  }
  if (word.endsWith('er')) {
    const stem = word.slice(0, -2);
    if (stem.length > 1 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
    push(stem);
    push(`${stem}e`);
  }
  return out;
}
