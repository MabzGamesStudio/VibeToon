import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_DICTIONARY_OPTIONS,
  applyMeaningsToLexicon,
  inputsForPort,
  lookupProgress,
  summariseDictionary,
  wordsToLookUp,
  type DictionaryFlowData,
  type DictionaryProviders,
  type FlowNode,
  type Lexicon,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Field } from '../common/Field';
import { EditorShell } from './EditorShell';

/** Words per request: a batch comes back in seconds and is saved before the next. */
const BATCH_SIZE = 100;

/**
 * A word database in, a better one out.
 *
 * Counting a corpus knows how often a word appears and what follows it, but not
 * what kind of word it is — and word type is what decides whether the grammar
 * flow produces English or soup. Asking a dictionary is slow, rate-limited and
 * occasionally refused, so it gets a flow of its own instead of being buried in
 * the counting.
 */
export function DictionaryFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data as DictionaryFlowData;
  const { view: prefs } = useView();
  const [lexicon, setLexicon] = useState<Lexicon | null>(null);
  const [lexiconError, setLexiconError] = useState<string | null>(null);
  const [providers, setProviders] = useState<DictionaryProviders | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const stopRef = useRef(false);

  const patch = useCallback((next: DictionaryFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);
  const options = { ...DEFAULT_DICTIONARY_OPTIONS, ...data.options };

  const lexiconInput = inputsForPort(project, node.id, 'lexicon')[0];
  const lexiconPath = lexiconInput?.artifact?.path ?? '';
  const lexiconHash = lexiconInput?.artifact?.hash ?? '';

  useEffect(() => {
    if (!lexiconPath) {
      setLexicon(null);
      setLexiconError(null);
      return undefined;
    }
    let cancelled = false;
    setLexiconError(null);
    void api
      .artifactText(project.id, lexiconPath)
      .then((body) => !cancelled && setLexicon(JSON.parse(body) as Lexicon))
      .catch((error: Error) => !cancelled && setLexiconError(error.message));
    return () => {
      cancelled = true;
    };
  }, [project.id, lexiconPath, lexiconHash]);

  useEffect(() => {
    let cancelled = false;
    void api
      .dictionaryProviders()
      .then((found) => !cancelled && setProviders(found))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const blocked = !lexiconInput
    ? 'Wire a Word Database into the Word database input first.'
    : !lexicon
      ? lexiconError
        ? `Could not read the word database: ${lexiconError}`
        : `Press Generate on ${lexiconInput.sourceNode.name} first — it has not written its word database yet.`
      : null;

  const pending = useMemo(() => (lexicon ? wordsToLookUp(lexicon, data) : []), [data, lexicon]);
  const summary = useMemo(() => summariseDictionary(data), [data]);
  const applied = useMemo(
    () => (lexicon ? applyMeaningsToLexicon(lexicon, data) : null),
    [data, lexicon],
  );

  /** The service this flow asks: its own choice, or whatever the studio is set to. */
  const flowProvider = providers
    ? providers.providers.find((provider) => provider.id === (data.providerId || providers.activeId))
    : undefined;

  const setKey = useCallback(
    async (id: string, key: string) => {
      try {
        setProviders(await api.setDictionaryKey(id, key));
        setKeyDraft('');
        notify('success', key.trim() ? 'Key saved on the server.' : 'Key cleared.');
      } catch (error) {
        notify('error', `Could not save the key: ${(error as Error).message}`);
      }
    },
    [notify],
  );

  /** Look the outstanding words up a batch at a time, saving as each lands. */
  const lookUp = useCallback(async () => {
    if (pending.length === 0) return;
    stopRef.current = false;
    const total = pending.length;
    let queue = [...pending];
    let meanings = { ...data.meanings };
    const tally = { found: 0, missing: 0, failed: 0, cached: 0, rateLimited: 0 };

    setProgress({ done: 0, total });
    try {
      while (queue.length > 0) {
        if (stopRef.current) {
          notify('warn', `Stopped after ${tally.found + tally.missing} of ${total}. What was found is kept.`);
          return;
        }

        const batch = queue.slice(0, BATCH_SIZE);
        const result = await api.lookupWords(batch, BATCH_SIZE, data.providerId || undefined);
        meanings = { ...meanings, ...result.meanings };
        patch({ ...data, meanings });

        tally.found += result.found.length;
        tally.missing += result.missing.length;
        tally.failed += result.failed.length;
        tally.cached += result.cached;
        tally.rateLimited += result.rateLimited;

        const settled = new Set([...result.found, ...result.missing, ...result.failed]);
        const left = batch.filter((word) => !settled.has(word) && !(word in result.meanings));
        queue = [...new Set([...result.remaining.filter((word) => batch.includes(word)), ...left, ...queue.slice(batch.length)])];
        setProgress({ done: total - queue.length, total });

        if (result.unreachable) {
          notify(
            'error',
            `${result.unreachable} ${tally.found + tally.missing} of ${total} were answered. Open Logs to see what the service said, then try again to carry on.`,
          );
          return;
        }
        if (result.rateLimited > 0 && result.retryAfterMs) {
          notify('warn', `Asked to wait ${Math.ceil(result.retryAfterMs / 1000)}s — slowing down.`);
          await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
        }
      }

      notify(
        'success',
        `Answered ${tally.found.toLocaleString()} word(s)${tally.cached > 0 ? ` (${tally.cached.toLocaleString()} cached)` : ''}${
          tally.missing > 0 ? `, ${tally.missing.toLocaleString()} not in the dictionary` : ''
        }${tally.failed > 0 ? `, ${tally.failed.toLocaleString()} could not be looked up` : ''}. Generate to apply them.`,
      );
    } catch (error) {
      notify('error', `Lookup stopped: ${(error as Error).message}`);
    } finally {
      setProgress(null);
      stopRef.current = false;
    }
  }, [data, notify, patch, pending]);

  const rows = useMemo(() => {
    if (!applied) return [];
    const needle = query.trim().toLowerCase();
    return applied.lexicon.lexemes
      .filter((lexeme) => !needle || lexeme.spelling.includes(needle))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, prefs.listLimit);
  }, [applied, prefs.listLimit, query]);

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      banner={
        progress ? (
          <div className="vt-sync-banner">
            <span>
              Looking up {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
            </span>
          </div>
        ) : blocked ? (
          <div className="vt-sync-banner">
            <span>{blocked} This flow improves a database it is given; it does not build one.</span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>What is known</h3>
          <dl className="vt-kv">
            <dt>Words in</dt>
            <dd>{lexicon ? lexicon.lexemes.length.toLocaleString() : '—'}</dd>
            <dt>Answers held</dt>
            <dd>
              {summary.known.toLocaleString()}
              {summary.guessed > 0 ? ` (${summary.guessed.toLocaleString()} guessed)` : ''}
            </dd>
            <dt>Never asked</dt>
            <dd>{pending.length.toLocaleString()}</dd>
            {applied ? (
              <>
                <dt>Would change</dt>
                <dd>
                  {applied.retyped.toLocaleString()} type(s), {applied.described.toLocaleString()} description(s)
                </dd>
              </>
            ) : null}
          </dl>

          <div className="vt-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={blocked !== null || pending.length === 0 || progress !== null}
              title={blocked ?? undefined}
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
            <div
              className="vt-progress"
              role="progressbar"
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
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
            Asking happens here, where it can be watched and stopped. Generating applies what has been learned,
            so a run is instant and a lookup stopped half way is still worth generating.
          </div>
        </div>

        <div className="vt-section">
          <h3>Service</h3>
          <Field
            label="Dictionary"
            tip="lexicon.provider"
            hint={
              providers?.pinnedByEnvironment
                ? 'VIBETOON_DICTIONARY_URL is set, so the address is fixed.'
                : data.providerId
                  ? 'Set on this flow, whatever the studio is set to.'
                  : `Following the studio — ${providers?.reason ?? 'reading…'}.`
            }
          >
            <select
              value={data.providerId}
              aria-label="Dictionary"
              disabled={!providers || providers.pinnedByEnvironment}
              onChange={(event) => patch({ ...data, providerId: event.target.value })}
            >
              <option value="">Follow the studio{providers ? ` (${providers.activeId})` : ''}</option>
              {(providers?.providers ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                  {provider.needsKey && !provider.hasKey ? ' — needs a key' : ''}
                </option>
              ))}
            </select>
          </Field>
          {flowProvider ? <div className="vt-hint">{flowProvider.note}</div> : null}

          {flowProvider?.needsKey ? (
            <Field
              label="API token"
              tip="dictionary.key"
              hint={
                flowProvider.hasKey
                  ? 'A key is stored for this service. It is never shown again.'
                  : 'Kept on the server, outside every project, and never sent back to this page.'
              }
            >
              <div className="vt-row">
                <input
                  type="password"
                  value={keyDraft}
                  placeholder={flowProvider.hasKey ? '•••••••• stored' : 'paste the key'}
                  aria-label="API token"
                  autoComplete="off"
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="vt-btn"
                  disabled={!keyDraft.trim()}
                  onClick={() => void setKey(flowProvider.id, keyDraft)}
                >
                  Save
                </button>
                {flowProvider.hasKey ? (
                  <button
                    type="button"
                    className="vt-btn is-ghost is-small is-danger"
                    onClick={() => void setKey(flowProvider.id, '')}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </Field>
          ) : null}
          {flowProvider?.needsKey && flowProvider.keyUrl && !flowProvider.hasKey ? (
            <div className="vt-hint">
              <a href={flowProvider.keyUrl} target="_blank" rel="noreferrer">
                Register for a key
              </a>
              . It is written to <code>data/settings.json</code>, which is outside every project and
              gitignored, so it never travels with a project you copy or commit.
            </div>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>What to ask about</h3>
          <Field
            label="Skip words rarer than"
            tip="dictionary.minFrequency"
            hint="0 asks about everything. A long tail of one-off words can double the run for little gain."
          >
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={options.minFrequency}
              onChange={(event) =>
                patch({ ...data, options: { ...options, minFrequency: Number(event.target.value) || 0 } })
              }
            />
          </Field>
          <label className="vt-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={options.refresh}
              onChange={(event) => patch({ ...data, options: { ...options, refresh: event.target.checked } })}
            />
            <span>Ask again about words already answered</span>
          </label>
          <label className="vt-row" style={{ gap: 6, marginTop: 4 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={options.overwriteTypes}
              onChange={(event) =>
                patch({ ...data, options: { ...options, overwriteTypes: event.target.checked } })
              }
            />
            <span>Replace the type the database had</span>
          </label>
          <label className="vt-row" style={{ gap: 6, marginTop: 4 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={options.overwriteDescriptions}
              onChange={(event) =>
                patch({ ...data, options: { ...options, overwriteDescriptions: event.target.checked } })
              }
            />
            <span>Replace the description the database had</span>
          </label>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Field label="Search words" hint="What the database will look like once this flow generates.">
          <input
            value={query}
            placeholder="Filter by spelling…"
            aria-label="Search words"
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>

        <div className="vt-log" style={{ marginTop: 10 }}>
          {rows.length === 0 ? (
            <div className="vt-empty">
              {blocked ?? 'No words match.'}
            </div>
          ) : (
            rows.map((lexeme) => {
              const meaning = data.meanings[lexeme.spelling];
              const source = meaning?.source ?? 'none';
              return (
                <div key={lexeme.id} className="vt-log-row" style={{ gridTemplateColumns: '130px 90px 90px minmax(0, 1fr)' }}>
                  <span className="vt-log-subject">{lexeme.spelling}</span>
                  <span className="vt-log-service">{lexeme.type}</span>
                  <span className={`vt-pill ${source === 'dictionary' ? 'is-ready' : source === 'none' ? 'is-error' : 'is-empty'}`}>
                    {source === 'none' ? 'not asked' : source}
                  </span>
                  <span className="vt-log-subject" title={lexeme.description}>
                    {lexeme.description || '—'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </EditorShell>
  );
}
