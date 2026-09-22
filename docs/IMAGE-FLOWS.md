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

# Palette Filter

`art.palette.filter` · takes an **Image** and a **Palette** · gives **`filtered.png`** and **`filter.md`**

Three jobs in one flow, because they are the same measurement read three ways.

| Mode | What it does | What it is for |
| --- | --- | --- |
| **Keep** | Pixels near a palette color stay; the rest go transparent. | Finding where a color is used. |
| **Remove** | The other way round. | Dropping a background whose color you sampled. |
| **Snap** | Nothing goes transparent; every pixel becomes its nearest palette color. | Making a photograph look drawn. |

Keep and Remove are exact mirrors: filter an image against its own palette with
one color switched off, and the share Keep drops is the share Remove keeps.

**Snap has no tolerance**, and the editor stops offering one in that mode. Every
pixel has a nearest palette color; refusing to pick would leave a hole in an
image the mode promises not to put holes in.

**A pixel that is already transparent is left alone, in every mode.** This flow
takes the extraction flow's output as its input, and re-deciding pixels that were
deliberately cut away would undo that work.

Any palette color can be switched off, which is how you ask a narrow question of
a wide palette. The editor shows how many pixels landed on each.

Closeness uses the same OKLab scale as the palette's own minimum distance — see
[COLOR-PALETTE.md](COLOR-PALETTE.md) for why plain RGB cannot do this job.
**Softness** widens the threshold into a band where pixels are partly
transparent, which stops a filtered photograph looking cut out with scissors;
**hard alpha** forces the decision back to on or off, for sprites and anything
going to indexed color.

## Reading a palette

The Color Palette flow's `palette.json` is the expected input, but the reader is
deliberately tolerant: a bare list of hex strings works, and so does a list of
objects with a `hex` on them. A palette written by hand or exported from another
tool should not need a converter. Anything unreadable is reported as unreadable
rather than treated as an empty palette.
