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

The editor reads the video's **length**, **frame count**, **frame rate** and
**size** from the file's own packets — the length is when its last frame ends —
not from its header, which a video recorded in a browser often leaves without a
length. Where this browser cannot decode the file, it plays it instead and reads
to the end once to find its length. **What it is** and **Credit
and terms** are written into `source.md` with where the video came from. A video
fetched from a link with no credit is flagged there: it belongs to someone.

Wire its *Video* into any flow that takes one.

---

## Any video comes in

The file picker of every flow that reads a video takes any video file — MP4,
WebM, QuickTime, Ogg, Matroska, AVI, Windows Media, Flash, MPEG streams —
by its type or its extension. A browser can play the first five; the others
are **converted to MP4 as they arrive** (uploaded or fetched) when ffmpeg is
installed (set `VIBETOON_FFMPEG` if it is not on the `PATH`). Without ffmpeg
such a file is turned away with what to do, rather than kept where no flow
could play it.

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
what "a frame" means here; it is read from the file when the video arrives. The
line under the video says which frame is showing and how many there are.

## Crop

Tick **Crop the picture** and a box appears over the video. Drag the box to move
it, drag a handle to move that side or corner, or drag outside it to draw a new
one; or type its left, top, width and height. Everything outside it is dimmed.
The crop is the same for every frame, and its sides are kept even, which video
encoders need.

## Length and frame rate

The video's length, frame count and frame rate are read from the file's own
packets — when its last frame ends, how many frames it holds, and how many a
second — not from its header; the *Frame rate* starts at what was read, for each
video of a batch on its own. Stepping, splitting and writing all go by it.

## Written as

**Written as** (under *What comes out*) picks the format the edit, or each clip,
is written in: WebM (VP9, VP8 or AV1), MP4 (H.264) or Matroska (H.264). One this
browser cannot write is greyed out; one it has no encoder for, so can only
record as the video plays, is marked ⚠. The run that writes the files records
which edit they came from, so the flow is up to date after its own Generate.

## What comes out

- **One video**: the kept segments one after another, cropped, as
  `edited.webm`.
- **A clip for each segment**: each kept segment on its own, cropped, as
  `clips/clip-01.webm`, `clips/clip-02.webm`, … on the *Clips* port (a folder of
  videos).
- Always, `edit.json`: the source's size and length, the crop, which segments
  were kept (and the clip each became) and which were deleted, and the edited
  length. It is the edit itself, to redo from the source elsewhere.

**Generate** writes the edit in the editor, **frame by frame**: frame *i* of a
segment is the video's own frame for the middle of its slot, *start + (i + ½) /
fps*, decoded from the file, drawn through the crop and encoded at exactly
*i / fps* (with Mediabunny, over the browser's WebCodecs). So a segment of *n /
fps* seconds is exactly *n* frames, evenly spaced, nothing is dropped however
slow the page is, and it does not take as long as the edit lasts. The file is
finished properly: its length in its header, an index (WebM Cues, or an MP4
index at the front) and a whole picture at least every second, so every reader
agrees on how long it is and how many frames it has, and can go straight to any
of them. A progress bar shows how far it has got, and **Stop** stops it without
writing anything.

- Where this browser cannot decode the source from its file, each frame is shown
  in a video element and drawn once the browser says it is shown, then encoded
  the same way.
- Where it has no encoder for the chosen format, the edit is recorded as it
  plays (the old way: real time, frames caught whenever the page draws one) and
  the recording is copied into a file with its length and an index. Its frames
  may not be evenly spaced; the editor says so.
- **The sound is not kept.** Only the picture is written.
- When the edit changes after it was written, the editor says so until it is
  written again.
- A run without the editor (**Generate stale** on the graph) writes `edit.json`
  and says the video is written in the editor.

### Why not record it as it plays

The edit used to be written by playing it and recording the page. A recording
like that catches a frame whenever the page manages to draw one: a 5-second
clip came out as 73 frames, some a millisecond apart and some half a second, in
a file with no length in its header and no index. It played fine, but its length
and frame count read differently in every place that looked, and reading frames
out of it one by one gave the same frame again and again across the long gaps.
Writing frame by frame from the decoded source is what makes the length, the
frames and the file agree.
- Choosing a different video clears the segments and crop, since they were for
  another video.

Every change is one undo step.
