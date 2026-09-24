import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_COLOR_SETTING,
  EMPTY_FILTER,
  addEvent,
  charactersIn,
  clampView,
  colorKeyOf,
  colorLegend,
  deleteEvent,
  durationOf,
  emptyTimelineFlowData,
  eventColor,
  eventRange,
  eventsFromBrief,
  exportEvents,
  formatEventDuration,
  formatPartialTime,
  formatPlace,
  hashedColor,
  layoutLanes,
  matchesFilter,
  newEvent,
  parsePartialTime,
  parsePlacePath,
  partialFromMs,
  precisionOf,
  sortEvents,
  spanRange,
  ticksFor,
  timeRange,
  updateEvent,
  utc,
  withDuration,
  zoomView,
  type TimelineEvent,
} from '../src/flows/timeline';
import * as timelineModule from '../src/flows/timeline';
import { migrateNode } from '../src/project/migrate';
import type { FlowNode } from '../src/types/project';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function event(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return { ...newEvent(over.id ?? 'e', over.start ?? { year: 2004 }), ...over };
}

/* ---------------- partial times ---------------- */

test('a partial time stands for all the time it could be', () => {
  assert.deepEqual(timeRange({ year: 2004 }), { from: utc(2004), to: utc(2005) });
  const march = timeRange({ year: 2004, month: 3 })!;
  assert.equal(iso(march.from), '2004-03-01T00:00:00.000Z');
  assert.equal(iso(march.to), '2004-04-01T00:00:00.000Z');
  const minute = timeRange({ year: 2004, month: 3, day: 15, hour: 14, minute: 30 })!;
  assert.equal(minute.to - minute.from, 60_000);
  assert.equal(timeRange({}), null, 'no year is undated');
  assert.equal(precisionOf({ year: 2004, day: 3 }), 'year', 'a day with no month says nothing placeable');
});

test('December rolls into the next year, and years before 100 are not read as 19xx', () => {
  assert.equal(iso(timeRange({ year: 1999, month: 12 })!.to), '2000-01-01T00:00:00.000Z');
  assert.equal(new Date(utc(44)).getUTCFullYear(), 44);
  assert.equal(new Date(utc(-499)).getUTCFullYear(), -499);
});

test('what people type is read as the time they meant, or not at all', () => {
  assert.deepEqual(parsePartialTime('2004'), { year: 2004 });
  assert.deepEqual(parsePartialTime('2004-03'), { year: 2004, month: 3 });
  assert.deepEqual(parsePartialTime('2004-03-15 14:30'), { year: 2004, month: 3, day: 15, hour: 14, minute: 30 });
  assert.deepEqual(parsePartialTime('2004-03-15T14:30:05Z'), { year: 2004, month: 3, day: 15, hour: 14, minute: 30, second: 5 });
  assert.deepEqual(parsePartialTime('March 2004'), { year: 2004, month: 3 });
  assert.deepEqual(parsePartialTime('15 March 2004'), { year: 2004, month: 3, day: 15 });
  assert.deepEqual(parsePartialTime('Mar 15, 2004'), { year: 2004, month: 3, day: 15 });
  assert.deepEqual(parsePartialTime('c. 1999'), { year: 1999, circa: true });
  assert.deepEqual(parsePartialTime('1999?'), { year: 1999, circa: true });
  assert.deepEqual(parsePartialTime('500 BC'), { year: -499 });
  assert.equal(parsePartialTime('the night of the flood'), null);
  assert.equal(parsePartialTime('2004-13'), null, 'no thirteenth month');
  assert.equal(parsePartialTime('Smarch 2004'), null);
});

test('a partial time is written the way it is known', () => {
  assert.equal(formatPartialTime({ year: 2004 }), '2004');
  assert.equal(formatPartialTime({ year: 2004, month: 3 }), 'Mar 2004');
  assert.equal(formatPartialTime({ year: 2004, month: 3, day: 15, hour: 14, minute: 30 }), '15 Mar 2004, 14:30');
  assert.equal(formatPartialTime({ year: 2004, month: 3, day: 15, hour: 9 }), '15 Mar 2004, 09h');
  assert.equal(formatPartialTime({ year: 1999, circa: true }), 'c. 1999');
  assert.equal(formatPartialTime({ year: -499 }), '500 BC');
  assert.equal(formatPartialTime({}), 'Undated');
});

test('an instant turns back into a partial time at any precision', () => {
  const at = Date.parse('2010-07-04T18:45:12Z');
  assert.deepEqual(partialFromMs(at, 'day'), { year: 2010, month: 7, day: 4 });
  assert.deepEqual(partialFromMs(at), { year: 2010, month: 7, day: 4, hour: 18, minute: 45, second: 12 });
  assert.deepEqual(partialFromMs(at, 'year'), { year: 2010 });
});

/* ---------------- events over time ---------------- */

test('a timespan with vague ends has a certain middle and uncertain edges', () => {
  const war = event({ start: { year: 1939 }, end: { year: 1945 } });
  const range = eventRange(war)!;
  assert.equal(iso(range.from), '1939-01-01T00:00:00.000Z');
  assert.equal(iso(range.to), '1946-01-01T00:00:00.000Z');
  assert.equal(iso(range.sure!.from), '1940-01-01T00:00:00.000Z', 'certainly on by the end of 1939');
  assert.equal(iso(range.sure!.to), '1945-01-01T00:00:00.000Z', 'certainly still on until 1945 began');
  assert.equal(eventRange(event({ start: { year: 2004, month: 3 } }))!.sure, null, 'a vague moment has no certain part');
});

test('duration is start to end, and setting one moves the end', () => {
  const trip = event({ start: { year: 2004, month: 3, day: 1 }, end: { year: 2004, month: 3, day: 11 } });
  assert.equal(durationOf(trip), 10 * DAY);
  assert.equal(formatEventDuration(10 * DAY), '10 days');
  assert.equal(formatEventDuration(26 * 3_600_000), '1 day 2 h');
  const longer = withDuration(trip, 3 * DAY + 4 * 3_600_000);
  assert.deepEqual(longer.end, { year: 2004, month: 3, day: 4, hour: 4 });
  assert.equal(durationOf(event({ end: undefined })), null, 'a moment has no duration');
});

test('events sort by time, undated at the end', () => {
  const sorted = sortEvents([
    event({ id: 'late', start: { year: 2010 } }),
    event({ id: 'none', start: {} }),
    event({ id: 'early', start: { year: 2001, month: 6 } }),
  ]);
  assert.deepEqual(sorted.map((one) => one.id), ['early', 'late', 'none']);
});

/* ---------------- places ---------------- */

test('a place is a path cut off where knowledge runs out', () => {
  assert.deepEqual(parsePlacePath('Europe / France / Paris'), ['Europe', 'France', 'Paris']);
  assert.deepEqual(parsePlacePath('Europe > France'), ['Europe', 'France']);
  assert.equal(formatPlace({ path: ['France', 'Paris'], approximate: true }), 'near France / Paris');
  assert.equal(formatPlace({ path: [] }), 'Somewhere');
});

/* ---------------- filtering and color ---------------- */

const cast: TimelineEvent[] = [
  event({ id: 'a', title: 'The heist', characters: ['Ada', 'Bo'], places: [{ path: ['Europe', 'France', 'Paris'] }], tags: ['crime'] }),
  event({ id: 'b', title: 'The escape', characters: ['Bo'], places: [{ path: ['Europe', 'Spain'] }], dialog: [{ character: 'Bo', line: 'Run, the vault is open!' }] }),
  event({ id: 'c', title: 'A quiet day', characters: ['Cy'], places: [{ path: ['Asia', 'Japan'] }], tags: ['calm'] }),
];

test('filters narrow by words, people, places and tags', () => {
  const pick = (filter: Partial<typeof EMPTY_FILTER>) =>
    cast.filter((one) => matchesFilter(one, { ...EMPTY_FILTER, ...filter })).map((one) => one.id);
  assert.deepEqual(pick({}), ['a', 'b', 'c']);
  assert.deepEqual(pick({ text: 'vault' }), ['b'], 'dialog is searched');
  assert.deepEqual(pick({ text: 'the escape' }), ['b'], 'every word must appear');
  assert.deepEqual(pick({ characters: ['bo'] }), ['a', 'b']);
  assert.deepEqual(pick({ places: ['europe'] }), ['a', 'b'], 'any level of the path');
  assert.deepEqual(pick({ tags: ['calm'] }), ['c']);
  assert.deepEqual(pick({ characters: ['Bo'], places: ['Spain'] }), ['b'], 'filters combine');
});

test('color follows the chosen setting, and a chosen or own color wins', () => {
  const byCharacter = { ...DEFAULT_COLOR_SETTING, by: 'character' as const };
  assert.equal(colorKeyOf(cast[0]!, byCharacter), 'Ada');
  assert.equal(eventColor(cast[0]!, byCharacter), hashedColor('Ada'));
  assert.equal(hashedColor('Ada'), hashedColor('ada'), 'the same name, the same color');
  const byPlace = { ...DEFAULT_COLOR_SETTING, by: 'place' as const, placeLevel: 2 };
  assert.equal(colorKeyOf(cast[0]!, byPlace), 'France');
  assert.equal(colorKeyOf(cast[1]!, { ...byPlace, placeLevel: 5 }), 'Spain', 'a short path gives its narrowest part');
  const chosen = { ...byCharacter, chosen: { 'character:ada': '#123456' } };
  assert.equal(eventColor(cast[0]!, chosen), '#123456');
  assert.equal(eventColor({ ...cast[0]!, color: '#abcdef' }, chosen), '#abcdef');
  const keywords = { ...DEFAULT_COLOR_SETTING, by: 'keyword' as const, keywords: [{ word: 'vault', color: '#ff0000' }] };
  assert.equal(eventColor(cast[1]!, keywords), '#ff0000');
  assert.equal(eventColor(cast[2]!, keywords), '#8a93a6', 'no rule matched');
});

test('the legend lists values most used first', () => {
  const legend = colorLegend(cast, { ...DEFAULT_COLOR_SETTING, by: 'place', placeLevel: 1 });
  assert.deepEqual(legend.map((entry) => [entry.key, entry.count]), [['Europe', 2], ['Asia', 1]]);
  assert.deepEqual(charactersIn(cast, ['Dee']), ['Ada', 'Bo', 'Cy', 'Dee']);
});

/* ---------------- the view and the axis ---------------- */

test('the span runs from its start to the end of today unless given an end', () => {
  const now = Date.parse('2026-09-24T15:00:00Z');
  const range = spanRange({ start: '2000-01-01T00:00:00.000Z', end: null }, now);
  assert.equal(iso(range.from), '2000-01-01T00:00:00.000Z');
  assert.equal(iso(range.to), '2026-09-25T00:00:00.000Z');
  assert.equal(emptyTimelineFlowData().span.start, '2000-01-01T00:00:00.000Z');
  assert.equal(emptyTimelineFlowData().span.end, null, 'today, whenever today is');
});

test('zooming keeps the moment under the pointer still, and the view stays inside the span', () => {
  const span = { from: 0, to: 1000 * DAY };
  const view = { from: 100 * DAY, to: 300 * DAY };
  const zoomed = zoomView(view, 0.5, 200 * DAY, span);
  assert.equal(zoomed.from, 150 * DAY);
  assert.equal(zoomed.to, 250 * DAY);
  const out = zoomView(view, 100, 200 * DAY, span);
  assert.deepEqual(out, span, 'no further out than the span');
  assert.equal(clampView({ from: 990 * DAY, to: 1090 * DAY }, span).to, span.to, 'pushed back inside');
  assert.equal(clampView({ from: 0, to: 1 }, span).to, 60_000, 'no narrower than a minute');
});

test('ticks land on calendar boundaries at every zoom', () => {
  const years = ticksFor(utc(2000), utc(2026), 1000);
  assert.ok(years.every((tick) => new Date(tick.at).getUTCMonth() === 0 && new Date(tick.at).getUTCDate() === 1));
  const months = ticksFor(utc(2004), utc(2005), 1200);
  assert.ok(months.length >= 4 && months.every((tick) => new Date(tick.at).getUTCDate() === 1), 'firsts of months');
  const hours = ticksFor(utc(2004, 3, 1), utc(2004, 3, 2), 1200);
  assert.ok(hours.every((tick) => new Date(tick.at).getUTCMinutes() === 0));
  const spaced = ticksFor(utc(2004, 3, 1, 10), utc(2004, 3, 1, 10, 30), 900, 90);
  assert.ok(spaced.length <= 11, 'at least the spacing apart');
});

test('lanes keep events from overlapping, and reuse a lane once it is clear', () => {
  const lanes = layoutLanes([
    { id: 'a', x0: 0, x1: 100 },
    { id: 'b', x0: 50, x1: 120 },
    { id: 'c', x0: 110, x1: 200 },
  ]);
  assert.equal(lanes.get('a'), 0);
  assert.equal(lanes.get('b'), 1);
  assert.equal(lanes.get('c'), 0);
});

/* ---------------- editing, reading back, writing out ---------------- */

test('events are added, edited and deleted with ids that are never reused', () => {
  let data = addEvent(emptyTimelineFlowData(), { year: 2004 }, 'One');
  data = addEvent(data, { year: 2005 }, 'Two');
  assert.deepEqual(data.events.map((one) => one.id), ['evt_1', 'evt_2']);
  assert.equal(data.selected, 'evt_2');
  data = updateEvent(data, 'evt_1', { title: 'First', characters: ['Ada'] });
  assert.equal(data.events[0]!.title, 'First');
  data = deleteEvent(data, 'evt_2');
  assert.equal(data.selected, undefined);
  assert.equal(addEvent(data, {}).events.at(-1)!.id, 'evt_3');
});

test('the old brief timeline opens as events', () => {
  const events = eventsFromBrief({ events: '2004-03 — The heist\nthe night of the flood — Everyone leaves', offscreen: '2005 — Bo gets caught' });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0]!.start, { year: 2004, month: 3 });
  assert.equal(events[0]!.title, 'The heist');
  assert.equal(timeRange(events[1]!.start), null, 'unreadable, so undated');
  assert.equal(events[1]!.timeNote, 'the night of the flood', 'but the words are kept');
  assert.deepEqual(events[2]!.tags, ['off-screen']);

  const node = {
    id: 'n',
    kind: 'story.timeline',
    name: 'Timeline',
    position: { x: 0, y: 0 },
    notes: '',
    outputs: [],
    data: { editor: 'brief', fields: { events: '1999 — Born', present: '', offscreen: '' } },
  } as unknown as FlowNode;
  const migrated = migrateNode(node).data;
  assert.equal(migrated.editor, 'timeline');
  assert.equal((migrated as ReturnType<typeof emptyTimelineFlowData>).events[0]!.title, 'Born');
});

test('a timeline stored before a setting existed gets it on the way in', () => {
  const node = {
    id: 'n',
    kind: 'story.timeline',
    name: 'Timeline',
    position: { x: 0, y: 0 },
    notes: '',
    outputs: [],
    data: { editor: 'timeline', span: { start: '2000-01-01T00:00:00.000Z', end: null }, events: [{ id: 'x', title: 'T', start: { year: 2000 } }] },
  } as unknown as FlowNode;
  const data = migrateNode(node).data as ReturnType<typeof emptyTimelineFlowData>;
  assert.deepEqual(data.filter, EMPTY_FILTER);
  assert.equal(data.color.by, 'character');
  assert.deepEqual(data.events[0]!.characters, []);
  assert.equal(data.seq, 1);
});

test('the output is every event, in time order, with its resolved time and color', () => {
  let data = emptyTimelineFlowData();
  data = { ...data, events: [cast[1]!, { ...cast[0]!, start: { year: 2001 }, end: { year: 2002, month: 6 } }] };
  const out = exportEvents(data);
  assert.deepEqual(out.map((one) => one.id), ['a', 'b']);
  assert.equal(out[0]!.from, '2001-01-01T00:00:00.000Z');
  assert.equal(out[0]!.when, '2001 – Jun 2002');
  assert.equal(out[0]!.places[0]!.label, 'Europe / France / Paris');
  assert.match(out[0]!.color, /^#[0-9a-f]{6}$/);
  assert.ok(out[0]!.duration);
});

/* ---------------- what is wired in ---------------- */

test('character names come out of profiles, headings and JSON', () => {
  const { namesFromCharacters } = timelineModule;
  assert.deepEqual(namesFromCharacters('# Ada Lovelace — the inventor\n\nSome text.'), ['Ada Lovelace']);
  assert.deepEqual(namesFromCharacters('## Profile\n- **Name:** Bo\n- Role: thief'), ['Bo']);
  assert.deepEqual(namesFromCharacters('["Ada", {"name": "Bo"}, 3]'), ['Ada', 'Bo']);
  assert.deepEqual(namesFromCharacters('{"characters": [{"name": "Cy"}]}'), ['Cy']);
  assert.deepEqual(namesFromCharacters(''), []);
  assert.deepEqual(namesFromCharacters('# Dee\n\n*Character*\n\n## Name\n\nDee Marsh\n\n## Role\n\nThief'), ['Dee Marsh'], 'the brief’s own section wins over the flow’s title');
});

test('places come out of a map’s locations, the place itself last in its path', () => {
  const { placesFromMap } = timelineModule;
  const places = placesFromMap({
    locations: [
      { id: 'loc_1', name: 'Paris', path: ['Europe', 'France'], kind: 'city' },
      { id: 'loc_2', name: 'Rue X', path: ['Europe', 'France', 'Paris', 'Rue X'] },
      { name: '' },
      'junk',
    ],
  });
  assert.deepEqual(places.map((place) => place.path), [['Europe', 'France', 'Paris'], ['Europe', 'France', 'Paris', 'Rue X']]);
  assert.equal(places[0]!.kind, 'city');
  assert.deepEqual(placesFromMap(null), []);
});

test('a time moves by calendar units, as precise as the move needs', () => {
  const { shiftTime } = timelineModule;
  assert.deepEqual(shiftTime({ year: 2004, month: 3 }, 1, 'year'), { year: 2005, month: 3 });
  assert.deepEqual(shiftTime({ year: 2004, month: 3 }, 3, 'day'), { year: 2004, month: 3, day: 4 });
  assert.deepEqual(shiftTime({ year: 2004, month: 11 }, 3, 'month'), { year: 2005, month: 2 });
  assert.deepEqual(shiftTime({ year: 2004, month: 3, day: 1 }, 2, 'week'), { year: 2004, month: 3, day: 15 });
  assert.deepEqual(shiftTime({ year: 2004, month: 3, day: 1 }, 90, 'minute'), { year: 2004, month: 3, day: 1, hour: 1, minute: 30 });
  assert.equal(shiftTime({}, 1, 'day'), null);
});
