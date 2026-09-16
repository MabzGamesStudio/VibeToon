import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isLogProblem, type ApiLogEntry } from '@vibetoon/shared';
import { api } from '../../api/client';
import { Modal } from './Modal';

const POLL_MS = 2_000;

/** A row's colour: what happened, not how the request was phrased. */
const OUTCOME_CLASS: Record<string, string> = {
  ok: 'is-ready',
  cached: 'is-empty',
  missing: 'is-empty',
  retry: 'is-stale',
  'rate-limited': 'is-stale',
  timeout: 'is-error',
  failed: 'is-error',
};

function clock(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? iso
    : `${when.toTimeString().slice(0, 8)}.${String(when.getMilliseconds()).padStart(3, '0')}`;
}

function bytes(count: number | undefined): string {
  if (count === undefined) return '';
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} kB`;
  return `${(count / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Everything the studio has asked of the outside world.
 *
 * A flow's run log says what generating did; this says what left the machine —
 * which word was looked up, what the dictionary answered, how long it took, and
 * which attempt it was. It is the view you want open while a lookup is running
 * and coming back short.
 */
export function LogViewer({ onClose }: { onClose(): void }): JSX.Element {
  const [entries, setEntries] = useState<ApiLogEntry[]>([]);
  const [service, setService] = useState<'all' | 'dictionary' | 'corpus'>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const sinceRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const load = useCallback(async (reset: boolean) => {
    try {
      const page = await api.logs(reset ? { limit: 500 } : { since: sinceRef.current, limit: 500 });
      sinceRef.current = page.latest;
      setFile(page.file);
      setDropped(page.dropped);
      setError(null);
      // The buffer is capped server-side, so the viewer caps too rather than
      // growing without bound across a long session.
      setEntries((current) => (reset ? page.entries : [...current, ...page.entries].slice(-2_000)));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  // Follow the tail while the reader is at the bottom, and leave them alone the
  // moment they scroll up to look at something.
  useEffect(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [entries]);

  const shown = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (service === 'all' || entry.service === service) &&
          (!problemsOnly || isLogProblem(entry.outcome)),
      ),
    [entries, problemsOnly, service],
  );

  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const entry of entries) tally[entry.outcome] = (tally[entry.outcome] ?? 0) + 1;
    return tally;
  }, [entries]);

  return (
    <Modal
      title="API log"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="vt-faint" style={{ fontSize: 11 }}>
            {file ? <>Also written to <code>{file}</code></> : 'Held in memory only.'}
            {dropped > 0 ? ` · ${dropped.toLocaleString()} older entries have scrolled off.` : ''}
          </span>
          <span className="vt-spacer" />
          <button
            type="button"
            className="vt-btn is-small"
            title="Read back what the file holds, including anything a server restart lost"
            onClick={() => {
              void api
                .logFile(500)
                .then((page) => {
                  setEntries(page.entries);
                  setLive(false);
                })
                .catch((cause: Error) => setError(cause.message));
            }}
          >
            Load from file
          </button>
          <button
            type="button"
            className="vt-btn is-small"
            disabled={entries.length === 0}
            onClick={() => void navigator.clipboard?.writeText(JSON.stringify(shown, null, 2))}
          >
            Copy {shown.length.toLocaleString()} as JSON
          </button>
          <button
            type="button"
            className="vt-btn is-small is-danger"
            onClick={() => {
              void api.clearLogs().then(() => {
                sinceRef.current = 0;
                setEntries([]);
                setSelected(null);
              });
            }}
          >
            Clear
          </button>
        </>
      }
    >
      <div className="vt-row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="vt-tabs">
          {(['all', 'dictionary', 'corpus'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`vt-btn is-small${service === option ? ' is-active' : ''}`}
              onClick={() => setService(option)}
            >
              {option === 'all' ? 'Everything' : option === 'dictionary' ? 'Dictionary' : 'Corpus'}
            </button>
          ))}
        </div>
        <label className="vt-row" style={{ gap: 5 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={problemsOnly}
            onChange={(event) => setProblemsOnly(event.target.checked)}
          />
          <span className="vt-faint">problems only</span>
        </label>
        <label className="vt-row" style={{ gap: 5 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={live}
            onChange={(event) => {
              setLive(event.target.checked);
              if (event.target.checked) void load(true);
            }}
          />
          <span className="vt-faint">live</span>
        </label>
        <span className="vt-spacer" />
        {Object.entries(counts).map(([outcome, count]) => (
          <span key={outcome} className={`vt-pill ${OUTCOME_CLASS[outcome] ?? ''}`}>
            {outcome} {count.toLocaleString()}
          </span>
        ))}
      </div>

      {error ? <div className="vt-pill is-error">Could not read the log: {error}</div> : null}

      <div
        className="vt-log"
        ref={listRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 ? (
          <div className="vt-empty">
            Nothing yet. Looking a word up in a Word Database flow, or fetching a corpus, is recorded here —
            every attempt, what the service answered, and how long it took.
          </div>
        ) : (
          shown.map((entry) => (
            <div key={entry.seq}>
              <button
                type="button"
                className={`vt-log-row${selected === entry.seq ? ' is-open' : ''}`}
                onClick={() => setSelected(selected === entry.seq ? null : entry.seq)}
              >
                <span className="vt-log-time">{clock(entry.at)}</span>
                <span className="vt-log-service">{entry.service}</span>
                <span className={`vt-pill ${OUTCOME_CLASS[entry.outcome] ?? ''}`}>{entry.outcome}</span>
                <span className="vt-log-subject">{entry.subject ?? entry.url}</span>
                <span className="vt-log-num">{entry.status ?? ''}</span>
                <span className="vt-log-num">{entry.attempt && entry.attempt > 1 ? `try ${entry.attempt}` : ''}</span>
                <span className="vt-log-num">{entry.durationMs}ms</span>
                <span className="vt-log-num">{bytes(entry.bytes)}</span>
              </button>
              {selected === entry.seq ? (
                <div className="vt-log-detail">
                  <dl className="vt-kv">
                    <dt>When</dt>
                    <dd>{entry.at}</dd>
                    <dt>Request</dt>
                    <dd>
                      <code>
                        {entry.method} {entry.url}
                      </code>
                    </dd>
                    {entry.detail ? (
                      <>
                        <dt>What happened</dt>
                        <dd>{entry.detail}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
