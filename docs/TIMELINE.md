# Timeline

`story.timeline` · takes **Characters** and **Places** (optional) · gives **`timeline.json`** and **`timeline.md`**

Events on a line through time. Each has a time — a moment or a stretch — and a
place or places, and either can be known exactly or only in part. Each also has
details, the characters in it, tags, and the dialog spoken in it.

## Partial times

A time is stored as the fields that are known: year, month, day, hour, minute,
second. A missing field is unknown, and the time stands for **all of the time it
could be**: "2004" is the whole year, "March 2004" the whole month.

| Typed | Means | Drawn as |
| --- | --- | --- |
| `2004` | Some time in 2004 | A faded bar a year long |
| `March 2004`, `2004-03` | Some time that month | A faded bar a month long |
| `15 Mar 2004 14:30` | That minute | A diamond |
| `c. 1999`, `1999?` | About then — the year is a guess | Dashed |
| `500 BC` | 500 BC (year −499, astronomers' counting) | |

An event that **lasts** has an end as well. With vague ends it has a solid middle —
when it was certainly happening — and faded edges: "1939 to 1945" is certainly on
from the end of 1939 to the start of 1945, and possibly for a year either side. A
length can be given instead of an end ("3 months"); months and years are calendar
ones.

Anything the fields cannot say — "the night of the storm" — goes in the time note.
An event with no year is **undated**: kept, listed under the line, written out
last.

Everything is **UTC**, so the line never shifts when opened in another time zone.

## Partial places

A place is a path from broad to narrow: `Europe / France / Paris / Rue de Rivoli`.
Stop where knowledge runs out — `Europe / France` is somewhere in France — and tick
**Near** when the narrowest part is a guess. An event can have several places.

With a world map flow wired into **Places**, its named locations are offered, and
picking one links the event to it and takes its path.

## The line

- **The span** runs from 1 January 2000 to today by default — and "today" moves
  on by itself. Both ends can be set, to the minute, in UTC.
- **Zoom** with the wheel, about the pointer, from the whole span down to a minute
  across the screen. **Drag** to move along it. The axis follows the zoom from
  centuries to seconds, always on calendar boundaries.
- **The overview** above the line is the whole span, small, with the part in view
  marked. Drag the marked part to move, drag its edges to widen or narrow it,
  click elsewhere to jump there. Every event is a tick in its color.
- Events sit in **lanes** so they never overlap, packed by how much room they
  take at the current zoom.
- **Double-click** an empty stretch to add an event there, as precise as the zoom:
  a year when looking at decades, a day when looking at a month.

## Finding and coloring

Filters narrow what is drawn: **words** (all of them must appear, anywhere in the
event including its dialog), **characters**, **places** (any level of a path) and
**tags**. Filtering never changes what is written out.

**Color events** by character, place (at a chosen level of the path), tag, or
keyword (a list of words and colors; the first one an event contains wins) — or
one color for everything. The legend lists the values in play, most used first;
click a swatch to change it. An event can also have a color of its own.

## What comes out

`timeline.json` holds the span and every event in time order, undated last: the
fields as entered, plus the resolved stretch (`from`, `to` as ISO UTC), the
precision, a readable `when`, the duration, place labels, and the color it is
drawn in. `timeline.md` is the same as a chronology, dialog included.

A timeline saved as the old text brief opens with each `when — what` line as an
event; a `when` that cannot be read as a time is kept as the event's time note.
