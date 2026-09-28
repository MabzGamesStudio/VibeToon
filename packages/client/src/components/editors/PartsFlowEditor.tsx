import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_VECTOR_BRUSH,
  adoptBound,
  emptyPartsFlowData,
  inputsForPort,
  moveShapesToPart,
  partById,
  partView,
  partsState,
  readBoundRig,
  setPartImage,
  shapePath,
  summariseParts,
  type FlowNode,
  type PartsFlowData,
  type Project,
  type RigPart,
  type VectorBrush,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { EditorShell } from './EditorShell';
import { useVectorWorkbench } from './vector/useVectorWorkbench';

/** A part drawn small, framed on itself, for the list. */
function Thumbnail({ part }: { part: RigPart }): JSX.Element {
  const box = partView(part, 0.08);
  if (!box) return <span className="vt-part-thumb is-empty" />;
  return (
    <svg className="vt-part-thumb" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {part.image.shapes.map((shape) =>
        shape.kind === 'polygon' ? (
          <path key={shape.id} d={shapePath(shape)} fill={shape.color} fillRule="evenodd" />
        ) : (
          <path key={shape.id} d={shapePath(shape)} fill="none" stroke={shape.color} strokeWidth={shape.width} strokeLinecap="round" />
        ),
      )}
    </svg>
  );
}

/**
 * A bound drawing, taken apart into its body parts.
 *
 * Every shape goes to the part that carries most of its points. Pick a part to
 * see it alone (or over the rest, faded) and edit it with every tool of the
 * Vector Editor; a shape in the wrong part can be sent to the right one.
 */
export function PartsFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'parts' ? (node.data as PartsFlowData) : emptyPartsFlowData();
  const patch = useCallback((over: Partial<PartsFlowData> | PartsFlowData) => setFlowData(node.id, { ...data, ...over }), [data, node.id, setFlowData]);

  const input = inputsForPort(project, node.id, 'bound')[0];
  const artifact = input?.artifact;
  const state = partsState(data, artifact?.hash);
  const [fitPart, setFitPart] = useState(true);

  const takeIn = useCallback(async () => {
    if (!artifact) return;
    try {
      const bound = readBoundRig(await (await fetch(api.artifactUrl(project.id, artifact.path))).json());
      if (!bound) {
        notify('error', 'That file is not a bound rig this editor can read.');
        return;
      }
      const next = adoptBound(data, bound, artifact.hash);
      patch(next);
      notify('success', `Split into ${next.parts.length} part(s).`);
    } catch (error) {
      notify('error', `Could not read that: ${(error as Error).message}`);
    }
  }, [artifact, data, notify, patch, project.id]);

  const part = partById(data, data.current) ?? data.parts[0];
  const empty = { width: data.bound?.image.width ?? 100, height: data.bound?.image.height ?? 100, shapes: [] };
  const image = part?.image ?? empty;
  const backdrop = useMemo(
    () => (data.showOthers && part ? data.parts.filter((other) => other.id !== part.id).flatMap((other) => other.image.shapes) : []),
    [data.parts, data.showOthers, part],
  );
  const view = fitPart && part ? (partView(part) ?? undefined) : undefined;

  const blocked = !input
    ? 'Wire a Rig Binding flow into the Bound rig input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not written a bound rig yet.`
      : null;

  const bench = useVectorWorkbench({
    image,
    selected: data.selected,
    brush: { ...DEFAULT_VECTOR_BRUSH, ...(data.brush ?? {}) },
    onEdit: (next, selected) => part && patch({ ...setPartImage(data, part.id, next), selected, edits: data.edits + 1 }),
    onLive: (next) => part && patch(setPartImage(data, part.id, next)),
    onSettle: () => patch({ edits: data.edits + 1 }),
    onSelect: (selected) => patch({ selected }),
    onBrush: (brush: VectorBrush) => patch({ brush }),
    backdrop,
    ...(view ? { view } : {}),
    title: part ? part.name : 'The parts',
    empty: blocked ?? (data.bound ? 'This part has no shapes. Draw one with Draw shape.' : 'Nothing taken in yet.'),
    stageTools: (
      <label className="vt-row" style={{ gap: 6, fontSize: 11 }}>
        <input type="checkbox" checked={fitPart} onChange={(event) => setFitPart(event.target.checked)} />
        Frame this part
      </label>
    ),
  });

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={async () => {
        await generateFlow(node.id);
      }}
      banner={
        blocked ? (
          <div className="vt-sync-banner">
            <span>{blocked}</span>
          </div>
        ) : state === 'none' ? (
          <div className="vt-sync-banner">
            <span>Nothing taken in yet.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take it in
            </button>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>The binding has changed since these parts were made. Taking it in again splits it afresh and replaces {data.edits} edit(s).</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take in the new one
            </button>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Parts ({data.parts.length})</h3>
          <div className="vt-part-list">
            {data.parts.map((one) => (
              <button
                key={one.id}
                type="button"
                className={`vt-part-item${part?.id === one.id ? ' is-selected' : ''}`}
                onClick={() => patch({ current: one.id, selected: [] })}
              >
                <Thumbnail part={one} />
                <span className="vt-part-name">{one.name}</span>
                <span className="vt-faint">{one.image.shapes.length}</span>
              </button>
            ))}
          </div>
          <label className="vt-row" style={{ gap: 6, marginTop: 6 }}>
            <input type="checkbox" checked={data.showOthers} onChange={(event) => patch({ showOthers: event.target.checked })} />
            Show the other parts, faded
          </label>
        </div>

        {bench.toolPanel}
        {bench.selectionPanel}

        {part && data.selected.length > 0 ? (
          <div className="vt-section">
            <h3>Belongs to</h3>
            <select
              value={part.id}
              aria-label="Move the selected shapes to another part"
              onChange={(event) => {
                const to = event.target.value;
                patch(moveShapesToPart(data, data.selected, part.id, to));
                notify('success', `Moved ${data.selected.length} shape(s) to ${data.parts.find((one) => one.id === to)?.name ?? data.bound?.rig.bones.find((bone) => bone.id === to)?.name ?? to}.`);
              }}
            >
              {[...data.parts.map((one) => ({ id: one.id, name: one.name })), ...(data.bound?.rig.bones ?? []).filter((bone) => !data.parts.some((one) => one.id === bone.id)).map((bone) => ({ id: bone.id, name: `${bone.name} (empty)` }))].map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
            <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
              Sends the selected shape(s) to another part, keeping their place in the drawing’s order.
            </p>
          </div>
        ) : null}

        <div className="vt-section">
          <h3>The binding</h3>
          <button type="button" className="vt-btn is-small" disabled={!artifact} onClick={() => void takeIn()}>
            Split it again
          </button>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            Every shape goes to the bone carrying most of its points. Splitting again replaces {data.edits} edit(s).
          </p>
        </div>
      </aside>

      <div className="vt-editor-main">
        {bench.stage}
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseParts(data)} · {data.edits} edit(s)
        </p>
      </div>
    </EditorShell>
  );
}
