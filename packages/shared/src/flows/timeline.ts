/**
 * A timeline of events, each happening at a time — or over a stretch of time —
 * and in a place or places, either of which may be known exactly or only in
 * part.
 *
 * **Partial is the ordinary case.** A story's history is full of "sometime in
 * 2004", "a spring morning in Paris", "the winter after the war". So a time is
 * stored as the fields that are known — year, month, day, hour, minute, second —
 * and a missing field is simply missing: "March 2004" is a year and a month and
 * nothing else, and it stands for the whole of March. Laid on the timeline it is
 * a bar a month long rather than a dot on the first of the month pretending to
 * be exact. `circa` marks a known field that is itself a guess.
 *
 * A place is the same idea: a path from broad to narrow — `Europe / France /
 * Paris / Rue de Rivoli` — cut off where knowledge runs out. "Somewhere in
 * France" is a path two long. A place can also name a location on a world map
 * flow wired in, so the two agree about where things are.
 *
 * Times are UTC throughout. A story's clock has no time zone until someone gives
 * it one, and a UTC timeline cannot shift an hour when it is opened somewhere
 * else.
 */

/* ------------------------------------------------------------------ *
 * Times, exact and partial
 * ------------------------------------------------------------------ */

export type TimePrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

export const TIME_PRECISIONS: readonly TimePrecision[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/** A moment, as much of it as is known. Any field may be missing; a missing field is unknown. */
export interface PartialTime {
  /** Negative for BC: -499 is 500 BC, the way astronomers count, with a year 0. */
  year?: number;
  /** 1–12. */
  month?: number;
  /** 1–31. */
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  /** The known fields are themselves a guess: "about 1999". */
  circa?: boolean;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Milliseconds in the unit each precision names, for the ones that are fixed. */
const UNIT_MS: Record<'day' | 'hour' | 'minute' | 'second', number> = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1000,
};

/** A UTC instant from calendar fields. Safe for years 0–99 and below, which `Date.UTC` maps to 1900. */
export function utc(year: number, month = 1, day = 1, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  // Year, month and day together, so a month or day past the end rolls over in
  // the right year — and a 29 February in a non-leap year into March, as the
  // calendar does.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** How fine a partial time goes: the last field in the run from the year that is known. */
export function precisionOf(time: PartialTime): TimePrecision | null {
  if (time.year === undefined) return null;
  if (time.month === undefined) return 'year';
  if (time.day === undefined) return 'month';
  if (time.hour === undefined) return 'day';
  if (time.minute === undefined) return 'hour';
  if (time.second === undefined) return 'minute';
  return 'second';
}

/**
 * The stretch of time a partial time stands for: from its first possible
 * instant, up to (not including) the first instant after it.
 *
 * "2004" is the whole year; "March 2004" the month; "15 March 2004 14:30" that
 * minute. A field known below a missing one — a day with no month — says
 * nothing that can be placed, so reading stops at the first gap. `null` for a
 * time with no year, which is undated.
 */
export function timeRange(time: PartialTime | undefined): { from: number; to: number } | null {
  if (!time) return null;
  const precision = precisionOf(time);
  if (!precision) return null;
  const year = time.year!;
  switch (precision) {
    case 'year':
      return { from: utc(year), to: utc(year + 1) };
    case 'month':
      return { from: utc(year, time.month), to: utc(year, time.month! + 1) };
    default: {
      const from = utc(year, time.month, time.day, time.hour ?? 0, time.minute ?? 0, time.second ?? 0);
      return { from, to: from + UNIT_MS[precision] };
    }
  }
}

/** The partial time a UTC instant is, kept to a precision. */
export function partialFromMs(ms: number, precision: TimePrecision = 'second'): PartialTime {
  const date = new Date(ms);
  const out: PartialTime = { year: date.getUTCFullYear() };
  const order = TIME_PRECISIONS.indexOf(precision);
  if (order >= 1) out.month = date.getUTCMonth() + 1;
  if (order >= 2) out.day = date.getUTCDate();
  if (order >= 3) out.hour = date.getUTCHours();
  if (order >= 4) out.minute = date.getUTCMinutes();
  if (order >= 5) out.second = date.getUTCSeconds();
  return out;
}

/** A partial time as a person would write it: `15 Mar 2004, 14:30`, `Mar 2004`, `c. 1999`, `500 BC`. */
export function formatPartialTime(time: PartialTime | undefined): string {
  if (!time || time.year === undefined) return 'Undated';
  const precision = precisionOf(time)!;
  const year = time.year <= 0 ? `${1 - time.year} BC` : String(time.year);
  const parts: string[] = [];
  if (precision !== 'year') {
    const month = MONTH_SHORT[(time.month! - 1 + 12) % 12]!;
    parts.push(precision === 'month' ? `${month} ${year}` : `${time.day} ${month} ${year}`);
  } else parts.push(year);
  if (time.hour !== undefined && precision !== 'day' && precision !== 'month') {
    const pad = (value: number) => String(value).padStart(2, '0');
    let clock = `${pad(time.hour)}:${pad(time.minute ?? 0)}`;
    if (precision === 'second') clock += `:${pad(time.second ?? 0)}`;
    if (precision === 'hour') clock = `${pad(time.hour)}h`;
    parts[0] = `${parts[0]}, ${clock}`;
  }
  return `${time.circa ? 'c. ' : ''}${parts[0]}`;
}

/**
 * Read a time someone typed.
 *
 * Takes what people write: `2004`, `2004-03`, `2004-03-15`, `2004-03-15 14:30`,
 * ISO with a `T` and a `Z`, `March 2004`, `15 March 2004`, `March 15, 2004`,
 * `500 BC`, and `c.` / `circa` / `about` / `~` / a trailing `?` for a guess.
 * `null` for anything else, rather than a wrong date: an event quietly filed in
 * the wrong century is worse than one left undated.
 */
export function parsePartialTime(text: string): PartialTime | null {
  let rest = text.trim().toLowerCase();
  if (!rest) return null;
  let circa = false;
  const guess = /^(c\.|ca\.|circa|about|around|approx\.?|~)\s*/;
  if (guess.test(rest)) {
    circa = true;
    rest = rest.replace(guess, '');
  }
  if (rest.endsWith('?')) {
    circa = true;
    rest = rest.slice(0, -1).trim();
  }
  const done = (time: PartialTime): PartialTime | null => {
    if (time.month !== undefined && (time.month < 1 || time.month > 12)) return null;
    if (time.day !== undefined && (time.day < 1 || time.day > 31)) return null;
    if (time.hour !== undefined && (time.hour < 0 || time.hour > 23)) return null;
    if (time.minute !== undefined && (time.minute < 0 || time.minute > 59)) return null;
    if (time.second !== undefined && (time.second < 0 || time.second > 59)) return null;
    return circa ? { ...time, circa: true } : time;
  };

  // 500 BC, 44 bce, 1066 ad
  const era = rest.match(/^(\d{1,6})\s*(bc|bce|ad|ce)$/);
  if (era) return done({ year: era[2]!.startsWith('b') ? 1 - Number(era[1]) : Number(era[1]) });

  // ISO-like: 2004, 2004-03, 2004-03-15, 2004-03-15 14:30[:05], with T and Z allowed
  const iso = rest.match(/^(-?\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2})(?:[t\s]+(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.\d+)?)?)?h?)?)?)?z?$/);
  if (iso) {
    const [, year, month, day, hour, minute, second] = iso;
    const time: PartialTime = { year: Number(year) };
    if (month) time.month = Number(month);
    if (day) time.day = Number(day);
    if (hour) time.hour = Number(hour);
    if (minute) time.minute = Number(minute);
    if (second) time.second = Number(second);
    return done(time);
  }

  // Month names: "march 2004", "15 march 2004", "march 15, 2004", "mar 2004", with an optional time after
  const month = (word: string) => MONTHS.findIndex((name) => name.startsWith(word) && word.length >= 3) + 1;
  const named = rest.match(/^(?:(\d{1,2})\s+)?([a-z]+)\.?\s+(?:(\d{1,2}),?\s+)?(-?\d{1,6})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (named) {
    const [, dayBefore, name, dayAfter, year, hour, minute, second] = named;
    const index = month(name!);
    if (index === 0) return null;
    const time: PartialTime = { year: Number(year), month: index };
    const day = dayBefore ?? dayAfter;
    if (day) time.day = Number(day);
    if (day && hour) {
      time.hour = Number(hour);
      time.minute = Number(minute);
      if (second) time.second = Number(second);
    }
    return done(time);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Places, exact and partial
 * ------------------------------------------------------------------ */

export interface EventPlace {
  /** Broad to narrow: `["Europe", "France", "Paris"]`. Shorter is vaguer. */
  path: string[];
  /** The narrowest part is itself a guess: "near Paris". */
  approximate?: boolean;
  /** A location on a wired-in world map, by id, when it is one. */
  locationId?: string;
  note?: string;
}

export function formatPlace(place: EventPlace): string {
  const path = place.path.filter(Boolean);
  if (path.length === 0) return 'Somewhere';
  return `${place.approximate ? 'near ' : ''}${path.join(' / ')}`;
}

/** `Europe / France / Paris`, or `Europe > France`, or commas — as a path. */
export function parsePlacePath(text: string): string[] {
  return text
    .split(/\s*[/>›]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface DialogLine {
  character: string;
  line: string;
  /** How it is said, or what happens while it is. */
  direction?: string;
}

export interface TimelineEvent {
  id: string;
  title: string;
  /** What happened. */
  details: string;
  /** When it starts — or when it happens, for a moment rather than a stretch. */
  start: PartialTime;
  /** When it ends, for an event that lasts. Absent is a moment. */
  end?: PartialTime;
  /** Anything about the time that the fields cannot say: "the night of the storm". */
  timeNote?: string;
  places: EventPlace[];
  characters: string[];
  tags: string[];
  dialog: DialogLine[];
  /** A color of its own, over whatever the color setting would give it. */
  color?: string;
}

export function newEvent(id: string, start: PartialTime, title = 'New event'): TimelineEvent {
  return { id, title, details: '', start, places: [], characters: [], tags: [], dialog: [] };
}

/**
 * Where an event sits on the line.
 *
 * `from` to `to` is everything it could cover: the earliest its start could be
 * to the latest its end could be. `sure` is the part it certainly covers — from
 * the latest its start could be to the earliest its end could be — which a
 * timespan with vague ends has and a vague moment does not. `null` when undated.
 */
export function eventRange(
  event: Pick<TimelineEvent, 'start' | 'end'>,
): { from: number; to: number; sure: { from: number; to: number } | null } | null {
  const start = timeRange(event.start);
  if (!start) return null;
  const end = event.end ? timeRange(event.end) : null;
  if (!end) return { from: start.from, to: start.to, sure: null };
  const from = Math.min(start.from, end.from);
  const to = Math.max(start.to, end.to);
  const sure = start.to < end.from ? { from: start.to, to: end.from } : null;
  return { from, to, sure };
}

/**
 * How long an event lasts, in milliseconds: from its start to its end, each read
 * at its earliest. `null` for a moment, or an end before its start.
 */
export function durationOf(event: Pick<TimelineEvent, 'start' | 'end'>): number | null {
  const start = timeRange(event.start);
  const end = event.end ? timeRange(event.end) : null;
  if (!start || !end) return null;
  const length = end.from - start.from;
  return length >= 0 ? length : null;
}

/**
 * Give an event a duration: its end moves to its start plus that long.
 *
 * Kept to the precision the duration needs — two hours after a day that is only
 * known to the day is still only known to the day's end, so the end is written
 * as precisely as the finer of the two.
 */
export function withDuration(event: TimelineEvent, ms: number): TimelineEvent {
  const start = timeRange(event.start);
  if (!start || !(ms >= 0)) return event;
  const needs: TimePrecision =
    ms % UNIT_MS.minute !== 0 ? 'second' : ms % UNIT_MS.hour !== 0 ? 'minute' : ms % UNIT_MS.day !== 0 ? 'hour' : 'day';
  const finer = TIME_PRECISIONS[Math.max(TIME_PRECISIONS.indexOf(needs), TIME_PRECISIONS.indexOf(precisionOf(event.start)!))]!;
  return { ...event, end: partialFromMs(start.from + ms, finer) };
}

export type DurationUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute';

export const DURATION_UNITS: readonly DurationUnit[] = ['year', 'month', 'week', 'day', 'hour', 'minute'];

/**
 * A time moved on by a count of calendar units, kept at least as precise as it
 * was and as precise as the unit needs: a year after March 2004 is March 2005;
 * three days after March 2004 is 4 March 2004, a day being the finest thing the
 * move says anything about. Months are calendar months, so a month after 31
 * January rolls into March as the calendar does.
 */
export function shiftTime(time: PartialTime, amount: number, unit: DurationUnit): PartialTime | null {
  const range = timeRange(time);
  if (!range) return null;
  const own = precisionOf(time)!;
  const needs: TimePrecision = unit === 'week' ? 'day' : unit;
  const precision = TIME_PRECISIONS[Math.max(TIME_PRECISIONS.indexOf(own), TIME_PRECISIONS.indexOf(needs))]!;
  const date = new Date(range.from);
  const whole = Math.round(amount);
  switch (unit) {
    case 'year':
      return partialFromMs(utc(date.getUTCFullYear() + whole, date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()), precision);
    case 'month':
      return partialFromMs(utc(date.getUTCFullYear(), date.getUTCMonth() + 1 + whole, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()), precision);
    case 'week':
      return partialFromMs(range.from + amount * 7 * UNIT_MS.day, precision);
    default:
      return partialFromMs(range.from + amount * UNIT_MS[unit], precision);
  }
}

/** A duration as words:/** A duration as words: `3 days 4 h`, `45 min`, `2 years 1 month` (a year is 365.25 days, a month a twelfth of that). */
export function formatEventDuration(ms: number): string {
  if (ms <= 0) return 'no time';
  const year = 365.25 * UNIT_MS.day;
  const month = year / 12;
  const units: Array<[number, string, string]> = [
    [year, 'year', 'years'],
    [month, 'month', 'months'],
    [UNIT_MS.day, 'day', 'days'],
    [UNIT_MS.hour, 'h', 'h'],
    [UNIT_MS.minute, 'min', 'min'],
    [UNIT_MS.second, 's', 's'],
  ];
  const out: string[] = [];
  let rest = ms;
  for (const [size, one, many] of units) {
    const count = Math.floor(rest / size + 1e-9);
    if (count > 0) {
      out.push(`${count} ${count === 1 ? one : many}`);
      rest -= count * size;
    }
    if (out.length === 2) break;
  }
  return out.length > 0 ? out.join(' ') : 'under a second';
}

/** Events in time order, undated last; ties by title. */
export function sortEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((one, two) => {
    const a = eventRange(one);
    const b = eventRange(two);
    if (a && b && a.from !== b.from) return a.from - b.from;
    if (a && !b) return -1;
    if (b && !a) return 1;
    return one.title.localeCompare(two.title);
  });
}

/* ------------------------------------------------------------------ *
 * Finding events, and coloring them
 * ------------------------------------------------------------------ */

export interface TimelineFilter {
  /** Words that must all appear somewhere in the event: title, details, notes, tags, dialog. */
  text: string;
  /** Any of these characters. Empty is no filter. */
  characters: string[];
  /** Any of these places — matching any part of a place's path. */
  places: string[];
  tags: string[];
}

export const EMPTY_FILTER: TimelineFilter = { text: '', characters: [], places: [], tags: [] };

const lower = (value: string) => value.toLowerCase();

/** Every word of an event, for searching. */
function searchable(event: TimelineEvent): string {
  return lower(
    [
      event.title,
      event.details,
      event.timeNote ?? '',
      ...event.tags,
      ...event.characters,
      ...event.places.flatMap((place) => [...place.path, place.note ?? '']),
      ...event.dialog.flatMap((line) => [line.character, line.line, line.direction ?? '']),
    ].join('\n'),
  );
}

export function matchesFilter(event: TimelineEvent, filter: TimelineFilter): boolean {
  const words = lower(filter.text).split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const body = searchable(event);
    if (!words.every((word) => body.includes(word))) return false;
  }
  if (filter.characters.length > 0) {
    const wanted = new Set(filter.characters.map(lower));
    if (!event.characters.some((name) => wanted.has(lower(name)))) return false;
  }
  if (filter.places.length > 0) {
    const wanted = new Set(filter.places.map(lower));
    if (!event.places.some((place) => place.path.some((part) => wanted.has(lower(part))))) return false;
  }
  if (filter.tags.length > 0) {
    const wanted = new Set(filter.tags.map(lower));
    if (!event.tags.some((tag) => wanted.has(lower(tag)))) return false;
  }
  return true;
}

export function isFiltering(filter: TimelineFilter): boolean {
  return Boolean(filter.text.trim()) || filter.characters.length > 0 || filter.places.length > 0 || filter.tags.length > 0;
}

/**
 * What an event is colored by.
 *
 * - `character` — its first character, so each person's thread reads as one color.
 * - `place` — its first place, at the level of the path chosen by `placeLevel`:
 *   level 1 colors by continent or country, a deeper level by city.
 * - `tag` — its first tag.
 * - `keyword` — the first keyword rule whose word it contains.
 * - `none` — one color for everything; an event's own color still wins.
 */
export type ColorBy = 'none' | 'character' | 'place' | 'tag' | 'keyword';

export const COLOR_BY: readonly ColorBy[] = ['none', 'character', 'place', 'tag', 'keyword'];

export const COLOR_BY_LABEL: Record<ColorBy, string> = {
  none: 'One color',
  character: 'By character',
  place: 'By place',
  tag: 'By tag',
  keyword: 'By keyword',
};

export interface KeywordColor {
  word: string;
  color: string;
}

export interface ColorSetting {
  by: ColorBy;
  /** For `place`: how far down the path to read, 1 being the broadest part. */
  placeLevel: number;
  /** For `keyword`: first match wins. */
  keywords: KeywordColor[];
  /** Colors chosen for particular values, by `by:value` — over the generated ones. */
  chosen: Record<string, string>;
}

export const DEFAULT_COLOR_SETTING: ColorSetting = { by: 'character', placeLevel: 1, keywords: [], chosen: {} };

/** The value an event is colored by under a setting, or `null` when it has none. */
export function colorKeyOf(event: TimelineEvent, setting: ColorSetting): string | null {
  switch (setting.by) {
    case 'character':
      return event.characters[0] ?? null;
    case 'tag':
      return event.tags[0] ?? null;
    case 'place': {
      const path = event.places[0]?.path ?? [];
      if (path.length === 0) return null;
      return path[Math.min(path.length, Math.max(1, setting.placeLevel)) - 1] ?? null;
    }
    case 'keyword': {
      const body = searchable(event);
      return setting.keywords.find((rule) => rule.word.trim() && body.includes(lower(rule.word.trim())))?.word ?? null;
    }
    default:
      return null;
  }
}

/** One hue per name, the same name always the same hue: a hash round the color wheel. */
export function hashedColor(name: string): string {
  let hash = 2166136261;
  for (const char of lower(name)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // Golden-angle steps spread neighbouring hashes apart.
  const hue = Math.round((hash * 137.508) % 360);
  return hslToHex(hue, 62, 58);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The color nothing in particular gets. */
export const PLAIN_COLOR = '#8a93a6';

/** An event's color: its own, else the one chosen for its value, else its value's hashed color. */
export function eventColor(event: TimelineEvent, setting: ColorSetting): string {
  if (event.color) return event.color;
  const key = colorKeyOf(event, setting);
  if (key === null) return PLAIN_COLOR;
  if (setting.by === 'keyword') {
    return setting.keywords.find((rule) => rule.word === key)?.color ?? PLAIN_COLOR;
  }
  return setting.chosen[`${setting.by}:${lower(key)}`] ?? hashedColor(key);
}

/** The values in play under a setting, most used first, with their colors — the legend. */
export function colorLegend(
  events: readonly TimelineEvent[],
  setting: ColorSetting,
): Array<{ key: string; color: string; count: number }> {
  if (setting.by === 'none') return [];
  if (setting.by === 'keyword') {
    return setting.keywords.map((rule) => ({
      key: rule.word,
      color: rule.color,
      count: events.filter((event) => colorKeyOf(event, setting) === rule.word).length,
    }));
  }
  const counts = new Map<string, { key: string; count: number }>();
  for (const event of events) {
    const key = colorKeyOf(event, setting);
    if (key === null) continue;
    const known = counts.get(lower(key));
    if (known) known.count += 1;
    else counts.set(lower(key), { key, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map(({ key, count }) => ({
      key,
      count,
      color: setting.chosen[`${setting.by}:${lower(key)}`] ?? hashedColor(key),
    }));
}

/** Everyone named anywhere on the timeline, plus any names handed in, once each. */
export function charactersIn(events: readonly TimelineEvent[], extra: readonly string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const name of [...extra, ...events.flatMap((event) => [...event.characters, ...event.dialog.map((line) => line.character)])]) {
    const clean = name.trim();
    if (clean && !seen.has(lower(clean))) seen.set(lower(clean), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Every place name at every level of every path, once each. */
export function placesIn(events: readonly TimelineEvent[], extra: readonly string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const name of [...extra, ...events.flatMap((event) => event.places.flatMap((place) => place.path))]) {
    const clean = name.trim();
    if (clean && !seen.has(lower(clean))) seen.set(lower(clean), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function tagsIn(events: readonly TimelineEvent[]): string[] {
  const seen = new Map<string, string>();
  for (const tag of events.flatMap((event) => event.tags)) {
    const clean = tag.trim();
    if (clean && !seen.has(lower(clean))) seen.set(lower(clean), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ *
 * The span, and the part of it in view
 * ------------------------------------------------------------------ */

export interface TimelineSpan {
  /** ISO, UTC. */
  start: string;
  /** ISO, UTC — or `null` for today, whenever today is. */
  end: string | null;
}

export const DEFAULT_SPAN: TimelineSpan = { start: '2000-01-01T00:00:00.000Z', end: null };

/** The span as milliseconds. An end of `null` is the end of today; an end before the start is swapped. */
export function spanRange(span: TimelineSpan, now: number = Date.now()): { from: number; to: number } {
  const start = Date.parse(span.start);
  const today = new Date(now);
  const endOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  const end = span.end === null ? endOfToday : Date.parse(span.end);
  const from = Number.isFinite(start) ? start : Date.parse(DEFAULT_SPAN.start);
  const to = Number.isFinite(end) ? end : endOfToday;
  return from <= to ? { from, to: Math.max(to, from + 1000) } : { from: to, to: from };
}

export interface TimelineView {
  from: number;
  to: number;
}

/** The closest a view may zoom: a minute across the whole width. */
export const NARROWEST_VIEW = 60_000;

/** A view kept inside the span and no narrower than a minute. */
export function clampView(view: TimelineView, span: { from: number; to: number }): TimelineView {
  const full = span.to - span.from;
  const width = Math.min(full, Math.max(NARROWEST_VIEW, view.to - view.from));
  let from = Math.max(span.from, Math.min(view.from, span.to - width));
  if (!Number.isFinite(from)) from = span.from;
  return { from, to: from + width };
}

/** Zoom by a factor (below 1 is in) about a moment, which stays where it is on screen. */
export function zoomView(view: TimelineView, factor: number, about: number, span: { from: number; to: number }): TimelineView {
  const share = (about - view.from) / Math.max(1, view.to - view.from);
  const width = (view.to - view.from) * factor;
  const from = about - share * width;
  return clampView({ from, to: from + width }, span);
}

export function panView(view: TimelineView, by: number, span: { from: number; to: number }): TimelineView {
  return clampView({ from: view.from + by, to: view.to + by }, span);
}

/* ------------------------------------------------------------------ *
 * The axis
 * ------------------------------------------------------------------ */

export interface Tick {
  at: number;
  label: string;
  /** A tick at a boundary of the next unit up — the first of a month, midnight — drawn heavier. */
  major: boolean;
}

type Step = { unit: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'; count: number; size: number };

const STEPS: Step[] = [
  ...[1, 5, 15, 30].map((count) => ({ unit: 'second' as const, count, size: count * UNIT_MS.second })),
  ...[1, 5, 15, 30].map((count) => ({ unit: 'minute' as const, count, size: count * UNIT_MS.minute })),
  ...[1, 3, 6, 12].map((count) => ({ unit: 'hour' as const, count, size: count * UNIT_MS.hour })),
  ...[1, 2, 7, 14].map((count) => ({ unit: 'day' as const, count, size: count * UNIT_MS.day })),
  ...[1, 3, 6].map((count) => ({ unit: 'month' as const, count, size: count * 30.44 * UNIT_MS.day })),
  ...[1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000].map((count) => ({
    unit: 'year' as const,
    count,
    size: count * 365.25 * UNIT_MS.day,
  })),
];

/**
 * Ticks for a stretch of time across a width, at least `spacing` pixels apart.
 *
 * On calendar boundaries rather than at even millisecond steps: a tick every
 * month lands on the first of each month, not every 30.44 days, and a tick every
 * week on a Monday. The unit follows the zoom from millennia down to seconds.
 */
export function ticksFor(from: number, to: number, width: number, spacing = 90): Tick[] {
  const span = Math.max(1, to - from);
  const wanted = (span / Math.max(1, width)) * spacing;
  const step = STEPS.find((candidate) => candidate.size >= wanted) ?? STEPS[STEPS.length - 1]!;
  const out: Tick[] = [];
  const first = new Date(from);
  let at: number;
  const pad = (value: number) => String(value).padStart(2, '0');
  const yearLabel = (year: number) => (year <= 0 ? `${1 - year} BC` : String(year));

  if (step.unit === 'year') {
    const year = Math.ceil(first.getUTCFullYear() / step.count) * step.count;
    for (let y = year; (at = utc(y)) <= to && out.length < 400; y += step.count) {
      if (at >= from) out.push({ at, label: yearLabel(y), major: y % (step.count * 10) === 0 });
    }
    return out;
  }
  if (step.unit === 'month') {
    let year = first.getUTCFullYear();
    let month = first.getUTCMonth();
    month = Math.ceil(month / step.count) * step.count;
    for (let guard = 0; guard < 400; guard += 1) {
      at = utc(year + Math.floor(month / 12), (month % 12) + 1);
      if (at > to) break;
      if (at >= from) {
        const m = month % 12;
        out.push({ at, label: m === 0 ? yearLabel(year + Math.floor(month / 12)) : MONTH_SHORT[m]!, major: m === 0 });
      }
      month += step.count;
    }
    return out;
  }

  const size = step.size;
  // Days line up on midnight and weeks on Mondays; smaller units on their own boundaries.
  let start: number;
  if (step.unit === 'day' && step.count >= 7) {
    const midnight = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
    const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
    start = midnight - weekday * UNIT_MS.day;
  } else start = Math.floor(from / size) * size;
  for (at = start; at <= to && out.length < 400; at += size) {
    if (at < from) continue;
    const date = new Date(at);
    let label: string;
    let major = false;
    if (step.unit === 'day') {
      label = date.getUTCDate() === 1 ? `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}` : `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
      major = date.getUTCDate() === 1;
    } else if (step.unit === 'hour') {
      const midnight = date.getUTCHours() === 0;
      label = midnight ? `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}` : `${pad(date.getUTCHours())}:00`;
      major = midnight;
    } else if (step.unit === 'minute') {
      label = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
      major = date.getUTCMinutes() === 0;
    } else {
      label = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
      major = date.getUTCSeconds() === 0;
    }
    out.push({ at, label, major });
  }
  return out;
}

/**
 * Lanes, so events never draw over each other.
 *
 * Each item goes in the first lane whose last item ends — label included — by
 * the time this one starts, in pixels: two events a day apart share a lane when
 * zoomed out to centuries and not when zoomed in to the day. Greedy, in start
 * order, which is what keeps a lane reading left to right in time.
 */
export function layoutLanes(items: ReadonlyArray<{ id: string; x0: number; x1: number }>, gap = 6): Map<string, number> {
  const lanes: number[] = [];
  const out = new Map<string, number>();
  for (const item of [...items].sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1)) {
    let lane = lanes.findIndex((end) => end + gap <= item.x0);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(item.x1);
    } else lanes[lane] = item.x1;
    out.set(item.id, lane);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

export interface TimelineFlowData {
  editor: 'timeline';
  span: TimelineSpan;
  events: TimelineEvent[];
  /** The part of the span on screen. Absent is all of it. */
  view?: TimelineView;
  filter: TimelineFilter;
  color: ColorSetting;
  /** The event open in the details panel. */
  selected?: string;
  /** Monotonic counter for event ids. */
  seq: number;
}

export function emptyTimelineFlowData(): TimelineFlowData {
  return {
    editor: 'timeline',
    span: { ...DEFAULT_SPAN },
    events: [],
    filter: { ...EMPTY_FILTER },
    color: { ...DEFAULT_COLOR_SETTING, keywords: [], chosen: {} },
    seq: 0,
  };
}

/** The next event id, and the data with the counter moved on. */
export function takeEventId(data: TimelineFlowData): { id: string; data: TimelineFlowData } {
  const seq = (data.seq ?? 0) + 1;
  return { id: `evt_${seq}`, data: { ...data, seq } };
}

export function addEvent(data: TimelineFlowData, start: PartialTime, title?: string): TimelineFlowData {
  const taken = takeEventId(data);
  const event = newEvent(taken.id, start, title);
  return { ...taken.data, events: [...taken.data.events, event], selected: event.id };
}

export function updateEvent(data: TimelineFlowData, id: string, change: Partial<TimelineEvent>): TimelineFlowData {
  return { ...data, events: data.events.map((event) => (event.id === id ? { ...event, ...change, id } : event)) };
}

export function deleteEvent(data: TimelineFlowData, id: string): TimelineFlowData {
  return {
    ...data,
    events: data.events.filter((event) => event.id !== id),
    ...(data.selected === id ? { selected: undefined } : {}),
  };
}

/**
 * Events from the brief this flow used to be: one per line of `when — what`.
 *
 * The `when` is read as a time where it can be and kept as a note where it
 * cannot — "the night of the flood" is still worth having on the event, undated.
 */
export function eventsFromBrief(fields: Record<string, string>): TimelineEvent[] {
  const lines = [
    ...(fields.events ?? '').split('\n').map((line) => ({ line, tag: '' })),
    ...(fields.offscreen ?? '').split('\n').map((line) => ({ line, tag: 'off-screen' })),
  ].filter(({ line }) => line.trim());
  return lines.map(({ line, tag }, index) => {
    const [when, ...what] = line.split(/\s+[—–-]\s+/);
    const text = what.length > 0 ? what.join(' — ').trim() : line.trim();
    const time = what.length > 0 ? parsePartialTime(when!) : null;
    const event = newEvent(`evt_${index + 1}`, time ?? {}, text.slice(0, 80) || 'Event');
    return {
      ...event,
      details: text,
      ...(what.length > 0 && !time ? { timeNote: when!.trim() } : {}),
      tags: tag ? [tag] : [],
    };
  });
}

/* ------------------------------------------------------------------ *
 * What is wired in
 * ------------------------------------------------------------------ */

/**
 * Character names out of whatever a character flow wrote.
 *
 * A profile is markdown: a `## Name` section (what the character brief writes),
 * a `Name:` line, or failing both the top heading. JSON is a list of names or of objects with a `name`. Offered as
 * suggestions, so a stray heading does no harm — it is never added to an event
 * unless someone picks it.
 */
export function namesFromCharacters(body: string): string[] {
  const out = new Set<string>();
  const text = body.trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const json = JSON.parse(text) as unknown;
      const list = Array.isArray(json) ? json : ((json as Record<string, unknown>).characters as unknown[]) ?? [];
      for (const entry of Array.isArray(list) ? list : []) {
        if (typeof entry === 'string') out.add(entry.trim());
        else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
          out.add((entry as { name: string }).name.trim());
        }
      }
      return [...out].filter(Boolean);
    } catch {
      // Not JSON after all; read it as text.
    }
  }
  // What the character brief writes: a `## Name` section with the name under it.
  const section = text.match(/^#{1,6}\s*name\s*\n+\s*([^\n#][^\n]*)/im);
  if (section) out.add(section[1]!.trim());
  for (const line of text.split('\n')) {
    const named = line.match(/^\s*(?:[-*]\s*)?\*{0,2}name\*{0,2}\s*:\s*\*{0,2}(.+?)\*{0,2}\s*$/i);
    if (named) out.add(named[1]!.trim());
  }
  if (out.size === 0) {
    const heading = text.match(/^#\s+(.+)$/m);
    if (heading) out.add(heading[1]!.replace(/\s+[—–-]\s+.*$/, '').trim());
  }
  return [...out].filter(Boolean);
}

export interface MapPlace {
  id: string;
  name: string;
  /** Broad to narrow, the place itself last. */
  path: string[];
  kind?: string;
}

/** Named locations out of what a world map flow wrote (`locations.json`), leniently. */
export function placesFromMap(json: unknown): MapPlace[] {
  const list = Array.isArray(json) ? json : ((json as Record<string, unknown> | null)?.locations as unknown[]) ?? [];
  const out: MapPlace[] = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const path = Array.isArray(record.path) ? record.path.filter((part): part is string => typeof part === 'string' && part.trim() !== '') : [];
    out.push({
      id: typeof record.id === 'string' ? record.id : name,
      name,
      path: path.length > 0 && path[path.length - 1] === name ? path : [...path, name],
      ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Writing it out
 * ------------------------------------------------------------------ */

export interface ExportedEvent {
  id: string;
  title: string;
  details: string;
  start: PartialTime;
  end?: PartialTime;
  /** The stretch the event could cover, ISO UTC; absent when undated. */
  from?: string;
  to?: string;
  precision: TimePrecision | null;
  when: string;
  duration?: string;
  timeNote?: string;
  places: Array<EventPlace & { label: string }>;
  characters: string[];
  tags: string[];
  dialog: DialogLine[];
  color: string;
}

/** The events as data for whatever reads the timeline next, in time order. */
export function exportEvents(data: TimelineFlowData): ExportedEvent[] {
  return sortEvents(data.events).map((event) => {
    const range = eventRange(event);
    const duration = durationOf(event);
    return {
      id: event.id,
      title: event.title,
      details: event.details,
      start: event.start,
      ...(event.end ? { end: event.end } : {}),
      ...(range ? { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() } : {}),
      precision: precisionOf(event.start),
      when: event.end ? `${formatPartialTime(event.start)} – ${formatPartialTime(event.end)}` : formatPartialTime(event.start),
      ...(duration !== null ? { duration: formatEventDuration(duration) } : {}),
      ...(event.timeNote ? { timeNote: event.timeNote } : {}),
      places: event.places.map((place) => ({ ...place, label: formatPlace(place) })),
      characters: event.characters,
      tags: event.tags,
      dialog: event.dialog,
      color: eventColor(event, data.color),
    };
  });
}

export function summariseTimeline(data: TimelineFlowData): string {
  const dated = data.events.filter((event) => timeRange(event.start)).length;
  const undated = data.events.length - dated;
  const people = charactersIn(data.events).length;
  return [
    `${data.events.length} event(s)`,
    ...(undated > 0 ? [`${undated} undated`] : []),
    `${people} character(s)`,
    `${placesIn(data.events).length} place name(s)`,
  ].join(' · ');
}
