/**
 * The dictionary services the studio knows how to talk to.
 *
 * Swapping dictionary is not just a different address: every service returns a
 * different shape, and a part of speech is called `partOfSpeech` in one, `fl` in
 * another, and a single letter glued to the front of the definition in a third.
 * So a provider is an address *and* the code that reads what comes back.
 *
 * Nothing here needs a key except where it says so, and the two that do are
 * free to register for. The keyless ones are the useful default: a word database
 * built from a book asks about thousands of words, which is exactly the shape of
 * traffic a free tier is metered against.
 */

/**
 * One of the things a service says a spelling can be.
 *
 * A service is asked once per word and answers with several of these, because a
 * spelling is not a word: Free Dictionary returns `light` as a noun, a verb and
 * an adjective in one response. Reading only the first, which is what this used
 * to do, is how `light` ended up in a word database as a noun and nothing else.
 */
export interface ProviderSense {
  partOfSpeech?: string;
  definition?: string;
}

export interface ProviderReading {
  senses: ProviderSense[];
}

/** Keep one sense per part of speech, in the order the service gave them. */
function distinct(senses: ProviderSense[]): ProviderReading {
  const seen = new Set<string>();
  const kept: ProviderSense[] = [];
  for (const sense of senses) {
    if (!sense.partOfSpeech && !sense.definition) continue;
    const key = (sense.partOfSpeech ?? '').trim().toLowerCase();
    // A service that lists ten noun senses is offering ten descriptions of one
    // word, not ten words. The first is the one that goes in.
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    kept.push(sense);
  }
  return { senses: kept };
}

export interface DictionaryProvider {
  id: string;
  label: string;
  /** What it is, what it costs, and what it is good and bad at. */
  note: string;
  needsKey: boolean;
  /** Where to get a key, when one is needed. */
  keyUrl?: string;
  /** `{word}` and `{key}` are filled in. */
  url: string;
  /** Pull every sense — part of speech and definition — out of whatever came back. */
  read(payload: unknown): ProviderReading;
}

/** Wiktionary hands back HTML in its definitions; the word database wants words. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function first<T>(value: unknown): T | undefined {
  return Array.isArray(value) && value.length > 0 ? (value[0] as T) : undefined;
}

/** Datamuse writes the part of speech as a letter in front of the definition. */
const DATAMUSE_POS: Record<string, string> = {
  n: 'noun',
  v: 'verb',
  adj: 'adjective',
  adv: 'adverb',
  u: '',
};

export const DICTIONARY_PROVIDERS: DictionaryProvider[] = [
  {
    id: 'free-dictionary',
    label: 'Free Dictionary API',
    note: 'No key, no registration. Generous until it is not: it throttles hard under a long run, and has been known to refuse outright from a datacentre address.',
    needsKey: false,
    url: 'https://api.dictionaryapi.dev/api/v2/entries/en/{word}',
    read(payload) {
      // A word it does not have comes back as `{ title: 'No Definitions Found' }`
      // rather than a list, so this cannot assume it got one.
      if (!Array.isArray(payload)) return { senses: [] };
      const senses: ProviderSense[] = [];
      for (const entry of payload as Array<{ meanings?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }> }> }>) {
        for (const meaning of entry?.meanings ?? []) {
          const definition = meaning.definitions?.find((candidate) => candidate.definition)?.definition;
          senses.push({
            ...(meaning.partOfSpeech ? { partOfSpeech: meaning.partOfSpeech } : {}),
            ...(definition ? { definition } : {}),
          });
        }
      }
      return distinct(senses);
    },
  },

  {
    id: 'wiktionary',
    label: 'Wiktionary',
    note: 'No key. Wikimedia’s own service, so it is steady and it will not vanish; definitions are written by hand and can be long, and its part-of-speech labels are the broadest of the lot.',
    needsKey: false,
    url: 'https://en.wiktionary.org/api/rest_v1/page/definition/{word}',
    read(payload) {
      const english = (payload as { en?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }> }> })?.en;
      return distinct(
        (english ?? []).map((sense) => {
          const raw = sense.definitions?.find((candidate) => candidate.definition)?.definition;
          const definition = raw ? stripHtml(raw) : undefined;
          return {
            ...(sense.partOfSpeech ? { partOfSpeech: sense.partOfSpeech.toLowerCase() } : {}),
            ...(definition ? { definition } : {}),
          };
        }),
      );
    },
  },

  {
    id: 'datamuse',
    label: 'Datamuse',
    note: 'No key, and by far the most tolerant of a few thousand words in a row. Definitions are terse, and it only knows four parts of speech — but a type is what the grammar flow actually needs, and it gives one definition per part of speech, so a word with several meanings comes back with all of them.',
    needsKey: false,
    url: 'https://api.datamuse.com/words?sp={word}&md=dp&max=1',
    read(payload) {
      const match = first<{ word?: string; defs?: string[] }>(payload);
      return distinct(
        (match?.defs ?? []).map((raw) => {
          // `n\ta source of light` — the letter before the tab is the part of speech.
          const [tag, ...rest] = raw.split('\t');
          const definition = rest.join('\t').trim();
          const partOfSpeech = DATAMUSE_POS[(tag ?? '').trim()] ?? '';
          return {
            ...(partOfSpeech ? { partOfSpeech } : {}),
            ...(definition ? { definition } : {}),
          };
        }),
      );
    },
  },

  {
    id: 'merriam-webster',
    label: 'Merriam-Webster Collegiate',
    note: 'A free key, 1,000 lookups a day. The best definitions and the most reliable parts of speech here; the daily cap is the catch for a book-sized database.',
    needsKey: true,
    keyUrl: 'https://dictionaryapi.com/register/index',
    url: 'https://dictionaryapi.com/api/v3/references/collegiate/json/{word}?key={key}',
    read(payload) {
      // A word it does not know comes back as a list of spelling suggestions,
      // which are strings rather than entries — that is a miss, not an answer.
      if (!Array.isArray(payload)) return { senses: [] };
      return distinct(
        (payload as Array<{ fl?: string; shortdef?: string[] }>)
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => {
            const definition = entry.shortdef?.find((candidate) => candidate?.trim());
            return {
              ...(entry.fl ? { partOfSpeech: entry.fl } : {}),
              ...(definition ? { definition } : {}),
            };
          }),
      );
    },
  },

  {
    id: 'wordnik',
    label: 'Wordnik',
    note: 'A free key for non-commercial use. Pulls definitions from several published dictionaries at once, so coverage of unusual words is good.',
    needsKey: true,
    keyUrl: 'https://developer.wordnik.com/',
    url: 'https://api.wordnik.com/v4/word.json/{word}/definitions?limit=12&includeRelated=false&api_key={key}',
    read(payload) {
      if (!Array.isArray(payload)) return { senses: [] };
      return distinct(
        (payload as Array<{ partOfSpeech?: string; text?: string }>).map((entry) => {
          const definition = entry?.text ? stripHtml(entry.text) : undefined;
          return {
            ...(entry?.partOfSpeech ? { partOfSpeech: entry.partOfSpeech } : {}),
            ...(definition ? { definition } : {}),
          };
        }),
      );
    },
  },
];

/**
 * A service of your own. It reads the common shapes rather than one in
 * particular, which covers most dictionary APIs and, when it does not, is the
 * point at which to add an entry above.
 */
export const CUSTOM_PROVIDER: DictionaryProvider = {
  id: 'custom',
  label: 'Custom',
  note: 'Whatever VIBETOON_DICTIONARY_URL points at. The answer is read for the field names the common services use.',
  needsKey: false,
  url: '',
  read(payload) {
    for (const provider of DICTIONARY_PROVIDERS) {
      const reading = provider.read(payload);
      if (reading.senses.length > 0) return reading;
    }
    return { senses: [] };
  },
};

export function providerById(id: string): DictionaryProvider | undefined {
  return id === CUSTOM_PROVIDER.id
    ? CUSTOM_PROVIDER
    : DICTIONARY_PROVIDERS.find((provider) => provider.id === id);
}
