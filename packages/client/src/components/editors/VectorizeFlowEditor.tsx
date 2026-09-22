import { useCallback, useMemo, useRef, useState } from 'react';
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
      const element = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('the browser could not decode this image'));
        image.src = api.artifactUrl(project.id, imagePath);
      });

      const width = element.naturalWidth;
      const height = element.naturalHeight;
      if (width === 0 || height === 0) throw new Error('the image has no size');
      if (width * height > 4_000_000) {
        // Every pixel is visited several times; past a few megapixels this stops
        // being a pause and starts being a hang.
        throw new Error(
          `${(width * height / 1_000_000).toFixed(1)}M pixels is more than this can decompose. Scale the picture down first.`,
        );
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('this browser would not give a canvas to read the image with');
      context.drawImage(element, 0, 0);
      const bitmap: Bitmap = {
        width,
        height,
        data: context.getImageData(0, 0, width, height).data,
      };

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
          <h3>Grouping</h3>
          <Slider
            label="Same-color tolerance"
            value={data.options.tolerance}
            min={0}
            max={40}
            step={0.5}
            tip="vectorize.tolerance"
            onChange={(tolerance) => patch({ options: { ...data.options, tolerance } })}
          />
          <Slider
            label="Color precision"
            value={data.options.precision}
            min={2}
            max={8}
            step={1}
            tip="palette.precision"
            format={(value) => `${value} bits · ${2 ** value} levels`}
            onChange={(precision) => patch({ options: { ...data.options, precision } })}
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
          <h3>How shapes are fitted</h3>
          <Field label="Method" tip="vectorize.fit">
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={data.options.fitToPixels}
                onChange={(event) =>
                  patch({ options: { ...data.options, fitToPixels: event.target.checked } })
                }
              />
              Measure against the pixels
            </label>
          </Field>
          {data.options.fitToPixels ? (
            <>
              <Slider
                label="What an anchor is worth"
                value={data.options.pointCost}
                min={0}
                max={40}
                step={1}
                tip="vectorize.pointCost"
                format={(value) => (value === 0 ? 'nothing — trace exactly' : `${value} pixels`)}
                hint="An anchor earns its place by covering this many pixels no cheaper shape would."
                onChange={(pointCost) => patch({ options: { ...data.options, pointCost } })}
              />
              <Slider
                label="What a polygon is worth"
                value={data.options.polygonCost}
                min={0}
                max={200}
                step={5}
                tip="vectorize.polygonCost"
                format={(value) => `${value} pixels`}
                onChange={(polygonCost) => patch({ options: { ...data.options, polygonCost } })}
              />
            </>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>Shape</h3>
          {data.options.fitToPixels ? (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
              Anchors are chosen by what they cover, so there is no tolerance to set. The
              two costs above decide how many there are.
            </p>
          ) : null}
          <Slider
            label="Simplify to within"
            value={data.options.simplify}
            min={0}
            max={6}
            step={0.1}
            tip="vectorize.simplify"
            format={(value) => (value === 0 ? 'every point' : `${value.toFixed(1)}px`)}
            hint={data.options.fitToPixels ? 'Only used with the fit switched off.' : undefined}
            onChange={(simplify) => patch({ options: { ...data.options, simplify } })}
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
                  style={{ background: color, cursor: 'default' }}
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
