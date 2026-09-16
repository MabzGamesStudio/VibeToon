import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { settingTip, type SettingTip } from '@vibetoon/shared';
import { useTips } from '../../state/tips';

export interface InfoTipProps {
  /** A key into the shared tip registry, or a tip written out in place. */
  tip: string | SettingTip;
  /** The setting this explains, for the button's label. */
  label?: string;
}

const PANEL_WIDTH = 280;
const GAP = 6;
const EDGE = 8;

/**
 * The (i) beside a setting. Clicking it opens what the setting does and a few
 * example values; clicking it again, pressing Escape, or clicking away closes it.
 *
 * It is a button rather than a hover target on purpose: a tooltip that appears
 * on hover cannot be read on a touch screen, cannot be reached from the
 * keyboard, and gets in the way of the control it is explaining.
 *
 * The panel is positioned against the viewport rather than against the label,
 * because most settings sit in a sidebar that scrolls — anchored inside one, a
 * panel wider than the column would simply be cut off.
 */
export function InfoTip({ tip, label }: InfoTipProps): JSX.Element | null {
  const { show } = useTips();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const resolved = typeof tip === 'string' ? settingTip(tip) : tip;

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 0;
    // Below the icon, unless there is more room above it.
    const below = rect.bottom + GAP;
    const flip = height > 0 && below + height > window.innerHeight - EDGE && rect.top > height + GAP + EDGE;
    setAt({
      top: flip ? rect.top - GAP - height : Math.min(below, Math.max(EDGE, window.innerHeight - height - EDGE)),
      left: Math.max(EDGE, Math.min(rect.left - GAP, window.innerWidth - PANEL_WIDTH - EDGE)),
    });
  }, []);

  // Measured once the panel is in the DOM, so its height is known before it is
  // decided whether it fits below.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    // Scrolling the sidebar moves the icon, so a panel pinned to the viewport
    // has to follow it — or close, if the icon has scrolled out of sight.
    const onScroll = () => place();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  // A setting with nothing written about it shows no icon at all, rather than an
  // icon that opens an empty box.
  if (!show || !resolved) return null;

  return (
    <span className="vt-infotip">
      <button
        type="button"
        ref={buttonRef}
        className={`vt-infotip-btn${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label ? `What “${label}” does` : 'What this setting does'}
        onClick={() => setOpen((current) => !current)}
      >
        i
      </button>
      {open ? (
        <div
          className="vt-infotip-panel"
          ref={panelRef}
          id={id}
          role="tooltip"
          style={{ top: at?.top ?? -9999, left: at?.left ?? -9999, width: PANEL_WIDTH }}
        >
          {label ? <strong>{label}</strong> : null}
          <span className="vt-infotip-what">{resolved.what}</span>
          {resolved.examples.length > 0 ? (
            <ul>
              {resolved.examples.map((example) => (
                <li key={example}>{example}</li>
              ))}
            </ul>
          ) : null}
          {resolved.note ? <span className="vt-infotip-note">{resolved.note}</span> : null}
        </div>
      ) : null}
    </span>
  );
}
