import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  inferWordType,
  isLookupCandidate,
  meaningForToken,
  wordTypeFromPartOfSpeech,
  type WordMeaning,
} from '@vibetoon/shared';
import { DATA_ROOT } from '../paths';

/** Override to point at another dictionary service, or at a stub in tests. */
export const DICTIONARY_URL =
  process.env.VIBETOON_DICTIONARY_URL ?? 'https://api.dictionaryapi.dev/api/v2/entries/en/{word}';

const CACHE_DIR = path.join(DATA_ROOT, 'cache', 'dictionary');
const CONCURRENCY = 6;

interface CachedLookup {
  word: string;
  fetchedAt: string;
  found: boolean;
  partOfSpeech?: string;
  definition?: string;
}

interface DictionaryMeaning {
  partOfSpeech?: string;
  definitions?: Array<{ definition?: string }>;
}

interface DictionaryEntry {
  meanings?: DictionaryMeaning[];
}

export interface LookupResult {
  meanings: Record<string, WordMeaning>;
  /** Words the dictionary defined. */
  found: string[];
  /** Words it has no entry for. */
  missing: string[];
  /** Words whose lookup failed, so they still have no definition. */
  failed: string[];
  /** Set when the service could not be reached at all; nothing else was tried. */
  unreachable?: string;
  /** How many answers came from the cache rather than the network. */
  cached: number;
}

function cachePath(word: string): string {
  // One file per word, named safely: `don't` must not become a path.
  const safe = Buffer.from(word, 'utf8').toString('hex');
  return path.join(CACHE_DIR, `${safe}.json`);
}

async function readCache(word: string): Promise<CachedLookup | undefined> {
  try {
    return JSON.parse(await readFile(cachePath(word), 'utf8')) as CachedLookup;
  } catch {
    return undefined;
  }
}

async function writeCache(entry: CachedLookup): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(entry.word), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Pull the first part of speech and definition out of a dictionary response. */
export function readDictionaryResponse(payload: unknown): { partOfSpeech?: string; definition?: string } {
  const entries = Array.isArray(payload) ? (payload as DictionaryEntry[]) : [];
  for (const entry of entries) {
    for (const meaning of entry.meanings ?? []) {
      const definition = meaning.definitions?.find((candidate) => candidate.definition)?.definition;
      if (meaning.partOfSpeech || definition) {
        return {
          ...(meaning.partOfSpeech ? { partOfSpeech: meaning.partOfSpeech } : {}),
          ...(definition ? { definition } : {}),
        };
      }
    }
  }
  return {};
}

function meaningFrom(cached: CachedLookup): WordMeaning {
  const type = wordTypeFromPartOfSpeech(cached.partOfSpeech) ?? inferWordType(cached.word);
  return {
    type,
    description: (cached.definition ?? '').trim(),
    source: cached.found && cached.partOfSpeech ? 'dictionary' : 'inferred',
  };
}

/**
 * Look words up, one request each, cached on disk so the same word is never
 * fetched twice. If the service cannot be reached the whole run stops rather
 * than firing hundreds of doomed requests: whatever was cached still comes
 * back, and the caller is told why the rest did not.
 */
export async function lookupWords(
  words: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<LookupResult> {
  const result: LookupResult = { meanings: {}, found: [], missing: [], failed: [], cached: 0 };
  const queue: string[] = [];

  for (const word of words) {
    const token = meaningForToken(word);
    if (token) {
      result.meanings[word] = token;
      continue;
    }
    if (!isLookupCandidate(word)) {
      result.meanings[word] = { type: inferWordType(word), description: '', source: 'inferred' };
      continue;
    }
    const cached = await readCache(word);
    if (cached) {
      result.meanings[word] = meaningFrom(cached);
      result.cached += 1;
      (cached.found ? result.found : result.missing).push(word);
      continue;
    }
    queue.push(word);
  }

  let stopped: string | undefined;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const word = queue.shift();
      if (!word) return;
      try {
        const response = await fetchImpl(DICTIONARY_URL.replace('{word}', encodeURIComponent(word)));
        if (response.status === 404) {
          const entry: CachedLookup = { word, fetchedAt: new Date().toISOString(), found: false };
          await writeCache(entry);
          result.meanings[word] = meaningFrom(entry);
          result.missing.push(word);
          continue;
        }
        if (!response.ok) {
          // A 4xx or 5xx that is not "no such word" means the service is not
          // answering properly; treat that as unreachable rather than as an
          // answer about this word.
          stopped = `The dictionary service answered ${response.status}.`;
          result.failed.push(word);
          continue;
        }
        const parsed = readDictionaryResponse(await response.json());
        const entry: CachedLookup = {
          word,
          fetchedAt: new Date().toISOString(),
          found: true,
          ...(parsed.partOfSpeech ? { partOfSpeech: parsed.partOfSpeech } : {}),
          ...(parsed.definition ? { definition: parsed.definition } : {}),
        };
        await writeCache(entry);
        result.meanings[word] = meaningFrom(entry);
        result.found.push(word);
      } catch (error) {
        stopped = `Could not reach the dictionary service: ${(error as Error).message}`;
        result.failed.push(word);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker));

  if (stopped) {
    result.unreachable = stopped;
    for (const word of queue) result.failed.push(word);
  }
  return result;
}
