import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MorphologyStatus, Variations, WordType } from '@vibetoon/shared';
import { recordApiCall } from '../logs';
import { DATA_ROOT } from '../paths';
import { getSettings } from '../settings';
import {
  DEFAULT_MORPHOLOGY,
  MORPHOLOGY_SOURCES,
  decompress,
  familyForType,
  morphologySourceById,
  type MorphFamily,
  type MorphologySource,
} from './morphologySources';

/**
 * The forms of a word, from a dataset, cached on disk.
 *
 * The dataset is one file of a few megabytes, which is small to download and far
 * too big to hold in memory next to everything else the studio is doing. So it is
 * downloaded once and turned into a few hundred small index files, sharded on the
 * first two letters of the spelling; a lookup reads one of those, and the ones in
 * use stay in memory. Building the index is the slow part and happens once, on
 * request, with the result reported.
 *
 * Every surface form is a key, not just the base word: a corpus gives you
 * `children` and `forgave`, and those have to find their way to `child` and
 * `forgive` without anything being stripped off the end of them.
 */

const CACHE_ROOT = path.join(DATA_ROOT, 'cache', 'morphology');

/** Shards held in memory. Each is a few hundred kilobytes at most. */
const SHARD_LIMIT = 48;

interface ShardEntry {
  lemma: string;
  family: MorphFamily;
  forms: Variations;
  /** False when the dataset could not confirm the word is of this kind. */
  certain?: boolean;
}

/**
 * One shard: spelling to the paradigms that spelling appears in.
 *
 * Built and read with `Object.hasOwn` and a null prototype, because English
 * contains `constructor`, `toString` and `valueOf`, and a plain object claims to
 * have those already. Reading `shard.constructor` on a normal object hands back a
 * function rather than a list of paradigms, and everything after that goes wrong
 * in a way that has nothing to do with morphology.
 */
type Shard = Record<string, ShardEntry[]>;

interface IndexMeta {
  sourceId: string;
  builtAt: string;
  paradigms: number;
  spellings: number;
  shards: number;
  /** Rows the parser could not read, so a bad download shows up as a number. */
  skipped: number;
}

function sourceDir(sourceId: string): string {
  return path.join(CACHE_ROOT, sourceId);
}

function shardPath(sourceId: string, shard: string): string {
  return path.join(sourceDir(sourceId), 'index', `${shard}.json`);
}

function metaPath(sourceId: string): string {
  return path.join(sourceDir(sourceId), 'meta.json');
}

/** Spellings are grouped by their first two letters; anything else shares `_`. */
export function shardFor(spelling: string): string {
  const match = /^[a-z]{2}/.exec(spelling.toLowerCase());
  return match ? match[0] : '_';
}

/* ------------------------------------------------------------------ *
 * Which dataset is in use
 * ------------------------------------------------------------------ */

/** A local file to read instead of downloading, for tests and for offline use. */
export const MORPHOLOGY_FILE_OVERRIDE = process.env.VIBETOON_MORPHOLOGY_FILE ?? '';

export function activeMorphology(prefer = ''): { source: MorphologySource; reason: string } {
  for (const [id, reason] of [
    [prefer, 'set on this flow'],
    [getSettings().morphologySource ?? '', 'chosen in the studio'],
    [process.env.VIBETOON_MORPHOLOGY ?? '', 'VIBETOON_MORPHOLOGY is set'],
    [DEFAULT_MORPHOLOGY, 'the default'],
  ] as const) {
    const source = id ? morphologySourceById(id) : undefined;
    if (source) return { source, reason };
  }
  return { source: MORPHOLOGY_SOURCES[0]!, reason: 'the only one there is' };
}

/* ------------------------------------------------------------------ *
 * Building the index
 * ------------------------------------------------------------------ */

async function readMeta(sourceId: string): Promise<IndexMeta | undefined> {
  try {
    return JSON.parse(await readFile(metaPath(sourceId), 'utf8')) as IndexMeta;
  } catch {
    return undefined;
  }
}

/** Fetch the dataset, or read the local file when one is pointed at. */
async function fetchDataset(
  source: MorphologySource,
  fetchImpl: typeof fetch,
): Promise<{ text: string; bytes: number; from: string }> {
  if (MORPHOLOGY_FILE_OVERRIDE) {
    const buffer = await readFile(MORPHOLOGY_FILE_OVERRIDE);
    return {
      text: decompress(buffer, MORPHOLOGY_FILE_OVERRIDE.endsWith('.gz')),
      bytes: buffer.byteLength,
      from: MORPHOLOGY_FILE_OVERRIDE,
    };
  }

  const started = Date.now();
  let status: number | undefined;
  try {
    const response = await fetchImpl(source.url, { headers: { accept: '*/*' } });
    status = response.status;
    if (!response.ok) throw new Error(`the dataset answered ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    recordApiCall({
      service: 'morphology',
      url: source.url,
      subject: source.label,
      durationMs: Date.now() - started,
      status,
      outcome: 'ok',
      detail: `${(buffer.byteLength / 1_000_000).toFixed(1)}MB downloaded`,
    });
    return { text: decompress(buffer, source.gzip), bytes: buffer.byteLength, from: source.url };
  } catch (error) {
    recordApiCall({
      service: 'morphology',
      url: source.url,
      subject: source.label,
      durationMs: Date.now() - started,
      ...(status !== undefined ? { status } : {}),
      outcome: 'failed',
      detail: (error as Error).message,
    });
    throw error;
  }
}

export interface BuildResult {
  meta: IndexMeta;
  bytes: number;
  from: string;
  ms: number;
}

/**
 * Download the dataset and write the index.
 *
 * Shards are accumulated in memory and written at the end: the whole index is
 * tens of megabytes of JSON, which is fine to hold for the second or two this
 * takes and much better than reopening six hundred files as the parse walks the
 * file in no particular order.
 */
export async function buildMorphologyIndex(
  prefer = '',
  fetchImpl: typeof fetch = fetch,
): Promise<BuildResult> {
  const started = Date.now();
  const { source } = activeMorphology(prefer);
  const { text, bytes, from } = await fetchDataset(source, fetchImpl);

  const paradigms = source.parse(text);
  const lines = text.split('\n').filter((line) => line.trim()).length;

  const shards = new Map<string, Shard>();
  let spellings = 0;
  const add = (spelling: string, entry: ShardEntry): void => {
    const key = spelling.toLowerCase();
    const shard = shards.get(shardFor(key)) ?? (Object.create(null) as Shard);
    const list = Object.hasOwn(shard, key) ? shard[key]! : [];
    // The same lemma and family can arrive twice from a dataset with duplicate
    // rows; the first reading wins so a rebuild is deterministic.
    if (list.some((held) => held.lemma === entry.lemma && held.family === entry.family)) return;
    if (list.length === 0) spellings += 1;
    list.push(entry);
    shard[key] = list;
    shards.set(shardFor(key), shard);
  };

  for (const paradigm of paradigms) {
    const entry: ShardEntry = {
      lemma: paradigm.lemma,
      family: paradigm.family,
      forms: paradigm.forms,
      ...(paradigm.certain ? {} : { certain: false }),
    };
    add(paradigm.lemma, entry);
    // Every spelling the paradigm contains is a way in, which is what lets
    // `children` and `forgave` be looked up directly.
    for (const spelling of Object.values(paradigm.forms)) {
      if (spelling) add(spelling, entry);
    }
  }

  // Written fresh: a rebuild after switching datasets must not leave shards of
  // the old one behind to be found by a later lookup.
  await rm(path.join(sourceDir(source.id), 'index'), { recursive: true, force: true });
  await mkdir(path.join(sourceDir(source.id), 'index'), { recursive: true });
  for (const [name, shard] of shards) {
    await writeFile(shardPath(source.id, name), JSON.stringify(shard), 'utf8');
  }

  const meta: IndexMeta = {
    sourceId: source.id,
    builtAt: new Date().toISOString(),
    paradigms: paradigms.length,
    spellings,
    shards: shards.size,
    skipped: Math.max(0, lines - paradigms.length),
  };
  await writeFile(metaPath(source.id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  loaded.clear();

  return { meta, bytes, from, ms: Date.now() - started };
}

/* ------------------------------------------------------------------ *
 * Looking a word up
 * ------------------------------------------------------------------ */

const loaded = new Map<string, Shard>();

async function shardOf(sourceId: string, spelling: string): Promise<Shard | undefined> {
  const name = shardFor(spelling);
  const key = `${sourceId}/${name}`;
  const held = loaded.get(key);
  if (held) {
    // Touched, so it goes to the back of the queue rather than being dropped next.
    loaded.delete(key);
    loaded.set(key, held);
    return held;
  }

  let shard: Shard;
  try {
    shard = JSON.parse(await readFile(shardPath(sourceId, name), 'utf8')) as Shard;
  } catch {
    return undefined;
  }
  loaded.set(key, shard);
  while (loaded.size > SHARD_LIMIT) {
    const oldest = loaded.keys().next().value;
    if (oldest === undefined) break;
    loaded.delete(oldest);
  }
  return shard;
}

/**
 * Every form of a word, read as the given type.
 *
 * Reading matters: `saw` as a noun has a plural, and as a verb it is the past of
 * `see`, and the dataset holds both. The type comes from the dictionary, so the
 * two answers never have to be guessed between.
 *
 * Nothing comes back when the dataset has no paradigm for the word — which is a
 * fact about the dataset, not about the word, and is reported as such rather than
 * filled in.
 */
export async function lookupForms(
  spelling: string,
  type: WordType,
  prefer = '',
): Promise<Variations | undefined> {
  const family = familyForType(type);
  if (!family) return undefined;
  const { source } = activeMorphology(prefer);
  const shard = await shardOf(source.id, spelling);
  const key = spelling.toLowerCase();
  // `Object.hasOwn`, not `shard[key]`: a shard read back from JSON has the usual
  // prototype, so `shard.constructor` would answer for a word it does not hold.
  const entries = shard && Object.hasOwn(shard, key) ? shard[key] : undefined;
  if (!entries || entries.length === 0) return undefined;

  const matches = entries.filter((entry) => entry.family === family);
  if (matches.length === 0) return undefined;

  // A word that is its own lemma is the right answer over one that is some other
  // word's form: `lay` the verb, not `lay` as the past of `lie`.
  const own = matches.find((entry) => entry.lemma === key);
  if (own) return own.forms;

  /*
   * Otherwise this spelling is some other word's form, and occasionally several
   * words claim it — `crises` is the plural of `crisis`, and the dataset also
   * lists it under `cris` and `crise`, which are not words. The one whose part of
   * speech the dataset could confirm is the answer; it is the dataset's own
   * signal rather than a rule about English, which is the only kind of tie-break
   * worth having here.
   */
  const confirmed = matches.find((entry) => entry.certain !== false);
  return (confirmed ?? matches[0])!.forms;
}

/** Whether the active dataset has been downloaded and indexed here. */
export async function morphologyStatus(prefer = ''): Promise<MorphologyStatus> {
  const { source, reason } = activeMorphology(prefer);
  const meta = await readMeta(source.id);
  return {
    sources: MORPHOLOGY_SOURCES.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      note: candidate.note,
      homeUrl: candidate.homeUrl,
      approxBytes: candidate.approxBytes,
    })),
    activeId: source.id,
    reason: MORPHOLOGY_FILE_OVERRIDE
      ? `VIBETOON_MORPHOLOGY_FILE points at ${MORPHOLOGY_FILE_OVERRIDE}`
      : reason,
    ready: meta !== undefined,
    paradigms: meta?.paradigms ?? 0,
    spellings: meta?.spellings ?? 0,
    ...(meta?.builtAt ? { builtAt: meta.builtAt } : {}),
  };
}

/** Forget the cached shards. For tests, and after the data directory is cleared. */
export function resetMorphologyCache(): void {
  loaded.clear();
}
