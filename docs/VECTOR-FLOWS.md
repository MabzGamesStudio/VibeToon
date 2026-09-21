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

The other settings are about grouping and tidiness:

| Setting | What it does |
| --- | --- |
| Same-color tolerance | How different two neighbouring pixels may be and still be one region. |
| Color precision | Rounding applied before anything is grouped. |
| Drop regions under | The noise floor, in pixels. |
| Simplify to within | How far an outline may move to lose a point. |
| Curved if bent by | How bent a run must be, relative to its length, to be a curve. |

## How it works

**Regions.** Pixels flood into regions of one color. A candidate is compared
against the **seed** color rather than its neighbour's — comparing neighbour to
neighbour walks a gradient across the whole picture one indistinguishable step at
a time, and would make one region of everything.

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

**Convex pieces.** An area is ear-clipped to triangles and then glued back
together wherever the join stays convex. Triangles alone would satisfy "convex"
and give ten times the shapes, which is worse to edit and worse to read.

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
