import { useCallback, useMemo } from 'react';
import {
  adopt,
  brushOf,
  editState,
  emptyVectorEditFlowData,
  imageOf,
  inputsForPort,
  readVectorImage,
  summariseVector,
  type FlowNode,
  type Project,
  type VectorEditFlowData,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { EditorShell } from './EditorShell';
import { useVectorWorkbench } from './vector/useVectorWorkbench';

/**
 * Editing a vectorized image.
 *
 * A decomposition is a starting guess: it gets the shapes roughly right and puts
 * points where the pixels changed rather than where the drawing turns. This is
 * where that is fixed — move a point, add one, delete one, cut a shape in two,
 * take a run out of a line, curve a node, or draw a shape of your own. The
 * tools are the workbench's (`vector/useVectorWorkbench.tsx`), shared with the
 * other editors that hold shapes.
 *
 * The edits live in this flow rather than being recomputed from upstream, which
 * is the whole point of it. An upstream change is reported and the edits are kept
 * until you say otherwise: losing an afternoon's work to someone re-running the
 * decomposition would make the flow not worth using.
 */
export function VectorEditFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'vectorEdit' ? (node.data as VectorEditFlowData) : emptyVectorEditFlowData();

  const input = inputsForPort(project, node.id, 'vector')[0];
  const artifact = input?.artifact;

  const image = imageOf(data);
  const state = editState(data, artifact?.hash);
  const summary = useMemo(() => summariseVector(image), [image]);

  const patch = useCallback(
    (over: Partial<VectorEditFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  const takeIn = useCallback(async () => {
    if (!artifact) return;
    try {
      const response = await fetch(api.artifactUrl(project.id, artifact.path));
      if (!response.ok) throw new Error(`the file could not be read (${response.status})`);
      const read = readVectorImage(await response.json());
      if (read.shapes.length === 0) {
        notify('error', 'That file has no shapes in it that this editor can read.');
        return;
      }
      patch(adopt(data, read, artifact.hash));
      notify('success', `Took in ${read.shapes.length} shape(s).`);
    } catch (error) {
      notify('error', `Could not read that: ${(error as Error).message}`);
    }
  }, [artifact, data, notify, patch, project.id]);

  const blocked = !input
    ? 'Wire a Polygon Decomposition flow into the Vector input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not produced a vector yet.`
      : null;

  const bench = useVectorWorkbench({
    image,
    selected: data.selected,
    brush: brushOf(data),
    onEdit: (next, selected) => patch({ image: next, selected, edits: data.edits + 1 }),
    onLive: (next) => patch({ image: next }),
    onSettle: () => patch({ edits: data.edits + 1 }),
    onSelect: (selected) => patch({ selected }),
    onBrush: (brush) => patch({ brush }),
    title: 'The drawing',
    empty: blocked ?? 'Nothing taken in yet.',
    stageTools: (
      <span className="vt-faint" style={{ fontSize: 11 }}>
        {image.shapes.length > 0 ? `${image.width} × ${image.height} · ${summary.shapes} shapes` : 'nothing yet'}
      </span>
    ),
  });
  const one = data.selected.length === 1 ? image.shapes.find((shape) => shape.id === data.selected[0]) : undefined;

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
            <span>Nothing taken in yet. Press “Take it in” to start editing.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take it in
            </button>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>
              {input!.sourceNode.name} has changed since these {data.edits} edit(s) were made. Taking it in
              again replaces them.
            </span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take in the new one
            </button>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        {bench.toolPanel}

        <div className="vt-section">
          <h3>What is here</h3>
          <dl className="vt-kv">
            <dt>Shapes</dt>
            <dd>{summary.shapes}</dd>
            <dt>Polygons</dt>
            <dd>{summary.polygons}</dd>
            <dt>Lines</dt>
            <dd>{summary.lines}</dd>
            <dt>Points</dt>
            <dd>{summary.points.toLocaleString()}</dd>
            <dt>Edits</dt>
            <dd>{data.edits}</dd>
          </dl>
          {summary.concave > 0 ? (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.4 }}>
              {summary.concave} polygon(s) are no longer convex. That is allowed, but anything
              downstream relying on convexity should know.
            </p>
          ) : null}
        </div>

        {bench.selectionPanel}

        <div className="vt-section">
          <h3>The original</h3>
          <button type="button" className="vt-btn is-small" disabled={!artifact} onClick={() => void takeIn()}>
            Take it in again
          </button>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            Replaces everything here with what is wired in, including {data.edits} edit(s).
          </p>
        </div>
      </aside>

      <div className="vt-editor-main">
        {bench.stage}
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summary.shapes} shape(s), {summary.points.toLocaleString()} point(s) · {data.edits} edit(s)
          {one ? ` · selected: ${one.kind} ${one.color}` : ''}
        </p>
      </div>
    </EditorShell>
  );
}
