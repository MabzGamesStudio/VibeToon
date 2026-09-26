# Rig Match

`animation.match` · takes a **Bound rig** and a **Picture** · gives **`match.json`**, **`fitted.json`**, **`fitted.svg`** and **`overlay.png`**

Finds a bound rig's body in a picture. The body is placed, sized and turned to
where it is in the picture, then each part is turned and sized to match, and
every part gets a confidence. Anything can then be put right by hand.

```
Skeletal Rig ──┐
               ├──▶ Rig Binding ──┐
Vector ────────┘                  ├──▶ Rig Match ──▶ fitted.json ──▶ Pose
Picture ──────────────────────────┘
```

A **bound rig** is a body: a skeleton with a drawing whose every point follows a
bone. The picture is anything the same character appears in — another drawing
of them, a frame, a reference.

## How it finds the body

1. **The body's features.** The drawing is painted at rest, and each body part
   gives small square patches of itself. *Features per part* sets how many,
   scaled by the square root of how big the part is: a chest gives more than a
   hand, and a part hidden under others gives none. They are picked where there
   is most to see (edges, markings, the outline) and spread apart.
2. **The picture's features.** Patches are taken all over the picture, each at a
   range of sizes (*Range in size*: from 1/×R to ×R the size the body was first
   guessed at) and turned through a range of angles (*Range in angle*: ±A
   degrees, every 15°). A leaning or larger body is still found.
3. **Comparing.** Every patch becomes an **embedding**: for each cell of a 4 × 4
   grid, its color in OKLab, how much of it is covered, and how much edge it
   has. Two patches are alike as far as those numbers are.
   - **Only the part's own pixels.** A body patch is compared only where its own
     part is. The rest of the patch is other parts, which will be elsewhere once
     the body has moved: a patch of shin taken at rest has the other shin beside
     it.
   - **Edges on the patch's grid.** Edges are measured between the patch's own
     samples, which are read from a pyramid of the picture at the right size.
     So an outline looks the same whatever size the body is drawn at.
4. **Placing the body.** Each good match says where the whole body would be
   (this patch of chest found *here*, this big, turned this far), and each
   placement is scored by how many other matches agree with it. The best few are
   refined by least squares on the agreeing features' positions, which puts them
   between the 15° and size steps. They are then judged on every feature's
   likeness, using the best-matching 60% so a raised arm cannot drag the trunk
   off.
5. **Fitting each part.** From the root down, each part is turned (inside its
   joint's range of motion, when *Keep to each joint's range* is on) and sized
   (up to √R bigger or smaller) to where its own features match best.
   - **Parts below it count too.** The next parts down count at less weight, so
     a neck with nothing of its own to see is placed by where it carries the
     head.
   - **Passes.** One sweep of every allowed angle, then two closer passes. The
     body's placement is tightened after the sweep and again once every part is
     placed.
   - **Counter-turns.** A joint can be turned while the parts below it are
     turned back the same amount. That moves them without turning them, the way
     out of a turn shared wrongly between a neck and a head.
6. **Confidence.** Each feature's likeness where it ended up counts only as far
   as it beats that feature's likeness to the picture at large:
   `(here − anywhere) / (1 − anywhere)`. A plain patch of skin looks like a good
   deal of any picture of that person, so finding it is weak evidence; one with
   an eye in it looks like nothing else. A part's confidence is its features';
   the body's is the parts', weighted by size. 70% and up is *strong*, 45% *fair*,
   20% *weak*, below that *not found*.

The same body, picture and settings always give the same fit.

The match runs in a Web Worker, reporting its stage as it goes, and takes a few
seconds. The picture is worked on at most 384 pixels across, and the body is
painted 256 across. Tested on a painted character in known poses, the match
recovers the placement within a few pixels and a degree or two, and every joint
within a few pixels on a body about 300 pixels tall.

## Settings

| Setting | What it does |
| --- | --- |
| Features per part | How many patches each part gives. More is steadier and slower. |
| Range in size | How far the picture's patches range in size around the first guess, and so how much bigger or smaller the body may be found. Its square root bounds how much one part may grow or shrink against the rest. |
| Range in angle | How far the picture's patches are turned, and so how far the body may lean and each part turn against its parent. |
| Keep to each joint's range of motion | Parts stay inside the rig's own limits. |

The first guess fills the picture with the body, or covers what is not
transparent in a cut-out. For a small figure in a wide scene, place it roughly
by hand first and press **Refine from here**: the placement is then searched for
only near where it is.

## Adjusting by hand

- **Joints**: drag a joint to turn its part to point there and size it to reach.
  Everything below comes along. Dragging the root's joint moves the whole body.
  Click a part, on the picture or in the confidence list, to turn or size it
  with sliders, or put it back as drawn.
- **Whole body**: drag to move it, drag the corner square to size it, drag the
  round handle to turn it. There is also a turn slider and a size box.
- **Show**: the body (with how solidly it is drawn), the skeleton (colored by
  confidence), and the features as dots colored by confidence. A selected part
  also shows the patch each of its features compared.
- A fit changed by hand is marked as such; **Measure this pose** scores it
  again, against the same background as the match.

Every change here can be undone (Ctrl+Z), and what is shown (the body, the
skeleton, the features) is left as it is by undo.

## What comes out

- `match.json`: the picture's size, the placement (`x`, `y`, `scale`,
  `rotation`, `pivot`), the pose (each bone's own turn, as a Pose flow stores
  it), each part's size, and for each part its angle, size, where its ends are
  in the picture, and its confidence. It also says whether the confidences
  describe this fit or one since adjusted by hand.
- `fitted.json`: the bound rig re-made in the picture. Its bones are measured
  from the fitted pose, its drawing moved into the picture's frame, its binding
  unchanged. Wired into a **Pose** flow, its rest pose *is* the match, so posing
  carries on from here.
- `fitted.svg`: the drawing in the matched pose, the picture's size.
- `overlay.png`: the picture with the body over it and the skeleton on top.
  Drawn only when the picture is a PNG; for any other format a note says so.
