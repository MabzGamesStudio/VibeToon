import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  inferWordType,
  isLookupCandidate,
  meaningForToken,
  wordTypeFromPartOfSpeech,
  type DictionaryResult,
} from '@vibetoon/shared';
import { DATA_ROOT } from '../paths';

/** Override to point at another dictionary service, or at a stub in tests. */
export const DICTIONARY_URL =
  process.env.VIBETOON_DICTIONARY_URL ?? 'https://api.dictionaryapi.dev/api/v2/entries/en/{word}';

const CACHE_DIR = path.join(DATA_ROOT, 'cache', 'dictionary');

export interface LookupOptions {
  /** Attempt at most this many words. The rest come back as `remaining`. */
  limit: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Wait this long after each request before the next one on the same worker. */
  pauseMs: number;
  /** Give up on a single request after this long. */
  timeoutMs: number;
  /** How long to wait before each retry of a word the service refused. */
  retryDelaysMs: readonly number[];
  /** Abandon the batch once this many words have run out of retries. */
  maxFailures: number;
  fetchImpl: typeof fetch;
  /** Called after each word is settled, for a log line. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Defaults chosen for a free dictionary service with no published limit: a few
 * requests at a time with a breath between them gets through a book-sized word
 * list without being throttled, and a batch of 200 keeps any one request from
 * running for minutes.
 */
export const DEFAULT_LOOKUP_OPTIONS: LookupOptions = {
  limit: 200,
  concurrency: 4,
  pauseMs: 120,
  timeoutMs: 8_000,
  retryDelaysMs: [500, 1_500, 4_000],
  maxFailures: 3,
  fetchImpl: fetch,
};

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

function meaningFrom(cached: CachedLookup): DictionaryResult['meanings'][string] {
  const type = wordTypeFromPartOfSpeech(cached.partOfSpeech) ?? inferWordType(cached.word);
  return {
    type,
    description: (cached.definition ?? '').trim(),
    source: cached.found && cached.partOfSpeech ? 'dictionary' : 'inferred',
  };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

/** What one request came back as, before any retrying is decided. */
type Attempt =
  | { kind: 'entry'; entry: CachedLookup }
  | { kind: 'missing' }
  | { kind: 'retry'; reason: string; waitMs?: number; rateLimited: boolean }
  | { kind: 'fatal'; reason: string };

async function attempt(word: string, options: LookupOptions): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(DICTIONARY_URL.replace('{word}', encodeURIComponent(word)), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    if (response.status === 404) return { kind: 'missing' };
    if (response.status === 429) {
      return {
        kind: 'retry',
        reason: 'the dictionary service asked us to slow down (429)',
        ...(retryAfterMs(response.headers.get('retry-after')) !== undefined
          ? { waitMs: retryAfterMs(response.headers.get('retry-after')) }
          : {}),
        rateLimited: true,
      };
    }
    // A server-side error or a gateway hiccup is worth another go; anything
    // else (a 401, a 403) will answer the same way however often we ask.
    if (response.status >= 500 || response.status === 408) {
      return { kind: 'retry', reason: `the dictionary service answered ${response.status}`, rateLimited: false };
    }
    if (!response.ok) {
      return { kind: 'fatal', reason: `The dictionary service answered ${response.status}.` };
    }

    const parsed = readDictionaryResponse(await response.json());
    return {
      kind: 'entry',
      entry: {
        word,
        fetchedAt: new Date().toISOString(),
        found: true,
        ...(parsed.partOfSpeech ? { partOfSpeech: parsed.partOfSpeech } : {}),
        ...(parsed.definition ? { definition: parsed.definition } : {}),
      },
    };
  } catch (error) {
    const message = (error as Error).name === 'AbortError'
      ? `the request timed out after ${options.timeoutMs}ms`
      : (error as Error).message;
    return { kind: 'retry', reason: message, rateLimited: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look words up in batches, cached on disk so a word is never fetched twice.
 *
 * A word that fails is retried a few times, waiting as long as the service asks
 * when it asks; a run of words that will not answer abandons the batch rather
 * than firing hundreds of doomed requests. Whatever was learned still comes
 * back, along with the words nothing was heard about, so the caller can carry on
 * where it left off.
 */
export async function lookupWords(
  words: readonly string[],
  overrides: Partial<LookupOptions> = {},
): Promise<DictionaryResult> {
  const options: LookupOptions = { ...DEFAULT_LOOKUP_OPTIONS, ...overrides };
  const result: DictionaryResult = {
    meanings: {},
    found: [],
    missing: [],
    failed: [],
    remaining: [],
    rateLimited: 0,
    cached: 0,
    requested: 0,
  };

  // Marks and numbers need no dictionary, and a word already on disk needs no
  // network. Only what is left is a request.
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
    if (queue.length >= Math.max(1, options.limit)) {
      result.remaining.push(word);
      continue;
    }
    queue.push(word);
  }

  const total = queue.length;
  let done = 0;
  let abandoned: string | undefined;
  let failures = 0;

  const settle = (): void => {
    done += 1;
    options.onProgress?.(done, total);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (abandoned) return;
      const word = queue.shift();
      if (word === undefined) return;

      let lastReason = 'the dictionary service did not answer';
      for (let tries = 0; tries <= options.retryDelaysMs.length; tries += 1) {
        result.requested += 1;
        const outcome = await attempt(word, options);

        if (outcome.kind === 'entry' || outcome.kind === 'missing') {
          const entry: CachedLookup =
            outcome.kind === 'entry'
              ? outcome.entry
              : { word, fetchedAt: new Date().toISOString(), found: false };
          await writeCache(entry);
          result.meanings[word] = meaningFrom(entry);
          (entry.found ? result.found : result.missing).push(word);
          settle();
          break;
        }

        if (outcome.kind === 'fatal') {
          abandoned = outcome.reason;
          result.failed.push(word);
          settle();
          break;
        }

        lastReason = outcome.reason;
        if (outcome.rateLimited) {
          result.rateLimited += 1;
          if (outcome.waitMs !== undefined) {
            result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, outcome.waitMs);
          }
        }
        const delay = options.retryDelaysMs[tries];
        if (delay === undefined) {
          // Out of retries for this word. A few of these in a batch means the
          // service is not answering, so stop asking.
          result.failed.push(word);
          failures += 1;
          if (failures >= options.maxFailures) {
            abandoned = `Gave up after ${failures} word(s) the dictionary would not answer — ${lastReason}.`;
          }
          settle();
          break;
        }
        await sleep(outcome.waitMs !== undefined ? Math.max(delay, outcome.waitMs) : delay);
      }

      await sleep(options.pauseMs);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, options.concurrency), Math.max(1, total)) }, worker),
  );

  if (abandoned) {
    result.unreachable = abandoned;
    // Whatever is still queued was never asked about, so it is not a failure.
    for (const word of queue) result.remaining.push(word);
  }
  return result;
}
