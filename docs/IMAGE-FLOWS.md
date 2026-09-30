# Getting a picture in, and cutting it up

Three flows that make an image something the graph can work with: a **source**, an
**extraction**, and a **filter**. They are separate flows because they are
separate decisions, and they chain because that is how the work actually goes.

```
Image Source ──▶ Image Extraction ──▶ Palette Filter ──▶ …
      │                                      ▲
      └──────────▶ Color Palette ───────────┘
```

## Looking closely

Every part of an editor that shows a picture fills the screen on request, and once
it is there it **zooms and pans, right down to one pixel drawn sixty-four across**.
Scroll to zoom, drag with the middle button — or hold Shift — to move around, and
the buttons in the header do the same thing with a number on them.

Two details that make it worth having:

- **It zooms about the pointer**, so what is under it stays under it. Zooming about
  the middle is the thing that makes a zoom control useless for looking at a
  detail: every step towards a pixel pushes it further off the edge and the whole
  time goes on dragging it back.
- **A pixel is a square.** The browser's default is to smooth an image it scales
  up, which at eight times is a blur of guesses about colors that are not in the
  picture — the opposite of what looking closely is for.

Clicking still lands where it looks like it lands at any zoom, because every editor
maps a click through the proportions of the element's own box rather than through
an assumed scale.

## Where the pixels are decided

In the editor, in your browser — not on the server.

The browser already decodes PNG, JPEG, WebP, GIF and AVIF, and a canvas already
composites a mask. The alternative is this project carrying a decoder for each
format and a compositor besides, which is a great deal of code to own for
something every machine already has. So the editor does the pixel work and sends
the finished PNG along with the run, the same way the design flows send their
rasterised plates.

Two consequences, and both are said out loud rather than hidden:

- Generating a flow you have not opened produces a warning, not a file.
- Changing the picture upstream marks the work stale rather than quietly
  describing the old one.

---

# Image Source

`art.image` · takes nothing · gives an **Image** and **`source.md`**

A picture from this machine, or from a link.

Before this flow the only way into the graph was to find some other flow with a
spare image output and upload onto that port. That works, and nobody would guess
it. This is the door.

## Fetching a link

The server does the download, because a site that serves an image will usually
refuse a cross-origin read of its bytes, and because the bytes have to end up
where the project keeps them.

**It has to be the address of the image itself**, not of the page it sits on. A
page address returns HTML, and the flow says so — `That address returned a web
page, not an image` — rather than storing it and failing to draw it later. The
format is read from the first bytes, not from the `Content-Type` header, because
a server calling a perfectly good PNG `application/octet-stream` is common and a
server calling an HTML error page `image/png` is not rare either.

**Fetched once, never again.** A link that works today is not a link that works
next year, so the bytes are copied into the project. The flow keeps working on a
train, and generating never depends on a network.

**Addresses on this machine are refused.** A URL in a project file is an
instruction to the server to make a request, and the server can reach what your
browser cannot: the loopback interface, the private network around it, and a
cloud instance's metadata endpoint on `169.254.169.254`. None of those are the
web. The check covers `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16` and IPv6 loopback, and only `http` and `https` are fetched at all.

## What it records

`source.md` holds the provenance: what the file is, its size and dimensions, and
where it came from. A fetched picture with no credit recorded gets a note saying
so — nothing enforces it, and this is the only place the fact can live while it
is still easy to find out.

Dimensions are measured in the editor, because nothing on the server decodes an
image. An SVG is flagged for having no fixed pixel grid, and a GIF for having
only its first frame read.

---

# Image Extraction

`art.cutout` · takes an **Image** · gives **`cutout.png`**, **`mask.png`** and **`cutout.md`**

Cut a subject out by clicking the parts to keep.

## The mask is derived, never painted

This is the rule the whole flow follows, and it is what makes it usable.

What is stored is the **list of things you did** — the seeds you dropped, the
lines you cut. The mask is rebuilt from that list every single time. So every
action stays a real object: selectable, switchable, deletable. Delete the third
click of twenty and its region goes with it, and the other nineteen are untouched.

Painting into a bitmap would be simpler and would make every action permanent.
Twenty clicks in, the only way to undo the third is to start again. That is the
tool people give up on.

| Object | How | What it does |
| --- | --- | --- |
| Include | Left click | Floods a region in. |
| Exclude | Right click | Floods a region back out. |
| Cut | Two clicks with the straight tool | A barrier a fill cannot cross. |
| Curved cut | Click along a curve, then double-click | The same, smoothed. |
| Erase | A cut set to erase | Also clears what it covers. |

They apply **in the order they were made**, so an exclude takes a bite out of
what came before and an include after that puts some back. That is what clicking
feels like, so it is what the list means.

## Tolerance is measured against the pixel you clicked

Not against each neighbour in turn. That distinction is the whole difference
between a tool you can aim and the one everybody complains about.

Comparing neighbour to neighbour lets a fill walk a gradient across the entire
picture, one indistinguishable step at a time, and "select everything" is the
classic magic-wand failure. Comparing every candidate to the **seed color**
bounds the region by what you actually pointed at.

Distance is in OKLab, times 100 — under about 2 is a difference you cannot see,
20 is navy against royal blue, 70 and up is red against green. Each seed keeps
the tolerance it was made with, because the edge of a face and the edge of a sky
need different answers.

## Cut lines, and what they are for

Two regions can be the same color and still be different things. A shadow under
an arm joins it to the body at a distance of well under 1, and no tolerance
separates them — lower it and you lose the arm's own shading too.

A cut line is a barrier the fill cannot cross, so it separates them by geometry
instead of by color. It is at least one pixel wide for a reason: a
one-pixel-thin barrier leaks through diagonal gaps.

A cut is smoothed with a centripetal Catmull-Rom spline, which passes **through**
every point it is given. A Bézier would pull away from them, and a line that does
not go where you put it is not a line you can aim.

There is no straight-or-curved to pick before drawing one, because a two-point
spline **is** a straight line: click twice for a straight cut, more for a curve.

## Regions, for when no tolerance can help

A fill answers "what is this thing" by color, and some subjects have no answer.
A face against a busy background shares its colors with that background
everywhere; every fill catches some of both, and no amount of clicking fixes it.

So a **region** is a closed shape you draw round something, which takes — or
drops — everything inside it regardless of what the pixels are. Finish it with a
double-click or Enter to keep the inside, or right-click to drop it: the same
left-and-right as the fill tool, so there is one thing to remember rather than two.

**Smoothed** follows a curve through your points, for something organic;
**cornered** joins them straight, for something with edges. Here the difference is
real, unlike on a cut, because a shape has more than two points. The curve wraps
past the ends so the shape closes without a kink at the seam — which on a shape
drawn by hand is exactly where the eye goes.

A region's points are **corners**, and pixels are their centres: a box drawn from
`(0,0)` to `(7,2)` encloses the centres of the top two rows.

Filling is even-odd by scanline, so a shape drawn back over itself has a hole in
the middle without that being a special case.

A region is a selection on its own: one region kept, with no fill point and no
cut, is a mask of what is inside it. (It used to make no mask at all until a fill
point was added as well.)

## Moving and reshaping what is drawn

Everything drawn can be moved and reshaped after the fact:

- **Move** tool: drag a fill point, a cut or a region to move it whole.
- **On a selected region or cut, with any tool:**
  - drag one of its nodes to move it;
  - press on an edge to put a new node there and drag it into place;
  - right-click a node to delete it. A region keeps at least three nodes and a
    cut at least two.

  The edge is measured on the outline as it is drawn, so on a smoothed region
  you point at the curve, not at the straight lines between the nodes.

Fill points, nodes and the lines between them are sized on **screen**, not in
the picture's pixels. Zooming in to place a node precisely does not blow the node
up over the place you are aiming at. A node stays 7 screen pixels across whether
the stage is at fit or zoomed in 655%.

Every drag is one undo step.

## The edge

| Setting | What it is for |
| --- | --- |
| Tolerance | How far a fill spreads. |
| Neighbours | Whether a fill may spread through a corner as well as an edge. |
| Grow | Take back the blended halo a fill on a photograph stops short of, or trim a fringe off one that went wide. |
| Feather | Soften the edge, so a cutout composited elsewhere does not look cut out. |
| Drop islands under | Clear the speckle a fill picks up on a noisy photograph. |

Shrinking treats the border of the image as an edge like any other — otherwise a
selection running to the edge of the picture keeps a one-pixel frame of
background it was told to lose.

## What comes out

`cutout.png` is what was kept, everything else transparent. `mask.png` is the
selection alone, white on black, for anything that wants to use it differently.
`cutout.md` lists every object in the terms of what it does.

Cutting out of an already-transparent image cannot make a pixel *more* opaque:
the mask multiplies the alpha that was there rather than replacing it.

---

# Image Resize

`art.resize` · takes an **Image** · gives **`resized.png`**

Makes a picture bigger or smaller.

**Size.** Set it **by a factor** (×0.25 to ×8, with quick picks for the common
ones) or **to a size** in pixels. To a size, **keep its shape** makes the height
follow the width. The largest it will make is 16,384 pixels a side and 64
million pixels in all; beyond that it is shrunk as a whole, keeping its shape.

**Resampling**, how the new pixels are worked out:

| Method | What it does | For |
| --- | --- | --- |
| Nearest | Copies the pixel underneath; edges stay hard. | Pixel art, where each pixel is part of the drawing. |
| Bilinear | Blends the nearest two each way. Soft. | A quick, gentle resize. |
| Bicubic | Catmull-Rom, four each way: crisp with little ringing. | Drawings and cartoons (the default). |
| Lanczos | Six each way, the sharpest; can leave a faint halo beside hard edges. | Photographs. |

It is done in two passes, across and then down.

- **Shrinking** widens the kernel by as much as the picture shrinks, so every
  source pixel counts. A fine stripe shrunk to an eighth comes out a mid grey,
  not flickering black and white.
- **Premultiplied alpha.** Colors are blended with alpha premultiplied, so a
  transparent pixel's color never bleeds into the edge of the shape beside it.
  The edge fades rather than stepping.

The editor works the result out as the settings change and shows it at the size
it comes out beside the original (**Resized** / **Original**), zoomable to the
pixel. A PNG is also resized on the server, so the flow regenerates with
everything else. Any other format is decoded by the browser, so for those the
editor sends its result with the run.

---

# Image Crop

`art.crop` · takes an **Image** · gives **`cropped.png`** and **`crop.json`**

Cuts a picture down to part of it, in one of two ways.

**To the solid pixels.** For a picture with transparency (a cut-out character,
a sprite on a clear sheet), the box is the smallest one that holds every solid
pixel, so the subject is boxed and centred with nothing round it.

- **Solid above** is how much alpha a pixel needs to count. At 0 any pixel that
  is not fully clear counts, down to the faintest halo; raise it to leave soft
  shadows and haze outside the box.
- **Margin** keeps that many clear pixels round the subject on every side. It
  may reach past the picture's edge, and what is outside comes out clear.
- A picture with no transparency is solid all over, so its solid box is the
  whole picture. The editor says so; draw a box instead.
- **Adjust this box by hand** switches to drawing by hand, starting from the
  solid box.

**By hand.** Drag on the picture to draw a box. Drag the box to move it, drag
one of its eight handles to move that side or corner, or type its left, top,
width and height. Hold **Shift** to draw a new box over the old one. A box drawn
by hand stays inside the picture. **Whole picture** starts again;
**Fit to the solid pixels** puts the box round the solid pixels.

**Keep it square** grows the short side about the box's middle.

The editor shows the box over the picture, with everything outside it dimmed.
**Cropped** shows the result. The handles stay the same size on screen however
far you zoom in. Every change is one undo step.

`crop.json` says where the box was, so a flow downstream can put the crop back:

```json
{ "kind": "crop", "version": 1, "mode": "opaque", "source": { "width": 200, "height": 160 }, "box": { "x": 103, "y": 33, "width": 55, "height": 55 } }
```

A PNG is cropped on the server as well; any other format is cropped in the
editor and sent with the run.

---

# Line Detection

`art.lines` · takes an **Image** · gives **`lines.png`** and **`lines.md`** · feeds the [Line Graph](#line-graph)

Finds the drawn lines in a picture: the strokes between areas, told apart from
the edges where one area simply meets another.

```
colour A │ line colour │ colour B        a line: two sharp changes, a thin band between
colour A │ colour B                    an edge: one change, not a line
colour A ░▒▓ colour B                    a gradient: no sharp change, not a line
```

**Across a line the colour does three things.** It is one colour, then changes
sharply to the line's colour, then a few pixels on changes sharply again to the
colour on the far side (which may be the same as the first).

- **An edge**, one colour meeting another directly, is one change, not two.
- **A gradient** changes a little at every pixel and never sharply.
- **A soft edge**, a pixel or two part-way between the colours either side of
  it, is a blend rather than a colour of its own. It is taken as part of the
  edge, so anti-aliasing does not turn every edge into a thin line.

**How it looks.** The picture is read in square **chunks**. In each one, every
row, every column and both diagonals are walked and cut into runs of one
colour:

1. A run ends where a pixel is sharply unlike the one before it
   (**Sharp change**), or has drifted from the run's colour (**Flatness**).
   The second is how a gradient becomes many runs with no sharp change between
   them.
2. A run with a sharp change on both sides, no wider than **Widest line**, in a
   colour unlike both neighbours, is a line crossed in that direction.
3. **Longer than wide.** The line pixels found, joined to the ones of the same
   colour next to them, must reach along the line at least **Longer than wide
   by** times the line's width. A speck or a short dash is not a line; a stroke
   is. The length is measured over the chunk and half a chunk round it, so a
   line crossing a chunk's border is not cut short.

**Confidence and width.** Each line pixel gets a confidence from how sharp its
two changes are and how far past the ratio it reaches, and a **width**: the
narrowest any walk crossed its line, which is the width straight across (a
diagonal step counts as √2 pixels). `lines.png` is **black where there is no
line**. A line is **red when it is thin and blue when it is wide**, from pure red
at 1 pixel to pure blue at 16 pixels and wider, and **brighter the surer**: red
plus blue is the confidence, and how they are split is the width. That is exact
enough to read back, which is how the [Line Graph](#line-graph) takes the lines
in.

| Setting | What it does |
| --- | --- |
| Sharp change | How different two neighbouring pixels must be for a change to count (black against white is 100). |
| Flatness | How far a pixel may drift from its run's colour and stay in it. |
| Widest line | The widest a band can be and still be a line, in pixels. |
| Longer than wide by | How many times longer than wide a line must be. |
| Chunk size | The side of the squares the picture is read in. |

The editor finds the lines when the picture arrives. After that, two controls
sit both under the settings and over the picture:

- **Generate** finds the lines for the settings as they are and writes
  `lines.png` and `lines.md` to the outputs (as Generate at the top of the
  editor does). With Live off, changing a setting does not redo anything: the
  editor says the settings have changed since, and Generate is highlighted.
- **Live** is a switch. On, the lines are found again each time a setting stops
  moving, so you see them change as you drag, which suits a small picture. Live
  only shows them; Generate still writes them. It is kept with the flow.

**Lines** and **Original** switch between the line picture and the picture
itself; **over the picture** lays the lines over it. A PNG is read on the server
as well; any other format is worked out in the editor and sent with the run. A
picture a million pixels in size takes well under a second.

## Explain a pixel

Press **Explain a pixel** over the picture and click any pixel (a drag still
pans). The explanation opens under the picture and answers one question: why
is this pixel, or is it not, a line? It is worked out by the same code that
finds the lines (`explainLinePixel` beside `detectLines`), and a test holds the
two to the same answer.

- **The verdict** — a line or not, its confidence and width, and in a sentence
  what decided it.
- **A magnifier** round the pixel, with the chunk it was read in, the patch it
  joined, and the four walks through it (across, down, both diagonals) drawn
  over the pixels. The run each walk found the pixel in is outlined.
- **Each walk, pixel by pixel** — a strip of the pixels the walk crossed, cut
  into runs of one colour, with the size of each change marked (▲), slow drift
  shown dotted, and soft edges that were folded into their neighbours hatched.
- **The checks**, in the order the code makes them — narrow enough, a sharp
  change in, a sharp change out, a colour of its own, and so on — each ticked or
  crossed, with the numbers it compared. The first cross is why the walk did not
  count.
- **The patch** its crossings joined: how many pixels, how long and how wide,
  and a bar showing how far past **Longer than wide by** it reached.
- **The score**, as the sum it is: how sharp its edges were, how far past the
  ratio its patch reached, and the confidence that makes.

**How it works** at the top of the editor explains the whole algorithm, with a
flow chart, pseudocode and further reading (see
[ALGORITHMS.md](ALGORITHMS.md#line-detection)).

---

# Line Graph

`art.lines.graph` · takes a Line Detection's **Lines** · gives **`graph.json`**, **`vector.json`**, **`lines.svg`** and **`graph.md`**

Turns found lines into vector lines, joined where they meet.

```
Picture ──▶ Line Detection ──▶ Line Graph ──▶ vector.json ──▶ Vector Editor, Rig Binding…
```

**How it traces.**

1. The lines picture is read back: every pixel's confidence and width. A pixel
   counts when it is at least as sure as **Surest pixels only**.
2. **Fill.** Every connected area of line pixels is one fill. The editor shows
   each in its own faint colour under the lines.
3. **Thin.** Each fill is thinned to its middle, one pixel wide, keeping it in
   one piece (Zhang–Suen thinning). The vector lines are laid along this middle,
   so each runs over the area it came from.
4. **Nodes.** Where a middle ends there is an end; where three or more meet,
   a junction. Lines that cross or branch share the node where they meet. A loop
   with no end or junction gets a node where it starts, and comes back to it.
5. **Tidy.** Thinning leaves short spurs off a lumpy band. A line from an end
   into a junction shorter than **Drop spurs shorter than** is dropped, and a
   node left joining just two lines is taken out and the two joined into one.
6. **Simplify.** Each line keeps only the points it needs to stay within
   **Simplify** pixels of the middle it was traced along.

Each line keeps the **width** of the band it runs along (the mean width under
it) and its mean confidence.

**Keep lines of width.** Only lines in the range are kept: drawn in colour in
the editor, and written to the files. A small bar chart shows how many lines
there are of each width, coloured as the lines are. At the top of the scale
(16+ px) the range keeps everything wider too.

**By hand.**

- Click a line to select it (Shift adds to the selection). **Delete**, or
  **Take out**, takes the selected lines out. **Put back all** returns them.
- Drag a node to move it; every line ending there moves its end with it.
  **Nodes back** undoes every move.
- **Show lines taken out or out of range** draws them dashed: grey for out of
  range, red for taken out.

The hand edits are kept for this picture traced this way. Change the tracing
settings, or the lines coming in, and the lines are traced afresh with new ids,
so the edits are set aside (not applied to the wrong lines) until you forget
them. The width range is not an edit: it can be changed freely. Every change is
one undo step.

**What comes out**, of the kept lines only:

| File | What it is |
| --- | --- |
| `graph.json` | The nodes, and the lines between them: `from`, `to`, `points`, `width`, `confidence`, `length`. |
| `vector.json` | The lines as a vector drawing: open the Vector Editor on it, or bind it to a rig. |
| `lines.svg` | Each line as a polyline as wide as its line, coloured red (thin) to blue (wide). |
| `graph.md` | How many lines were found, kept, left out by width and taken out by hand. |

---

# Palette Filter

`art.palette.filter` · takes an **Image** and a **Palette** · gives **`filtered.png`** and **`filter.md`**

Two jobs in one flow, because they are the same measurement read two ways. Both
are exact about what they write, because exactness is what they are for.

| Mode | Every output pixel is | What it is for |
| --- | --- | --- |
| **Keep** | The source pixel exactly as it was (color and opacity) if it is within the tolerance of a palette color — otherwise `(0, 0, 0, 0)`. | Finding where a color is used. |
| **Snap** | Exactly one palette entry's four numbers, whichever entry looks nearest. | Making a picture use those colors and no others. |

**Snap leaves as many values in the picture as the palette has, and no others.**
Five colors and a transparent entry in play gives a result with six RGBA values in
it. A pixel becomes the entry's color *and* its opacity — nothing is multiplied or
blended with what the pixel was — so naming a half-transparent color is how you
fade the part of a picture that is that color, and an entry at `0%` erases it.
There is no tolerance in this mode: every pixel has a nearest entry, and refusing
to pick would leave a value in the picture that is not a palette color.

**Snap can clear away specks: the smallest chunk.** Snapping decides each pixel
on its own, so noise, a stray dot, or the flecks a soft edge leaves come out as
patches of one or two pixels in the wrong color. Set **Smallest chunk** and any
patch of one palette color smaller than that — pixels touching, corners included —
takes the color of a patch it touches instead. Of the colors beside it, it takes
the one closest to what its own pixels were, not whatever surrounds it most: a
dark red speck between a blue sky and a red roof goes red. Smallest first, so a
speck inside a speck is settled before the one around it. The transparent entry
counts like any other color, so a pinhole in a shape closes and a speck floating
in empty space goes. Every value in the result is still a palette value. Corners
count as touching so that a line one pixel wide on the diagonal stays one line.
Off (any size) by default; keep ignores it.

**Keep hands the source pixel back, not the palette value.** It does not recolor
anything: the palette is the question, and the picture is the answer. The point of
a tolerance is to take in shading, and replacing the pixel with the entry it
matched would throw that shading away again. So keep's result can hold many values
— every shade the tolerance took in — but each one is a pixel of the source, and
everything else is `(0, 0, 0, 0)`. It is a decision, not a fade: there is no soft
band around the threshold.

**Nearness is by hue, saturation, brightness and opacity.** Each color is placed
in the HSB cone:

- hue is a direction round it;
- saturation is how far out from its middle;
- brightness is how high up it, with the cone narrowing to a point at black.

So hue counts exactly as much as a color has any. Two greys are never pushed
apart by the hue their rounding gives them, and a dark red is nearer black than a
bright red is. Opacity is measured beside the color. Black against white is 100,
and so is clear against solid.

**Snap takes the absolute nearest entry** by that measure. A half-faded red is
not the solid red entry at a tolerance of `0`, and a transparent pixel is nowhere
near black, whatever color numbers it carries.

A soft edge is always nearest **its own color**: a red edge pixel snaps to red
above half opacity and to clear below it, never to the orange beside it. Comparing
how colors *look* laid over black and white — the obvious alternative — got this
wrong: a half-transparent yellow over black is a dark olive, nearer green than
yellow, so every soft yellow edge snapped to a green fringe. `0` means the exact
palette value and nothing else, which is what flat artwork wants; anything
photographic needs room, because the same red is a hundred slightly different reds
once it has been through a camera and a JPEG.

**Transparent pixels.** In keep they stay transparent, written as `(0, 0, 0, 0)`.
In snap they snap like any other pixel, to the entry that looks most like nothing:
the palette's transparent entry, which the Color Palette flow adds for a picture
with transparent pixels. With no transparent entry in play, snap has to give them
one of the colors — that is what "only palette values" means — and the report
says how many it filled.

**There is no remove mode.** There used to be, and it was the keep mode with the
answer inverted. An inverted answer is a thing you already have: switch the color
off and keep the others.

**Exact on the way in and out.** A browser canvas stores every pixel multiplied by
its own opacity, so a half-transparent pixel read or written through one comes
back a step off — `#283cdc80` becomes `#283cdb80`. The editor therefore reads PNGs
and writes the result without a canvas (`png.ts`), and the server decodes the
upload and counts it: the report states how many distinct values the file holds,
and warns if a snapped result holds any value that is not a palette color. On a
test cut-out with soft edges, a glass pane and a junk-filled transparent
background, the previous version's snap left 68 values in the picture for a
five-entry palette; this one leaves 5.

Any palette color can be switched off, which is how you ask a narrow question of
a wide palette. The editor shows how many pixels landed on each.

## Reading a palette

The Color Palette flow's `palette.json` is the expected input, but the reader is
deliberately tolerant: a bare list of hex strings works, and so does a list of
objects with a `hex` on them. A palette written by hand or exported from another
tool should not need a converter. Anything unreadable is reported as unreadable
rather than treated as an empty palette.
