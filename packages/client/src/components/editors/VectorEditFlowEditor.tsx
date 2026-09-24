import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VECTOR_TOOL_HINT,
  VECTOR_TOOL_LABEL,
  addPoint,
  allPoints,
  adopt,
  containsPoint,
  deletePoint,
  deleteRun,
  deleteShapes,
  editState,
  emptyVectorEditFlowData,
  imageOf,
  inputsForPort,
  mapPoints,
  nearestPoint,
  nearestSegment,
  newId,
  readVectorImage,
  shapeById,
  shapePath,
  splitLine,
  splitPolygon,
  summariseVector,
  type FlowNode,
  type Project,
  type VectorEditFlowData,
  type VectorLine,
  type VectorPoint,
  type VectorShape,
  type VectorTool,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Field } from '../common/Field';
import { onScreen } from '../common/handles';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/** How near the cursor has to be, in screen pixels, to grab something. */
const GRAB = 10;

/**
 * Editing a vectorized image.
 *
 * A decomposition is a starting guess: it gets the shapes roughly right and puts
 * points where the pixels changed rather than where the drawing turns. This is
 * where that is fixed — move a point, add one, delete one, cut a shape in two,
 * or take a run out of a line.
 *
 * The edits live in this flow rather than being recomputed from upstream, which
 * is the whole point of it. An upstream change is reported and the edits are kept
 * until you say otherwise: losing an afternoon's work to someone re-running the
 * decomposition would make the flow not worth using.
 */
export function VectorEditFlowEditor({
  project,
  node,
}: {
  project: Project;
  node: FlowNode;
}): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const { view } = useView();
  const data =
    node.data.editor === 'vectorEdit' ? (node.data as VectorEditFlowData) : emptyVectorEditFlowData();

  const input = inputsForPort(project, node.id, 'vector')[0];
  const artifact = input?.artifact;

  const [tool, setTool] = useState<VectorTool>('select');
  const [dragging, setDragging] = useState<{ id: string; index: number } | null>(null);
  const [pending, setPending] = useState<
    { id: string; kind: 'cut'; from: VectorPoint } | { id: string; kind: 'erase'; index: number } | null
  >(null);
  const [hover, setHover] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);

  const image = imageOf(data);
  const state = editState(data, artifact?.hash);
  const summary = useMemo(() => summariseVector(image), [image]);

  const patch = useCallback(
    (over: Partial<VectorEditFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  /** Every edit goes through here, so the count and the selection stay honest. */
  const edit = useCallback(
    (next: ReturnType<typeof imageOf>, selected = data.selected) => {
      // An operation that declined to do anything — a cut that missed, a delete
      // of nothing — hands back the image it was given. Counting that as an edit
      // would make the number a count of clicks rather than of changes.
      if (next === image) return;
      const alive = new Set(next.shapes.map((shape) => shape.id));
      patch({
        image: next,
        edits: data.edits + 1,
        selected: selected.filter((id) => alive.has(id)),
      });
    },
    [data.edits, data.selected, image, patch],
  );

  /* ---------------- taking the upstream in ---------------- */

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

  /* ---------------- pointer work ---------------- */

  /** Where in the image a pointer event landed, and how big a screen pixel is. */
  const locate = (
    event: React.MouseEvent,
  ): { point: VectorPoint; scale: number } | null => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    const scale = Math.min(box.width / image.width, box.height / image.height);
    if (scale === 0) return null;
    const drawn = { width: image.width * scale, height: image.height * scale };
    const left = box.x + (box.width - drawn.width) / 2;
    const top = box.y + (box.height - drawn.height) / 2;
    return {
      point: { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale },
      scale,
    };
  };

  /** The shape and anchor nearest the cursor, if anything is near enough. */
  const grab = (point: VectorPoint, scale: number) => {
    const reach = GRAB / scale;
    let best: { shape: VectorShape; index: number; distance: number } | null = null;
    for (const shape of image.shapes) {
      const near = nearestPoint(shape, point);
      if (!near || near.distance > reach) continue;
      if (!best || near.distance < best.distance) {
        best = { shape, index: near.index, distance: near.distance };
      }
    }
    return best;
  };

  /**
   * The shape under the cursor: nearest edge, or — for a filled shape — the one
   * the point is inside.
   *
   * Edge-only would mean a big polygon could be picked up by its outline alone,
   * which is a thin target around a large object and not where anyone clicks.
   * The edge still wins when it is close, because adding a point to an edge has
   * to land on the edge you meant.
   */
  const grabEdge = (point: VectorPoint, scale: number) => {
    const reach = GRAB / scale;
    let best: { shape: VectorShape; index: number; distance: number } | null = null;
    for (const shape of image.shapes) {
      const near = nearestSegment(shape, point);
      if (!near || near.distance > reach) continue;
      if (!best || near.distance < best.distance) {
        best = { shape, index: near.index, distance: near.distance };
      }
    }
    if (best) return best;

    // Nothing near an edge, so fall back to what the point is inside. Later
    // shapes are drawn on top, so the last one that contains it is the one you
    // can see.
    for (let index = image.shapes.length - 1; index >= 0; index -= 1) {
      const shape = image.shapes[index]!;
      if (!containsPoint(shape, point)) continue;
      const near = nearestSegment(shape, point);
      return { shape, index: near?.index ?? 0, distance: near?.distance ?? 0 };
    }
    return null;
  };

  const onDown = (event: React.MouseEvent) => {
    const found = locate(event);
    if (!found) return;
    const { point, scale } = found;

    if (tool === 'select') {
      const anchor = grab(point, scale);
      if (anchor) {
        setDragging({ id: anchor.shape.id, index: anchor.index });
        patch({ selected: event.shiftKey ? [...data.selected, anchor.shape.id] : [anchor.shape.id] });
        return;
      }
      const edge = grabEdge(point, scale);
      patch({
        selected: edge
          ? event.shiftKey
            ? [...data.selected, edge.shape.id]
            : [edge.shape.id]
          : [],
      });
      return;
    }

    if (tool === 'add') {
      const edge = grabEdge(point, scale);
      if (!edge) return;
      edit(addPoint(image, edge.shape.id, edge.index, point), [edge.shape.id]);
      return;
    }

    if (tool === 'cut') {
      // The second click only says which way the cut runs; the first chose the
      // shape. Requiring the second to land on that shape again makes a cut that
      // leaves it — which is most of them — impossible to aim.
      if (pending?.kind === 'cut') {
        edit(splitPolygon(image, pending.id, pending.from, point, newId), []);
        setPending(null);
        return;
      }
      const edge = grabEdge(point, scale);
      if (!edge) return;
      const shape = edge.shape;

      if (shape.kind === 'line') {
        // A line is cut where you click: one point is enough to divide it.
        edit(splitLine(image, shape.id, edge.index, point, newId), []);
        return;
      }
      // A polygon needs a line across it, so the first click starts the cut and
      // the second (handled above) only says which way it runs.
      setPending({ id: shape.id, kind: 'cut', from: point });
      patch({ selected: [shape.id] });
      return;
    }

    if (tool === 'erase') {
      const anchor = grab(point, scale);
      if (!anchor) return;
      if (!pending || pending.kind !== 'erase' || pending.id !== anchor.shape.id) {
        setPending({ id: anchor.shape.id, kind: 'erase', index: anchor.index });
        patch({ selected: [anchor.shape.id] });
        return;
      }
      edit(deleteRun(image, anchor.shape.id, pending.index, anchor.index, newId), []);
      setPending(null);
    }
  };

  /**
   * Right click deletes: an anchor under the Move tool, or the whole shape
   * otherwise. The same left-adds, right-removes as the cutout editor, so there
   * is one convention across the studio rather than one per tool.
   */
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const found = locate(event);
    if (!found) return;
    const { point, scale } = found;

    const anchor = grab(point, scale);
    if (anchor) {
      edit(deletePoint(image, anchor.shape.id, anchor.index), [anchor.shape.id]);
      return;
    }
    const edge = grabEdge(point, scale);
    if (edge) edit(deleteShapes(image, [edge.shape.id]), []);
  };

  const onMove = (event: React.MouseEvent) => {
    if (!dragging) return;
    const found = locate(event);
    if (!found) return;
    // Moved straight into the image rather than through `edit`, so a drag is one
    // edit rather than one per frame — and the undo count stays meaningful.
    const shape = shapeById(image, dragging.id);
    if (!shape) return;
    const moved = mapPoints(shape, (existing, at) => (at === dragging.index ? found.point : existing));
    patch({ image: { ...image, shapes: image.shapes.map((s) => (s.id === dragging.id ? moved : s)) } });
  };

  const onUp = () => {
    if (dragging) patch({ edits: data.edits + 1 });
    setDragging(null);
  };

  /* ---------------- keys ---------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (data.selected.length === 0) return;
        event.preventDefault();
        edit(deleteShapes(image, data.selected), []);
      } else if (event.key === 'Escape') {
        setPending(null);
        setDragging(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selected = image.shapes.filter((shape) => data.selected.includes(shape.id));
  const one = selected.length === 1 ? selected[0]! : null;

  const blocked = !input
    ? 'Wire a Polygon Decomposition flow into the Vector input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not produced a vector yet.`
      : null;

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
        <div className="vt-section">
          <h3>Tool</h3>
          <div className="vt-facet-values">
            {(['select', 'add', 'cut', 'erase'] as VectorTool[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`vt-chip${tool === value ? ' is-on' : ''}`}
                title={VECTOR_TOOL_HINT[value]}
                onClick={() => {
                  setTool(value);
                  setPending(null);
                }}
              >
                {VECTOR_TOOL_LABEL[value]}
              </button>
            ))}
          </div>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            {pending
              ? pending.kind === 'cut'
                ? 'Click the far side of the shape to finish the cut. Esc to abandon.'
                : 'Click the other end of the run to delete. Esc to abandon.'
              : VECTOR_TOOL_HINT[tool]}
          </p>
        </div>

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

        {one ? (
          <div className="vt-section">
            <h3>{one.kind === 'polygon' ? 'Polygon' : 'Line'}</h3>
            <dl className="vt-kv">
              <dt>Color</dt>
              <dd>
                <span
                  className="vt-swatch-chip"
                  style={{ background: one.color }}
                  aria-hidden="true"
                />{' '}
                <code>{one.color}</code>
              </dd>
              <dt>Points</dt>
              <dd>{allPoints(one).length}</dd>
            </dl>
            {one.kind === 'line' ? (
              <Field label="Shape">
                <label className="vt-row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={one.curved}
                    onChange={(event) =>
                      edit({
                        ...image,
                        shapes: image.shapes.map((shape) =>
                          shape.id === one.id
                            ? ({ ...shape, curved: event.target.checked } as VectorLine)
                            : shape,
                        ),
                      })
                    }
                  />
                  Curved
                </label>
              </Field>
            ) : null}
            <button
              type="button"
              className="vt-btn is-small is-danger"
              onClick={() => edit(deleteShapes(image, data.selected), [])}
            >
              Delete {selected.length === 1 ? 'this' : `these ${selected.length}`}
            </button>
          </div>
        ) : null}

        <div className="vt-section">
          <h3>The original</h3>
          <button
            type="button"
            className="vt-btn is-small"
            disabled={!artifact}
            onClick={() => void takeIn()}
          >
            Take it in again
          </button>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            Replaces everything here with what is wired in, including {data.edits} edit(s).
          </p>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The drawing"
          tools={
            <>
              <span className="vt-faint" style={{ fontSize: 11 }}>
                {image.shapes.length > 0
                  ? `${image.width} × ${image.height} · ${summary.shapes} shapes`
                  : 'nothing yet'}
              </span>
              {data.selected.length > 0 ? (
                <button
                  type="button"
                  className="vt-btn is-small is-danger"
                  onClick={() => edit(deleteShapes(image, data.selected), [])}
                >
                  Delete {data.selected.length}
                </button>
              ) : null}
            </>
          }
        >
          {({ scale }) => (
          <div className="vt-vector-stage">
            {image.shapes.length > 0 ? (
              <div
                className="vt-vector-frame"
                ref={frame}
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
                onContextMenu={onContextMenu}
                style={{ aspectRatio: `${image.width} / ${image.height}`, cursor: tool === 'select' ? 'default' : 'crosshair' }}
              >
                <svg
                  className="vt-vector-svg is-editable"
                  viewBox={`0 0 ${image.width} ${image.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {image.shapes
                    .filter((shape) => shape.kind === 'polygon')
                    .map((shape) => (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill={shape.color} fillRule="evenodd"
                        className={`vt-vector-shape${data.selected.includes(shape.id) ? ' is-selected' : ''}${
                          hover === shape.id ? ' is-hover' : ''
                        }`}
                        onMouseEnter={() => setHover(shape.id)}
                        onMouseLeave={() => setHover(null)}
                      />
                    ))}
                  {image.shapes
                    .filter((shape): shape is VectorLine => shape.kind === 'line')
                    .map((shape) => (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill="none"
                        stroke={shape.color}
                        strokeWidth={shape.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`vt-vector-shape${data.selected.includes(shape.id) ? ' is-selected' : ''}${
                          hover === shape.id ? ' is-hover' : ''
                        }`}
                        onMouseEnter={() => setHover(shape.id)}
                        onMouseLeave={() => setHover(null)}
                      />
                    ))}

                  {/* Anchors, on the selected shapes only: every point of every
                      shape at once is unreadable and unclickable. */}
                  {selected.slice(0, view.listLimit).map((shape) =>
                    allPoints(shape).map((point, index) => (
                      <circle
                        key={`${shape.id}:${index}`}
                        cx={point.x}
                        cy={point.y}
                        r={onScreen(Math.max(1, image.width / 260), scale)}
                        strokeWidth={onScreen(1, scale)}
                        className={`vt-anchor${
                          dragging?.id === shape.id && dragging.index === index ? ' is-held' : ''
                        }${
                          pending?.kind === 'erase' && pending.id === shape.id && pending.index === index
                            ? ' is-marked'
                            : ''
                        }`}
                      />
                    )),
                  )}
                </svg>
              </div>
            ) : (
              <div className="vt-empty">{blocked ?? 'Nothing taken in yet.'}</div>
            )}
          </div>
          )}
        </Stage>

        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summary.shapes} shape(s), {summary.points.toLocaleString()} point(s) · {data.edits} edit(s)
          {one ? ` · selected: ${one.kind} ${one.color}` : ''}
        </p>
      </div>
    </EditorShell>
  );
}
