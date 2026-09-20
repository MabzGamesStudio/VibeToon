import { useMemo, useState } from 'react';
import {
  EMPTY_FLOW_FILTER,
  FLOW_CATEGORY_LABEL,
  activeFacetCount,
  filterFlowKinds,
  flowFacets,
  isFlowFilterEmpty,
  toggleFacet,
  type ArtifactKind,
  type FacetOption,
  type FlowCategory,
  type FlowFilter,
  type FlowKindDef,
} from '@vibetoon/shared';
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

/**
 * One facet: a row of tickable values with the count each would leave. A value
 * at zero is shown disabled rather than hidden, so the list of options does not
 * reshuffle under the cursor as you tick things.
 */
function Facet<T extends string>({
  title,
  hint,
  options,
  chosen,
  onToggle,
}: {
  title: string;
  hint: string;
  options: Array<FacetOption<T>>;
  chosen: readonly T[];
  onToggle(value: T): void;
}): JSX.Element | null {
  if (options.length === 0) return null;
  return (
    <div className="vt-facet">
      <h4 title={hint}>{title}</h4>
      <div className="vt-facet-values">
        {options.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={`vt-chip${on ? ' is-on' : ''}`}
              disabled={!on && option.count === 0}
              aria-pressed={on}
              onClick={() => onToggle(option.value)}
              title={
                option.count === 0
                  ? `No flow matches ${option.label} alongside the other filters`
                  : `${option.count} flow${option.count === 1 ? '' : 's'}`
              }
            >
              {option.label}
              <span className="vt-chip-count">{option.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface FlowPaletteProps {
  /** Where a newly added flow lands, in world coordinates. */
  dropPoint: { x: number; y: number };
}

export function FlowPalette({ dropPoint }: FlowPaletteProps): JSX.Element {
  const { registry, addNode, project } = useStudio();
  const [filter, setFilter] = useState<FlowFilter>(EMPTY_FLOW_FILTER);
  const [open, setOpen] = useState(false);

  const defs = registry?.flowKinds ?? [];
  const matches = useMemo(() => filterFlowKinds(defs, filter), [defs, filter]);
  const facets = useMemo(() => flowFacets(defs, filter), [defs, filter]);

  const grouped = useMemo(() => {
    const groups = new Map<FlowCategory, FlowKindDef[]>();
    for (const def of matches) {
      const list = groups.get(def.category) ?? [];
      list.push(def);
      groups.set(def.category, list);
    }
    return groups;
  }, [matches]);

  const narrowing = activeFacetCount(filter);
  const patch = (over: Partial<FlowFilter>) => setFilter((current) => ({ ...current, ...over }));

  return (
    <aside className="vt-palette">
      <header>
        <input
          value={filter.query}
          placeholder="Search flows…"
          onChange={(event) => patch({ query: event.target.value })}
          aria-label="Search flows"
        />

        <div className="vt-palette-tools">
          <button
            type="button"
            className={`vt-btn is-small${open ? ' is-active' : ''}`}
            aria-expanded={open}
            title="Narrow the catalogue by what a flow takes, what it gives, and where it belongs"
            onClick={() => setOpen((was) => !was)}
          >
            {open ? '▾' : '▸'} Filters
            {narrowing > 0 ? <span className="vt-chip-count">{narrowing}</span> : null}
          </button>
          {isFlowFilterEmpty(filter) ? null : (
            <button
              type="button"
              className="vt-btn is-ghost is-small"
              onClick={() => setFilter(EMPTY_FLOW_FILTER)}
            >
              Clear
            </button>
          )}
        </div>

        {open ? (
          <div className="vt-facets">
            <Facet
              title="Takes"
              hint="Flows with an input port that accepts this kind of file — what you can plug a file into."
              options={facets.inputs}
              chosen={filter.inputs}
              onToggle={(value: ArtifactKind) => patch({ inputs: toggleFacet(filter.inputs, value) })}
            />
            <Facet
              title="Gives"
              hint="Flows with an output port that produces this kind of file — what could feed a port you have."
              options={facets.outputs}
              chosen={filter.outputs}
              onToggle={(value: ArtifactKind) => patch({ outputs: toggleFacet(filter.outputs, value) })}
            />
            <Facet
              title="Stage"
              hint="Where in making a clip the flow belongs."
              options={facets.categories}
              chosen={filter.categories}
              onToggle={(value: FlowCategory) =>
                patch({ categories: toggleFacet(filter.categories, value) })
              }
            />
            <p className="vt-faint vt-facet-note">
              Within a row, any one counts. Across rows, all must hold.
            </p>
          </div>
        ) : null}

        <div className="vt-faint" style={{ marginTop: 6, fontSize: 11 }}>
          {matches.length} flow kind{matches.length === 1 ? '' : 's'}
          {matches.length === defs.length ? '' : ` of ${defs.length}`} · click to add
        </div>
      </header>

      <div className="vt-palette-list">
        {[...grouped.entries()].map(([category, group]) => (
          <div key={category} className="vt-palette-group">
            <h3>{FLOW_CATEGORY_LABEL[category]}</h3>
            {group.map((def) => (
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
        {matches.length === 0 ? (
          <div className="vt-empty">
            Nothing matches
            {filter.query.trim() ? ` “${filter.query.trim()}”` : ''}
            {narrowing > 0 ? ` with ${narrowing} filter${narrowing === 1 ? '' : 's'} on` : ''}.
            <br />
            <button type="button" className="vt-btn is-ghost is-small" onClick={() => setFilter(EMPTY_FLOW_FILTER)}>
              Clear the filters
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
