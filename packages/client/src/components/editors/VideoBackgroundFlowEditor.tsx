import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyMarks,
  backgroundFrameSize,
  backgroundReport,
  commonestBackground,
  emptyVideoBackgroundFlowData,
  clipFrameTimes,
  clipLength,
  nearestFrame,
  newId,
  videoSourceOf,
  type BackgroundMark,
  type BackgroundResult,
  type Bitmap,
  type FlowNode,
  type Project,
  type VideoBackgroundFlowData,
  type VideoSampling,
  noVideoMessage,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useBatchRun, waitUntil } from '../../state/batchRun';
import { useStudio } from '../../state/store';
import { pngDataUrl } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { VideoUpload, clock, useFileUpload } from '../common/video';
import { openClip, useClipProbe, type OpenClip } from '../common/clip';
import { paintBitmap, svgPoint, useFitScale } from './CropFlowEditor';
import { EditorShell } from './EditorShell';

interface ReadFrame {
  time: number;
  bitmap: Bitmap;
  thumb: string;
}

/** Base64 of a UTF-8 string, for a markdown attachment. */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A see-through tint over what is already background, for marking a frame. */
function tintOf(result: BackgroundResult): Bitmap {
  const { width, height, data } = result.image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    if (data[p * 4 + 3]! === 0) continue;
    out.set([60, 200, 120, 90], p * 4);
  }
  return { width, height, data: out };
}

const flat = (points: number[]) => Array.from({ length: points.length / 2 }, (_, i) => `${points[i * 2]},${points[i * 2 + 1]}`).join(' ');

/**
 * Taking the background out of a video.
 *
 * The frames are read here and kept while the editor is open. Each pixel's
 * most common colour across them is the background, where it is common
 * enough; pick a frame to paint, erase or draw round
 * what it shows, and it is put in (or taken out) from that frame.
 */
export function VideoBackgroundFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, notify, uploadOutput, generateFlow } = useStudio();
  const data = node.data.editor === 'videoBackground' ? (node.data as VideoBackgroundFlowData) : emptyVideoBackgroundFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<VideoBackgroundFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const setSampling = (over: Partial<VideoSampling>) => patch({ sampling: { ...data.sampling, ...over } });

  const source = videoSourceOf(project, node);
  const videoUrl = source ? api.artifactUrl(project.id, source.artifact.path) : null;
  // The clip is probed for where its frames are; the times read are worked out inside that.
  const { probe, error: videoError } = useClipProbe(videoUrl);
  const meta = probe?.meta ?? null;
  const upload = useFileUpload((fileName, body) => uploadOutput(node.id, 'source', fileName, body), (message) => notify('error', message));
  const times = useMemo(() => (probe ? clipFrameTimes(probe.span, data.sampling) : []), [probe, data.sampling]);

  /* ---------------- reading the frames ---------------- */

  const [frames, setFrames] = useState<ReadFrame[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const stopping = useRef(false);
  const read = useCallback(async (): Promise<ReadFrame[]> => {
    if (!videoUrl || !source) return [];
    stopping.current = false;
    // Each frame is taken from the clip at its time, once the clip shows it
    // (see `openClip`). The times are worked out from the clip opened here,
    // not from the one probed for the editor: going from one item of a batch
    // to the next, that can still be the item before, and its times laid on
    // this clip bunched every frame into the start of it or past its end.
    let clip: OpenClip;
    try {
      clip = await openClip(videoUrl);
    } catch (reason) {
      notify('error', `Could not read the video: ${(reason as Error).message}`);
      return [];
    }
    const times = clipFrameTimes(clip.span, dataRef.current.sampling);
    const clipMeta = { duration: clipLength(clip.span), width: clip.width, height: clip.height };
    const size = backgroundFrameSize(clipMeta, times.length);
    setRunning({ done: 0, total: times.length });
    const thumbHeight = Math.max(1, Math.round((96 * size.height) / size.width));
    const got: ReadFrame[] = [];
    try {
      for (const time of times) {
        if (stopping.current) break;
        const { bitmap } = await clip.frame(time, size.width, size.height);
        got.push({ time, bitmap, thumb: clip.thumbnail(96, thumbHeight) });
        setRunning({ done: got.length, total: times.length });
      }
    } catch (reason) {
      notify('error', `Could not read every frame: ${(reason as Error).message}`);
    } finally {
      clip.close();
      setRunning(null);
    }
    if (got.length === 0) return [];
    setFrames(got);
    const was = dataRef.current;
    const sameVideo = was.video?.hash === source.artifact.hash && was.frameSize?.width === size.width && was.frameSize?.height === size.height;
    patch({
      video: { hash: source.artifact.hash, duration: clipMeta.duration, width: clipMeta.width, height: clipMeta.height },
      frameSize: size,
      // Marks are in frame pixels, so they only carry over at the same size.
      ...(sameVideo ? {} : { marks: [], current: null }),
    });
    return got;
  }, [notify, patch, source, videoUrl]);

  /* ---------------- the background ---------------- */

  // Each pixel's commonest colour: redone when the frames, the tolerance or the agreement change.
  const [base, setBase] = useState<BackgroundResult | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (frames.length === 0) {
      setBase(null);
      return undefined;
    }
    setWorking(true);
    const timer = window.setTimeout(() => {
      setBase(commonestBackground(frames.map((frame) => frame.bitmap), data.tolerance, data.agreement));
      setWorking(false);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [frames, data.tolerance, data.agreement]);

  // And the marks laid over it.
  const result = useMemo(
    () => (base ? applyMarks(base, data.marks, (time) => nearestFrame(frames, time)?.bitmap) : null),
    [base, data.marks, frames],
  );

  /* ---------------- what is shown ---------------- */

  const current = data.current !== null ? nearestFrame(frames, data.current) : undefined;
  const shownSize = data.frameSize ?? (frames[0] ? { width: frames[0].bitmap.width, height: frames[0].bitmap.height } : null);
  const picture = useRef<HTMLCanvasElement | null>(null);
  const tint = useRef<HTMLCanvasElement | null>(null);
  const [showTint, setShowTint] = useState(true);
  useEffect(() => {
    paintBitmap(picture.current, current ? current.bitmap : (result?.image ?? null));
    paintBitmap(tint.current, current && result && showTint ? tintOf(result) : null);
  }, [current, result, showTint]);

  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const fit = useFitScale(svg, shownSize?.width ?? 0, shownSize?.height ?? 0);

  /* ---------------- marking ---------------- */

  const [stroke, setStroke] = useState<number[] | null>(null);
  const [region, setRegion] = useState<number[]>([]);
  const addMark = (mark: BackgroundMark) => patch({ marks: [...dataRef.current.marks, mark] });
  const finishRegion = useCallback(() => {
    // A double-click lands two clicks on the same spot first; drop the repeats.
    const points: number[] = [];
    for (let i = 0; i < region.length; i += 2) {
      const x = region[i]!;
      const y = region[i + 1]!;
      if (points.length >= 2 && Math.hypot(x - points[points.length - 2]!, y - points[points.length - 1]!) < 0.75) continue;
      points.push(x, y);
    }
    if (points.length >= 6 && current) {
      addMark({ id: newId('mark'), kind: 'region', time: current.time, mode: 'include', points: points.map((value) => Math.round(value * 10) / 10) });
    }
    setRegion([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, current]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (region.length === 0) return;
      if (event.key === 'Enter') finishRegion();
      if (event.key === 'Escape') setRegion([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishRegion, region.length]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!svg || !current || event.button !== 0) return;
    const at = svgPoint(svg, event);
    if (data.tool === 'region') {
      setRegion((points) => [...points, at.x, at.y]);
      return;
    }
    event.preventDefault();
    const points = [at.x, at.y];
    setStroke(points);
    const move = (moveEvent: PointerEvent) => {
      const next = svgPoint(svg, moveEvent);
      const lastX = points[points.length - 2]!;
      const lastY = points[points.length - 1]!;
      if (Math.hypot(next.x - lastX, next.y - lastY) < Math.max(0.5, data.brush / 4)) return;
      points.push(next.x, next.y);
      setStroke([...points]);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setStroke(null);
      addMark({
        id: newId('mark'),
        kind: 'stroke',
        time: current.time,
        mode: data.tool === 'erase' ? 'exclude' : 'include',
        radius: data.brush,
        points: points.map((value) => Math.round(value * 10) / 10),
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const marksHere = current ? data.marks.filter((mark) => nearestFrame(frames, mark.time) === current) : [];

  const onGenerate = async () => {
    if (!result || !base) {
      await generateFlow(node.id);
      return;
    }
    try {
      await generateFlow(node.id, [
        { name: 'background.png', data: await pngDataUrl(result.image) },
        { name: 'background.md', data: `data:text/markdown;base64,${utf8Base64(backgroundReport(dataRef.current, result.stats))}` },
      ]);
    } catch (reason) {
      notify('error', `Could not write the background: ${(reason as Error).message}`);
    }
  };

  // Generate all, for one item of a batch: read its frames, work out its
  // background with the settings it has, and send it.
  const readRef = useRef(read);
  readRef.current = read;
  const metaRef = useRef({ meta, videoError, framesNow: frames });
  metaRef.current = { meta, videoError, framesNow: frames };
  useBatchRun(node, async () => {
    await waitUntil(() => metaRef.current.meta ?? (metaRef.current.videoError ? 'failed' : null), 'Reading the video');
    if (!metaRef.current.meta) throw new Error(`the video could not be read: ${metaRef.current.videoError}`);
    // Both refs are set in the same render, so `read` is now the one made for this video.
    const got = metaRef.current.framesNow.length > 0 ? metaRef.current.framesNow : await readRef.current();
    if (got.length === 0) throw new Error('no frames could be read');
    const settings = dataRef.current;
    const made = applyMarks(
      commonestBackground(got.map((frame) => frame.bitmap), settings.tolerance, settings.agreement),
      settings.marks,
      (time) => nearestFrame(got, time)?.bitmap,
    );
    await generateFlow(node.id, [
      { name: 'background.png', data: await pngDataUrl(made.image) },
      { name: 'background.md', data: `data:text/markdown;base64,${utf8Base64(backgroundReport(dataRef.current, made.stats))}` },
    ]);
  });

  const blocked = !source ? noVideoMessage(project, node) : videoError ? `The video could not be read: ${videoError}.` : null;
  const share = (count: number) => (result ? `${((count / Math.max(1, result.stats.total)) * 100).toFixed(1)}%` : '—');

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}
      actions={source?.wired ? undefined : <VideoUpload replace={Boolean(source)} onFile={upload} />}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Frames</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Sample the video">
            {(
              [
                ['total', 'So many in all'],
                ['fps', 'So many a second'],
              ] as const
            ).map(([mode, label]) => (
              <button key={mode} type="button" className={`vt-chip${data.sampling.mode === mode ? ' is-on' : ''}`} aria-pressed={data.sampling.mode === mode} onClick={() => setSampling({ mode })}>
                {label}
              </button>
            ))}
          </div>
          {data.sampling.mode === 'fps' ? (
            <Slider range="videoBackground.fps" label="Frames a second" tip="videoBackground.sampling" value={data.sampling.fps} format={(value) => `${value.toFixed(1)} a second`} onChange={(fps) => setSampling({ fps: Math.round(fps * 10) / 10 })} />
          ) : (
            <Slider range="videoBackground.total" label="Frames in all" tip="videoBackground.sampling" value={data.sampling.total} format={(value) => `${Math.round(value)}`} onChange={(total) => setSampling({ total: Math.round(total) })} />
          )}
          <p className="vt-faint" style={{ fontSize: 11 }}>
            {meta ? `${times.length} frame(s) from a ${meta.duration.toFixed(2)}s video, read at ${backgroundFrameSize(meta, times.length).width} × ${backgroundFrameSize(meta, times.length).height}.` : '—'}
          </p>
          {running ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <progress max={running.total} value={running.done} style={{ flex: 1 }} />
              <button type="button" className="vt-btn is-small" onClick={() => (stopping.current = true)}>
                Stop
              </button>
            </div>
          ) : (
            <button type="button" className="vt-btn is-primary is-small" disabled={!meta} onClick={() => void read()}>
              {frames.length > 0 ? 'Read the frames again' : 'Read the frames'}
            </button>
          )}
        </div>

        <div className="vt-section">
          <h3>What counts as the background</h3>
          <p className="vt-hint">Each pixel takes the colour it has most often. If that colour is in fewer of the frames than the agreement, the pixel is left clear.</p>
          <Slider
            range="videoBackground.tolerance"
            label="Tolerance"
            tip="videoBackground.tolerance"
            value={data.tolerance}
            format={(value) => `${Math.round(value)}`}
            onChange={(tolerance) => patch({ tolerance: Math.round(tolerance) })}
          />
          <Slider
            range="videoBackground.agreement"
            label="Agreement"
            tip="videoBackground.agreement"
            value={data.agreement}
            format={(value) => `${Math.round(value)}% of frames`}
            onChange={(agreement) => patch({ agreement: Math.round(agreement) })}
          />
          <dl className="vt-kv">
            <dt>Common enough</dt>
            <dd>{working ? '…' : result ? share(result.stats.kept) : '—'}</dd>
            <dt>Marked by hand</dt>
            <dd>{result ? share(result.stats.marked) : '—'}</dd>
            <dt>Marks</dt>
            <dd>{data.marks.length}</dd>
          </dl>
        </div>

        <div className="vt-section">
          <h3>Put more in by hand</h3>
          {!current ? (
            <p className="vt-hint">Choose a frame below that shows a part of the background that moved, then paint it or draw round it.</p>
          ) : (
            <>
              <div className="vt-facet-values" role="radiogroup" aria-label="Tool">
                {(
                  [
                    ['paint', 'Paint in'],
                    ['region', 'Draw round'],
                    ['erase', 'Erase'],
                  ] as const
                ).map(([tool, label]) => (
                  <button key={tool} type="button" className={`vt-chip${data.tool === tool ? ' is-on' : ''}`} aria-pressed={data.tool === tool} onClick={() => patch({ tool })}>
                    {label}
                  </button>
                ))}
              </div>
              {data.tool !== 'region' ? (
                <Slider range="videoBackground.brush" label="Brush" tip="videoBackground.brush" value={data.brush} format={(value) => `${Math.round(value)} px`} onChange={(brush) => patch({ brush: Math.round(brush) })} />
              ) : (
                <p className="vt-hint">Click round the part to put in; double-click or press Enter to close it, Escape to drop it.</p>
              )}
              <label className="vt-row" style={{ gap: 6 }}>
                <input type="checkbox" checked={showTint} onChange={(event) => setShowTint(event.target.checked)} />
                Tint what is background already
              </label>
              <button
                type="button"
                className="vt-btn is-small"
                disabled={marksHere.length === 0}
                onClick={() => patch({ marks: data.marks.filter((mark) => !marksHere.includes(mark)) })}
              >
                Clear this frame’s marks ({marksHere.length})
              </button>
            </>
          )}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={current ? `Frame at ${clock(current.time)}` : 'Background'}
          tools={
            current ? (
              <button type="button" className="vt-btn is-small" onClick={() => patch({ current: null })}>
                Show the background
              </button>
            ) : null
          }
        >
          {({ scale }) => {
            const unit = 1 / Math.max(1e-3, fit * scale);
            return (
              <div className="vt-resize-stage">
                {frames.length === 0 || !shownSize ? (
                  <div className="vt-empty">
                    {blocked ?? (running ? `Reading frame ${running.done} of ${running.total}…` : data.marks.length > 0 ? `Read the frames to see the background and the ${data.marks.length} mark(s) on it.` : 'Read the frames to find the background.')}
                  </div>
                ) : (
                  <div className="vt-crop-frame">
                    <canvas ref={picture} className="vt-crop-canvas" style={{ imageRendering: 'pixelated' }} />
                    <canvas ref={tint} className="vt-crop-canvas is-over" style={{ display: current && showTint ? 'block' : 'none' }} />
                    {current ? (
                      <svg
                        ref={setSvg}
                        className="vt-crop-overlay vt-bg-marks"
                        viewBox={`0 0 ${shownSize.width} ${shownSize.height}`}
                        style={{ cursor: 'crosshair' }}
                        onPointerDown={onPointerDown}
                        onDoubleClick={() => finishRegion()}
                      >
                        {marksHere.map((mark) =>
                          mark.kind === 'region' ? (
                            <polygon key={mark.id} className={`vt-bg-mark is-${mark.mode}`} points={flat(mark.points)} strokeWidth={1.5 * unit} />
                          ) : (
                            <polyline key={mark.id} className={`vt-bg-stroke is-${mark.mode}`} points={flat(mark.points.length === 2 ? [...mark.points, ...mark.points] : mark.points)} strokeWidth={mark.radius * 2} />
                          ),
                        )}
                        {stroke ? (
                          <polyline className={`vt-bg-stroke is-${data.tool === 'erase' ? 'exclude' : 'include'} is-live`} points={flat(stroke.length === 2 ? [...stroke, ...stroke] : stroke)} strokeWidth={data.brush * 2} />
                        ) : null}
                        {region.length >= 2 ? <polygon className="vt-bg-mark is-include is-live" points={flat(region)} strokeWidth={1.5 * unit} /> : null}
                        {region.length >= 2
                          ? Array.from({ length: region.length / 2 }, (_, i) => <circle key={i} cx={region[i * 2]} cy={region[i * 2 + 1]} r={3 * unit} className="vt-bg-node" />)
                          : null}
                      </svg>
                    ) : null}
                  </div>
                )}
              </div>
            );
          }}
        </Stage>

        {frames.length > 0 ? (
          <div className="vt-bg-strip" role="listbox" aria-label="Frames">
            <button type="button" className={`vt-bg-thumb is-background${!current ? ' is-on' : ''}`} onClick={() => patch({ current: null })}>
              Background
            </button>
            {frames.map((frame) => {
              const marked = data.marks.some((mark) => nearestFrame(frames, mark.time) === frame);
              return (
                <button
                  key={frame.time}
                  type="button"
                  role="option"
                  aria-selected={current === frame}
                  className={`vt-bg-thumb${current === frame ? ' is-on' : ''}${marked ? ' is-marked' : ''}`}
                  title={`Frame at ${clock(frame.time)}${marked ? ' · marked' : ''}`}
                  onClick={() => patch({ current: frame.time })}
                >
                  <img src={frame.thumb} alt={`Frame at ${clock(frame.time)}`} draggable={false} />
                  <span>{clock(frame.time)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
