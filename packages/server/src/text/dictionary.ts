import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isLookupCandidate,
  meaningForToken,
  wordTypeFromPartOfSpeech,
  type DictionaryResult,
  type LogOutcome,
  type WordMeaning,
  type WordSense,
} from '@vibetoon/shared';
import { lookupForms } from './morphology';
import { recordApiCall } from '../logs';
import { DATA_ROOT } from '../paths';
import { dictionaryKeyFor, getSettings } from '../settings';
import {
  CUSTOM_PROVIDER,
  providerById,
  type DictionaryProvider,
  type ProviderReading,
} from './dictionaryProviders';

/**
 * Point at another service, or at a stub in tests. Setting this wins over every
 * other choice, and the answer is read for whichever common shape it turns out
 * to be in.
 */
export const DICTIONARY_URL_OVERRIDE = process.env.VIBETOON_DICTIONARY_URL ?? '';

/** A key from the environment, used for any service that has none of its own. */
const ENV_DICTIONARY_KEY = process.env.VIBETOON_DICTIONARY_KEY ?? '';

/**
 * The key for one service: the one entered in the studio, else the environment's.
 * Never written into an artifact, sent to the browser, or recorded in the log.
 */
export function keyForProvider(providerId: string): string {
  return dictionaryKeyFor(providerId) || ENV_DICTIONARY_KEY;
}

const DEFAULT_PROVIDER = 'free-dictionary';
const CACHE_DIR = path.join(DATA_ROOT, 'cache', 'dictionary');

/**
 * Which service is being asked, and why that one.
 *
 * An explicit address wins, then whatever was picked in the studio, then the
 * environment, then the keyless default. A provider that needs a key it has not
 * been given is skipped rather than used to fire a few hundred requests that can
 * only come back 401.
 */
export function activeProvider(prefer = ''): { provider: DictionaryProvider; url: string; reason: string } {
  if (DICTIONARY_URL_OVERRIDE) {
    return {
      provider: CUSTOM_PROVIDER,
      url: DICTIONARY_URL_OVERRIDE,
      reason: 'VIBETOON_DICTIONARY_URL is set',
    };
  }

  const chosen = getSettings().dictionaryProvider;
  const fromEnv = process.env.VIBETOON_DICTIONARY ?? '';
  for (const [id, reason] of [
    [prefer, 'set on this flow'],
    [chosen ?? '', 'chosen in the studio'],
    [fromEnv, 'VIBETOON_DICTIONARY is set'],
    [DEFAULT_PROVIDER, 'the default'],
  ] as const) {
    const provider = id ? providerById(id) : undefined;
    if (!provider) continue;
    if (!provider.needsKey || keyForProvider(provider.id)) {
      return { provider, url: provider.url, reason };
    }
    // A service whose key is missing is never used to fire requests that can
    // only come back 401; the keyless default is used and the reason says why.
    const fallback = providerById(DEFAULT_PROVIDER)!;
    return {
      provider: fallback,
      url: fallback.url,
      reason: `${provider.label} has no key yet, so the default is being used instead`,
    };
  }
  const fallback = providerById(DEFAULT_PROVIDER)!;
  return { provider: fallback, url: fallback.url, reason: 'the default' };
}

/** The address for one word, with the key filled in when the service takes one. */
export function dictionaryUrlFor(word: string, prefer = ''): string {
  const active = activeProvider(prefer);
  return active.url
    .replace('{word}', encodeURIComponent(word))
    .replace('{key}', encodeURIComponent(keyForProvider(active.provider.id)));
}

/** Whether a service has a key, without saying what it is. */
export function hasDictionaryKey(providerId?: string): boolean {
  return providerId ? keyForProvider(providerId).length > 0 : ENV_DICTIONARY_KEY.length > 0;
}

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
  /** Ask this service rather than whatever the studio is set to. */
  provider: string;
  /** Take the forms of a word from this dataset rather than the studio's choice. */
  morphology: string;
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
  provider: '',
  morphology: '',
};

/**
 * What one word's answer looks like on disk.
 *
 * The senses are cached; the *forms* are not, because they come from a separate
 * dataset which can be swapped without any of this becoming wrong. Switching
 * morphology dataset therefore costs a re-index and no re-asking of the
 * dictionary.
 */
interface CachedLookup {
  word: string;
  fetchedAt: string;
  found: boolean;
  senses: Array<{ partOfSpeech?: string; definition?: string }>;
}

/** An answer written by an older version, before a word could have several senses. */
interface LegacyCachedLookup extends Partial<CachedLookup> {
  partOfSpeech?: string;
  definition?: string;
}

function cachePath(word: string): string {
  // One file per word, named safely: `don't` must not become a path.
  const safe = Buffer.from(word, 'utf8').toString('hex');
  return path.join(CACHE_DIR, `${safe}.json`);
}

async function readCache(word: string): Promise<CachedLookup | undefined> {
  let stored: LegacyCachedLookup;
  try {
    stored = JSON.parse(await readFile(cachePath(word), 'utf8')) as LegacyCachedLookup;
  } catch {
    return undefined;
  }
  if (Array.isArray(stored.senses)) return stored as CachedLookup;
  // One sense, from before there could be more. Worth reading rather than
  // discarding: it is a real answer, just an incomplete one.
  return {
    word: stored.word ?? word,
    fetchedAt: stored.fetchedAt ?? new Date().toISOString(),
    found: stored.found ?? false,
    senses:
      stored.partOfSpeech || stored.definition
        ? [
            {
              ...(stored.partOfSpeech ? { partOfSpeech: stored.partOfSpeech } : {}),
              ...(stored.definition ? { definition: stored.definition } : {}),
            },
          ]
        : [],
  };
}

async function writeCache(entry: CachedLookup): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(entry.word), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Pull every sense out of whatever the service sent. */
export function readDictionaryResponse(payload: unknown, prefer = ''): ProviderReading {
  return activeProvider(prefer).provider.read(payload);
}

/**
 * Turn a cached answer into senses, and fill in each one's forms.
 *
 * A sense whose part of speech means nothing to us is dropped — except when none
 * of them do, in which case one sense is kept with the definition and a type of
 * `unknown`. Knowing what a word means without knowing what kind of word it is is
 * a real state to be in, and pretending otherwise by guessing a type from the
 * spelling is exactly what this no longer does.
 */
async function meaningFrom(cached: CachedLookup, morphology: string): Promise<WordMeaning> {
  const typed: WordSense[] = [];
  for (const sense of cached.senses) {
    const type = wordTypeFromPartOfSpeech(sense.partOfSpeech);
    if (!type) continue;
    const variations = await lookupForms(cached.word, type, morphology);
    typed.push({
      type,
      description: (sense.definition ?? '').trim(),
      ...(variations ? { variations } : {}),
    });
  }

  if (typed.length === 0) {
    const described = cached.senses.find((sense) => sense.definition?.trim());
    if (described) {
      return {
        senses: [{ type: 'unknown', description: described.definition!.trim() }],
        source: 'dictionary',
        fetchedAt: cached.fetchedAt,
      };
    }
    return { senses: [], source: 'none', fetchedAt: cached.fetchedAt };
  }

  return { senses: typed, source: 'dictionary', fetchedAt: cached.fetchedAt };
}

/** The types that have other forms, so a missing paradigm is worth counting. */
const INFLECTING = new Set(['noun', 'verb', 'adjective', 'adverb', 'number']);

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

/** What one attempt is recorded as, so the log reads the way the code decided. */
function outcomeOf(result: Attempt): { outcome: LogOutcome; detail?: string } {
  switch (result.kind) {
    case 'entry':
      return { outcome: 'ok' };
    case 'missing':
      return { outcome: 'missing', detail: 'no entry for this word' };
    case 'fatal':
      return { outcome: 'failed', detail: result.reason };
    default:
      return {
        outcome: result.rateLimited ? 'rate-limited' : result.reason.includes('timed out') ? 'timeout' : 'retry',
        detail: result.reason,
      };
  }
}

async function attempt(word: string, options: LookupOptions, tries: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const url = dictionaryUrlFor(word, options.provider);
  const started = Date.now();
  let status: number | undefined;

  const record = (result: Attempt): Attempt => {
    const { outcome, detail } = outcomeOf(result);
    recordApiCall({
      service: 'dictionary',
      url,
      subject: word,
      durationMs: Date.now() - started,
      attempt: tries + 1,
      outcome,
      ...(status !== undefined ? { status } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
    return result;
  };

  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    status = response.status;

    if (response.status === 404) return record({ kind: 'missing' });
    if (response.status === 429) {
      return record({
        kind: 'retry',
        reason: 'the dictionary service asked us to slow down (429)',
        ...(retryAfterMs(response.headers.get('retry-after')) !== undefined
          ? { waitMs: retryAfterMs(response.headers.get('retry-after')) }
          : {}),
        rateLimited: true,
      });
    }
    // A server-side error or a gateway hiccup is worth another go; anything
    // else (a 401, a 403) will answer the same way however often we ask.
    if (response.status >= 500 || response.status === 408) {
      return record({
        kind: 'retry',
        reason: `the dictionary service answered ${response.status}`,
        rateLimited: false,
      });
    }
    if (!response.ok) {
      return record({ kind: 'fatal', reason: `The dictionary service answered ${response.status}.` });
    }

    const parsed = readDictionaryResponse(await response.json(), options.provider);
    // Some services answer 200 with an empty list, or with spelling suggestions,
    // for a word they do not have. Nothing useful came back either way.
    if (parsed.senses.length === 0) return record({ kind: 'missing' });
    return record({
      kind: 'entry',
      entry: {
        word,
        fetchedAt: new Date().toISOString(),
        found: true,
        senses: parsed.senses,
      },
    });
  } catch (error) {
    const message = (error as Error).name === 'AbortError'
      ? `the request timed out after ${options.timeoutMs}ms`
      : (error as Error).message;
    return record({ kind: 'retry', reason: message, rateLimited: false });
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
    withForms: 0,
    formless: 0,
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
    // A token no dictionary could know and that is not a mark or a number gets
    // no entry at all. It stays unlooked-up, which is what it is.
    if (!isLookupCandidate(word)) continue;
    const cached = await readCache(word);
    if (cached) {
      result.meanings[word] = await meaningFrom(cached, options.morphology);
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

  // Cache hits are recorded once for the batch rather than once per word: a
  // thousand of them would push every interesting line out of the log.
  if (result.cached > 0) {
    recordApiCall({
      service: 'dictionary',
      url: activeProvider(options.provider).url,
      subject: `${result.cached} word(s)`,
      outcome: 'cached',
      durationMs: 0,
      detail: 'answered from the disk cache; nothing was sent',
    });
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
        const outcome = await attempt(word, options, tries);

        if (outcome.kind === 'entry' || outcome.kind === 'missing') {
          const entry: CachedLookup =
            outcome.kind === 'entry'
              ? outcome.entry
              : { word, fetchedAt: new Date().toISOString(), found: false, senses: [] };
          await writeCache(entry);
          result.meanings[word] = await meaningFrom(entry, options.morphology);
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

  // Whether the forms dataset knew a word is worth reporting separately: the
  // dictionary can answer perfectly while the morphology index is not built.
  for (const meaning of Object.values(result.meanings)) {
    if (meaning.senses.length === 0) continue;
    const any = meaning.senses.some(
      (sense) => sense.variations && Object.keys(sense.variations).length > 0,
    );
    if (any) result.withForms += 1;
    else if (meaning.senses.some((sense) => INFLECTING.has(sense.type))) result.formless += 1;
  }

  if (abandoned) {
    result.unreachable = abandoned;
    // Whatever is still queued was never asked about, so it is not a failure.
    for (const word of queue) result.remaining.push(word);
  }
  return result;
}
