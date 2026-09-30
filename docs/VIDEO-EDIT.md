# Video Source and Video Edit

Getting a video into a project, and cutting it down.

```
Video Source ──▶ Video Edit ──▶ edited.webm ──▶ Shot Split, Video Background, Video Rig Match…
                             └▶ clips/ (a clip for each segment)
```

---

# Video Source

`animation.video.source` · gives **the video** and **`source.md`**

A video from this machine or from a link.

- **From this machine.** Choose a file, up to 1 GB. It is copied into the
  project, sent as it is rather than read into the page first, so a long video
  uploads as easily as a short one.
- **From a link.** Paste the address of the video *file* and press **Fetch**. The
  server downloads it once and keeps it with the project, so the flow keeps
  working when the address stops.
  - A page that plays a video is a web page, not the video; the flow says so
    rather than keeping a page.
  - The file is known by its first bytes, not by its name or what the server
    says it is: MP4, WebM, QuickTime, Ogg or Matroska.
  - Up to 256 MB. A link that says it is bigger is refused before anything is
    read, and one that does not say is stopped once it passes the limit.
  - Addresses on this machine and on the private network are refused before
    anything is asked, as for pictures.

The editor plays the video and measures its **length** and **size** (a video
recorded in a browser often does not say how long it is until read to the end,
so the editor reads to the end once to find out). **What it is** and **Credit
and terms** are written into `source.md` with where the video came from. A video
fetched from a link with no credit is flagged there: it belongs to someone.

Wire its *Video* into any flow that takes one.

---

# Video Edit

`animation.video.edit` · takes a **Video** (or upload one) · gives **`edited.webm`** or **`clips/`**, and **`edit.json`**

Crops a video, splits it into segments, and deletes the ones not wanted.

## The timeline

Under the picture is the **timeline**, three rows deep:

- a **ruler** of times, with the **shots** behind it once they have been found
  (see below), each shot a band of its own and its cut a dashed orange line down
  the timeline;
- a **filmstrip** of the video's frames, read as they come into view;
- the **segments** (below).

A bar under it is the whole video: the part the timeline shows is the lighter
window on it, deleted stretches are red and shot cuts orange.

| To | Do |
| --- | --- |
| Scrub | Drag along the timeline. The video follows, a frame at a time, and the playhead stays in view. |
| Step a frame | ← and → (Shift: a second), or the **◀|** and **|▶** buttons beside Play. Hold the key or press it again and again: each press moves exactly one frame. Home and End go to the first and last frame. Stepping pauses the video, and the frame number is shown next to the time. |
| Zoom | The mouse wheel over the timeline zooms about the pointer, **+** and **−** (on the keyboard or the buttons) about the playhead, in as far as a few frames across. **Whole video** zooms right out. |
| Pan | Drag with Shift (or Alt, or the middle button) held, scroll sideways, or drag the window on the bar underneath (click the bar to go straight there). |

The filmstrip shows a frame every so many frames, fewer the further out it is
zoomed; zoomed in far enough, every frame. A frame is repeated along its tile
when there is room, so a tile is as long as the frames it stands for.

Frames are counted from the time with a little give (`floor(time × fps +
0.05)`), and a frame's start time is worked out exactly. Without that, a frame
whose start rounds to, say, 3.033 s read back as the frame before it, and
stepping on from it went nowhere. Scrubbing snaps to the nearest frame start.

## Shots

**Find the shots** looks for the cuts in the video the way Shot Split does:
frames twice a second are compared by a small picture and a colour histogram,
and each cut is narrowed down to the frame by halving. Shots shorter than half
a second are joined to a neighbour. The shots are listed under the button (click
one to go to it) and shown on the timeline, and kept with the flow for this
video. **Split at the shots** splits the segments at every cut, so each shot can
be kept or deleted, or written as a clip of its own.

## Segments

The video is a row of **segments** end to end, shown on the timeline under the
filmstrip. At first there is one, the whole video.

| To | Do |
| --- | --- |
| Move the playhead | Click or drag along the timeline. |
| Split | **Split at …**, or press **S**: the segment under the playhead is cut in two at the frame nearest it. |
| Delete a segment | Select it (click it on the bar or in the list) and press **Delete**, or **Delete** beside it in the list. Deleted segments are hatched red. |
| Keep it again | The same again: **Keep**. |
| Join two | **Join ↓** joins a segment to the next. The joined segment is kept if either was. |

**Play** plays the video. With **play the edit** ticked (the default) it skips
what is deleted, so what you see is what will be written. Space plays and
pauses. A split, scrubbing and stepping all snap to the **frame rate**, which is
what "a frame" means here: a browser cannot read a video's own frame rate, so
set it to the video's.

## Crop

Tick **Crop the picture** and a box appears over the video. Drag the box to move
it, drag a handle to move that side or corner, or drag outside it to draw a new
one; or type its left, top, width and height. Everything outside it is dimmed.
The crop is the same for every frame, and its sides are kept even, which video
encoders need.

## What comes out

- **One video**: the kept segments one after another, cropped, as
  `edited.webm`.
- **A clip for each segment**: each kept segment on its own, cropped, as
  `clips/clip-01.webm`, `clips/clip-02.webm`, … on the *Clips* port (a folder of
  videos).
- Always, `edit.json`: the source's size and length, the crop, which segments
  were kept (and the clip each became) and which were deleted, and the edited
  length. It is the edit itself, to redo from the source elsewhere.

**Generate** records the edit in the editor: the video is played through the
crop, segment by segment, and recorded as WebM (VP9 where the browser has it).
So it takes about as long as the edit lasts. A progress bar shows how far it
has got, and **Stop** stops it without writing anything.

- **The sound is not kept.** Only the picture is recorded.
- When the edit changes after it was recorded, the editor says so until it is
  recorded again.
- A run without the editor (**Generate stale** on the graph) writes `edit.json`
  and says the video is recorded in the editor.
- Choosing a different video clears the segments and crop, since they were for
  another video.

Every change is one undo step.
