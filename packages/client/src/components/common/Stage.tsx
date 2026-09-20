import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface StageRenderState {
  /** True while this part is filling the screen. */
  full: boolean;
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
  className?: string;
  children: ReactNode | ((state: StageRenderState) => ReactNode);
}

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
  className,
  children,
}: StageProps): JSX.Element {
  const [full, setFull] = useState(defaultFull);
  const button = useRef<HTMLButtonElement | null>(null);

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
      <div className="vt-stage-body">
        {typeof children === 'function' ? children({ full }) : children}
      </div>
    </section>
  );
}
