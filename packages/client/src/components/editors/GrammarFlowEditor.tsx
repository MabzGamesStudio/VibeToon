import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_CORPUS_SOURCES,
  addGrammarDataset,
  describePattern,
  extractGrammar,
  inputsForPort,
  masterGrammar,
  removeGrammarDataset,
  sampleGrammarDataset,
  setGrammarIncluded,
  summariseGrammar,
  type FlowNode,
  type GrammarDataset,
  type GrammarFlowData,
  type Lexicon,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Field } from '../common/Field';
import { InfoTip } from '../common/InfoTip';
import { formatWhen } from '../common/format';
import { EditorShell } from './EditorShell';

type PatternKind = 'sentences' | 'fragments' | 'phrases';

const KIND_LABEL: Record<PatternKind, string> = {
  sentences: 'Sentences',
  fragments: 'Fragments',
  phrases: 'Phrases',
};

export function GrammarFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data as GrammarFlowData;
  const { view: prefs } = useView();
  const [tab, setTab] = useState<'corpora' | 'patterns'>('corpora');
  const [kind, setKind] = useState<PatternKind>('sentences');
  const [busy, setBusy] = useState<string | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [lexicon, setLexicon] = useState<Lexicon | null>(null);
  const [lexiconError, setLexiconError] = useState<string | null>(null);

  const master = useMemo(() => masterGrammar(data), [data]);
  const summary = useMemo(() => summariseGrammar(data, master), [data, master]);

  // The word database wired in is what types the words; without it every token
  // would be a guess, so the editor reads it before counting anything.
  const lexiconInput = inputsForPort(project, node.id, 'lexicon')[0];
  const lexiconPath = lexiconInput?.artifact?.path ?? '';
  const lexiconHash = lexiconInput?.artifact?.hash ?? '';
  useEffect(() => {
    if (!lexiconPath) {
      setLexicon(null);
      setLexiconError(null);
      return undefined;
    }
    // Regenerating upstream changes the hash while a read is still in flight, so
    // a stale answer must not be allowed to land on top of a newer one.
    let cancelled = false;
    setLexiconError(null);
    void api
      .artifactText(project.id, lexiconPath)
      .then((body) => {
        if (cancelled) return;
        setLexicon(JSON.parse(body) as Lexicon);
      })
      .catch((error: Error) => {
        if (!cancelled) setLexiconError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, lexiconPath, lexiconHash]);

  /**
   * Why a corpus cannot be added right now, or null when one can.
   *
   * Reading a corpus happens here in the browser, and it cannot start until the
   * word database it is read against has been generated. Every control that adds
   * a corpus is gated on this one answer, so none of them is a dead end that
   * looks live.
   */
  const blocked = !lexiconInput
    ? 'Wire a Word Database into the Word database input first.'
    : !lexicon
      ? lexiconError
        ? `Could not read the word database: ${lexiconError}`
        : `Press Generate on ${lexiconInput.sourceNode.name} first — it has not written its word database yet.`
      : null;

  const patch = useCallback((next: GrammarFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);

  const addCorpus = useCallback(
    (text: string, name: string, source: GrammarDataset['source']) => {
      if (!lexicon) {
        notify('warn', 'Wire a word database in first — it is what says which word is which.');
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        notify('warn', 'There is no text to read.');
        return;
      }
      const dataset = extractGrammar(trimmed, lexicon, name.trim() || 'Corpus', source, data.options);
      patch(addGrammarDataset(data, dataset));
      notify(
        'success',
        `Read ${dataset.stats.sentences.toLocaleString()} sentence(s) from “${dataset.name}” — ${dataset.sentences.length} shape(s).`,
      );
    },
    [data, lexicon, notify, patch],
  );

  const fetchCorpus = useCallback(async () => {
    if (!url.trim()) return;
    setBusy('Fetching…');
    try {
      const fetched = await api.fetchCorpus(url.trim());
      addCorpus(fetched.text, fetched.name, { kind: 'url', reference: fetched.url });
      setUrl('');
    } catch (error) {
      notify('error', `Could not fetch that: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [addCorpus, notify, url]);

  const patterns = master[kind];

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
            className={`vt-btn is-small${tab === 'patterns' ? ' is-active' : ''}`}
            onClick={() => setTab('patterns')}
          >
            Patterns
          </button>
        </div>
      }
      banner={
        busy ? (
          <div className="vt-sync-banner">
            <span>{busy}</span>
          </div>
        ) : blocked ? (
          <div className="vt-sync-banner">
            <span>
              {blocked} A word database supplies the type and form of every word, which is what turns a
              corpus into sentence shapes.
            </span>
          </div>
        ) : null
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The database</h3>
          <dl className="vt-kv">
            <dt>Sentence shapes</dt>
            <dd>{summary.sentencePatterns.toLocaleString()}</dd>
            <dt>Fragments</dt>
            <dd>{summary.fragmentPatterns.toLocaleString()}</dd>
            <dt>Phrases</dt>
            <dd>{summary.phrasePatterns.toLocaleString()}</dd>
            <dt>Sentences read</dt>
            <dd>{summary.sentencesRead.toLocaleString()}</dd>
            <dt>Words found</dt>
            <dd>
              {Math.round(summary.coverage * 100)}% of {summary.wordsRead.toLocaleString()}
            </dd>
            <dt>Corpora</dt>
            <dd>
              {summary.included} of {summary.datasets} included
            </dd>
          </dl>
          <div className="vt-hint">
            How much of the corpus the word database has an entry for. A word it has never seen is typed by
            guess — and so is a word whose entry was never looked up, since its type is a guess too. Run the
            dictionary on the word database first: a wrong word type is the one thing that makes these shapes
            wrong, and nothing downstream can recover from it.
          </div>
        </div>

        <div className="vt-section">
          <h3>Reading</h3>
          <div className="vt-hint" style={{ marginBottom: 8 }}>
            Applied when a corpus is read. A dataset keeps the patterns it was counted with.
          </div>
          <Field
            label="Longest sentence kept"
            tip="grammar.maxSentenceSlots"
            hint="Sentences longer than this are read but not kept as a shape."
          >
            <input
              type="number"
              min={4}
              value={data.options.maxSentenceSlots}
              onChange={(event) =>
                patch({
                  ...data,
                  options: { ...data.options, maxSentenceSlots: Number(event.target.value) || 4 },
                })
              }
            />
          </Field>
          <Field label="Shortest phrase" tip="grammar.phraseMin">
            <input
              type="number"
              min={2}
              value={data.options.phraseMin}
              onChange={(event) =>
                patch({ ...data, options: { ...data.options, phraseMin: Number(event.target.value) || 2 } })
              }
            />
          </Field>
          <Field label="Longest phrase" tip="grammar.phraseMax">
            <input
              type="number"
              min={2}
              value={data.options.phraseMax}
              onChange={(event) =>
                patch({ ...data, options: { ...data.options, phraseMax: Number(event.target.value) || 2 } })
              }
            />
          </Field>
          <Field label="Patterns kept of each kind" tip="grammar.maxPatterns">
            <input
              type="number"
              min={20}
              step={20}
              value={data.options.maxPatterns}
              onChange={(event) =>
                patch({ ...data, options: { ...data.options, maxPatterns: Number(event.target.value) || 20 } })
              }
            />
          </Field>
          <Field label="A pattern must occur" tip="grammar.minCount" hint="Times a shape has to turn up before it is kept.">
            <input
              type="number"
              min={1}
              value={data.options.minCount}
              onChange={(event) =>
                patch({ ...data, options: { ...data.options, minCount: Number(event.target.value) || 1 } })
              }
            />
          </Field>
          <label className="vt-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={data.options.useForms}
              onChange={(event) =>
                patch({ ...data, options: { ...data.options, useForms: event.target.checked } })
              }
            />
            <span>Include word forms</span>
            <InfoTip tip="grammar.useForms" label="Include word forms" />
          </label>
          <div className="vt-hint">
            On, a slot is `verb·past` rather than `verb`: more precise shapes, but each one is rarer.
          </div>
        </div>
      </aside>

      {tab === 'corpora' ? (
        <div className="vt-editor-main">
          <div className="vt-row" style={{ marginBottom: 10 }}>
            <strong>Corpora</strong>
            <span className="vt-faint">
              Tick to count a corpus into the grammar; untick to take it back out exactly.
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
                      onChange={(event) => patch(setGrammarIncluded(data, dataset.id, event.target.checked))}
                    />
                  </label>
                  <div className="vt-corpus-body">
                    <div className="vt-row" style={{ gap: 6 }}>
                      <strong>{dataset.name}</strong>
                      <span className="vt-pill">{dataset.source.kind}</span>
                      <span className="vt-spacer" />
                      <span className="vt-faint" style={{ fontSize: 11 }}>
                        {formatWhen(dataset.createdAt)}
                      </span>
                    </div>
                    <div className="vt-faint" style={{ fontSize: 11 }}>
                      {dataset.stats.sentences.toLocaleString()} sentences ·{' '}
                      {dataset.sentences.length.toLocaleString()} shapes ·{' '}
                      {dataset.phrases.length.toLocaleString()} phrases ·{' '}
                      {Math.round(
                        (dataset.stats.tagged / Math.max(1, dataset.stats.tagged + dataset.stats.unknown)) * 100,
                      )}
                      % typed
                    </div>
                  </div>
                  <button
                    type="button"
                    className="vt-btn is-ghost is-small is-danger"
                    title="Remove this corpus"
                    onClick={() => {
                      if (!window.confirm(`Remove “${dataset.name}” from this grammar?`)) return;
                      patch(removeGrammarDataset(data, dataset.id));
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
            {blocked ? (
              <div className="vt-blocked">{blocked} Until then a corpus cannot be read here.</div>
            ) : null}
            <Field label="From the web" tip="grammar.corpusUrl" hint="The same addresses the word database reads.">
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
                  disabled={!url.trim() || busy !== null || blocked !== null}
                  title={blocked ?? (url.trim() ? 'Fetch this address and read it for its sentence shapes' : 'Paste an address, or pick one below')}
                  onClick={() => void fetchCorpus()}
                >
                  Fetch and read
                </button>
              </div>
            </Field>
            <div className="vt-corpus-suggestions">
              {DEFAULT_CORPUS_SOURCES.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  className="vt-btn is-small"
                  disabled={blocked !== null}
                  title={blocked ?? `${source.author} — ${source.note}`}
                  onClick={() => setUrl(source.url)}
                >
                  {source.title}
                </button>
              ))}
              <button
                type="button"
                className="vt-btn is-small"
                disabled={blocked !== null}
                title={blocked ?? 'The short sample written for this project'}
                onClick={() => lexicon && patch(addGrammarDataset(data, sampleGrammarDataset(lexicon)))}
              >
                + Workshop sample
              </button>
            </div>

            <Field label="Or paste text" tip="lexicon.pasteText">
              <input
                value={pasteName}
                placeholder="Name for this corpus"
                aria-label="Pasted corpus name"
                onChange={(event) => setPasteName(event.target.value)}
              />
              <textarea
                rows={6}
                value={pasteText}
                placeholder="Paste the text to read…"
                aria-label="Corpus text"
                style={{ marginTop: 6 }}
                onChange={(event) => setPasteText(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="vt-btn"
              disabled={!pasteText.trim() || blocked !== null}
              title={blocked ?? 'Read this text for its sentence shapes'}
              onClick={() => {
                addCorpus(pasteText, pasteName || 'Pasted text', { kind: 'pasted' });
                setPasteText('');
                setPasteName('');
              }}
            >
              Read this text
            </button>
          </div>
        </div>
      ) : (
        <div className="vt-editor-main">
          <div className="vt-row" style={{ marginBottom: 10 }}>
            <div className="vt-tabs">
              {(['sentences', 'fragments', 'phrases'] as PatternKind[]).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`vt-btn is-small${kind === candidate ? ' is-active' : ''}`}
                  onClick={() => setKind(candidate)}
                >
                  {KIND_LABEL[candidate]}
                </button>
              ))}
            </div>
            <span className="vt-faint">
              {patterns.length.toLocaleString()} shape{patterns.length === 1 ? '' : 's'}, commonest first
            </span>
          </div>

          {patterns.length === 0 ? (
            <div className="vt-empty">Nothing counted yet.</div>
          ) : (
            <div className="vt-patterns">
              {patterns.slice(0, prefs.listLimit).map(([signature, count]) => (
                <div className="vt-pattern" key={signature}>
                  <span className="vt-pattern-count">{count}×</span>
                  <code className="vt-pattern-shape">{describePattern(signature)}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </EditorShell>
  );
}
