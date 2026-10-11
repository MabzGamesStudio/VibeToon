# Voronoi Diagram

`art.voronoi` · takes an **Image**, and optionally a **Palette** · gives
**`voronoi.png`**, **`vector.json`** and **`voronoi.svg`**, **`nodes.json`** and
**`voronoi.md`**

```
Image ──┐
        ├──▶ Voronoi Diagram ──▶ voronoi.png / vector.json + voronoi.svg / nodes.json
Palette ┘        (optional)
```

A picture redrawn as a Voronoi diagram: so many **nodes**, each one colour, and
every pixel the colour of the node nearest it. The nodes are placed, and
coloured, to make the diagram as like the picture as it can be — they gather
where the picture has detail, and spread out over flat colour.

## What is made small

The diagram is compared with the picture pixel by pixel: the squared difference
in red, green, blue and opacity, with colours premultiplied by opacity so a
see-through pixel's colour counts for nothing. Squared differences make the best
colour for a cell easy — the average of its pixels — and let a cell's error be
kept as sums while pixels come and go:

- with **S** the sum of a cell's pixels, **Q** the sum of their squared lengths
  and **N** how many, its error with its average colour is `Q − |S|² / N`;
- with a palette, its error with entry **e** is `Q + N|e|² − 2 e·S`, least for
  the palette colour nearest the cell's average.

So for nodes where they are, the colours are settled; the work is where the
nodes go.

## Where the nodes go

1. **Smaller, to work on.** The picture is averaged down to about 64 pixels a
   node (between 40,000 and 300,000 pixels).
2. **Start where the detail is.** Nodes are scattered with more where the
   picture has edges (a Sobel filter) and some everywhere, stratified so they
   spread evenly through the detail.
3. **Nudge each node.** Each round, in a shuffled order, each node tries a step
   left, right, up and down. A step is measured exactly: the node is moved, only
   the pixels round it are looked at — those of its cell now nearer another node
   and those of other cells now nearer it — and each changed cell's colour and
   error are worked out again from its sums. A step that makes the whole diagram
   fit better is kept and tried again (up to four times); one that does not is
   undone from a log. Steps start at a third of the distance between nodes and
   shrink by 0.72 a round.
4. **Move the nodes that do least.** Nudging only goes downhill, so every other
   round the nodes whose cells cost least to lose — empty ones, and those most
   like a neighbour (the Ward cost of joining them) — are taken out and put down
   where the fit is worst: in the cell with the most error, at the middle of its
   pixels that fit worse than its average. Each is kept only if the diagram fits
   better for it.
5. **At full size.** The nodes are scaled back, every pixel of the picture is
   labelled with its nearest node, and each node's colour is fitted again from
   the picture's own pixels.

A nearest-node look-up uses a grid of buckets: only the buckets round a pixel are
looked in, ring by ring, until no node further out could be nearer. The same
picture and settings always give the same diagram: the scattering and the order
the nodes are nudged in come from a seeded random number.

## Spacing and repel

No two nodes are ever nearer each other than a pixel: a step that would bring a
node closer than that to another is not taken, and nodes are started at least a
pixel apart (packed nodes — more than a third as many as the picture has pixels
— start on pixel centres, so up to one a pixel always fits).

**Repel** makes the nodes push each other apart as they are placed. Every move
is weighed twice: how much better it makes the diagram fit, and how close it
brings the node to its neighbours — `(1 − d / spacing)²` for each neighbour
nearer than the average spacing, weighted so that at 100 a node on top of a
neighbour costs as much as an average cell's whole error. At 0 the nodes crowd
along the picture's edges; higher, the cells come out more alike in size.

## The palette

Wire a [Color Palette](COLOR-PALETTE.md) (or any `palette.json`) into the
**Palette** input and tick **Only the palette's colours**: every node then takes
one of its colours — the one that fits its cell best — and the picture the
diagram makes has only those colours in it. Unticked, or with nothing wired, each
node takes its cell's own average.

## As shapes

**Write** chooses the picture, the shapes, or both. As shapes, each cell is drawn
exactly: the picture's rectangle cut by the line halfway between its node and
every node near enough to matter (only nodes nearer than twice the cell's
furthest corner can cut it, and they are looked for a ring at a time). With
**Join same-colored cells**, cells of one colour that share an edge are one
polygon: its outline is the edges that face another colour or the picture's edge,
and a loop that winds the other way is a **hole** where another area is inside
it. A node whose cell holds no pixel is left out, its neighbours closing over it
as they do in the picture; fully see-through cells make no shape. `vector.json`
is the same format the [Vector Editor](VECTOR-FLOWS.md) edits, and `voronoi.svg`
is made from it.

## In the editor

Nothing is fitted until **Fit** is pressed (or **Generate**, which fits first
when the settings changed): fitting a few thousand nodes takes seconds. It runs a
slice at a time, with a progress bar and a Stop button, so the page stays
responsive — about a second for 300 nodes on a 720p picture, twelve for 20,000.

The stage shows **the diagram** or **the picture**, with **Nodes** drawn as dots
the same size on screen however far you zoom in, and **Edges** (strong
between colours, faint between cells of one colour) and **Nodes** over either.
Beside it: how far off the diagram is (the mean difference per pixel and the
peak signal to noise), how many nodes have pixels and how many were moved, and
how many areas of same-coloured cells there are. Opened again later, the
diagram is read back from the `nodes.json` it last wrote, so it is there without
fitting it again.

## Settings

| Setting | What it does |
|---|---|
| **Nodes** (300) | How many cells. More follow the picture more closely and take longer. There is no fixed top: widen the slider's range in Settings for more, up to one node a pixel. |
| **Rounds** (12) | How long the nodes are nudged; more fits a little better. |
| **Repel** (off) | How hard nodes push each other apart: higher spreads them more evenly. |
| **Only the palette's colours** | With a palette wired in, every node takes one of its colours. |
| **Write** | The picture, the shapes, or both. What is not written is taken off the ports. |
| **Join same-colored cells** | As shapes: one polygon for each area of one colour, with holes. |

## What comes out

- **`voronoi.png`** — the diagram as a picture, every pixel its cell's colour.
- **`vector.json`** and **`voronoi.svg`** — the cells as polygons.
- **`nodes.json`** — every node: where it is, its colour (and palette entry),
  and how many pixels its cell holds; the settings, the palette, how far off the
  diagram is, and the picture it was fitted to.
- **`voronoi.md`** — the report.

A PNG is fitted on the server too, with the flow's settings, when the editor is
not open — a run of the whole project, or the items of a batch. Another format is
fitted in the editor, where the browser decodes it.

The [Video Background](VIDEO-BACKGROUND.md) flow uses the same fitting, frame by
frame, to find what moves by its **Voronoi areas**.
