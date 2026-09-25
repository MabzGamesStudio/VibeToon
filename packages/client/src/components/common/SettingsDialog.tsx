import { useEffect, useMemo, useState } from 'react';
import {
  FLOW_CATEGORIES,
  FLOW_CATEGORY_LABEL,
  FLOW_KINDS,
  SLIDER_RANGES,
  validateSliderOverrides,
  type SliderRangeDef,
  type SliderRangeOverride,
} from '@vibetoon/shared';
import { useSliderRanges } from '../../state/sliderRanges';
import { Modal } from './Modal';

type Field = 'min' | 'max' | 'step';

const FIELDS: Array<{ id: Field; label: string }> = [
  { id: 'min', label: 'Lowest' },
  { id: 'max', label: 'Highest' },
  { id: 'step', label: 'Step' },
];

/** A number as short as it can be written. */
const show = (value: number) => String(Number(value.toPrecision(6)));

/** One slider's ends, edited in place and saved when a field is left. */
function RangeRow({ range }: { range: SliderRangeDef }): JSX.Element {
  const { overrides, setRange } = useSliderRanges();
  const saved = overrides[range.key];
  const current = useMemo(
    () => ({ min: saved?.min ?? range.min, max: saved?.max ?? range.max, step: saved?.step ?? range.step }),
    [range, saved?.min, saved?.max, saved?.step],
  );
  const [draft, setDraft] = useState<Record<Field, string>>({ min: show(current.min), max: show(current.max), step: show(current.step) });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft({ min: show(current.min), max: show(current.max), step: show(current.step) });
    setError(null);
  }, [current]);

  const commit = (next: Record<Field, string>) => {
    const change: SliderRangeOverride = {};
    for (const { id } of FIELDS) {
      const text = next[id].trim();
      if (text === '') continue;
      const number = Number(text);
      if (!Number.isFinite(number)) {
        setError(`“${text}” is not a number.`);
        return;
      }
      change[id] = number;
    }
    const checked = validateSliderOverrides({ [range.key]: change });
    if (!checked.ok) {
      const reason = checked.error.replace(`${range.label}: `, '');
      setError(reason.charAt(0).toUpperCase() + reason.slice(1));
      return;
    }
    setError(null);
    setRange(range.key, checked.value[range.key] ?? null);
  };

  const changed = Boolean(saved);
  return (
    <tr className={changed ? 'is-changed' : undefined}>
      <th scope="row">
        {range.label}
        {range.unit ? <span className="vt-faint"> · {range.unit}</span> : null}
        {error ? <div className="vt-slider-range-error">{error}</div> : null}
      </th>
      <td className="vt-faint">
        {show(range.min)} to {show(range.max)}, by {show(range.step)}
      </td>
      {FIELDS.map(({ id, label }) => (
        <td key={id}>
          <input
            type="number"
            value={draft[id]}
            step="any"
            aria-label={`${range.label}: ${label.toLowerCase()}`}
            className={saved?.[id] !== undefined ? 'is-changed' : undefined}
            onChange={(event) => setDraft({ ...draft, [id]: event.target.value })}
            onBlur={() => commit(draft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(draft);
              if (event.key === 'Escape') {
                event.stopPropagation();
                setDraft({ min: show(current.min), max: show(current.max), step: show(current.step) });
                setError(null);
              }
            }}
          />
        </td>
      ))}
      <td>
        <button
          type="button"
          className="vt-btn is-small is-ghost"
          disabled={!changed}
          aria-label={`Reset ${range.label}`}
          onClick={() => setRange(range.key, null)}
        >
          Reset
        </button>
      </td>
    </tr>
  );
}

interface Group {
  id: string;
  title: string;
  subtitle: string;
  sections: Array<{ name: string; ranges: SliderRangeDef[] }>;
}

/** Sliders by the flow they are in, flows in the order the palette lists them. */
function groups(query: string, onlyChanged: boolean, changed: Set<string>): Array<{ category: string; groups: Group[] }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (range: SliderRangeDef, flowLabel: string) =>
    (!onlyChanged || changed.has(range.key)) &&
    words.every((word) => `${range.label} ${range.section} ${flowLabel} ${range.key}`.toLowerCase().includes(word));

  const build = (id: string, title: string, subtitle: string, ranges: SliderRangeDef[]): Group | null => {
    const visible = ranges.filter((range) => shown(range, title));
    if (visible.length === 0) return null;
    const sections = new Map<string, SliderRangeDef[]>();
    for (const range of visible) sections.set(range.section, [...(sections.get(range.section) ?? []), range]);
    return { id, title, subtitle, sections: [...sections].map(([name, list]) => ({ name, ranges: list })) };
  };

  const out = FLOW_CATEGORIES.map((category) => ({
    category: FLOW_CATEGORY_LABEL[category],
    groups: FLOW_KINDS.filter((kind) => kind.category === category)
      .map((kind) => build(kind.kind, kind.label, kind.kind, SLIDER_RANGES.filter((range) => range.flows.includes(kind.kind))))
      .filter((group): group is Group => group !== null),
  }));
  const loose = build('other', 'Connections', 'on the graph', SLIDER_RANGES.filter((range) => range.flows.length === 0));
  if (loose) out.push({ category: 'Everywhere else', groups: [loose] });
  return out.filter((entry) => entry.groups.length > 0);
}

/**
 * Settings for this installation: how far every slider reaches.
 *
 * Laid out by flow, as the flows are listed on the graph, so a slider is found
 * where it is used. A change takes effect in every editor at once and is kept
 * on this machine, for every project.
 */
export function SettingsDialog({ onClose }: { onClose(): void }): JSX.Element {
  const { overrides, resetAll } = useSliderRanges();
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const changed = useMemo(() => new Set(Object.keys(overrides)), [overrides]);
  const laidOut = useMemo(() => groups(query, onlyChanged, changed), [query, onlyChanged, changed]);

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="vt-faint" style={{ marginRight: 'auto', fontSize: 12 }}>
            Kept on this machine for every project. {changed.size} of {SLIDER_RANGES.length} sliders changed.
          </span>
          <button
            type="button"
            className="vt-btn is-ghost"
            disabled={changed.size === 0}
            onClick={() => {
              if (window.confirm('Put every slider back to its own range?')) resetAll();
            }}
          >
            Reset all
          </button>
          <button type="button" className="vt-btn is-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="vt-settings">
        <h3>Slider ranges</h3>
        <p className="vt-hint">
          The lowest and highest value each slider reaches, and how far one notch moves it. Narrow a range to
          make fine changes easier, or widen it to go past what the defaults allow. A value already set outside
          a range is kept, and shown; the slider stops at its end.
        </p>
        <div className="vt-row" style={{ gap: 8, margin: '10px 0' }}>
          <input
            type="search"
            value={query}
            placeholder="Find a slider or a flow…"
            aria-label="Find a slider"
            style={{ flex: 1 }}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="vt-row" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={onlyChanged} onChange={(event) => setOnlyChanged(event.target.checked)} />
            Only changed
          </label>
        </div>

        {laidOut.length === 0 ? <p className="vt-faint">No slider matches.</p> : null}
        {laidOut.map(({ category, groups: flows }) => (
          <div key={category} className="vt-settings-category">
            <h4>{category}</h4>
            {flows.map((group) => (
              <section key={group.id} className="vt-settings-flow" aria-label={`${group.title} sliders`}>
                <header>
                  <strong>{group.title}</strong>
                  <span className="vt-faint">{group.subtitle}</span>
                </header>
                <table className="vt-slider-ranges">
                  <thead>
                    <tr>
                      <th>Slider</th>
                      <th>Default</th>
                      <th>Lowest</th>
                      <th>Highest</th>
                      <th>Step</th>
                      <th aria-label="Reset" />
                    </tr>
                  </thead>
                  {group.sections.map((section) => (
                    <tbody key={section.name}>
                      <tr className="vt-slider-range-section">
                        <td colSpan={6}>{section.name}</td>
                      </tr>
                      {section.ranges.map((range) => (
                        <RangeRow key={range.key} range={range} />
                      ))}
                    </tbody>
                  ))}
                </table>
              </section>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
