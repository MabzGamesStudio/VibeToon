import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_CORPUS_SOURCES,
  addCorpusPart,
  includedParts,
  localPartText,
  moveCorpusPart,
  newId,
  removeCorpusPart,
  samplePart,
  setCorpusIncluded,
  summariseCorpus,
  type CorpusFlowData,
  type CorpusPart,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { formatWhen } from '../common/format';
import { EditorShell } from './EditorShell';

const KIND_LABEL: Record<CorpusPart['kind'], string> = {
  builtin: 'built in',
  pasted: 'pasted',
  url: 'fetched each run',
};

function bytesLabel(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} kB`;
  return `${(count / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * The corpus flow: the text itself, in one place.
 *
 * A part that is an address is stored as an address and fetched on every run, so
 * a novel never has to live in the project file. A part you pasted is stored as
 * it is, because nothing else has it.
 */
export function CorpusFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data as CorpusFlowData;
  const [url, setUrl] = useState('');
  const [urlName, setUrlName] = useState('');
  const [pasteName, setPasteName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [checking, setChecking] = useState(false);

  const patch = useCallback((next: CorpusFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);
  const summary = useMemo(() => summariseCorpus(data), [data]);
  const order = useMemo(() => includedParts(data), [data]);

  const addUrl = useCallback(() => {
    const address = url.trim();
    if (!address) return;
    let name = urlName.trim();
    if (!name) {
      const known = DEFAULT_CORPUS_SOURCES.find((source) => source.url === address);
      name = known?.title ?? address.split('/').pop()?.replace(/\.[a-z]+$/i, '') ?? 'Corpus';
    }
    patch(
      addCorpusPart(data, {
        id: newId('part'),
        name,
        kind: 'url',
        url: address,
        addedAt: new Date().toISOString(),
      }),
    );
    setUrl('');
    setUrlName('');
    notify('info', `Added “${name}”. It is fetched when the flow runs.`);
  }, [data, notify, patch, url, urlName]);

  /** Fetch once now, so a bad address is found before a run depends on it. */
  const check = useCallback(
    async (part: CorpusPart) => {
      if (!part.url) return;
      setChecking(true);
      try {
        const fetched = await api.fetchCorpus(part.url);
        patch({
          ...data,
          parts: data.parts.map((candidate) =>
            candidate.id === part.id
              ? {
                  ...candidate,
                  lastBytes: fetched.text.length,
                  lastReadAt: new Date().toISOString(),
                  lastError: undefined,
                }
              : candidate,
          ),
        });
        notify('success', `${part.name}: ${bytesLabel(fetched.text.length)} of text.`);
      } catch (error) {
        const message = (error as Error).message;
        patch({
          ...data,
          parts: data.parts.map((candidate) =>
            candidate.id === part.id ? { ...candidate, lastError: message } : candidate,
          ),
        });
        notify('error', `${part.name}: ${message}`);
      } finally {
        setChecking(false);
      }
    },
    [data, notify, patch],
  );

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      banner={checking ? <div className="vt-sync-banner"><span>Fetching…</span></div> : undefined}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The corpus</h3>
          <dl className="vt-kv">
            <dt>Parts</dt>
            <dd>
              {summary.included} of {summary.parts} included
            </dd>
            <dt>Size</dt>
            <dd>
              {bytesLabel(summary.bytes)}
              {summary.unknown > 0 ? ` + ${summary.unknown} not yet read` : ''}
            </dd>
            {summary.errors > 0 ? (
              <>
                <dt>Problems</dt>
                <dd>{summary.errors} could not be read</dd>
              </>
            ) : null}
          </dl>
          <div className="vt-hint">
            Wire the Corpus output into a Word Database and a Grammar Database and both read exactly the same
            words — which is what makes their word types line up.
          </div>
        </div>

        <div className="vt-section">
          <h3>Joining</h3>
          <Field
            label="Between parts"
            tip="corpus.separator"
            hint="Written between one part and the next, so the end of one does not read as the start of the next."
          >
            <select
              value={data.separator}
              aria-label="Between parts"
              onChange={(event) => patch({ ...data, separator: event.target.value })}
            >
              <option value={'\n\n'}>A blank line</option>
              <option value={'\n'}>A line break</option>
              <option value={'\n\n* * *\n\n'}>A break mark</option>
              <option value={' '}>A space</option>
            </select>
          </Field>
          <div className="vt-hint">
            A blank line is the safe choice: the counting treats it as a break, so no pair is learned across the
            join between two books.
          </div>
        </div>
      </aside>

      <div className="vt-editor-main">
        <div className="vt-row" style={{ marginBottom: 10 }}>
          <strong>Parts</strong>
          <span className="vt-faint">
            Written in this order. Untick one to leave it out without losing it.
          </span>
        </div>

        <div className="vt-corpus-list">
          {data.parts.map((part) => {
            const included = data.included.includes(part.id);
            const position = order.findIndex((candidate) => candidate.id === part.id);
            const local = localPartText(part);
            const size = local !== null ? local.length : part.lastBytes;
            return (
              <div key={part.id} className={`vt-corpus-row${included ? ' is-on' : ''}`}>
                <label className="vt-corpus-tick">
                  <input
                    type="checkbox"
                    checked={included}
                    aria-label={`Include ${part.name}`}
                    onChange={(event) => patch(setCorpusIncluded(data, part.id, event.target.checked))}
                  />
                </label>
                <div className="vt-corpus-body">
                  <div className="vt-row" style={{ gap: 6 }}>
                    <strong>{part.name}</strong>
                    <span className="vt-pill">{KIND_LABEL[part.kind]}</span>
                    <span className="vt-spacer" />
                    <span className="vt-faint" style={{ fontSize: 11 }}>
                      {part.lastReadAt ? formatWhen(part.lastReadAt) : formatWhen(part.addedAt)}
                    </span>
                  </div>
                  <div className="vt-faint" style={{ fontSize: 11 }}>
                    {size !== undefined ? bytesLabel(size) : 'size unknown until it is read'}
                    {part.url ? ` · ${part.url}` : ''}
                  </div>
                  {part.lastError ? <div className="vt-pill is-error">{part.lastError}</div> : null}
                </div>
                {included && position >= 0 ? (
                  <>
                    <button
                      type="button"
                      className="vt-btn is-ghost is-small"
                      disabled={position === 0}
                      title="Write this part earlier"
                      onClick={() => patch(moveCorpusPart(data, part.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="vt-btn is-ghost is-small"
                      disabled={position === order.length - 1}
                      title="Write this part later"
                      onClick={() => patch(moveCorpusPart(data, part.id, 1))}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
                {part.kind === 'url' ? (
                  <button
                    type="button"
                    className="vt-btn is-ghost is-small"
                    disabled={checking}
                    title="Fetch it once now, to check the address works"
                    onClick={() => void check(part)}
                  >
                    Check
                  </button>
                ) : null}
                <button
                  type="button"
                  className="vt-btn is-ghost is-small is-danger"
                  title="Remove this part"
                  onClick={() => {
                    if (!window.confirm(`Remove “${part.name}” from this corpus?`)) return;
                    patch(removeCorpusPart(data, part.id));
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          {data.parts.length === 0 ? <div className="vt-empty">No parts yet.</div> : null}
        </div>

        <div className="vt-section">
          <h3>Add a part</h3>
          <Field
            label="From the web"
            tip="corpus.url"
            hint="Any plain-text address. It is stored as an address and fetched on every run, so a book never goes into the project file."
          >
            <input
              value={urlName}
              placeholder="Name for this part (optional)"
              aria-label="Part name"
              onChange={(event) => setUrlName(event.target.value)}
            />
            <div className="vt-row" style={{ marginTop: 6 }}>
              <input
                value={url}
                placeholder="https://…"
                aria-label="Corpus URL"
                onChange={(event) => setUrl(event.target.value)}
              />
              <button type="button" className="vt-btn" disabled={!url.trim()} onClick={addUrl}>
                Add
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
                onClick={() => {
                  setUrl(source.url);
                  setUrlName(source.title);
                }}
              >
                {source.title}
              </button>
            ))}
            <button
              type="button"
              className="vt-btn is-small"
              title="The short sample written for this project"
              onClick={() => patch(addCorpusPart(data, samplePart()))}
            >
              + Workshop sample
            </button>
          </div>

          <Field
            label="Or paste text"
            tip="corpus.paste"
            hint="Anything you have the right to use — a script, a transcript, your own writing. Pasted text is kept in the project."
          >
            <input
              value={pasteName}
              placeholder="Name for this part"
              aria-label="Pasted part name"
              onChange={(event) => setPasteName(event.target.value)}
            />
            <textarea
              rows={6}
              value={pasteText}
              placeholder="Paste the text…"
              aria-label="Part text"
              style={{ marginTop: 6 }}
              onChange={(event) => setPasteText(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="vt-btn"
            disabled={!pasteText.trim()}
            onClick={() => {
              patch(
                addCorpusPart(data, {
                  id: newId('part'),
                  name: pasteName.trim() || 'Pasted text',
                  kind: 'pasted',
                  text: pasteText,
                  addedAt: new Date().toISOString(),
                  lastBytes: pasteText.length,
                }),
              );
              setPasteText('');
              setPasteName('');
            }}
          >
            Add this text
          </button>
          <div className="vt-hint" style={{ marginTop: 8 }}>
            Text wired into this flow’s Text input is added as a part too, read fresh on every run.
          </div>
        </div>
      </div>
    </EditorShell>
  );
}
