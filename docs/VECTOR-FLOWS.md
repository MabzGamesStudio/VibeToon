# From pixels to shapes, and editing them

Two flows. The first turns a picture back into lines and polygons; the second is
where you fix what it got wrong.

```
Image ──▶ Polygon Decomposition ──▶ Vector Editor ──▶ vector.json / vector.svg
```

---

# Polygon Decomposition

`art.vectorize` · takes an **Image** · gives **`vector.json`**, **`vector.svg`** and **`vector.md`**

## What counts as a line

This is the whole idea, and it is a rule with two halves that both matter.

A **line** is a region that is **thin** *and* has **different things on either
side of it**.

Thin alone is not enough: a long thin rectangle of solid color sitting on its
own is a shape, not a stroke. Separating alone is not enough either, because
every region separates its neighbours from each other in some sense.

The example the flow is built around:

| Picture | What comes out |
| --- | --- |
| A red box beside a blue box | **Two areas, no line.** The boundary between two colors is not a drawn mark. |
| The same, with a black stroke between them | **One line and two areas.** The black is thin, with red one side and blue the other. |

Transparency counts as one of the things a stroke can have on a side, so a black
outline round a shape on a transparent background is a line: ink one side,
nothing the other.

## The one setting that decides what the picture is

**Widest a stroke may be.** Below it a thin shape is a mark with a middle; above
it the same shape is a long thin area with an inside. There is no right answer in
general — it depends how the picture was drawn — so it is a number you turn while
watching the result.

On the test picture in `docs/`, at 4px the flow finds 5 lines and 11 polygons; at
1px it finds 0 lines and 23 polygons, because every stroke has become an area.

The other settings are about where the boundaries are and how heavy the result is:

| Setting | What it does |
| --- | --- |
| Contrast that counts | How steeply the picture must change to be a boundary, in the OKLab-times-100 scale. |
| …and to keep one going | The weaker threshold, which keeps a boundary unbroken where it softens. |
| Drop regions under | The noise floor, in pixels. Smaller regions are folded into a neighbour. |
| Simplify to within | How far a boundary may move to lose a point. The main control over how heavy the result is. |
| At most, per shape | A hard point budget, for when a tolerance alone will not promise one. |
| Curved if bent by | How bent a run must be, relative to its length, to be a curve. |
| Rounds of refinement | How many times to measure the result and do the worst part better. See below. |

## Boundaries first, and the fill between them

The version before this one grew regions by **color tolerance**: flood outwards
while each pixel is near enough the one the fill started from. That asks a
question with no good answer. Set it low and a face shaded across twenty tones
becomes two hundred regions; set it high and the fill walks through the outline
into the background. There is no value in between, because the amount a region
varies *inside itself* is unrelated to how much it differs from its neighbour.

So the boundaries are found first, in one pass, and the regions are whatever they
enclose. Nothing is measured against a starting pixel, so shading is free.

**Canny, on OKLab.** The gradient has to mean "how different does this look": in
RGB a boundary between two blues reads as steeper than one between two greens
plainly further apart, so one threshold could not serve a whole picture. The
ridges are thinned to one pixel, because a gradient is several pixels wide and a
boundary is a line — a fat boundary eats the regions either side of it. Then the
weak parts of strong boundaries are joined back on, because a boundary that fades
for a pixel and comes back is still one boundary, and a one-pixel gap is all it
takes for two regions to bleed into one.

**The fill also stops at a plain step** from one pixel to the next, at that same
threshold. Both barriers are needed and each covers what the other misses:

- The edge map catches a **soft** boundary. An anti-aliased outline is a run of
  small steps and the step test walks straight through it; the gradient over three
  pixels sees it plainly.
- The step test catches a **thin bar**. Canny finds a *step*, and a one-pixel line
  between two colors is not two steps three pixels apart — it is a single ridge,
  thinned to whichever side happened to be steeper. Take the ridge out and the
  line has nothing left to defend it. This matters because a one-pixel line
  between two colors is the example the whole flow is built around.

**The boundary pixels are then handed back.** They were never nothing: a stroke
three pixels wide has boundaries down both sides and only its middle survives the
edge pass, so a region built from the gaps alone is a third of the ink. Each goes
to whichever neighbouring region its own color is nearest — **unless it is further
from every neighbour than they are from each other**. That exception is the part
that took finding. Nearest-of-its-neighbours alone always has an answer, so a
black ring whose every pixel reads as a boundary is handed to the red it encloses:
the outline becomes more red and the drawing loses its lines. A pixel half way
between two colors is their boundary and is claimed; black between red and blue is
further from both than they are from one another, and is left to become a region of
its own.

**Whatever is left over becomes a region too.** A shape thin enough that *every*
one of its pixels is a boundary gets no seed from the fill and no neighbour it
looks like, so without a final pass for the leftovers it belongs to nothing and
silently disappears. A two-pixel sliver, and the black ring above, are both
exactly that.

## The shapes fit together

The areas are a **partition** of the picture. Every pixel that is drawn belongs to
exactly one of them, and no pixel belongs to two.

That is not tidiness. Shapes that overlap only look right because they are painted
in an order that hides the seams under each other, and everything downstream pays
for it: a rig cannot bind to a shape whose extent depends on what is painted after
it, an editor cannot cut one without leaving a hole, and a pose that moves one
shape and not its neighbour tears the drawing open.

### One boundary, traced once

It holds because **every boundary in the picture is traced and simplified once**,
and used by the shapes either side of it in opposite directions. They cannot
overlap, because the shared edge is literally the same list of numbers; they
cannot gap, for the same reason; and the drawing costs fewer points than before,
because a boundary that used to be simplified twice is now paid for once.

The picture's boundaries are cut into **arcs**, each running from one junction —
where three or more regions meet — to the next. A junction is the one thing
simplifying may never move: pull one and the three shapes meeting there come
apart.

### A hole is a hole

A shape with nothing in the middle of it has nothing in the middle of it.

Tracing an outline gives the boundary round the outside, and filling that gives a
disc. For a black ring round a face that was *almost* right — the face is painted
over the middle afterwards and only the rim shows — and for a ring with
transparency in the middle it was plainly wrong: a washer came out as a coin. Now
each hole is cut out with a **bridge**, a slit from the hole to the outside walked
down one side and back up the other, so the ring stays one closed loop with a
genuinely empty middle.

### Nothing is drawn where the picture is not

Painting over a transparent part of the picture is weighted at **sixteen ordinary
wrong pixels**. A plain one-for-one count does not say it loudly enough: a boundary
spilling into the empty half of a picture is worth the same as a pixel a shade off,
and it is spread thin along a boundary, so it vanishes into a block average. Counted
properly, it is the first thing a round of refinement pulls back.

### A piece thinner than a stroke is a stroke — if it covers the same ink

A sliver of polygon is a mark with a width pretending to be an area: three or more
anchors to say what two and a width say better, and miserable to grab hold of.
Measured across its narrowest direction, which for a triangle is its shortest
altitude.

But a sliver is also what a convex cut leaves along any curve, and *that* kind has
to stay a polygon — it is part of the partition, and a stroke is not, so swapping
one in opens a seam down both of its long sides. On a finely traced boundary there
are dozens: measured, it took a drawing from 825 wrong pixels to 1034. So the swap
is measured rather than assumed. A real thin limb is covered better by a stroke
than by the splinters it was cut into; a splinter of a curve is not, and keeps its
place.

## Rounds of refinement: measure, then fix the worst part

Rasterise what has been drawn, take the difference from the picture it came from,
and average that over a grid of blocks. A block's average is the honest measure of
"how bad is it around here" — one wrong pixel is noise, a whole block wrong is a
shape in the wrong place — and the worst blocks are where more anchors buy
something. Everywhere else keeps the loose tolerance, which is the whole reason it
is affordable.

Three things had to be right for that to work at all, and each was wrong first:

- **Both the tolerance and the budget.** Either alone does nothing. A tolerance
  cannot buy detail the budget will not pay for, and a bigger budget buys nothing
  while the tolerance says there is nothing worth keeping. Granting one and not
  the other came back with the identical drawing.
- **Point by point, not boundary by boundary.** An arc runs from junction to
  junction and can be the whole outline of a head. Tightening the arc spends
  anchors along every part of it that was already exact, blows the budget, and the
  budget loosens the lot back again — so asking for a closer fit produced a *worse*
  drawing.
- **The smallest tolerance that fits the budget, found by bisection.** Doubling
  until it fits overshoots, and a boundary needing twenty-one points at 0.45 lands
  at 4.7 while the boundary beside it stays sharp. Measured, asking for more points
  came back with more error than asking for fewer — which is not a thing a setting
  should ever do.

A round is kept only if it is actually better, so more rounds never make a drawing
worse, only slower. A block also has to be **twice as wrong as the picture's own
average** to count, or a drawing that is already good has a fifth of itself marked
as a hotspot and the next round spends anchors all over it for nothing.

## The fit this replaced

Simplifying a traced outline by a tolerance asks a slightly wrong question. "Is
this anchor within 1.2px of the traced path" says nothing about whether the shape
that comes out **covers the color it stands for**; a corner cut off a square is
well within any tolerance and leaves a wedge of the picture unpainted.

Measuring it properly answers that, and costs. Every candidate is drawn and
compared with the pixels it is meant to be:

- **missed** — pixels of this color the shape failed to cover.
- **extra** — pixels it covers that are not this color.

Both are wrong in the same way and count the same. Against that sits what the
shape costs: every anchor and every polygon is worth something, or the best
answer is always to trace each pixel exactly. **Those two prices are settings** —
at an anchor worth 6 pixels, an anchor earns its place by covering six pixels no
cheaper shape would. Set them to nothing for an exact trace, or high for a few
loose shapes.

On a test drawing, the same picture comes out at 1.6% of pixels wrong with 65
anchors, 1.9% with 55, or 2.2% with 53, as those prices move.

That fit is **gone**, and the rounds of refinement above replace it. It could not
survive shared boundaries: re-simplifying one region's outline on its own is
exactly what the arcs exist to stop, and a fit that moves a boundary for one shape
and not its neighbour is an overlap by another name. Measuring the whole drawing
once a round and spending the next round's anchors on the worst part of it answers
the same question, keeps the partition, and costs a fraction as much.

### A shape is not charged for what covers it

Areas are painted biggest first and strokes last, the way the picture was made,
and a shape is not judged on pixels that something painted **after** it will
cover.

That is not a leniency, it is what the picture does. Without it every enclosing
shape is punished for the things standing on it: a background is "wrong"
everywhere the subject is, and the fit responds by eating the background away
from its neighbours — which leaves real gaps, because the thing it was
overlapping was going to cover that seam. It is also what lets an area run
*under* a stroke instead of stopping at its edge, so a stroke narrower than the
gap it was traced from no longer leaves a hairline of background showing through.

### Strokes widen until they fill the gap

A stroke's width is searched from thin upwards and the best one kept. The width
that leaves fewest wrong pixels **is** the width of the contrast gap, found by
measuring rather than estimated from area over length — which is off wherever a
stroke branches, and every crossing is a branch. Then each end is pushed outwards
while pushing keeps helping, because thinning ate them.

Three things had to be right for that to work at all:

- **Coverage is fractional.** A band two units wide over three pixels of ink
  paints the middle one fully and each outer one half. Thresholded at "more than
  half covered" that is indistinguishable from a band three wide, so the search
  reports 2 where the ink is 3 and every line comes out a third too thin.
- **Crossing strokes divide the ink between them.** Strokes that touch are one
  region, and scoring each against all of it makes the others read as ink this
  one failed to cover — a weight that swamps the thing being measured. Each pixel
  goes to the path it lies nearest.
- **The search runs past the limit.** Capping it at the maximum line width would
  make the "is this a stroke" test vacuous: the answer could never exceed the
  threshold it is compared against. Asking what width the ink *wants*, and then
  checking that against the limit, is a question with two possible answers.

## How it works

**Regions.** Boundaries, then the fill between them, then the boundary pixels
handed back, then the leftovers — as above.

**Convex pieces**, all on *indices* rather than on coordinates. A shape with a
hole bridged into it holds the same point twice, and every test — is this corner
one of the ear's own, do these two pieces share this edge — comes out wrong when
asked by position: the other copy answers yes, and clipping stalls with a sixth of
the shape still on the floor while a merge joins across the wrong seam and loses a
bite out of the middle. Ear clipping picks the **fattest** ear rather than the
first, which leaves almost no splinters, and every merge is checked by area,
because areas add when a join is real.

**Thickness.** Each region's thickest point, by distance transform. That decides
which regions are worth measuring properly; the real width is taken afterwards
from **area over length**, because the distance transform is out by a pixel on
every even width — a two-wide stroke has no pixel more than half a pixel from its
edge, so the transform calls it one.

**Outlines** are traced on pixel *corners*, so they land on the edge of the shape
rather than half a pixel inside it. **Centrelines** come from Zhang-Suen thinning,
walked end to end. Thinning eats the ends of a stroke — an endpoint has nothing
behind it to protect it — so each open end is pushed back out to where the ink
actually stops.

A diagonal link in the skeleton is ignored when the two pixels are already joined
the long way round. Without that rule the outside corner of any rectangle looks
like a junction, and a perfectly good closed outline shatters into one path per
corner.

**Fitting** simplifies with Ramer-Douglas-Peucker, then decides straight or curved
by how far the run departs from the straight line between its ends *relative to
its length* — a 2px bow across 10px is a curve, and the same bow across 400px is a
straight line someone drew by hand.

An outline is a **ring**, and running open RDP round one gets it wrong twice. The
baseline it starts from joins the first point to the last, which on a ring are
neighbours, so every point is measured against a one-pixel chord that means
nothing; and whichever corner the trace happened to stop on is pinned while the
corner beside it is free to go. A square came out as a triangle. The ring is split
at the point farthest from the start instead, giving two open halves that between
them cover it, each with a baseline the length of the shape.

A tolerance alone cannot promise a **point budget** — one fiddly outline will
always find a way to spend forty — so a shape over budget is simplified harder
until it fits, which loosens the shapes that need loosening and leaves the rest
alone. In the other direction, a shape can be smaller than the tolerance: a
two-pixel square has no corner more than a pixel and a half off its own diagonal,
so a pixel and a half of slack flattens it into a line. It keeps enough points to
still be a shape. Losing detail is the deal; losing the shape is not.

**Hertel-Mehlhorn.** The triangles are glued back together by rubbing out every cut
that was not earning its place: a cut can go whenever the shape left behind is
still convex, and only the two corners the cut ended at can have stopped being so.
Triangles alone would satisfy "convex" and give ten times the shapes, which is
worse to edit and worse to read.

## Why convex

A polygon here is always convex, because that is what everything downstream can
rely on. A convex polygon is trivially triangulated, filled, offset and
point-tested, and never has the self-intersections that make a concave one a
special case in every renderer that meets it.

Editing can break that, and when it does the flow says so rather than letting a
consumer find out.

## What a line stores

The **anchors**, plus whether the run between them is smoothed — not cubic
control points.

Storing the cubics directly is what an SVG does and it makes editing miserable:
dragging one point means fixing up four numbers on each side to keep the curve
continuous, and adding a point in the middle of a curve means solving for a split.

Nothing is lost. The written SVG holds real cubic Béziers, converted exactly: a
centripetal Catmull-Rom segment *is* a cubic with control points at
`p1 ± (p2 - p0) / 6`, so the curve in the file is the curve the editor drew rather
than a fit to it.

---

# Vector Editor

`art.vector.edit` · takes a **Vector** · gives **`vector.json`** and **`vector.svg`**

A decomposition is a starting guess. It gets the shapes roughly right and puts
points where the pixels changed rather than where the drawing turns. This is
where that gets fixed.

| Tool | What it does |
| --- | --- |
| **Move** | Drag an anchor. Click a shape to select it; right-click an anchor to delete just that one. |
| **Add point** | Click an edge to put a new anchor there — where you pointed, not at the midpoint. |
| **Cut** | Click across a shape to cut it in two. A line is cut where you click once. |
| **Delete part** | Click two anchors on a shape to delete the run between them. |

`Delete` removes whatever is selected. `Esc` abandons a half-finished cut.

Clicking the middle of a filled shape selects it, not just its outline —
otherwise a big polygon could only be picked up by a thin target around a large
object.

A cut is **extended past both clicks** before anything is intersected. Two clicks
across a shape are almost never exactly on its outline, and a segment lying wholly
inside a polygon crosses none of its edges; taken literally that is "not a cut",
so the gesture would do nothing for a reason invisible on screen.

Cutting a line gives two lines that still meet at the cut, rather than a gap.
Cutting a **closed** line opens it instead, because that is what cutting a loop
once does. Taking a bite out of the middle of a line leaves two pieces; taking one
off an end just shortens it. A loop with a bite out of it becomes a line, because
it is not a loop any more.

## The edits are the work

Everything else in this studio derives its output from its input. This flow does
not: what it writes **is** its input with the edits on top.

That is deliberate. Losing an afternoon's work because somebody re-ran the
decomposition upstream would make the flow not worth using, so an upstream change
is reported and the edits are kept until you say otherwise. **Take it in again**
is how you say otherwise, and it says what it will replace.
