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
npm test           # shared model + server API tests (see docs/TESTING.md)
npm run typecheck  # whole monorepo
npm run build      # production client bundle
npm start          # serve API + built client from :5174
```

Projects are plain folders under `data/projects/<id>/` — `project.json` plus an
`artifacts/` directory of generated files. Copy one, zip it, or put it in git.
Set `VIBETOON_DATA` to keep them somewhere else.

## What you can do today

- **Graph overview.** Add flows from a catalogue of 47 kinds, drag a port to
  another port to connect them, and see at a glance what is up to date, what is
  stale and what failed. Port types are checked and loops are refused.
- **A filterable catalogue.** Forty-seven flow kinds is more than a list you
  read, so it is a list you narrow: by what a flow *takes*, what it *gives*, and
  where it belongs. Port kind is the useful axis on a graph — the question is
  rarely "what is in the art category" and often "what can I plug this image
  into". Within a row any one counts, across rows all must hold, and each option
  carries the number of flows it would leave.
- **A View menu.** Everything the studio draws costs something on a big project:
  forty nodes with their ports and files, an inspector fetching every generated
  file, a preview that reruns the generator on every keystroke. Each can be
  turned off, and “Lighten everything” turns the lot down in one click.
- **An API log.** Every dictionary lookup and corpus download the studio makes,
  with the status, the timing, which attempt it was and why it failed — the
  thing the browser's network tab cannot show you, because it happens on the
  server. See [docs/API-LOG.md](docs/API-LOG.md).
- **An (i) on every setting.** What it does and what a value of it looks like,
  with the useful range written out — `0.02` against `0.45` against `1`. One
  switch in the header hides them all again.
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
- **Corpus.** The text everything else reads, gathered in one place. A part that
  is an address is fetched on every run, so a novel never lives in the project
  file; a part you pasted is kept. Wire it into a word database and a grammar
  database and both read exactly the same words.
- **Dictionary.** A word database in, a better one out: it asks a dictionary
  what each word is, because word *type* is what decides whether the grammar
  flow produces English or soup. Five services are built in, three needing no
  key, and a key for the others is entered in the studio and kept on the server,
  outside every project.
- **Word database.** Counted out of a corpus rather than written by hand: point
  it at a public-domain book or paste your own text, and it tallies every word
  and every pair of adjacent words, asks a dictionary for types and definitions,
  and derives frequencies and weighted contexts. Each corpus stays its own
  dataset of raw counts, so combining and *un*-combining them is exact — build a
  database from two books, untick one, and what is left is precisely the other.
  Five dictionary services are built in, three of them needing no key, so a
  service that throttles is a switch rather than a dead end.
  Every entry also carries the other spellings its word takes — `walk`, `walks`,
  `walking`, `walked` — which is what makes the grammar flow possible.
  See [docs/WORD-DATABASE.md](docs/WORD-DATABASE.md).
- **Grammar database.** A corpus plus a word database read for the *shapes* its
  sentences take: `determiner noun:singular verb:third_person_singular` and how
  often that shape turned up. Sentences, the fragments they are built from, and
  every short phrase inside them, counted the same exact way corpora are, so
  they combine and un-combine without drifting.
  See [docs/GRAMMAR-DATABASE.md](docs/GRAMMAR-DATABASE.md).
- **Random text.** Walks that database to write new text or rewrite text arriving
  over a wire. Length is set by word count, character
  count, or a percentage change, with a temperature that decides how exactly to
  land on it; another temperature decides how much of the incoming text is
  replaced. Wire a grammar database in and it stops writing word by word and
  starts writing into sentence shapes, inflecting each word to fit its slot.
  Every run is seeded, so it is reproducible.
  See [docs/RANDOM-TEXT.md](docs/RANDOM-TEXT.md).
- **Design sheets.** Character, set and prop design flows are drawing surfaces:
  a sheet of plates (front, three-quarter, expressions) drawn with the same
  vector tools as the board, alongside the written spec. Generating writes the
  first plate as the flow's key image — `character.png` — and every plate as its
  model sheet, so the picture and the words that describe it stay together.
- **Image source.** A picture from this machine or from a link, made into an
  artifact the graph can track. A fetched image is copied into the project rather
  than re-fetched each run, because a link that works today is not a link that
  works next year — and an address pointing at this machine or its private
  network is refused, because the server can reach what your browser cannot.
- **Image extraction.** Cut a subject out by clicking: left click floods a region
  in, right click takes one out, and a line cuts across whatever the pixels think
  — which is what separates an arm from the body it shares a shadow with. For a
  subject no tolerance can find, draw a **region** round it and keep or drop
  everything inside. What is stored is the list of those actions, never the mask,
  so every one stays selectable and deleting the third of twenty takes its region
  with it. Tolerance
  is measured against the pixel you clicked rather than against each neighbour,
  which is the difference between a tool you can aim and one that selects the
  whole picture. Writes a transparent PNG and the mask beside it.
- **Palette filter.** A palette and an image in, a filtered image out: keep only
  those colors, drop them, or snap every pixel to the nearest one. Keep and
  remove are exact mirrors; snap has no threshold, because every pixel has a
  nearest. A pixel that was already transparent is left alone in every mode, so
  cutting a subject out first and filtering it second does not undo the cutting.
  See [docs/IMAGE-FLOWS.md](docs/IMAGE-FLOWS.md) for all three.
- **Polygon decomposition.** A picture back into shapes: strokes become lines and
  areas become convex polygons. A line is a region that is *thin* **and** has
  different things either side of it — two blocks meeting is not a line, a stroke
  between them is — so one setting, how wide a stroke may be, decides what the
  picture is. Shapes are then fitted by **measuring**: each candidate is drawn and
  compared with the pixels it stands for, and what it gets wrong is weighed
  against what it costs in anchors and polygons — both of which are prices you
  set. A stroke widens until it fills the contrast gap it was traced from, and
  grows at each end while growing keeps helping.
- **Vector editor.** Where the decomposition gets fixed: drag anchors, add and
  delete them, cut a shape in two, or delete a run out of a line. The edits are
  the work, so they are kept rather than recomputed — an upstream re-run is
  reported, not allowed to throw them away.
  See [docs/VECTOR-FLOWS.md](docs/VECTOR-FLOWS.md) for both.
- **Rig binding.** A skeleton and a vectorized drawing in: assign shapes to bones
  by picking or by lassoing a region, and add or delete bones as you go. The rig
  is scaled onto the drawing when it arrives, because the two were made in
  different spaces and a skeleton in the corner has no bone to aim at. One shape
  belongs to one bone — an outline has to go somewhere whole.
- **Pose.** Move the bound rig. Turn a joint and everything below it comes along,
  or drag the end of a limb and the joints above it work out how to get there. A
  reach it cannot make falls short and says how far out it was, rather than
  stretching into a pose a body could not hold.
  See [docs/RIG-FLOWS.md](docs/RIG-FLOWS.md) for both.
- **Color palette.** An image in, the colors it actually uses most out —
  *counted*, not averaged, which is how palettes avoid coming out as five
  shades of mud. A minimum distance measured in OKLab stops a gradient of near
  neighbours taking every slot: anything closer joins a group, and the palette
  is one color picked out of each group. A temperature moves that pick around
  inside its group, so a palette color is always a color the image contains.
  See [docs/COLOR-PALETTE.md](docs/COLOR-PALETTE.md).
- **Skeletal rig.** A character type is a skeleton, not a label: `octopus` is
  forty-two bones in eight chains and `human` is nineteen in a different shape.
  The editor draws it over the character design and edits limits — range of
  motion, stiffness, and how far a bone may squash or stretch. A run of small
  bones is a chain with one floppiness, so a tentacle is one slider rather than
  eight, and editing a left bone writes its right twin.
  See [docs/SKELETAL-RIG.md](docs/SKELETAL-RIG.md).
- **Timeline.** Events on a zoomable line through time, each with a time and
  places known exactly or only in part ("March 2004", "somewhere in France"),
  characters, tags and dialog. Filter by words, characters, places and tags, and
  color by any of them. See [docs/TIMELINE.md](docs/TIMELINE.md).
- **World map.** A generated world — land and sea, climate, what grows — zoomed
  from continent to harbour wall, painted over, regenerated in parts, and filled
  with named places from a catalogue of 780 kinds, each named at the scales where
  it makes sense. Its places feed the timeline.
  See [docs/WORLD-MAP.md](docs/WORLD-MAP.md).
- **Animatic.** The board laid out in time: hold a shot longer, cut one out, aim
  at a runtime and fit the whole cut to it — none of which touches the board. It
  plays in the browser, and **Export video** records the same cut to a real video
  file and puts it on the flow's Preview port, so a laptop with no video tooling
  still produces a watchable file at the end of the pipeline.
- **Video output.** The animatic, edit and render flows write the cut as a
  timeline (`animatic.json` / `edl.json`) that every downstream flow reads, plus
  an mp4 when ffmpeg is installed — and the exact command when it is not. Set
  `VIBETOON_FFMPEG` if ffmpeg is not on your `PATH`.
- **Full-screen editing.** A canvas is worth more room than a panel beside a
  settings column gives it, so the drawing surfaces expand to fill the screen and
  collapse again — the cutout canvas, the filter preview, the skeleton, design
  plates and storyboard panels. Expanding does not move anything in the page, so
  a drawing in progress survives it.
- **Every other flow kind** uses the brief editor: fields defined by the flow
  itself, generated into a markdown brief with everything arriving over its
  connections recorded underneath. Image and audio ports take a file you upload,
  so work you made elsewhere becomes a real artifact the graph can track.

## What it does not do

- It does not draw, act, compose or animate for you. Generation here means
  turning what you wrote into the files the next flow reads, and assembling what
  exists. There is no model wired in; every generator is deterministic and local
  — including the random text flow, which walks a word database you can edit
  rather than predicting anything.
- Bespoke editors exist for twenty flow kinds so far (corpus, word database,
  dictionary, grammar database, random text, dialog, storyboard, the three design
  sheets, image source, image extraction, color palette, palette filter, polygon
  decomposition, vector editor, rig binding, pose, skeletal rig and animatic).
  The rest are real and usable through the brief editor, but they are text and
  uploads, not purpose-built tools.
- Building a word database from a book needs the network: one download for the
  text, and one dictionary request per word (cached afterwards). Without it the
  bundled sample corpus still works, because the words in it ship with their
  meanings — but a word nothing has answered for stays `unknown` rather than
  falling back to a guess.
- The image flows do their pixel work in the browser, because that is what
  decodes a JPEG and composites a mask. Decomposition reads every pixel several
  times, so it is capped at about four megapixels — scale a photograph down first. So generating one you have not opened
  warns rather than writing a file, and changing the picture upstream marks the
  work stale rather than quietly describing the old one.
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
docs/             architecture, the flow catalogue, the rules language, the log
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the full flow
list in [docs/FLOWS.md](docs/FLOWS.md).
