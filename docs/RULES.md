# Connection rules

Every connection carries a block of plain text. Most of it is meant to be read by
a person (or, later, by a model): *keep the reaction on the same panel as the
joke*. Some of it is interpreted directly, which is what lets a connection do
something on its own.

The format is one rule per line:

```
# how to break this scene down
panel per: beat
merge: consecutive action beats
shot for line: MCU
shot for action: WS
carry: sound -> notes
min duration: 1.2
keep: the pause before the last line
```

- A line of the form `key: value` whose key is in the table below is
  **interpreted**.
- Any other line — including a `key: value` line whose key is not known — is kept
  verbatim as **guidance**. Nothing you write is ever silently dropped; unknown
  keys are flagged in the editor rather than discarded.
- `#` starts a comment at the start of a line, or mid-line when followed by a
  space. `palette: #ff8800` keeps its colour.
- Keys are case- and space-insensitive (`Shot   For   Line` = `shot for line`),
  and the last line wins if a key is repeated — except `carry` and `ignore`,
  which accumulate.

## Interpreted directives

| Directive         | Example                     | Applies to        | Effect |
| ----------------- | --------------------------- | ----------------- | ------ |
| `panel per`       | `beat`                      | storyboard        | Granularity: `beat` (default), `line`, `action` or `scene`. Non-anchor beats fold into the panel they belong with. |
| `merge`           | `consecutive action beats`  | storyboard        | Collapse runs of action into one panel. `none` disables it. |
| `shot default`    | `MS`                        | storyboard        | Shot size when nothing more specific matches. |
| `shot for line`   | `MCU`                       | storyboard        | Shot size for dialog beats. |
| `shot for action` | `WS`                        | storyboard        | Shot size for action beats. |
| `shot for sound`  | `INSERT`                    | storyboard        | Shot size for panels made from a sound cue. |
| `carry`           | `sound -> notes`            | any               | Copy a source field into a destination field. Repeatable; `a, b` carries fields as-is. Destinations: `notes`, `sound`, `action`, `camera`, `dialog`. |
| `ignore`          | `direction, parenthetical`  | any               | Drop a beat type or field: `line`, `action`, `sound`, `direction`, `parenthetical`, `camera`. |
| `min duration`    | `1.2`                       | storyboard, animatic | Floor for a derived panel duration, in seconds. |
| `max duration`    | `6`                         | storyboard, animatic | Ceiling for a derived panel duration. |
| `words per second`| `2.6`                       | storyboard, animatic | Speaking rate used to time a line with no explicit duration. |
| `scenes`          | `1-3` / `2,4` / `all`       | any               | Restrict to a range or list of scene numbers. |
| `weight`          | `0.7`                       | any               | How hard this input should push the result, 0 to 1. |
| `keep`            | `names, props`              | any               | Guidance, passed through verbatim. |
| `never`           | `invent new characters`     | any               | Guidance, passed through verbatim. |
| `always`          | `end a scene on an image`   | any               | Guidance, passed through verbatim. |

The connection inspector lists the directives the *target* flow understands and
inserts them for you, and shows how your text parsed as you type.

## Worked example

This dialog:

```
ACTION  Mabz drags the lamp round.
ACTION  The machine sits there.            (sound: one small clack)
MABZ    It did it yesterday. Twice.
TULLY   (not moving) I am going to watch.
CAMERA  Push in on the gear.
```

with `panel per: beat` and `merge: consecutive action beats` gives four panels —
the two action beats become one WS panel carrying the sound cue, each line gets
its own MCU panel, and the camera direction lands on its own panel.

Change one line to `panel per: line` and the same script becomes two panels: the
actions fold into the panel for Mabz's line, and the camera direction rides with
Tully's.

Change `carry: sound -> notes` and the cue also appears in the panel notes, where
whoever animates it will read it.

Nothing is applied behind your back: in the default `suggest` mode the storyboard
shows exactly what a re-derivation would add, update or drop, and you accept it.
