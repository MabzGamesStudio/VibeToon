import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_CORPUS_SOURCES,
  WORD_TYPES,
  WORD_TYPE_LABEL,
  addDataset,
  extractCorpus,
  fillTokenMeanings,
  masterDataset,
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
import { formatWhen } from '../common/format';
import { EditorShell } from './EditorShell';

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

  const lookUp = useCallback(async () => {
    if (pending.length === 0) return;
    setBusy(`Looking up ${pending.length} word(s)…`);
    try {
      const result = await api.lookupWords(pending);
      patch({ ...data, meanings: { ...data.meanings, ...result.meanings } });
      if (result.unreachable) {
        notify(
          'error',
          `${result.unreachable} ${result.found.length} word(s) were already cached; the rest keep their guessed type.`,
        );
      } else {
        notify(
          'success',
          `Defined ${result.found.length} word(s)${result.cached > 0 ? ` (${result.cached} from the cache)` : ''}${
            result.missing.length > 0 ? `, ${result.missing.length} not in the dictionary` : ''
          }.`,
        );
      }
    } catch (error) {
      notify('error', `Lookup failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
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
          <button
            type="button"
            className="vt-btn is-small"
            style={{ marginTop: 8 }}
            disabled={pending.length === 0 || busy !== null}
            onClick={() => void lookUp()}
          >
            Look up {pending.length.toLocaleString()} word{pending.length === 1 ? '' : 's'}
          </button>
          <div className="vt-hint">
            Asks a dictionary for each word’s type and definition. Answers are cached, so a word is only ever
            fetched once.
          </div>
        </div>

        <div className="vt-section">
          <h3>Counting</h3>
          <div className="vt-hint" style={{ marginBottom: 8 }}>
            Applied when a corpus is added. A dataset keeps the counts it was pruned to, so changing these
            affects the next corpus you add, not the ones already counted.
          </div>
          <Field label="Words kept per corpus">
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
          <Field label="Links kept per word">
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
          <Field label="A pair must occur" hint="Times a pair has to turn up before it is kept.">
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
          </label>
        </div>

        <div className="vt-section">
          <h3>Weighting</h3>
          <div className="vt-hint" style={{ marginBottom: 8 }}>
            Applied every time the database is derived, so these can be changed freely.
          </div>
          <Field
            label="Lift ceiling"
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
          <Field label="Weakest link kept">
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
          <Field label="Contexts per word">
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

            <Field label="Or paste text" hint="Anything you have the right to use — a script, a transcript, your own writing.">
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

                  <Field label="Word type" hint="From the dictionary, or your correction.">
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
                  <Field label="Description">
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
