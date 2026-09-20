import { useCallback, useEffect, useRef, useState } from 'react';
import type { Sketch, Stroke } from '@vibetoon/shared';
import { drawSketch, drawStroke, emptySketch, toSketchSpace } from './sketch';

const INKS = ['#1d1a17', '#7a5c3e', '#2e5d8a', '#a33b2c'];
const BRUSHES = [1.6, 3, 6, 12];

export interface SketchPadProps {
  sketch: Sketch | null;
  onChange(sketch: Sketch | null): void;
  /** False on read-only surfaces. */
  editable?: boolean;
  /** Show the brush strip. Kept off for panels that are not the active one. */
  showTools?: boolean;
  label?: string;
  /** Called when the pad is drawn on, so the board can mark it active. */
  onActivate?(): void;
  /**
   * Stroke space for a new drawing, which also sets the pad's shape. Panels are
   * 16:9; a character sheet wants something taller.
   */
  box?: { width: number; height: number };
  /**
   * Offer a full-screen button on the tools strip. A thumbnail-sized pad is fine
   * for a thumbnail-sized drawing and not for anything you mean to finish.
   */
  canExpand?: boolean;
}

/**
 * A vector sketch pad: strokes are kept as points in the sketch box, so panels
 * stay small in the project file, scale to any size, and can be undone one
 * stroke at a time. No canvas bitmaps are stored anywhere.
 */
export function SketchPad({
  sketch,
  onChange,
  editable = true,
  showTools = true,
  label,
  onActivate,
  box,
  canExpand = false,
}: SketchPadProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveStroke = useRef<Stroke | null>(null);
  const [ink, setInk] = useState(INKS[0]!);
  const [width, setWidth] = useState(BRUSHES[1]!);
  const [erasing, setErasing] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setFull(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [full]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawSketch(canvas, sketch);
    const live = liveStroke.current;
    if (live && sketch) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.scale(canvas.width / sketch.width, canvas.height / sketch.height);
      drawStroke(ctx, live);
      ctx.restore();
    }
  }, [sketch]);

  // Size the backing store to the element so lines are crisp on hi-dpi screens.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const nextWidth = Math.max(1, Math.round(rect.width * ratio));
      const nextHeight = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      redraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(redraw, [redraw]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || event.button !== 0) return;
    onActivate?.();
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    const base = sketch ?? emptySketch(box?.width, box?.height);
    const point = toSketchSpace(canvas, event, base);
    liveStroke.current = {
      points: [Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10],
      width: erasing ? Math.max(8, width * 3) : width,
      color: ink,
      ...(erasing ? { erase: true } : {}),
    };

    let frame = 0;
    const move = (moveEvent: PointerEvent) => {
      const live = liveStroke.current;
      if (!live) return;
      const next = toSketchSpace(canvas, moveEvent, base);
      const lastX = live.points[live.points.length - 2] ?? 0;
      const lastY = live.points[live.points.length - 1] ?? 0;
      // Skip points that add nothing, which keeps strokes small in the file.
      if (Math.hypot(next.x - lastX, next.y - lastY) < 1.2) return;
      live.points.push(Math.round(next.x * 10) / 10, Math.round(next.y * 10) / 10);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          redraw();
        });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (frame) cancelAnimationFrame(frame);
      const live = liveStroke.current;
      liveStroke.current = null;
      if (!live) return;
      onChange({
        ...base,
        strokes: [...base.strokes, live],
        updatedAt: new Date().toISOString(),
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    redraw();
  };

  const undo = () => {
    if (!sketch || sketch.strokes.length === 0) return;
    const strokes = sketch.strokes.slice(0, -1);
    onChange(strokes.length === 0 ? null : { ...sketch, strokes, updatedAt: new Date().toISOString() });
  };

  return (
    <div className={`vt-sketch-wrap${full ? ' is-full' : ''}`}>
      {editable && showTools ? (
        <div className="vt-sketch-tools">
          {BRUSHES.map((size) => (
            <button
              key={size}
              type="button"
              className={`vt-brush${!erasing && width === size ? ' is-active' : ''}`}
              onClick={() => {
                setWidth(size);
                setErasing(false);
              }}
              title={`${size}px brush`}
            >
              <i style={{ width: Math.min(14, size + 2), height: Math.min(14, size + 2) }} />
            </button>
          ))}
          {INKS.map((color) => (
            <button
              key={color}
              type="button"
              className={`vt-ink${!erasing && ink === color ? ' is-active' : ''}`}
              style={{ background: color }}
              onClick={() => {
                setInk(color);
                setErasing(false);
              }}
              title={color}
              aria-label={`Ink ${color}`}
            />
          ))}
          <button
            type="button"
            className={`vt-btn is-small${erasing ? ' is-active' : ''}`}
            onClick={() => setErasing((current) => !current)}
          >
            Erase
          </button>
          <span className="vt-spacer" />
          <button
            type="button"
            className="vt-btn is-small"
            onClick={undo}
            disabled={!sketch || sketch.strokes.length === 0}
          >
            Undo
          </button>
          <button
            type="button"
            className="vt-btn is-small is-danger"
            onClick={() => onChange(null)}
            disabled={!sketch}
          >
            Clear
          </button>
          {canExpand ? (
            <button
              type="button"
              className={`vt-btn is-small${full ? ' is-active' : ''}`}
              aria-pressed={full}
              title={full ? 'Shrink back into the editor (Esc)' : 'Draw at full screen'}
              onClick={() => setFull((was) => !was)}
            >
              {full ? '⤡ Shrink' : '⤢ Full screen'}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="vt-sketch"
        style={box ? { aspectRatio: `${box.width} / ${box.height}` } : undefined}
      >
        <canvas ref={canvasRef} onPointerDown={onPointerDown} />
        {!sketch || sketch.strokes.length === 0 ? (
          <div className="vt-sketch-empty">{label ?? 'draw here'}</div>
        ) : null}
      </div>
    </div>
  );
}
