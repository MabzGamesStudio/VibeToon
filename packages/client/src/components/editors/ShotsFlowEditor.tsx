import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adoptDetection,
  detectShots,
  embedFrame,
  emptyShotsFlowData,
  joinShots,
  shotClipName,
  shotClipsWanted,
  shotsKey,
  shotsOf,
  splitShotAt,
  summariseShots,
  videoSourceOf,
  type FlowNode,
  type Project,
  type ShotOptions,
  type ShotsFlowData,
  type VideoSampling,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useBatchRun, waitUntil } from '../../state/batchRun';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { FrameReader, VideoUpload, clock, loadVideo, releaseVideo, useFileUpload, useVideoMeta } from '../common/video';
import { EditorShell } from './EditorShell';
import { ShotViewer } from './ShotViewer';
import { blobDataUrl, recordingType, renderEdit, type RenderProgress } from './renderVideo';

/** Frames are compared this small: enough for an 8 × 8 picture and a colour histogram. */
const EMBED_WIDTH = 96;
/** Preview frames are drawn this tall. */
const THUMB_HEIGHT = 54;

/**
 * Splitting a video into shots, then putting them right by hand.
 *
 * Each shot is a row of frames, as long as the shot is. Click in a row to split
 * it at that frame; join a shot to the next with the button beside it.
 */
export function ShotsFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, notify, uploadOutput, generateFlow } = useStudio();
  const data = node.data.editor === 'shots' ? (node.data as ShotsFlowData) : emptyShotsFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<ShotsFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const setOptions = (over: Partial<ShotOptions>) => patch({ options: { ...data.options, ...over } });
  const setSampling = (over: Partial<VideoSampling>) => patch({ sampling: { ...data.sampling, ...over } });

  const source = videoSourceOf(project, node);
  const videoUrl = source ? api.artifactUrl(project.id, source.artifact.path) : null;
  const { meta, error: videoError } = useVideoMeta(videoUrl);
  const upload = useFileUpload((fileName, body) => uploadOutput(node.id, 'source', fileName, body), (message) => notify('error', message));

  /* ---------------- finding the shots ---------------- */

  const [running, setRunning] = useState<{ stage: string; fraction: number } | null>(null);
  const stopping = useRef(false);
  const find = useCallback(async (): Promise<boolean> => {
    if (!videoUrl || !meta || !source) return false;
    stopping.current = false;
    setRunning({ stage: 'Reading the video', fraction: 0 });
    let video: HTMLVideoElement;
    try {
      video = await loadVideo(videoUrl);
    } catch (reason) {
      setRunning(null);
      notify('error', `Could not read the video: ${(reason as Error).message}`);
      return false;
    }
    const width = Math.min(EMBED_WIDTH, meta.width);
    const reader = new FrameReader(video, width, Math.max(1, Math.round((meta.height * width) / meta.width)));
    const start = dataRef.current;
    try {
      const found = await detectShots(
        meta.duration,
        start.sampling,
        start.options,
        async (time) => {
          if (stopping.current) throw new Error('stopped');
          return embedFrame(await reader.read(time));
        },
        (done, total) => setRunning({ stage: `Comparing frames: ${done} of ${total}`, fraction: done / total }),
      );
      patch(adoptDetection(dataRef.current, found, { hash: source.artifact.hash, duration: meta.duration, width: meta.width, height: meta.height }));
      notify('success', `${found.cuts.length + 1} shot(s), from ${found.looks} frame(s) looked at.`);
      return true;
    } catch (reason) {
      if ((reason as Error).message !== 'stopped') notify('error', `Could not split the video: ${(reason as Error).message}`);
      return false;
    } finally {
      releaseVideo(video);
      setRunning(null);
    }
  }, [meta, notify, patch, source, videoUrl]);

  /* ---------------- writing ---------------- */

  // With "each shot as a video" on, Generate plays each shot through and
  // records it: a clip per shot, in a folder that goes on as a batch.
  const [recording, setRecording] = useState<RenderProgress | null>(null);
  const clipsWanted = shotClipsWanted(project, node);
  const clipsWiredTo = project.connections
    .filter((connection) => connection.from.nodeId === node.id && connection.from.portId === 'clips')
    .map((connection) => project.nodes.find((candidate) => candidate.id === connection.to.nodeId)?.name)
    .filter(Boolean);
  const stopRecording = useRef(false);
  const onGenerate = async () => {
    const current = dataRef.current;
    if (!clipsWanted || !current.video || !videoUrl) {
      await generateFlow(node.id);
      return;
    }
    if (!recordingType()) {
      notify('error', 'This browser cannot record video, so only the shots are written.');
      await generateFlow(node.id);
      return;
    }
    const cut = shotsOf(current.cuts, current.video.duration);
    stopRecording.current = false;
    setRecording({ done: 0, total: current.video.duration, clip: 0 });
    try {
      const blobs = await renderEdit({
        url: videoUrl,
        segments: cut.map((shot) => ({ ...shot, deleted: false })),
        crop: { x: 0, y: 0, width: current.video.width - (current.video.width % 2), height: current.video.height - (current.video.height % 2) },
        fps: current.options.fps,
        mode: 'clips',
        onProgress: setRecording,
        stopped: () => stopRecording.current,
      });
      if (stopRecording.current) {
        notify('info', 'Stopped. Nothing was written.');
        return;
      }
      const attachments = await Promise.all(blobs.map(async (blob, index) => ({ name: `shots/${shotClipName(index)}`, data: await blobDataUrl(blob) })));
      await generateFlow(node.id, attachments);
    } catch (reason) {
      notify('error', `Could not record the shots: ${(reason as Error).message}`);
    } finally {
      setRecording(null);
    }
  };

  // Generate all, for one video of a batch: find its shots if they are not
  // found yet, then write them.
  const ready = useRef({ meta, videoError, find, found: Boolean(data.video && data.video.hash === source?.artifact.hash) });
  ready.current = { meta, videoError, find, found: Boolean(data.video && data.video.hash === source?.artifact.hash) };
  useBatchRun(node, async () => {
    await waitUntil(() => ready.current.meta ?? (ready.current.videoError ? 'failed' : null), 'Reading the video');
    if (!ready.current.meta) throw new Error(`the video could not be read: ${ready.current.videoError}`);
    if (!ready.current.found && !(await ready.current.find())) throw new Error('its shots could not be found');
    // The shots found are in the settings by the next render.
    await waitUntil(() => dataRef.current.video !== undefined, 'Finding the shots');
    await onGenerateRef.current();
  });
  const onGenerateRef = useRef(onGenerate);
  onGenerateRef.current = onGenerate;

  /* ---------------- the rows ---------------- */

  const duration = data.video?.duration ?? meta?.duration ?? 0;
  const shots = useMemo(() => shotsOf(data.cuts, duration), [data.cuts, duration]);
  const longest = shots.reduce((most, shot) => Math.max(most, shot.end - shot.start), 0);
  const aspect = meta && meta.width > 0 ? meta.width / meta.height : data.video ? data.video.width / data.video.height : 16 / 9;
  const thumbWidth = Math.round(THUMB_HEIGHT * aspect);

  // How many pixels a second of video is drawn at. Starts so the longest shot
  // fills the width; the slider changes it.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [available, setAvailable] = useState(900);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setAvailable(Math.max(200, element.clientWidth - 150)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pxPerSecond = scale ?? (longest > 0 ? Math.max(8, Math.min(600, available / longest)) : 60);

  // Preview frames, read one at a time, kept for as long as the editor is open.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** Where a row's tiles start: one preview frame for each tile's width of the row. */
  const tileTimes = useCallback(
    (shot: { start: number; end: number }) => {
      const width = Math.max(thumbWidth / 2, (shot.end - shot.start) * pxPerSecond);
      return Array.from({ length: Math.max(1, Math.ceil(width / thumbWidth)) }, (_, tile) => Math.round((shot.start + (tile * thumbWidth) / pxPerSecond) * 100) / 100);
    },
    [pxPerSecond, thumbWidth],
  );
  const wanted = useMemo(() => shots.flatMap(tileTimes).slice(0, 2000), [shots, tileTimes]);
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  useEffect(() => {
    if (!videoUrl || !meta || running) return undefined;
    const missing = wanted.filter((time) => !thumbsRef.current[time.toFixed(2)]);
    if (missing.length === 0) return undefined;
    let cancelled = false;
    void (async () => {
      let video: HTMLVideoElement | null = null;
      try {
        video = await loadVideo(videoUrl);
        const reader = new FrameReader(video, thumbWidth, THUMB_HEIGHT);
        let batch: Record<string, string> = {};
        for (let i = 0; i < missing.length && !cancelled; i += 1) {
          batch[missing[i]!.toFixed(2)] = await reader.thumbnail(missing[i]!);
          if (i % 8 === 7 || i === missing.length - 1) {
            const add = batch;
            batch = {};
            if (!cancelled) setThumbs((current) => ({ ...current, ...add }));
          }
        }
      } catch {
        // Previews are a nicety; the rows work without them.
      } finally {
        if (video) releaseVideo(video);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wanted, videoUrl, meta, running, thumbWidth]);

  const [hover, setHover] = useState<{ shot: number; time: number } | null>(null);
  // The shot shown large, and where a click on its row asked it to go.
  // Kept here, not in the flow: looking at a shot changes nothing it writes.
  const [viewed, setViewed] = useState<number | null>(null);
  const viewing = viewed !== null && viewed < shots.length ? viewed : null;
  const [seek, setSeek] = useState<{ time: number } | null>(null);
  const select = (index: number | null) => setViewed(index);
  const splitAt = (time: number) => {
    const next = splitShotAt(dataRef.current, time);
    if (next === dataRef.current) notify('info', 'That is where the shot already starts or ends.');
    else patch(next);
  };
  const strength = new Map(data.detected.map((cut) => [cut.time, cut.difference]));

  const blocked = !source ? 'Wire a video into the Video input, or upload one here.' : videoError ? `The video could not be read: ${videoError}.` : null;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={
        blocked ? (
          <div className="vt-sync-banner"><span>{blocked}</span></div>
        ) : recording ? (
          <div className="vt-sync-banner">
            <span>
              Recording shot {recording.clip + 1}, {clock(recording.done)} of {clock(recording.total)}…
            </span>
            <progress max={recording.total} value={recording.done} style={{ flex: 1, maxWidth: 240 }} />
            <button type="button" className="vt-btn is-small" onClick={() => (stopRecording.current = true)}>
              Stop
            </button>
          </div>
        ) : clipsWanted && data.video && data.recorded !== shotsKey(data) ? (
          <div className="vt-sync-banner">
            <span>
              {data.recorded
                ? 'The shots have changed since their clips were recorded.'
                : `Each shot is to be recorded as a video${clipsWiredTo.length > 0 ? ` for ${clipsWiredTo.join(', ')}` : ''}, and has not been yet.`}{' '}
              Generate to record them.
            </span>
          </div>
        ) : undefined
      }
      actions={source?.wired ? undefined : <VideoUpload replace={Boolean(source)} onFile={upload} />}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The video</h3>
          <dl className="vt-kv">
            <dt>Length</dt>
            <dd>{meta ? `${meta.duration.toFixed(2)}s` : '—'}</dd>
            <dt>Size</dt>
            <dd>{meta ? `${meta.width} × ${meta.height}` : '—'}</dd>
          </dl>
          <Field label="Frame rate" tip="shots.frameRate" hint="What a cut is found to: the frame it falls on.">
            <input
              type="number"
              min={1}
              max={240}
              value={data.options.fps}
              aria-label="Frame rate"
              onChange={(event) => setOptions({ fps: Math.max(1, Math.min(240, Number(event.target.value) || 24)) })}
            />
          </Field>
        </div>

        <div className="vt-section">
          <h3>Finding the cuts</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Compare frames">
            {(
              [
                ['fps', 'So many a second'],
                ['total', 'So many in all'],
              ] as const
            ).map(([mode, label]) => (
              <button key={mode} type="button" className={`vt-chip${data.sampling.mode === mode ? ' is-on' : ''}`} aria-pressed={data.sampling.mode === mode} onClick={() => setSampling({ mode })}>
                {label}
              </button>
            ))}
          </div>
          {data.sampling.mode === 'fps' ? (
            <Slider range="shots.fps" label="Compare every" tip="shots.sampling" value={data.sampling.fps} format={(value) => `${value.toFixed(2)} a second`} onChange={(fps) => setSampling({ fps: Math.round(fps * 100) / 100 })} />
          ) : (
            <Slider range="shots.total" label="Frames compared" tip="shots.sampling" value={data.sampling.total} format={(value) => `${Math.round(value)} in all`} onChange={(total) => setSampling({ total: Math.round(total) })} />
          )}
          <Slider
            range="shots.threshold"
            label="A cut is a difference of"
            tip="shots.threshold"
            value={data.options.threshold}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(threshold) => setOptions({ threshold: Math.round(threshold * 100) / 100 })}
          />
          <Slider
            range="shots.minShot"
            label="Shortest shot"
            tip="shots.minShot"
            value={data.options.minShot}
            format={(value) => `${value.toFixed(1)}s`}
            onChange={(minShot) => setOptions({ minShot: Math.round(minShot * 10) / 10 })}
          />
          {running ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <progress max={1} value={running.fraction} style={{ flex: 1 }} />
              <button type="button" className="vt-btn is-small" onClick={() => (stopping.current = true)}>
                Stop
              </button>
            </div>
          ) : (
            <button type="button" className="vt-btn is-primary is-small" disabled={!meta} onClick={() => void find()}>
              {data.video ? 'Find the shots again' : 'Find the shots'}
            </button>
          )}
          {running ? <p className="vt-faint" style={{ fontSize: 11 }}>{running.stage}</p> : null}
          {data.video && data.edits > 0 ? <p className="vt-hint">Finding them again replaces the {data.edits} change(s) made by hand.</p> : null}
        </div>

        <div className="vt-section">
          <h3>What comes out</h3>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={clipsWanted} disabled={clipsWiredTo.length > 0} onChange={(event) => patch({ clips: event.target.checked })} />
            Each shot as a video of its own
          </label>
          {clipsWiredTo.length > 0 ? (
            <p className="vt-faint" style={{ fontSize: 11 }}>
              On, because Shot clips is wired to {clipsWiredTo.join(', ')}.
            </p>
          ) : null}
          <p className="vt-hint">
            {clipsWanted
              ? 'Generate records each shot onto the Shot clips port, as a folder of videos. Wire it into a flow that takes one video — Video Background, say — and each shot goes through it on its own, as a batch. Recording takes as long as the video.'
              : 'The shots are written as times, in shots.json. Tick this to have each one as a video too, to send them on as a batch.'}
          </p>
        </div>

        <div className="vt-section">
          <h3>Shots</h3>
          <p className="vt-faint" style={{ fontSize: 11 }}>{summariseShots(data)}</p>
          {shots.length > 0 ? (
            <Slider
              range="shots.scale"
              label="Row scale"
              tip="shots.scale"
              value={pxPerSecond}
              format={(value) => `${Math.round(value)} px a second`}
              onChange={(value) => setScale(Math.round(value))}
            />
          ) : null}
        </div>
      </aside>

      <div className="vt-editor-main" ref={listRef}>
        {!data.video ? (
          <div className="vt-empty">{blocked ?? 'Press Find the shots to split the video.'}</div>
        ) : (
          <div className="vt-shot-list">
            {viewing !== null && videoUrl ? (
              <ShotViewer
                videoUrl={videoUrl}
                shots={shots}
                index={viewing}
                fps={data.options.fps}
                tiles={tileTimes(shots[viewing]!).map((time) => thumbs[time.toFixed(2)])}
                seek={seek}
                onSelect={select}
                onSplit={splitAt}
              />
            ) : (
              <p className="vt-hint" style={{ margin: '0 0 8px' }}>
                Click a shot to see it large, slide through it and step it a frame at a time. Shift-click a shot’s frames to split it there.
              </p>
            )}
            {shots.map((shot, index) => {
              const width = Math.max(thumbWidth / 2, (shot.end - shot.start) * pxPerSecond);
              const into = index === 0 ? null : strength.get(shot.start);
              return (
                <div key={`${shot.start}`} className={`vt-shot-row${viewing === index ? ' is-selected' : ''}`}>
                  <div className="vt-shot-head" onClick={() => select(index)} style={{ cursor: 'pointer' }}>
                    <strong>Shot {index + 1}</strong>
                    <span className="vt-faint">
                      {clock(shot.start)} – {clock(shot.end)}
                    </span>
                    <span>{(shot.end - shot.start).toFixed(2)}s</span>
                    {index > 0 ? <span className="vt-faint">{into !== undefined && into !== null ? `cut ${Math.round(into * 100)}%` : 'cut by hand'}</span> : null}
                  </div>
                  <div
                    className="vt-shot-strip"
                    style={{ width }}
                    title="Click to see this shot here, large. Shift-click to split it here."
                    onPointerMove={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      const time = shot.start + ((event.clientX - box.left) / box.width) * (shot.end - shot.start);
                      setHover({ shot: index, time: Math.round(time * data.options.fps) / data.options.fps });
                    }}
                    onPointerLeave={() => setHover(null)}
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      const time = shot.start + ((event.clientX - box.left) / box.width) * (shot.end - shot.start);
                      if (event.shiftKey) {
                        splitAt(Math.round(time * data.options.fps) / data.options.fps);
                        return;
                      }
                      if (viewing !== index) select(index);
                      setSeek({ time });
                    }}
                  >
                    {tileTimes(shot).map((time, tile) => {
                      const url = thumbs[time.toFixed(2)];
                      return (
                        <div key={tile} className="vt-shot-tile" style={{ width: thumbWidth, height: THUMB_HEIGHT }}>
                          {url ? <img src={url} alt="" draggable={false} /> : null}
                        </div>
                      );
                    })}
                    {hover && hover.shot === index ? (
                      <div className="vt-shot-cursor" style={{ left: `${((hover.time - shot.start) / (shot.end - shot.start)) * 100}%` }}>
                        <span>{clock(hover.time)}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="vt-shot-actions">
                    <button type="button" className={`vt-btn is-small${viewing === index ? ' is-active' : ''}`} onClick={() => select(viewing === index ? null : index)}>
                      {viewing === index ? 'Viewing' : 'View'}
                    </button>
                    {index < shots.length - 1 ? (
                      <button type="button" className="vt-btn is-small" title="Join this shot and the next into one" onClick={() => patch(joinShots(dataRef.current, index))}>
                        Join with next
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </EditorShell>
  );
}
