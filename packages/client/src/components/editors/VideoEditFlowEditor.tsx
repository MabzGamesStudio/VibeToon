import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CROP_HANDLES,
  DEFAULT_SHOT_OPTIONS,
  DEFAULT_VIDEO_SAMPLING,
  clampEditView,
  clipName,
  detectShots,
  editShotCuts,
  editViewShowing,
  embedFrame,
  filmstripFrames,
  panEditView,
  rulerTicks,
  snapToFrame,
  splitAtCuts,
  stepFrame,
  zoomEditView,
  dragHandle,
  editKey,
  editSegments,
  editedDuration,
  emptyVideoEditFlowData,
  joinSegments,
  keptSegments,
  moveRect,
  normaliseRect,
  clampRect,
  playOnFrom,
  splitSegmentAt,
  summariseEdit,
  toggleSegment,
  videoCropRect,
  videoSourceOf,
  type CropHandle,
  type CropRect,
  type EditView,
  type FlowNode,
  type Project,
  type VideoEditFlowData,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useBatchRun, waitUntil } from '../../state/batchRun';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { FrameReader, VideoUpload, clock, loadVideo, releaseVideo, useFileUpload, useFrameThumbnails, useVideoMeta } from '../common/video';
import { svgPoint, useFitScale } from './CropFlowEditor';
import { EditorShell } from './EditorShell';
import { blobDataUrl, recordingType, renderEdit, type RenderProgress } from './renderVideo';

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

/** How tall the filmstrip's pictures are, in pixels. */
const THUMB_HEIGHT = 40;
/** Shots are looked for in frames this wide. */
const EMBED_WIDTH = 96;
/** And compared twice a second, each cut then found to the frame. */
const SHOT_SAMPLING = { ...DEFAULT_VIDEO_SAMPLING, mode: 'fps' as const, fps: 2 };

/** A ruler mark's label: whole seconds when the marks are, hundredths when not. */
function tickLabel(time: number, step: number): string {
  const whole = step >= 1;
  return `${Math.floor(time / 60)}:${(time % 60).toFixed(whole ? 0 : 2).padStart(whole ? 2 : 5, '0')}`;
}

type Held = { kind: 'handle'; handle: CropHandle; from: CropRect } | { kind: 'move'; from: CropRect; start: { x: number; y: number } } | { kind: 'draw'; start: { x: number; y: number } };

/**
 * Cutting a video: a crop over the picture, and a timeline under it — a ruler
 * with the shots found in the video, a filmstrip of its frames, and the row of
 * segments to split, delete and join. Drag along the timeline to scrub, ← and →
 * to step a frame; the wheel zooms it and a drag with Shift (or the bar under
 * it) pans. The video plays here, and plays the edit — skipping what is
 * deleted — when asked. Generate records the edit here and writes it.
 */
export function VideoEditFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData, notify, uploadOutput, generateFlow } = useStudio();
  const data = node.data.editor === 'videoEdit' ? (node.data as VideoEditFlowData) : emptyVideoEditFlowData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((over: Partial<VideoEditFlowData>) => setFlowData(node.id, { ...dataRef.current, ...over }), [node.id, setFlowData]);
  const apply = useCallback((next: VideoEditFlowData) => setFlowData(node.id, next), [node.id, setFlowData]);

  const source = videoSourceOf(project, node);
  const videoUrl = source ? api.artifactUrl(project.id, source.artifact.path) : null;
  const { meta, error: videoError } = useVideoMeta(videoUrl);
  const upload = useFileUpload((fileName, body) => uploadOutput(node.id, 'source', fileName, body), (message) => notify('error', message));

  // Take the video's measurements the first time it is seen.
  useEffect(() => {
    if (!meta || !source) return;
    const was = dataRef.current.video;
    if (was && was.hash === source.artifact.hash && was.duration === meta.duration) return;
    const video = { hash: source.artifact.hash, duration: Math.round(meta.duration * 1000) / 1000, width: meta.width, height: meta.height };
    // A different video: its old segments and crop were for another picture.
    patch(was && was.hash !== source.artifact.hash ? { video, segments: [], crop: null, selected: null } : { video });
  }, [meta, source, patch]);

  const duration = data.video?.duration ?? 0;
  const segments = editSegments(data, duration);
  const crop = videoCropRect(data);
  const size = data.video ? { width: data.video.width, height: data.video.height } : null;

  /* ---------------- playing ---------------- */

  const player = useRef<HTMLVideoElement | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editOnly, setEditOnly] = useState(true);
  useEffect(() => {
    const video = player.current;
    if (!video) return undefined;
    let frame = 0;
    const tick = () => {
      const at = video.currentTime;
      setNow(at);
      if (!video.paused && editOnly) {
        const onward = playOnFrom(dataRef.current, at);
        if (onward === null) video.pause();
        else if (onward > at + 0.01) video.currentTime = onward;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [editOnly, videoUrl]);
  const togglePlay = () => {
    const video = player.current;
    if (!video) return;
    if (video.paused) {
      if (editOnly) {
        const onward = playOnFrom(dataRef.current, video.currentTime);
        video.currentTime = onward ?? keptSegments(dataRef.current)[0]?.start ?? 0;
      }
      void video.play();
    } else video.pause();
  };
  const seekTo = (time: number) => {
    const at = Math.max(0, Math.min(duration, time));
    if (player.current) player.current.currentTime = at;
    setNow(at);
  };
  /** Pause, and step `by` frames from the frame showing. */
  const stepBy = (by: number) => {
    const video = player.current;
    if (!video || !(duration > 0)) return;
    video.pause();
    seekTo(stepFrame(video.currentTime, dataRef.current.fps, by, duration));
  };

  /* ---------------- the timeline's view ---------------- */

  const fps = data.fps;
  const [view, setView] = useState<EditView>({ from: 0, to: duration });
  const viewRef = useRef(view);
  viewRef.current = view;
  // The whole video, when a video (or its length) is new.
  useEffect(() => setView({ from: 0, to: duration }), [duration]);
  // Keep the playhead in view as it moves, whether playing, scrubbing or stepping.
  useEffect(() => setView((current) => editViewShowing(current, duration, fps, now)), [now, duration, fps]);
  const span = Math.max(1e-6, view.to - view.from);
  const across = (time: number) => `${((time - view.from) / span) * 100}%`;
  const zoomBy = (factor: number) => {
    const current = viewRef.current;
    const about = now >= current.from && now <= current.to ? now : (current.from + current.to) / 2;
    setView(zoomEditView(current, duration, fps, about, factor));
  };

  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const [timelineWidth, setTimelineWidth] = useState(0);
  useEffect(() => {
    if (!timeline) return undefined;
    const observer = new ResizeObserver(() => setTimelineWidth(timeline.clientWidth));
    observer.observe(timeline);
    setTimelineWidth(timeline.clientWidth);
    return () => observer.disconnect();
  }, [timeline]);
  const timeAtX = useCallback(
    (clientX: number) => {
      if (!timeline) return 0;
      const box = timeline.getBoundingClientRect();
      const current = viewRef.current;
      return current.from + ((clientX - box.left) / Math.max(1, box.width)) * (current.to - current.from);
    },
    [timeline],
  );
  // The wheel zooms about the pointer; sideways (or with Shift) it pans.
  useEffect(() => {
    if (!timeline) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
      if (sideways !== 0) {
        setView(panEditView(current, duration, fps, (sideways / Math.max(1, timeline.clientWidth)) * (current.to - current.from)));
      } else {
        setView(zoomEditView(current, duration, fps, timeAtX(event.clientX), Math.exp(-event.deltaY * 0.0015)));
      }
    };
    timeline.addEventListener('wheel', onWheel, { passive: false });
    return () => timeline.removeEventListener('wheel', onWheel);
  }, [timeline, duration, fps, timeAtX]);

  /** Drag along the timeline: scrub; with Shift, Alt or the middle button: pan. */
  const onTimelineDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!timeline || !(duration > 0)) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    target.focus();
    const panning = event.button === 1 || event.shiftKey || event.altKey;
    if (!panning && event.button !== 0) return;
    const startX = event.clientX;
    const startView = viewRef.current;
    const scrub = (clientX: number) => seekTo(snapToFrame(Math.max(0, Math.min(duration, timeAtX(clientX))), dataRef.current.fps));
    if (!panning) {
      player.current?.pause();
      scrub(event.clientX);
    }
    const move = (moveEvent: PointerEvent) => {
      if (panning) {
        const by = -((moveEvent.clientX - startX) / Math.max(1, timeline.clientWidth)) * (startView.to - startView.from);
        setView(panEditView(startView, duration, fps, by));
      } else scrub(moveEvent.clientX);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (panning) return;
      const at = player.current?.currentTime ?? 0;
      const index = editSegments(dataRef.current, duration).findIndex((segment) => at >= segment.start && at < segment.end);
      if (index >= 0 && index !== dataRef.current.selected) patch({ selected: index });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  /** The bar under the timeline is the whole video: drag the window on it to pan, or click to go there. */
  const onOverviewDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(duration > 0)) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    const box = target.getBoundingClientRect();
    const timeAt = (clientX: number) => ((clientX - box.left) / Math.max(1, box.width)) * duration;
    const current = viewRef.current;
    const width = current.to - current.from;
    const at = timeAt(event.clientX);
    // On the window, it is picked up where it was held; off it, it is centred there first.
    const inside = at >= current.from && at <= current.to;
    const start = inside ? current : clampEditView({ from: at - width / 2, to: at + width / 2 }, duration, fps);
    if (!inside) setView(start);
    const move = (moveEvent: PointerEvent) => setView(panEditView(start, duration, fps, timeAt(moveEvent.clientX) - at));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  /* ---------------- the filmstrip ---------------- */

  const thumbWidth = size && size.height > 0 ? Math.max(8, Math.round((THUMB_HEIGHT * size.width) / size.height)) : 0;
  const { thumbs, want } = useFrameThumbnails(videoUrl, thumbWidth, THUMB_HEIGHT, fps);
  const strip = useMemo(() => filmstripFrames(view, timelineWidth, thumbWidth, fps, duration), [view, timelineWidth, thumbWidth, fps, duration]);
  useEffect(() => want(strip.frames), [strip, want]);
  const ruler = useMemo(() => rulerTicks(view, timelineWidth, fps), [view, timelineWidth, fps]);

  /* ---------------- shots ---------------- */

  const cuts = editShotCuts(data);
  const shotStarts = [0, ...cuts];
  const [shotRun, setShotRun] = useState<number | null>(null);
  const stoppingShots = useRef(false);
  const findShots = async () => {
    if (!videoUrl || !meta || !source) return;
    stoppingShots.current = false;
    setShotRun(0);
    let video: HTMLVideoElement;
    try {
      video = await loadVideo(videoUrl);
    } catch (reason) {
      setShotRun(null);
      notify('error', `Could not read the video: ${(reason as Error).message}`);
      return;
    }
    const width = Math.min(EMBED_WIDTH, meta.width);
    const reader = new FrameReader(video, width, Math.max(1, Math.round((meta.height * width) / meta.width)));
    try {
      const found = await detectShots(
        meta.duration,
        SHOT_SAMPLING,
        { ...DEFAULT_SHOT_OPTIONS, fps: dataRef.current.fps },
        async (time) => {
          if (stoppingShots.current) throw new Error('stopped');
          return embedFrame(await reader.read(time));
        },
        (done, total) => setShotRun(done / total),
      );
      patch({ shots: { hash: source.artifact.hash, cuts: found.cuts.map((cut) => cut.time) } });
      notify('success', `${found.cuts.length + 1} shot(s) found.`);
    } catch (reason) {
      if ((reason as Error).message !== 'stopped') notify('error', `Could not find the shots: ${(reason as Error).message}`);
    } finally {
      releaseVideo(video);
      setShotRun(null);
    }
  };

  /* ---------------- segments ---------------- */

  const selected = data.selected !== null && segments[data.selected] ? data.selected : segments.findIndex((segment) => now >= segment.start && now < segment.end);
  const splitHere = () => {
    const next = splitSegmentAt(dataRef.current, now);
    if (next === dataRef.current) notify('info', 'That is the edge of a segment already.');
    else apply(next);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.ctrlKey || event.metaKey) return;
      if (event.key === 's' || event.key === 'S') splitHere();
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        // A frame at a time; with Shift, a second.
        const frames = event.shiftKey ? Math.max(1, Math.round(dataRef.current.fps)) : 1;
        stepBy(event.key === 'ArrowLeft' ? -frames : frames);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        player.current?.pause();
        seekTo(event.key === 'Home' ? 0 : stepFrame(duration, dataRef.current.fps, 0, duration));
      } else if (event.key === '+' || event.key === '=') zoomBy(2);
      else if (event.key === '-' || event.key === '_') zoomBy(0.5);
      else if ((event.key === 'Delete' || event.key === 'Backspace') && selected >= 0) apply(toggleSegment(dataRef.current, selected));
      else if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------------- crop ---------------- */

  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const fit = useFitScale(svg, size?.width ?? 0, size?.height ?? 0);
  const [live, setLive] = useState<CropRect | null>(null);
  const shownCrop = live ?? crop;
  const cropping = data.crop !== null;
  const begin = (event: React.PointerEvent, what: Held) => {
    if (!svg || !size || !cropping) return;
    event.preventDefault();
    event.stopPropagation();
    let last: CropRect | null = null;
    const move = (moveEvent: PointerEvent) => {
      const at = svgPoint(svg, moveEvent);
      if (what.kind === 'handle') last = dragHandle(what.from, what.handle, at, size);
      else if (what.kind === 'move') last = moveRect(what.from, { x: Math.round(at.x - what.start.x), y: Math.round(at.y - what.start.y) }, size);
      else last = clampRect(normaliseRect({ x: what.start.x, y: what.start.y, width: at.x - what.start.x, height: at.y - what.start.y }), size);
      setLive(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (last) patch({ crop: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const setCropField = (key: keyof CropRect, value: number) => {
    if (!size) return;
    patch({ crop: clampRect({ ...(data.crop ?? { x: 0, y: 0, ...size }), [key]: Math.round(value) }, size) });
  };

  /* ---------------- recording ---------------- */

  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const stopping = useRef(false);
  const onGenerate = async () => {
    const current = dataRef.current;
    const kept = keptSegments(current);
    const box = videoCropRect(current);
    if (!videoUrl || !box || kept.length === 0) {
      await generateFlow(node.id);
      return;
    }
    if (!recordingType()) {
      notify('error', 'This browser cannot record video, so only the edit is written.');
      await generateFlow(node.id);
      return;
    }
    stopping.current = false;
    player.current?.pause();
    setProgress({ done: 0, total: editedDuration(current), clip: 0 });
    try {
      const blobs = await renderEdit({ url: videoUrl, segments: kept, crop: box, fps: current.fps, mode: current.output, onProgress: setProgress, stopped: () => stopping.current });
      if (stopping.current) {
        notify('info', 'Stopped. Nothing was written.');
        return;
      }
      const attachments =
        current.output === 'joined'
          ? [{ name: 'edited.webm', data: await blobDataUrl(blobs[0]!) }]
          : await Promise.all(blobs.map(async (blob, index) => ({ name: `clips/${clipName(index)}`, data: await blobDataUrl(blob) })));
      patch({ rendered: editKey(current) });
      await generateFlow(node.id, attachments);
    } catch (reason) {
      notify('error', `Could not record the edit: ${(reason as Error).message}`);
    } finally {
      setProgress(null);
    }
  };

  // Generate all, for one video of a batch: once the video is measured, record the edit as Generate does.
  const onGenerateRef = useRef(onGenerate);
  onGenerateRef.current = onGenerate;
  const videoErrorRef = useRef(videoError);
  videoErrorRef.current = videoError;
  useBatchRun(node, async () => {
    await waitUntil(() => (dataRef.current.video && (!source || dataRef.current.video.hash === source.artifact.hash)) || videoErrorRef.current, 'Reading the video');
    if (!dataRef.current.video) throw new Error(`the video could not be read: ${videoErrorRef.current}`);
    await onGenerateRef.current();
  });

  const behind = Boolean(data.rendered) && data.rendered !== editKey(data);
  const blocked = !source ? 'Wire a video into the Video input, or upload one here.' : videoError ? `The video could not be read: ${videoError}.` : null;

  return (
    <EditorShell
      project={project}
      node={node}
      onGenerate={onGenerate}
      banner={
        blocked ? (
          <div className="vt-sync-banner"><span>{blocked}</span></div>
        ) : progress ? (
          <div className="vt-sync-banner">
            <span>
              Recording {data.output === 'clips' ? `clip ${progress.clip + 1}, ` : ''}
              {clock(progress.done)} of {clock(progress.total)}…
            </span>
            <progress max={progress.total} value={progress.done} style={{ flex: 1, maxWidth: 240 }} />
            <button type="button" className="vt-btn is-small" onClick={() => (stopping.current = true)}>
              Stop
            </button>
          </div>
        ) : behind ? (
          <div className="vt-sync-banner"><span>The edit has changed since it was last recorded. Generate to record it again.</span></div>
        ) : undefined
      }
      actions={source?.wired ? undefined : <VideoUpload replace={Boolean(source)} onFile={upload} />}
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>Crop</h3>
          <label className="vt-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={cropping}
              disabled={!size}
              onChange={(event) => patch({ crop: event.target.checked && size ? { x: Math.round(size.width / 8), y: Math.round(size.height / 8), width: Math.round((size.width * 3) / 4), height: Math.round((size.height * 3) / 4) } : null })}
            />
            Crop the picture
          </label>
          {cropping && shownCrop ? (
            <>
              <p className="vt-hint">Drag the box or its handles on the video; drag outside it to draw a new one.</p>
              <div className="vt-crop-fields">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <label key={key} className="vt-field">
                    <span className="vt-label">{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'width' ? 'Width' : 'Height'}</span>
                    <input type="number" min={key === 'width' || key === 'height' ? 2 : 0} value={shownCrop[key]} aria-label={`Crop ${key}`} onChange={(event) => setCropField(key, Number(event.target.value) || 0)} />
                  </label>
                ))}
              </div>
              <p className="vt-faint" style={{ fontSize: 11 }}>Recorded at {shownCrop.width} × {shownCrop.height}: the sides are kept even, as video needs.</p>
            </>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>Segments</h3>
          <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button type="button" className="vt-btn is-small" disabled={!data.video} title="Split the segment under the playhead (S)" onClick={splitHere}>
              Split at {clock(now)}
            </button>
            {selected >= 0 ? (
              <button type="button" className="vt-btn is-small" onClick={() => apply(toggleSegment(dataRef.current, selected))} title="Delete (Delete key)">
                {segments[selected]?.deleted ? `Keep segment ${selected + 1}` : `Delete segment ${selected + 1}`}
              </button>
            ) : null}
          </div>
          <ol className="vt-edit-segments">
            {segments.map((segment, index) => (
              <li key={`${segment.start}`} className={`${segment.deleted ? 'is-deleted' : ''}${index === selected ? ' is-selected' : ''}`}>
                <button type="button" className="vt-edit-segment-name" onClick={() => {
                  patch({ selected: index });
                  seekTo(segment.start);
                }}>
                  {index + 1}. {clock(segment.start)} – {clock(segment.end)}
                </button>
                <span className="vt-faint">{(segment.end - segment.start).toFixed(2)}s</span>
                <button type="button" className="vt-btn is-ghost is-small" onClick={() => apply(toggleSegment(dataRef.current, index))}>
                  {segment.deleted ? 'Keep' : 'Delete'}
                </button>
                {index < segments.length - 1 ? (
                  <button type="button" className="vt-btn is-ghost is-small" title="Join with the next segment" onClick={() => apply(joinSegments(dataRef.current, index))}>
                    Join ↓
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </div>

        <div className="vt-section">
          <h3>Shots</h3>
          <p className="vt-hint">Finds where the video cuts from one shot to the next, to the frame, and shows the shots on the timeline.</p>
          {shotRun !== null ? (
            <div className="vt-row" style={{ gap: 6 }}>
              <progress max={1} value={shotRun} style={{ flex: 1 }} />
              <button type="button" className="vt-btn is-small" onClick={() => (stoppingShots.current = true)}>
                Stop
              </button>
            </div>
          ) : (
            <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              <button type="button" className={`vt-btn is-small${data.shots ? '' : ' is-primary'}`} disabled={!meta} onClick={() => void findShots()}>
                {cuts.length > 0 || data.shots ? 'Find the shots again' : 'Find the shots'}
              </button>
              {cuts.length > 0 ? (
                <button
                  type="button"
                  className="vt-btn is-small"
                  title="Split the segments at every cut between shots"
                  onClick={() => {
                    const next = splitAtCuts(dataRef.current, cuts);
                    if (next === dataRef.current) notify('info', 'The segments are split at every shot already.');
                    else apply(next);
                  }}
                >
                  Split at the shots
                </button>
              ) : null}
            </div>
          )}
          {data.shots && data.video && data.shots.hash === data.video.hash ? (
            <ol className="vt-edit-segments">
              {shotStarts.map((start, index) => {
                const end = shotStarts[index + 1] ?? duration;
                return (
                  <li key={start}>
                    <button type="button" className="vt-edit-segment-name" onClick={() => seekTo(start)}>
                      Shot {index + 1}. {clock(start)} – {clock(end)}
                    </button>
                    <span className="vt-faint">{(end - start).toFixed(2)}s</span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>What comes out</h3>
          <div className="vt-facet-values" role="radiogroup" aria-label="Write the edit as">
            {(
              [
                ['joined', 'One video'],
                ['clips', 'A clip for each segment'],
              ] as const
            ).map(([output, label]) => (
              <button key={output} type="button" className={`vt-chip${data.output === output ? ' is-on' : ''}`} aria-pressed={data.output === output} onClick={() => patch({ output })}>
                {label}
              </button>
            ))}
          </div>
          <Field label="Frame rate" tip="videoEdit.fps" hint="Frames a second it is recorded at, and what a split snaps to.">
            <input type="number" min={1} max={60} value={data.fps} aria-label="Frame rate" onChange={(event) => patch({ fps: Math.max(1, Math.min(60, Number(event.target.value) || 30)) })} />
          </Field>
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>{summariseEdit(data)}</p>
          <p className="vt-hint">Generate plays the edit and records it, so it takes as long as the edit lasts. The sound is not kept.</p>
        </div>
      </aside>

      <div className="vt-editor-main">
        {videoUrl && size ? (
          <>
            <div className="vt-crop-frame vt-edit-frame">
              <video ref={player} className="vt-crop-canvas" src={videoUrl} muted playsInline preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
              <svg
                ref={setSvg}
                className={`vt-crop-overlay${cropping ? ' is-manual' : ''}`}
                viewBox={`0 0 ${size.width} ${size.height}`}
                onPointerDown={(event) => {
                  if (!cropping || !svg) return;
                  const at = svgPoint(svg, event);
                  begin(event, { kind: 'draw', start: { x: Math.round(at.x), y: Math.round(at.y) } });
                }}
              >
                {cropping && shownCrop ? (
                  <>
                    <path
                      className="vt-crop-shade"
                      fillRule="evenodd"
                      d={`M0,0h${size.width}v${size.height}h${-size.width}Z M${shownCrop.x},${shownCrop.y}h${shownCrop.width}v${shownCrop.height}h${-shownCrop.width}Z`}
                    />
                    <rect
                      className="vt-crop-box"
                      x={shownCrop.x}
                      y={shownCrop.y}
                      width={shownCrop.width}
                      height={shownCrop.height}
                      strokeWidth={1.5 / Math.max(1e-3, fit)}
                      onPointerDown={(event) => svg && begin(event, { kind: 'move', from: shownCrop, start: svgPoint(svg, event) })}
                    />
                    {CROP_HANDLES.map((handle) => {
                      const [fx, fy] = HANDLE_AT[handle];
                      const side = 10 / Math.max(1e-3, fit);
                      return (
                        <rect
                          key={handle}
                          className="vt-crop-handle"
                          aria-label={`Crop handle ${handle}`}
                          x={shownCrop.x + shownCrop.width * fx - side / 2}
                          y={shownCrop.y + shownCrop.height * fy - side / 2}
                          width={side}
                          height={side}
                          strokeWidth={1 / Math.max(1e-3, fit)}
                          onPointerDown={(event) => begin(event, { kind: 'handle', handle, from: shownCrop })}
                        />
                      );
                    })}
                  </>
                ) : null}
              </svg>
            </div>

            <div className="vt-row vt-edit-controls">
              <button type="button" className="vt-btn is-small" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <span className="vt-faint">
                {clock(now)} / {clock(duration)}
              </span>
              <label className="vt-row" style={{ gap: 5 }}>
                <input type="checkbox" checked={editOnly} onChange={(event) => setEditOnly(event.target.checked)} />
                play the edit (skip what is deleted)
              </label>
              <span className="vt-spacer" />
              <span className="vt-faint">Edit: {clock(editedDuration(data))}</span>
            </div>

            <div className="vt-row vt-edit-zoom">
              <button type="button" className="vt-btn is-small" onClick={() => zoomBy(0.5)} aria-label="Zoom out" title="Zoom out (−)" disabled={span >= duration - 1e-6}>
                −
              </button>
              <button type="button" className="vt-btn is-small" onClick={() => zoomBy(2)} aria-label="Zoom in" title="Zoom in (+)">
                +
              </button>
              <button type="button" className="vt-btn is-small" onClick={() => setView({ from: 0, to: duration })} disabled={span >= duration - 1e-6}>
                Whole video
              </button>
              <span className="vt-faint">
                {clock(view.from)} – {clock(view.to)}
                {duration > 0 && span < duration - 1e-6 ? ` · ×${(duration / span).toFixed(1)}` : ''}
              </span>
              <span className="vt-spacer" />
              {cuts.length > 0 ? <span className="vt-faint">{cuts.length + 1} shots</span> : null}
            </div>

            <div
              ref={setTimeline}
              className="vt-edit-timeline"
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={now}
              aria-valuetext={clock(now)}
              onPointerDown={onTimelineDown}
              onAuxClick={(event) => event.preventDefault()}
            >
              <div className="vt-edit-ruler">
                {cuts.length > 0
                  ? shotStarts.map((start, index) => {
                      const end = shotStarts[index + 1] ?? duration;
                      if (end < view.from || start > view.to) return null;
                      return (
                        <div
                          key={`shot-${start}`}
                          className={`vt-edit-shot${index % 2 === 1 ? ' is-odd' : ''}`}
                          style={{ left: across(start), width: `${((end - start) / span) * 100}%` }}
                          title={`Shot ${index + 1}: ${clock(start)} – ${clock(end)}`}
                        >
                          <span>Shot {index + 1}</span>
                        </div>
                      );
                    })
                  : null}
                {ruler.ticks.map((tick) => (
                  <span key={tick} className="vt-edit-tick" style={{ left: across(tick) }}>
                    {tickLabel(tick, ruler.step)}
                  </span>
                ))}
              </div>
              <div className="vt-edit-strip">
                {strip.frames.map((frame) => {
                  const start = frame / Math.max(1, fps);
                  const picture = thumbs[frame];
                  return (
                    <div
                      key={frame}
                      className="vt-edit-thumb"
                      style={{
                        left: across(start),
                        width: `${((strip.every / Math.max(1, fps)) / span) * 100}%`,
                        backgroundImage: picture ? `url(${picture})` : undefined,
                        backgroundSize: `${thumbWidth}px ${THUMB_HEIGHT}px`,
                      }}
                    />
                  );
                })}
              </div>
              <div className="vt-edit-bar">
                {segments.map((segment, index) =>
                  segment.end < view.from || segment.start > view.to ? null : (
                    <div
                      key={`${segment.start}`}
                      className={`vt-edit-block${segment.deleted ? ' is-deleted' : ''}${index === selected ? ' is-selected' : ''}`}
                      style={{ left: across(segment.start), width: `${((segment.end - segment.start) / span) * 100}%` }}
                      title={`${index + 1}: ${clock(segment.start)} – ${clock(segment.end)}${segment.deleted ? ' (deleted)' : ''}`}
                    >
                      <span>{index + 1}</span>
                    </div>
                  ),
                )}
              </div>
              {cuts.map((cut) =>
                cut < view.from || cut > view.to ? null : <div key={`cut-${cut}`} className="vt-edit-cut" style={{ left: across(cut) }} />,
              )}
              <div className="vt-edit-playhead" style={{ left: across(now) }} />
            </div>

            <div className="vt-edit-overview" onPointerDown={onOverviewDown} aria-label="The whole video: drag the window to pan">
              {segments.map((segment) =>
                segment.deleted ? (
                  <div
                    key={`${segment.start}`}
                    className="vt-edit-overview-gone"
                    style={{ left: `${(segment.start / Math.max(1e-6, duration)) * 100}%`, width: `${((segment.end - segment.start) / Math.max(1e-6, duration)) * 100}%` }}
                  />
                ) : null,
              )}
              {cuts.map((cut) => (
                <div key={`cut-${cut}`} className="vt-edit-overview-cut" style={{ left: `${(cut / Math.max(1e-6, duration)) * 100}%` }} />
              ))}
              <div
                className="vt-edit-window"
                style={{ left: `${(view.from / Math.max(1e-6, duration)) * 100}%`, width: `${(span / Math.max(1e-6, duration)) * 100}%` }}
              />
              <div className="vt-edit-overview-head" style={{ left: `${(now / Math.max(1e-6, duration)) * 100}%` }} />
            </div>
            <p className="vt-faint" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5 }}>
              Drag along the timeline to scrub. ← → step a frame (Shift: a second), Home and End go to the ends. The wheel zooms, + and − too; Shift-drag, a
              sideways scroll or the bar underneath pans. S splits at the playhead, Delete deletes or keeps the selected segment, Space plays.
            </p>
          </>
        ) : (
          <div className="vt-empty">{blocked ?? 'Reading the video…'}</div>
        )}
      </div>
    </EditorShell>
  );
}
