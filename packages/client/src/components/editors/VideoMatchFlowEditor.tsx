import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confidenceLabel,
  emptyVideoMatchFlowData,
  fitAt,
  fittedBones,
  fittedImage,
  frameFound,
  frameTimes,
  inputsForPort,
  readBoundRig,
  segmentsOf,
  shapePath,
  summariseVideoMatch,
  videoMatchState,
  matchFrameName,
  videoSourceOf,
  type FlowNode,
  type Project,
  type RigFit,
  type RigMatchOptions,
  type VideoFrame,
  type VideoMatchFlowData,
  type VideoSampling,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { onScreen } from '../common/handles';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { pngDataUrl } from '../common/pixels';
import { FrameReader, loadVideo, releaseVideo, seek } from '../common/video';
import { EditorShell } from './EditorShell';
import type { MatchReply, MatchRequest } from './rigMatch/matchWorker';

/** Frames are read no wider than this: the match works on at most 384 pixels across anyway. */
const FRAME_WIDTH = 480;

/** How often a long run saves what it has, in frames. */
const SAVE_EVERY = 4;

function confidenceColor(value: number | null | undefined): string {
  if (value === null || value === undefined) return '#8a93a6';
  const hue = Math.round(Math.max(0, Math.min(1, value)) * 120);
  return `hsl(${hue} 75% 50%)`;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

/**
 * Finding a bound rig through a video.
 *
 * The video is sampled into frames and the Rig Match run on each, in a
 * worker, with the settings here. Each frame found starts from where the last
 * one left the body; a frame below the confidence threshold is taken not to
 * show the character, and the animation is split there. The result plays back
 * as the body and its skeleton alone, or over the video.
 */
export function VideoMatchFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, notify, uploadOutput, generateFlow } = useStudio();
  const data = node.data.editor === 'videoMatch' ? (node.data as VideoMatchFlowData) : emptyVideoMatchFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback(
    (over: Partial<VideoMatchFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }),
    [node.id, setFlowData],
  );

  const boundArtifact = inputsForPort(project, node.id, 'bound').find((input) => input.artifact)?.artifact;
  const source = videoSourceOf(project, node);
  const videoUrl = source ? api.artifactUrl(project.id, source.artifact.path) : null;
  const state = videoMatchState(data, boundArtifact?.hash, source?.artifact.hash);
  const bound = data.bound;

  /* ---------------- the video's own measurements ---------------- */

  const [meta, setMeta] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  useEffect(() => {
    setMeta(null);
    setVideoError(null);
    if (!videoUrl) return undefined;
    let cancelled = false;
    loadVideo(videoUrl)
      .then((video) => {
        if (!cancelled) setMeta({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
        video.removeAttribute('src');
        video.load();
      })
      .catch((error: Error) => {
        if (!cancelled) setVideoError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [videoUrl]);

  const duration = meta?.duration ?? data.video?.duration ?? 0;
  const times = useMemo(() => frameTimes(duration, data.sampling), [duration, data.sampling]);
  const frameSize = data.frameSize ?? (meta && meta.width > 0 ? { width: Math.min(FRAME_WIDTH, meta.width), height: Math.round((meta.height * Math.min(FRAME_WIDTH, meta.width)) / meta.width) } : null);

  /* ---------------- taking the body in ---------------- */

  const takeIn = useCallback(async () => {
    if (!boundArtifact) return;
    try {
      const read = readBoundRig(await (await fetch(api.artifactUrl(project.id, boundArtifact.path))).json());
      if (!read) {
        notify('error', 'That file is not a bound rig this editor can read.');
        return;
      }
      patch({ bound: read, boundHash: boundArtifact.hash });
      notify('success', `Took in ${read.rig.bones.length} bone(s).`);
    } catch (error) {
      notify('error', `Could not read that: ${(error as Error).message}`);
    }
  }, [boundArtifact, notify, patch, project.id]);

  const upload = useCallback(
    (file: File) => void uploadOutput(node.id, 'source', file.name, file),
    [node.id, uploadOutput],
  );

  /* ---------------- matching every frame ---------------- */

  const worker = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const stopping = useRef(false);
  const [running, setRunning] = useState<{ index: number; count: number; stage: string; fraction: number } | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);

  /** One match in the worker, as a promise. */
  const matchFrame = useCallback(
    (bodyKey: string, pixels: ImageData, options: RigMatchOptions, from: RigFit | undefined, onProgress: (stage: string, fraction: number) => void) =>
      new Promise<Extract<MatchReply, { type: 'done' }>>((resolve, reject) => {
        const now = dataRef.current;
        if (!now.bound) {
          reject(new Error('nothing taken in'));
          return;
        }
        if (!worker.current) worker.current = new Worker(new URL('./rigMatch/matchWorker.ts', import.meta.url), { type: 'module' });
        const id = (requestId.current += 1);
        const buffer = pixels.data.slice().buffer;
        const request: MatchRequest = {
          type: 'match',
          id,
          key: bodyKey,
          bound: now.bound,
          picture: { width: pixels.width, height: pixels.height, pixels: buffer },
          options,
          freshPicture: true,
          ...(from ? { from } : {}),
        };
        worker.current.onmessage = (event: MessageEvent<MatchReply>) => {
          const reply = event.data;
          if (reply.id !== id) return;
          if (reply.type === 'progress') onProgress(reply.stage, reply.fraction);
          else if (reply.type === 'done') resolve(reply);
          else if (reply.type === 'error') reject(new Error(reply.message));
        };
        worker.current.postMessage(request, [buffer]);
      }),
    [],
  );

  const run = useCallback(
    async (onlyMissing: boolean) => {
      const start = dataRef.current;
      if (!start.bound || !videoUrl || !source || !meta) return;
      const wanted = frameTimes(meta.duration, start.sampling);
      if (wanted.length === 0) return;
      const width = Math.min(FRAME_WIDTH, meta.width);
      const size = { width, height: Math.max(1, Math.round((meta.height * width) / meta.width)) };
      const sameVideo = start.video?.hash === source.artifact.hash && start.frameSize?.width === size.width;
      let frames: VideoFrame[] = onlyMissing && sameVideo ? start.frames.filter((frame) => wanted.includes(frame.time)) : [];
      const done = new Set(frames.map((frame) => frame.time));
      const video = { hash: source.artifact.hash, duration: meta.duration, width: meta.width, height: meta.height };
      const save = () =>
        patch({ frames: [...frames].sort((a, b) => a.time - b.time), video, frameSize: size, matchedAt: new Date().toISOString() });

      stopping.current = false;
      setRunning({ index: 0, count: wanted.length, stage: 'Reading the video', fraction: 0 });
      let element: HTMLVideoElement;
      try {
        element = await loadVideo(videoUrl);
      } catch (error) {
        notify('error', `Could not read the video: ${(error as Error).message}`);
        setRunning(null);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const bodyKey = `${start.boundHash ?? ''}|video`;
      const threshold = start.threshold;
      let sinceSave = 0;
      try {
        for (let index = 0; index < wanted.length; index += 1) {
          if (stopping.current) break;
          const time = wanted[index]!;
          if (done.has(time)) continue;
          setRunning({ index, count: wanted.length, stage: 'Reading the frame', fraction: 0 });
          await seek(element, time);
          context.drawImage(element, 0, 0, size.width, size.height);
          const pixels = context.getImageData(0, 0, size.width, size.height);
          // Start where the frame before left the body, if it was found there.
          const before = frames.filter((frame) => frame.time < time).sort((a, b) => b.time - a.time)[0];
          const from = before && frameFound(before, threshold) ? before.fit! : undefined;
          const progress = (stage: string, fraction: number) => setRunning({ index, count: wanted.length, stage, fraction });
          let frame: VideoFrame;
          try {
            let result = await matchFrame(bodyKey, pixels, start.options, from, progress);
            let followed = Boolean(from);
            // Followed and lost: the character may have jumped. Look everywhere.
            if (from && result.report.confidence < threshold && !stopping.current) {
              const fresh = await matchFrame(bodyKey, pixels, start.options, undefined, progress);
              if (fresh.report.confidence > result.report.confidence) {
                result = fresh;
                followed = false;
              }
            }
            frame = {
              time,
              fit: result.fit,
              confidence: result.report.confidence,
              parts: Object.fromEntries(Object.entries(result.report.parts).map(([id, part]) => [id, part.confidence])),
              ...(followed ? { followed: true } : {}),
            };
          } catch {
            frame = { time, fit: null, confidence: 0 };
          }
          frames = [...frames, frame];
          done.add(time);
          sinceSave += 1;
          if (sinceSave >= SAVE_EVERY) {
            save();
            sinceSave = 0;
          }
        }
      } finally {
        save();
        setRunning(null);
        element.removeAttribute('src');
        element.load();
      }
      const found = frames.filter((frame) => frameFound(frame, threshold)).length;
      notify(
        stopping.current ? 'info' : found > 0 ? 'success' : 'warn',
        `${stopping.current ? 'Stopped: ' : ''}${frames.length} of ${wanted.length} frame(s) matched; the body was found in ${found}.`,
      );
    },
    [matchFrame, meta, notify, patch, source, videoUrl],
  );

  const stop = () => {
    stopping.current = true;
  };

  /* ---------------- playing it back ---------------- */

  const segments = useMemo(() => segmentsOf(data.frames, data.threshold), [data.frames, data.threshold]);
  const step = data.frames.length > 1 ? duration / Math.max(1, data.frames.length) : duration;
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  timeRef.current = time;
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const shown = useMemo(() => (bound ? fitAt(data.frames, segments, time, step / 2) : null), [bound, data.frames, segments, step, time]);
  const bones = useMemo(() => (bound && shown ? fittedBones(bound.rig, shown.fit) : new Map()), [bound, shown]);
  const drawing = useMemo(() => (bound && shown && frameSize ? fittedImage(bound, shown.fit, frameSize) : null), [bound, frameSize, shown]);
  const playerVideo = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!playing || duration <= 0) return undefined;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      const next = timeRef.current + dt;
      if (next < duration) setTime(next);
      else if (loop) setTime(0);
      else {
        setTime(duration);
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [duration, loop, playing, speed]);

  // The video under the body follows the playhead.
  useEffect(() => {
    const video = playerVideo.current;
    if (!video || !data.showVideo) return;
    if (Math.abs(video.currentTime - time) > 0.08) video.currentTime = time;
  }, [data.showVideo, time]);

  /* ---------------- what is shown ---------------- */

  const setOption = <K extends keyof RigMatchOptions>(key: K, value: RigMatchOptions[K]) => patch({ options: { ...data.options, [key]: value } });
  const setSampling = (over: Partial<VideoSampling>) => patch({ sampling: { ...data.sampling, ...over } });
  const found = data.frames.filter((frame) => frameFound(frame, data.threshold)).length;
  const missing = times.filter((one) => !data.frames.some((frame) => frame.time === one)).length;

  const blocked = !boundArtifact
    ? 'Wire a Rig Binding flow into the Bound rig input.'
    : !source
      ? 'Wire a video into the Video input, or upload one here.'
      : videoError
        ? `The video could not be read: ${videoError}.`
        : null;

  const uploadButton = (
    <label className="vt-btn is-small" title="Upload a video onto this flow’s own Video port">
      {source && !source.wired ? 'Replace the video' : 'Upload a video'}
      <input
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload(file);
          event.target.value = '';
        }}
      />
    </label>
  );

  // Generate also writes the frames that were matched, as pictures: a folder
  // that goes on as a batch, a frame at a time.
  const [writingFrames, setWritingFrames] = useState<number | null>(null);
  const onGenerate = async () => {
    const current = dataRef.current;
    if (!videoUrl || !current.frameSize || current.frames.length === 0) {
      await generateFlow(node.id);
      return;
    }
    let video: HTMLVideoElement | null = null;
    const attachments: Array<{ name: string; data: string }> = [];
    try {
      video = await loadVideo(videoUrl);
      const reader = new FrameReader(video, current.frameSize.width, current.frameSize.height);
      for (const [index, frame] of current.frames.entries()) {
        setWritingFrames(index);
        attachments.push({ name: `frames/${matchFrameName(index)}`, data: await pngDataUrl(await reader.read(frame.time)) });
      }
    } catch (reason) {
      notify('error', `Could not read the frames: ${(reason as Error).message}. The animation is written without them.`);
    } finally {
      if (video) releaseVideo(video);
      setWritingFrames(null);
    }
    await generateFlow(node.id, attachments);
  };

  return (
    <EditorShell
      onGenerate={onGenerate}
      project={project}
      node={node}
      actions={source?.wired ? undefined : uploadButton}
      banner={
        blocked ? (
          <div className="vt-sync-banner">
            <span>{blocked}</span>
            {!source ? uploadButton : null}
          </div>
        ) : writingFrames !== null ? (
          <div className="vt-sync-banner">
            <span>
              Writing the frames: {writingFrames + 1} of {data.frames.length}…
            </span>
          </div>
        ) : state === 'none' ? (
          <div className="vt-sync-banner">
            <span>Nothing taken in yet.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take it in
            </button>
          </div>
        ) : state === 'stale' ? (
          <div className="vt-sync-banner">
            <span>The body, the video or the frames to sample have changed since these frames were matched.</span>
            <button type="button" className="vt-btn is-small" onClick={() => void takeIn()}>
              Take the body in again
            </button>
          </div>
        ) : undefined
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Frames</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Sample the video by">
            {(
              [
                ['fps', 'A second'],
                ['total', 'In all'],
              ] as const
            ).map(([mode, label]) => (
              <button key={mode} type="button" className={`vt-chip${data.sampling.mode === mode ? ' is-on' : ''}`} aria-pressed={data.sampling.mode === mode} onClick={() => setSampling({ mode })}>
                {label}
              </button>
            ))}
          </div>
          {data.sampling.mode === 'fps' ? (
            <Slider
              range="videoMatch.fps"
              label="Frames a second"
              tip="videoMatch.sampling"
              value={data.sampling.fps}
              format={(value) => `${value} a second`}
              onChange={(fps) => setSampling({ fps })}
            />
          ) : (
            <Slider
              range="videoMatch.total"
              label="Frames in all"
              tip="videoMatch.sampling"
              value={data.sampling.total}
              format={(value) => `${Math.round(value)} frames`}
              onChange={(total) => setSampling({ total: Math.round(total) })}
            />
          )}
          <p className="vt-faint" style={{ fontSize: 11 }}>
            {duration > 0 ? `${times.length} frame(s) from ${duration.toFixed(1)}s of video.` : 'The video’s length is not known yet.'}
          </p>
        </div>

        <div className="vt-section">
          <h3>Finding the body</h3>
          <Slider
            range="videoMatch.features"
            label="Features per part"
            tip="rigMatch.features"
            value={data.options.features}
            format={(value) => `${Math.round(value)}`}
            onChange={(value) => setOption('features', Math.round(value))}
          />
          <Slider
            range="videoMatch.scaleRange"
            label="Range in size"
            tip="rigMatch.scaleRange"
            value={data.options.scaleRange}
            format={(value) => `×${value.toFixed(1)}`}
            onChange={(value) => setOption('scaleRange', value)}
          />
          <Slider
            range="videoMatch.angleRange"
            label="Range in angle"
            tip="rigMatch.angleRange"
            value={data.options.angleRange}
            format={(value) => (value < 1 ? 'upright only' : `±${Math.round(value)}°`)}
            onChange={(value) => setOption('angleRange', Math.round(value))}
          />
          <Field label="Joints" tip="rigMatch.keepLimits">
            <label className="vt-row" style={{ gap: 6 }}>
              <input type="checkbox" checked={data.options.keepLimits} onChange={(event) => setOption('keepLimits', event.target.checked)} />
              Keep to each joint’s range of motion
            </label>
          </Field>
          <Slider
            range="videoMatch.threshold"
            label="Found at confidence"
            tip="videoMatch.threshold"
            value={data.threshold}
            format={(value) => `${Math.round(value * 100)}% and up`}
            hint="Frames below this are dropped, and the animation is split there."
            onChange={(threshold) => patch({ threshold })}
          />
          <div className="vt-row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" className="vt-btn is-primary" disabled={!bound || !meta || Boolean(running)} onClick={() => void run(false)}>
              Match every frame
            </button>
            {data.frames.length > 0 && missing > 0 && state !== 'stale' ? (
              <button type="button" className="vt-btn" disabled={!bound || !meta || Boolean(running)} onClick={() => void run(true)}>
                Match the other {missing}
              </button>
            ) : null}
          </div>
          {running ? (
            <div className="vt-match-progress" role="status">
              <div className="vt-match-bar">
                <span style={{ width: `${Math.round(((running.index + running.fraction) / running.count) * 100)}%` }} />
              </div>
              <div className="vt-row" style={{ gap: 6 }}>
                <span className="vt-faint">
                  Frame {running.index + 1} of {running.count} · {running.stage}…
                </span>
                <span className="vt-spacer" />
                <button type="button" className="vt-btn is-small is-ghost" onClick={stop}>
                  Stop
                </button>
              </div>
            </div>
          ) : (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
              {summariseVideoMatch(data)}
            </p>
          )}
        </div>

        <div className="vt-section">
          <h3>Segments ({segments.length})</h3>
          {segments.length === 0 ? (
            <p className="vt-faint" style={{ fontSize: 11 }}>
              {data.frames.length === 0 ? 'Match the frames to find where the character is.' : 'The body was not found in any frame at this threshold.'}
            </p>
          ) : (
            <div className="vt-match-parts">
              {segments.map((segment, index) => (
                <button
                  key={`${segment.start}-${segment.end}`}
                  type="button"
                  className={`vt-match-part${shown?.segment === index ? ' is-selected' : ''}`}
                  title="Play this segment"
                  onClick={() => {
                    setTime(segment.start);
                    setPlaying(true);
                  }}
                >
                  <span className="vt-match-part-name">
                    {index + 1}. {clock(segment.start)}–{clock(segment.end)}
                  </span>
                  <span className="vt-match-part-bar">
                    <span style={{ width: `${Math.round(segment.confidence * 100)}%`, background: confidenceColor(segment.confidence) }} />
                  </span>
                  <span className="vt-faint">{segment.frames.length} fr</span>
                </button>
              ))}
            </div>
          )}
          {data.frames.length > 0 ? (
            <p className="vt-faint" style={{ fontSize: 11 }}>
              Found in {found} of {data.frames.length} frame(s); {data.frames.length - found} dropped.
            </p>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>Show</h3>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showBody} aria-label="Show the body" onChange={(event) => patch({ showBody: event.target.checked })} />
            The body
          </label>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showSkeleton} aria-label="Show the skeleton" onChange={(event) => patch({ showSkeleton: event.target.checked })} />
            The skeleton
          </label>
          <label className="vt-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={data.showVideo} aria-label="Show the video" onChange={(event) => patch({ showVideo: event.target.checked })} />
            The video underneath
          </label>
          {data.showBody && data.showVideo ? (
            <Slider
              range="videoMatch.bodyOpacity"
              label="Body over the video"
              value={data.bodyOpacity}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={(bodyOpacity) => patch({ bodyOpacity })}
            />
          ) : null}
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          zoomable
          title="The rig animation"
          tools={
            <div className="vt-row" style={{ gap: 6 }}>
              <button type="button" className="vt-btn is-small" disabled={duration <= 0} aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((was) => !was)}>
                {playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <select value={speed} aria-label="Speed" onChange={(event) => setSpeed(Number(event.target.value))}>
                {[0.25, 0.5, 1, 2].map((value) => (
                  <option key={value} value={value}>
                    ×{value}
                  </option>
                ))}
              </select>
              <label className="vt-row" style={{ gap: 4, fontSize: 11 }}>
                <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
                Loop
              </label>
              <span className="vt-faint" style={{ fontSize: 11, minWidth: 120, whiteSpace: 'nowrap' }}>
                {clock(time)} / {clock(duration)}
                {shown ? ` · segment ${shown.segment + 1}` : data.frames.length > 0 ? ' · not found here' : ''}
              </span>
            </div>
          }
        >
          {({ scale }) => (
            <div className="vt-vector-stage vt-video-stage">
              {frameSize ? (
                <div className="vt-vector-frame vt-video-frame" style={{ aspectRatio: `${frameSize.width} / ${frameSize.height}` }}>
                  {data.showVideo && videoUrl ? <video ref={playerVideo} className="vt-video-under" src={videoUrl} muted playsInline preload="auto" /> : null}
                  <svg className="vt-vector-svg" viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} preserveAspectRatio="xMidYMid meet">
                    {data.showBody && drawing ? (
                      <g opacity={data.showVideo ? data.bodyOpacity : 1} className="vt-match-body">
                        {drawing.shapes.map((shape) =>
                          shape.kind === 'polygon' ? (
                            <path key={shape.id} d={shapePath(shape)} fill={shape.color} fillRule="evenodd" />
                          ) : (
                            <path key={shape.id} d={shapePath(shape)} fill="none" stroke={shape.color} strokeWidth={shape.width} strokeLinecap="round" strokeLinejoin="round" />
                          ),
                        )}
                      </g>
                    ) : null}
                    {data.showSkeleton
                      ? [...bones.entries()].map(([id, bone]) => (
                          <g key={id}>
                            <line x1={bone.from.x} y1={bone.from.y} x2={bone.to.x} y2={bone.to.y} strokeWidth={onScreen(2.5, scale)} className="vt-bone" />
                            <circle cx={bone.from.x} cy={bone.from.y} r={onScreen(3, scale)} strokeWidth={onScreen(1, scale)} className="vt-joint" />
                          </g>
                        ))
                      : null}
                  </svg>
                  {!shown && data.frames.length > 0 ? <div className="vt-video-absent">Not found here</div> : null}
                </div>
              ) : (
                <div className="vt-empty">{blocked ?? (videoUrl ? 'Reading the video…' : 'No video yet.')}</div>
              )}
            </div>
          )}
        </Stage>

        {duration > 0 ? (
          <div
            className="vt-video-track"
            role="slider"
            aria-label="Time"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={time}
            tabIndex={0}
            onPointerDown={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const at = (x: number) => Math.max(0, Math.min(duration, ((x - box.left) / box.width) * duration));
              setTime(at(event.clientX));
              const move = (moveEvent: PointerEvent) => setTime(at(moveEvent.clientX));
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          >
            {segments.map((segment) => (
              <span
                key={`${segment.start}-${segment.end}`}
                className="vt-video-segment"
                style={{
                  left: `${(segment.start / duration) * 100}%`,
                  width: `${Math.max(0.4, ((segment.end + step / 2 - segment.start) / duration) * 100)}%`,
                  background: confidenceColor(segment.confidence),
                }}
              />
            ))}
            {data.frames.map((frame) => (
              <span
                key={frame.time}
                className={`vt-video-tick${frameFound(frame, data.threshold) ? '' : ' is-dropped'}`}
                style={{ left: `${(frame.time / duration) * 100}%` }}
                title={`${clock(frame.time)} · ${confidenceLabel(frame.confidence)}${frame.followed ? ' · followed from the frame before' : ''}`}
              />
            ))}
            <span className="vt-video-head" style={{ left: `${(time / duration) * 100}%` }} />
          </div>
        ) : null}
        <p className="vt-faint" style={{ marginTop: 8, fontSize: 11 }}>
          {summariseVideoMatch(data)}
        </p>
      </div>
    </EditorShell>
  );
}
