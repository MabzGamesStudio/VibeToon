import type { WordMeaning } from './corpus';

/**
 * What the dictionary lookup takes and gives back.
 *
 * A word database built from a book is thousands of words long, and a
 * dictionary service will not answer thousands of requests in a row. So a
 * lookup is a batch: the caller asks about as many words as the server is
 * willing to attempt in one go, and the server says which ones it did not get
 * to. The caller keeps going until nothing is left, or stops.
 */
export interface DictionaryRequest {
  words: string[];
  /** Attempt at most this many words in this batch. */
  limit?: number;
}

export interface DictionaryResult {
  /** What was learned, keyed by spelling. Includes words answered from the cache. */
  meanings: Record<string, WordMeaning>;
  /** Words the dictionary defined. */
  found: string[];
  /** Words it has no entry for. They keep a guessed type, and are not asked about again. */
  missing: string[];
  /** Words whose lookup was attempted and failed, so they still have no definition. */
  failed: string[];
  /**
   * Words this batch did not attempt: over the batch limit, or abandoned
   * because the service stopped answering. Ask about these in the next batch.
   */
  remaining: string[];
  /** Set when the service stopped answering and the batch was cut short. */
  unreachable?: string;
  /** Times the service asked us to slow down. */
  rateLimited: number;
  /** How long it asked us to wait, when it said so. */
  retryAfterMs?: number;
  /** How many answers came from the cache rather than the network. */
  cached: number;
  /** Words this batch actually sent a request for. */
  requested: number;
}

/** The share of a lookup that is done, for a progress readout. */
export function lookupProgress(done: number, total: number): number {
  return total <= 0 ? 1 : Math.min(1, Math.max(0, done / total));
}

/** A dictionary service the studio can be pointed at, as the browser sees it. */
export interface DictionaryProviderInfo {
  id: string;
  label: string;
  note: string;
  /** Whether it needs a key, which only the server ever sees. */
  needsKey: boolean;
  /** Where to register for one. */
  keyUrl?: string;
  /** False when it needs a key that has not been given, so it cannot be picked. */
  available: boolean;
  /** Whether a key has been stored for this service. Never the key itself. */
  hasKey: boolean;
}

export interface DictionaryProviders {
  providers: DictionaryProviderInfo[];
  /** Which one is being asked. */
  activeId: string;
  /** Why that one — chosen here, set in the environment, or the default. */
  reason: string;
  /** Whether a key is present at all. Never the key itself. */
  hasKey: boolean;
  /** True when an explicit address is set, which no choice here can override. */
  pinnedByEnvironment: boolean;
}
