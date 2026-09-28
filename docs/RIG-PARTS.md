# Rig Parts

`animation.parts` · takes a **Bound rig** · gives **`parts.json`**, **`parts.svg`** and a folder of part drawings

Takes a bound drawing apart into its body parts, so each part can be looked at
and edited on its own.

```
Skeletal Rig ──┐
               ├──▶ Rig Binding ──▶ Rig Parts ──▶ parts.json ──▶ Face Parts
Vector ────────┘
```

## How the drawing is divided

A binding says which bone every point of the drawing follows. Every shape goes
to the part whose bone carries **most of its points**.

- A shape that bends across a joint (a sleeve over an elbow, say) goes to the
  bone that carries most of it.
- A shape bound to nothing goes to **Not bound**.
- The parts come in the rig's own order. Each part keeps its shapes' ids and
  their place in the drawing's order, so a shape drawn over another still is.
- Every part is at the whole drawing's size, so the parts lie back over one
  another exactly.

## Working

- **The parts list** shows each part as a small drawing, with how many shapes
  it has. Click one to work on it.
- **Frame this part** (on the stage) fits the view to the part. Turn it off to
  see it where it sits in the whole drawing.
- **Show the other parts, faded** puts the rest of the body behind the part,
  for context. Turn it off to see the part alone.
- **Editing.** Every tool of the Vector Editor works here, on the part in view:

  | Tool | What it does |
  | --- | --- |
  | **Move** | Drag a node. |
  | **Move shape** | Drag a whole shape, or several. |
  | **Add point** | Add a node on an edge. |
  | **Draw shape** | Draw a new filled shape or line. |
  | **Cut** | Cut a shape in two. |
  | **Delete part** | Delete a run of a line. |
  | **Delete node** | Delete a node. |
  | **Curves** | Curve a node. |
  | **Smooth brush** | Average or curve nodes by brushing over them. |

  A selected shape's color (and a line's width) can be changed, and **Delete**
  removes it.
- **Belongs to** sends the selected shapes to another part, including a bone
  that had none.
- **Split it again** starts over from the binding, replacing the edits. A
  changed binding upstream is reported, not taken in on its own.

Every change is one undo step. The part in view, and what is shown, are not.

## What comes out

`parts.json`:

```json
{
  "kind": "rigParts",
  "version": 1,
  "width": 400,
  "height": 400,
  "parts": [
    {
      "id": "head",
      "name": "Head",
      "parent": "neck",
      "joint": { "from": { "x": 200, "y": 86 }, "to": { "x": 200, "y": -2 } },
      "bounds": { "x": 176, "y": -2, "width": 48, "height": 88 },
      "image": { "width": 400, "height": 400, "shapes": [] }
    }
  ]
}
```

- **Joint.** `joint` is where the part's bone lies at rest, in the drawing's
  coordinates. It is null for **Not bound**.
- **`parts.svg`** is all the parts together, as edited.
- **The `parts/` folder** holds one SVG per part, named after it
  (`left-upper-arm.svg`).

The [Face Parts](FACE-PARTS.md) flow reads `parts.json` and takes its head parts.
