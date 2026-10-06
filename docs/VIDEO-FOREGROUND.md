# Video Foreground

`art.video.foreground` · takes a **Video** and a **Background** · gives **`frames/`**, **`foreground.json`** and **`foreground.md`**

Takes the background out of a video's frames, so only what moves in front of
it is left — the characters, on clear.

```
Video ─────────────┬──────────────────────────▶ Video Foreground ──▶ frames/frame-0001-at-0.000s.png …
                   └─▶ Video Background ──▶ (Background)
```

The background is the picture [Video Background](VIDEO-BACKGROUND.md) makes
from the same clip, or any picture of the scene with nothing in front. With
Shot Split's clips wired into both, each shot is a batch item, and each gets
its own background and its own foreground.

## How it is worked out

1. **The frames.** Picked from the frames the file holds — **so many in all**,
   or **so many a second** — and read at the background's size. Every frame
   read is held while the editor is open, so at most 60 million pixels' worth
   (about 65 frames at 1280 × 720); the editor says when it reads fewer.
2. **Lined up.** With **Follow the camera** on, each frame is lined up with
   the background first — a camera that shakes or pans moves the scene in the
   frame. The shift is the one that matches best, each pixel's difference
   capped so the character in front cannot pull it, searched coarse to fine
   near where the frame before sat and no further than **Most it moves between
   frames**. The background's clear pixels are left out of the match.
3. **Taken apart.** A frame pixel is background when its colour is within the
   **Tolerance** of the background pixel behind it, or of one of that pixel's
   eight neighbours (an edge that wavers by a pixel is not a character).
   Anything else is in front, and kept.
4. **Tidied.** Pieces smaller than **Drop specks under** are dropped; holes in
   what is kept no bigger than **Fill holes up to** (and not touching the
   frame's edge) are filled — a shirt the colour of the wall behind it is still
   the character; what is kept is grown by **Grow** pixels, for its soft edge.

Where the background is clear — Video Background could not put anything back,
because a character stood there all along — or a camera move shows past its
edge, there is nothing to compare with. **Keep the frame** keeps those pixels;
**Clear it** clears them.

The settings work on the frames read, a slice at a time, so the page stays
responsive; the frames are lined up again only when the frames, the background
or the reach change.

## In the editor

- **What is kept** shows a frame as it will be written, **The frame** as it was
  read, **The mask** what is kept in white.
- The strip under the picture is every frame read; hover one for how much of it
  was kept.
- *Moved* says how far the camera moved; *Kept* how much of all the frames is
  kept.

## What comes out

- `frames/`: each frame, the background's size, the frame's own pixels where
  something is in front and clear everywhere else, named for its place and its
  time: `frame-0003-at-1.250s.png`. Into a flow that takes one picture, a
  batch of the frames; into [Character Split](CHARACTER-SPLIT.md), the
  characters.
- `foreground.json`: each frame's file, time, where the background sat in it,
  how many pixels were kept and in how many pieces.
- `foreground.md`: the same, in words and a table.

The frames are read in the editor, where the video can be decoded, and sent
with **Generate** there.
