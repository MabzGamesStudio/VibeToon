# Video Background

`art.video.background` · takes a **Video** · gives **`background.png`** and **`background.md`**

Takes the background out of a video clip: the colour each pixel has most often,
where it has it often enough.

```
Video ──▶ Video Background ──▶ background.png
          (or upload one in the editor)
```

## How it is worked out

1. **The frames.** The clip is first **probed** for where its frames really
   are: the time its first frame is shown at, the time its last frame is, and
   how long a frame lasts, all as the browser shows them. A header is not
   trusted for this — a clip recorded in a browser often has no length in it,
   and one cut from a longer video may not start at 0. The clip is then
   sampled **so many in all**, spread evenly from the first frame to the last
   (both included), or **so many a second** from the first frame, each time
   snapped to one of the clip's own frames, and no frame read twice.
   Each frame is taken by seeking to it, waiting — however long it takes —
   for the seek to finish, and then for the frame to be shown; the picture is
   then the last frame at or before that time, which is the right one. A
   recording made in a browser has frames when the page managed to draw one,
   not on an even beat, so a frame's own time is reported but never insisted
   on: insisting on it, and giving up after a moment, is what took a frame
   left over from the seek before and froze the frames from about a second in.
   Each read has its frame before the next seek starts. The video is in the
   page while it is read, since a browser may stop decoding one it thinks
   nobody sees.

   Clips recorded here (Shot Split, Video Edit) ask for a whole picture every
   half second. Without one, a recording has a whole picture only at its
   start, and every seek decodes from there, slower the further in.
2. **Every pixel, across every frame.** The colours a pixel has are gathered
   into groups of the same colour, within the **tolerance**. The biggest group
   is the colour it has **most often**, and the pixel takes that colour (the
   average of the group, so the frames where something stood in front are
   left out of it).
3. **Common enough?** If that colour is in fewer of the frames than the
   **agreement**, no one colour is common enough to be the background, and the
   pixel is left **clear**.

The tolerance is measured over red, green, blue and opacity, with black against
white at 100. At 2 only colours that never change count as one; about 8 allows
for compression noise; 25 allows for flicker and slow changes of light, and
joins similar colours of things passing in front too.

The agreement is a share of the frames. At 50% (the default) a pixel keeps the
colour it has more often than not, so a character walking past, in front of any
one spot for less than half the clip, is left out without marking anything. At
100% only pixels that are the same in every frame are kept. Lower it for a
character that lingers; raise it when something moving is taken for the
background.

A colour joins the first group it is within the tolerance of, and the winning
group is counted again against its average, so the order of the frames matters
little. On a tie the group seen first wins.

All the frames are held at once to find each pixel's commonest colour, so they
are read at the video's own size only while that fits: at most 1,280 pixels
across, and 40 million pixels over all the frames together. More frames of a
bigger video are read smaller. The editor says what size it read them at.

## Putting more in by hand

A character that stays in one place for most of the clip is the most common
colour there, and one that moves covers some of the background in every frame. What one frame shows can be put back from that frame:

1. Choose the frame in the strip under the picture.
2. Mark what it shows:
   - **Paint in**: brush over it. **Brush** sets the radius.
   - **Draw round**: click round it, then double-click or press Enter to close
     the shape. Escape drops it.
   - **Erase**: brush over pixels to take them out of the background, even ones
     common enough to be kept.
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

- `background.png`, the size the frames were read at, clear wherever no colour
  was common enough and nothing was marked.
- `background.md`: how many frames, how much of the picture had one colour in
  enough of them, and how much was marked by hand.

The frames are read in the editor, where the video can be decoded, so the
background is worked out there and sent with **Generate** in the editor. An
uploaded video stays on the flow's own *Video* port.
