import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyMarks,
  backgroundFrameSize,
  backgroundInFrame,
  backgroundReport,
  backgroundWork,
  emptyVideoBackgroundFlowData,
  nearestFrame,
  newId,
  pickFrameTimes,
  steadyWork,
  videoSourceOf,
  type BackgroundMark,
  type BackgroundOptions,
  type BackgroundProgress,
  type BackgroundResult,
  type Bitmap,
  type FlowNode,
  type FrameOffset,
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
import { openVideoFrames, useVideoFrameTimes, type VideoFrames } from '../common/frames';
import { inSlices, utf8Base64 } from '../common/slices';
import { paintBitmap, svgPoint, useFitScale } from './CropFlowEditor';
import { EditorShell } from './EditorShell';

interface ReadFrame {
  time: number;
  bitmap: Bitmap;
  thumb: string;
}

/** A see-through tint over what is already background, on a frame where the background sits at `offset`. */
function tintOf(result: BackgroundResult, offset: FrameOffset): Bitmap {
  const { width, height } = result.image;
  const shown = backgroundInFrame(result, offset);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p += 1) if (shown[p]) out.set([60, 200, 120, 90], p * 4);
  return { width, height, data: out };
}

const optionsOf = (data: VideoBackgroundFlowData): BackgroundOptions => ({
  tolerance: data.tolerance,
  agreement: data.agreement,
  steady: data.steady,
  maxShift: data.maxShift,
  rebuild: data.rebuild,
  patch: data.patch,
});

const STAGES: Record<BackgroundProgress['stage'], string> = {
  steady: 'Lining the frames up',
  still: 'Finding what never changes',
  patches: 'Rebuilding what moved',
};

/** Where the background sits in each frame, worked out once for each set of frames and reach. */
async function offsetsFor(
  frames: readonly ReadFrame[],
  data: VideoBackgroundFlowData,
  known: { key: string; frames: readonly ReadFrame[]; offsets: FrameOffset[] } | null,
  onProgress: (progress: BackgroundProgress) => void,
  cancelled: () => boolean,
): Promise<{ key: string; frames: readonly ReadFrame[]; offsets: FrameOffset[] } | null> {
  const key = data.steady ? `steady:${data.maxShift}` : 'still';
  if (known && known.frames === frames && known.key === key) return known;
  if (!data.steady) return { key, frames, offsets: frames.map(() => ({ dx: 0, dy: 0 })) };
  const offsets = await inSlices(steadyWork(frames.map((frame) => frame.bitmap), data.maxShift), onProgress, cancelled);
  return offsets ? { key, frames, offsets } : null;
}

const flat = (points: number[]) => Array.from({ length: points.length / 2 }, (_, i) => `${points[i * 2]},${points[i * 2 + 1]}`).join(' ');

/**
 * Taking the background out of a video.
 *
 * The frames are read here, exactly as the file holds them, and kept while
 * the editor is open. They are lined up with each other, the pixels that never
 * change are the background, and what moved is rebuilt patch by patch from the
 * frames that show the background there (see `backgroundWork`); pick a frame
 * to paint, erase or draw round what it shows, and it is put in (or taken
 * out) from that frame.
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
  // The clip is probed for when each of its frames is shown; the frames read are picked from those.
  const { probe, error: videoError } = useVideoFrameTimes(videoUrl);
  const meta = probe && probe.url === videoUrl ? probe.facts : null;
  const upload = useFileUpload((fileName, body) => uploadOutput(node.id, 'source', fileName, body), (message) => notify('error', message));
  const times = useMemo(() => (probe && probe.url === videoUrl ? pickFrameTimes(probe.times, data.sampling) : []), [probe, videoUrl, data.sampling]);

  /* ---------------- reading the frames ---------------- */

  const [frames, setFrames] = useState<ReadFrame[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const stopping = useRef(false);
  const read = useCallback(async (): Promise<ReadFrame[]> => {
    if (!videoUrl || !source) return [];
    stopping.current = false;
    // Each frame is taken from the clip as it holds it: decoded from the file
    // where this browser can, else shown and drawn (see `openVideoFrames`).
    // The times are worked out from the clip opened here, not from the one
    // probed for the editor: going from one item of a batch to the next, that
    // can still be the item before.
    let clip: VideoFrames;
    let times: number[];
    try {
      clip = await openVideoFrames(videoUrl);
      times = pickFrameTimes(await clip.frameTimes(), dataRef.current.sampling);
    } catch (reason) {
      notify('error', `Could not read the video: ${(reason as Error).message}`);
      return [];
    }
    const facts = clip.facts;
    const size = backgroundFrameSize(facts, times.length);
    setRunning({ done: 0, total: times.length });
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const thumbHeight = Math.max(1, Math.round((96 * size.height) / size.width));
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 96;
    thumbCanvas.height = thumbHeight;
    const thumbContext = thumbCanvas.getContext('2d')!;
    const got: ReadFrame[] = [];
    try {
      await clip.read(
        times,
        ({ time, image }) => {
          context.clearRect(0, 0, size.width, size.height);
          context.drawImage(image, 0, 0, size.width, size.height);
          const pixels = context.getImageData(0, 0, size.width, size.height);
          thumbContext.drawImage(canvas, 0, 0, 96, thumbHeight);
          got.push({ time, bitmap: { width: size.width, height: size.height, data: pixels.data }, thumb: thumbCanvas.toDataURL('image/jpeg', 0.6) });
          setRunning({ done: got.length, total: times.length });
        },
        () => stopping.current,
      );
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
      video: { hash: source.artifact.hash, duration: facts.duration, width: facts.width, height: facts.height },
      frameSize: size,
      // Marks are in frame pixels, so they only carry over at the same size.
      ...(sameVideo ? {} : { marks: [], current: null }),
    });
    return got;
  }, [notify, patch, source, videoUrl]);

  /* ---------------- the background ---------------- */

  // Lined up, what never changes, and what moved rebuilt: redone, a slice at
  // a time, when the frames or the settings change. The frames are lined up
  // again only when they or the reach change.
  const [base, setBase] = useState<BackgroundResult | null>(null);
  const [working, setWorking] = useState<BackgroundProgress | null>(null);
  const steadied = useRef<{ key: string; frames: readonly ReadFrame[]; offsets: FrameOffset[] } | null>(null);
  const { tolerance, agreement, steady, maxShift, rebuild, patch: patchSize } = data;
  useEffect(() => {
    if (frames.length === 0) {
      setBase(null);
      return undefined;
    }
    let cancelled = false;
    const settings = { ...dataRef.current, tolerance, agreement, steady, maxShift, rebuild, patch: patchSize };
    const timer = window.setTimeout(() => {
      void (async () => {
        setWorking({ stage: steady ? 'steady' : 'still', done: 0, total: 1 });
        const lined = await offsetsFor(frames, settings, steadied.current, setWorking, () => cancelled);
        if (!lined || cancelled) return;
        steadied.current = lined;
        const made = await inSlices(backgroundWork(frames.map((frame) => frame.bitmap), optionsOf(settings), lined.offsets), setWorking, () => cancelled);
        if (!made || cancelled) return;
        setBase(made);
        setWorking(null);
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [frames, tolerance, agreement, steady, maxShift, rebuild, patchSize]);

  // And the marks laid over it, each moved by where the background sits in its frame.
  const frameAt = useCallback(
    (result: BackgroundResult, list: readonly ReadFrame[]) => (time: number) => {
      const found = nearestFrame(list, time);
      if (!found) return undefined;
      return { bitmap: found.bitmap, offset: result.offsets[list.indexOf(found)] ?? { dx: 0, dy: 0 } };
    },
    [],
  );
  const result = useMemo(() => (base ? applyMarks(base, data.marks, frameAt(base, frames)) : null), [base, data.marks, frames, frameAt]);

  /* ---------------- what is shown ---------------- */

  const current = data.current !== null ? nearestFrame(frames, data.current) : undefined;
  const shownSize = data.frameSize ?? (frames[0] ? { width: frames[0].bitmap.width, height: frames[0].bitmap.height } : null);
  const picture = useRef<HTMLCanvasElement | null>(null);
  const tint = useRef<HTMLCanvasElement | null>(null);
  const [showTint, setShowTint] = useState(true);
  const currentOffset = current && result ? (result.offsets[frames.indexOf(current)] ?? { dx: 0, dy: 0 }) : null;
  useEffect(() => {
    paintBitmap(picture.current, current ? current.bitmap : (result?.image ?? null));
    paintBitmap(tint.current, current && result && currentOffset && showTint ? tintOf(result, currentOffset) : null);
  }, [current, result, currentOffset?.dx, currentOffset?.dy, showTint]);

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
        { name: 'background.md', data: `data:text/markdown;base64,${utf8Base64(backgroundReport(dataRef.current, result.stats, frames.map((frame, index) => ({ time: frame.time, offset: result.offsets[index]! }))))}` },
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
    const lined = await offsetsFor(got, settings, steadied.current, setWorking, () => false);
    const built = lined ? await inSlices(backgroundWork(got.map((frame) => frame.bitmap), optionsOf(settings), lined.offsets), setWorking, () => false) : null;
    setWorking(null);
    if (!built) throw new Error('the background could not be worked out');
    const made = applyMarks(built, settings.marks, frameAt(built, got));
    await generateFlow(node.id, [
      { name: 'background.png', data: await pngDataUrl(made.image) },
      { name: 'background.md', data: `data:text/markdown;base64,${utf8Base64(backgroundReport(dataRef.current, made.stats, got.map((frame, index) => ({ time: frame.time, offset: made.offsets[index]! }))))}` },
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
          <p className="vt-hint">
            The frames are lined up with each other, so a camera that shakes or drifts does not count as change. A pixel that never changes is the background. What changed is
            rebuilt patch by patch: the biggest group of frames that show the same in a patch, frames side by side counting more, if it is in at least the agreement share of
            them. Anything else is left clear.
          </p>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.steady} onChange={(event) => patch({ steady: event.target.checked })} />
            Follow the camera
          </label>
          {data.steady ? (
            <Slider
              range="videoBackground.maxShift"
              label="Most it moves between frames"
              tip="videoBackground.maxShift"
              value={data.maxShift}
              format={(value) => `${Math.round(value)} px`}
              onChange={(maxShift) => patch({ maxShift: Math.round(maxShift) })}
            />
          ) : null}
          <Slider
            range="videoBackground.tolerance"
            label="Tolerance"
            tip="videoBackground.tolerance"
            value={data.tolerance}
            format={(value) => `${Math.round(value)}`}
            onChange={(tolerance) => patch({ tolerance: Math.round(tolerance) })}
          />
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.rebuild} onChange={(event) => patch({ rebuild: event.target.checked })} />
            Rebuild what moved from patches
          </label>
          {data.rebuild ? (
            <>
              <Slider range="videoBackground.patch" label="Patch" tip="videoBackground.patch" value={data.patch} format={(value) => `${Math.round(value)} px`} onChange={(size) => patch({ patch: Math.round(size) })} />
              <Slider
                range="videoBackground.agreement"
                label="Agreement"
                tip="videoBackground.agreement"
                value={data.agreement}
                format={(value) => `${Math.round(value)}% of frames`}
                onChange={(agreement) => patch({ agreement: Math.round(agreement) })}
              />
            </>
          ) : null}
          {working ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <span className="vt-faint" style={{ fontSize: 11 }}>{STAGES[working.stage]}…</span>
              <progress max={working.total} value={working.done} style={{ flex: 1 }} />
            </div>
          ) : null}
          <dl className="vt-kv">
            <dt>Moved</dt>
            <dd>{result ? (data.steady ? (result.stats.moved > 0 ? `up to ${result.stats.moved} px` : 'not at all') : 'not followed') : '—'}</dd>
            <dt>Never changed</dt>
            <dd>{result ? share(result.stats.still) : '—'}</dd>
            <dt>Rebuilt</dt>
            <dd>{result ? share(result.stats.rebuilt) : '—'}</dd>
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
