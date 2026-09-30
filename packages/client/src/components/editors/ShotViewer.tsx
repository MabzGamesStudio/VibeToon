import { useEffect, useRef, useState } from 'react';
import { frameIndex, frameStart, type Shot } from '@vibetoon/shared';
import { clock } from '../common/video';

/**
 * One shot, large: the video held to the shot, to slide through and play.
 *
 * Drag along the bar under it to scrub, a frame at a time. ← and → step a
 * frame (Shift: a second) and stay inside the shot; Home and End go to its
 * first and last frame; Space plays it, stopping at its end (or going round,
 * with Loop). ↑ and ↓ go to the shot before and after; S splits the shot at
 * the frame shown; Escape closes the viewer.
 */
export function ShotViewer({
  videoUrl,
  shots,
  index,
  fps,
  tiles,
  seek,
  onSelect,
  onSplit,
}: {
  videoUrl: string;
  shots: readonly Shot[];
  index: number;
  fps: number;
  /** Pictures along the shot, for the bar. */
  tiles: readonly (string | undefined)[];
  /** Asked from outside: go to this time (a new object each time). */
  seek: { time: number } | null;
  onSelect(index: number | null): void;
  onSplit(time: number): void;
}): JSX.Element {
  const shot = shots[index]!;
  const video = useRef<HTMLVideoElement | null>(null);
  const [now, setNow] = useState(shot.start);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  // The shot's frames: its first, and the one before the next shot starts.
  const first = frameIndex(shot.start, fps);
  const last = Math.max(first, frameIndex(shot.end, fps) - 1);
  const current = Math.max(first, Math.min(last, frameIndex(now, fps)));
  const show = (frame: number) => {
    const time = frameStart(Math.max(first, Math.min(last, frame)), fps);
    if (video.current) video.current.currentTime = time;
    setNow(time);
  };
  const showRef = useRef(show);
  showRef.current = show;

  // A new shot starts at its first frame.
  useEffect(() => {
    video.current?.pause();
    showRef.current(first);
  }, [index, first, last]);

  // Asked to go somewhere: a click on the shot's row.
  useEffect(() => {
    if (seek) showRef.current(frameIndex(seek.time, fps));
  }, [seek, fps]);

  // Follow the video while it plays, and hold it to the shot.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const element = video.current;
      if (element && !element.paused) {
        if (element.currentTime >= shot.end - 1e-3) {
          if (loopRef.current) element.currentTime = frameStart(first, fps);
          else {
            element.pause();
            element.currentTime = frameStart(last, fps);
          }
        }
        setNow(element.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shot.end, first, last, fps]);

  const togglePlay = () => {
    const element = video.current;
    if (!element) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    // From the end, play the shot again from its start.
    if (frameIndex(element.currentTime, fps) >= last) element.currentTime = frameStart(first, fps);
    void element.play();
  };
  const step = (by: number) => {
    video.current?.pause();
    showRef.current(frameIndex(video.current?.currentTime ?? now, fps) + by);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const second = Math.max(1, Math.round(fps));
      if (event.key === 'ArrowRight') step(event.shiftKey ? second : 1);
      else if (event.key === 'ArrowLeft') step(event.shiftKey ? -second : -1);
      else if (event.key === 'Home') {
        video.current?.pause();
        showRef.current(first);
      } else if (event.key === 'End') {
        video.current?.pause();
        showRef.current(last);
      } else if (event.key === ' ') togglePlay();
      else if (event.key === 'ArrowUp') {
        if (index > 0) onSelect(index - 1);
      } else if (event.key === 'ArrowDown') {
        if (index < shots.length - 1) onSelect(index + 1);
      } else if (event.key === 's' || event.key === 'S') onSplit(frameStart(frameIndex(video.current?.currentTime ?? now, fps), fps));
      else if (event.key === 'Escape') onSelect(null);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onBarDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    video.current?.pause();
    const at = (clientX: number) => {
      const box = bar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width)));
      showRef.current(Math.round((shot.start + fraction * (shot.end - shot.start)) * fps));
    };
    at(event.clientX);
    const move = (moveEvent: PointerEvent) => at(moveEvent.clientX);
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  };

  const span = Math.max(1e-6, shot.end - shot.start);
  return (
    <div className="vt-shot-viewer" aria-label={`Shot ${index + 1}`}>
      <div className="vt-row vt-shot-viewer-head">
        <strong>
          Shot {index + 1} of {shots.length}
        </strong>
        <span className="vt-faint">
          {clock(shot.start)} – {clock(shot.end)} · {(shot.end - shot.start).toFixed(2)}s · {last - first + 1} frame(s)
        </span>
        <span className="vt-spacer" />
        <button type="button" className="vt-btn is-small" disabled={index === 0} title="The shot before (↑)" onClick={() => onSelect(index - 1)}>
          ‹ Shot {index}
        </button>
        <button type="button" className="vt-btn is-small" disabled={index >= shots.length - 1} title="The shot after (↓)" onClick={() => onSelect(index + 1)}>
          Shot {index + 2} ›
        </button>
        <button type="button" className="vt-btn is-ghost is-small" title="Close the viewer (Escape)" aria-label="Close the viewer" onClick={() => onSelect(null)}>
          ✕
        </button>
      </div>

      <video
        ref={video}
        className="vt-shot-video"
        src={videoUrl}
        muted
        playsInline
        preload="auto"
        onLoadedData={() => showRef.current(frameIndex(now, fps))}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      <div className="vt-row vt-shot-viewer-controls">
        <button type="button" className="vt-btn is-small" aria-label="Back a frame" title="Back a frame (←)" onClick={() => step(-1)}>
          |◀
        </button>
        <button type="button" className="vt-btn is-small" aria-label={playing ? 'Pause' : 'Play the shot'} title="Play the shot (Space)" onClick={togglePlay}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button type="button" className="vt-btn is-small" aria-label="On a frame" title="On a frame (→)" onClick={() => step(1)}>
          ▶|
        </button>
        <span className="vt-faint">
          {clock(now)} · frame {current - first + 1} of {last - first + 1} in the shot ({current + 1} in the video)
        </span>
        <label className="vt-row" style={{ gap: 4 }}>
          <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
          loop
        </label>
        <span className="vt-spacer" />
        <button type="button" className="vt-btn is-small" title="Split the shot at this frame (S)" disabled={current === first} onClick={() => onSplit(frameStart(current, fps))}>
          Split here
        </button>
      </div>

      <div className="vt-shot-scrub" role="slider" aria-label="Scrub the shot" aria-valuemin={shot.start} aria-valuemax={shot.end} aria-valuenow={now} aria-valuetext={clock(now)} onPointerDown={onBarDown}>
        {tiles.map((url, tile) => (
          <div key={tile} className="vt-shot-scrub-tile">
            {url ? <img src={url} alt="" draggable={false} /> : null}
          </div>
        ))}
        <div className="vt-shot-scrub-head" style={{ left: `${((now - shot.start) / span) * 100}%` }} />
      </div>
      <p className="vt-faint" style={{ margin: '4px 0 0', fontSize: 11 }}>
        Drag along the bar to scrub. ← → a frame (Shift: a second), Home and End the shot’s first and last frame, Space plays, ↑ ↓ the shot before and after, S splits here, Escape closes.
      </p>
    </div>
  );
}
