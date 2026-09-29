# Video Rig Match

`animation.video.match` · takes a **Bound rig** and a **Video** · gives **`animation.json`** and **`animation.md`**

Finds a bound rig's body in every sampled frame of a video and turns the
matches into a rig animation. The animation is split wherever the character is
not found.

```
Rig Binding ──▶ Video Rig Match ──▶ animation.json
Video ────────┘   (or upload one in the editor)
```

## How it goes

1. **Take the body in.** The bound rig wired into *Bound rig*.
2. **The video.** Either wire one into *Video*, or press **Upload a video**. An
   uploaded video is kept on the flow's own *Video* port, so a regenerate never
   drops it.
3. **Choose the frames.** Sample the video either by **a second** (so many
   frames per second of video) or **in all** (so many frames spread evenly over
   the whole video). The first frame is at the start, and none is at the very
   end, which is so often black. At most 600 frames.
4. **Match every frame.** Each sampled frame is read at up to 480 pixels across
   and runs through the [Rig Match](RIG-MATCH.md), in a worker, with the
   settings here:
   - **Features per part**, **Range in size** and **Range in angle** work as in
     the Rig Match.
   - **Keep to each joint's range of motion** keeps every joint inside the
     rig's limits.

   What the match learns about the body is kept from frame to frame. Only the
   picture is new each time.
5. **Following.** A character moves little between frames, so a frame after one
   where the body was found starts its search from where that frame left it. A
   followed search that comes back below the threshold is tried again across
   the whole picture, in case the character jumped, and the better answer is
   kept. A frame after one where the body was lost always searches the whole
   picture.
6. **Splitting.** Every frame gets the body's confidence.
   - Below **Found at confidence**, the character is taken not to be in the
     frame (off screen, hidden, or a cut to another shot). That frame is
     dropped and the animation is split there.
   - What is left is a list of **segments**: runs of frames the body was found
     in. Each segment is a rig animation of its own.

**Stop** keeps the frames matched so far; **Match the other N** carries on from
there. Changing the body, the video or the sampling makes the frames out of
date, and the banner says so.

## Watching it

The stage plays the animation back as **just the body and its skeleton**. You
can turn on **the video underneath** to compare them.

- **Between sampled frames** the body is blended: placement, size, every
  joint's angle (turned the short way round) and every part's size.
- **Outside every segment** nothing is drawn, and the stage says *Not found
  here*.

| Control | What it does |
| --- | --- |
| **Play** / **Pause**, speed, **Loop** | Play the whole video's length. |
| The track under the stage | Drag to scrub. It shows each segment colored by its confidence, a tick for every sampled frame, and dropped frames in red. |
| A segment in the list | Plays from its start. |
| **Show** | The body, the skeleton, and the video underneath (with how solidly the body is drawn over it). |

## What comes out

`animation.json` holds:

```json
{
  "kind": "rigAnimation",
  "version": 1,
  "picture": { "width": 480, "height": 270 },
  "video": { "duration": 2.88, "width": 1920, "height": 1080, "sampled": 12 },
  "sampling": { "mode": "total", "fps": 6, "total": 12 },
  "threshold": 0.3,
  "bones": [{ "id": "hips", "name": "Hips", "parent": null }],
  "segments": [
    {
      "start": 0, "end": 1.2, "confidence": 0.71,
      "keys": [
        {
          "time": 0,
          "confidence": 0.74,
          "placement": { "x": 150.8, "y": 190.1, "scale": 0.6, "rotation": 0, "pivot": { "x": 200, "y": 210 } },
          "pose": { "left-upper-arm": 40.2 },
          "sizes": {}
        }
      ]
    }
  ],
  "dropped": 2
}
```

- **Coordinates.** Placements are in the pixels of the frames as they were
  matched (`picture`). Multiply by `video.width / picture.width` to get the
  video's own pixels.
- **Pose.** Each key's `pose` is each bone's own turn, stored exactly as a
  Pose flow stores one.

`animation.md` lists the segments and the frames dropped, with each one's
confidence.

**Frames** is the frames that were matched, as pictures at the size they were
matched at — `frame-001.png`, `frame-002.png`, … in order. Generate in the editor
reads them from the video and sends them with the run. Wired into a flow that
takes one picture it is a batch, a frame at a time (see [BATCHES.md](BATCHES.md)).

On a test video of the character walking across a painted background, with a
stretch where the character is gone, all 12 sampled frames were matched in
about 30 seconds. The two frames without the character were dropped at 1%
confidence, the rest scored around 70%, and the placements landed within a
pixel of where the character was painted.
