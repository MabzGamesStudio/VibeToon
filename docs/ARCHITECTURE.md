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
| `assembly`    | `animation.animatic`, `production.edit/render`      | `animatic.json` / `edl.json`, `render-plan.md`, mp4 when ffmpeg exists |
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

## Video

The board's panels are rasterised in the browser from the same stroke data
(`rasterizePanel`) and posted with the generate request, which writes `panels/`.
The assembly generator reads the storyboard JSON plus that folder, writes a
timeline, and — if ffmpeg is on the machine — runs a concat-demuxer render into
an mp4. Without ffmpeg it writes `concat.txt` and the exact command instead, and
the browser playblast covers watching the cut.

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

The graph canvas is plain React and SVG: nodes are absolutely positioned in a
transformed world layer, edges are cubics between port anchors read from layout
(so they stay attached without hard-coded card metrics), and each interaction —
pan, node drag, wire drag — is a pointer capture that commits once on release.
