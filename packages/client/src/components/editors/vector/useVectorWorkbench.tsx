import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  VECTOR_TOOLS,
  VECTOR_TOOL_HINT,
  VECTOR_TOOL_LABEL,
  addPoint,
  addShape,
  allPoints,
  averageNodeRuns,
  containsPoint,
  curveFromHandle,
  curveNodes,
  deleteNode,
  deletePoint,
  deleteRun,
  deleteShapes,
  handlePosition,
  mapPoints,
  nearestPoint,
  nearestSegment,
  newId,
  nodeHandles,
  pointKey,
  setLineWidth,
  setNodeCurve,
  setShapeColor,
  shapeById,
  shapeNodesNear,
  shapePath,
  splitLine,
  splitPolygon,
  translateShapes,
  type VectorBrush,
  type VectorImage,
  type VectorLine,
  type VectorPoint,
  type VectorShape,
  type VectorTool,
} from '@vibetoon/shared';
import { useView } from '../../../state/view';
import { Field } from '../../common/Field';
import { onScreen } from '../../common/handles';
import { Slider } from '../../common/Slider';
import { Stage } from '../../common/Stage';

/** How near the cursor has to be, in screen pixels, to grab something. */
const GRAB = 10;

/** How far out a corner's handles are drawn, as a curve, so there is something to pull. */
const GHOST = 0.4;

/** A shape's look beyond its own color: an outline saying what it is, or faded. */
export interface ShapeDecoration {
  outline?: string;
  opacity?: number;
}

export interface VectorWorkbenchOptions {
  /** The shapes being edited. */
  image: VectorImage;
  selected: readonly string[];
  brush: VectorBrush;
  /** A finished change: one step, counted. */
  onEdit(next: VectorImage, selected: string[]): void;
  /** A change in the middle of a drag, not counted until `onSettle`. */
  onLive(next: VectorImage): void;
  /** The drag that made live changes is over: count it. */
  onSettle(): void;
  onSelect(selected: string[]): void;
  onBrush(brush: VectorBrush): void;
  /** Shapes drawn faded behind, not editable: the rest of the drawing, for context. */
  backdrop?: readonly VectorShape[];
  backdropOpacity?: number;
  /** The part of the picture shown, in its own units. The whole of it by default. */
  view?: { x: number; y: number; width: number; height: number };
  decorate?(shape: VectorShape): ShapeDecoration | undefined;
  title: string;
  /** Extra things for the stage's toolbar. */
  stageTools?: ReactNode;
  /** What the stage says when there is nothing to edit. */
  empty: ReactNode;
  /** Answer to keys (Delete, Enter, Esc). Off when another part of the page has them. */
  keys?: boolean;
}

export interface VectorWorkbench {
  /** The tool picker, and the settings of the tool in hand. */
  toolPanel: JSX.Element;
  /** What is selected: its color, its width, and deleting it. Null when nothing is. */
  selectionPanel: JSX.Element | null;
  stage: JSX.Element;
  tool: VectorTool;
}

/**
 * Editing vector shapes: every tool of the Vector Editor, for any editor that
 * holds shapes — the whole drawing, one body part, one feature of a face.
 *
 * The hook holds what is in hand (the tool, a drag, a half-drawn shape) and
 * the pointer work. What is being edited is the caller's, handed in and handed
 * back through `onEdit` (a finished change), `onLive` and `onSettle` (a drag, so
 * one drag is one step), and `onSelect`.
 */
export function useVectorWorkbench(options: VectorWorkbenchOptions): VectorWorkbench {
  const { image, selected: selectedIds, brush, onEdit, onLive, onSettle, onSelect, onBrush } = options;
  const { view: prefs } = useView();
  const box = options.view ?? { x: 0, y: 0, width: image.width, height: image.height };

  const [tool, setTool] = useState<VectorTool>('select');
  const [dragging, setDragging] = useState<{ id: string; index: number } | null>(null);
  const [pending, setPending] = useState<
    { id: string; kind: 'cut'; from: VectorPoint } | { id: string; kind: 'erase'; index: number } | null
  >(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pulling, setPulling] = useState<'ahead' | 'behind' | null>(null);
  const [brushed, setBrushed] = useState<Set<string> | null>(null);
  const [cursor, setCursor] = useState<{ point: VectorPoint; scale: number } | null>(null);
  const [shifting, setShifting] = useState<{ last: VectorPoint; ids: string[] } | null>(null);
  const [draft, setDraft] = useState<VectorPoint[]>([]);
  const [drawKind, setDrawKind] = useState<'polygon' | 'line'>('polygon');
  const [drawColor, setDrawColor] = useState('#333333');
  const [drawWidth, setDrawWidth] = useState(3);
  const frame = useRef<HTMLDivElement | null>(null);

  const selected = image.shapes.filter((shape) => selectedIds.includes(shape.id));
  const one = selected.length === 1 ? selected[0]! : null;
  const handles = useMemo(
    () => (tool === 'curve' && picked ? nodeHandles(image, picked, selectedIds[0]) : null),
    [selectedIds, image, picked, tool],
  );

  /** Every finished change goes through here, so the selection stays honest. */
  const edit = (next: VectorImage, keep: readonly string[] = selectedIds) => {
    // An operation that declined to do anything hands back the image it was
    // given; counting that would make the count one of clicks, not changes.
    if (next === image) return;
    const alive = new Set(next.shapes.map((shape) => shape.id));
    onEdit(next, keep.filter((id) => alive.has(id)));
  };
  const select = (ids: string[]) => onSelect(ids);
  const setBrush = (over: Partial<VectorBrush>) => onBrush({ ...brush, ...over });

  /* ---------------- pointer work ---------------- */

  /** Where in the picture a pointer event landed, and how big a picture unit is on screen. */
  const locate = (event: { clientX: number; clientY: number }): { point: VectorPoint; scale: number } | null => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0 || box.width === 0 || box.height === 0) return null;
    const scale = Math.min(rect.width / box.width, rect.height / box.height);
    if (scale === 0) return null;
    const left = rect.x + (rect.width - box.width * scale) / 2;
    const top = rect.y + (rect.height - box.height * scale) / 2;
    return { point: { x: box.x + (event.clientX - left) / scale, y: box.y + (event.clientY - top) / scale }, scale };
  };

  /** The shape and anchor nearest the cursor, if anything is near enough. */
  const grab = (point: VectorPoint, scale: number, preferSelected = false) => {
    const reach = GRAB / scale;
    let best: { shape: VectorShape; index: number; distance: number } | null = null;
    // A node shown on the selected shape wins over one hidden in another.
    const inOrder = preferSelected
      ? [...image.shapes.filter((shape) => selectedIds.includes(shape.id)), ...image.shapes.filter((shape) => !selectedIds.includes(shape.id))]
      : image.shapes;
    for (const shape of inOrder) {
      if (preferSelected && best && !selectedIds.includes(shape.id)) break;
      const near = nearestPoint(shape, point);
      if (!near || near.distance > reach) continue;
      if (!best || near.distance < best.distance) best = { shape, index: near.index, distance: near.distance };
    }
    return best;
  };

  /**
   * The shape under the cursor: nearest edge, or — for a filled shape — the one
   * the point is inside. The edge wins when it is close, because adding a
   * point to an edge has to land on the edge you meant.
   */
  const grabEdge = (point: VectorPoint, scale: number) => {
    const reach = GRAB / scale;
    let best: { shape: VectorShape; index: number; distance: number } | null = null;
    for (const shape of image.shapes) {
      const near = nearestSegment(shape, point);
      if (!near || near.distance > reach) continue;
      if (!best || near.distance < best.distance) best = { shape, index: near.index, distance: near.distance };
    }
    if (best) return best;
    // Later shapes are drawn on top, so the last one containing the point is the one you can see.
    for (let index = image.shapes.length - 1; index >= 0; index -= 1) {
      const shape = image.shapes[index]!;
      if (!containsPoint(shape, point)) continue;
      const near = nearestSegment(shape, point);
      return { shape, index: near?.index ?? 0, distance: near?.distance ?? 0 };
    }
    return null;
  };

  /** Finish the shape being drawn, if it has enough points to be one. */
  const finishDraft = (points = draft) => {
    // A double-click lands its two clicks on the same spot; that is one point.
    const clean = points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y) > 0.5);
    setDraft([]);
    const round = (point: VectorPoint) => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });
    if (drawKind === 'polygon' && clean.length >= 3) {
      const shape: VectorShape = { id: newId('shape'), kind: 'polygon', color: drawColor, points: clean.map(round) };
      edit(addShape(image, shape), [shape.id]);
    } else if (drawKind === 'line' && clean.length >= 2) {
      const shape: VectorLine = { id: newId('line'), kind: 'line', color: drawColor, width: drawWidth, points: clean.map(round), curved: false, closed: false };
      edit(addShape(image, shape), [shape.id]);
    }
  };

  /**
   * One step of a brush stroke: take in the selected shape's nodes under the
   * brush. Curving happens as it goes; averaging waits for the stroke to end,
   * so a brush held still does not wear the outline away.
   */
  const stroke = (shape: VectorShape, point: VectorPoint, scale: number, so: Set<string>) => {
    const under = shapeNodesNear(shape, point, brush.size / scale).filter((key) => !so.has(key));
    setBrushed(new Set([...so, ...under]));
    if (brush.mode === 'curve' && under.length > 0) onLive(curveNodes(image, new Set(under), brush.amount));
  };

  const onDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const found = locate(event);
    if (!found) return;
    const { point, scale } = found;

    if (tool === 'draw') {
      setDraft([...draft, point]);
      return;
    }

    if (tool === 'select') {
      const anchor = grab(point, scale);
      if (anchor) {
        setDragging({ id: anchor.shape.id, index: anchor.index });
        select(event.shiftKey ? [...selectedIds, anchor.shape.id] : [anchor.shape.id]);
        return;
      }
      const edge = grabEdge(point, scale);
      select(edge ? (event.shiftKey ? [...selectedIds, edge.shape.id] : [edge.shape.id]) : []);
      return;
    }

    if (tool === 'shift') {
      const edge = grabEdge(point, scale);
      if (!edge) {
        select([]);
        return;
      }
      const ids = selectedIds.includes(edge.shape.id) ? [...selectedIds] : event.shiftKey ? [...selectedIds, edge.shape.id] : [edge.shape.id];
      select(ids);
      setShifting({ last: point, ids });
      return;
    }

    if (tool === 'add') {
      const edge = grabEdge(point, scale);
      if (edge) edit(addPoint(image, edge.shape.id, edge.index, point), [edge.shape.id]);
      return;
    }

    if (tool === 'cut') {
      // The second click only says which way the cut runs; the first chose the shape.
      if (pending?.kind === 'cut') {
        edit(splitPolygon(image, pending.id, pending.from, point, newId), []);
        setPending(null);
        return;
      }
      const edge = grabEdge(point, scale);
      if (!edge) return;
      if (edge.shape.kind === 'line') {
        edit(splitLine(image, edge.shape.id, edge.index, point, newId), []);
        return;
      }
      setPending({ id: edge.shape.id, kind: 'cut', from: point });
      select([edge.shape.id]);
      return;
    }

    if (tool === 'node') {
      const anchor = grab(point, scale, true);
      if (anchor) {
        edit(deleteNode(image, pointKey(allPoints(anchor.shape)[anchor.index]!)), [anchor.shape.id]);
        return;
      }
      const edge = grabEdge(point, scale);
      select(edge ? [edge.shape.id] : []);
      return;
    }

    if (tool === 'curve') {
      if (handles) {
        for (const which of ['ahead', 'behind'] as const) {
          if ((which === 'ahead' ? handles.ahead : handles.behind) === 0) continue;
          const at = handlePosition(handles, which, GHOST);
          if (Math.hypot(at.x - point.x, at.y - point.y) <= GRAB / scale) {
            setPulling(which);
            return;
          }
        }
      }
      const anchor = grab(point, scale, true);
      if (anchor) {
        setPicked(pointKey(allPoints(anchor.shape)[anchor.index]!));
        select([anchor.shape.id]);
        return;
      }
      const edge = grabEdge(point, scale);
      setPicked(null);
      select(edge ? [edge.shape.id] : []);
      return;
    }

    if (tool === 'smooth') {
      if (!one) {
        // Nothing to brush yet: the first click picks the shape.
        const edge = grabEdge(point, scale);
        select(edge ? [edge.shape.id] : []);
        return;
      }
      stroke(one, point, scale, new Set());
      return;
    }

    if (tool === 'erase') {
      const anchor = grab(point, scale);
      if (!anchor) return;
      if (!pending || pending.kind !== 'erase' || pending.id !== anchor.shape.id) {
        setPending({ id: anchor.shape.id, kind: 'erase', index: anchor.index });
        select([anchor.shape.id]);
        return;
      }
      edit(deleteRun(image, anchor.shape.id, pending.index, anchor.index, newId), []);
      setPending(null);
    }
  };

  /** Right click deletes: an anchor if one is under it, or else the shape. Drawing, it finishes the shape. */
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (tool === 'draw') {
      finishDraft();
      return;
    }
    const found = locate(event);
    if (!found) return;
    const anchor = grab(found.point, found.scale);
    if (anchor) {
      edit(deletePoint(image, anchor.shape.id, anchor.index), [anchor.shape.id]);
      return;
    }
    const edge = grabEdge(found.point, found.scale);
    if (edge) edit(deleteShapes(image, [edge.shape.id]), []);
  };

  const onMove = (event: React.MouseEvent) => {
    const found = locate(event);
    if (!found) return;
    if (tool === 'smooth' || tool === 'draw') setCursor(found);
    if (shifting) {
      const by = { x: found.point.x - shifting.last.x, y: found.point.y - shifting.last.y };
      onLive(translateShapes(image, shifting.ids, by));
      setShifting({ ...shifting, last: found.point });
      return;
    }
    if (pulling && handles) {
      onLive(setNodeCurve(image, handles.key, curveFromHandle(handles, pulling, found.point)));
      return;
    }
    if (brushed && one) {
      stroke(one, found.point, found.scale, brushed);
      return;
    }
    if (!dragging) return;
    // Straight into the image rather than through `edit`, so a drag is one step, not one per frame.
    const shape = shapeById(image, dragging.id);
    if (!shape) return;
    const moved = mapPoints(shape, (existing, at) => (at === dragging.index ? { ...existing, x: found.point.x, y: found.point.y } : existing));
    onLive({ ...image, shapes: image.shapes.map((candidate) => (candidate.id === dragging.id ? moved : candidate)) });
  };

  const onUp = () => {
    if (dragging || pulling || shifting) onSettle();
    if (brushed && brushed.size > 0 && one) {
      if (brush.mode === 'average') edit(averageNodeRuns(image, one.id, brushed, brush.window).image);
      else onSettle();
    }
    setDragging(null);
    setPulling(null);
    setBrushed(null);
    setShifting(null);
  };

  const onLeave = () => {
    onUp();
    setCursor(null);
  };

  /* ---------------- keys ---------------- */

  const keys = options.keys !== false;
  useEffect(() => {
    if (!keys) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (tool === 'draw' && draft.length > 0) {
        if (event.key === 'Enter') {
          event.preventDefault();
          finishDraft();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft([]);
        } else if (event.key === 'Backspace') {
          event.preventDefault();
          setDraft(draft.slice(0, -1));
        }
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (tool === 'curve' && handles) {
          event.preventDefault();
          edit(deleteNode(image, handles.key));
          setPicked(null);
          return;
        }
        if (selectedIds.length === 0) return;
        event.preventDefault();
        edit(deleteShapes(image, selectedIds), []);
      } else if (event.key === 'Escape') {
        setPending(null);
        setDragging(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------------- the tool panel ---------------- */

  const toolPanel = (
    <>
      <div className="vt-section">
        <h3>Tool</h3>
        <div className="vt-facet-values">
          {VECTOR_TOOLS.map((value) => (
            <button
              key={value}
              type="button"
              className={`vt-chip${tool === value ? ' is-on' : ''}`}
              title={VECTOR_TOOL_HINT[value]}
              onClick={() => {
                setTool(value);
                setPending(null);
                setPicked(null);
                setCursor(null);
                setDraft([]);
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
            : tool === 'draw' && draft.length > 0
              ? `${draft.length} point(s) — double-click, right-click or Enter to finish; Backspace takes the last back; Esc abandons it.`
              : VECTOR_TOOL_HINT[tool]}
        </p>
      </div>

      {tool === 'draw' ? (
        <div className="vt-section">
          <h3>New shape</h3>
          <div className="vt-facet-values">
            {(['polygon', 'line'] as const).map((kind) => (
              <button key={kind} type="button" className={`vt-chip${drawKind === kind ? ' is-on' : ''}`} onClick={() => setDrawKind(kind)}>
                {kind === 'polygon' ? 'Filled shape' : 'Line'}
              </button>
            ))}
          </div>
          <div className="vt-row" style={{ gap: 8, marginTop: 6 }}>
            <label className="vt-row" style={{ gap: 6 }}>
              Color
              <input type="color" value={drawColor} aria-label="New shape color" onChange={(event) => setDrawColor(event.target.value)} />
            </label>
            {one ? (
              <button type="button" className="vt-btn is-small" title="Use the selected shape’s color" onClick={() => setDrawColor(one.color)}>
                Take the selected color
              </button>
            ) : null}
          </div>
          {drawKind === 'line' ? (
            <label className="vt-field">
              <span className="vt-label">Width</span>
              <input type="number" min={0.25} step={0.5} value={drawWidth} aria-label="New line width" onChange={(event) => setDrawWidth(Math.max(0.25, Number(event.target.value) || 1))} />
            </label>
          ) : null}
        </div>
      ) : null}

      {tool === 'curve' ? (
        <div className="vt-section">
          <h3>Node</h3>
          {handles ? (
            <>
              <Slider
                range="vectorEdit.nodeCurve"
                label="How curved"
                tip="vectorEdit.nodeCurve"
                value={handles.s}
                format={(value) => (value === 0 ? 'a sharp corner' : value.toFixed(2))}
                onChange={(s) => edit(setNodeCurve(image, handles.key, { s }))}
              />
              <Slider
                range="vectorEdit.nodeTurn"
                label="Turn"
                tip="vectorEdit.nodeTurn"
                within={{ min: -180, max: 180 }}
                value={handles.a}
                format={(value) => `${value.toFixed(0)}°`}
                onChange={(a) => edit(setNodeCurve(image, handles.key, { a }))}
              />
              <div className="vt-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="vt-btn is-small" onClick={() => edit(setNodeCurve(image, handles.key, { s: 0, a: 0 }))}>
                  Sharp corner
                </button>
                <button type="button" className="vt-btn is-small" onClick={() => edit(setNodeCurve(image, handles.key, { s: 1, a: 0 }))}>
                  Smooth
                </button>
                <button
                  type="button"
                  className="vt-btn is-small is-danger"
                  onClick={() => {
                    edit(deleteNode(image, handles.key));
                    setPicked(null);
                  }}
                >
                  Delete node
                </button>
              </div>
            </>
          ) : (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
              Click a node to curve it. Select a shape first to see its nodes.
            </p>
          )}
        </div>
      ) : null}

      {tool === 'smooth' ? (
        <div className="vt-section">
          <h3>Smooth brush</h3>
          <div className="vt-facet-values">
            {(['average', 'curve'] as const).map((mode) => (
              <button key={mode} type="button" className={`vt-chip${brush.mode === mode ? ' is-on' : ''}`} onClick={() => setBrush({ mode })}>
                {mode === 'average' ? 'Average nodes' : 'Curve nodes'}
              </button>
            ))}
          </div>
          <Slider
            range="vectorEdit.brushSize"
            label="Brush size"
            tip="vectorEdit.brushSize"
            value={brush.size}
            format={(value) => `${value.toFixed(0)} px`}
            onChange={(size) => setBrush({ size })}
          />
          {brush.mode === 'average' ? (
            <Slider
              range="vectorEdit.brushWindow"
              label="Nodes averaged into one"
              tip="vectorEdit.brushWindow"
              value={brush.window}
              format={(value) => `${value.toFixed(0)} → 1`}
              onChange={(window) => setBrush({ window })}
            />
          ) : (
            <Slider
              range="vectorEdit.brushAmount"
              label="How curved"
              tip="vectorEdit.brushAmount"
              value={brush.amount}
              format={(value) => (value === 0 ? 'sharp corners' : value.toFixed(2))}
              onChange={(amount) => setBrush({ amount })}
            />
          )}
          {one ? (
            <button
              type="button"
              className="vt-btn is-small"
              onClick={() => {
                const every = new Set(allPoints(one).map(pointKey));
                edit(brush.mode === 'average' ? averageNodeRuns(image, one.id, every, brush.window).image : curveNodes(image, every, brush.amount));
              }}
            >
              {brush.mode === 'average' ? 'Average' : 'Curve'} the whole shape
            </button>
          ) : (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>Click a shape to brush it.</p>
          )}
        </div>
      ) : null}
    </>
  );

  /* ---------------- the selection panel ---------------- */

  const selectionPanel = one ? (
    <div className="vt-section">
      <h3>{one.kind === 'polygon' ? 'Polygon' : 'Line'}</h3>
      <dl className="vt-kv">
        <dt>Color</dt>
        <dd>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(one.color) ? one.color : '#000000'} aria-label="Shape color" onChange={(event) => edit(setShapeColor(image, [one.id], event.target.value))} />{' '}
          <code>{one.color}</code>
        </dd>
        <dt>Points</dt>
        <dd>{allPoints(one).length}</dd>
      </dl>
      {one.kind === 'line' ? (
        <>
          <label className="vt-field">
            <span className="vt-label">Width</span>
            <input type="number" min={0.25} step={0.5} value={one.width} aria-label="Line width" onChange={(event) => edit(setLineWidth(image, [one.id], Number(event.target.value) || 1))} />
          </label>
          <Field label="Shape">
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={one.curved}
                onChange={(event) =>
                  edit({ ...image, shapes: image.shapes.map((shape) => (shape.id === one.id ? ({ ...shape, curved: event.target.checked } as VectorLine) : shape)) })
                }
              />
              Curved
            </label>
          </Field>
        </>
      ) : null}
      <button type="button" className="vt-btn is-small is-danger" onClick={() => edit(deleteShapes(image, selectedIds), [])}>
        Delete this
      </button>
    </div>
  ) : selected.length > 1 ? (
    <div className="vt-section">
      <h3>{selected.length} shapes</h3>
      <button type="button" className="vt-btn is-small is-danger" onClick={() => edit(deleteShapes(image, selectedIds), [])}>
        Delete these {selected.length}
      </button>
    </div>
  ) : null;

  /* ---------------- the stage ---------------- */

  const drawShape = (shape: VectorShape, editable: boolean) => {
    const look = options.decorate?.(shape);
    const classes = editable
      ? `vt-vector-shape${selectedIds.includes(shape.id) ? ' is-selected' : ''}${hover === shape.id ? ' is-hover' : ''}`
      : 'vt-vector-backdrop';
    const key = `${editable ? '' : 'b:'}${shape.id}`;
    const common = {
      d: shapePath(shape),
      className: classes,
      ...(look?.opacity !== undefined ? { opacity: look.opacity } : {}),
      ...(editable ? { onMouseEnter: () => setHover(shape.id), onMouseLeave: () => setHover(null) } : {}),
    };
    return shape.kind === 'polygon' ? (
      <path key={key} {...common} fill={shape.color} fillRule="evenodd" />
    ) : (
      <path key={key} {...common} fill="none" stroke={shape.color} strokeWidth={shape.width} strokeLinecap="round" strokeLinejoin="round" />
    );
  };

  const cursorStyle =
    shifting ? 'grabbing' : tool === 'select' ? 'default' : tool === 'shift' ? 'move' : tool === 'smooth' && one ? 'none' : 'crosshair';

  const stage = (
    <Stage zoomable title={options.title} tools={options.stageTools}>
      {({ scale }) => (
        <div className="vt-vector-stage">
          {image.shapes.length > 0 || (options.backdrop?.length ?? 0) > 0 || tool === 'draw' ? (
            <div
              className="vt-vector-frame"
              ref={frame}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={onUp}
              onMouseLeave={onLeave}
              onDoubleClick={() => {
                if (tool === 'draw') finishDraft();
              }}
              onContextMenu={onContextMenu}
              style={{ aspectRatio: `${box.width} / ${box.height}`, cursor: cursorStyle }}
            >
              <svg className="vt-vector-svg is-editable" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} preserveAspectRatio="xMidYMid meet">
                {options.backdrop?.length ? (
                  <g opacity={options.backdropOpacity ?? 0.22} style={{ pointerEvents: 'none' }}>
                    {options.backdrop.filter((shape) => shape.kind === 'polygon').map((shape) => drawShape(shape, false))}
                    {options.backdrop.filter((shape) => shape.kind === 'line').map((shape) => drawShape(shape, false))}
                  </g>
                ) : null}
                {image.shapes.filter((shape) => shape.kind === 'polygon').map((shape) => drawShape(shape, true))}
                {image.shapes.filter((shape) => shape.kind === 'line').map((shape) => drawShape(shape, true))}

                {/* What each shape is, as an outline over it. */}
                {options.decorate
                  ? image.shapes.map((shape) => {
                      const outline = options.decorate?.(shape)?.outline;
                      return outline ? (
                        <path key={`o:${shape.id}`} d={shapePath(shape)} fill="none" stroke={outline} strokeWidth={onScreen(1.5, scale)} className="vt-shape-tag" />
                      ) : null;
                    })
                  : null}

                {/* Anchors, on the selected shapes only: every point of every shape at once is unreadable. */}
                {selected.slice(0, prefs.listLimit).map((shape) =>
                  allPoints(shape).map((point, index) => (
                    <circle
                      key={`${shape.id}:${index}`}
                      cx={point.x}
                      cy={point.y}
                      r={onScreen(Math.max(1, box.width / 260), scale)}
                      strokeWidth={onScreen(1, scale)}
                      className={`vt-anchor${
                        (dragging?.id === shape.id && dragging.index === index) || (picked !== null && handles?.key === pointKey(point)) ? ' is-held' : ''
                      }${brushed?.has(pointKey(point)) && brush.mode === 'average' ? ' is-brushed' : ''}${
                        pending?.kind === 'erase' && pending.id === shape.id && pending.index === index ? ' is-marked' : ''
                      }`}
                    />
                  )),
                )}

                {handles
                  ? (['ahead', 'behind'] as const)
                      .filter((which) => (which === 'ahead' ? handles.ahead : handles.behind) > 0)
                      .map((which) => {
                        const at = handlePosition(handles, which, GHOST);
                        const ghost = handles.s === 0;
                        return (
                          <g key={which}>
                            <line x1={handles.at.x} y1={handles.at.y} x2={at.x} y2={at.y} strokeWidth={onScreen(1, scale)} className={`vt-curve-arm${ghost ? ' is-ghost' : ''}`} />
                            <circle cx={at.x} cy={at.y} r={onScreen(4, scale)} strokeWidth={onScreen(1.5, scale)} className={`vt-curve-handle${ghost ? ' is-ghost' : ''}`} />
                          </g>
                        );
                      })
                  : null}

                {/* The shape being drawn, closed already if it is an area. */}
                {tool === 'draw' && draft.length > 0 ? (
                  <g className="vt-draw-draft">
                    {drawKind === 'polygon' && draft.length >= 2 ? (
                      <polygon
                        points={[...draft, ...(cursor ? [cursor.point] : [])].map((point) => `${point.x},${point.y}`).join(' ')}
                        fill={drawColor}
                        fillOpacity={0.45}
                        stroke={drawColor}
                        strokeWidth={onScreen(1.5, scale)}
                      />
                    ) : (
                      <polyline
                        points={[...draft, ...(cursor ? [cursor.point] : [])].map((point) => `${point.x},${point.y}`).join(' ')}
                        fill="none"
                        stroke={drawColor}
                        strokeWidth={drawKind === 'line' ? drawWidth : onScreen(1.5, scale)}
                        strokeLinecap="round"
                      />
                    )}
                    {draft.map((point, index) => (
                      <circle key={index} cx={point.x} cy={point.y} r={onScreen(3, scale)} strokeWidth={onScreen(1, scale)} className="vt-anchor" />
                    ))}
                  </g>
                ) : null}

                {tool === 'smooth' && one && cursor ? (
                  <circle cx={cursor.point.x} cy={cursor.point.y} r={brush.size / cursor.scale} strokeWidth={onScreen(1, scale)} className="vt-brush-ring" />
                ) : null}
              </svg>
            </div>
          ) : (
            <div className="vt-empty">{options.empty}</div>
          )}
        </div>
      )}
    </Stage>
  );

  return { toolPanel, selectionPanel, stage, tool };
}
