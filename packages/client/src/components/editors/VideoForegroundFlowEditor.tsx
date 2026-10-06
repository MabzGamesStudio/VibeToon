import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  emptyVideoForegroundFlowData,
  foregroundFile,
  foregroundFrameLimit,
  foregroundFrameName,
  foregroundReport,
  foregroundWork,
  alignToBackgroundWork,
  inputsForPort,
  nearestFrame,
  noVideoMessage,
  pickFrameTimes,
  videoSourceOf,
  type Bitmap,
  type FlowNode,
  type ForegroundFrame,
  type ForegroundOptions,
  type FrameOffset,
  type Project,
  type VideoForegroundFlowData,
  type VideoSampling,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useBatchRun, waitUntil } from '../../state/batchRun';
import { useStudio } from '../../state/store';
import { pngDataUrl, readBitmap } from '../common/pixels';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { clock } from '../common/video';
import { openVideoFrames, useVideoFrameTimes, type VideoFrames } from '../common/frames';
import { inSlices, textDataUrl } from '../common/slices';
import { paintBitmap } from './CropFlowEditor';
import { EditorShell } from './EditorShell';

interface ReadFrame {
  time: number;
  bitmap: Bitmap;
  thumb: string;
}

const optionsOf = (data: VideoForegroundFlowData): ForegroundOptions => ({
  steady: data.steady,
  maxShift: data.maxShift,
  tolerance: data.tolerance,
  speck: data.speck,
  holes: data.holes,
  grow: data.grow,
  unknown: data.unknown,
});

const STAGES: Record<string, string> = { steady: 'Lining the frames up', apart: 'Taking the background out' };

/** A mask as a picture: what is kept white, the rest black. */
function maskBitmap(frame: ForegroundFrame): Bitmap {
  const { width, height } = frame.image;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < frame.mask.length; p += 1) {
    const v = frame.mask[p] ? 255 : 0;
    data.set([v, v, v, 255], p * 4);
  }
  return { width, height, data };
}

/** The picture a URL holds, read once for each URL. */
function useBitmap(url: string | null): { bitmap: Bitmap | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; bitmap: Bitmap | null; error: string | null }>({ url: null, bitmap: null, error: null });
  useEffect(() => {
    setState({ url, bitmap: null, error: null });
    if (!url) return undefined;
    let cancelled = false;
    readBitmap(url, { maxPixels: 16_000_000 })
      .then((bitmap) => {
        if (!cancelled) setState({ url, bitmap, error: null });
      })
      .catch((reason: Error) => {
        if (!cancelled) setState({ url, bitmap: null, error: reason.message });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state.url === url ? { bitmap: state.bitmap, error: state.error } : { bitmap: null, error: null };
}

/**
 * Taking the background out of a video, so only what moves is left.
 *
 * The frames are read here at the background's size and kept while the
 * editor is open; each is lined up with the background and every pixel that
 * matches it made clear (see `foregroundOf`). The settings work on the frames
 * read, a slice at a time, so the page stays responsive.
 */
export function VideoForegroundFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, notify, generateFlow } = useStudio();
  const data = node.data.editor === 'videoForeground' ? (node.data as VideoForegroundFlowData) : emptyVideoForegroundFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<VideoForegroundFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const setSampling = (over: Partial<VideoSampling>) => patch({ sampling: { ...data.sampling, ...over } });

  const source = videoSourceOf(project, node);
  const videoUrl = source ? api.artifactUrl(project.id, source.artifact.path) : null;
  const { probe, error: videoError } = useVideoFrameTimes(videoUrl);
  const meta = probe && probe.url === videoUrl ? probe.facts : null;

  const backgroundRef = inputsForPort(project, node.id, 'background').find((input) => input.artifact)?.artifact;
  const backgroundPath = backgroundRef ? (backgroundRef.entries?.[0] ? `${backgroundRef.path}/${backgroundRef.entries[0]}` : backgroundRef.path) : '';
  const backgroundUrl = backgroundPath ? api.artifactUrl(project.id, backgroundPath) : null;
  const { bitmap: background, error: backgroundError } = useBitmap(backgroundUrl);
  const limit = background ? foregroundFrameLimit(background.width, background.height) : 0;

  /** The frames to read: as the sampling asks, no more than fit. */
  const planTimes = useCallback(
    (frameTimes: readonly number[], sampling: VideoSampling, most: number) => {
      const wanted = pickFrameTimes(frameTimes, sampling);
      return wanted.length <= most ? wanted : pickFrameTimes(frameTimes, { ...sampling, mode: 'total', total: most });
    },
    [],
  );
  const times = useMemo(() => (probe && probe.url === videoUrl && limit > 0 ? planTimes(probe.times, data.sampling, limit) : []), [probe, videoUrl, limit, data.sampling, planTimes]);

  /* ---------------- reading the frames ---------------- */

  const [frames, setFrames] = useState<ReadFrame[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const stopping = useRef(false);
  const read = useCallback(async (): Promise<ReadFrame[]> => {
    if (!videoUrl || !source || !background) return [];
    stopping.current = false;
    let clip: VideoFrames;
    let wanted: number[];
    try {
      clip = await openVideoFrames(videoUrl);
      wanted = planTimes(await clip.frameTimes(), dataRef.current.sampling, foregroundFrameLimit(background.width, background.height));
    } catch (reason) {
      notify('error', `Could not read the video: ${(reason as Error).message}`);
      return [];
    }
    const facts = clip.facts;
    if (facts.width > 0 && Math.abs(facts.width / facts.height - background.width / background.height) > 0.02) {
      notify('info', `The video is ${facts.width} × ${facts.height} and the background ${background.width} × ${background.height}: not the same shape, so the frames are stretched to fit it.`);
    }
    const { width, height } = background;
    setRunning({ done: 0, total: wanted.length });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const thumbHeight = Math.max(1, Math.round((96 * height) / width));
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 96;
    thumbCanvas.height = thumbHeight;
    const thumbContext = thumbCanvas.getContext('2d')!;
    const got: ReadFrame[] = [];
    try {
      await clip.read(
        wanted,
        ({ time, image }) => {
          context.clearRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height);
          thumbContext.drawImage(canvas, 0, 0, 96, thumbHeight);
          got.push({ time, bitmap: { width, height, data: pixels.data }, thumb: thumbCanvas.toDataURL('image/jpeg', 0.6) });
          setRunning({ done: got.length, total: wanted.length });
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
    patch({
      video: { hash: source.artifact.hash, duration: facts.duration, width: facts.width, height: facts.height },
      background: { hash: backgroundRef?.hash, width, height },
    });
    return got;
  }, [background, backgroundRef?.hash, notify, patch, planTimes, source, videoUrl]);

  /* ---------------- taking the background out ---------------- */

  const [results, setResults] = useState<ForegroundFrame[]>([]);
  const [working, setWorking] = useState<{ stage: string; done: number; total: number } | null>(null);
  const lined = useRef<{ key: string; frames: readonly ReadFrame[]; background: Bitmap; offsets: FrameOffset[] } | null>(null);

  /** The frames taken apart with these settings, lining them up again only when the frames, background or reach change. */
  const work = useCallback(
    async (list: readonly ReadFrame[], plate: Bitmap, settings: VideoForegroundFlowData, cancelled: () => boolean): Promise<ForegroundFrame[] | null> => {
      const key = settings.steady ? `steady:${settings.maxShift}` : 'still';
      let offsets: FrameOffset[];
      const known = lined.current;
      if (known && known.frames === list && known.background === plate && known.key === key) offsets = known.offsets;
      else if (!settings.steady) offsets = list.map(() => ({ dx: 0, dy: 0 }));
      else {
        const found = await inSlices(alignToBackgroundWork(plate, list.map((frame) => frame.bitmap), settings.maxShift), setWorking, cancelled);
        if (!found) return null;
        offsets = found;
      }
      lined.current = { key, frames: list, background: plate, offsets };
      return inSlices(foregroundWork(plate, list.map((frame) => frame.bitmap), optionsOf(settings), offsets), setWorking, cancelled);
    },
    [],
  );

  const { steady, maxShift, tolerance, speck, holes, grow, unknown } = data;
  useEffect(() => {
    if (frames.length === 0 || !background) {
      setResults([]);
      return undefined;
    }
    let cancelled = false;
    const settings = { ...dataRef.current, steady, maxShift, tolerance, speck, holes, grow, unknown };
    const timer = window.setTimeout(() => {
      void (async () => {
        setWorking({ stage: steady ? 'steady' : 'apart', done: 0, total: 1 });
        const made = await work(frames, background, settings, () => cancelled);
        if (!made || cancelled) return;
        setResults(made);
        setWorking(null);
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [frames, background, steady, maxShift, tolerance, speck, holes, grow, unknown, work]);

  const summaries = (list: readonly ReadFrame[], made: readonly ForegroundFrame[]) =>
    made.map((frame, index) => ({ time: list[index]!.time, offset: frame.offset, kept: frame.stats.kept, total: frame.stats.total, pieces: frame.stats.pieces }));

  const send = async (list: readonly ReadFrame[], made: readonly ForegroundFrame[]) => {
    const attachments = await Promise.all(made.map(async (frame, index) => ({ name: `frames/${foregroundFrameName(index, list[index]!.time)}`, data: await pngDataUrl(frame.image) })));
    const sums = summaries(list, made);
    attachments.push({ name: 'foreground.json', data: textDataUrl(foregroundFile(dataRef.current, sums), 'application/json') });
    attachments.push({ name: 'foreground.md', data: textDataUrl(foregroundReport(dataRef.current, sums)) });
    await generateFlow(node.id, attachments);
  };

  const onGenerate = async () => {
    if (results.length === 0 || results.length !== frames.length) {
      await generateFlow(node.id);
      return;
    }
    try {
      await send(frames, results);
    } catch (reason) {
      notify('error', `Could not write the frames: ${(reason as Error).message}`);
    }
  };

  // Generate all, for one item of a batch: read its frames, take its background out, and send them.
  const readRef = useRef(read);
  readRef.current = read;
  const ready = useRef({ meta, videoError, background, backgroundError, frames });
  ready.current = { meta, videoError, background, backgroundError, frames };
  useBatchRun(node, async () => {
    await waitUntil(() => (ready.current.meta && ready.current.background) ?? (ready.current.videoError || ready.current.backgroundError ? 'failed' : null), 'Reading the video and the background');
    if (!ready.current.meta) throw new Error(`the video could not be read: ${ready.current.videoError}`);
    if (!ready.current.background) throw new Error(`the background could not be read: ${ready.current.backgroundError}`);
    const got = ready.current.frames.length > 0 ? ready.current.frames : await readRef.current();
    if (got.length === 0) throw new Error('no frames could be read');
    const made = await work(got, ready.current.background, dataRef.current, () => false);
    setWorking(null);
    if (!made) throw new Error('the frames could not be taken apart');
    await send(got, made);
  });

  /* ---------------- what is shown ---------------- */

  const shown = data.current !== null ? nearestFrame(frames, data.current) : frames[0];
  const shownIndex = shown ? frames.indexOf(shown) : -1;
  const shownResult = shownIndex >= 0 ? results[shownIndex] : undefined;
  const picture = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!shown) {
      paintBitmap(picture.current, null);
      return;
    }
    if (data.view === 'frame' || !shownResult) paintBitmap(picture.current, shown.bitmap);
    else paintBitmap(picture.current, data.view === 'mask' ? maskBitmap(shownResult) : shownResult.image);
  }, [shown, shownResult, data.view]);

  const keptShare = results.length > 0 ? results.reduce((sum, frame) => sum + frame.stats.kept, 0) / results.reduce((sum, frame) => sum + frame.stats.total, 0) : null;
  const moved = results.reduce((most, frame) => Math.max(most, Math.hypot(frame.offset.dx, frame.offset.dy)), 0);
  const blocked = !source
    ? noVideoMessage(project, node)
    : !backgroundRef
      ? 'No background — wire one into the Background input (Video Background makes one from the same clip).'
      : videoError
        ? `The video could not be read: ${videoError}.`
        : backgroundError
          ? `The background could not be read: ${backgroundError}.`
          : null;

  return (
    <EditorShell project={project} node={node} onGenerate={onGenerate} banner={blocked ? <div className="vt-sync-banner"><span>{blocked}</span></div> : undefined}>
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
            <Slider range="videoForeground.fps" label="Frames a second" tip="videoForeground.sampling" value={data.sampling.fps} format={(value) => `${value.toFixed(1)} a second`} onChange={(fps) => setSampling({ fps: Math.round(fps * 10) / 10 })} />
          ) : (
            <Slider range="videoForeground.total" label="Frames in all" tip="videoForeground.sampling" value={data.sampling.total} format={(value) => `${Math.round(value)}`} onChange={(total) => setSampling({ total: Math.round(total) })} />
          )}
          <p className="vt-faint" style={{ fontSize: 11 }}>
            {meta && background ? `${times.length} frame(s) from a ${meta.duration.toFixed(2)}s video, read at the background's ${background.width} × ${background.height}${times.length >= limit ? ` (at most ${limit} fit)` : ''}.` : '—'}
          </p>
          {running ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <progress max={running.total} value={running.done} style={{ flex: 1 }} />
              <button type="button" className="vt-btn is-small" onClick={() => (stopping.current = true)}>
                Stop
              </button>
            </div>
          ) : (
            <button type="button" className="vt-btn is-primary is-small" disabled={!meta || !background} onClick={() => void read()}>
              {frames.length > 0 ? 'Read the frames again' : 'Read the frames'}
            </button>
          )}
        </div>

        <div className="vt-section">
          <h3>Taking the background out</h3>
          <p className="vt-hint">
            Each frame is lined up with the background, and every pixel whose colour is within the tolerance of the background’s there is made clear. Specks are dropped and
            holes filled, so what is left is the characters.
          </p>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.steady} onChange={(event) => patch({ steady: event.target.checked })} />
            Follow the camera
          </label>
          {data.steady ? (
            <Slider range="videoForeground.maxShift" label="Most it moves between frames" tip="videoForeground.maxShift" value={data.maxShift} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ maxShift: Math.round(value) })} />
          ) : null}
          <Slider range="videoForeground.tolerance" label="Tolerance" tip="videoForeground.tolerance" value={data.tolerance} format={(value) => `${Math.round(value)}`} onChange={(value) => patch({ tolerance: Math.round(value) })} />
          <Slider range="videoForeground.speck" label="Drop specks under" tip="videoForeground.speck" value={data.speck} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ speck: Math.round(value) })} />
          <Slider range="videoForeground.holes" label="Fill holes up to" tip="videoForeground.holes" value={data.holes} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ holes: Math.round(value) })} />
          <Slider range="videoForeground.grow" label="Grow" tip="videoForeground.grow" value={data.grow} format={(value) => `${Math.round(value)} px`} onChange={(value) => patch({ grow: Math.round(value) })} />
          <div className="vt-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="vt-faint">Where the background is clear</span>
            <div className="vt-facet-values" role="radiogroup" aria-label="Where the background is clear">
              {(
                [
                  ['keep', 'Keep the frame'],
                  ['clear', 'Clear it'],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" className={`vt-chip${data.unknown === value ? ' is-on' : ''}`} aria-pressed={data.unknown === value} onClick={() => patch({ unknown: value })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {working ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <span className="vt-faint" style={{ fontSize: 11 }}>{STAGES[working.stage] ?? 'Working'}…</span>
              <progress max={working.total} value={working.done} style={{ flex: 1 }} />
            </div>
          ) : null}
          <dl className="vt-kv">
            <dt>Moved</dt>
            <dd>{results.length > 0 ? (data.steady ? (moved > 0 ? `up to ${moved.toFixed(1)} px` : 'not at all') : 'not followed') : '—'}</dd>
            <dt>Kept</dt>
            <dd>{keptShare !== null ? `${(keptShare * 100).toFixed(1)}% of the pixels` : '—'}</dd>
            <dt>This frame</dt>
            <dd>{shownResult ? `${((shownResult.stats.kept / shownResult.stats.total) * 100).toFixed(1)}% kept, ${shownResult.stats.pieces} piece(s)` : '—'}</dd>
          </dl>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title={shown ? `Frame at ${clock(shown.time)}` : 'Frames'}
          tools={
            <div className="vt-facet-values" role="radiogroup" aria-label="Show">
              {(
                [
                  ['cutout', 'What is kept'],
                  ['frame', 'The frame'],
                  ['mask', 'The mask'],
                ] as const
              ).map(([view, label]) => (
                <button key={view} type="button" className={`vt-chip${data.view === view ? ' is-on' : ''}`} aria-pressed={data.view === view} onClick={() => patch({ view })}>
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {() => (
            <div className="vt-resize-stage">
              {frames.length === 0 ? (
                <div className="vt-empty">{blocked ?? (running ? `Reading frame ${running.done} of ${running.total}…` : 'Read the frames to take the background out of them.')}</div>
              ) : (
                <div className="vt-crop-frame">
                  <canvas ref={picture} className="vt-crop-canvas" style={{ imageRendering: 'pixelated' }} />
                </div>
              )}
            </div>
          )}
        </Stage>

        {frames.length > 0 ? (
          <div className="vt-bg-strip" role="listbox" aria-label="Frames">
            {frames.map((frame, index) => (
              <button
                key={frame.time}
                type="button"
                role="option"
                aria-selected={shown === frame}
                className={`vt-bg-thumb${shown === frame ? ' is-on' : ''}`}
                title={`Frame at ${clock(frame.time)}${results[index] ? ` · ${((results[index]!.stats.kept / results[index]!.stats.total) * 100).toFixed(1)}% kept` : ''}`}
                onClick={() => patch({ current: frame.time })}
              >
                <img src={frame.thumb} alt={`Frame at ${clock(frame.time)}`} draggable={false} />
                <span>{clock(frame.time)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
