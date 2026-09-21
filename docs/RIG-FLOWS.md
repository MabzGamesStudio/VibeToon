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
fitted by whichever dimension is tighter so it keeps its proportions. Only where
it sits and how big it is are changed; the skeleton's own shape is the rig
flow's business.

## Working

| Tool | What it does |
| --- | --- |
| **Pick** | Click a shape to select it; shift-click to add to the selection. |
| **Region** | Draw round a group and take them all. Double-click to close it. |
| **Add bone** | Click where a new bone should end. It hangs off the selected one. |

A region takes in every shape whose **middle** falls inside it, not every shape
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
