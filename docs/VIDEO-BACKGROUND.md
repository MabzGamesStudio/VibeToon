# Video Background

`art.video.background` · takes a **Video** · gives **`background.png`** and **`background.md`**

Takes the background out of a video clip: what stays put while everything else
moves.

```
Video ──▶ Video Background ──▶ background.png
          (or upload one in the editor)
```

## How it is worked out

1. **The frames.** The clip is sampled **so many in all** (spread evenly over
   it) or **so many a second**. The first is at the start, and none is at the
   very end, which is so often black.
2. **Every pixel, across every frame.** A pixel's colour is the middle of the
   colours it had (the median, channel by channel, so one odd frame does not
   tint it). If every frame is within the **tolerance** of that colour, the
   pixel is background. If not, something passed in front of it, and it is left
   **clear**.

The tolerance is measured over red, green, blue and opacity, with black against
white at 100. At 2 only pixels that never change count; about 8 allows for
compression noise; 25 allows for flicker and slow changes of light, and takes in
slow-moving things too.

All the frames are held at once to take medians, so they are read at the
video's own size only while that fits: at most 1,280 pixels across, and 40
million pixels over all the frames together. More frames of a bigger video are
read smaller. The editor says what size it read them at.

## Putting more in by hand

A moving character covers some of the background in every frame, but not the
same part in all of them. What one frame shows can be put back from that frame:

1. Choose the frame in the strip under the picture.
2. Mark what it shows:
   - **Paint in**: brush over it. **Brush** sets the radius.
   - **Draw round**: click round it, then double-click or press Enter to close
     the shape. Escape drops it.
   - **Erase**: brush over pixels to take them out of the background, even ones
     that held still.
3. **Tint what is background already** shades, in green, what is in the
   background so far, so you can see what is missing.

Every mark belongs to its frame, and the marks are laid on in the order they
were made: a stroke painted in takes that frame's pixels, and a later erase
clears them again. A frame with marks has a green border in the strip. **Clear
this frame's marks** takes them all off. **Show the background** goes back to
the result. Every mark is one undo step.

Marks are kept with the flow, but the frames themselves are not: after the
editor has been closed, **Read the frames** again to see the background and
change it. Reading a different video, or at a different size, clears the marks,
since they are in the frames' pixels.

## What comes out

- `background.png`, the size the frames were read at, clear wherever something
  moved and nothing was marked.
- `background.md`: how many frames, how much of the picture held still, and how
  much was marked by hand.

The frames are read in the editor, where the video can be decoded, so the
background is worked out there and sent with **Generate** in the editor. An
uploaded video stays on the flow's own *Video* port.
