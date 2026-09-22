import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface StageRenderState {
  /** True while this part is filling the screen. */
  full: boolean;
  /** How many screen pixels one of the part's own pixels is drawn at. */
  scale: number;
}

export interface StageProps {
  /** What this part is, shown in its header and used to label the button. */
  title: string;
  /** Buttons belonging to this part, shown before the expand button. */
  tools?: ReactNode;
  /** A line under the header, e.g. what the current tool does. */
  banner?: ReactNode;
  /** Start expanded. */
  defaultFull?: boolean;
  /** Told whenever it expands or collapses, for a canvas that sizes itself. */
  onFullChange?(full: boolean): void;
  /**
   * Let the part be zoomed and panned. On for anything showing a picture, where
   * the reason to fill the screen is usually to look closely at one part of it.
   */
  zoomable?: boolean;
  className?: string;
  children: ReactNode | ((state: StageRenderState) => ReactNode);
}

/**
 * The closest it will go: one of the part's pixels drawn sixty-four across.
 *
 * Which is far past the point of seeing individual pixels as squares, and that
 * is the point — "zoom in all the way" should run out because there is nothing
 * left to see, not because the control stopped.
 */
const MOST = 64;

/**
 * A part of an editor that can fill the screen.
 *
 * A drawing surface is the case this exists for. The settings that go with it
 * are worth having beside it while you set them up and only in the way once you
 * are working, and a 400px canvas is not enough to cut around a character in.
 *
 * Expanding does **not** move the part in the React tree — it only changes its
 * class, and the CSS fixes it to the viewport. Rendering the same children
 * somewhere else (a portal, a conditional branch) would unmount and remount
 * them, and remounting a canvas loses its pixels: an in-progress cutout would
 * vanish on expanding, which is exactly when you want it. So the DOM node stays
 * put and only its box changes.
 */
export function Stage({
  title,
  tools,
  banner,
  defaultFull = false,
  onFullChange,
  zoomable = false,
  className,
  children,
}: StageProps): JSX.Element {
  const [full, setFull] = useState(defaultFull);
  const button = useRef<HTMLButtonElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const panning = useRef<{ x: number; y: number } | null>(null);

  const fit = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

  /**
   * Zoom about the pointer, so what is under it stays under it.
   *
   * Zooming about the middle is the thing that makes a zoom control useless for
   * looking at a detail: every step you take towards a pixel pushes it further
   * off the edge and you spend the whole time dragging it back.
   */
  const zoomBy = useCallback((by: number, at?: { x: number; y: number }) => {
    const box = body.current?.getBoundingClientRect();
    setView((current) => {
      const scale = Math.min(MOST, Math.max(1, current.scale * by));
      if (scale === current.scale) return current;
      const anchorX = at && box ? at.x - box.left : (box?.width ?? 0) / 2;
      const anchorY = at && box ? at.y - box.top : (box?.height ?? 0) / 2;
      const step = scale / current.scale;
      return {
        scale,
        x: anchorX - (anchorX - current.x) * step,
        y: anchorY - (anchorY - current.y) * step,
      };
    });
  }, []);

  // Wheel to zoom, and never the page behind it. Listened for on the element
  // rather than through React, because React's wheel handler is passive and a
  // passive listener may not call preventDefault.
  useEffect(() => {
    const element = body.current;
    if (!zoomable || !element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18, { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomable, zoomBy]);

  // Shrinking back into the editor puts the view back where it was, so the part
  // is never left scrolled off to a corner of itself at a size too small to find
  // the way back from.
  useEffect(() => {
    if (!full) fit();
  }, [full, fit]);

  const set = useCallback(
    (next: boolean) => {
      setFull(next);
      onFullChange?.(next);
    },
    [onFullChange],
  );

  // Escape is what everyone tries first, and it should not also escape whatever
  // the editor beneath does with it, so it is only listened for while expanded.
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      set(false);
      button.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [full, set]);

  // A part filling the screen over a scrolled page leaves the page scrolling
  // behind it under the wheel, which reads as the canvas refusing to pan.
  useEffect(() => {
    if (!full) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [full]);

  return (
    <section
      className={`vt-stage${full ? ' is-full' : ''}${className ? ` ${className}` : ''}`}
      aria-label={title}
    >
      <header className="vt-stage-bar">
        <strong>{title}</strong>
        <span className="vt-spacer" />
        {tools}
        {zoomable ? (
          <span className="vt-zoom-controls">
            <button
              type="button"
              className="vt-btn is-small"
              title="Zoom out"
              aria-label="Zoom out"
              onClick={() => zoomBy(1 / 1.6)}
            >
              −
            </button>
            <button
              type="button"
              className="vt-btn is-small"
              title="Back to fitting the frame"
              onClick={fit}
            >
              {view.scale > 1.005 ? `${Math.round(view.scale * 100)}%` : 'Fit'}
            </button>
            <button
              type="button"
              className="vt-btn is-small"
              title="Zoom in"
              aria-label="Zoom in"
              onClick={() => zoomBy(1.6)}
            >
              +
            </button>
          </span>
        ) : null}
        <button
          ref={button}
          type="button"
          className={`vt-btn is-small${full ? ' is-active' : ''}`}
          aria-pressed={full}
          title={full ? `Shrink ${title} back into the editor (Esc)` : `Expand ${title} to fill the screen`}
          onClick={() => set(!full)}
        >
          {full ? '⤡ Shrink' : '⤢ Full screen'}
        </button>
      </header>
      {banner}
      {zoomable && view.scale > 1.005 ? (
        <div className="vt-hint vt-zoom-hint">
          Drag with the middle button — or hold Shift — to move around. Scroll to zoom.
        </div>
      ) : null}
      <div
        ref={body}
        className={`vt-stage-body${zoomable ? ' is-zoomable' : ''}${
          view.scale > 1.005 ? ' is-zoomed' : ''
        }`}
        onPointerDown={(event) => {
          if (!zoomable) return;
          // Middle button, or Shift with any button. Anything else belongs to
          // whatever is being drawn on.
          if (event.button !== 1 && !(event.shiftKey && event.button === 0)) return;
          event.preventDefault();
          panning.current = { x: event.clientX - view.x, y: event.clientY - view.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const from = panning.current;
          if (!from) return;
          setView((current) => ({ ...current, x: event.clientX - from.x, y: event.clientY - from.y }));
        }}
        onPointerUp={(event) => {
          if (!panning.current) return;
          panning.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <div
          className="vt-stage-view"
          style={
            zoomable
              ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
              : undefined
          }
        >
          {typeof children === 'function' ? children({ full, scale: view.scale }) : children}
        </div>
      </div>
    </section>
  );
}
