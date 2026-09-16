import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiLogEntry, ApiLogPage, LogOutcome } from '@vibetoon/shared';
import { DATA_ROOT } from './paths';

/**
 * Where calls to the outside world are recorded.
 *
 * Kept in memory so the viewer is instant, and appended to a file so a restart
 * — which `tsx --watch` does on every save — does not throw away the evidence
 * you were in the middle of reading. The file is capped and rotated once, which
 * is enough to debug a lookup without quietly filling a disk.
 */
const BUFFER_SIZE = 1_000;
const FILE_LIMIT_BYTES = 2 * 1024 * 1024;

export const LOG_DIR = path.join(DATA_ROOT, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'api.jsonl');

/** Writing to disk is off in tests, which would otherwise litter temp dirs. */
const PERSIST = process.env.VIBETOON_LOG_FILE !== 'off';

let buffer: ApiLogEntry[] = [];
let seq = 0;
let dropped = 0;
/** Appends are chained so two calls finishing at once cannot interleave a line. */
let writing: Promise<void> = Promise.resolve();

export interface LogInput {
  service: string;
  method?: string;
  url: string;
  subject?: string;
  status?: number;
  outcome: LogOutcome;
  durationMs: number;
  attempt?: number;
  bytes?: number;
  detail?: string;
}

/**
 * The URL is shown to whoever opens the viewer, so anything that looks like a
 * credential is masked before it is stored. A dictionary key in a query string
 * is the case that matters: it arrives from the environment and should not be
 * copied into a log file or a screenshot.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|auth|apikey|app_id/i.test(key)) url.searchParams.set(key, '…');
    }
    if (url.username || url.password) {
      url.username = '…';
      url.password = '';
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function recordApiCall(input: LogInput): ApiLogEntry {
  seq += 1;
  const entry: ApiLogEntry = {
    seq,
    at: new Date().toISOString(),
    service: input.service,
    method: input.method ?? 'GET',
    url: redactUrl(input.url),
    outcome: input.outcome,
    durationMs: Math.round(input.durationMs),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };

  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) {
    dropped += buffer.length - BUFFER_SIZE;
    buffer = buffer.slice(-BUFFER_SIZE);
  }
  if (PERSIST) writing = writing.then(() => persist(entry)).catch(() => undefined);
  return entry;
}

async function persist(entry: ApiLogEntry): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  const size = await stat(LOG_FILE).then((info) => info.size).catch(() => 0);
  if (size > FILE_LIMIT_BYTES) {
    // One generation of history is kept, so the file never grows without bound
    // but the run before this one is still readable.
    await rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => undefined);
  }
  await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Time a call and record whatever it turns out to be. */
export async function timed<T>(
  input: Omit<LogInput, 'durationMs' | 'outcome'>,
  run: () => Promise<{ outcome: LogOutcome; status?: number; bytes?: number; detail?: string; value: T }>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    recordApiCall({
      ...input,
      durationMs: Date.now() - started,
      outcome: result.outcome,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    });
    return result.value;
  } catch (error) {
    recordApiCall({
      ...input,
      durationMs: Date.now() - started,
      outcome: 'failed',
      detail: (error as Error).message,
    });
    throw error;
  }
}

export interface ReadLogsOptions {
  /** Only entries newer than this seq. */
  since?: number;
  /** Only these services. */
  service?: string;
  limit?: number;
}

export function readLogs(options: ReadLogsOptions = {}): ApiLogPage {
  const limit = Math.max(1, Math.min(2_000, options.limit ?? 300));
  let entries = buffer;
  if (options.since !== undefined) entries = entries.filter((entry) => entry.seq > options.since!);
  if (options.service) entries = entries.filter((entry) => entry.service === options.service);
  return {
    entries: entries.slice(-limit),
    latest: seq,
    dropped,
    file: PERSIST ? LOG_FILE : null,
  };
}

export function clearLogs(): void {
  buffer = [];
  dropped = 0;
  if (PERSIST) writing = writing.then(() => writeFile(LOG_FILE, '', 'utf8')).catch(() => undefined);
}

/** Read back what was written to disk, for whatever a restart lost from memory. */
export async function readLogFile(limit = 300): Promise<ApiLogEntry[]> {
  if (!PERSIST) return [];
  const body = await readFile(LOG_FILE, 'utf8').catch(() => '');
  return body
    .split('\n')
    .filter((line) => line.trim())
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ApiLogEntry];
      } catch {
        return [];
      }
    });
}

/** Everything settles before the process exits, so nothing is lost on shutdown. */
export function flushLogs(): Promise<void> {
  return writing;
}
