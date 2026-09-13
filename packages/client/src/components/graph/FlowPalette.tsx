import { useMemo, useState } from 'react';
import { FLOW_CATEGORY_LABEL, type FlowCategory, type FlowKindDef } from '@vibetoon/shared';
import { useStudio } from '../../state/store';

/** Nudge down and right until the spot is not already taken by another flow. */
function freeSpotNear(point: { x: number; y: number }, nodes: Array<{ position: { x: number; y: number } }>) {
  let candidate = { ...point };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const clash = nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < 60 && Math.abs(node.position.y - candidate.y) < 60,
    );
    if (!clash) return candidate;
    candidate = { x: candidate.x + 48, y: candidate.y + 40 };
  }
  return candidate;
}

export interface FlowPaletteProps {
  /** Where a newly added flow lands, in world coordinates. */
  dropPoint: { x: number; y: number };
}

export function FlowPalette({ dropPoint }: FlowPaletteProps): JSX.Element {
  const { registry, addNode, project } = useStudio();
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<FlowCategory, FlowKindDef[]>();
    for (const def of registry?.flowKinds ?? []) {
      const haystack = `${def.label} ${def.kind} ${def.summary}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      const list = groups.get(def.category) ?? [];
      list.push(def);
      groups.set(def.category, list);
    }
    return groups;
  }, [query, registry]);

  const total = [...grouped.values()].reduce((sum, list) => sum + list.length, 0);

  return (
    <aside className="vt-palette">
      <header>
        <input
          value={query}
          placeholder="Search flows…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search flows"
        />
        <div className="vt-faint" style={{ marginTop: 6, fontSize: 11 }}>
          {total} flow kind{total === 1 ? '' : 's'} · click to add
        </div>
      </header>

      <div className="vt-palette-list">
        {[...grouped.entries()].map(([category, defs]) => (
          <div key={category} className="vt-palette-group">
            <h3>{FLOW_CATEGORY_LABEL[category]}</h3>
            {defs.map((def) => (
              <button
                key={def.kind}
                type="button"
                className={`vt-palette-item cat-${def.category}`}
                onClick={() => addNode(def.kind, freeSpotNear(dropPoint, project?.nodes ?? []))}
                title={`${def.kind}\nin: ${def.inputs.map((p) => p.label).join(', ') || '—'}\nout: ${def.outputs
                  .map((p) => p.fileName ?? p.label)
                  .join(', ')}`}
              >
                <span className="vt-palette-name">
                  <span className="vt-row" style={{ gap: 6 }}>
                    <span className="vt-palette-dot" />
                    {def.label}
                  </span>
                  {def.maturity === 'editor' ? <span className="vt-pill is-ready">editor</span> : null}
                </span>
                <span className="vt-palette-summary">{def.summary}</span>
              </button>
            ))}
          </div>
        ))}
        {total === 0 ? <div className="vt-empty">Nothing matches “{query}”.</div> : null}
      </div>
    </aside>
  );
}
