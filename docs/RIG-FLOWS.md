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

## One shape, one bone

Every shape belongs to at most one bone.

A shape belonging to two would have to be torn between them when they move
apart, and tearing is something only a mesh can do — these are outlines, and an
outline has to go somewhere whole. Where a drawing really does need to bend
across a joint, cut the shape in the vector editor and bind the halves
separately. That is a deliberate limit rather than a missing feature: the
alternative is a weighting scheme, and weights on an outline produce a shape
that crosses itself the first time a joint goes past ninety degrees.

A shape bound to nothing **stays where it was drawn** when the rig moves. That
is visible, and therefore fixable. Dropping it silently would not be.

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

A character is a hundred shapes and an arm is four of them. Picking those four
out of all of them at once is the thing that makes this flow feel impossible, so
the drawing is **faded back except the part being assigned to**. Shapes another
part has already taken fade further; a toggle hides them entirely, which leaves
only what is still to do.

Shapes keep their own colors and wear the part's color round the edge. Recoloring
an assigned shape tells you which part it is in and hides the one thing you are
actually looking at — whether this really is the arm.

## Working

| Tool | What it does |
| --- | --- |
| **Add** | Click a shape to put it in this part. Dragging runs across several. |
| **Take out** | Click a shape to take it out of whatever it is in. |
| **Area** | Click round a group of shapes. **Enter** finishes it, Backspace undoes a point, Esc abandons it. |
| **Add bone** | Click where a new bone should end. It hangs off the selected one. |

Adding and taking away are separate tools rather than one tool with a modifier,
because binding a character is hundreds of clicks in a row and holding a key
down for half of them is not a thing anyone should be asked to do. Each tool does
its one thing on every click, and assigns straight away rather than making a
selection you then have to confirm.

An area takes in every shape whose **middle** falls inside it, not every shape
wholly enclosed. Asking someone to lasso an outline exactly is asking them to do
the binding twice.

Deleting a bone re-hangs its children on its parent **where they already are**,
and moves its shapes there too. Deleting a bone should take that bone away, not
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
