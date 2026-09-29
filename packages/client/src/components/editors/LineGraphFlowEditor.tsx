import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LINE_GRAPH_OPTIONS,
  MAX_GRAPH_WIDTH,
  buildLineGraph,
  editedGraph,
  emptyLineGraphFlowData,
  graphBasis,
  inputsForPort,
  summariseGraph,
  widthColour,
  type Bitmap,
  type FlowNode,
  type GraphPoint,
  type LineGraph,
  type LineGraphFlowData,
  type LineGraphOptions,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { paintBitmap, svgPoint, useFitScale } from './CropFlowEditor';
import { EditorShell } from './EditorShell';

/** The fills, faintly tinted, each its own shade, to show what every line runs over. */
function fillPicture(graph: LineGraph): Bitmap {
  const out = new Uint8ClampedArray(graph.width * graph.height * 4);
  for (let i = 0; i < graph.fills.length; i += 1) {
    const fill = graph.fills[i]!;
    if (!fill) continue;
    const hue = (fill * 137.5) % 360;
    // A cheap hue wheel: enough to tell neighbouring fills apart.
    const r = 128 + 90 * Math.cos((hue * Math.PI) / 180);
    const g = 128 + 90 * Math.cos(((hue - 120) * Math.PI) / 180);
    const b = 128 + 90 * Math.cos(((hue + 120) * Math.PI) / 180);
    out.set([r, g, b, 110], i * 4);
  }
  return { width: graph.width, height: graph.height, data: out };
}

const points = (list: readonly GraphPoint[]) => list.map((point) => `${point.x},${point.y}`).join(' ');

/**
 * A Line Detection's lines, as a graph of vector lines over the areas they
 * were traced from. Keep a width range; click a line to select it and Delete
 * to take it out; drag a node to move it, and the lines' ends with it.
 */
export function LineGraphFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData } = useStudio();
  const data = node.data.editor === 'lineGraph' ? (node.data as LineGraphFlowData) : emptyLineGraphFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<LineGraphFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const setOptions = (over: Partial<LineGraphOptions>) => patch({ options: { ...data.options, ...over } });

  const input = inputsForPort(project, node.id, 'lines')[0];
  const artifact = input?.artifact;
  const path = artifact ? (artifact.entries?.[0] ? `${artifact.path}/${artifact.entries[0]}` : artifact.path) : '';

  const [picture, setPicture] = useState<Bitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPicture(null);
    setError(null);
    if (!path) return undefined;
    let cancelled = false;
    readBitmap(api.artifactUrl(project.id, path), { maxPixels: 16_000_000 })
      .then((read) => {
        if (!cancelled) setPicture(read);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, project.id]);

  // Traced a moment after the tracing settings stop moving.
  const [graph, setGraph] = useState<LineGraph | null>(null);
  const optionsKey = JSON.stringify(data.options);
  useEffect(() => {
    if (!picture) {
      setGraph(null);
      return undefined;
    }
    const timer = window.setTimeout(() => setGraph(buildLineGraph(picture, data.options)), 120);
    return () => window.clearTimeout(timer);
  }, [picture, optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const basis = graphBasis(artifact?.hash, data.options);
  const edited = data.basis === undefined || data.basis === basis;
  const edits = edited ? data : { ...data, hidden: [], moved: {} };
  const [dragging, setDragging] = useState<{ id: string; at: GraphPoint } | null>(null);
  const shown = useMemo(() => {
    if (!graph) return null;
    const moved = dragging ? { ...edits.moved, [dragging.id]: dragging.at } : edits.moved;
    return editedGraph(graph, { ...edits, moved });
  }, [graph, edits, dragging]);

  // Every hand edit is keyed to this tracing.
  const edit = (over: Partial<LineGraphFlowData>) => patch({ ...(edited ? {} : { hidden: [], moved: {} }), ...over, basis });

  const [showHidden, setShowHidden] = useState(true);
  const selected = new Set(data.selected);
  const takeOut = () => {
    if (selected.size === 0) return;
    edit({ hidden: [...new Set([...edits.hidden, ...selected])], selected: [] });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && dataRef.current.selected.length > 0) takeOut();
      if (event.key === 'Escape') patch({ selected: [] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const under = useRef<HTMLCanvasElement | null>(null);
  const fills = useMemo(() => (graph && data.showFill ? fillPicture(graph) : null), [graph, data.showFill]);
  useEffect(() => {
    paintBitmap(under.current, fills ?? picture);
  }, [fills, picture]);

  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const fit = useFitScale(svg, picture?.width ?? 0, picture?.height ?? 0);

  const dragNode = (event: React.PointerEvent, id: string) => {
    if (!svg) return;
    event.preventDefault();
    event.stopPropagation();
    let last: GraphPoint | null = null;
    const move = (moveEvent: PointerEvent) => {
      const at = svgPoint(svg, moveEvent);
      last = { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 };
      setDragging({ id, at: last });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(null);
      if (last) edit({ moved: { ...edits.moved, [id]: last } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const blocked = !input
    ? 'Wire a Line Detection’s Lines into the Lines input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not found any lines yet.`
      : error
        ? `The lines could not be read: ${error}.`
        : null;
  const range = data.widthRange;
  const topLabel = (value: number) => (value >= MAX_GRAPH_WIDTH ? `${MAX_GRAPH_WIDTH}+ px` : `${value.toFixed(1)} px`);

  // How many lines of each width, for choosing the range.
  const histogram = useMemo(() => {
    const bins = new Array<number>(MAX_GRAPH_WIDTH).fill(0);
    for (const edge of graph?.edges ?? []) bins[Math.min(MAX_GRAPH_WIDTH - 1, Math.max(0, Math.floor(edge.width - 0.5)))]! += 1;
    return bins;
  }, [graph]);
  const tallest = Math.max(1, ...histogram);

  return (
    <EditorShell project={project} node={node} banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Tracing</h3>
          <p className="vt-hint">Each area of line pixels is filled, thinned to its middle, and traced; the vector lines run along the middle of the fills.</p>
          <Slider range="lineGraph.minConfidence" label="Surest pixels only" tip="lineGraph.minConfidence" value={data.options.minConfidence} format={(value) => `${Math.round(value * 100)}%`} onChange={(minConfidence) => setOptions({ minConfidence: Math.round(minConfidence * 100) / 100 })} />
          <Slider range="lineGraph.simplify" label="Simplify" tip="lineGraph.simplify" value={data.options.simplify} format={(value) => `${value.toFixed(1)} px`} onChange={(simplify) => setOptions({ simplify: Math.round(simplify * 10) / 10 })} />
          <Slider range="lineGraph.spur" label="Drop spurs shorter than" tip="lineGraph.spur" value={data.options.spur} format={(value) => `${Math.round(value)} px`} onChange={(spur) => setOptions({ spur: Math.round(spur) })} />
          <button type="button" className="vt-btn is-ghost is-small" onClick={() => setOptions({ ...DEFAULT_LINE_GRAPH_OPTIONS })}>
            Defaults
          </button>
        </div>

        <div className="vt-section">
          <h3>Keep lines of width</h3>
          <div className="vt-width-histogram" aria-hidden="true">
            {histogram.map((count, index) => {
              const width = index + 1;
              const inside = width >= range.min && (range.max >= MAX_GRAPH_WIDTH || width <= range.max);
              return <i key={index} className={inside ? 'is-in' : ''} style={{ height: `${(count / tallest) * 100}%`, background: widthColour(width) }} title={`${count} line(s) about ${width} px wide`} />;
            })}
          </div>
          <Slider range="lineGraph.widthMin" label="From" tip="lineGraph.widthRange" value={range.min} format={topLabel} onChange={(min) => patch({ widthRange: { min: Math.min(Math.round(min * 2) / 2, range.max), max: range.max } })} />
          <Slider range="lineGraph.widthMax" label="To" tip="lineGraph.widthRange" value={range.max} format={topLabel} onChange={(max) => patch({ widthRange: { min: range.min, max: Math.max(Math.round(max * 2) / 2, range.min) } })} />
        </div>

        <div className="vt-section">
          <h3>By hand</h3>
          <p className="vt-hint">Click a line to select it (Shift for more), Delete to take it out. Drag a node to move it.</p>
          <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button type="button" className="vt-btn is-small" disabled={selected.size === 0} onClick={takeOut}>
              Take out {selected.size > 0 ? selected.size : ''} line{selected.size === 1 ? '' : 's'}
            </button>
            <button type="button" className="vt-btn is-small" disabled={edits.hidden.length === 0} onClick={() => edit({ hidden: [] })}>
              Put back all {edits.hidden.length}
            </button>
            <button type="button" className="vt-btn is-small" disabled={Object.keys(edits.moved).length === 0} onClick={() => edit({ moved: {} })}>
              Nodes back
            </button>
          </div>
          <label className="vt-row" style={{ gap: 6, marginTop: 6 }}>
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
            Show lines taken out or out of range
          </label>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showFill} onChange={(event) => patch({ showFill: event.target.checked })} />
            Show the fills under the lines
          </label>
          {!edited ? (
            <p className="vt-hint">
              The lines or the tracing have changed since {data.hidden.length + Object.keys(data.moved).length} hand edit(s) were made, so they are set aside.{' '}
              <button type="button" className="vt-btn is-ghost is-small" onClick={() => patch({ hidden: [], moved: {}, basis })}>
                Forget them
              </button>
            </p>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>Found</h3>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>{graph && shown ? summariseGraph(graph, shown) : picture ? 'Tracing…' : '—'}</p>
          {shown ? (
            <dl className="vt-kv">
              <dt>Kept</dt>
              <dd>{shown.edges.length}</dd>
              <dt>Out of range</dt>
              <dd>{shown.filtered.length}</dd>
              <dt>Taken out</dt>
              <dd>{shown.hidden.length}</dd>
            </dl>
          ) : null}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage zoomable title="The line graph">
          {({ scale }) => {
            const unit = 1 / Math.max(1e-3, fit * scale);
            return (
              <div className="vt-resize-stage vt-graph-stage">
                {picture && shown ? (
                  <div className="vt-crop-frame">
                    <canvas ref={under} className="vt-crop-canvas" style={{ imageRendering: 'pixelated' }} />
                    <svg
                      ref={setSvg}
                      className="vt-crop-overlay vt-line-graph"
                      viewBox={`0 0 ${picture.width} ${picture.height}`}
                      onPointerDown={(event) => {
                        if (event.target === event.currentTarget) patch({ selected: [] });
                      }}
                    >
                      {showHidden
                        ? [...shown.filtered, ...shown.hidden].map((edge) => (
                            <polyline key={edge.id} className={`vt-graph-edge is-out${shown.hidden.includes(edge) ? ' is-hidden' : ''}`} points={points(edge.points)} strokeWidth={Math.max(edge.width * 0.5, 1.5 * unit)} />
                          ))
                        : null}
                      {shown.edges.map((edge) => (
                        <g key={edge.id}>
                          <polyline
                            className={`vt-graph-edge${selected.has(edge.id) ? ' is-selected' : ''}`}
                            points={points(edge.points)}
                            stroke={widthColour(edge.width)}
                            strokeWidth={Math.max(edge.width * 0.6, 1.5 * unit)}
                          />
                          <polyline
                            className="vt-graph-edge-hit"
                            points={points(edge.points)}
                            strokeWidth={Math.max(edge.width, 10 * unit)}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              const next = event.shiftKey ? (selected.has(edge.id) ? data.selected.filter((id) => id !== edge.id) : [...data.selected, edge.id]) : [edge.id];
                              patch({ selected: next });
                            }}
                          >
                            <title>{`${edge.id}: ${edge.width.toFixed(1)} px wide, ${Math.round(edge.length)} px long, ${Math.round(edge.confidence * 100)}% sure`}</title>
                          </polyline>
                        </g>
                      ))}
                      {shown.nodes.map((graphNode) => (
                        <circle key={graphNode.id} className="vt-graph-node" cx={graphNode.x} cy={graphNode.y} r={4 * unit} strokeWidth={1.5 * unit} onPointerDown={(event) => dragNode(event, graphNode.id)} />
                      ))}
                    </svg>
                  </div>
                ) : (
                  <div className="vt-empty">{blocked ?? 'Reading the lines…'}</div>
                )}
              </div>
            );
          }}
        </Stage>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          Lines are coloured by width: red thin, blue wide. Grey dashed lines are out of the width range; red dashed ones were taken out.
        </p>
      </div>
    </EditorShell>
  );
}
