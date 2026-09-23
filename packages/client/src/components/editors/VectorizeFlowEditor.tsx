import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  emptyVectorizeFlowData,
  inputsForPort,
  newId,
  shapePath,
  summariseVector,
  summariseVectorize,
  vectorize,
  vectorizeState,
  type Bitmap,
  type FlowNode,
  type Project,
  type VectorImage,
  type VectorizeFlowData,
  type VectorizeReport,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/**
 * A picture, turned back into shapes.
 *
 * Decomposing happens here for the same reason the palette flow counts pixels
 * here: the browser is what decodes a PNG. It is the expensive thing in this
 * editor — every pixel, twice — so it runs when asked rather than on every
 * keystroke, and what is kept afterwards is the answer rather than the picture.
 */
export function VectorizeFlowEditor({
  project,
  node,
}: {
  project: Project;
  node: FlowNode;
}): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'vectorize' ? (node.data as VectorizeFlowData) : emptyVectorizeFlowData();

  const imageInput = inputsForPort(project, node.id, 'image')[0];
  const artifact = imageInput?.artifact;
  const imagePath = useMemo(() => {
    if (!artifact) return '';
    const entry = artifact.entries?.[0];
    return entry ? `${artifact.path}/${entry}` : artifact.path;
  }, [artifact]);

  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<VectorizeReport | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const patch = useCallback(
    (over: Partial<VectorizeFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  const state = vectorizeState(data, artifact?.hash);
  const result: VectorImage | null = data.result;
  const summary = useMemo(() => (result ? summariseVector(result) : null), [result]);
  const report = fresh ?? data.report ?? null;

  /** Read the picture and decompose it. */
  const decompose = useCallback(async () => {
    if (!imagePath) return;
    setBusy(true);
    try {
      // Byte for byte (`pixels.ts`), so a picture already snapped to a palette
      // decomposes into exactly those colors. Every pixel is visited several times;
      // past a few megapixels this stops being a pause and starts being a hang, so
      // a bigger picture is refused before it is decoded.
      const bitmap: Bitmap = await readBitmap(api.artifactUrl(project.id, imagePath), { maxPixels: 4_000_000 });

      const run = vectorize(bitmap, data.options, newId);
      setFresh(run.report);
      patch({
        result: run.image,
        report: run.report,
        imageHash: artifact?.hash,
        readAt: new Date().toISOString(),
      });
      notify('success', summariseVectorize(run.report));
    } catch (error) {
      notify('error', `Could not decompose that image: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [artifact?.hash, data.options, imagePath, notify, patch, project.id]);

  const blocked = !imageInput
    ? 'Wire an image into the Image input first.'
    : !artifact
      ? `Press Generate on ${imageInput.sourceNode.name} first — it has not produced an image yet.`
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
            <span>{blocked} This flow turns a picture into shapes; it does not make one.</span>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>
              The image has changed since it was decomposed, so the shapes below describe the old one.
              Decompose it again.
            </span>
          </div>
        ) : state === 'none' ? (
          <div className="vt-sync-banner">
            <span>Nothing decomposed yet. Press “Decompose”.</span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Decompose</h3>
          <button
            type="button"
            className="vt-btn is-primary"
            disabled={busy || !artifact}
            onClick={() => void decompose()}
          >
            {busy ? 'Working…' : result ? 'Decompose again' : 'Decompose'}
          </button>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            Reads every pixel, so it runs when asked rather than as you turn the settings.
          </p>
        </div>

        <div className="vt-section">
          <h3>What counts as a line</h3>
          <Slider
            label="Widest a stroke may be"
            value={data.options.lineWidth}
            min={1}
            max={24}
            step={0.5}
            tip="vectorize.lineWidth"
            format={(value) => `${value}px`}
            hint="Below this a thin shape is a drawn mark; above it, a long thin area."
            onChange={(lineWidth) => patch({ options: { ...data.options, lineWidth } })}
          />
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            A stroke is thin <em>and</em> has different things either side of it. Two blocks meeting
            is not a line; a stroke between them is.
          </p>
        </div>

        <div className="vt-section">
          <h3>Where the edges are</h3>
          <Slider
            label="Contrast that counts"
            value={data.options.edgeThreshold}
            min={2}
            max={40}
            step={0.5}
            tip="vectorize.edgeThreshold"
            hint="Turn it down to find fainter boundaries, up to ignore shading."
            onChange={(edgeThreshold) => patch({ options: { ...data.options, edgeThreshold } })}
          />
          <Slider
            label="…and to keep one going"
            value={data.options.edgeFloor}
            min={0}
            max={20}
            step={0.5}
            tip="vectorize.edgeFloor"
            hint="A weaker boundary is kept only where it joins a stronger one."
            onChange={(edgeFloor) => patch({ options: { ...data.options, edgeFloor } })}
          />
          <Slider
            label="Drop regions under"
            value={data.options.minArea}
            min={0}
            max={200}
            step={4}
            tip="vectorize.minArea"
            format={(value) => (value === 0 ? 'keep all' : `${value}px`)}
            onChange={(minArea) => patch({ options: { ...data.options, minArea } })}
          />
        </div>

        <div className="vt-section">
          <h3>Where to spend the effort</h3>
          <Slider
            label="Rounds of refinement"
            value={data.options.refineRounds}
            min={0}
            max={4}
            step={1}
            tip="vectorize.refineRounds"
            format={(value) => (value === 0 ? 'none — one pass' : `${value} round${value === 1 ? '' : 's'}`)}
            hint="Each round draws the result, measures it against the picture, and tightens only the boundaries running through the worst parts."
            onChange={(refineRounds) => patch({ options: { ...data.options, refineRounds } })}
          />
          {data.options.refineRounds > 0 ? (
            <>
              <Slider
                label="Measured over blocks of"
                value={data.options.hotspotBlock}
                min={4}
                max={64}
                step={4}
                tip="vectorize.hotspotBlock"
                format={(value) => `${value} × ${value} px`}
                hint="How big a mistake has to be to count as one."
                onChange={(hotspotBlock) => patch({ options: { ...data.options, hotspotBlock } })}
              />
              <Slider
                label="Worst blocks to work on"
                value={data.options.hotspotShare}
                min={0.05}
                max={1}
                step={0.05}
                tip="vectorize.hotspotShare"
                format={(value) => `${(value * 100).toFixed(0)}% of them`}
                onChange={(hotspotShare) => patch({ options: { ...data.options, hotspotShare } })}
              />
            </>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>How many points</h3>
          <Slider
            label="Simplify to within"
            value={data.options.detail}
            min={0}
            max={6}
            step={0.1}
            tip="vectorize.detail"
            format={(value) => (value === 0 ? 'every point' : `${value.toFixed(1)}px`)}
            hint="The main control over how heavy the result is. Turn it up for fewer points."
            onChange={(detail) => patch({ options: { ...data.options, detail } })}
          />
          <Slider
            label="At most, per shape"
            value={data.options.maxPoints}
            min={0}
            max={80}
            step={1}
            tip="vectorize.maxPoints"
            format={(value) => (value === 0 ? 'no limit' : `${value} points`)}
            hint="A shape over budget is simplified harder until it fits."
            onChange={(maxPoints) => patch({ options: { ...data.options, maxPoints } })}
          />
          <Slider
            label="Curved if bent by"
            value={data.options.curveThreshold}
            min={0}
            max={0.3}
            step={0.01}
            tip="vectorize.curveThreshold"
            format={(value) => `${(value * 100).toFixed(0)}% of its length`}
            onChange={(curveThreshold) => patch({ options: { ...data.options, curveThreshold } })}
          />
        </div>

        <div className="vt-section">
          <h3>What belongs together</h3>
          <Field label="Join" tip="vectorize.joinShapes">
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={data.options.joinShapes}
                onChange={(event) => patch({ options: { ...data.options, joinShapes: event.target.checked } })}
              />
              Join shapes of the same color that touch
            </label>
          </Field>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
            {data.options.joinShapes
              ? 'Polygons that share a side become one polygon, and lines whose ends meet become one line. A shape with a hole stays two, because a polygon cannot have one.'
              : 'Every area comes back as the convex pieces it was cut into, for anything that needs every polygon convex.'}
          </p>
          {data.options.joinShapes ? (
            <Slider
              label="Join line ends within"
              value={data.options.joinGap}
              min={0}
              max={12}
              step={0.5}
              tip="vectorize.joinGap"
              format={(value) => (value === 0 ? 'only where they touch' : `${value.toFixed(1)}px`)}
              onChange={(joinGap) => patch({ options: { ...data.options, joinGap } })}
            />
          ) : null}
        </div>

        {summary ? (
          <div className="vt-section">
            <h3>What was found</h3>
            <dl className="vt-kv">
              <dt>Shapes</dt>
              <dd>{summary.shapes}</dd>
              <dt>Polygons</dt>
              <dd>{summary.polygons}</dd>
              <dt>Lines</dt>
              <dd>
                {summary.lines} ({summary.straightLines} straight, {summary.curvedLines} curved)
              </dd>
              <dt>Points</dt>
              <dd>{summary.points.toLocaleString()}</dd>
              <dt>Colors</dt>
              <dd>{summary.colors.length}</dd>
              {report ? (
                <>
                  {report.joinedPolygons > 0 || report.joinedLines > 0 ? (
                    <>
                      <dt>Joined</dt>
                      <dd>
                        {report.joinedPolygons} polygon join(s), {report.joinedLines} line join(s)
                      </dd>
                    </>
                  ) : null}
                  <dt>Pixels wrong</dt>
                  <dd>
                    {Math.round(report.wrongPixels).toLocaleString()}
                    {report.drawnPixels > 0
                      ? ` · ${((report.wrongPixels / report.drawnPixels) * 100).toFixed(1)}% of what it drew`
                      : ''}
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="vt-filter-colors" style={{ marginTop: 6 }}>
              {summary.colors.map((color) => (
                <span
                  key={color}
                  className="vt-filter-color is-on"
                  style={{ '--vt-swatch': color, cursor: 'default' } as CSSProperties}
                  title={`${color} — ${result!.shapes.filter((shape) => shape.color === color).length} shape(s)`}
                >
                  <span>{color.slice(1)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The shapes"
          tools={
            <>
              <span className="vt-faint" style={{ fontSize: 11 }}>
                {result ? `${result.width} × ${result.height} · ${summary?.shapes ?? 0} shapes` : 'nothing yet'}
              </span>
              {artifact ? (
                <button
                  type="button"
                  className={`vt-btn is-small${showSource ? ' is-active' : ''}`}
                  title="Show the picture it came from behind the shapes"
                  onClick={() => setShowSource(!showSource)}
                >
                  Source
                </button>
              ) : null}
            </>
          }
        >
          <div className="vt-vector-stage">
            {result && result.shapes.length > 0 ? (
              <div
                className="vt-vector-frame"
                style={{ aspectRatio: `${result.width} / ${result.height}` }}
              >
                {showSource && imagePath ? (
                  <img className="vt-vector-source" src={api.artifactUrl(project.id, imagePath)} alt="" />
                ) : null}
                <svg
                  ref={svg}
                  className="vt-vector-svg"
                  viewBox={`0 0 ${result.width} ${result.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {result.shapes
                    .filter((shape) => shape.kind === 'polygon')
                    .map((shape) => (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill={shape.color}
                        // The areas tile the picture exactly, but a renderer
                        // antialiases each on its own — so without a hairline of
                        // its own color, every boundary shows the background
                        // through it.
                        stroke={shape.color}
                        strokeWidth={0.5}
                        className={`vt-vector-shape${hover === shape.id ? ' is-hover' : ''}`}
                        onMouseEnter={() => setHover(shape.id)}
                        onMouseLeave={() => setHover(null)}
                      />
                    ))}
                  {result.shapes
                    .filter((shape): shape is Extract<typeof shape, { kind: 'line' }> => shape.kind === 'line')
                    .map((shape) => (
                      <path
                        key={shape.id}
                        d={shapePath(shape)}
                        fill="none"
                        stroke={shape.color}
                        strokeWidth={shape.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`vt-vector-shape${hover === shape.id ? ' is-hover' : ''}`}
                        onMouseEnter={() => setHover(shape.id)}
                        onMouseLeave={() => setHover(null)}
                      />
                    ))}
                </svg>
              </div>
            ) : (
              <div className="vt-empty">
                {busy ? 'Decomposing…' : (blocked ?? 'Nothing decomposed yet.')}
              </div>
            )}
          </div>
        </Stage>

        {report ? (
          <>
            <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
              {summariseVectorize(report)}
              {report.thinButNotSeparating > 0
                ? ` · ${report.thinButNotSeparating} thin shape(s) kept as areas because they border only one thing`
                : ''}
            </p>
            {report.problems.length > 0 ? (
              <div className="vt-section">
                <h3>Worth looking at</h3>
                <ul className="vt-hints">
                  {report.problems.slice(0, 20).map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </EditorShell>
  );
}
