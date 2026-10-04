import { useCallback, useMemo, useRef } from 'react';
import {
  emptyBatchSelectFlowData,
  invertSelected,
  isSelected,
  itemMatchesFilter,
  selectSources,
  setSelected,
  splitSelection,
  summariseSelection,
  type BatchSelectFlowData,
  type FlowNode,
  type Project,
  type SelectableItem,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { EditorShell } from './EditorShell';

/** A small look at an item: the picture, the clip's first moments, or its name. */
function ItemPreview({ project, item }: { project: Project; item: SelectableItem }): JSX.Element {
  if (!item.artifact) return <span className="vt-select-none">not made yet</span>;
  const url = api.artifactUrl(project.id, item.artifact.path);
  if (item.kind === 'image') return <img src={url} alt="" loading="lazy" draggable={false} />;
  if (item.kind === 'video') return <video src={`${url}#t=0.1`} muted playsInline preload="metadata" />;
  return <span className="vt-select-none">{item.kind ?? 'file'}</span>;
}

/**
 * Batch Select: every item of every batch wired in, to tick or untick. What
 * is ticked goes out on Selected as one folder, and on as one batch; the rest
 * on The rest.
 */
export function BatchSelectFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData } = useStudio();
  const data = node.data.editor === 'batchSelect' ? (node.data as BatchSelectFlowData) : emptyBatchSelectFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((next: BatchSelectFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);

  const sources = useMemo(() => selectSources(project, node), [project, node]);
  const split = useMemo(() => splitSelection(project, node, data), [project, node, data]);
  const shown = (items: SelectableItem[]) => items.filter((item) => itemMatchesFilter(item, data.filter));
  const allShown = sources.flatMap((source) => shown(source.items)).map((item) => item.key);
  const total = sources.reduce((sum, source) => sum + source.items.length, 0);
  const ticked = sources.reduce((sum, source) => sum + source.items.filter((item) => isSelected(data, item.key)).length, 0);

  const toggle = (item: SelectableItem) => patch(setSelected(dataRef.current, [item.key], !isSelected(dataRef.current, item.key)));

  return (
    <EditorShell project={project} node={node}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Choose</h3>
          <p className="vt-hint">Wire in as many folders or batches as you like. Every item is listed; click one to tick or untick it. The ticked ones go out on Selected as one batch, the rest on The rest. An item that arrives later is ticked.</p>
          <p className="vt-faint" style={{ fontSize: 12 }}>
            {ticked} of {total} ticked
          </p>
          <label className="vt-field">
            <span className="vt-label">Show only names with</span>
            <input value={data.filter} placeholder="shot-0, background…" onChange={(event) => patch({ ...dataRef.current, filter: event.target.value })} />
          </label>
          <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            <button type="button" className="vt-btn is-small" disabled={allShown.length === 0} onClick={() => patch(setSelected(dataRef.current, allShown, true))}>
              Tick {data.filter ? 'shown' : 'all'}
            </button>
            <button type="button" className="vt-btn is-small" disabled={allShown.length === 0} onClick={() => patch(setSelected(dataRef.current, allShown, false))}>
              Untick {data.filter ? 'shown' : 'all'}
            </button>
            <button type="button" className="vt-btn is-small" disabled={allShown.length === 0} onClick={() => patch(invertSelected(dataRef.current, allShown))}>
              Invert
            </button>
          </div>
        </div>
        <div className="vt-section">
          <h3>Goes out</h3>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>{summariseSelection(split)}</p>
          {split.waiting.length > 0 ? <p className="vt-hint">Items not made yet upstream are left out until they are: generate the flow they come from.</p> : null}
          {split.otherKind.length > 0 ? <p className="vt-hint">A folder holds one kind of file, so the {split.otherKind.length} item(s) that are not {split.kind}s are set aside.</p> : null}
        </div>
      </aside>
      <div className="vt-editor-main vt-select-main">
        {sources.length === 0 ? (
          <div className="vt-empty">Wire folders or batches into Items — a Shot Split’s clips, the backgrounds a Video Background made of each shot — to choose from them.</div>
        ) : (
          sources.map((source) => {
            const items = shown(source.items);
            const keys = items.map((item) => item.key);
            const on = source.items.filter((item) => isSelected(data, item.key)).length;
            return (
              <section key={source.connection.id} className="vt-select-source">
                <header className="vt-row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <h4>{source.source.name}</h4>
                  <span className="vt-faint">
                    {source.connection.from.portId} · {on} of {source.items.length} ticked
                  </span>
                  <span className="vt-spacer" />
                  <button type="button" className="vt-btn is-ghost is-small" disabled={keys.length === 0} onClick={() => patch(setSelected(dataRef.current, keys, true))}>
                    All
                  </button>
                  <button type="button" className="vt-btn is-ghost is-small" disabled={keys.length === 0} onClick={() => patch(setSelected(dataRef.current, keys, false))}>
                    None
                  </button>
                </header>
                {items.length === 0 ? (
                  <p className="vt-faint">{source.items.length === 0 ? 'Nothing in it yet.' : 'No name here has that in it.'}</p>
                ) : (
                  <div className="vt-select-grid" role="group" aria-label={`Items from ${source.source.name}`}>
                    {items.map((item) => {
                      const selected = isSelected(data, item.key);
                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={`vt-select-item${selected ? ' is-on' : ''}${item.artifact ? '' : ' is-waiting'}`}
                          aria-pressed={selected}
                          title={`${item.fileName}${item.artifact ? '' : ' — not made yet'}`}
                          onClick={() => toggle(item)}
                        >
                          <span className="vt-select-preview">
                            <ItemPreview project={project} item={item} />
                          </span>
                          <span className="vt-select-label">
                            <input type="checkbox" tabIndex={-1} readOnly checked={selected} aria-hidden="true" /> {item.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </EditorShell>
  );
}
