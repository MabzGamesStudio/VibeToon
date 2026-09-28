import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RESIZE_METHODS,
  RESIZE_METHOD_LABEL,
  emptyResizeFlowData,
  inputsForPort,
  resizeBitmap,
  summariseResize,
  targetSize,
  type Bitmap,
  type FlowNode,
  type Project,
  type ResizeFlowData,
  type ResizeMethod,
  type ResizeOptions,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/** Put pixels on a canvas, sized to them. */
function paint(canvas: HTMLCanvasElement | null, bitmap: Bitmap | null): void {
  if (!canvas || !bitmap) return;
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height), 0, 0);
}

/**
 * Resizing a picture.
 *
 * The result is worked out here as the settings change, and shown at the size
 * it comes out, so what Generate writes is what you are looking at.
 */
export function ResizeFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'resize' ? (node.data as ResizeFlowData) : emptyResizeFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<ResizeFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const setOptions = (over: Partial<ResizeOptions>) => patch({ options: { ...data.options, ...over } });

  const input = inputsForPort(project, node.id, 'image')[0];
  const artifact = input?.artifact;
  const path = artifact ? (artifact.entries?.[0] ? `${artifact.path}/${artifact.entries[0]}` : artifact.path) : '';

  const [source, setSource] = useState<Bitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    setError(null);
    if (!path) return undefined;
    let cancelled = false;
    readBitmap(api.artifactUrl(project.id, path), { maxPixels: 40_000_000 })
      .then((read) => {
        if (cancelled) return;
        setSource(read);
        const was = dataRef.current.source;
        if (!was || was.width !== read.width || was.height !== read.height || was.hash !== artifact?.hash) {
          patch({ source: { width: read.width, height: read.height, ...(artifact?.hash ? { hash: artifact.hash } : {}) } });
        }
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the file: re-reading it on every setting would be slow for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, project.id, artifact?.hash]);

  const size = source ? targetSize(source, data.options) : null;

  // Worked out a moment after the settings stop moving, so dragging the slider
  // over a big picture does not resize it at every step.
  const [result, setResult] = useState<{ bitmap: Bitmap; ms: number } | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (!source || !size) {
      setResult(null);
      return undefined;
    }
    setWorking(true);
    const timer = window.setTimeout(() => {
      const started = performance.now();
      const bitmap = resizeBitmap(source, size.width, size.height, data.options.method);
      setResult({ bitmap, ms: performance.now() - started });
      setWorking(false);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [source, size?.width, size?.height, data.options.method]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showing, setShowing] = useState<'after' | 'before'>('after');
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => paint(canvas.current, showing === 'after' ? (result?.bitmap ?? null) : source), [result, source, showing]);

  const onGenerate = async () => {
    if (!result) {
      await generateFlow(node.id);
      return;
    }
    try {
      await generateFlow(node.id, [{ name: 'resized.png', data: await pngDataUrl(result.bitmap) }]);
    } catch (reason) {
      notify('error', `Could not write the picture: ${(reason as Error).message}`);
    }
  };

  const blocked = !input
    ? 'Wire an image into the Image input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not produced an image yet.`
      : error
        ? `The picture could not be read: ${error}.`
        : null;

  const shown = showing === 'after' ? (result?.bitmap ?? null) : source;
  // Each is drawn at its size against the larger of the two, so enlarging
  // looks bigger and shrinking looks smaller.
  const widest = Math.max(source?.width ?? 1, result?.bitmap.width ?? 1);
  const share = shown ? shown.width / widest : 1;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Size</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Resize by">
            {(
              [
                ['scale', 'By a factor'],
                ['size', 'To a size'],
              ] as const
            ).map(([mode, label]) => (
              <button key={mode} type="button" className={`vt-chip${data.options.mode === mode ? ' is-on' : ''}`} aria-pressed={data.options.mode === mode} onClick={() => setOptions({ mode })}>
                {label}
              </button>
            ))}
          </div>
          {data.options.mode === 'scale' ? (
            <>
              <Slider
                range="resize.scale"
                label="Scale"
                tip="resize.scale"
                value={data.options.scale}
                format={(value) => `×${value.toFixed(2)}`}
                onChange={(scale) => setOptions({ scale: Math.round(scale * 100) / 100 })}
              />
              <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {[0.25, 0.5, 2, 3, 4].map((scale) => (
                  <button key={scale} type="button" className={`vt-chip${data.options.scale === scale ? ' is-on' : ''}`} onClick={() => setOptions({ scale })}>
                    ×{scale}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="vt-row" style={{ gap: 6 }}>
                <label className="vt-field" style={{ flex: 1 }}>
                  <span className="vt-label">Width</span>
                  <input
                    type="number"
                    min={1}
                    value={data.options.width}
                    aria-label="Width in pixels"
                    onChange={(event) => setOptions({ width: Math.max(1, Math.round(Number(event.target.value) || 1)) })}
                  />
                </label>
                <label className="vt-field" style={{ flex: 1 }}>
                  <span className="vt-label">Height</span>
                  <input
                    type="number"
                    min={1}
                    disabled={data.options.keepAspect}
                    value={data.options.keepAspect && size ? size.height : data.options.height}
                    aria-label="Height in pixels"
                    onChange={(event) => setOptions({ height: Math.max(1, Math.round(Number(event.target.value) || 1)) })}
                  />
                </label>
              </div>
              <label className="vt-row" style={{ gap: 6 }}>
                <input type="checkbox" checked={data.options.keepAspect} onChange={(event) => setOptions({ keepAspect: event.target.checked, ...(size ? { height: size.height } : {}) })} />
                Keep its shape (the height follows the width)
              </label>
            </>
          )}
        </div>

        <div className="vt-section">
          <h3>Resampling</h3>
          <Field label="Method" tip="resize.method">
            <select value={data.options.method} aria-label="Resampling method" onChange={(event) => setOptions({ method: event.target.value as ResizeMethod })}>
              {RESIZE_METHODS.map((method) => (
                <option key={method} value={method}>
                  {RESIZE_METHOD_LABEL[method]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="vt-section">
          <h3>What comes out</h3>
          <dl className="vt-kv">
            <dt>From</dt>
            <dd>{source ? `${source.width} × ${source.height}` : '—'}</dd>
            <dt>To</dt>
            <dd>{size ? `${size.width} × ${size.height}` : '—'}</dd>
            <dt>Worked out in</dt>
            <dd>{working ? 'working…' : result ? `${Math.round(result.ms)} ms` : '—'}</dd>
          </dl>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            {summariseResize(source ?? data.source, data.options)}
          </p>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={showing === 'after' ? 'Resized' : 'The original'}
          tools={
            <div className="vt-facet-values" role="radiogroup" aria-label="Show">
              {(
                [
                  ['after', 'Resized'],
                  ['before', 'Original'],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" className={`vt-chip${showing === value ? ' is-on' : ''}`} aria-pressed={showing === value} onClick={() => setShowing(value)}>
                  {label}
                </button>
              ))}
            </div>
          }
        >
          <div className="vt-resize-stage">
            {shown ? (
              <canvas
                ref={canvas}
                className="vt-resize-canvas"
                style={{
                  width: `${Math.round(share * 1000) / 10}%`,
                  imageRendering: 'pixelated',
                }}
              />
            ) : (
              <div className="vt-empty">{blocked ?? 'Reading the picture…'}</div>
            )}
          </div>
        </Stage>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          Shown at the size it comes out beside the original: the larger of the two fills the stage. Zoom in to compare pixels.
        </p>
      </div>
    </EditorShell>
  );
}
