import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyMask,
  buildMask,
  deleteSelected,
  emptyCutoutFlowData,
  inputsForPort,
  labelOf,
  linePoints,
  regionOutline,
  unflatten,
  maskBounds,
  newId,
  objectsOf,
  selectObject,
  setLine,
  setRegion,
  setSeed,
  takeSeq,
  summariseCutout,
  type Bitmap,
  type CutLine,
  type CutoutFlowData,
  type FlowNode,
  type MaskReport,
  type Project,
  type Region,
  type Seed,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Field } from '../common/Field';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

/** What a click does. */
type Tool = 'fill' | 'cut' | 'region';

/**
 * Hand pixels to a canvas.
 *
 * `ImageData` insists on an array backed by a plain `ArrayBuffer`, while the
 * shared code returns an ordinary `Uint8ClampedArray` that could in principle be
 * backed by a shared one. Copying through the constructor settles it, and keeps
 * the platform's fussiness in one place instead of at all three call sites.
 */
function toImageData(pixels: Uint8ClampedArray, width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(pixels), width, height);
}

/**
 * Where the picture actually is inside an element that contains it.
 *
 * The canvas fills its frame and letterboxes itself with `object-fit: contain`,
 * so the element's box and the drawn picture are not the same rectangle. Clicking
 * has to be mapped through the letterbox or every seed lands in the wrong place —
 * and by a margin that changes with the window, which is the sort of bug that
 * looks like the fill algorithm misbehaving.
 */
function containedRect(
  box: DOMRect,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(box.width / width, box.height / height);
  const drawn = { width: width * scale, height: height * scale };
  return {
    x: box.x + (box.width - drawn.width) / 2,
    y: box.y + (box.height - drawn.height) / 2,
    ...drawn,
  };
}

/**
 * Cutting a subject out of an image.
 *
 * Left click floods a region in, right click takes one out, and a line cuts
 * across whatever the pixels think. What is stored is the list of those actions,
 * never the mask — so every one of them stays selectable and deletable, and
 * deleting the third of twenty does not mean starting again.
 *
 * The pixels live here rather than on the server for the same reason the palette
 * flow counts them here: the browser is what decodes a JPEG, and a canvas is what
 * composites a mask. What goes to the server is the finished PNG.
 */
export function CutoutFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify, busyFlows } = useStudio();
  const { view } = useView();
  const data = node.data.editor === 'cutout' ? (node.data as CutoutFlowData) : emptyCutoutFlowData();
  const busy = busyFlows.includes(node.id);

  const imageInput = inputsForPort(project, node.id, 'image')[0];
  const artifact = imageInput?.artifact;

  /** An `imageSet` port carries a folder; the first image in it is the one read. */
  const imagePath = useMemo(() => {
    if (!artifact) return '';
    const entry = artifact.entries?.[0];
    return entry ? `${artifact.path}/${entry}` : artifact.path;
  }, [artifact]);

  const [tool, setTool] = useState<Tool>('fill');
  const [bitmap, setBitmap] = useState<Bitmap | null>(null);
  /**
   * How many screen pixels one image pixel is drawn as when the picture fits the
   * stage — the layout's scale, before any zoom.
   *
   * The markers are drawn in the SVG's image-coordinate space, so without this a
   * seed on a 200px reference is a blob covering half the subject, and a seed on
   * a 4000px photograph is too small to find. Dividing by it gives every picture
   * the same size of marker at fit. Zooming the stage then scales them with the
   * picture, like everything else in it: a node is a place in the picture, and
   * zooming in on it should make it bigger, not leave it behind.
   *
   * Measured from the layout box (`offsetWidth`), not the one on screen, which
   * includes the zoom — reading that made the markers jump between sizes
   * whenever something happened to resize the stage mid-zoom.
   */
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState<number[]>([]);
  /** Whether the next region is smoothed. A shape's corners are a real choice. */
  const [regionCurved, setRegionCurved] = useState(true);
  const [loading, setLoading] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);

  const patch = useCallback(
    (over: Partial<CutoutFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  /* ---------------- reading the image ---------------- */

  useEffect(() => {
    if (!imagePath) {
      setBitmap(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Byte for byte, so what is cut out is the file's own pixels (`pixels.ts`).
    readBitmap(api.artifactUrl(project.id, imagePath))
      .then((read) => {
        if (cancelled) return;
        setBitmap(read);
        const { width, height } = read;
        if (data.imageWidth !== width || data.imageHeight !== height || data.imageHash !== artifact?.hash) {
          patch({ imageWidth: width, imageHeight: height, imageHash: artifact?.hash });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) notify('error', `Could not read that image: ${error.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the file rather than on `data`: re-reading the image
    // on every click would make the editor unusable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePath, project.id, artifact?.hash]);

  useEffect(() => {
    const surface = canvas.current;
    if (!surface || !bitmap) return undefined;
    const measure = () => {
      const width = surface.offsetWidth;
      const height = surface.offsetHeight;
      if (width === 0 || height === 0) return;
      setZoom(Math.min(width / bitmap.width, height / bitmap.height) || 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [bitmap]);

  /* ---------------- the mask ---------------- */

  const built = useMemo(() => {
    if (!bitmap) return null;
    if (data.seeds.length === 0 && data.lines.length === 0) return null;
    return buildMask(bitmap, data);
  }, [bitmap, data]);

  /** Draw the image with everything outside the mask dimmed rather than hidden. */
  useEffect(() => {
    const surface = canvas.current;
    if (!surface || !bitmap) return;
    surface.width = bitmap.width;
    surface.height = bitmap.height;
    const context = surface.getContext('2d');
    if (!context) return;

    if (!built) {
      context.putImageData(toImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
      return;
    }
    // Excluded pixels are dimmed, not cleared: you need to see what you are
    // about to click on, and a cut-away region you cannot see is a region you
    // cannot put back.
    const shown = new Uint8ClampedArray(bitmap.data.length);
    for (let index = 0; index < built.mask.alpha.length; index += 1) {
      const at = index * 4;
      const inside = built.mask.alpha[index]! / 255;
      const dim = 0.25 + 0.75 * inside;
      shown[at] = bitmap.data[at]! * dim;
      shown[at + 1] = bitmap.data[at + 1]! * dim;
      shown[at + 2] = bitmap.data[at + 2]! * dim + (1 - inside) * 40;
      shown[at + 3] = bitmap.data[at + 3]!;
    }
    context.putImageData(toImageData(shown, bitmap.width, bitmap.height), 0, 0);
  }, [bitmap, built]);

  /* ---------------- clicking ---------------- */

  /** Where in the image a pointer event landed, in image pixels. */
  const pointAt = (event: React.MouseEvent): { x: number; y: number } | null => {
    const surface = canvas.current;
    if (!surface || !bitmap) return null;
    const box = surface.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const drawn = containedRect(box, bitmap.width, bitmap.height);
    if (drawn.width === 0 || drawn.height === 0) return null;
    return {
      x: ((event.clientX - drawn.x) / drawn.width) * bitmap.width,
      y: ((event.clientY - drawn.y) / drawn.height) * bitmap.height,
    };
  };

  const addSeed = (point: { x: number; y: number }, mode: Seed['mode']) => {
    const { seq, data: bumped } = takeSeq(data);
    const seed: Seed = {
      id: newId('seed'),
      mode,
      x: Math.round(point.x),
      y: Math.round(point.y),
      tolerance: data.options.tolerance,
      seq,
    };
    patch({ ...bumped, seeds: [...data.seeds, seed], selected: [seed.id] });
  };

  const finishLine = (points: number[]) => {
    // Two points is a straight cut and more is a curve, which is why there is no
    // straight tool to choose first.
    if (points.length < 4) return;
    const line: CutLine = {
      id: newId('cut'),
      points,
      width: Math.max(1, Math.round(data.options.tolerance / 6)),
      mode: 'block',
    };
    patch({ lines: [...data.lines, line], selected: [line.id] });
  };

  const finishRegion = (points: number[], mode: Region['mode']) => {
    // Three points is the least that encloses anything.
    if (points.length < 6) return;
    const { seq, data: bumped } = takeSeq(data);
    const region: Region = {
      id: newId('region'),
      points,
      curved: regionCurved,
      mode,
      seq,
    };
    patch({
      ...bumped,
      regions: [...(data.regions ?? []), region],
      selected: [region.id],
    });
  };

  const onCanvasClick = (event: React.MouseEvent) => {
    const point = pointAt(event);
    if (!point) return;

    if (tool === 'fill') {
      addSeed(point, 'include');
      return;
    }
    // Built click by click, until you double-click, press Enter, or right-click.
    // Dragging would be smoother for one stroke and useless for aiming a cut.
    setDrawing([...drawing, Math.round(point.x), Math.round(point.y)]);
  };

  /** Finish whatever is being drawn. A region right-clicked closed drops its inside. */
  const finishDrawing = (points: number[], exclude = false) => {
    if (tool === 'region') finishRegion(points, exclude ? 'exclude' : 'include');
    else finishLine(points);
    setDrawing([]);
  };

  const onCanvasContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (tool !== 'fill') {
      // Right click finishes what is being drawn, which is what every other
      // polygon tool does. For a region it also says which way round it goes:
      // left-finish keeps the inside, right-finish drops it — the same left and
      // right as the fill tool, so there is one thing to remember rather than two.
      if (drawing.length > 0) finishDrawing(drawing, true);
      else setDrawing([]);
      return;
    }
    const point = pointAt(event);
    if (point) addSeed(point, 'exclude');
  };

  const onCanvasDoubleClick = (event: React.MouseEvent) => {
    if (tool === 'fill') return;
    event.preventDefault();
    if (drawing.length > 0) finishDrawing(drawing);
  };

  /* ---------------- keys ---------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!overlay.current) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (data.selected.length === 0) return;
        event.preventDefault();
        patch(deleteSelected(data));
      } else if (event.key === 'Enter' && drawing.length > 0) {
        event.preventDefault();
        finishDrawing(drawing);
      } else if (event.key === 'Escape' && drawing.length > 0) {
        event.preventDefault();
        setDrawing([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------------- generating ---------------- */

  /** Render the cutout and the mask, and send both with the run. */
  const onGenerate = async () => {
    if (!bitmap || !built) {
      notify('error', 'Nothing is selected yet — left-click the part of the image to keep.');
      return;
    }
    const box = maskBounds(built.mask);
    if (!box) {
      notify('error', 'The selection is empty, so there is nothing to write.');
      return;
    }

    // Encoded without a canvas, which would move the color of every feathered
    // edge pixel a step (see `pixels.ts`).
    const grey = new Uint8ClampedArray(bitmap.data.length);
    for (let index = 0; index < built.mask.alpha.length; index += 1) {
      const at = index * 4;
      const value = built.mask.alpha[index]!;
      grey[at] = grey[at + 1] = grey[at + 2] = value;
      grey[at + 3] = 255;
    }
    const [cut, mask] = await Promise.all([
      pngDataUrl({ width: bitmap.width, height: bitmap.height, data: applyMask(bitmap, built.mask) }),
      pngDataUrl({ width: bitmap.width, height: bitmap.height, data: grey }),
    ]);

    await generateFlow(node.id, [
      { name: 'cutout.png', data: cut },
      { name: 'mask.png', data: mask },
    ]);
  };

  /* ---------------- the object list ---------------- */

  const objects = objectsOf(data);
  const selected = objects.filter((object) => data.selected.includes(object.id));
  const one = selected.length === 1 ? selected[0]! : null;
  const report: MaskReport | null = built?.report ?? null;

  const blocked = !imageInput
    ? 'Wire an image into the Image input first.'
    : !artifact
      ? `Press Generate on ${imageInput.sourceNode.name} first — it has not produced an image yet.`
      : null;

  const scale = bitmap ? { width: bitmap.width, height: bitmap.height } : { width: 1, height: 1 };

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={
        blocked ? (
          <div className="vt-sync-banner">
            <span>{blocked} This flow cuts a subject out of a picture; it does not make one.</span>
          </div>
        ) : data.imageHash && artifact && data.imageHash !== artifact.hash ? (
          <div className="vt-sync-banner">
            <span>
              The image has changed since these selections were made, so they may no longer land where you
              meant. Check them before generating.
            </span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Tool</h3>
          <div className="vt-facet-values">
            {(
              [
                ['fill', 'Fill', 'Left click includes a region, right click excludes one.'],
                [
                  'cut',
                  'Cut',
                  'Click along the cut; two points is a straight one, more is a curve. Double-click or Enter to finish, Esc to abandon.',
                ],
                [
                  'region',
                  'Region',
                  'Draw round something. Finish with a double-click or Enter to keep the inside, or right-click to drop it.',
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                className={`vt-chip${tool === value ? ' is-on' : ''}`}
                title={hint}
                onClick={() => {
                  setTool(value);
                  setDrawing([]);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            {tool === 'fill'
              ? 'Left click to include a region, right click to exclude one.'
              : drawing.length === 0
                ? tool === 'cut'
                  ? 'Click along the cut. Two points is straight, more is a curve.'
                  : 'Click round the thing you want. The ends join up on their own.'
                : tool === 'cut'
                  ? `${drawing.length / 2} point(s) — double-click or Enter to finish, Esc to abandon.`
                  : `${drawing.length / 2} point(s) — finish to keep the inside, right-click to drop it, Esc to abandon.`}
          </p>
        </div>

        {tool === 'region' ? (
          <div className="vt-section">
            <h3>The next region</h3>
            <Field label="Shape" tip="cutout.region">
              <label className="vt-row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={regionCurved}
                  onChange={(event) => setRegionCurved(event.target.checked)}
                />
                Smooth through the points
              </label>
            </Field>
            <p className="vt-faint" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
              Off gives corners, for something with edges. Either can be changed after
              it is drawn.
            </p>
          </div>
        ) : null}

        <div className="vt-section">
          <h3>How far a fill spreads</h3>
          <Slider
            range="cutout.tolerance"
            label="Tolerance"
            value={data.options.tolerance}
            tip="cutout.tolerance"
            hint="Used by the next fill. Each one keeps its own afterwards."
            onChange={(tolerance) => patch({ options: { ...data.options, tolerance } })}
          />
          <Field label="Neighbours" tip="cutout.diagonal">
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={data.options.diagonal}
                onChange={(event) => patch({ options: { ...data.options, diagonal: event.target.checked } })}
              />
              Include diagonals
            </label>
          </Field>
        </div>

        <div className="vt-section">
          <h3>The edge</h3>
          <Slider
            range="cutout.grow"
            label="Grow"
            value={data.options.grow}
            tip="cutout.grow"
            format={(value) => `${value > 0 ? '+' : ''}${value}px`}
            hint="A fill stops just short of a photographed edge. Growing takes the halo back."
            onChange={(grow) => patch({ options: { ...data.options, grow } })}
          />
          <Slider
            range="cutout.feather"
            label="Feather"
            value={data.options.feather}
            tip="cutout.feather"
            format={(value) => (value === 0 ? 'hard' : `${value}px`)}
            onChange={(feather) => patch({ options: { ...data.options, feather } })}
          />
          <Slider
            range="cutout.minIsland"
            label="Drop islands under"
            value={data.options.minIsland}
            tip="cutout.minIsland"
            format={(value) => (value === 0 ? 'keep all' : `${value}px`)}
            onChange={(minIsland) => patch({ options: { ...data.options, minIsland } })}
          />
        </div>

        {one ? (
          <div className="vt-section">
            <h3>{labelOf(data, one)}</h3>
            {one.type === 'seed' ? (
              <>
                <Slider
                  range="cutout.seedTolerance"
                  label="Its own tolerance"
                  value={one.tolerance}
                  hint="The edge of a face and the edge of a sky need different answers."
                  onChange={(tolerance) => patch(setSeed(data, one.id, { tolerance }))}
                />
                <Field label="What it does">
                  <select
                    value={one.mode}
                    onChange={(event) =>
                      patch(setSeed(data, one.id, { mode: event.target.value as Seed['mode'] }))
                    }
                  >
                    <option value="include">Include this region</option>
                    <option value="exclude">Exclude this region</option>
                  </select>
                </Field>
                <p className="vt-faint" style={{ fontSize: 11 }}>
                  At {Math.round(one.x)}, {Math.round(one.y)} ·{' '}
                  {report?.seeds.find((entry) => entry.id === one.id)?.pixels.toLocaleString() ?? 0} pixels
                </p>
              </>
            ) : one.type === 'region' ? (
              <>
                <Field label="What it does">
                  <select
                    value={one.mode}
                    onChange={(event) =>
                      patch(setRegion(data, one.id, { mode: event.target.value as Region['mode'] }))
                    }
                  >
                    <option value="include">Keep everything inside</option>
                    <option value="exclude">Drop everything inside</option>
                  </select>
                </Field>
                <label className="vt-row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={one.curved}
                    onChange={(event) => patch(setRegion(data, one.id, { curved: event.target.checked }))}
                  />
                  Smooth through the points
                </label>
                <p className="vt-faint" style={{ fontSize: 11, marginTop: 6 }}>
                  {one.points.length / 2} points ·{' '}
                  {report?.seeds.find((entry) => entry.id === one.id)?.pixels.toLocaleString() ?? 0} pixels
                  inside
                </p>
              </>
            ) : (
              <>
                <Slider
                  range="cutout.lineWidth"
                  label="Width"
                  value={one.width}
                  format={(value) => `${value}px`}
                  hint="A cut is a barrier a fill cannot cross. Too thin and a fill slips through a diagonal gap."
                  onChange={(width) => patch(setLine(data, one.id, { width }))}
                />
                <Field label="What it does">
                  <select
                    value={one.mode}
                    onChange={(event) =>
                      patch(setLine(data, one.id, { mode: event.target.value as CutLine['mode'] }))
                    }
                  >
                    <option value="block">Block a fill from crossing</option>
                    <option value="erase">Also clear what it covers</option>
                  </select>
                </Field>
                <p className="vt-faint" style={{ fontSize: 11, marginTop: 6 }}>
                  {one.points.length / 2} points · {one.points.length === 4 ? 'straight' : 'curved'}
                </p>
              </>
            )}
            <div className="vt-row" style={{ gap: 4, marginTop: 8 }}>
              <button
                type="button"
                className="vt-btn is-small"
                onClick={() =>
                  patch(
                    one.type === 'seed'
                      ? setSeed(data, one.id, { muted: !one.muted })
                      : one.type === 'region'
                        ? setRegion(data, one.id, { muted: !one.muted })
                        : setLine(data, one.id, { muted: !one.muted }),
                  )
                }
              >
                {one.muted ? 'Switch back on' : 'Switch off'}
              </button>
              <button
                type="button"
                className="vt-btn is-small is-danger"
                onClick={() => patch(deleteSelected(data))}
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The image"
          tools={
            <>
              <span className="vt-faint" style={{ fontSize: 11 }}>
                {loading ? 'Reading…' : bitmap ? `${bitmap.width} × ${bitmap.height}` : 'no image'}
              </span>
              {data.selected.length > 0 ? (
                <button
                  type="button"
                  className="vt-btn is-small is-danger"
                  onClick={() => patch(deleteSelected(data))}
                >
                  Delete {data.selected.length === 1 ? 'selected' : `${data.selected.length} selected`}
                </button>
              ) : null}
            </>
          }
        >
          <div className="vt-cutout-stage" ref={overlay} tabIndex={-1}>
            {bitmap ? (
              <div className="vt-cutout-frame">
                <canvas
                  ref={canvas}
                  className="vt-cutout-canvas"
                  onClick={onCanvasClick}
                  onContextMenu={onCanvasContextMenu}
                  onDoubleClick={onCanvasDoubleClick}
                  style={{ cursor: tool === 'fill' ? 'crosshair' : 'copy' }}
                />

                {/* The objects, drawn over the canvas so they stay clickable and
                    crisp at any zoom rather than being baked into the pixels. */}
                <svg
                  className={`vt-cutout-objects${drawing.length > 0 ? ' is-drawing' : ''}`}
                  viewBox={`0 0 ${scale.width} ${scale.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {(data.regions ?? []).map((region) => (
                    <polygon
                      key={region.id}
                      points={regionOutline(region)
                        .map((point) => `${point.x},${point.y}`)
                        .join(' ')}
                      className={`vt-region${data.selected.includes(region.id) ? ' is-selected' : ''}${
                        region.muted ? ' is-muted' : ''
                      } is-${region.mode}`}
                      strokeWidth={1.5}
                      onClick={(event) => {
                        event.stopPropagation();
                        patch(selectObject(data, region.id, event.shiftKey));
                      }}
                    />
                  ))}

                  {data.lines.map((line) => {
                    const points = linePoints(line)
                      .map((point) => `${point.x},${point.y}`)
                      .join(' ');
                    return (
                      <polyline
                        key={line.id}
                        points={points}
                        className={`vt-cut-line${data.selected.includes(line.id) ? ' is-selected' : ''}${
                          line.muted ? ' is-muted' : ''
                        }${line.mode === 'erase' ? ' is-erase' : ''}`}
                        strokeWidth={Math.max(line.width, 1 / zoom)}
                        onClick={(event) => {
                          event.stopPropagation();
                          patch(selectObject(data, line.id, event.shiftKey));
                        }}
                      />
                    );
                  })}

                  {drawing.length >= 2
                    ? (() => {
                        const drafted = Array.from({ length: drawing.length / 2 }, (_, index) =>
                          `${drawing[index * 2]},${drawing[index * 2 + 1]}`,
                        ).join(' ');
                        // A region is shown already closed while it is drawn, so
                        // its shape is the thing you are aiming rather than a
                        // chain of points you have to imagine joining up.
                        return tool === 'region' && drawing.length >= 6 ? (
                          <polygon
                            className="vt-region is-drafting"
                            points={drafted}
                            strokeWidth={1.5}
                          />
                        ) : (
                          <polyline
                            className="vt-cut-line is-drafting"
                            points={drafted}
                            strokeWidth={1.5}
                          />
                        );
                      })()
                    : null}

                  {/* The nodes of what is selected, so where a finished region or
                      cut actually runs through can be seen — and zoomed in on. */}
                  {[...(data.regions ?? []), ...data.lines]
                    .filter((object) => data.selected.includes(object.id))
                    .flatMap((object) =>
                      unflatten(object.points).map((point, index) => (
                        <circle
                          key={`${object.id}:${index}`}
                          className="vt-draft-point is-placed"
                          cx={point.x}
                          cy={point.y}
                          r={3 / zoom}
                        />
                      )),
                    )}

                  {/* The points as placed, so one dropped by mistake is visible. */}
                  {Array.from({ length: drawing.length / 2 }, (_, index) => (
                    <circle
                      key={index}
                      className="vt-draft-point"
                      cx={drawing[index * 2]}
                      cy={drawing[index * 2 + 1]}
                      r={3 / zoom}
                    />
                  ))}

                  {data.seeds.map((seed) => (
                    <g
                      key={seed.id}
                      className={`vt-seed${data.selected.includes(seed.id) ? ' is-selected' : ''}${
                        seed.muted ? ' is-muted' : ''
                      }${seed.mode === 'exclude' ? ' is-exclude' : ' is-include'}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        patch(selectObject(data, seed.id, event.shiftKey));
                      }}
                    >
                      {/* 5px and 11px on screen, whatever the picture is. */}
                      <circle cx={seed.x} cy={seed.y} r={5 / zoom} />
                      <circle cx={seed.x} cy={seed.y} r={11 / zoom} className="vt-seed-hit" />
                    </g>
                  ))}
                </svg>
              </div>
            ) : (
              <div className="vt-empty">{loading ? 'Reading the image…' : (blocked ?? 'No image.')}</div>
            )}
          </div>
        </Stage>

        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseCutout(data, report)}
          {busy ? ' · generating…' : ''}
        </p>

        {report && report.problems.length > 0 ? (
          <div className="vt-section">
            <h3>Worth looking at</h3>
            <ul className="vt-hints">
              {report.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="vt-section">
          <h3>What is selected ({objects.length})</h3>
          {objects.length === 0 ? (
            <div className="vt-empty">
              Nothing yet. Left-click the part of the picture to keep; right-click to take a part back out.
            </div>
          ) : (
            <div className="vt-object-list">
              {objects.slice(0, view.listLimit).map((object) => {
                const caught = report?.seeds.find((entry) => entry.id === object.id);
                return (
                  <button
                    key={object.id}
                    type="button"
                    className={`vt-object${data.selected.includes(object.id) ? ' is-selected' : ''}${
                      object.muted ? ' is-muted' : ''
                    }`}
                    onClick={(event) => patch(selectObject(data, object.id, event.shiftKey))}
                  >
                    <span className={`vt-object-dot is-${object.mode}`} />
                    <strong>{labelOf(data, object)}</strong>
                    <span className="vt-faint">
                      {object.type === 'seed'
                        ? `${Math.round(object.x)}, ${Math.round(object.y)} · tol ${object.tolerance}${
                            caught ? ` · ${caught.pixels.toLocaleString()}px` : ''
                          }`
                        : object.type === 'region'
                          ? `${object.points.length / 2} points · ${
                              object.curved ? 'smoothed' : 'cornered'
                            }${caught ? ` · ${caught.pixels.toLocaleString()}px` : ''}`
                          : `${object.points.length / 2} points · ${
                              object.points.length === 4 ? 'straight' : 'curved'
                            } · ${object.width}px`}
                    </span>
                    {object.muted ? <span className="vt-pill">off</span> : null}
                  </button>
                );
              })}
            </div>
          )}
          <p className="vt-faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            The mask is rebuilt from this list every time, in order, so deleting one of these takes its region
            with it. Select and press Delete, or shift-click to select several.
          </p>
        </div>
      </div>
    </EditorShell>
  );
}
