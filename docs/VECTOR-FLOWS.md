# From pixels to shapes, and editing them

Two flows. The first turns a picture back into lines and polygons; the second is
where you fix what it got wrong.

```
Image ──▶ Polygon Decomposition ──▶ Vector Editor ──▶ vector.json / vector.svg
```

---

# Polygon Decomposition

`art.vectorize` · takes an **Image** · gives **`vector.json`**, **`vector.svg`** and **`vector.md`**

## Polygons first, then lines

The decomposition works in two passes, and the order is the whole idea.

**First, polygons — and only polygons.** Every region of the picture is drawn as
one polygon: its outline, with a **hole** wherever something else is inside it.
An eye in a face is a hole in the face, with the eye's own polygon filling it
exactly; a transparent gap in a shape is a hole with nothing in it. The polygons
tile the picture — nothing overlaps, and nothing is left uncovered but the
transparent parts.

**Then, skinny polygons become lines.** With everything filled in, a polygon that
is **skinny** — no wider than a stroke anywhere, and at least twice as long as it
is wide — is a drawn mark rather than an area, and is drawn again as a line down
its middle with its measured width. It does not matter what is beside it: the
smile on a face borders nothing but the face, and it is a line.

| Picture | What comes out |
| --- | --- |
| A yellow smiley with black eyes and a drawn smile | **Four shapes:** the face (one polygon, a hole for each eye), the two eyes, and the smile as one line. |
| A red box beside a blue box | **Two polygons, no line.** Neither is thin; the boundary between two colors is not a drawn mark. |
| The same, with a black stroke between them | **Two polygons and one line.** |
| A ring with nothing in the middle | **One polygon with a hole.** |

**A skinny polygon wholly inside one other is closed over.** The smile was a hole
in the face; with the smile drawn as a line, the hole is filled back in and the
line drawn on top, the way the picture was drawn — a line down the middle of a
band never covers its ragged edges exactly, and a hole left open would show
through along them. One on a boundary between several things keeps the room it
had, because there is no one of them it plainly belongs to.

A thin region is only a line if its middle is a line: one that measures wider than
a stroke down its centreline stays a polygon, and so does one whose lines would all
be shorter than **Shortest line** — a dot or a dash rather than a mark.

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
| Join shapes of the same color that touch | On by default: polygons of one color that meet become one, and lines whose ends meet become one. Off cuts every polygon into convex pieces, holes bridged. |
| Join line ends within | How close two line ends of one color must be to join, in pixels. |
| Nodes at least | The closest two nodes may be. Closer ones are merged, in every shape that shares them. |
| Smallest polygon | A smaller polygon is folded into the neighbour it shares most outline with; one touching nothing is dropped. |
| Shortest line | A skinny polygon whose lines would all be shorter stays a polygon; a stub off a longer line is dropped. |
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

A shape with nothing in the middle of it has nothing in the middle of it, and a
shape with something else in the middle has that something in the middle — not a
second copy of itself underneath.

Tracing a region gives the loop round its outside and a loop round each hole in
it, and the polygon keeps them all: `points` is the outline and `holes` the loops
inside it, filled **even-odd**. The hole is the same arc as the outline of what
fills it, so the two meet exactly. A picture made before holes existed reads back
unchanged: a polygon without `holes` has none.

### Nothing is drawn where the picture is not

Painting over a transparent part of the picture is weighted at **sixteen ordinary
wrong pixels**. A plain one-for-one count does not say it loudly enough: a boundary
spilling into the empty half of a picture is worth the same as a pixel a shade off,
and it is spread thin along a boundary, so it vanishes into a block average. Counted
properly, it is the first thing a round of refinement pulls back.

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

**Convex pieces**, only when joining is off, all on *indices* rather than on coordinates. A shape with a
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

## Shapes of one color that touch are one shape

Two regions can come out exactly the same color and touching — a flat area split
by a faint edge — and a stroke is traced as the runs of its middle between forks.
Both are right about the picture and wrong about the drawing, so once the picture
is in shapes, neighbours of the same color are put back together:

| | Joined when | Into |
| --- | --- | --- |
| **Polygons** | They meet — side by side, or one filling a hole in the other — and are exactly the same color. | One polygon, with the holes of both — unless it would touch itself or come apart in two. |
| **Lines** | An end of one is within **Join line ends within** of an end of the other, and they are exactly the same color. | One line, with a single point halfway between the two ends, so the gap between them is drawn. |

*Exactly the same color* means the same hex. Two shapes a shade apart are two
things in the picture, and joining them would paint one of them the wrong color.

**A shared side is found on exact coordinates.** Neighbours hold literally the
same points along the boundary between them — that is what makes them fit, above —
so a side one polygon walks from *a* to *b* is walked from *b* to *a* by its
neighbour. The union of two polygons is every side of every loop of both, outlines
wound one way and holes the other, less the sides they share, walked back into
loops: the one wound like an outline is the outline, the rest are holes. So a
shape that exactly fills a hole closes it, and one that fills part of it shrinks it.

**Where three line ends meet**, only two can join, and the two joined are the two
that carry on straightest — the angle between one line leaving and the other
arriving. That is how a fork reads as a line with a branch rather than as three
stubs. Each end is used once, and joining never closes a chain on itself: closing
a loop is a different decision from joining two lines.

### Convex, when you need it

Turn **Join shapes of the same color that touch** off and every polygon is cut
into convex pieces instead, each hole bridged to the outside first so the pieces
leave it empty. A convex polygon is trivially triangulated,
filled, offset and point-tested, which some consumers want. Nothing in the studio
needs it: hit-testing is even-odd, which works for any simple polygon, and the
editor's cut handles concave shapes (below).

## The smallest things

Three minimums, each applied so that it cannot open a gap between shapes or make
two overlap — the one thing the decomposition promises.

**Nodes at least** (default 1.5 px). Nodes closer than this along an outline or a
line are merged into one. The merge is decided on the nodes, not on any one shape:
where neighbours share a node, it moves for all of them, so they still meet
exactly. Shortest edges first, and only while the merged node stays within the
distance of every node it took in, so a curve drawn as a run of one-pixel steps is
thinned out rather than collapsed into a point. A node where three or more
outlines meet stays put and the other comes to it. It runs on the finished shapes
— merging earlier moved the outlines that decide which regions are skinny, and
cost twice the accuracy for the same saving.

**Smallest polygon** (default 6 px²). A smaller polygon is folded into the
neighbour it shares the most outline with, whatever that neighbour's color — it
becomes part of it, so there is no hole where it was; one sitting in a hole of a
bigger polygon closes that hole. Its size is what it covers, holes taken off. One that touches no other
polygon is dropped. Joining runs again afterwards, because folding a crumb away can
leave two shapes of one color touching where it used to part them. This is not the
same as **Drop regions under**, which works on pixels before anything is traced;
this works on the shapes that came out.

**Shortest line** (default 4 px, end to end). A skinny polygon's runs are joined
first, so a long line is not judged short for arriving in pieces; then one whose
lines are all still too short is a dash or a dot, and stays the polygon it was
drawn as so its ink is kept, and stubs shorter than this off a longer line — the
spurs thinning leaves at a corner — are dropped.

Measured on the same four pictures, the defaults cost the face and the cartoon
about 2% more pixels off for about 5% fewer points, and change a photograph
hardly at all. Turned up — 3 px, 20 px², 8 px — the photograph went from 161
polygons to 78 and came out *closer* to the picture, because the crumbs were
mostly wrong anyway.

**A region drawn in one color is that color exactly.** A region's pixels are its
flat inside and the band of blended pixels along its edge that it was handed, and
their average is a shade off — two regions of one red came out a hex digit apart,
so they were never joined, and a picture snapped to a palette did not come back in
the palette's colors. When one exact color is at least a quarter of a region, that
is the region's color; a shaded region, where no color repeats much, keeps its
average. On the cartoon, ten shape colors became the eight it was drawn in.

## How fast, and where the time goes

Measured with V8's profiler on four pictures — the 256-pixel face, an 800-pixel
cartoon, and a photograph-like test of smooth gradients and noise at 200 and 400
pixels — and every change below was checked to give **exactly the same shapes**
as before, point for point.

| Picture | Before | After |
| --- | --- | --- |
| Face, 256 × 256 | 0.54 s | 0.33 s |
| Cartoon, 800 × 800 | 3.0 s | 1.4 s |
| Photo-like, 200 × 200 | 57.6 s | 0.33 s |
| Photo-like, 400 × 400 | did not finish in 20 minutes | 3.6 s |

**Color conversion was a third of the time on drawings.** sRGB's curve is a
`pow`, asked for three times a pixel by every measurement, and the measure of the
finished drawing against the picture converted every source pixel again on every
round. The curve is now looked up — it has 256 possible answers — and the source
is converted once per decomposition and shared.

**Cutting regions into convex pieces was the cliff on photographs** (every region was cut then; now only with joining off). Ear clipping
tested every corner against every other corner and every edge, on every round:
cubic in the length of the outline, and a photographed region has an outline
hundreds of points long with holes bridged into it. 96% of the 200-pixel photo's
minute went there. Two things took it away, without changing a single triangle:

- **A quadtree** (the flat form of an octree) over the corners, the edges and each
  corner's ear, so "is any corner inside this ear" and "does anything cross this
  cut" are asked of what is nearby rather than of everything.
- **Remembering each corner's answer.** Clipping an ear changes the outline only
  inside that ear, so only corners whose own ear overlaps it can get a different
  answer; the rest keep theirs. An 800-corner outline went from 70 seconds to a
  quarter of one.

Bridging holes into a region was next, for the same reason: every pair of corners
sorted, and each candidate checked against every edge. It now takes candidates
shortest-first off a heap, checks them against a quadtree of the edges, and keeps
one index for the whole region, adding only each new bridge to it.

**A flat grid against the quadtree.** Both were built behind the same interface
and measured. On whole pictures they were the same to within the noise; on a
2,000-corner outline the quadtree was faster (3.1 s against 3.8 s), and it needs no
cell size tuned to the picture. The quadtree was kept.

**The GPU.** Only the per-pixel stages — color conversion, edge detection, and
measuring the drawing against the picture — are the kind of work a graphics card
does well, and after the changes above they are about a fifth of the time on a
drawing and less on a photograph. The rest is flood-filling regions, tracing their
outlines and cutting them up: sequential, geometric work a GPU does not speed up.
So even an infinitely fast GPU could save at most about a fifth, before paying to
move the pixels there and back — not worth a second implementation of each stage
to keep in step with the first.

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

A straight line can cross a **concave** polygon more than twice — across a C it
goes into one arm, out, and into the other. The cut is then the stretch of the
line inside the shape nearest the two clicks, which is the stretch you were
pointing at. Any such stretch divides a simple polygon into exactly two, so the
halves are always shapes.

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
