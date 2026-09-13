# VibeToon

A workflow for making short animated clips on an ordinary laptop.

Making a clip is not one job, it is a dozen small ones — brainstorming, dialog,
character design, boards, music, sound, the edit — and each one feeds the next.
VibeToon models each of those as a **flow**: a thing with inputs, outputs and its
own editor. Flows are wired together in a graph, and each connection carries
**plain-text rules** that say how the downstream flow should read what arrives.

The first working path is the one every clip starts with: **Scene Dialog →
Storyboard**. Write the script, and the board breaks it into panels the way the
rules on the wire tell it to, keeping every sketch you have already drawn.

```
┌──────────────┐   panel per: beat          ┌──────────────┐
│ Scene Dialog │   shot for line: MCU        │  Storyboard  │
│  dialog.txt  ├────────────────────────────▶│ storyboard.  │
│  scenes.json │   carry: sound -> notes     │ json, panels │
└──────────────┘                             └──────────────┘
```

## Running it

```sh
npm install
npm run dev        # API on :5174, UI on http://localhost:5173
```

Then make a project (the default template is the dialog → storyboard graph
above), press **Generate stale**, open the storyboard and hit **Review sync**.

Other commands:

```sh
npm test           # shared model + server API tests
npm run typecheck  # whole monorepo
npm run build      # production client bundle
npm start          # serve API + built client from :5174
```

Projects are plain folders under `data/projects/<id>/` — `project.json` plus an
`artifacts/` directory of generated files. Copy one, zip it, or put it in git.
Set `VIBETOON_DATA` to keep them somewhere else.

## What you can do today

- **Graph overview.** Add flows from a catalogue of 34 kinds, drag a port to
  another port to connect them, and see at a glance what is up to date, what is
  stale and what failed. Port types are checked and loops are refused.
- **Rules on every connection.** A documented set of `key: value` directives is
  interpreted (`panel per: beat`, `shot for line: MCU`, `ignore: direction`,
  `carry: sound -> notes`, `min duration: 1.2`, …) and anything else you write is
  kept as guidance rather than dropped. See [docs/RULES.md](docs/RULES.md).
- **Scene dialog editor.** Cast with personality and voice notes, sets, and
  scenes of ordered beats — dialog, action, sound cues and camera directions —
  with estimated screen time. Generates `dialog.txt`, `scenes.json` and
  `soundcues.txt`.
- **Storyboard editor.** Panels with shot size, timing, dialog, action, sound and
  a vector sketch pad. Syncing from the dialog shows you exactly what it would
  add, update or drop *before* it touches the board; sketches, panel notes and
  pinned panels are never overwritten. Generates `storyboard.json`,
  `shotlist.csv`, `boards.md` and a rasterised `panels/` folder.
- **Playblast.** Play the board in the browser at its own timing, with dialog as
  captions. No tooling required.
- **Video output.** The animatic, edit and render flows assemble the boards into
  a timeline (`animatic.json` / `edl.json`) and, when ffmpeg is installed, an
  mp4. Without ffmpeg they still write the timeline, the clip list and the exact
  command to run later. Set `VIBETOON_FFMPEG` if it is not on your `PATH`.
- **Every other flow kind** uses the brief editor: fields defined by the flow
  itself, generated into a markdown brief with everything arriving over its
  connections recorded underneath. Image and audio ports take a file you upload,
  so a design you drew elsewhere becomes a real artifact the graph can track.

## What it does not do

- It does not draw, act, compose or animate for you. Generation here means
  turning what you wrote into the files the next flow reads, and assembling what
  exists. There is no model wired in; every generator is deterministic and local.
- Bespoke editors exist for two flow kinds so far (dialog, storyboard). The rest
  are real and usable through the brief editor, but they are text and uploads,
  not purpose-built tools.
- Rendering video needs ffmpeg installed separately.

## Layout

```
packages/shared   domain model, flow catalogue, rules language, board derivation
packages/server   file-backed projects, generation, video assembly (Express)
packages/client   React + SCSS: graph canvas, flow editors, playblast
docs/             architecture, the flow catalogue, the rules language
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the full flow
list in [docs/FLOWS.md](docs/FLOWS.md).
