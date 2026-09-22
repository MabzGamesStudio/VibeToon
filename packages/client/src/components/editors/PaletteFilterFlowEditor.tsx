import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FILTER_MODES,
  FILTER_MODE_HINT,
  FILTER_MODE_LABEL,
  activePalette,
  emptyPaletteFilterFlowData,
  filterImage,
  inputsForPort,
  readPalette,
  summariseFilter,
  type Bitmap,
  type FilterMode,
  type FilterPalette,
  type FilterReport,
  type FlowNode,
  type PaletteFilterFlowData,
  type Project,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';

function toImageData(pixels: Uint8ClampedArray, width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(pixels), width, height);
}

/**
 * An image filtered against a palette.
 *
 * Three jobs in one flow, because they are the same measurement read three ways:
 * keeping what is on-palette, dropping what is, and replacing every pixel with its
 * nearest. The first two answer "where is this color in my picture"; the third is
 * what makes a photograph look drawn.
 *
 * Both inputs are read here — the image because a browser is what decodes it, the
 * palette because the file is small and reading it here is what lets you tick a
 * color off and see the result immediately.
 */
export function PaletteFilterFlowEditor({
  project,
  node,
}: {
  project: Project;
  node: FlowNode;
}): JSX.Element {
  const { setFlowData, generateFlow, notify, busyFlows } = useStudio();
  const { view } = useView();
  const data =
    node.data.editor === 'paletteFilter' ? (node.data as PaletteFilterFlowData) : emptyPaletteFilterFlowData();
  const busy = busyFlows.includes(node.id);

  const imageInput = inputsForPort(project, node.id, 'image')[0];
  const paletteInput = inputsForPort(project, node.id, 'palette')[0];
  const imageArtifact = imageInput?.artifact;
  const paletteArtifact = paletteInput?.artifact;

  const imagePath = useMemo(() => {
    if (!imageArtifact) return '';
    const entry = imageArtifact.entries?.[0];
    return entry ? `${imageArtifact.path}/${entry}` : imageArtifact.path;
  }, [imageArtifact]);

  const [bitmap, setBitmap] = useState<Bitmap | null>(null);
  const [palette, setPalette] = useState<FilterPalette>(() => readPalette(undefined));
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const patch = useCallback(
    (over: Partial<PaletteFilterFlowData>) => setFlowData(node.id, { ...data, ...over }),
    [data, node.id, setFlowData],
  );

  /* ---------------- reading the inputs ---------------- */

  useEffect(() => {
    if (!imagePath) {
      setBitmap(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      const surface = document.createElement('canvas');
      surface.width = image.naturalWidth;
      surface.height = image.naturalHeight;
      const context = surface.getContext('2d', { willReadFrequently: true });
      if (!context) {
        setLoading(false);
        return;
      }
      context.drawImage(image, 0, 0);
      setBitmap({
        width: surface.width,
        height: surface.height,
        data: context.getImageData(0, 0, surface.width, surface.height).data,
      });
      setLoading(false);
    };
    image.onerror = () => {
      if (cancelled) return;
      setLoading(false);
      notify('error', 'The browser could not decode that image.');
    };
    image.src = api.artifactUrl(project.id, imagePath);
    return () => {
      cancelled = true;
    };
  }, [imagePath, notify, project.id]);

  useEffect(() => {
    if (!paletteArtifact) {
      setPalette(readPalette(undefined));
      setPaletteError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(api.artifactUrl(project.id, paletteArtifact.path));
        if (!response.ok) throw new Error(`the file could not be read (${response.status})`);
        const read = readPalette(await response.json());
        if (cancelled) return;
        setPalette(read);
        setPaletteError(
          read.hexes.length === 0 ? 'That file has no colors in it that this flow can read.' : null,
        );
      } catch (error) {
        if (!cancelled) setPaletteError((error as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paletteArtifact, project.id]);

  /* ---------------- filtering ---------------- */

  /**
   * Recomputed on every change, which is what makes the tolerance slider worth
   * having. Turned off with live previews in the View menu, because on a large
   * photograph this is the expensive thing in the editor.
   */
  const filtered = useMemo(() => {
    if (!bitmap || palette.hexes.length === 0) return null;
    if (!view.livePreview) return null;
    return filterImage(bitmap, palette, data.options);
  }, [bitmap, data.options, palette, view.livePreview]);

  useEffect(() => {
    const surface = canvas.current;
    if (!surface || !bitmap) return;
    surface.width = bitmap.width;
    surface.height = bitmap.height;
    const context = surface.getContext('2d');
    if (!context) return;
    context.putImageData(
      toImageData(filtered?.pixels ?? bitmap.data, bitmap.width, bitmap.height),
      0,
      0,
    );
  }, [bitmap, filtered]);

  const onGenerate = async () => {
    if (!bitmap) {
      notify('error', 'No image to filter yet.');
      return;
    }
    if (palette.hexes.length === 0) {
      notify('error', 'No palette to filter against yet.');
      return;
    }
    // Computed here rather than reused from the preview, so a run is correct even
    // with live previews switched off.
    const run = filterImage(bitmap, palette, data.options);
    const surface = document.createElement('canvas');
    surface.width = bitmap.width;
    surface.height = bitmap.height;
    surface.getContext('2d')!.putImageData(toImageData(run.pixels, bitmap.width, bitmap.height), 0, 0);

    patch({ imageHash: imageArtifact?.hash, paletteHash: paletteArtifact?.hash });
    await generateFlow(node.id, [{ name: 'filtered.png', data: surface.toDataURL('image/png') }]);
  };

  const active = activePalette(palette, data.options);
  const report: FilterReport | null = filtered?.report ?? null;

  const blocked = !imageInput
    ? 'Wire an image into the Image input.'
    : !imageArtifact
      ? `Press Generate on ${imageInput.sourceNode.name} first — it has no image yet.`
      : !paletteInput
        ? 'Wire a Color Palette flow into the Palette input.'
        : !paletteArtifact
          ? `Press Generate on ${paletteInput.sourceNode.name} first — it has no palette yet.`
          : paletteError;

  const toggleColor = (hex: string) => {
    // `only` empty means all, so the first tick has to start from everything.
    const current = data.options.only.length === 0 ? palette.hexes : data.options.only;
    const next = current.includes(hex) ? current.filter((candidate) => candidate !== hex) : [...current, hex];
    patch({
      options: { ...data.options, only: next.length === palette.hexes.length ? [] : next },
    });
  };

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={
        blocked ? (
          <div className="vt-sync-banner">
            <span>{blocked}</span>
          </div>
        ) : !view.livePreview ? (
          <div className="vt-sync-banner">
            <span>
              Live previews are off in the View menu, so the picture below is unfiltered. Generating still
              filters it.
            </span>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>What to do</h3>
          <Field label="Mode" tip="paletteFilter.mode">
            <select
              value={data.options.mode}
              onChange={(event) =>
                patch({ options: { ...data.options, mode: event.target.value as FilterMode } })
              }
            >
              {FILTER_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {FILTER_MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </Field>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            {FILTER_MODE_HINT[data.options.mode]}
          </p>
        </div>

        {data.options.mode === 'snap' ? (
          <div className="vt-section">
            <h3>Closeness</h3>
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
              Snapping has no threshold to set: every pixel has a nearest palette color and gets it. Nothing
              is made transparent, so a cutout wired in keeps its shape.
            </p>
          </div>
        ) : (
          <div className="vt-section">
            <h3>How close counts as the same</h3>
            <Slider
              label="Tolerance"
              value={data.options.tolerance}
              min={0}
              max={80}
              step={0.5}
              tip="paletteFilter.tolerance"
              hint="In OKLab, times 100: under 2 is invisible, 20 is navy against royal blue."
              onChange={(tolerance) => patch({ options: { ...data.options, tolerance } })}
            />
            <Slider
              label="Softness"
              value={data.options.softness}
              min={0}
              max={20}
              step={0.5}
              tip="paletteFilter.softness"
              format={(value) => (value === 0 ? 'a hard edge' : `±${value}`)}
              onChange={(softness) => patch({ options: { ...data.options, softness } })}
            />
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={data.options.hardAlpha}
                onChange={(event) =>
                  patch({ options: { ...data.options, hardAlpha: event.target.checked } })
                }
              />
              Force alpha fully on or off
            </label>
          </div>
        )}

        <div className="vt-section">
          <h3>
            Colors in play ({active.hexes.length} of {palette.hexes.length})
          </h3>
          {palette.hexes.length === 0 ? (
            <div className="vt-empty">No palette read yet.</div>
          ) : (
            <>
              <div className="vt-filter-colors">
                {palette.hexes.map((hex) => {
                  const on = active.hexes.includes(hex);
                  const landed = report?.perEntry.find((entry) => entry.hex === hex);
                  return (
                    <button
                      key={hex}
                      type="button"
                      className={`vt-filter-color${on ? ' is-on' : ''}`}
                      style={{ background: hex }}
                      aria-pressed={on}
                      title={`${hex}${on ? '' : ' — switched off'}${
                        landed ? ` · ${landed.pixels.toLocaleString()} pixels` : ''
                      }`}
                      onClick={() => toggleColor(hex)}
                    >
                      <span>{hex.slice(1)}</span>
                    </button>
                  );
                })}
              </div>
              {data.options.only.length > 0 ? (
                <button
                  type="button"
                  className="vt-btn is-ghost is-small"
                  style={{ marginTop: 6 }}
                  onClick={() => patch({ options: { ...data.options, only: [] } })}
                >
                  Switch them all back on
                </button>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The result"
          tools={
            <span className="vt-faint" style={{ fontSize: 11 }}>
              {loading ? 'Reading…' : bitmap ? `${bitmap.width} × ${bitmap.height}` : 'no image'}
              {busy ? ' · generating…' : ''}
            </span>
          }
        >
          <div className="vt-image-stage">
            {bitmap ? (
              <canvas ref={canvas} className="vt-filter-canvas" />
            ) : (
              <div className="vt-empty">{loading ? 'Reading the image…' : (blocked ?? 'No image.')}</div>
            )}
          </div>
        </Stage>

        {report ? (
          <>
            <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
              {summariseFilter(report, data.options)}
            </p>

            {report.problems.length > 0 ? (
              <div className="vt-section">
                <h3>Worth looking at</h3>
                <ul className="vt-hints">
                  {report.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {data.options.mode === 'snap' || data.options.mode === 'keep' ? (
              <div className="vt-section">
                <h3>Where the pixels landed</h3>
                <div className="vt-swatches">
                  {report.perEntry
                    .filter((entry) => entry.pixels > 0)
                    .map((entry) => (
                      <div
                        key={entry.hex}
                        className="vt-swatch"
                        style={{
                          background: entry.hex,
                          flexGrow: Math.max(entry.pixels, 1),
                        }}
                        title={`${entry.hex} — ${entry.pixels.toLocaleString()} pixels (${(
                          (entry.pixels / Math.max(1, report.considered)) *
                          100
                        ).toFixed(1)}%)`}
                      >
                        <span className="vt-swatch-label">
                          {((entry.pixels / Math.max(1, report.considered)) * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                </div>
                <p className="vt-faint" style={{ fontSize: 11, marginTop: 6 }}>
                  Each band is one palette color, as wide as the share of the picture that landed on it.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </EditorShell>
  );
}
