/**
 * A record of every call the studio makes to something outside itself.
 *
 * The flows keep their own run logs, but those only cover generating. When a
 * dictionary lookup comes back short or a corpus will not download, the useful
 * detail — which word, which attempt, what the service actually said — happens
 * on the server and used to go nowhere at all. These entries are that detail.
 */
export type LogOutcome =
  | 'ok'
  /** The service answered, but has no entry for what was asked. */
  | 'missing'
  /** Answered from the disk cache; nothing left this machine. */
  | 'cached'
  /** Failed, and is about to be tried again. */
  | 'retry'
  /** The service asked us to slow down. */
  | 'rate-limited'
  /** Gave up waiting for an answer. */
  | 'timeout'
  /** Failed for good. */
  | 'failed';

export const LOG_OUTCOMES: readonly LogOutcome[] = [
  'ok',
  'missing',
  'cached',
  'retry',
  'rate-limited',
  'timeout',
  'failed',
];

export interface ApiLogEntry {
  /** Monotonic within a server run, so a viewer can ask for “anything after this”. */
  seq: number;
  at: string;
  /** Which service was called: `dictionary`, `corpus`, and so on. */
  service: string;
  method: string;
  url: string;
  /** What was being looked up or fetched, for a readable list: a word, a host. */
  subject?: string;
  status?: number;
  outcome: LogOutcome;
  durationMs: number;
  /** 1 for the first go at a word, 2 for the first retry, and so on. */
  attempt?: number;
  bytes?: number;
  /** The error, or a note about what was decided. */
  detail?: string;
}

export interface ApiLogPage {
  entries: ApiLogEntry[];
  /** The newest seq the server holds, so a viewer knows if it is behind. */
  latest: number;
  /** Entries dropped off the end of the buffer since the server started. */
  dropped: number;
  /** Where the entries are also being written, when they are. */
  file: string | null;
}

/** The outcomes worth coloring as a problem. */
export function isLogProblem(outcome: LogOutcome): boolean {
  return outcome === 'failed' || outcome === 'timeout' || outcome === 'rate-limited' || outcome === 'retry';
}
