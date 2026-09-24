import { useEffect, useState } from 'react';
import {
  DURATION_UNITS,
  durationOf,
  formatEventDuration,
  formatPartialTime,
  formatPlace,
  parsePartialTime,
  parsePlacePath,
  precisionOf,
  shiftTime,
  type DurationUnit,
  type EventPlace,
  type MapPlace,
  type PartialTime,
  type TimelineEvent,
} from '@vibetoon/shared';
import { Field } from '../common/Field';

const FIELDS: Array<{ key: keyof PartialTime; label: string; min: number; max: number }> = [
  { key: 'year', label: 'Year', min: -100000, max: 100000 },
  { key: 'month', label: 'Month', min: 1, max: 12 },
  { key: 'day', label: 'Day', min: 1, max: 31 },
  { key: 'hour', label: 'Hour', min: 0, max: 23 },
  { key: 'minute', label: 'Min', min: 0, max: 59 },
  { key: 'second', label: 'Sec', min: 0, max: 59 },
];

/**
 * A time, as much of it as is known.
 *
 * Typed as words — `March 2004`, `c. 1999`, `2004-03-15 14:30` — or field by
 * field, where an empty field is unknown. The two stay in step: typing fills the
 * fields, and the fields are what is saved.
 */
function PartialTimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PartialTime;
  onChange(value: PartialTime): void;
}): JSX.Element {
  const [text, setText] = useState(formatPartialTime(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(value.year === undefined ? '' : formatPartialTime(value));
    setBad(false);
  }, [value]);

  const commit = () => {
    if (!text.trim()) {
      onChange({});
      return;
    }
    const parsed = parsePartialTime(text);
    if (!parsed) {
      setBad(true);
      return;
    }
    onChange(parsed);
  };

  const precision = precisionOf(value);
  return (
    <div className="vt-partial-time">
      <Field
        label={label}
        tip="timeline.time"
        hint={
          bad
            ? 'Not a time this can read — try “2004”, “March 2004”, “15 Mar 2004 14:30” or “c. 1999”.'
            : precision
              ? `Known to the ${precision}${value.circa ? ', roughly' : ''}.`
              : 'Undated.'
        }
      >
        <input
          type="text"
          value={text}
          aria-label={`${label}, typed`}
          placeholder="Undated — type a time"
          className={bad ? 'is-invalid' : ''}
          onChange={(event) => {
            setText(event.target.value);
            setBad(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
      </Field>
      <div className="vt-partial-fields">
        {FIELDS.map((field) => (
          <label key={field.key} className="vt-partial-field">
            <span>{field.label}</span>
            <input
              type="number"
              min={field.min}
              max={field.max}
              value={value[field.key] === undefined ? '' : String(value[field.key])}
              aria-label={`${label} ${field.label}`}
              onChange={(event) => {
                const raw = event.target.value;
                const next: PartialTime = { ...value };
                if (raw === '') delete next[field.key];
                else (next[field.key] as number | undefined) = Number(raw);
                onChange(next);
              }}
            />
          </label>
        ))}
        <label className="vt-row vt-partial-field" style={{ gap: 4 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={Boolean(value.circa)}
            onChange={(event) => onChange({ ...value, circa: event.target.checked || undefined })}
          />
          <span>About</span>
        </label>
      </div>
    </div>
  );
}

/** A list of words as removable chips, with a box to add more from suggestions. */
function Chips({
  label,
  values,
  suggestions,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  suggestions: string[];
  onChange(values: string[]): void;
  placeholder: string;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const listId = `chips-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const add = () => {
    const clean = draft.trim();
    if (clean && !values.some((value) => value.toLowerCase() === clean.toLowerCase())) onChange([...values, clean]);
    setDraft('');
  };
  return (
    <Field label={label}>
      <div className="vt-chips">
        {values.map((value) => (
          <span key={value} className="vt-chip">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((one) => one !== value))}>
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          list={listId}
          value={draft}
          aria-label={`Add to ${label}`}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <datalist id={listId}>
          {suggestions
            .filter((suggestion) => !values.includes(suggestion))
            .map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
        </datalist>
      </div>
    </Field>
  );
}

/** One event, every part of it editable. */
export function TimelineEventPanel({
  event,
  characters,
  places,
  mapPlaces,
  tags,
  onChange,
  onDelete,
  onClose,
}: {
  event: TimelineEvent;
  characters: string[];
  places: string[];
  mapPlaces: MapPlace[];
  tags: string[];
  onChange(change: Partial<TimelineEvent>): void;
  onDelete(): void;
  onClose(): void;
}): JSX.Element {
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState<DurationUnit>('day');
  const duration = durationOf(event);
  const setPlace = (index: number, change: Partial<EventPlace>) =>
    onChange({ places: event.places.map((place, at) => (at === index ? { ...place, ...change } : place)) });

  return (
    <div className="vt-section vt-timeline-panel" aria-label={`Event: ${event.title}`}>
      <h3>
        <span>Event</span>
        <span className="vt-row" style={{ gap: 4 }}>
          <button type="button" className="vt-btn is-small is-danger is-ghost" onClick={onDelete}>
            Delete
          </button>
          <button type="button" className="vt-btn is-small is-ghost" onClick={onClose}>
            Close
          </button>
        </span>
      </h3>

      <div className="vt-timeline-panel-grid">
        <div>
          <Field label="Title">
            <input type="text" value={event.title} aria-label="Title" onChange={(change) => onChange({ title: change.target.value })} />
          </Field>
          <Field label="Details" hint="What happened.">
            <textarea rows={5} value={event.details} aria-label="Details" onChange={(change) => onChange({ details: change.target.value })} />
          </Field>
          <Field label="Color" tip="timeline.color" hint={event.color ? 'Its own color, over the color setting.' : 'From the color setting.'}>
            <div className="vt-row" style={{ gap: 6 }}>
              <input
                type="color"
                value={event.color ?? '#8a93a6'}
                aria-label="Event color"
                onChange={(change) => onChange({ color: change.target.value })}
              />
              {event.color ? (
                <button type="button" className="vt-btn is-small is-ghost" onClick={() => onChange({ color: undefined })}>
                  Use the setting
                </button>
              ) : null}
            </div>
          </Field>
        </div>

        <div>
          <PartialTimeInput label={event.end ? 'Starts' : 'When'} value={event.start} onChange={(start) => onChange({ start })} />
          <label className="vt-row" style={{ gap: 6, margin: '4px 0 8px' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={Boolean(event.end)}
              onChange={(change) =>
                onChange({ end: change.target.checked ? (shiftTime(event.start, 1, 'day') ?? { ...event.start }) : undefined })
              }
            />
            <span>Lasts a while — has an end</span>
          </label>
          {event.end ? (
            <>
              <PartialTimeInput label="Ends" value={event.end} onChange={(end) => onChange({ end })} />
              <Field label="Lasts" tip="timeline.duration" hint={duration !== null ? formatEventDuration(duration) : 'Ends before it starts, or undated.'}>
                <div className="vt-row" style={{ gap: 4 }}>
                  <input
                    type="number"
                    min={0}
                    value={amount}
                    style={{ width: 70 }}
                    aria-label="Duration amount"
                    onChange={(change) => setAmount(Number(change.target.value))}
                  />
                  <select value={unit} aria-label="Duration unit" onChange={(change) => setUnit(change.target.value as DurationUnit)}>
                    {DURATION_UNITS.map((one) => (
                      <option key={one} value={one}>
                        {one}s
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="vt-btn is-small"
                    disabled={!precisionOf(event.start)}
                    onClick={() => {
                      const end = shiftTime(event.start, amount, unit);
                      if (end) onChange({ end });
                    }}
                  >
                    Set the end
                  </button>
                </div>
              </Field>
            </>
          ) : null}
          <Field label="About the time" hint="Anything the fields cannot say: “the night of the storm”.">
            <input type="text" value={event.timeNote ?? ''} aria-label="About the time" onChange={(change) => onChange({ timeNote: change.target.value || undefined })} />
          </Field>
        </div>

        <div>
          <Field label="Where" tip="timeline.place">
            <div className="vt-timeline-places">
              {event.places.map((place, index) => (
                <div key={index} className="vt-timeline-place">
                  <input
                    type="text"
                    list="timeline-place-names"
                    value={place.path.join(' / ')}
                    placeholder="Continent / Country / City / Street"
                    aria-label={`Place ${index + 1}`}
                    onChange={(change) => setPlace(index, { path: parsePlacePath(change.target.value) })}
                  />
                  {mapPlaces.length > 0 ? (
                    <select
                      value={place.locationId ?? ''}
                      aria-label={`Place ${index + 1} on the map`}
                      onChange={(change) => {
                        const found = mapPlaces.find((one) => one.id === change.target.value);
                        setPlace(index, found ? { locationId: found.id, path: found.path } : { locationId: undefined });
                      }}
                    >
                      <option value="">Not on the map</option>
                      {mapPlaces.map((one) => (
                        <option key={one.id} value={one.id}>
                          {one.path.join(' / ')}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <label className="vt-row" style={{ gap: 4 }} title="The narrowest part is a guess">
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={Boolean(place.approximate)}
                      onChange={(change) => setPlace(index, { approximate: change.target.checked || undefined })}
                    />
                    <span>Near</span>
                  </label>
                  <button
                    type="button"
                    className="vt-btn is-small is-ghost"
                    aria-label={`Remove place ${index + 1}`}
                    onClick={() => onChange({ places: event.places.filter((_, at) => at !== index) })}
                  >
                    ×
                  </button>
                  <span className="vt-faint" style={{ fontSize: 11 }}>
                    {formatPlace(place)}
                  </span>
                </div>
              ))}
              <datalist id="timeline-place-names">
                {places.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button type="button" className="vt-btn is-small" onClick={() => onChange({ places: [...event.places, { path: [] }] })}>
                + Place
              </button>
            </div>
          </Field>
          <Chips label="Characters" values={event.characters} suggestions={characters} onChange={(values) => onChange({ characters: values })} placeholder="Add someone…" />
          <Chips label="Tags" values={event.tags} suggestions={tags} onChange={(values) => onChange({ tags: values })} placeholder="Add a tag…" />
        </div>
      </div>

      <Field label="Dialog" hint="What was said, line by line.">
        <div className="vt-timeline-dialog">
          {event.dialog.map((line, index) => (
            <div key={index} className="vt-timeline-line">
              <input
                type="text"
                list="timeline-character-names"
                value={line.character}
                placeholder="Who"
                aria-label={`Line ${index + 1} speaker`}
                onChange={(change) =>
                  onChange({ dialog: event.dialog.map((one, at) => (at === index ? { ...one, character: change.target.value } : one)) })
                }
              />
              <input
                type="text"
                value={line.line}
                placeholder="What they say"
                aria-label={`Line ${index + 1}`}
                onChange={(change) =>
                  onChange({ dialog: event.dialog.map((one, at) => (at === index ? { ...one, line: change.target.value } : one)) })
                }
              />
              <input
                type="text"
                value={line.direction ?? ''}
                placeholder="How (optional)"
                aria-label={`Line ${index + 1} direction`}
                onChange={(change) =>
                  onChange({
                    dialog: event.dialog.map((one, at) => (at === index ? { ...one, direction: change.target.value || undefined } : one)),
                  })
                }
              />
              <button
                type="button"
                className="vt-btn is-small is-ghost"
                aria-label={`Move line ${index + 1} up`}
                disabled={index === 0}
                onClick={() => {
                  const next = [...event.dialog];
                  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                  onChange({ dialog: next });
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="vt-btn is-small is-ghost"
                aria-label={`Remove line ${index + 1}`}
                onClick={() => onChange({ dialog: event.dialog.filter((_, at) => at !== index) })}
              >
                ×
              </button>
            </div>
          ))}
          <datalist id="timeline-character-names">
            {[...new Set([...event.characters, ...characters])].map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <button
            type="button"
            className="vt-btn is-small"
            onClick={() => onChange({ dialog: [...event.dialog, { character: event.characters[0] ?? '', line: '' }] })}
          >
            + Line
          </button>
        </div>
      </Field>
    </div>
  );
}
