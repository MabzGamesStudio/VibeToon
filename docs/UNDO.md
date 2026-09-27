# Undo, redo and slider ranges

## Undo and redo

Every change to a project can be undone: an edit in any flow's editor, a node
added, moved, renamed or removed on the graph, a wire connected or its rules
changed, a project setting, and what a generate or a sync writes back into a
flow's data.

| | |
| --- | --- |
| Undo | **Ctrl+Z** (⌘Z), or **↶ Undo** in the header |
| Redo | **Ctrl+Shift+Z** or **Ctrl+Y** (⌘⇧Z), or **↷ Redo** |

The buttons say what they will do — *Undo World Map: settings*, *Undo Move
Timeline*, *Undo Connect Map → Timeline* — and are greyed out when there is
nothing to do.

### Where you are decides what is undone

- **Inside a flow's editor**, undo walks back *that flow* only: its data, its
  name and its notes. An edit made in another flow is never undone from here,
  because you could not see it happen.
- **On the graph**, undo is the last change anywhere. When that change is inside
  a flow, a note says what was undone.

Each flow keeps its own redo. A new change drops the redo of the flow it was
made in (that branch no longer follows), and any redo of the graph; the redo of
other flows is kept.

### What one step is

- **A gesture is one step.** Everything done while the pointer is held down —
  dragging a node, a slider, a brush stroke on the map, a joint on the rig — is
  one undo, however long it takes.
- **Typing is one step per pause.** Changes to the same thing less than a second
  apart join up; a pause, Enter, Tab or clicking elsewhere starts the next step.
- **A click is one step.** Two quick clicks on *Add* are two steps.
- **A generate or a sync is always a step of its own**, named after it, when it
  changed any flow's data.

### What is not a step

What only moves the eye is carried along, not recorded:

- **The view** — where a timeline, map or graph is zoomed and scrolled to — stays
  where it is when you undo.
- **The selection** comes back with the step it went with, so an undone delete
  returns selected.
- **The tool in hand** (the binding brush and bone, the pose mode, the timeline's
  filters) stays as it is.
- **Files** a generate wrote, the last run's log, and the project's revision are
  never rolled back: they are the server's, and a file cannot be un-written. For
  the same reason what the image source knows about its picture (its size and
  where it came from) and the size the image extraction measured are facts about
  a file, not steps.

History lasts while the project is open (the last 200 steps); opening another
project starts a new one. Undo and redo save like any edit.

### How it works

Every change to a project goes through one function in the studio's store, which
records the project before and after it (`packages/shared/src/project/history.ts`).
Edits replace what they change and share the rest, so an entry costs about what
the change does. A step is scoped to one flow when it changed one flow's own
things and nothing else, and to the graph otherwise. Undoing a flow's step puts
back only that flow's data, name and notes; undoing a graph step puts back the
nodes, positions, wires and project settings, and a node's own data only if that
step changed it.

## Slider ranges

**Settings** in the header lists every slider in the studio, flow by flow — 75
of them, from the world map's *Land* to the rig preview's *Gravity* and a
connection's *Weight*. For each, set the **lowest** and **highest** value it
reaches, and the **step** one notch moves it.

- Narrow a range to make fine changes easy: *Land* from 0 to 0.2 for a world of
  islands.
- Widen it to go past the defaults: *Stretches to* up to ×6 for a rubber-hose
  character.
- A value already set outside a new range is kept and shown in the readout; the
  slider stops at its end until you move it.
- A range the wrong way round, or a step wider than the range, is refused with
  the reason, and nothing is saved.
- **Reset** puts one slider back; **Reset all** puts them all back. **Only
  changed** lists what differs from the defaults.

The ranges belong to this installation, not to a project: they are kept in
`data/settings.json` (under `sliderRanges`) and apply to every project. Only the
ranges are ever sent to the browser from that file.

Every slider names its range by a key (`range="map.land"`), and its defaults live
in one list, `packages/shared/src/registry/sliderRanges.ts`. `sliderRanges.test.ts`
fails the build if a slider has no key, names one that is not in the list, or the
list holds one no slider uses — so a new slider cannot miss the settings page.
