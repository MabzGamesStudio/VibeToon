# Face Parts

`animation.face` · takes **Heads** · gives **`face.json`**, a folder of faces and a folder of feature drawings

Finds the features of one or more heads. Each can then be put right, hidden,
looked at alone, nudged, or swapped for the same feature of another head.

```
Rig Parts ──────────┐
                    ├──▶ Face Parts ──▶ face.json, faces/, features/
Vector drawing ─────┘
```

## Heads in

Wire in any number of these:

- a [Rig Parts](RIG-PARTS.md) file, whose parts named *head*, *face* or *skull*
  are taken;
- a vector drawing (from a decomposition or the Vector Editor), which is taken
  as one head.

Press **Take them in**. If a parts file has no part called a head, or you want
another part too, choose it under **Add a part as a head**. Taking them in again
finds the features afresh but keeps what was set (hidden, swapped, nudged).

## How the features are found

Each shape is placed on the face: across it from left to right, down it from
top to chin, and sized against it. Then, in order:

1. **Face.** The big shape the others sit on. Of the polygons at least a third
   the size of the largest, it is the lowest: hair is big too, but it sits
   above.
2. **Hair.** A sizeable shape in a color other than the face's that does any of
   these:
   - reaches the top of the head;
   - reaches out above or beside the face;
   - lies across the upper face as a fringe (a band wider than any one eyebrow
     could be).
3. **Ears.** At the face's sides, halfway down.
4. **Eyes.** The best-matched pair across the upper face: alike in size and
   color, level, mirrored about the middle, and not long and thin (that is an
   eyebrow). A shape inside an eye, such as a pupil or a highlight, goes with
   that eye.
5. **Eyebrows.** Above each eye, wider than tall.
6. **Mouth.** In the middle below the eyes: the widest thing there that is
   wider than tall, with what is inside it (teeth, a tongue).
7. **Nose.** In the middle, between the eyes and the mouth.

Anything that fits none of these is left as no feature. Left and right are as
seen: the left eye is the one on the left of the picture.

On a cartoon head with every feature (a face, hair, ears, eyebrows, eyes with
pupils, a nose, a mouth with teeth), all 13 shapes are found correctly, wherever
the head is and however big. On a bound body's head part, the face, hair band,
eyes and mouth are found. With the eyes taken out, the eyebrows are still
eyebrows.

## Putting it right

**Features** view outlines every shape in its feature's color. Pick a feature
under **Give a shape to**, then click shapes to give them to it; **None** takes a
shape out of every feature. **Find the features again** forgets what was given by
hand.

**Edit shapes** view has every tool of the Vector Editor, for the head's own
shapes: cut a shape that is two features in two, delete a stray node, or draw
what is missing.

## Each feature

| Control | What it does |
| --- | --- |
| **Hide** | Leaves it out of the face. |
| **Alone** | Shows only it, in every view. |
| **Swap** | Draws it with the same kind of feature from another head, or this head's other side (a left eye from a right). The swapped-in feature is fitted to where this head's own was: the same middle, sized to match. Where this head had none, it goes where it sat on its own face. |
| Click its name | Nudges it across and down, and sizes it about its middle. **Back where it was** undoes the nudge. |

**Result** view shows the face as it comes out.

Every change is one undo step. The head in view, what is shown alone, and the
feature being given are not.

## What comes out

`face.json`:

```json
{
  "kind": "faceParts",
  "version": 1,
  "heads": [
    {
      "id": "flow_parts:head",
      "name": "Head",
      "width": 400,
      "height": 400,
      "features": [
        {
          "id": "eye-left",
          "kind": "eye",
          "label": "Left eye",
          "hidden": false,
          "swappedFrom": { "head": "flow_cartoon", "feature": "eye-left" },
          "bounds": { "x": 187, "y": 34, "width": 7, "height": 6 },
          "shapes": []
        }
      ],
      "other": []
    }
  ]
}
```

- **Features.** Each feature's `shapes` are as set: empty when hidden, swapped
  ones fitted in, nudges applied. A swapped-in shape's id is prefixed with the
  head it came from and `~`, so it never collides with this head's own.
- **`other`.** The shapes that are no feature.
- **`faces/`** holds each head put back together, as an SVG.
- **`features/`** holds one SVG per feature of each head (`head-mouth.svg`). A
  hidden feature has none.
