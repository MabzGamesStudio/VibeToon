import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  artifactForPort,
  diagramFromNodes,
  emptyVoronoiFlowData,
  inputsForPort,
  nodeColorKey,
  readPalette,
  readVoronoiNodes,
  sameColorAreas,
  voronoiImage,
  voronoiNodesFile,
  voronoiReport,
  voronoiVectorWork,
  voronoiWork,
  type Bitmap,
  type FilterPalette,
  type FlowNode,
  type Project,
  type VoronoiFit,
  type VoronoiFlowData,
  type VoronoiProgress,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useBatchRun, waitUntil } from '../../state/batchRun';
import { useStudio } from '../../state/store';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { inSlices, textDataUrl } from '../common/slices';
import { paintBitmap, useFitScale } from './CropFlowEditor';
import { EditorShell } from './EditorShell';

const STAGES: Record<VoronoiProgress['stage'], string> = {
  start: 'Scattering the nodes',
  refine: 'Nudging the nodes',
  finish: 'At full size',
  shapes: 'Making the shapes',
};

/** What a fit was made from: the picture, the settings that change it, and the palette it kept to. */
const fitKey = (hash: string | null | undefined, nodes: number, refine: number, repel: number, palette: readonly string[] | null) => JSON.stringify([hash ?? '', nodes, refine, repel, palette]);

/** Node dots this many screen pixels across, however far the picture is zoomed. */
const DOT_RADIUS = 3;

/**
 * Every node as a dot over the picture, drawn in the picture's units but sized
 * by `unit` (picture units per screen pixel), so zooming in moves the dots
 * apart without making them bigger. One path, so tens of thousands draw fast.
 */
function NodeDots({ fit, unit }: { fit: VoronoiFit; unit: number }): JSX.Element {
  const r = DOT_RADIUS * unit;
  const d = useMemo(() => {
    const parts: string[] = [];
    const across = (r * 2).toFixed(3);
    for (const one of fit.nodes) parts.push(`M${(one.x - r).toFixed(2)} ${one.y.toFixed(2)}a${r.toFixed(3)} ${r.toFixed(3)} 0 1 0 ${across} 0a${r.toFixed(3)} ${r.toFixed(3)} 0 1 0 -${across} 0`);
    return parts.join('');
  }, [fit, r]);
  return <path d={d} fill="rgba(255, 255, 255, 0.95)" stroke="rgba(0, 0, 0, 0.85)" strokeWidth={unit} />;
}

/** The picture with the cells' edges drawn in: strong between colors, faint between cells of one color. */
function withEdges(base: Bitmap, fit: VoronoiFit): Bitmap {
  const { width: W, height: H } = base;
  const data = new Uint8ClampedArray(base.data);
  const keys = fit.nodes.map(nodeColorKey);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      const o = fit.owner[p]!;
      const right = x + 1 < W ? fit.owner[p + 1]! : o;
      const down = y + 1 < H ? fit.owner[p + W]! : o;
      if (right === o && down === o) continue;
      const between = (right !== o && keys[right] !== keys[o]) || (down !== o && keys[down] !== keys[o]);
      const strength = between ? 0.75 : 0.3;
      const light = 0.299 * data[p * 4]! + 0.587 * data[p * 4 + 1]! + 0.114 * data[p * 4 + 2]! > 110;
      const toward = light ? 0 : 255;
      for (let c = 0; c < 3; c += 1) data[p * 4 + c] = data[p * 4 + c]! + (toward - data[p * 4 + c]!) * strength;
      data[p * 4 + 3] = Math.max(data[p * 4 + 3]!, 200);
    }
  }
  return { width: W, height: H, data };
}

/**
 * A picture as a Voronoi diagram.
 *
 * The diagram is fitted here, when Fit (or Generate) is pressed — never as a
 * setting moves, since fitting a few thousand nodes takes seconds — a slice
 * at a time so the page stays responsive. What was last written is read back
 * from nodes.json when the editor opens, so the diagram is there without
 * fitting it again.
 */
export function VoronoiFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, generateFlow, notify, busyFlows } = useStudio();
  const data = node.data.editor === 'voronoi' ? (node.data as VoronoiFlowData) : emptyVoronoiFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<VoronoiFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);

  /* ---------------- the inputs ---------------- */

  const input = inputsForPort(project, node.id, 'image')[0];
  const artifact = input?.artifact;
  const path = artifact ? (artifact.entries?.[0] ? `${artifact.path}/${artifact.entries[0]}` : artifact.path) : '';
  const [source, setSource] = useState<Bitmap | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    setSourceError(null);
    if (!path) return undefined;
    let cancelled = false;
    readBitmap(api.artifactUrl(project.id, path), { maxPixels: 16_000_000 })
      .then((read) => {
        if (!cancelled) setSource(read);
      })
      .catch((reason: Error) => {
        if (!cancelled) setSourceError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, project.id, artifact?.hash]);

  const paletteInput = inputsForPort(project, node.id, 'palette')[0];
  const paletteArtifact = paletteInput?.artifact;
  const [palette, setPalette] = useState<FilterPalette | null>(null);
  const [paletteState, setPaletteState] = useState<'none' | 'loading' | 'ready' | string>('none');
  useEffect(() => {
    setPalette(null);
    if (!paletteArtifact) {
      setPaletteState('none');
      return undefined;
    }
    setPaletteState('loading');
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(api.artifactUrl(project.id, paletteArtifact.path));
        if (!response.ok) throw new Error(`the file could not be read (${response.status})`);
        const read = readPalette(await response.json());
        if (cancelled) return;
        setPalette(read.hexes.length > 0 ? read : null);
        setPaletteState(read.hexes.length > 0 ? 'ready' : 'That file has no colors in it that this flow can read.');
      } catch (reason) {
        if (!cancelled) setPaletteState((reason as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paletteArtifact?.path, paletteArtifact?.hash, project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedPalette = data.usePalette && palette ? palette : null;
  const wantedKey = fitKey(artifact?.hash, data.nodes, data.refine, data.repel, usedPalette?.hexes ?? null);

  /* ---------------- fitting ---------------- */

  const [fitted, setFitted] = useState<{ fit: VoronoiFit; key: string; source: Bitmap } | null>(null);
  const [working, setWorking] = useState<VoronoiProgress | null>(null);
  const stopping = useRef(false);
  const current = fitted && fitted.source === source ? fitted : null;
  const behind = Boolean(current && current.key !== wantedKey);

  const sourceRef = useRef(source);
  sourceRef.current = source;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const hashRef = useRef(artifact?.hash);
  hashRef.current = artifact?.hash;
  const fitNow = useCallback(async (): Promise<VoronoiFit | null> => {
    const picture = sourceRef.current;
    if (!picture) return null;
    const settings = dataRef.current;
    const colors = settings.usePalette && paletteRef.current ? paletteRef.current : null;
    stopping.current = false;
    setWorking({ stage: 'start', done: 0, total: 1 });
    const made = await inSlices(voronoiWork(picture, { nodes: settings.nodes, refine: settings.refine, repel: settings.repel }, colors?.colors ?? null), setWorking, () => stopping.current);
    setWorking(null);
    if (!made) return null;
    setFitted({ fit: made, key: fitKey(hashRef.current, settings.nodes, settings.refine, settings.repel, colors?.hexes ?? null), source: picture });
    const was = dataRef.current.image;
    if (!was || was.hash !== hashRef.current || was.width !== picture.width || was.height !== picture.height) {
      patch({ image: { width: picture.width, height: picture.height, ...(hashRef.current ? { hash: hashRef.current } : {}) } });
    }
    return made;
  }, [patch]);

  // What was last written, read back: the diagram is there without fitting it again.
  const written = artifactForPort(node, 'nodes');
  useEffect(() => {
    if (!source || !written || working) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(api.artifactUrl(project.id, written.path));
        if (!response.ok) return;
        const file = readVoronoiNodes(await response.json());
        if (cancelled || !file || (file.source && file.source !== artifact?.hash)) return;
        const fit = diagramFromNodes(source, file);
        if (!cancelled) setFitted((was) => (was && was.source === source ? was : { fit, key: fitKey(file.source ?? artifact?.hash, file.settings.nodes, file.settings.refine, file.settings.repel, file.settings.palette), source }));
      } catch {
        // Nothing to show until it is fitted.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, written?.path, written?.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- writing ---------------- */

  const send = async (fit: VoronoiFit) => {
    const settings = dataRef.current;
    const attachments: Array<{ name: string; data: string }> = [];
    if (settings.output !== 'vector') attachments.push({ name: 'voronoi.png', data: await pngDataUrl(voronoiImage(fit)) });
    let vector = null;
    if (settings.output !== 'picture') {
      setWorking({ stage: 'shapes', done: 0, total: fit.nodes.length });
      vector = await inSlices(voronoiVectorWork(fit, settings.merge), setWorking, () => false);
      setWorking(null);
      if (vector) attachments.push({ name: 'vector.json', data: textDataUrl(JSON.stringify(vector), 'application/json') });
    }
    attachments.push({ name: 'nodes.json', data: textDataUrl(voronoiNodesFile(settings, fit, hashRef.current ?? null), 'application/json') });
    attachments.push({ name: 'voronoi.md', data: textDataUrl(voronoiReport(settings, fit, vector)) });
    await generateFlow(node.id, attachments);
  };

  const onGenerate = async () => {
    let fit = current && !behind ? current.fit : null;
    if (!fit) {
      if (!source) {
        await generateFlow(node.id);
        return;
      }
      fit = await fitNow();
      if (!fit) return;
    }
    try {
      await send(fit);
    } catch (reason) {
      notify('error', `Could not write the diagram: ${(reason as Error).message}`);
    }
  };

  // Generate all, for one item of a batch: read its picture, fit it, and send it.
  const ready = useRef({ source, sourceError, paletteState });
  ready.current = { source, sourceError, paletteState };
  const currentRef = useRef({ current, behind });
  currentRef.current = { current, behind };
  useBatchRun(node, async () => {
    await waitUntil(() => (ready.current.source && ready.current.paletteState !== 'loading' ? ready.current.source : ready.current.sourceError ? 'failed' : null), 'Reading the picture');
    if (!ready.current.source) throw new Error(`the picture could not be read: ${ready.current.sourceError}`);
    const known = currentRef.current;
    const fit = known.current && !known.behind ? known.current.fit : await fitNow();
    if (!fit) throw new Error('the diagram could not be fitted');
    await send(fit);
  });

  /* ---------------- what is shown ---------------- */

  const fit = current?.fit ?? null;
  const diagram = useMemo(() => (fit ? voronoiImage(fit) : null), [fit]);
  const areas = useMemo(() => (fit ? sameColorAreas(fit).count : 0), [fit]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const base = data.view === 'picture' || !diagram ? source : diagram;
    if (!base) {
      paintBitmap(canvas.current, null);
      return;
    }
    paintBitmap(canvas.current, fit && data.showEdges ? withEdges(base, fit) : base);
  }, [source, diagram, fit, data.view, data.showEdges]);
  const [overlay, setOverlay] = useState<SVGSVGElement | null>(null);
  const fitScale = useFitScale(overlay, source?.width ?? 0, source?.height ?? 0);

  const generating = Boolean(working) || busyFlows.includes(node.id);
  const used = fit ? fit.nodes.filter((one) => one.pixels > 0).length : 0;
  const blocked = !input
    ? 'Wire an image into the Image input.'
    : !artifact
      ? `Press Generate on ${input.sourceNode.name} first — it has not produced an image yet.`
      : sourceError
        ? `The picture could not be read: ${sourceError}.`
        : null;
  const paletteNote =
    paletteState === 'none'
      ? 'No palette wired in: each node takes its cell’s own average.'
      : paletteState === 'loading'
        ? 'Reading the palette…'
        : paletteState === 'ready'
          ? null
          : `The palette could not be read: ${paletteState}`;

  return (
    <EditorShell project={project} node={node} onGenerate={onGenerate} banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Fitting</h3>
          <p className="vt-hint">
            Every pixel takes the color of the node nearest it. The nodes are placed, and colored, to make that as like the picture as it can be: they gather where the picture
            has detail.
          </p>
          <Slider range="voronoi.nodes" label="Nodes" tip="voronoi.nodes" value={data.nodes} format={(value) => `${Math.round(value)}`} onChange={(value) => patch({ nodes: Math.round(value) })} />
          <Slider range="voronoi.refine" label="Rounds" tip="voronoi.refine" value={data.refine} format={(value) => `${Math.round(value)}`} onChange={(value) => patch({ refine: Math.round(value) })} />
          <Slider
            range="voronoi.repel"
            label="Repel"
            tip="voronoi.repel"
            value={data.repel}
            format={(value) => (Math.round(value) === 0 ? 'off' : `${Math.round(value)}`)}
            hint="How hard nodes push each other apart: higher spreads them more evenly. No two are ever nearer than a pixel."
            onChange={(value) => patch({ repel: Math.round(value) })}
          />
          <label className="vt-row" style={{ gap: 6 }} title="With a palette wired in, the nodes take only its colors">
            <input type="checkbox" checked={data.usePalette} disabled={!palette} onChange={(event) => patch({ usePalette: event.target.checked })} />
            {palette ? `Only the palette’s ${palette.hexes.length} color(s)` : 'Only the palette’s colors'}
          </label>
          {palette && data.usePalette ? (
            <div className="vt-filter-colors" aria-label="The palette">
              {palette.hexes.map((hex) => (
                <span key={hex} className="vt-filter-color is-on" style={{ '--vt-swatch': hex } as CSSProperties} title={hex}>
                  <span>{hex.slice(1)}</span>
                </span>
              ))}
            </div>
          ) : null}
          {paletteNote ? <p className="vt-faint" style={{ fontSize: 11 }}>{paletteNote}</p> : null}
          {working ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <span className="vt-faint" style={{ fontSize: 11 }}>{STAGES[working.stage]}…</span>
              <progress max={working.total} value={working.done} style={{ flex: 1 }} />
              {working.stage !== 'shapes' ? (
                <button type="button" className="vt-btn is-small" onClick={() => (stopping.current = true)}>
                  Stop
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className={`vt-btn is-small${!fit || behind ? ' is-primary' : ''}`}
              disabled={!source || generating}
              title="Place and color the nodes for these settings"
              onClick={() => void fitNow()}
            >
              {fit ? 'Fit again' : 'Fit'}
            </button>
          )}
          {behind ? <p className="vt-faint" style={{ fontSize: 11 }}>The settings have changed since this was fitted: Fit again, or Generate fits it first.</p> : null}
          <dl className="vt-kv">
            <dt>Off by</dt>
            <dd>{fit ? `${fit.error.mean.toFixed(2)} a pixel · ${fit.error.psnr.toFixed(1)} dB` : '—'}</dd>
            <dt>Nodes</dt>
            <dd>{fit ? `${fit.nodes.length}${used < fit.nodes.length ? `, ${used} with pixels` : ''}${fit.relocated > 0 ? ` · ${fit.relocated} moved to where it fitted worst` : ''}` : '—'}</dd>
            <dt>Areas</dt>
            <dd>{fit ? `${areas} of same-colored cells` : '—'}</dd>
          </dl>
        </div>

        <div className="vt-section">
          <h3>Write</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Write">
            {(
              [
                ['picture', 'The picture'],
                ['vector', 'Shapes'],
                ['both', 'Both'],
              ] as const
            ).map(([output, label]) => (
              <button key={output} type="button" className={`vt-chip${data.output === output ? ' is-on' : ''}`} aria-pressed={data.output === output} onClick={() => patch({ output })}>
                {label}
              </button>
            ))}
          </div>
          {data.output !== 'picture' ? (
            <label className="vt-row" style={{ gap: 6 }} title="One polygon for each area of same-colored cells that touch, instead of one for each cell">
              <input type="checkbox" checked={data.merge} onChange={(event) => patch({ merge: event.target.checked })} />
              Join same-colored cells
            </label>
          ) : null}
          <p className="vt-faint" style={{ fontSize: 11 }}>
            {data.output === 'picture'
              ? 'voronoi.png: every pixel its cell’s color.'
              : `vector.json and voronoi.svg: ${data.merge ? 'a polygon for each area of one color, with holes' : 'a polygon for each cell'}${data.output === 'both' ? ', and voronoi.png' : ''}.`}{' '}
            nodes.json lists every node.
          </p>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={fit ? `${fit.nodes.length} nodes` : 'Voronoi diagram'}
          tools={
            <>
              <div className="vt-facet-values" role="radiogroup" aria-label="Show">
                {(
                  [
                    ['diagram', 'The diagram'],
                    ['picture', 'The picture'],
                  ] as const
                ).map(([view, label]) => (
                  <button key={view} type="button" className={`vt-chip${data.view === view ? ' is-on' : ''}`} aria-pressed={data.view === view} onClick={() => patch({ view })}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="vt-row" style={{ gap: 4 }} title="Draw the cells' edges: strong between colors, faint between cells of one color">
                <input type="checkbox" checked={data.showEdges} onChange={(event) => patch({ showEdges: event.target.checked })} />
                Edges
              </label>
              <label className="vt-row" style={{ gap: 4 }} title="Draw where each node is">
                <input type="checkbox" checked={data.showNodes} onChange={(event) => patch({ showNodes: event.target.checked })} />
                Nodes
              </label>
            </>
          }
        >
          {({ scale }) => (
            <div className="vt-resize-stage">
              {!source ? (
                <div className="vt-empty">{blocked ?? 'Reading the picture…'}</div>
              ) : (
                <div className="vt-crop-frame">
                  <canvas ref={canvas} className="vt-crop-canvas" style={{ imageRendering: 'pixelated' }} />
                  <svg ref={setOverlay} className="vt-crop-overlay" viewBox={`0 0 ${source.width} ${source.height}`} style={{ pointerEvents: 'none' }} aria-hidden="true">
                    {fit && data.showNodes ? <NodeDots fit={fit} unit={1 / Math.max(1e-3, fitScale * scale)} /> : null}
                  </svg>
                  {!fit && data.view === 'diagram' ? <div className="vt-faint" style={{ fontSize: 11, marginTop: 6 }}>Not fitted yet: the picture, until Fit is pressed.</div> : null}
                </div>
              )}
            </div>
          )}
        </Stage>
      </div>
    </EditorShell>
  );
}
