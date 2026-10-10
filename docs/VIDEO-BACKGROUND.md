# Video Background

`art.video.background` · takes a **Video** · gives **`background.png`** and **`background.md`**

Takes the background out of a video clip: the frames lined up with each other,
what never changes, and what moved rebuilt patch by patch from the frames that
show the background there.

```
Video ──▶ Video Background ──▶ background.png
          (or upload one in the editor)
```

## How it is worked out

1. **The frames.** The clip is opened and its frames listed as the file holds
   them: when each one is shown, read from the file's own packets. A header is
   not trusted for this, and neither is a grid worked out from a frame rate — a
   clip recorded in a browser has frames whenever the page managed to draw one,
   some a millisecond apart and some half a second. The frames to read are
   picked from that list: **so many in all**, spread evenly through them by
   count, first and last included; or **so many a second**, each the frame
   nearest that time. Only frames the clip has are picked, and none twice, so
   every frame read is a different picture. Each is then decoded from the file
   at its own time — not caught from a video element after a seek, which is
   what froze the frames from about a second in. (Where this browser cannot
   decode the file itself, each frame is shown in a video element in the page
   and drawn once the browser says it is shown.)
2. **Follow the camera.** A camera that shakes, drifts or pans moves the whole
   picture between frames, and then every pixel would change. So each frame is
   **lined up** with the ones before it first: the shift that makes it match
   best, searched on a small copy of the picture and made exact on bigger and
   bigger ones, no further than **Most it moves between frames** from where the
   frame before it sat. Every pixel counts in the match — a background of flat
   colours matches at many shifts except along its edges — but each pixel's
   difference is capped, so a character moving in front costs about the same at
   any shift and cannot pull the frames out of line. The search follows a pan
   from frame to frame however far it goes, and frames are matched against one
   frame rather than each against the one before, so a slow drift adds up rather
   than rounding away. The background is drawn where the frames were in the
   middle. Untick **Follow the camera** for a shot known to be still.
3. **What never changes.** With the frames lined up, a pixel whose colour stays
   within the **Tolerance** in every frame that sees it is background, as its
   average colour. Every pixel that changed is left **clear** for now.
4. **Rebuild what moved, patch by patch.** The picture is cut into square
   **patches**. For each patch with pixels that changed, every frame's version of
   it is compared with the others — over the changed pixels, a pixel matching
   where each version has the other's colour within a pixel of it, so an edge
   that wavers by a pixel (compression noise, a camera lined up to the nearest
   pixel) is still the same edge — and versions that match on nine in ten of
   them are one **group**. The background there is the biggest group, counting
   each frame in it once and half again for each frame read just after another
   of its own: a background seen in one frame is seen in the frames beside it,
   while a character passing over it has moved on. If that group holds at least
   the **Agreement** share of the frames that see the patch, the changed pixels
   are filled from its frames (the average of those that match there), so each
   patch is one coherent picture rather than a mix of pixels from many frames.
   Otherwise they stay clear. Untick **Rebuild what moved from patches** to see
   what never changed on its own.

The tolerance is measured over red, green, blue and opacity, with black against
white at 100. At 2 only colours that never change count as unchanged; about 8
allows for compression noise; 25 allows for flicker and slow changes of light.

The agreement is a share of the frames that see a patch. At 30% (the default) a
patch is rebuilt wherever one picture of it is shown in at least three frames of
ten and more often than any other — so a character walking past is left out
without marking anything, even one in front of a spot most of the time, as long
as it moves. Raise it if a character that lingered is being taken for the
background; lower it for one that covers part of the background most of the
time. A flow made before patches, with the old default of 50%, starts at 30%.

**Patch** sets the patches' size, 16 px by default: small ones fit tight round a
character but can be taken in by one that half covers them; big ones keep large
plain areas whole from a few frames.

All the frames are held at once, so they are read at the video's own size only
while that fits: at most 1,280 pixels across, and 40 million pixels over all the
frames together. More frames of a bigger video are read smaller. The editor says
what size it read them at, how far the picture moved, and how much of it never
changed, was rebuilt and was marked by hand. The work is done a slice at a time,
so the page stays responsive while it runs; changing a setting starts it again,
without lining the frames up again unless that is what changed.

## Or: by Voronoi areas

Pixels and patches compare colours where they are. **Voronoi areas** compares
shapes instead, and is chosen with the switch at the top of *What counts as the
background*:

1. **One palette for every frame.** k-means finds **Colours** colours (12 by
   default) in pixels sampled from all the frames, started k-means++ from a
   seeded random number, so the same thing is the same colour throughout.
2. **Each frame as a Voronoi diagram.** Each frame is drawn the way the
   [Voronoi Diagram](VORONOI.md) flow draws a picture — **Nodes a frame** nodes
   (400 by default), placed and coloured to fit it — in that palette only. Each
   frame starts from the nodes of the frame before, moved by how far the camera
   moved, so what did not move is drawn the same way.
3. **Areas.** Cells of one colour that touch are one area: the sky, a wall, a
   character's coat.
4. **How much each area changed.** Each area is compared with up to 16 other
   frames, lined up: the share of its pixels that frame does not show in its
   colour — within a pixel, so an edge that wavers, or a thin outline the
   diagram draws a little differently, is the same. A wall a character walked
   across is still mostly there in most frames; a character that walked is not
   where it was. The middle of those shares is the area's change.
5. **Animated.** An area that changed by at least **Animated when it changes
   by** (35% by default) is animated in that frame, grown by a pixel of the
   diagram for the edge a cell cuts across.
6. **Laid over each other.** Each pixel of the background is the middle colour,
   channel by channel, of the frames where it is not in an animated area — of
   those, the frames whose area there changed least, since a character's edge
   that joined a wall's area in a frame changes that area a little. A pixel in
   an animated area in every frame is clear.

The areas are worked out once for a set of frames: moving the threshold only
lays the frames over each other again, which takes a moment, while changing the
nodes or colours draws every frame again. In the editor, pick a frame and tick
**Show its areas** to see the frame as its areas, each in its palette colour,
the animated ones striped red. The report says how many areas there were in all
the frames and how many were animated; *Never animated* and *From other frames*
take the place of *Never changed* and *Rebuilt*.

## Putting more in by hand

A character that stays in one place for most of the clip is the background as
far as the frames can tell, and one that never moves off a spot leaves it clear.
What one frame shows can be put back from that frame:

1. Choose the frame in the strip under the picture.
2. Mark what it shows:
   - **Paint in**: brush over it. **Brush** sets the radius.
   - **Draw round**: click round it, then double-click or press Enter to close
     the shape. Escape drops it.
   - **Erase**: brush over pixels to take them out of the background, even ones
     common enough to be kept.
3. **Tint what is background already** shades, in green, what is in the
   background so far, lined up with that frame, so you can see what is missing.

Every mark belongs to its frame — where the camera moved, it is moved with that
frame onto the background — and the marks are laid on in the order they were
made: a stroke painted in takes that frame's pixels, and a later erase
clears them again. A frame with marks has a green border in the strip. **Clear
this frame's marks** takes them all off. **Show the background** goes back to
the result. Every mark is one undo step.

Marks are kept with the flow, but the frames themselves are not: after the
editor has been closed, **Read the frames** again to see the background and
change it. Reading a different video, or at a different size, clears the marks,
since they are in the frames' pixels.

## What comes out

- `background.png`, the size the frames were read at, lined up with the frames'
  middle position, clear wherever nothing could be put back and nothing was
  marked.
- `background.md`: how many frames, how far the picture moved, how much of it
  never changed, how much was rebuilt from patches, how much was marked by hand
  and how much is clear — and, when the camera moved, **where the background sits
  in each frame**: a frame's pixel at (x + right, y + down) shows the
  background's (x, y). That is what puts a character cut from a frame back in
  its place over the background.

The frames are read in the editor, where the video can be decoded, so the
background is worked out there and sent with **Generate** in the editor. An
uploaded video stays on the flow's own *Video* port.
