import { useEffect, useRef, useState } from 'react';
import { DEFAULT_VIEW, LIGHT_VIEW, useView, type ViewPrefs } from '../../state/view';

interface Row {
  key: keyof ViewPrefs;
  label: string;
  note: string;
}

/** Ordered by what costs most, so the first thing you turn off is the first thing that helps. */
const ROWS: Row[] = [
  { key: 'livePreview', label: 'Live previews', note: 'Rerun as you type. The most expensive thing here.' },
  { key: 'artifactPreviews', label: 'File previews', note: 'Thumbnails and text of generated files.' },
  { key: 'inspector', label: 'Inputs & files panel', note: 'The column down the right.' },
  { key: 'sidebar', label: 'Settings panel', note: 'The column down the left of an editor.' },
  { key: 'palette', label: 'Flow palette', note: 'The list of flows to add, on the graph.' },
  { key: 'effects', label: 'Shadows and transitions', note: 'Cosmetic, and not free on a weak GPU.' },
  { key: 'tips', label: 'Setting tips', note: 'The (i) beside every setting.' },
];

/**
 * What to draw and what to skip.
 *
 * Everything in here is useful, and everything in here costs something. On a
 * large project on a modest laptop that trade is worth making by hand, so it is
 * made by hand rather than guessed at.
 */
export function ViewMenu(): JSX.Element {
  const { view, set, toggle, apply, reduced } = useView();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="vt-viewmenu" ref={wrapRef}>
      <button
        type="button"
        className={`vt-btn is-ghost is-small${reduced ? ' is-active' : ''}`}
        aria-expanded={open}
        title="Choose what the studio draws, to make a big project feel lighter"
        onClick={() => setOpen((current) => !current)}
      >
        View{reduced ? ' ·' : ''}
      </button>

      {open ? (
        <div className="vt-viewmenu-panel" role="dialog" aria-label="View">
          <div className="vt-row" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>What to draw</strong>
            <span className="vt-spacer" />
            <button type="button" className="vt-btn is-small" onClick={() => apply(LIGHT_VIEW)}>
              Lighten everything
            </button>
            <button type="button" className="vt-btn is-small is-ghost" onClick={() => apply(DEFAULT_VIEW)}>
              Reset
            </button>
          </div>

          {ROWS.map((row) => (
            <label key={row.key} className="vt-viewmenu-row">
              <input
                type="checkbox"
                checked={view[row.key] as boolean}
                onChange={() => toggle(row.key)}
              />
              <span>
                <strong>{row.label}</strong>
                <span className="vt-faint">{row.note}</span>
              </span>
            </label>
          ))}

          <div className="vt-viewmenu-row is-choice">
            <span>
              <strong>Nodes on the graph</strong>
              <span className="vt-faint">Compact draws the name and status only.</span>
            </span>
            <select
              value={view.nodeDetail}
              aria-label="Nodes on the graph"
              onChange={(event) => set('nodeDetail', event.target.value as ViewPrefs['nodeDetail'])}
            >
              <option value="full">Full</option>
              <option value="compact">Compact</option>
            </select>
          </div>

          <div className="vt-viewmenu-row is-choice">
            <span>
              <strong>Rows in a long list</strong>
              <span className="vt-faint">Words, patterns and log lines are cut to this.</span>
            </span>
            <select
              value={String(view.listLimit)}
              aria-label="Rows in a long list"
              onChange={(event) => set('listLimit', Number(event.target.value))}
            >
              {[25, 50, 100, 300, 1000].map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
          </div>

          <div className="vt-hint" style={{ marginTop: 6 }}>
            Kept in this browser, not in the project. Turning a panel off hides it everywhere, so nothing is
            drawn for it at all.
          </div>
        </div>
      ) : null}
    </div>
  );
}
