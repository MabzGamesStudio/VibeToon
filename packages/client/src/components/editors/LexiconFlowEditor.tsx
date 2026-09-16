import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CORPUS_SOURCES,
  WORD_TYPES,
  WORD_TYPE_LABEL,
  addDataset,
  extractCorpus,
  fillTokenMeanings,
  masterDataset,
  lookupProgress,
  masterLexicon,
  removeDataset,
  sampleDataset,
  setIncluded,
  summarise,
  wordsNeedingLookup,
  type CorpusDataset,
  type FlowNode,
  type LexiconFlowData,
  type Project,
  type WordType,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { InfoTip } from '../common/InfoTip';
import { formatWhen } from '../common/format';
import { EditorShell } from './EditorShell';

/**
 * Words per request. Small enough that a batch comes back in a few seconds and
 * its answers are saved before the next one starts, large enough that a
 * thousand-word database is a handful of calls rather than a thousand.
 */
const BATCH_SIZE = 100;

const SOURCE_LABEL: Record<CorpusDataset['source']['kind'], string> = {
  builtin: 'built in',
  pasted: 'pasted',
  url: 'fetched',
  flow: 'from a flow',
};

export function LexiconFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data as LexiconFlowData;
  const [tab, setTab] = useState<'corpora' | 'words'>('corpora');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const stopRef = useRef(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const master = useMemo(() => masterDataset(data), [data]);
  const lexicon = useMemo(() => masterLexicon(data, master), [data, master]);
  const summary = useMemo(() => summarise(data, lexicon, master), [data, lexicon, master]);
  const pending = useMemo(() => wordsNeedingLookup(data, master), [data, master]);

  const patch = useCallback((next: LexiconFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);

  const addCorpus = useCallback(
    (text: string, name: string, source: CorpusDataset['source']) => {
      const trimmed = text.trim();
      if (!trimmed) {
        notify('warn', 'There is no text to count.');
        return;
      }
      const dataset = extractCorpus(trimmed, name.trim() || 'Corpus', source, data.extract);
      patch(fillTokenMeanings(addDataset(data, dataset)));
      notify(
        'success',
        `Counted ${dataset.tokenCount.toLocaleString()} tokens from “${dataset.name}” — ${dataset.entries.length} words kept.`,
      );
    },
    [data, notify, patch],
  );

  const fetchCorpus = useCallback(async () => {
    if (!url.trim()) return;
    setBusy('Fetching…');
    try {
      const fetched = await api.fetchCorpus(url.trim());
      addCorpus(fetched.text, fetched.name, { kind: 'url', reference: fetched.url });
      setUrl('');
      if (fetched.truncated) notify('warn', 'That file was very large, so only the first part was counted.');
    } catch (error) {
      notify('error', `Could not fetch that: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [addCorpus, notify, url]);

  /**
   * Look the undefined words up a batch at a time.
   *
   * A database built from a book runs to thousands of words, and a dictionary
   * service will not answer thousands of requests in a row — it throttles, or
   * simply stops. So each call asks about a few hundred, the answers are saved
   * as they arrive, and the loop carries on from what the server says it did not
   * get to. Saving each batch means stopping half way still keeps the work.
   */
  const lookUp = useCallback(async () => {
    if (pending.length === 0) return;
    stopRef.current = false;
    const total = pending.length;
    let queue = [...pending];
    let meanings = { ...data.meanings };
    const tally = { found: 0, missing: 0, failed: 0, cached: 0, rateLimited: 0 };

    setProgress({ done: 0, total });
    setBusy(`Looking up ${total.toLocaleString()} word(s)…`);
    try {
      while (queue.length > 0) {
        if (stopRef.current) {
          notify('warn', `Stopped after ${total - queue.length} of ${total} word(s). What was found is kept.`);
          return;
        }

        const batch = queue.slice(0, BATCH_SIZE);
        const result = await api.lookupWords(batch, BATCH_SIZE);

        meanings = { ...meanings, ...result.meanings };
        patch({ ...data, meanings });
        tally.found += result.found.length;
        tally.missing += result.missing.length;
        tally.failed += result.failed.length;
        tally.cached += result.cached;
        tally.rateLimited += result.rateLimited;

        // Anything the server did not get to goes back on the front of the
        // queue; anything it settled — defined, missing, or failed — does not.
        const settled = new Set([...result.found, ...result.missing, ...result.failed]);
        const leftInBatch = batch.filter((word) => !settled.has(word) && !(word in result.meanings));
        queue = [...result.remaining.filter((word) => batch.includes(word)), ...leftInBatch, ...queue.slice(batch.length)];
        queue = [...new Set(queue)];

        const done = total - queue.length;
        setProgress({ done, total });
        setBusy(`Looked up ${done.toLocaleString()} of ${total.toLocaleString()}…`);

        if (result.unreachable) {
          notify(
            'error',
            `${result.unreachable} ${done.toLocaleString()} of ${total.toLocaleString()} word(s) were done; the rest keep their guessed type. Try again later to carry on.`,
          );
          return;
        }
        if (result.rateLimited > 0 && result.retryAfterMs) {
          notify('warn', `The dictionary asked us to wait ${Math.ceil(result.retryAfterMs / 1000)}s — slowing down.`);
          await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
        }
      }

      notify(
        'success',
        `Defined ${tally.found.toLocaleString()} word(s)${tally.cached > 0 ? ` (${tally.cached.toLocaleString()} from the cache)` : ''}${
          tally.missing > 0 ? `, ${tally.missing.toLocaleString()} not in the dictionary` : ''
        }${tally.failed > 0 ? `, ${tally.failed.toLocaleString()} could not be looked up` : ''}${
          tally.rateLimited > 0 ? `, slowed down ${tally.rateLimited} time(s)` : ''
        }.`,
      );
    } catch (error) {
      const done = total - queue.length;
      notify(
        'error',
        `Lookup stopped after ${done.toLocaleString()} of ${total.toLocaleString()}: ${(error as Error).message}`,
      );
    } finally {
      setBusy(null);
      setProgress(null);
      stopRef.current = false;
    }
  }, [data, notify, patch, pending]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lexicon.lexemes
      .filter((lexeme) => !needle || lexeme.spelling.includes(needle))
      .sort((a, b) => (b.stats?.count ?? 0) - (a.stats?.count ?? 0))
      .slice(0, 400);
  }, [lexicon.lexemes, query]);

  const current = selected ? lexicon.lexemes.find((lexeme) => lexeme.id === selected) : undefined;
  const currentEntry = current ? master.entries.find((entry) => entry.spelling === current.spelling) : undefined;
  const byId = useMemo(() => new Map(lexicon.lexemes.map((lexeme) => [lexeme.id, lexeme])), [lexicon.lexemes]);

  const setMeaning = (spelling: string, change: { type?: WordType; description?: string }) => {
    const existing = data.meanings[spelling];
    patch({
      ...data,
      meanings: {
        ...data.meanings,
        [spelling]: {
          type: change.type ?? existing?.type ?? 'noun',
          description: change.description ?? existing?.description ?? '',
          source: 'manual',
        },
      },
    });
  };

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      actions={
        <div className="vt-tabs">
          <button
            type="button"
            className={`vt-btn is-small${tab === 'corpora' ? ' is-active' : ''}`}
            onClick={() => setTab('corpora')}
          >
            Corpora
          </button>
          <button
            type="button"
            className={`vt-btn is-small${tab === 'words' ? ' is-active' : ''}`}
            onClick={() => setTab('words')}
          >
            Words
          </button>
        </div>
      }
      banner={
        busy ? (
          <div className="vt-sync-banner">
            <span>{busy}</span>
          </div>
        ) : null
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The database</h3>
          <dl className="vt-kv">
            <dt>Words</dt>
            <dd>{summary.words.toLocaleString()}</dd>
            <dt>Tokens counted</dt>
            <dd>{summary.tokens.toLocaleString()}</dd>
            <dt>Context links</dt>
            <dd>{summary.links.toLocaleString()}</dd>
            <dt>Corpora</dt>
            <dd>
              {summary.included} of {summary.datasets} included
            </dd>
            <dt>Defined</dt>
            <dd>
              {summary.defined.toLocaleString()} from the dictionary
              {summary.undefined > 0 ? `, ${summary.undefined.toLocaleString()} guessed` : ''}
            </dd>
          </dl>
          <div className="vt-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={pending.length === 0 || progress !== null}
              onClick={() => void lookUp()}
            >
              Look up {pending.length.toLocaleString()} word{pending.length === 1 ? '' : 's'}
            </button>
            {progress ? (
              <button type="button" className="vt-btn is-small" onClick={() => (stopRef.current = true)}>
                Stop
              </button>
            ) : null}
          </div>
          {progress ? (
            <div className="vt-progress" role="progressbar" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}>
              <div
                className="vt-progress-bar"
                style={{ width: `${Math.round(lookupProgress(progress.done, progress.total) * 100)}%` }}
              />
              <span>
                {progress.done.toLocaleString()} of {progress.total.toLocaleString()} in batches of {BATCH_SIZE}
              </span>
            </div>
          ) : null}
          <div className="vt-hint">
            Asks a dictionary for each word’s type and definition, {BATCH_SIZE} at a time so the service is not
            flooded. Answers are cached, so a word is only ever fetched once — stopping part way keeps what was
            found, and running it again carries on.
          </div>
        </div>

        <div className="vt-section">
          <h3>Counting</h3>
          <div className="vt-hint" style={{ marginBottom: 8 }}>
            Applied when a corpus is added. A dataset keeps the counts it was pruned to, so changing these
            affects the next corpus you add, not the ones already counted.
          </div>
          <Field label="Words kept per corpus" tip="lexicon.maxWords">
            <input
              type="number"
              min={50}
              step={50}
              value={data.extract.maxWords}
              onChange={(event) =>
                patch({ ...data, extract: { ...data.extract, maxWords: Number(event.target.value) || 50 } })
              }
            />
          </Field>
          <Field label="Links kept per word" tip="lexicon.maxLinksPerWord">
            <input
              type="number"
              min={1}
              value={data.extract.maxLinksPerWord}
              onChange={(event) =>
                patch({
                  ...data,
                  extract: { ...data.extract, maxLinksPerWord: Number(event.target.value) || 1 },
                })
              }
            />
          </Field>
          <Field label="A pair must occur" tip="lexicon.minPairCount" hint="Times a pair has to turn up before it is kept.">
            <input
              type="number"
              min={1}
              value={data.extract.minPairCount}
              onChange={(event) =>
                patch({ ...data, extract: { ...data.extract, minPairCount: Number(event.target.value) || 1 } })
              }
            />
          </Field>
          <label className="vt-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={data.extract.includePunctuation}
              onChange={(event) =>
                patch({
                  ...data,
                  extract: { ...data.extract, includePunctuation: event.target.checked },
                })
              }
            />
            <span>Count punctuation as words</span>
            <InfoTip tip="lexicon.includePunctuation" label="Count punctuation as words" />
          </label>
        </div>

        <div className="vt-section">
          <h3>Weighting</h3>
          <div className="vt-hint" style={{ marginBottom: 8 }}>
            Applied every time the database is derived, so these can be changed freely.
          </div>
          <Field
            label="Lift ceiling"
            tip="lexicon.liftCeiling"
            hint="How much more often a word must follow another than it appears at all to count as a full-strength link."
          >
            <input
              type="number"
              min={2}
              step={1}
              value={data.derive.liftCeiling}
              onChange={(event) =>
                patch({ ...data, derive: { ...data.derive, liftCeiling: Number(event.target.value) || 2 } })
              }
            />
          </Field>
          <Field label="Weakest link kept" tip="lexicon.minWeight">
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={data.derive.minWeight}
              onChange={(event) =>
                patch({ ...data, derive: { ...data.derive, minWeight: Number(event.target.value) || 0 } })
              }
            />
          </Field>
          <Field label="Contexts per word" tip="lexicon.maxContexts">
            <input
              type="number"
              min={1}
              value={data.derive.maxContexts}
              onChange={(event) =>
                patch({ ...data, derive: { ...data.derive, maxContexts: Number(event.target.value) || 1 } })
              }
            />
          </Field>
        </div>
      </aside>

      {tab === 'corpora' ? (
        <div className="vt-editor-main">
          <div className="vt-row" style={{ marginBottom: 10 }}>
            <strong>Corpora</strong>
            <span className="vt-faint">
              Tick a corpus to count it into the database; untick it to take it back out exactly.
            </span>
          </div>

          <div className="vt-corpora">
            {data.datasets.map((dataset) => {
              const included = data.included.includes(dataset.id);
              return (
                <div key={dataset.id} className={`vt-corpus${included ? ' is-included' : ''}`}>
                  <label className="vt-corpus-check">
                    <input
                      type="checkbox"
                      checked={included}
                      aria-label={`Include ${dataset.name}`}
                      onChange={(event) => patch(setIncluded(data, dataset.id, event.target.checked))}
                    />
                  </label>
                  <div className="vt-corpus-body">
                    <div className="vt-row" style={{ gap: 6 }}>
                      <strong>{dataset.name}</strong>
                      <span className="vt-pill">{SOURCE_LABEL[dataset.source.kind]}</span>
                      <span className="vt-spacer" />
                      <span className="vt-faint" style={{ fontSize: 11 }}>
                        {formatWhen(dataset.createdAt)}
                      </span>
                    </div>
                    <div className="vt-faint" style={{ fontSize: 11 }}>
                      {dataset.tokenCount.toLocaleString()} tokens · {dataset.entries.length.toLocaleString()} words
                      kept of {dataset.distinctCount.toLocaleString()} ·{' '}
                      {dataset.entries.reduce((sum, entry) => sum + entry.next.length, 0).toLocaleString()} pairs
                      {dataset.source.reference ? ` · ${dataset.source.reference}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="vt-btn is-ghost is-small is-danger"
                    title="Remove this corpus"
                    onClick={() => {
                      if (!window.confirm(`Remove “${dataset.name}” from this database?`)) return;
                      patch(removeDataset(data, dataset.id));
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {data.datasets.length === 0 ? <div className="vt-empty">No corpora yet.</div> : null}
          </div>

          <div className="vt-section">
            <h3>Add a corpus</h3>

            <Field
              label="From the web"
              tip="lexicon.corpusUrl"
              hint="Any plain-text address. A Project Gutenberg file has its licence header and footer trimmed off."
            >
              <div className="vt-row">
                <input
                  value={url}
                  placeholder="https://…"
                  aria-label="Corpus URL"
                  onChange={(event) => setUrl(event.target.value)}
                />
                <button
                  type="button"
                  className="vt-btn"
                  disabled={!url.trim() || busy !== null}
                  onClick={() => void fetchCorpus()}
                >
                  Fetch and count
                </button>
              </div>
            </Field>
            <div className="vt-corpus-suggestions">
              {DEFAULT_CORPUS_SOURCES.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  className="vt-btn is-small"
                  title={`${source.author} — ${source.note}`}
                  onClick={() => setUrl(source.url)}
                >
                  {source.title}
                </button>
              ))}
              <button
                type="button"
                className="vt-btn is-small"
                title="The short sample written for this project"
                onClick={() => {
                  const sample = sampleDataset();
                  patch(fillTokenMeanings(addDataset(data, sample)));
                }}
              >
                + Workshop sample
              </button>
            </div>

            <Field
              label="Or paste text"
              tip="lexicon.pasteText"
              hint="Anything you have the right to use — a script, a transcript, your own writing."
            >
              <input
                value={pasteName}
                placeholder="Name for this corpus"
                aria-label="Pasted corpus name"
                onChange={(event) => setPasteName(event.target.value)}
              />
              <textarea
                rows={6}
                value={pasteText}
                placeholder="Paste the text to count…"
                aria-label="Corpus text"
                style={{ marginTop: 6 }}
                onChange={(event) => setPasteText(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="vt-btn"
              disabled={!pasteText.trim()}
              onClick={() => {
                addCorpus(pasteText, pasteName || 'Pasted text', { kind: 'pasted' });
                setPasteText('');
                setPasteName('');
              }}
            >
              Count this text
            </button>
            <div className="vt-hint" style={{ marginTop: 8 }}>
              Text wired into this flow’s Corpus input is counted too, as a corpus of its own, and re-counted
              whenever the flow runs.
            </div>
          </div>
        </div>
      ) : (
        <div className="vt-editor-main" style={{ padding: 0, display: 'flex', minHeight: 0 }}>
          <div className="vt-lexicon">
            <div className="vt-lexicon-list">
              <div className="vt-lexicon-tools">
                <input
                  value={query}
                  placeholder="Search words…"
                  aria-label="Search words"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="vt-faint" style={{ fontSize: 11, padding: '0 8px 6px' }}>
                {summary.words.toLocaleString()} words · showing {filtered.length.toLocaleString()}, most common
                first
              </div>
              <div className="vt-lexeme-rows vt-scroll">
                {filtered.map((lexeme) => (
                  <button
                    key={lexeme.id}
                    type="button"
                    className={`vt-lexeme-row${lexeme.id === selected ? ' is-selected' : ''}`}
                    onClick={() => setSelected(lexeme.id)}
                  >
                    <span className="vt-lexeme-spelling">{lexeme.spelling}</span>
                    <span className="vt-lexeme-type">{lexeme.type.slice(0, 4)}</span>
                    <span className="vt-freq-bar" title={`frequency ${lexeme.frequency.toFixed(2)}`}>
                      <i style={{ width: `${Math.round(lexeme.frequency * 100)}%` }} />
                    </span>
                    <span className="vt-lexeme-links">{lexeme.stats?.count ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="vt-lexeme-detail vt-scroll">
              {!current ? (
                <div className="vt-empty">Pick a word to see where its numbers came from.</div>
              ) : (
                <>
                  <div className="vt-row" style={{ marginBottom: 8 }}>
                    <h2>{current.spelling}</h2>
                    <span className="vt-pill">
                      {data.meanings[current.spelling]?.source ?? 'guessed'}
                    </span>
                  </div>
                  <dl className="vt-kv">
                    <dt>Count</dt>
                    <dd>
                      {current.stats?.count.toLocaleString()} ({current.stats?.perMillion.toLocaleString()} per
                      million)
                    </dd>
                    <dt>Frequency</dt>
                    <dd>{current.frequency.toFixed(2)}</dd>
                  </dl>

                  <Field label="Word type" tip="lexicon.wordType" hint="From the dictionary, or your correction.">
                    <select
                      value={current.type}
                      onChange={(event) =>
                        setMeaning(current.spelling, { type: event.target.value as WordType })
                      }
                    >
                      {WORD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {WORD_TYPE_LABEL[type]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Description" tip="lexicon.description">
                    <textarea
                      rows={3}
                      value={current.description}
                      placeholder="No definition yet."
                      onChange={(event) =>
                        setMeaning(current.spelling, { description: event.target.value })
                      }
                    />
                  </Field>

                  <div className="vt-section">
                    <h3>
                      <span>What follows it</span>
                      <span className="vt-faint">{current.contexts.length} link(s)</span>
                    </h3>
                    <div className="vt-hint" style={{ marginBottom: 6 }}>
                      Counted out of the corpus: how much more often each word follows this one than it turns up
                      at all. These are derived, so they change when the corpora or the weighting change.
                    </div>
                    {current.contexts.map((context) => {
                      const target = byId.get(context.id);
                      const pairs = currentEntry?.next.find(([spelling]) => spelling === target?.spelling)?.[1];
                      return (
                        <div className="vt-context-row" key={context.id}>
                          <button
                            type="button"
                            className="vt-context-name"
                            onClick={() => setSelected(context.id)}
                          >
                            {target?.spelling ?? context.id}
                          </button>
                          <span className="vt-freq-bar" title={`weight ${context.weight.toFixed(2)}`}>
                            <i style={{ width: `${Math.round(context.weight * 100)}%` }} />
                          </span>
                          <span className="vt-context-weight">{context.weight.toFixed(2)}</span>
                          <span className="vt-faint" style={{ fontSize: 10 }}>
                            {pairs ? `${pairs}×` : ''}
                          </span>
                        </div>
                      );
                    })}
                    {current.contexts.length === 0 ? (
                      <div className="vt-empty">Nothing follows it often enough to be worth keeping.</div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </EditorShell>
  );
}
