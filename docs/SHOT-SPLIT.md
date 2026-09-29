# Shot Split

`animation.video.shots` · takes a **Video** · gives **`shots.json`** and **`shots.md`**

Splits a video into its shots, finds each cut to the exact frame, and lets you
put them right by hand.

```
Video ──▶ Shot Split ──▶ shots.json
          (or upload one in the editor)
```

## How a cut is found

**Every frame is boiled down to an embedding** of two parts:

- **a small picture**, 8 × 8 in colour: where the colours are;
- **a colour histogram**, 4 × 4 × 4 bins: which colours there are.

Two frames' **difference** is half the mean difference of their small pictures
and half the distance between their histograms, from 0 (the same) to 1 (nothing
alike). A camera move changes the first and not the second; a cut changes both.

**Then the video is searched:**

1. Frames are compared at a coarse step: **so many a second** (2 by default) or
   **so many in all**.
2. Wherever two neighbouring samples differ by at least the threshold (**A cut
   is a difference of**), there is a cut somewhere between them.
3. **Binary search** finds the frame. It looks at the middle frame of the gap:
   if that frame looks more like the sample before, the cut is in the second
   half; if more like the one after, the first. It halves the gap until the frames
   either side of the cut are next to each other. A cut anywhere in a half-second
   gap at 24 frames a second is found in four looks.
4. A shot shorter than **Shortest shot** (a flash frame, a dissolve's middle, a
   false cut) is joined to the neighbour it is least unlike. The weaker of its two
   cuts goes, shortest shots first.

**Frame rate** is what "the exact frame" means. A browser cannot read a video's
frame rate from the file, so set it if it is not 24.

Two cuts between the same two compared frames are found as one. For fast
cutting, compare more often.

## Putting them right

After **Find the shots**, each shot is a row: its number, where it starts and
ends, how long it is, and how sharp the cut into it was. Then a strip of its
frames, **as long as the shot**. Every row uses the same scale (**Row scale**, in
pixels a second), so a shot twice as long is twice as wide.

- **Split a shot**: click in its row at the frame to split at. The line under
  the pointer shows the time, snapped to a frame.
- **Join a shot to the next**: press **Join with next**.

Every change is one undo step. **Find the shots again** starts over and replaces
what was done by hand.

## What comes out

`shots.json`:

```json
{
  "kind": "shots",
  "version": 1,
  "video": { "duration": 5.962, "width": 320, "height": 180, "fps": 24 },
  "shots": [
    { "index": 1, "start": 0, "end": 2.5, "duration": 2.5, "startFrame": 0, "endFrame": 59 },
    { "index": 2, "start": 2.5, "end": 4.208, "duration": 1.708, "startFrame": 60, "endFrame": 100 }
  ]
}
```

`endFrame` is the shot's last frame, inclusive. `shots.md` lists the shots with
how sharp each cut was, or *by hand* for a cut you made.

The cuts are found in the editor, where the video can be decoded, and stored with
the flow; **Generate** writes them out from there. An uploaded video stays on the
flow's own *Video* port.
