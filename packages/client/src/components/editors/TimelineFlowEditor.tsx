import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COLOR_BY,
  COLOR_BY_LABEL,
  EMPTY_FILTER,
  addEvent,
  charactersIn,
  clampView,
  colorLegend,
  deleteEvent,
  emptyTimelineFlowData,
  eventColor,
  eventRange,
  formatPartialTime,
  inputsForPort,
  isFiltering,
  matchesFilter,
  namesFromCharacters,
  partialFromMs,
  placesFromMap,
  placesIn,
  sortEvents,
  spanRange,
  summariseTimeline,
  tagsIn,
  timeRange,
  updateEvent,
  zoomView,
  type ColorBy,
  type FlowNode,
  type MapPlace,
  type Project,
  type TimelineFlowData,
  type TimelineView,
} from '@vibetoon/shared';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { Stage } from '../common/Stage';
import { EditorShell } from './EditorShell';
import { TimelineCanvas, TimelineOverview } from './TimelineCanvas';
import { TimelineEventPanel } from './TimelineEventPanel';

/** A UTC instant as the value of a `datetime-local` input, read as UTC. */
const toInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const fromInput = (value: string) => Date.parse(`${value}:00.000Z`);

/**
 * Events on a line through time.
 *
 * The line is the span — by default the first of January 2000 to today — and
 * the part of it on screen is chosen by zooming and dragging, with the whole
 * span always shown small above it and the part in view marked. Everything else
 * is about finding events and reading them: filters narrow what is drawn, a
 * color setting says what the colors mean, and selecting an event opens all of
 * it below.
 */
export function TimelineFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { setFlowData } = useStudio();
  const data = node.data.editor === 'timeline' ? (node.data as TimelineFlowData) : emptyTimelineFlowData();
  const patch = useCallback(
    (next: Partial<TimelineFlowData> | ((was: TimelineFlowData) => TimelineFlowData)) =>
      setFlowData(node.id, typeof next === 'function' ? next(data) : { ...data, ...next }),
    [data, node.id, setFlowData],
  );

  const span = useMemo(() => spanRange(data.span), [data.span]);

  /*
   * The view is held here while it moves, and written to the flow once it stops:
   * a wheel turn is twenty views, and saving the project twenty times for it
   * would make zooming stutter.
   */
  const [view, setView] = useState<TimelineView>(() => clampView(data.view ?? span, span));
  const saveTimer = useRef<number | undefined>(undefined);
  const dataRef = useRef(data);
  dataRef.current = data;
  const moveView = useCallback(
    (next: TimelineView) => {
      const clamped = clampView(next, span);
      setView(clamped);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => setFlowData(node.id, { ...dataRef.current, view: clamped }), 400);
    },
    [node.id, setFlowData, span],
  );
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  // A changed span pulls the view back inside it.
  useEffect(() => {
    setView((current) => clampView(current, span));
  }, [span]);

  /* ---------------- what is wired in ---------------- */

  const characterInputs = inputsForPort(project, node.id, 'characters');
  const placeInputs = inputsForPort(project, node.id, 'places');
  const [wiredNames, setWiredNames] = useState<string[]>([]);
  const [mapPlaces, setMapPlaces] = useState<MapPlace[]>([]);
  const characterKey = characterInputs.map((input) => input.artifact?.hash ?? '').join(',');
  const placeKey = placeInputs.map((input) => input.artifact?.hash ?? '').join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(
      characterInputs
        .filter((input) => input.artifact)
        .map((input) => fetch(api.artifactUrl(project.id, input.artifact!.path)).then((response) => (response.ok ? response.text() : ''))),
    ).then((bodies) => {
      if (live) setWiredNames([...new Set(bodies.flatMap(namesFromCharacters))]);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterKey, project.id]);
  useEffect(() => {
    let live = true;
    void Promise.all(
      placeInputs
        .filter((input) => input.artifact)
        .map((input) =>
          fetch(api.artifactUrl(project.id, input.artifact!.path))
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null),
        ),
    ).then((bodies) => {
      if (live) setMapPlaces(bodies.flatMap(placesFromMap));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey, project.id]);

  /* ---------------- finding and coloring ---------------- */

  const characters = useMemo(() => charactersIn(data.events, wiredNames), [data.events, wiredNames]);
  const places = useMemo(() => placesIn(data.events, mapPlaces.flatMap((place) => place.path)), [data.events, mapPlaces]);
  const tags = useMemo(() => tagsIn(data.events), [data.events]);
  const shown = useMemo(() => data.events.filter((event) => matchesFilter(event, data.filter)), [data.events, data.filter]);
  const dated = shown.filter((event) => timeRange(event.start));
  const undated = shown.filter((event) => !timeRange(event.start));
  const legend = useMemo(() => colorLegend(shown, data.color), [shown, data.color]);
  const selected = data.events.find((event) => event.id === data.selected);
  const filter = data.filter;
  const toggleIn = (list: string[], value: string) => (list.includes(value) ? list.filter((one) => one !== value) : [...list, value]);

  const add = (at: number, precision: Parameters<typeof partialFromMs>[1]) => {
    patch((was) => addEvent(was, partialFromMs(at, precision)));
  };

  /** Bring an event into view, keeping the zoom unless it does not fit. */
  const reveal = (id: string) => {
    const event = data.events.find((one) => one.id === id);
    const range = event ? eventRange(event) : null;
    patch({ selected: id });
    if (!range) return;
    const width = view.to - view.from;
    if (range.from >= view.from && range.to <= view.to) return;
    const wide = Math.max(width, (range.to - range.from) * 1.4);
    const middle = (range.from + range.to) / 2;
    moveView({ from: middle - wide / 2, to: middle + wide / 2 });
  };

  return (
    <EditorShell project={project} node={node}>
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>The span</h3>
          <Field label="From (UTC)" tip="timeline.span">
            <input
              type="datetime-local"
              value={toInput(Date.parse(data.span.start))}
              aria-label="Span start"
              onChange={(event) => {
                const ms = fromInput(event.target.value);
                if (Number.isFinite(ms)) patch({ span: { ...data.span, start: new Date(ms).toISOString() } });
              }}
            />
          </Field>
          <Field label="To (UTC)">
            <label className="vt-row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={data.span.end === null}
                onChange={(event) =>
                  patch({ span: { ...data.span, end: event.target.checked ? null : new Date(span.to).toISOString() } })
                }
              />
              <span>Today, whenever today is</span>
            </label>
            {data.span.end !== null ? (
              <input
                type="datetime-local"
                value={toInput(Date.parse(data.span.end))}
                aria-label="Span end"
                onChange={(event) => {
                  const ms = fromInput(event.target.value);
                  if (Number.isFinite(ms)) patch({ span: { ...data.span, end: new Date(ms).toISOString() } });
                }}
              />
            ) : null}
          </Field>
        </div>

        <div className="vt-section">
          <h3>
            <span>Find</span>
            {isFiltering(filter) ? (
              <button type="button" className="vt-btn is-small is-ghost" onClick={() => patch({ filter: { ...EMPTY_FILTER } })}>
                Clear
              </button>
            ) : null}
          </h3>
          <Field label="Words" tip="timeline.filter">
            <input
              type="search"
              value={filter.text}
              placeholder="Anything in an event…"
              aria-label="Filter by words"
              onChange={(event) => patch({ filter: { ...filter, text: event.target.value } })}
            />
          </Field>
          {(
            [
              ['Characters', 'characters', characters],
              ['Places', 'places', places],
              ['Tags', 'tags', tags],
            ] as const
          ).map(([label, key, options]) =>
            options.length > 0 ? (
              <Field key={key} label={label}>
                <div className="vt-chips is-toggles">
                  {options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`vt-chip${filter[key].includes(option) ? ' is-on' : ''}`}
                      aria-pressed={filter[key].includes(option)}
                      onClick={() => patch({ filter: { ...filter, [key]: toggleIn(filter[key], option) } })}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </Field>
            ) : null,
          )}
          <div className="vt-hint">
            {isFiltering(filter) ? `${shown.length} of ${data.events.length} event(s) shown.` : summariseTimeline(data)}
          </div>
        </div>

        <div className="vt-section">
          <h3>Color</h3>
          <Field label="Color events" tip="timeline.colorBy">
            <select
              value={data.color.by}
              aria-label="Color events"
              onChange={(event) => patch({ color: { ...data.color, by: event.target.value as ColorBy } })}
            >
              {COLOR_BY.map((by) => (
                <option key={by} value={by}>
                  {COLOR_BY_LABEL[by]}
                </option>
              ))}
            </select>
          </Field>
          {data.color.by === 'place' ? (
            <Slider
              label="Place level"
              tip="timeline.placeLevel"
              min={1}
              max={5}
              step={1}
              value={data.color.placeLevel}
              format={(value) => (value === 1 ? 'broadest' : `${value} deep`)}
              onChange={(placeLevel) => patch({ color: { ...data.color, placeLevel } })}
            />
          ) : null}
          {data.color.by === 'keyword' ? (
            <div className="vt-timeline-keywords">
              {data.color.keywords.map((rule, index) => (
                <div key={index} className="vt-row" style={{ gap: 4 }}>
                  <input
                    type="color"
                    value={rule.color}
                    aria-label={`Color for ${rule.word || 'keyword'}`}
                    onChange={(event) =>
                      patch({ color: { ...data.color, keywords: data.color.keywords.map((one, at) => (at === index ? { ...one, color: event.target.value } : one)) } })
                    }
                  />
                  <input
                    type="text"
                    value={rule.word}
                    placeholder="A word"
                    aria-label={`Keyword ${index + 1}`}
                    onChange={(event) =>
                      patch({ color: { ...data.color, keywords: data.color.keywords.map((one, at) => (at === index ? { ...one, word: event.target.value } : one)) } })
                    }
                  />
                  <button
                    type="button"
                    className="vt-btn is-small is-ghost"
                    aria-label={`Remove keyword ${index + 1}`}
                    onClick={() => patch({ color: { ...data.color, keywords: data.color.keywords.filter((_, at) => at !== index) } })}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="vt-btn is-small"
                onClick={() => patch({ color: { ...data.color, keywords: [...data.color.keywords, { word: '', color: '#e8705a' }] } })}
              >
                + Keyword
              </button>
              <div className="vt-hint">An event takes the color of the first keyword it contains.</div>
            </div>
          ) : null}
          {legend.length > 0 && data.color.by !== 'keyword' ? (
            <ul className="vt-timeline-legend">
              {legend.slice(0, 24).map((entry) => (
                <li key={entry.key}>
                  <input
                    type="color"
                    value={entry.color}
                    aria-label={`Color for ${entry.key}`}
                    onChange={(event) =>
                      patch({
                        color: { ...data.color, chosen: { ...data.color.chosen, [`${data.color.by}:${entry.key.toLowerCase()}`]: event.target.value } },
                      })
                    }
                  />
                  <span>{entry.key}</span>
                  <span className="vt-faint">{entry.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>
            <span>Events</span>
            <button
              type="button"
              className="vt-btn is-small"
              onClick={() => add((view.from + view.to) / 2, 'day')}
            >
              + Add
            </button>
          </h3>
          <div className="vt-timeline-list">
            {sortEvents(shown).map((event) => (
              <button
                key={event.id}
                type="button"
                className={`vt-timeline-row${event.id === data.selected ? ' is-active' : ''}`}
                onClick={() => reveal(event.id)}
              >
                <span className="vt-timeline-dot" style={{ background: eventColor(event, data.color) }} aria-hidden="true" />
                <span className="vt-lexeme-word">{event.title}</span>
                <span className="vt-faint">
                  {event.end ? `${formatPartialTime(event.start)} – ${formatPartialTime(event.end)}` : formatPartialTime(event.start)}
                </span>
              </button>
            ))}
            {shown.length === 0 ? (
              <div className="vt-hint">
                {data.events.length === 0 ? 'No events yet. Double-click the line, or press Add.' : 'Nothing matches the filter.'}
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="vt-editor-main">
        <Stage
          title="Timeline"
          tools={
            <>
              <span className="vt-faint" style={{ fontSize: 11 }}>
                {new Date(view.from).toISOString().slice(0, 10)} → {new Date(view.to).toISOString().slice(0, 10)} · scroll to zoom, drag to move,
                double-click to add
              </span>
              <span className="vt-zoom-controls">
                <button type="button" className="vt-btn is-small" aria-label="Zoom out" onClick={() => moveView(zoomView(view, 1.6, (view.from + view.to) / 2, span))}>
                  −
                </button>
                <button type="button" className="vt-btn is-small" title="Show the whole span" onClick={() => moveView(span)}>
                  All
                </button>
                <button type="button" className="vt-btn is-small" aria-label="Zoom in" onClick={() => moveView(zoomView(view, 1 / 1.6, (view.from + view.to) / 2, span))}>
                  +
                </button>
              </span>
            </>
          }
        >
          <div className="vt-timeline-stage">
            <TimelineOverview span={span} view={view} events={dated} color={data.color} onView={moveView} />
            <TimelineCanvas
              span={span}
              view={view}
              events={dated}
              color={data.color}
              selected={data.selected}
              onView={moveView}
              onSelect={(id) => patch({ selected: id })}
              onAdd={add}
            />
            {undated.length > 0 ? (
              <div className="vt-timeline-undated">
                <span className="vt-faint">Undated:</span>
                {undated.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={`vt-chip${event.id === data.selected ? ' is-on' : ''}`}
                    onClick={() => patch({ selected: event.id })}
                  >
                    <span className="vt-timeline-dot" style={{ background: eventColor(event, data.color) }} aria-hidden="true" />
                    {event.title}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </Stage>

        {selected ? (
          <TimelineEventPanel
            key={selected.id}
            event={selected}
            characters={characters}
            places={places}
            mapPlaces={mapPlaces}
            tags={tags}
            onChange={(change) => patch((was) => updateEvent(was, selected.id, change))}
            onDelete={() => patch((was) => deleteEvent(was, selected.id))}
            onClose={() => patch({ selected: undefined })}
          />
        ) : (
          <div className="vt-hint">Select an event to see and edit all of it — or double-click the line to add one there.</div>
        )}
      </div>
    </EditorShell>
  );
}
