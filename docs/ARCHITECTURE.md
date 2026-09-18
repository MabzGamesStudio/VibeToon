# Architecture

Three packages, one shared model.

```
packages/shared ──▶ packages/server (Express, tsx)
       │
       └──────────▶ packages/client (React, Vite, SCSS)
```

`@vibetoon/shared` is consumed as TypeScript source by both sides, so a change to
the model is a type error in the editor and the generator at the same time. The
server runs through `tsx`; the client is bundled by Vite. There is no build step
between them.

## The model

**Artifact** — a file a flow produced, typed by kind (`text`, `json`, `image`,
`imageSet`, `audio`, `video`, `timeline`, …) and recorded with a content hash.

**Port** — a named socket on a flow, typed by the artifact kinds it can carry.
Inputs declare what they accept; outputs declare the file they write.

**Flow kind** — the definition of a kind of work: its category, ports, which
editor it opens, and (for brief flows) the fields it collects. The catalogue
lives in `shared/src/registry/flowKinds.ts`; adding a kind is adding an entry.

**Flow** (a node) — an instance of a kind in a project: name, position, notes,
its editor's data, and the artifacts it last wrote.

**Connection** — an edge from an output port to an input port, carrying rules
text and settings (enabled, mode, weight, notes). Modes:

| Mode        | What it means                                                  |
| ----------- | -------------------------------------------------------------- |
| `suggest`   | Upstream changes become a proposal you accept in the editor.    |
| `apply`     | Upstream changes are pulled in automatically on generate.       |
| `reference` | Upstream is context only; it never rewrites downstream data.    |

**Project** — nodes, connections, settings (fps, frame size, default shot length,
style note) and the canvas view, with a revision counter for optimistic saves.

## Staleness

`computeSignature(project, node)` hashes everything that can change a flow's
output: its own data and notes, the project settings a generator reads, and —
per enabled incoming connection — the rules, mode, weight and the **hash of the
artifact it carries**. A flow is `ready` when that signature matches the one
recorded by its last run, and `stale` when it does not.

That is what makes the graph honest about consequences: editing dialog marks the
dialog flow stale, and only *regenerating* it (a new `dialog.txt` hash) marks the
storyboard stale in turn. Editing the rules on the wire marks the downstream flow
stale on its own.

## Generation

`POST /api/projects/:id/flows/:flowId/generate` builds a context (the project,
the node, its resolved inputs, a reader for upstream artifact text, an optional
set of attachments) and hands it to a generator chosen by flow kind:

| Generator     | Kinds                                              | Writes |
| ------------- | -------------------------------------------------- | ------ |
| `dialog`      | `story.dialog`                                      | `dialog.txt`, `scenes.json`, `soundcues.txt` |
| `storyboard`  | `animation.storyboard`                              | `storyboard.json`, `shotlist.csv`, `boards.md`, `panels/` |
| `animatic`    | `animation.animatic`                                | `animatic.json`, `animatic-plan.md`, mp4 when ffmpeg exists |
| `assembly`    | `production.edit`, `production.render`              | `edl.json`, `render-plan.md`, mp4 when ffmpeg exists |
| `lexicon`     | `text.lexicon`                                      | `lexicon.json`, `report.md` |
| `text`        | `text.random`                                       | `text.txt`, `lexicon.json`, `report.md` |
| `design`      | `animation.character/set/prop.design`               | the spec, plus the plates as a key image and a model sheet |
| `brief`       | everything else                                     | markdown / text / json / csv from the flow's fields |

Results are merged over the flow's existing outputs by port, so a file you
uploaded onto an image port survives a regenerate of the text ports next to it.

`POST /api/projects/:id/generate` runs every stale flow in topological order, so
a flow reads artifacts its inputs produced in the same pass.

## Dialog → storyboard

The one derivation implemented end to end, and the template for the rest:

1. `parseRules(connection.rules)` → directives + guidance.
2. `deriveConfigFromRules` turns the directives into knobs (granularity, merge
   policy, shot sizes per beat type, ignores, carries, duration clamps, scene
   filter).
3. `deriveBoardFromDialog` walks the scenes and produces panels, each remembering
   the beat ids it came from.
4. `planSync` merges that proposal into the board you have:
   - a panel matches an existing one by shared beat ids;
   - **sketches and panel notes are never overwritten**;
   - **pinned** panels keep their text;
   - hand-made panels (no beat ids) stay where they are;
   - a panel whose beats disappeared is dropped only if it is empty — if it has
     artwork it is kept and flagged as orphaned.
5. The plan is shown as a diff before anything is written (`suggest` mode) or
   applied during generation (`apply` mode).

## Random text

`text.random` is the other derivation implemented end to end, and it is worth
reading as a second worked example of the same idea: a flow with editable state
(a word database), a deterministic generator, and connection rules that retune it
from the outside. The engine lives in `shared/src/text/` — tokeniser, scoring,
sampler, and a starter database — so the editor previews a run with exactly the
code the server will write the artifact with. [RANDOM-TEXT.md](RANDOM-TEXT.md)
covers the scoring.

## Grammar

`text.grammar` is the third derivation, and the one that shows how two flows
combine into something neither could do alone: it takes a corpus *and* a word
database, and uses the second to read the first. The database is the authority on
what type each word is, the inflection rules say which form its spelling is in,
and what comes out is a count of the shapes the corpus's sentences take.

It reuses the corpus machinery wholesale — datasets of raw counts, a master that
is the sum of the ticked ones, exact subtraction when one is unticked — because
the property that made corpora composable is the same property patterns need.
`buildGrammarModel` turns the stored counts into what the sampler wants: sentence
shapes to draw from, and a map from a run of slots to what followed it.

[GRAMMAR-DATABASE.md](GRAMMAR-DATABASE.md) covers the whole flow.

## Video

The board's panels are rasterised in the browser from the same stroke data
(`rasterizePanel`) and posted with the generate request, which writes `panels/`.

The animatic reads `storyboard.json` plus that folder and lays it out in time.
Its own state is only what it changes — a hold, a shot cut out, a target runtime
— so `resolveAnimaticCut` is a pure function of (board, overrides, rules) and
retiming never edits a drawing. The cut list it writes is what the edit and
render flows read.

Two routes produce an actual file, and they meet at the same port:

- **Server:** a concat-demuxer ffmpeg render of the panel images at their clip
  durations. Without ffmpeg the exact command is written to `animatic-plan.md`
  next to `concat.txt`, so the same render can be run later by hand.
- **Browser:** `recordClips` paints the same `PlayClip`s the player uses onto a
  canvas, captures it with `canvas.captureStream` + `MediaRecorder`, and uploads
  the result onto the Preview port. Capture is real time, and the canvas is
  repainted every frame — a canvas stream only emits when the canvas is dirty, so
  a long held shot would otherwise record as a gap.

Because generation merges outputs by port, a recording made in the browser
survives regenerating the flow: the generator only writes `preview` when it
actually rendered one.

## Counting a corpus

`text.lexicon` keeps a list of datasets, each one the raw counts taken from a
single corpus, plus the ids of the ones currently included. The master is
`combineDatasets(included)` and the lexicon is `deriveLexicon(master, meanings)`
— both pure functions, both recomputed on demand. Nothing is ever merged
destructively, which is why unticking a corpus subtracts it exactly rather than
approximately, and why the weighting settings can be changed without re-reading
any text.

Only counts are stored, never the source text: a book is a megabyte of prose and
a few hundred kilobytes of counts, and the counts are what every later step
needs. The consequence is that the *counting* settings apply when a corpus is
added — a dataset cannot be re-pruned upwards later without counting the text
again.

The two network calls live on the server because the browser cannot make them:
book sites do not allow cross-origin reads, and the dictionary cache belongs on
disk. Both degrade rather than fail — a blocked dictionary leaves every word with
a guessed type and says so.

## Drawings

Three surfaces draw, and they all store vector strokes in the project rather than
pixels: storyboard panels, design plates, and anything added later. `SketchPad`
owns the input, `drawSketch` renders at any size, and the editor rasterises to
PNG only when a run needs files — panels at the project's frame size, design
plates at 1080 tall in the plate's own shape. Nothing in the project file is a
bitmap, so a board or a model sheet stays small, diffable and re-renderable.

## Storage

One folder per project:

```
data/projects/<projectId>/
  project.json
  artifacts/<flowId>/dialog.txt
  artifacts/<flowId>/panels/panel-001.png
```

Writes are serialised per project and go through a temp file + rename. `PUT`
carries the revision it was loaded at and is refused with 409 if the project
moved on, so a stale tab cannot overwrite newer work. Artifact paths are resolved
inside the project directory and refused if they climb out of it.

## Client

A single `StudioProvider` holds the project, autosaves 700ms after the last edit,
and coalesces edits made while a save is in flight. Generation, sync and upload
flush pending saves first, then adopt the project the server returns.

The graph canvas is plain React and SVG: cards sit in a transformed world layer,
edges are cubics between port anchors, and each interaction — pan, node drag, wire
drag — is a pointer capture that commits once on release.

Four rules keep it at frame rate on a large graph, and breaking any one of them
brings the lag back:

- **Port anchors are arithmetic, not layout.** Where a port sits inside its card
  is a property of the *flow kind*, so it is measured once per kind and cached;
  a card's anchors are then its position plus that offset. Reading `offsetLeft`
  off each dot instead forces the browser to lay the page out again on every
  frame of a drag, which was the single largest cost.
- **A gesture does not go through React.** Panning and zooming write the
  transform straight onto the world layer and the background, and tell React
  where they got to only on release (and, at 10Hz, so culling stays honest).
  The transform is painted in a layout effect rather than written as an inline
  style, so a commit cannot drag the canvas back to where the last commit was
  queued.
- **`NodeCard` is memoised and every prop it takes is stable.** That means
  `useCallback` on every handler, a `dropPortId` for *this* card rather than a
  freshly built object, and no `project` prop: whether a flow is up to date and
  which of its ports are wired costs a walk of every connection, so the canvas
  works that out once per project change and passes the answer down.
- **Off-screen cards are not drawn** once a graph passes 24 flows, with a whole
  viewport of slack around the edge. Below that everything is drawn, because a
  small graph is never the one that is slow.
