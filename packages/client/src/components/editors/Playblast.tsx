import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectSettings } from '@vibetoon/shared';
import { formatSeconds } from '../common/format';
import { clipAt, totalDuration, type PlayClip } from './playClips';

export interface PlayblastProps {
  clips: PlayClip[];
  settings: Pick<ProjectSettings, 'width' | 'height'>;
  title?: string;
  onClose(): void;
}

/**
 * Plays a cut in the browser, holding each shot for its own length. This is the
 * watchable output on a machine with no video tooling installed; the animatic
 * editor records the same clips to a file.
 */
export function Playblast({ clips, settings, title = 'Playblast', onClose }: PlayblastProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);

  const total = totalDuration(clips);
  const current = clipAt(clips, Math.min(time, Math.max(0, total - 0.0001)));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    current.clip.render(canvas);
  }, [current?.clip]);

  const tick = useCallback(
    (elapsed: number) => {
      setTime((previous) => {
        const next = previous + elapsed;
        if (next >= total) {
          if (loop) return 0;
          setPlaying(false);
          return total;
        }
        return next;
      });
    },
    [loop, total],
  );

  useEffect(() => {
    if (!playing || total === 0) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      tick((now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, tick, total]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="vt-playblast">
      <div className="vt-row">
        <strong>{title}</strong>
        <span className="vt-faint">
          {clips.length} shot{clips.length === 1 ? '' : 's'} · {formatSeconds(total)}
        </span>
        <span className="vt-spacer" />
        <label className="vt-row" style={{ gap: 5 }}>
          <input
            type="checkbox"
            checked={loop}
            style={{ width: 'auto' }}
            onChange={(event) => setLoop(event.target.checked)}
          />
          <span className="vt-faint">loop</span>
        </label>
        <button type="button" className="vt-btn is-small" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="vt-playblast-stage">
        <canvas ref={canvasRef} width={settings.width} height={settings.height} />
        {current?.clip.caption ? <div className="vt-playblast-caption">{current.clip.caption}</div> : null}
      </div>

      <div className="vt-playblast-bar">
        <button type="button" className="vt-btn" onClick={() => setPlaying((value) => !value)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="vt-time">
          {formatSeconds(time)} / {formatSeconds(total)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, total)}
          step={0.05}
          value={time}
          onChange={(event) => {
            setPlaying(false);
            setTime(Number(event.target.value));
          }}
          aria-label="Scrub"
        />
        <span className="vt-faint">{current ? current.clip.label : ''}</span>
      </div>
    </div>
  );
}
