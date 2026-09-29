# Batches

Many items going through the same flow side by side: a video's ten shots each
through Video Background, giving ten backgrounds; a rig's bones each through
Line Detection.

```
Video ──▶ Shot Split ══×10══▶ Video Background ══×10══▶ Line Detection
                 (Shot clips)          │
                                       └══10→1══▶ Animatic (Panel images)
```

A batch is **one wire**, drawn as a bundle of strands with how many items it
carries. It is made and removed like any other wire, has one set of rules and
settings, and is one undo step. Behind it, each item goes its own way.

## Where batches come from

A batch starts at a **folder** — an output that is a set of images, videos or
sounds. Each file in it is one item.

| Flow | Output | Items |
| --- | --- | --- |
| Shot Split | Shot clips | Each shot as a video, with **Each shot as a video of its own** ticked. |
| Video Edit | Clips | Each kept segment, when the edit is written as a clip each. |
| Rig Binding | Bone drawings | Each bone's shapes, as a drawing the size of the whole. |
| Rig Parts | Part drawings | Each part's drawing. |
| Face Parts | Faces, Feature drawings | Each head, or each feature of each head. |
| Video Rig Match | Frames | Each frame that was matched, as a picture. |
| Storyboard, voice and sound flows | Panels, takes, cues | Each panel or take. |

What a folder does depends on the input it is wired into:

- **An input that takes one file of that kind** (Video Background's *Video*):
  the folder goes as a batch, always.
- **An input that takes the whole folder too** (Line Detection's *Image* takes
  one picture or a folder of them): the folder goes whole, unless you choose
  otherwise. Select the wire, and under **Batch** choose *The whole folder* or
  *A batch, one image each*.

And a flow that has a batch wired into it makes a batch of everything it makes:

- Wired into an input that takes one file, it goes on as a batch: the next flow
  runs item by item too.
- Wired into an input that takes a **folder** of that kind and not one file
  (Animatic's *Panel images*), the items are **gathered**: they arrive together,
  as one folder. The wire shows `10→1`.

## A batch flow

A flow with a batch wired into it is a **batch flow**. On the graph it is drawn
as a stack, with how many items it has (`×10`) and a dot for each item's state:
green up to date, amber out of date, grey not made yet, red failed. The flow is
up to date when every item is.

It runs **once for each item**, as though that item alone were wired in: it
reads that item, uses that item's settings, and writes that item's files into a
folder of its own (`artifacts/<flow>/items/<item>/`). Nothing about the flow has
to know it is in a batch; any flow can be one.

Items are known by the name of the file they came from (`shot-03.webm`), which
stays put from run to run. So an item keeps its own settings and files when the
batch is made again, and a new item simply appears. An item that is gone is let
go of at the next run of the whole batch.

### Editing it

Double-click a batch flow and its editor opens as usual, showing one item, with
the **batch bar** across the top:

- **The items**, one chip each, coloured by state. Click one (or ‹ ›) to show it.
  The editor is the flow's own editor, showing that item: its video, its
  picture, its result.
- **Edit every item** (the default): a change is made to every item. An item
  with settings of its own takes the change too, and keeps the rest of its own.
- **Only this one**: a change is made to the item shown alone. From then on it
  has **its own settings** — its chip has a dashed border — and **Use the shared
  settings** drops them again.

What an editor finds out about the item in front of it — the length of its video,
the cuts found in it, the marks painted on its frames, the picture it read —
always stays with that item, even while editing every item. One video's length
is not every video's.

### Generating it

- **Generate** (at the top of the editor) does what it does for a single flow,
  for the item shown — or, for a flow whose files are made on the server, for
  every item while editing every item.
- **Generate all** (on the batch bar) makes every item:
  - A flow whose files are made on the server (Line Detection, Crop, Resize,
    anything with a brief) runs every item there.
  - A flow whose files are made in its editor — a video has to be decoded where
    it can be played — goes through the items one by one in the editor: it shows
    each and does what its buttons would. **Video Background** reads the frames,
    works out the background and sends it; **Shot Split** finds the shots (if
    they are not found yet) and records them; **Video Edit** records the edit.
    A progress bar shows how far it has got, and **Stop** stops after the item
    it is on.
- **Generate stale** on the graph runs only the items that are out of date.

Video Rig Match has to be taken in and matched in its editor, item by item; its
Generate all runs on the server and says so for each item that has not been.

## What comes out

A batch flow's output port stands for all its items: its hash changes when any
item's does, so whatever is downstream knows to run again — and only the items
whose own input changed do.

| Where | What |
| --- | --- |
| `artifacts/<flow>/items/<item>/…` | Each item's files, as the flow writes them for one. |
| The flow's *Files* panel | The item shown. |
| A gathered wire | The items' files for that port, together, as a folder. |
