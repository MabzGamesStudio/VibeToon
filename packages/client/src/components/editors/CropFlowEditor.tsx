import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CROP_HANDLES,
  CROP_MODES,
  CROP_MODE_LABEL,
  clampRect,
  cropBitmap,
  cropBoxFile,
  cropRectFor,
  dragHandle,
  emptyCropFlowData,
  hasTransparency,
  inputsForPort,
  moveRect,
  normaliseRect,
  opaqueBounds,
  summariseCrop,
  type Bitmap,
  type CropFlowData,
  type CropHandle,
  type CropRect,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/** Put pixels on a canvas, sized to them. */
export function paintBitmap(canvas: HTMLCanvasElement | null, bitmap: Bitmap | null): void {
  if (!canvas || !bitmap) return;
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height), 0, 0);
}

/** A point on an SVG, in its own units, from a pointer event: right at any zoom. */
export function svgPoint(svg: SVGSVGElement, event: { clientX: number; clientY: number }): { x: number; y: number } {
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

/**
 * How many screen pixels one unit of an SVG is drawn at, before any zoom round
 * it. The picture is fitted inside the element, so the tighter side decides.
 */
export function useFitScale(element: Element | null, width: number, height = 0): number {
  const [fit, setFit] = useState(1);
  useEffect(() => {
    if (!element || width <= 0) return undefined;
    const measure = () => {
      const box = element as HTMLElement;
      const across = box.clientWidth / width;
      setFit(Math.max(1e-3, height > 0 && box.clientHeight > 0 ? Math.min(across, box.clientHeight / height) : across));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, width, height]);
  return fit;
}

const HANDLE_AT: Record<CropHandle, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

const HANDLE_CURSOR: Record<CropHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

type Held = { kind: 'handle'; handle: CropHandle; from: CropRect } | { kind: 'move'; from: CropRect; start: { x: number; y: number } } | { kind: 'draw'; start: { x: number; y: number } };

/**
 * Cropping a picture: a box drawn by hand, or the smallest box round its solid
 * pixels. The box is shown on the picture, and the result beside it.
 */
export function CropFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify } = useStudio();
  const data = node.data.editor === 'crop' ? (node.data as CropFlowData) : emptyCropFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<CropFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);

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

  // While a box is being dragged, it is shown here and saved once on release.
  const [live, setLive] = useState<CropRect | null>(null);
  const shownData = live && data.mode === 'manual' ? { ...data, rect: live } : data;
  const rect = source ? cropRectFor(shownData, source) : null;
  const transparent = source ? hasTransparency(source) : false;
  const solid = source && data.mode === 'opaque' ? opaqueBounds(source, data.threshold) : null;

  const [result, setResult] = useState<Bitmap | null>(null);
  const rectKey = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '';
  useEffect(() => {
    if (!source || !rect) {
      setResult(null);
      return undefined;
    }
    const timer = window.setTimeout(() => setResult(cropBitmap(source, rect)), 60);
    return () => window.clearTimeout(timer);
  }, [source, rectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showing, setShowing] = useState<'box' | 'result'>('box');
  const picture = useRef<HTMLCanvasElement | null>(null);
  const cropped = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => paintBitmap(picture.current, source), [source, showing]);
  useEffect(() => paintBitmap(cropped.current, result), [result, showing]);

  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const fit = useFitScale(svg, source?.width ?? 0, source?.height ?? 0);

  const held = useRef<Held | null>(null);
  const begin = (event: React.PointerEvent, what: Held) => {
    if (!svg || !source || data.mode !== 'manual') return;
    event.preventDefault();
    event.stopPropagation();
    held.current = what;
    let last: CropRect | null = null;
    const move = (moveEvent: PointerEvent) => {
      const now = held.current;
      if (!now) return;
      const at = svgPoint(svg, moveEvent);
      if (now.kind === 'handle') last = dragHandle(now.from, now.handle, at, source);
      else if (now.kind === 'move') last = moveRect(now.from, { x: Math.round(at.x - now.start.x), y: Math.round(at.y - now.start.y) }, source);
      else last = clampRect(normaliseRect({ x: now.start.x, y: now.start.y, width: at.x - now.start.x, height: at.y - now.start.y }), source);
      setLive(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      held.current = null;
      setLive(null);
      if (last) patch({ rect: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onGenerate = async () => {
    if (!result || !rect || !source) {
      await generateFlow(node.id);
      return;
    }
    try {
      await generateFlow(node.id, [
        { name: 'cropped.png', data: await pngDataUrl(result) },
        { name: 'crop.json', data: `data:application/json;base64,${btoa(cropBoxFile(source, rect, data.mode))}` },
      ]);
    } catch (reason) {
      notify('error', `Could not write the crop: ${(reason as Error).message}`);
    }
  };

  const blocked = !input
    ? 'Wire an image into the Image input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not produced an image yet.`
      : error
        ? `The picture could not be read: ${error}.`
        : null;

  const setRectField = (key: keyof CropRect, value: number) => {
    if (!source) return;
    const base = data.rect ?? { x: 0, y: 0, width: source.width, height: source.height };
    patch({ rect: clampRect({ ...base, [key]: Math.round(value) }, source) });
  };

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Crop</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Crop by">
            {CROP_MODES.map((mode) => (
              <button key={mode} type="button" className={`vt-chip${data.mode === mode ? ' is-on' : ''}`} aria-pressed={data.mode === mode} onClick={() => patch({ mode })}>
                {CROP_MODE_LABEL[mode]}
              </button>
            ))}
          </div>

          {data.mode === 'opaque' ? (
            <>
              {source && !transparent ? (
                <p className="vt-hint">This picture has no transparency, so the solid box is all of it. Draw a box by hand instead.</p>
              ) : null}
              <Slider
                range="crop.threshold"
                label="Solid above"
                tip="crop.threshold"
                value={data.threshold}
                format={(value) => `alpha ${Math.round(value)}`}
                onChange={(threshold) => patch({ threshold: Math.round(threshold) })}
              />
              <Slider
                range="crop.padding"
                label="Margin"
                tip="crop.padding"
                value={data.padding}
                format={(value) => `${Math.round(value)} px`}
                onChange={(padding) => patch({ padding: Math.round(padding) })}
              />
              {solid ? (
                <button
                  type="button"
                  className="vt-btn is-small"
                  title="Switch to drawing by hand, starting from this box"
                  onClick={() => patch({ mode: 'manual', rect: clampRect(rect ?? solid, source!) })}
                >
                  Adjust this box by hand
                </button>
              ) : null}
            </>
          ) : (
            <>
              <p className="vt-hint">Drag on the picture to draw a box; drag the box or its handles to change it, or hold Shift to draw a new one over it.</p>
              <div className="vt-crop-fields">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <label key={key} className="vt-field">
                    <span className="vt-label">{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'width' ? 'Width' : 'Height'}</span>
                    <input
                      type="number"
                      min={key === 'width' || key === 'height' ? 1 : 0}
                      value={rect ? rect[key] : 0}
                      disabled={!source}
                      aria-label={`Box ${key}`}
                      onChange={(event) => setRectField(key, Number(event.target.value) || 0)}
                    />
                  </label>
                ))}
              </div>
              <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <button type="button" className="vt-btn is-small" disabled={!source} onClick={() => patch({ rect: null })}>
                  Whole picture
                </button>
                <button
                  type="button"
                  className="vt-btn is-small"
                  disabled={!source || !transparent}
                  title="The smallest box round the solid pixels"
                  onClick={() => {
                    const box = source ? opaqueBounds(source, data.threshold) : null;
                    if (box && source) patch({ rect: clampRect(box, source) });
                  }}
                >
                  Fit to the solid pixels
                </button>
              </div>
            </>
          )}
          <label className="vt-row" style={{ gap: 6, marginTop: 8 }}>
            <input type="checkbox" checked={data.square} onChange={(event) => patch({ square: event.target.checked })} />
            Keep it square
          </label>
        </div>

        <div className="vt-section">
          <h3>What comes out</h3>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            {summariseCrop(source ?? data.source, rect, data.mode)}
          </p>
          {rect && source && (rect.x < 0 || rect.y < 0 || rect.x + rect.width > source.width || rect.y + rect.height > source.height) ? (
            <p className="vt-hint">The box reaches past the picture’s edge; what is outside it comes out clear.</p>
          ) : null}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={showing === 'box' ? 'The picture, and the box' : 'Cropped'}
          tools={
            <div className="vt-facet-values" role="radiogroup" aria-label="Show">
              {(
                [
                  ['box', 'Picture'],
                  ['result', 'Cropped'],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" className={`vt-chip${showing === value ? ' is-on' : ''}`} aria-pressed={showing === value} onClick={() => setShowing(value)}>
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {({ scale }) => {
            const unit = 1 / Math.max(1e-3, fit * scale);
            return (
              <div className="vt-resize-stage">
                {!source ? (
                  <div className="vt-empty">{blocked ?? 'Reading the picture…'}</div>
                ) : showing === 'result' ? (
                  <canvas ref={cropped} className="vt-resize-canvas" style={{ imageRendering: 'pixelated' }} />
                ) : (
                  <div className="vt-crop-frame">
                    <canvas ref={picture} className="vt-crop-canvas" style={{ imageRendering: 'pixelated' }} />
                    <svg
                      ref={setSvg}
                      className={`vt-crop-overlay${data.mode === 'manual' ? ' is-manual' : ''}`}
                      viewBox={`0 0 ${source.width} ${source.height}`}
                      onPointerDown={(event) => {
                        if (data.mode !== 'manual' || !svg) return;
                        const at = svgPoint(svg, event);
                        begin(event, { kind: 'draw', start: { x: Math.round(at.x), y: Math.round(at.y) } });
                      }}
                    >
                      {rect ? (
                        <>
                          {/* Everything outside the box, dimmed. */}
                          <path
                            className="vt-crop-shade"
                            fillRule="evenodd"
                            d={`M${-source.width},${-source.height}h${source.width * 3}v${source.height * 3}h${-source.width * 3}Z M${rect.x},${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`}
                          />
                          <rect
                            className="vt-crop-box"
                            x={rect.x}
                            y={rect.y}
                            width={rect.width}
                            height={rect.height}
                            strokeWidth={1.5 * unit}
                            onPointerDown={(event) => {
                              if (!svg) return;
                              const at = svgPoint(svg, event);
                              // A box that is the whole picture cannot move, so dragging
                              // in it draws a new one, as Shift does anywhere.
                              const whole = rect.x <= 0 && rect.y <= 0 && rect.width >= source.width && rect.height >= source.height;
                              if (whole || event.shiftKey) begin(event, { kind: 'draw', start: { x: Math.round(at.x), y: Math.round(at.y) } });
                              else begin(event, { kind: 'move', from: rect, start: at });
                            }}
                          />
                          {data.mode === 'manual'
                            ? CROP_HANDLES.map((handle) => {
                                const [fx, fy] = HANDLE_AT[handle];
                                const size = 9 * unit;
                                return (
                                  <rect
                                    key={handle}
                                    className="vt-crop-handle"
                                    aria-label={`Handle ${handle}`}
                                    x={rect.x + rect.width * fx - size / 2}
                                    y={rect.y + rect.height * fy - size / 2}
                                    width={size}
                                    height={size}
                                    strokeWidth={unit}
                                    style={{ cursor: HANDLE_CURSOR[handle] }}
                                    onPointerDown={(event) => begin(event, { kind: 'handle', handle, from: rect })}
                                  />
                                );
                              })
                            : null}
                        </>
                      ) : null}
                    </svg>
                  </div>
                )}
              </div>
            );
          }}
        </Stage>
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {data.mode === 'opaque'
            ? 'The box is worked out from the picture’s solid pixels. Switch to By hand to draw your own.'
            : 'Drag on the picture to draw a box. Zoom in to place its edges to the pixel.'}
        </p>
      </div>
    </EditorShell>
  );
}
