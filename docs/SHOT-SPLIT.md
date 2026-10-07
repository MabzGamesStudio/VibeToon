# Shot Split

`animation.video.shots` · takes a **Video** · gives **`shots.json`** and **`shots.md`**, and each shot as a video on **Shot clips**

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

**Frame rate** is what "the exact frame" means. It is read from the file when
the video arrives (see below); change it only if you know better.

Two cuts between the same two compared frames are found as one. For fast
cutting, compare more often.

## Length and frame rate

The video's **length**, **frame count** and **frame rate** are read from the
file's own packets, frame by frame, never from its header alone: the length is
when its last frame ends, the count is how many frames it holds, and the rate is
the count over the time they span, snapped to a standard rate such as 24, 25,
29.97 or 30. A recording made in a browser often has no length in its header at
all, and some (an MP4 written in pieces) give only the first piece's, so a clip
that plays for three seconds would say half a second. Where this browser cannot
decode the file itself, it is played instead: the editor reads to its real end
once and times a few frames going by, and the side panel says the count is
*about* that many, measured as it played.

Frames in `shots.json`, the report, a split's snapping and the clips written all
go by that rate (it can be changed under *Frame rate*). In a batch, every video
keeps its own length and frame rate.

## Putting them right

After **Find the shots**, each shot is a row: its number, where it starts and
ends, how long it is, and how sharp the cut into it was. Then a strip of its
frames, **as long as the shot**. Every row uses the same scale (**Row scale**, in
pixels a second), so a shot twice as long is twice as wide.

- **Look at a shot**: click its strip, or its number, or press **View**. The
  shot opens in the large viewer (below), at the frame you clicked.
- **Split a shot**: Shift-click in its row at the frame to split at, or press
  **S** in the viewer. The line under the pointer shows the time, snapped to a
  frame.
- **Join a shot to the next**: press **Join with next**.

### The shot viewer

The viewer shows the chosen shot large, held to that shot: playing stops at its
end (or loops, with **Loop**), and scrubbing stays inside it. Under the video is
a scrub bar of the shot's frames.

| Key | Does |
| --- | --- |
| ← / → | Back or on a frame (Shift: a second) |
| Home / End | The shot's first or last frame |
| Space | Play or pause |
| ↑ / ↓ | The shot before or after |
| S | Split the shot at this frame |
| Escape | Close the viewer |

Looking at a shot changes nothing in the flow, so it does not make the flow out
of date.

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

### Each shot as a video

Tick **Each shot as a video of its own** (under *What comes out*), or wire the
**Shot clips** port into another flow — the box is then ticked for you, and says
which flow needs it — and Generate also writes every shot as a clip — `shots/shot-01.webm`, `shot-02.webm`, … — on
the **Shot clips** port. Wire that into a flow that takes one video, such as
Video Background, and it is a **batch**: each shot goes through that flow on its
own, and you get a background for each. See [BATCHES.md](BATCHES.md).

- Each clip is **written frame by frame**, as Video Edit writes: every frame of
  the clip is the video's own frame for that moment, decoded from the file and
  encoded at exactly its place, at the video's frame rate. A shot of 3 seconds at
  30 fps is a clip of exactly 90 frames, evenly spaced, whose file says it is 3
  seconds long, has an index (WebM Cues) and a whole picture every second — so
  Video Edit, Video Background and any player agree on its length and its frames.
  It is not played to be written, so it does not take as long as the video.
- **Each clip as** picks the format: WebM (VP9, VP8 or AV1), MP4 (H.264) or
  Matroska (H.264). Formats this browser cannot write are greyed out; one it can
  only record as the video plays (no encoder for it here) is marked ⚠, and its
  frames may not be evenly spaced — pick a WebM format there. The clips are named
  for the format (`shot-01.mp4`), and changing it marks the clips as behind until
  they are written again.
- A progress bar shows the shot being written, and **Stop** stops without
  writing anything.
- The sound is not kept.
- When the shots change after they were written, the editor says so until they
  are written again.
- Before anything is written, the flow downstream already shows one item per
  shot (*None of the 5 made yet by Shot Split*), with a button to open Shot Split
  and write them.

Clips written before this (by playing each shot through and recording the page)
came out with their frames unevenly spaced — some a millisecond apart, some half
a second — no length in the file and no index, so their length and frame count
read differently everywhere, and reading frames out of them repeated a frame
across the long gaps. **Generate** again to write them frame by frame.
