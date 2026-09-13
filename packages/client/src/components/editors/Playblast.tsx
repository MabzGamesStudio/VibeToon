import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectSettings, TimedPanel } from '@vibetoon/shared';
import { formatSeconds } from '../common/format';
import { drawSketch } from './sketch';

export interface PlayblastProps {
  panels: TimedPanel[];
  settings: Pick<ProjectSettings, 'width' | 'height'>;
  onClose(): void;
}

/**
 * Plays the board in the browser, holding each panel for its own duration. This
 * is the watchable output on a machine with no video tooling installed; the
 * server writes the same cut as a timeline and, where ffmpeg exists, an mp4.
 */
export function Playblast({ panels, settings, onClose }: PlayblastProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);

  const total = panels.length > 0 ? panels[panels.length - 1]!.endSec : 0;
  const currentIndex = Math.max(
    0,
    panels.findIndex((panel) => time < panel.endSec),
  );
  const current = panels[currentIndex] ?? panels[panels.length - 1];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    drawSketch(canvas, current.panel.sketch);
    if (!current.panel.sketch || current.panel.sketch.strokes.length === 0) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.textAlign = 'center';
        ctx.font = '28px system-ui, sans-serif';
        ctx.fillText(
          `Panel ${current.index + 1} — ${current.panel.shot}`,
          canvas.width / 2,
          canvas.height / 2,
        );
        ctx.font = '18px system-ui, sans-serif';
        ctx.fillText(
          (current.panel.action || current.panel.dialog || '').replace(/\s+/g, ' ').slice(0, 80),
          canvas.width / 2,
          canvas.height / 2 + 30,
        );
      }
    }
  }, [current]);

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
        setPlaying((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const caption = [current?.panel.dialog, current?.panel.sound ? `(${current.panel.sound})` : '']
    .filter(Boolean)
    .join('\n');

  return (
    <div className="vt-playblast">
      <div className="vt-row">
        <strong>Playblast</strong>
        <span className="vt-faint">
          {panels.length} panel{panels.length === 1 ? '' : 's'} · {formatSeconds(total)}
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
        {caption ? <div className="vt-playblast-caption">{caption}</div> : null}
      </div>

      <div className="vt-playblast-bar">
        <button type="button" className="vt-btn" onClick={() => setPlaying((current) => !current)}>
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
        <span className="vt-faint">
          panel {(current?.index ?? 0) + 1} · {current?.panel.shot}
        </span>
      </div>
    </div>
  );
}
