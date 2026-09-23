# Putting a drawing on a skeleton, and moving it

Two flows at the end of the vector chain: one binds a drawing to a rig, the
other moves it.

```
Skeletal Rig ──┐
               ├──▶ Rig Binding ──▶ Pose ──▶ pose.json / pose.svg
Vector ────────┘
```

---

# Rig Binding

`animation.bind` · takes a **Rig** and a **Vector** · gives **`bound.json`**, **`bound.svg`** and **`bound.md`**

## Bound by node, not by shape

A drawing is bound by its **nodes** — the points its shapes are drawn through —
and each node follows at most one bone.

Binding used to be by whole shape, and that stopped working once the
decomposition joined each region into one polygon: the whole of a skin-colored
arm and hand can be a single shape now, and a shape can only go one way. Bound by
its points it goes several — the points round the upper arm follow the upper arm,
the ones round the hand follow the hand — and when the rig moves, **each point
moves with its own bone**, so the polygon between them bends at the elbow instead
of having to be cut there first.

**A node is a place, not a point of one shape.** Neighbouring shapes share the
points along the boundary between them — that is how they fit — and two points in
the same place are one node, bound once. So posing can bend a boundary, but it
cannot give the two sides of one different bones and tear them apart.

A node bound to nothing **stays where it was drawn** when the rig moves, and a
shape with some points bound and some not stretches between them. The summary
counts both and the run warns about them: visible, and therefore fixable.

Each node follows one bone, fully. Blending a point between two bones by weight —
what a mesh would do at a joint — is not done: on an outline it produces a shape
that crosses itself the first time a joint goes past ninety degrees.

`bound.json` carries, for each shape, the bone each of its points follows in the
shape's own point order, so nothing downstream has to know how nodes are named. A
binding or a bound rig saved when binding was by shape opens with every point of
each shape on the bone that shape had, which moves exactly as it did.

## The two live in different spaces

A rig is about a hundred rig units tall and hangs around the origin. A drawing
is however many pixels wide the picture was. Taken in as they are, the skeleton
lands in a corner as a thin sliver and there is no bone to aim at — which makes
binding, the entire job of this flow, impossible to do.

So the rig is **scaled and centred onto the drawing** when it is taken in,
fitted by whichever dimension is tighter so it keeps its proportions.

That gets them roughly on top of each other, and roughly is where the useful
work starts. A skeleton has to line up with the shoulders and hips of *this*
drawing, and no automatic fit knows where those are — so each is then placed by
hand, and **separately**:

| Tool | What it moves |
| --- | --- |
| **Move drawing** | Drag the drawing under the skeleton; scroll to size it. |
| **Move skeleton** | Drag the whole skeleton over the drawing; scroll to size it. |
| **Move joint** | Drag any joint anywhere. What hangs off it comes along. |

Separately, because moving the drawing under a skeleton you have already
positioned is a different thing from moving the skeleton over a drawing you have
already framed, and wanting one is not wanting the other. Sizing the skeleton
scales every bone's offset, so the rig gets bigger rather than one bone getting
longer — the proportions are the rig's own and are not touched.

Both zoom **about the pointer**, so what is under it stays under it. Zooming
about the middle is the thing that makes a zoom control useless for lining
something up: every step towards the shoulder you are aiming at pushes it
further off the edge. *Drawing back* and *Skeleton back* put either of them
where it started, because a drag and a scroll can put something somewhere you
cannot see it.

The drawing goes downstream **where it was put**, and the frame grows to hold
it. A frame left at the old size clips a drawing that was zoomed up to meet a
big skeleton, and the posing flow would then show three quarters of a character
and no reason why.

## Only the part being worked on

A character is a hundred shapes and an arm is a few of them. Picking those out of
all of them at once is the thing that makes this flow feel impossible, so a shape
is drawn **as plainly as it belongs to the part being assigned to** — by the share
of its points in the part, so an arm polygon half on the upper arm is half there
when the upper arm is picked. A toggle hides what other parts have taken, which
leaves only what is still to do.

The nodes are drawn as dots **in their part's color**: the part being worked on
largest and outlined, other parts smaller, unbound nodes small and pale. The
shapes keep their own colors — recoloring them would hide the one thing you are
actually looking at, which is whether this really is the arm.

## Working

| Tool | What it does |
| --- | --- |
| **Add** | Brush over nodes to put them in this part. Drag to paint a run of them. |
| **Take out** | Brush over nodes to take them out of whatever part they are in. |
| **Area** | Click round a group of nodes. **Enter** puts every node inside into this part, Backspace undoes a point, Esc abandons it. |
| **Add bone** | Click where a new bone should end. It hangs off the selected one. |

The brush is a circle that follows the pointer, and its size is set **on screen**,
like the joints and handles: zooming in is how you get at a crowded joint, and a
brush that grew with the zoom would take in the same crowd however far in you
went.

Adding and taking away are separate tools rather than one tool with a modifier,
because binding a character is hundreds of clicks in a row and holding a key
down for half of them is not a thing anyone should be asked to do. Each tool does
its one thing on every click, and assigns straight away rather than making a
selection you then have to confirm.

An area takes in exactly the nodes inside it. A node is a point, so it is in or it
is not — which is what makes a lasso precise here in a way it could not be with
whole shapes, where one half in and half out had to be decided one way or the
other.

Deleting a bone re-hangs its children on its parent **where they already are**,
and moves its nodes there too. Deleting a bone should take that bone away, not
collapse everything below it onto the origin.

## The edits are the work

Like the vector editor, this flow writes what it holds rather than something
derived from its inputs. A binding is an afternoon, and an upstream re-run is
reported rather than allowed to throw it away.

---

# Pose

`animation.pose` · takes a **Bound rig** · gives **`pose.json`** and **`pose.svg`**

## Rest and posed have to agree about where the rig stands

A pose is a difference from rest, so the two have to be measured from the same
place. They were not: resting read the rig's origin — where it was put when it
was laid over the drawing — and posing walked from the coordinate origin
instead. An **empty** pose, with nothing turned at all, therefore moved the whole
drawing by that offset and threw the picture off the top-left corner. Which is
this flow "not working" in one line, and the test for it asserts the only thing
that could have caught it: posing nothing changes nothing.

## A pose is angles, not positions

One number a bone: how far it has turned from where it rests. Everything else —
where each bone ends up, and where the drawing goes with it — falls out of that
and the hierarchy.

Positions would be a drawing of one arrangement. Angles are the arrangement
itself: they survive the rig being edited underneath them, they interpolate
between two poses sensibly, and they cannot describe a skeleton that has come
apart.

## Two ways to move it

**Turn a joint** is forward kinematics, and it is what a skeleton is for: the
shoulder moves and the whole arm comes with it, because a bone's turn is added to
everything its parents have already done.

**Drag a tip** is inverse kinematics, and it is what a person means when they say
where they want a hand. The joints above it have to work out how to get there,
which is the harder question and the one worth having a solver for.

## How the solver works

Cyclic coordinate descent. Work back down the chain from the joint nearest the
tip: at each one, turn it so the tip points as near the target as that joint
alone can manage, clamp it to what the joint allows, and move on. Go round again
until it is close enough.

CCD rather than a Jacobian because joint limits are a *clamp* rather than a
constraint to solve around, the arithmetic is a few dot products, and a chain
that cannot reach settles gracefully stretched towards the target instead of
oscillating. For a character's arm — three or four bones with hard stops — it is
the right tool, and it is one that can be read.

**Its weak spot is a straight chain aimed at a target in line with it.** Every
joint's correction is then a fraction of a degree, because turning about a pivot
the tip is already pointing away from barely moves it; an arm hanging straight
down being asked to touch its own shoulder is exactly that case. So a stalled
solve is given a few degrees of bend to break the line, and converges from there.
The bend is fixed and alternating rather than random, so the same drag always
gives the same pose, and the best pose found is the one handed back — a nudge is
a guess, and a guess that made things worse is not kept.

A reach it cannot make **falls short and says so**, with how far out it was. That
is more useful than a limb stretched into a pose a body could not hold, and the
limits can be switched off when the question is whether it is the joints or the
length that is stopping you.

## Limits are the rig's

Read through the chain, so a bone in a tentacle obeys the chain's floppiness
rather than nothing at all. A poser that ignored that would let a rig fold in
ways the rig itself says it cannot — and the rig is where that decision belongs.
