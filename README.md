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
- **Random text.** A word database — each entry with a word type, how common it
  is, and weighted links to other words — that the flow walks to write new text
  or rewrite text arriving over a wire. Length is set by word count, character
  count, or a percentage change, with a temperature that decides how exactly to
  land on it; another temperature decides how much of the incoming text is
  replaced. Every run is seeded, so it is reproducible.
  See [docs/RANDOM-TEXT.md](docs/RANDOM-TEXT.md).
- **Animatic.** The board laid out in time: hold a shot longer, cut one out, aim
  at a runtime and fit the whole cut to it — none of which touches the board. It
  plays in the browser, and **Export video** records the same cut to a real video
  file and puts it on the flow's Preview port, so a laptop with no video tooling
  still produces a watchable file at the end of the pipeline.
- **Video output.** The animatic, edit and render flows write the cut as a
  timeline (`animatic.json` / `edl.json`) that every downstream flow reads, plus
  an mp4 when ffmpeg is installed — and the exact command when it is not. Set
  `VIBETOON_FFMPEG` if ffmpeg is not on your `PATH`.
- **Every other flow kind** uses the brief editor: fields defined by the flow
  itself, generated into a markdown brief with everything arriving over its
  connections recorded underneath. Image and audio ports take a file you upload,
  so a design you drew elsewhere becomes a real artifact the graph can track.

## What it does not do

- It does not draw, act, compose or animate for you. Generation here means
  turning what you wrote into the files the next flow reads, and assembling what
  exists. There is no model wired in; every generator is deterministic and local
  — including the random text flow, which walks a word database you can edit
  rather than predicting anything.
- Bespoke editors exist for four flow kinds so far (dialog, storyboard, random
  text, animatic). The rest
  are real and usable through the brief editor, but they are text and uploads,
  not purpose-built tools.
- Rendering an mp4 on the server needs ffmpeg installed separately. The
  in-browser export writes WebM, recorded in real time — a 30 second animatic
  takes 30 seconds — and the file it produces carries no duration in its header,
  which some players only work out once they have read it.

## Layout

```
packages/shared   domain model, flow catalogue, rules language, board derivation,
                  the word database and text generator
packages/server   file-backed projects, generation, video assembly (Express)
packages/client   React + SCSS: graph canvas, flow editors, playblast
docs/             architecture, the flow catalogue, the rules language
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the full flow
list in [docs/FLOWS.md](docs/FLOWS.md).
