import type { AlgorithmGuide } from '../guides';

export const SHOTS_GUIDE: AlgorithmGuide = {
  kinds: ['animation.video.shots'],
  title: 'Finding cuts: compare samples, then binary-search each cut to the frame',
  summary:
    'Every frame is boiled down to an embedding — an 8 × 8 colour thumbnail and a 64-bin colour histogram. The video is sampled coarsely; wherever two neighbouring samples differ by more than the threshold, there is a cut between them, and a binary search finds its exact frame by asking, of the middle frame, which side it looks like. Shots shorter than the minimum are then joined to the neighbour they are least unlike.',
  steps: [
    { kind: 'input', title: 'The video, and its frame rate' },
    {
      kind: 'loop',
      title: 'For each sampled frame',
      detail: 'So many a second, or so many in all.',
      steps: [
        { kind: 'step', title: 'Embed it', detail: '8 × 8 thumbnail + 4 × 4 × 4 colour histogram.' },
        { kind: 'step', title: 'Difference from the sample before', detail: '½ mean thumbnail difference + ½ histogram distance, 0–1.' },
      ],
    },
    {
      kind: 'loop',
      title: 'For each gap whose difference passes the threshold',
      steps: [
        {
          kind: 'loop',
          title: 'Until the two frames are next to each other',
          steps: [
            { kind: 'step', title: 'Look at the middle frame' },
            { kind: 'decision', title: 'More like the frame before the gap?', no: 'The cut is before it: the middle becomes the right end.' },
            { kind: 'step', title: 'The cut is after it: the middle becomes the left end' },
          ],
        },
        { kind: 'step', title: 'The cut is the right end’s frame' },
      ],
    },
    {
      kind: 'loop',
      title: 'While a shot is shorter than the shortest shot',
      steps: [{ kind: 'step', title: 'Remove the weaker of its two cuts', detail: 'It joins the neighbour it is least unlike.' }],
    },
    { kind: 'output', title: 'shots.json, shots.md — and each shot as a clip, when asked' },
  ],
  pseudocode: `def embed(frame):
  thumb = mean colour of each cell of an 8x8 grid          # where colours are
  hist  = share of pixels in each of 4x4x4 colour bins    # which colours
  return thumb, hist

def difference(a, b):                                       # 0 .. 1
  return 0.5 * mean(|a.thumb - b.thumb|) + 0.5 * sum(|a.hist - b.hist|) / 2

samples = frames at the sampling times
cuts = []
for (prev, next) in neighbouring samples:
  if difference(prev, next) < threshold: continue
  lo, hi = frame(prev), frame(next)            # lo looks like before, hi like after
  while hi - lo > 1:
    mid = (lo + hi) // 2
    if difference(mid, prev) <= difference(mid, next): lo = mid
    else: hi = mid
  cuts += hi

while some shot is shorter than min_shot:
  take the shortest; drop its weaker cut (the lower difference)`,
  sections: [
    {
      heading: 'Two views of a frame',
      body: 'The thumbnail says **where** the colours are; the histogram says **which** colours there are. A camera pan moves the thumbnail a lot and the histogram little; a cut to a different scene changes both. Taking half of each makes a pan look like one shot and a cut look like a cut.',
    },
    {
      heading: 'Why binary search',
      body: 'Comparing every frame with the next is exact and slow. Sampling is fast and only knows a cut is somewhere in a gap. Binary search gets both: each look halves the gap, so a cut anywhere in two seconds at 24 frames a second (48 frames) is found in about six looks. The middle frame is asked which end it looks more like; the cut is the first frame that looks like the far end.',
    },
    {
      heading: 'Short shots',
      body: 'A flash frame, or the middle of a dissolve, can pass the threshold on both sides and make a shot a few frames long. Any shot shorter than **Shortest shot** loses the weaker of its two cuts — the one with the smaller difference — so it joins the neighbour it is least unlike. Shortest first, until none is too short.',
    },
    {
      heading: 'Each shot as a clip',
      body: 'With **Each shot as a video** on, Generate writes every shot as a file of its own, frame by frame at the video’s frame rate — the same way Video Edit writes, not by playing it: a shot of 3 seconds at 30 fps is 90 frames, evenly spaced, in a file that says it is 3 seconds long and has an index. Flows downstream get each clip as an item of a batch.',
    },
    {
      heading: 'What it misses',
      body: '- Two cuts between the same two samples are found as one. Sample more often for fast cutting.\n- A slow dissolve changes a little at each sample and may never pass the threshold.\n- A sudden flash or a very fast pan can pass it and make a false cut — which the shots editor lets you join back.',
    },
  ],
  settings: [
    { name: 'Compare every / Frames compared', effect: 'How often frames are sampled. Cuts closer together than one sample apart are found as one.' },
    { name: 'A cut is a difference of', effect: 'How unlike two samples must be for a cut between them.' },
    { name: 'Shortest shot', effect: 'Shots shorter than this are joined to a neighbour.' },
    { name: 'Frame rate', effect: 'What “a frame” is: the search narrows each cut to one.' },
  ],
  cost: 'One look per sample, plus about log₂(frames per gap) looks per cut. Each look decodes a frame, which is most of the time.',
  resources: [
    { title: 'Shot transition detection', url: 'https://en.wikipedia.org/wiki/Shot_transition_detection', note: 'The problem, and the kinds of transition that make it hard.' },
    { title: 'Binary search', url: 'https://en.wikipedia.org/wiki/Binary_search_algorithm', note: 'Halving the gap until the cut is between two neighbouring frames.' },
    { title: 'Color histogram', url: 'https://en.wikipedia.org/wiki/Color_histogram', note: 'The “which colours” half of a frame’s embedding.' },
  ],
  source: ['packages/shared/src/flows/shots.ts — embedFrame, frameDifference, detectShots, dropShortShots'],
  tryIt: 'Click a shot to see it large and step through it frame by frame with ← and →: the first frame of each shot is where the search landed.',
};

export const VIDEO_EDIT_GUIDE: AlgorithmGuide = {
  kinds: ['animation.video.edit'],
  title: 'Editing a video: segments, a crop, and writing it frame by frame',
  summary:
    'The video is a row of segments end to end. A split cuts the segment under the playhead at the nearest frame; a segment is kept or deleted; two neighbours can be joined. On Generate the kept segments are written frame by frame: each frame of the result is the source’s frame for that moment, decoded from the file and drawn through the crop, and encoded at exactly its place — so a segment of so many frames is that many frames long, evenly spaced, and the file says how long it is.',
  steps: [
    { kind: 'input', title: 'The video' },
    { kind: 'step', title: 'Read what it is', detail: 'Its length, frame count and frame rate, from the file’s own packets: the end of its last frame, how many frames it holds, and how many a second.' },
    { kind: 'step', title: 'Segments', detail: 'At first one, the whole video. Splits snap to the nearest frame start.' },
    { kind: 'step', title: 'The crop', detail: 'One box for every frame, its sides made even (video encoders need even sizes).' },
    {
      kind: 'loop',
      title: 'For each kept segment, in order',
      steps: [
        { kind: 'step', title: 'Count its frames', detail: 'Its length times the frame rate, rounded: n.' },
        {
          kind: 'loop',
          title: 'For each of its n frames',
          steps: [
            { kind: 'step', title: 'Take the source’s frame for the middle of that frame’s slot', detail: 'Decoded from the file; where this browser cannot decode it, shown in a video element and drawn once it is shown.' },
            { kind: 'step', title: 'Draw it through the crop' },
            { kind: 'step', title: 'Encode it at exactly i / fps, lasting 1 / fps' },
          ],
        },
        { kind: 'decision', title: 'A clip each?', no: 'The next segment carries on in the same file.' },
        { kind: 'step', title: 'Finish the file', detail: 'Its length in the header, an index (WebM Cues) and a whole picture every second.' },
      ],
    },
    { kind: 'output', title: 'edited.webm, or clips/clip-01.webm …, and edit.json' },
  ],
  pseudocode: `facts = read_packets(video)            # duration = end of last frame, frames, fps
segments = [(0, facts.duration, kept)]
split(t):  s = segment containing t; t = nearest frame start
           replace s with (s.start, t) and (t, s.end), same kept/deleted
crop = even(clamp(box, inside video))

out = new_file(format, crop.width, crop.height, fps, key_frame_every = 1s)
written = 0
for s in segments if s.kept:
  n = round((s.end - s.start) * fps)
  for i in 0 .. n-1:
    frame = source_frame_shown_at(s.start + (i + 0.5) / fps)   # decoded, not played
    canvas.draw(frame, source = crop, target = whole canvas)
    out.add(canvas, timestamp = written / fps, duration = 1 / fps)
    written += 1
  if output == clips: out.finish(); out = new_file(...); written = 0
out.finish()                                # writes the length and the index
save edit.json = { crop, kept segments, deleted segments, lengths }`,
  sections: [
    {
      heading: 'Written frame by frame, not recorded as it plays',
      body: 'A clip recorded by playing the video and capturing the page (a MediaRecorder on a canvas) catches a frame whenever the page manages to draw one: the frames come unevenly — 70 frames in five seconds, some a millisecond apart and some half a second — the file has no length in its header and no index, and anything that reads it is left to guess. It plays fine, and every count of its length and frames is wrong, and reading a frame at a time from it gives the same frame again and again where the gaps are long. So the edit is not played. Each frame of the result is decoded from the source file, drawn through the crop and handed to the browser’s video encoder (WebCodecs, through Mediabunny) with its exact time; nothing is dropped however slow the page is, and it is not real time — often faster.',
    },
    {
      heading: 'A properly finished file',
      body: 'The file is written whole: its length in its header (the WebM Duration), an index of where each second starts (WebM Cues, or an MP4 index at the front), and a whole picture — a key frame — at least once a second. So every reader agrees on how long it is and how many frames it has, and can go straight to any frame without decoding everything before it.',
    },
    {
      heading: 'Which frame is taken',
      body: 'Frame i of a segment is the source frame shown at the middle of its slot, start + (i + ½) / fps. At the source’s own rate that is the source’s own frame i, whatever small offset its first frame has; from a source at another rate it is the nearest frame in time.',
    },
    {
      heading: 'Frames, exactly',
      body: 'The frame rate is read from the file — how many frames it holds over how long they last, as the nearest standard rate. Splits and steps land on a frame’s exact start (not rounded to the millisecond, which can show the frame before), and stepping reads the current frame with a small tolerance, so each press moves exactly one frame.',
    },
    {
      heading: 'Playing the edit',
      body: 'With **play the edit** on, the player skips deleted segments as it plays: whenever the time enters a deleted segment it jumps to the start of the next kept one, and stops after the last — so what you see is what will be written.',
    },
    {
      heading: 'When the browser cannot',
      body: 'Where this browser cannot decode the source from its file, each frame is shown in a video element and drawn once the browser says it is shown. Where it cannot encode the chosen format at all, the edit is recorded as it plays, the old way, and the recording is copied into a file with its length and an index; the picker marks such a format with ⚠, and its frames may not be evenly spaced.',
    },
  ],
  settings: [
    { name: 'Frame rate', effect: 'What splits and steps snap to, and the rate the result is written at. Read from the file when the video arrives.' },
    { name: 'Crop', effect: 'The box every frame is cut to, with even sides.' },
    { name: 'What comes out', effect: 'One video of the kept segments joined, or a clip for each.' },
    { name: 'Written as', effect: 'The container and codec: WebM with VP9, VP8 or AV1, MP4 or Matroska with H.264.' },
  ],
  cost: 'One decode, one draw and one encode per frame written: not real time, and usually quicker than playing it.',
  resources: [
    { title: 'Mediabunny', url: 'https://mediabunny.dev/', note: 'Reads and writes video files in the browser, frame by frame, over WebCodecs.' },
    { title: 'WebCodecs API', url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API', note: 'The browser’s own video decoders and encoders, called on single frames.' },
    { title: 'Matroska elements (WebM)', url: 'https://www.matroska.org/technical/elements.html', note: 'Duration, Cues and the rest of what a finished WebM file holds.' },
    { title: 'Edit decision list', url: 'https://en.wikipedia.org/wiki/Edit_decision_list', note: 'What edit.json is: the edit, to redo from the source.' },
  ],
  source: [
    'packages/shared/src/flows/videoEdit.ts — editSegments, splitSegmentAt, stepFrame, videoCropRect',
    'packages/client/src/components/editors/renderVideo.ts — renderEdit',
    'packages/client/src/components/common/media.ts — readVideoFacts, openExactVideo, startClip',
  ],
};

export const VIDEO_SOURCE_GUIDE: AlgorithmGuide = {
  kinds: ['animation.video.source'],
  title: 'Bringing a video in: checked by its bytes, fetched safely',
  summary:
    'A video is uploaded as its raw bytes, or fetched from a public address. Either way it is known by its first bytes — the signature every video format starts with — not by its name or what a server claims. A fetch refuses addresses on this machine or the private network before asking, and stops at the size limit.',
  steps: [
    { kind: 'input', title: 'A file, or an address' },
    { kind: 'decision', title: 'An address?', no: 'An upload: the file’s bytes are sent as they are and kept.' },
    { kind: 'decision', title: 'http(s), and not this machine or the private network?', no: 'Refused before anything is asked.' },
    { kind: 'decision', title: 'Says it is under the limit (256 MB)?', no: 'Refused before anything is read.' },
    { kind: 'step', title: 'Read it, stopping if it passes the limit' },
    { kind: 'decision', title: 'Do its first bytes say it is a video?', detail: 'MP4/QuickTime (ftyp), WebM/Matroska (EBML), Ogg.', no: 'A web page or something else: refused.' },
    { kind: 'output', title: 'The video, kept with the project, and source.md' },
  ],
  pseudocode: `def sniff(bytes):
  if bytes[4:8] == "ftyp": return quicktime if brand == "qt  " else mp4
  if bytes[0:4] == 1A 45 DF A3:                      # EBML
    return webm if "webm" in bytes[:64] else matroska
  if bytes[0:4] == "OggS": return ogg
  if bytes[4:8] in ("moov", "mdat", "wide"): return quicktime
  return None

fetch(url):
  refuse unless scheme is http(s) and host is public
  refuse if content-length > limit
  read, stopping past limit
  type = sniff(bytes) or refuse("a web page, not a video")`,
  sections: [
    {
      heading: 'Known by its bytes',
      body: 'A file name can say anything, and a server’s content type is often wrong (or says a page is a video). Every video container starts with a fixed signature, so the first few bytes say what it is. A page that *plays* a video is HTML, not the video, and is refused rather than kept.',
    },
    {
      heading: 'Safe fetching',
      body: 'The server does the download, so it must not be tricked into reaching places a browser could not: addresses on this machine and on the private network are refused before any request. A response that says it is too big is refused before reading; one that does not say is stopped as soon as it passes the limit.',
    },
    {
      heading: 'Measuring',
      body: 'The length, frame count and frame rate are read from the file’s own packets: the length is when its last frame ends, the count is how many frames it holds. A header is not trusted for this — a video recorded in a browser often has no length in it at all. Where this browser cannot read the file that way, it is played instead: the editor seeks far past the end once to make it find its length, and watches a few frames go by for the rate.',
    },
  ],
  resources: [
    { title: 'List of file signatures', url: 'https://en.wikipedia.org/wiki/List_of_file_signatures', note: 'The “magic numbers” formats start with.' },
    { title: 'Server-side request forgery', url: 'https://owasp.org/www-community/attacks/Server_Side_Request_Forgery', note: 'Why a server that fetches addresses refuses private ones.' },
  ],
  source: ['packages/shared/src/flows/videoSource.ts — sniffVideoType', 'packages/server/src/net/fetchVideo.ts — fetchVideo'],
};

export const RIG_MATCH_GUIDE: AlgorithmGuide = {
  kinds: ['animation.match'],
  title: 'Finding a rigged body in a picture, by small features',
  summary:
    'The bound drawing is painted at rest and cut into small square features, part by part. The picture is cut into features too, at a range of sizes and angles. Each feature is turned into a short list of numbers, and matches between body and picture features vote for where the whole body is. Then each part, from the root down, is turned and sized to where its own features match best, and every part gets a confidence.',
  steps: [
    { kind: 'input', title: 'A body (a rig bound to a drawing) and a picture' },
    { kind: 'step', title: 'The body’s features', detail: 'Paint the drawing at rest; from each part take square patches where there is most to see — more for a big part.' },
    { kind: 'step', title: 'The picture’s features', detail: 'Patches all over it, each at a range of sizes and turned through a range of angles.' },
    { kind: 'step', title: 'Embed every patch', detail: 'For each cell of a 4 × 4 grid: OKLab colour, how covered, how much edge.' },
    {
      kind: 'loop',
      title: 'For each good match of a body patch to a picture patch',
      steps: [{ kind: 'step', title: 'Vote for where the whole body would be', detail: 'This patch of chest found here, this big, turned this far.' }],
    },
    { kind: 'step', title: 'Place the body where most votes agree' },
    {
      kind: 'loop',
      title: 'Twice: for each part, root first',
      steps: [
        { kind: 'step', title: 'Try turns and sizes inside the joint’s range', detail: 'Keep the one where its features, and the parts below it, match best.' },
      ],
    },
    { kind: 'step', title: 'Confidence per part', detail: 'How well its features match where they ended up, against how well they match the picture at large.' },
    { kind: 'output', title: 'The fit: a placement, a pose and sizes — match.json' },
  ],
  pseudocode: `body = paint(bound drawing at rest)
body_feats  = for part in parts: best patches of part (count ~ part size)
image_feats = patches over the picture at scales s in [1/range .. range]
              and angles a in [-angle .. +angle]
embed(patch) = for cell in 4x4: (oklab colour, coverage, edge strength)

votes = {}
for bf in body_feats:
  for pf in nearest image_feats to bf by embedding:
    placement = where the body is if bf sits at pf (x, y, scale, rotation)
    votes[placement] += similarity(bf, pf)
fit.placement = the placement with the most votes

repeat 2 times:
  for part in bones, root first:
    for angle, size within joint limits:
      score = match of part's features (and its children's) at that pose
    keep the best; tighten the placement
confidence[part] = match where it ended up vs match anywhere in the picture`,
  sections: [
    {
      heading: 'Features, not the whole body at once',
      body: 'Matching the whole body as one picture fails as soon as an arm moves. Small patches of each part can be found wherever that part is, and each one on its own says where the body would be. Many matches agreeing on one placement is strong evidence; a few stray matches are outvoted.',
    },
    {
      heading: 'What a patch is',
      body: 'A patch is reduced to numbers: for each cell of a 4 × 4 grid, its colour in OKLab, how much of the cell is covered, and how much edge it has. Two patches are as alike as those numbers are. A body patch is only judged where the body *is*: its empty corners say nothing about the picture’s background.',
    },
    {
      heading: 'Root first',
      body: 'Once the body is placed, each bone is fitted in turn from the root down, turned (within its joint’s range) and sized to where its own features match best, taking the parts below it along. Doing it twice, and tightening the placement between, lets later parts correct an early guess.',
    },
    {
      heading: 'Confidence',
      body: 'A patch of plain skin matches everywhere, so matching here is no evidence. Each feature’s match where it ended up is weighed against how well it matches the picture at large: a feature that matches only here is strong evidence, one that matches everywhere is none.',
    },
  ],
  settings: [
    { name: 'Features', effect: 'How many patches each part gives, before sizing by how big it is. More is steadier and slower.' },
    { name: 'Scale range', effect: 'How much bigger or smaller the body may be in the picture than it was drawn.' },
    { name: 'Angle range', effect: 'How far the body, and each part against its parent, may turn.' },
    { name: 'Keep limits', effect: 'Keep every joint inside the rig’s own range of motion.' },
  ],
  cost: 'Grows with picture features × scales × angles; it runs in a worker so the editor stays responsive. Deterministic: the same inputs give the same fit.',
  resources: [
    { title: 'Feature matching', url: 'https://en.wikipedia.org/wiki/Feature_(computer_vision)', note: 'Finding an object by its small distinctive pieces.' },
    { title: 'Hough transform (voting)', url: 'https://en.wikipedia.org/wiki/Generalised_Hough_transform', note: 'Many matches voting for one placement — the idea behind placing the body.' },
    { title: 'Pictorial structures', url: 'https://en.wikipedia.org/wiki/Pictorial_structure_model', note: 'Finding a body as parts joined in a tree, fitted part by part.' },
  ],
  source: ['packages/shared/src/flows/rigMatchSolve.ts — the solver', 'packages/shared/src/flows/rigMatch.ts — the fit and its settings'],
};

export const VIDEO_MATCH_GUIDE: AlgorithmGuide = {
  kinds: ['animation.video.match'],
  title: 'A rig animation from a video: Rig Match on every sampled frame',
  summary:
    'The video is sampled, and Rig Match is run on each frame. A frame after one where the body was found starts its search from where the body was, since a character moves little between frames; after a frame where it was lost, the whole picture is searched again. Frames below the confidence threshold split the animation into segments, each a run of frames the body was found in.',
  steps: [
    { kind: 'input', title: 'A bound rig and a video' },
    { kind: 'step', title: 'Sample frames', detail: 'So many a second or so many in all; never the very last frame.' },
    {
      kind: 'loop',
      title: 'For each sampled frame, in order',
      steps: [
        { kind: 'decision', title: 'Was the body found in the frame before?', no: 'Search the whole picture, as Rig Match does.' },
        { kind: 'step', title: 'Search from where the body was', detail: 'Followed from the frame before.' },
        { kind: 'step', title: 'Keep the fit and its confidence' },
      ],
    },
    {
      kind: 'loop',
      title: 'Down the frames',
      steps: [{ kind: 'decision', title: 'Confidence at least the threshold?', no: 'The body is not here: end the current segment.' }],
    },
    { kind: 'output', title: 'animation.json (segments of keys), animation.md, and the frames as pictures' },
  ],
  pseudocode: `times = frame_times(duration, sampling)          # never the last frame
previous = None
for t in times:
  picture = read frame at t
  if previous and previous.confidence >= threshold:
    fit = rig_match(picture, start_from = previous.fit)   # followed
  else:
    fit = rig_match(picture)                              # whole picture
  frames += (t, fit, fit.confidence)
  previous = frames[-1]

segments, run = [], []
for f in frames by time:
  if f.fit and f.confidence >= threshold: run += f
  else: close run as a segment
close run`,
  sections: [
    {
      heading: 'Following',
      body: 'Between one sampled frame and the next a character moves a little, so the search starts from the last fit instead of from nothing. That is faster and steadier. After a frame where the body was lost — off screen, hidden, a cut — the next frame searches the whole picture again.',
    },
    {
      heading: 'Segments',
      body: 'Below the **threshold**, a frame is taken not to show the character, and the animation is split there. Each segment is a run of frames the body was found in, written as keys: where the body is, each joint’s angle, each part’s size, and how sure the match was.',
    },
  ],
  settings: [
    { name: 'Frames a second / in all', effect: 'How densely the video is sampled.' },
    { name: 'Threshold', effect: 'Below this confidence a frame does not show the character, and splits the animation.' },
    { name: 'Rig Match settings', effect: 'Features, scale and angle ranges, and joint limits, as in Rig Match.' },
  ],
  cost: 'One Rig Match per sampled frame — less for a followed frame.',
  resources: [
    { title: 'Video tracking', url: 'https://en.wikipedia.org/wiki/Video_tracking', note: 'Following an object from frame to frame, and re-finding it when lost.' },
  ],
  source: ['packages/shared/src/flows/videoMatch.ts — frameTimes, segmentsOf, rigAnimationOf', 'packages/shared/src/flows/rigMatchSolve.ts'],
};

export const ANIMATIC_GUIDE: AlgorithmGuide = {
  kinds: ['animation.animatic'],
  title: 'An animatic: the board’s panels timed into a cut',
  summary:
    'The storyboard decides what the shots are; the animatic decides how long each is held and which are in. Each panel’s length is its override if it has one, else the board’s, clamped to the minimum and maximum the wire’s rules set. Shots are laid end to end, with their start times and frame counts at the frame rate; Fit to target scales every shot by the same factor so the whole lands on the target length.',
  steps: [
    { kind: 'input', title: 'The storyboard: panels and their lengths' },
    {
      kind: 'loop',
      title: 'For each panel, in order',
      steps: [
        { kind: 'decision', title: 'Kept?', no: 'Skipped: listed, but not in the cut.' },
        { kind: 'step', title: 'Length = override, or the board’s', detail: 'Then clamped between min duration and max duration from the wire’s rules.' },
        { kind: 'step', title: 'Place it at the cursor; move the cursor on by its length', detail: 'Start frame = start × fps; frames = length × fps (at least 1).' },
      ],
    },
    { kind: 'step', title: 'Compare the total with the target length' },
    { kind: 'output', title: 'animatic.json, and the playblast recorded in the editor' },
  ],
  pseudocode: `cursor = 0
for panel in board.panels:
  o = overrides[panel]
  if o.skip: skipped += panel; continue
  length = clamp(o.duration or panel.duration, min_duration, max_duration)
  clips += { panel, start: cursor, end: cursor + length,
             start_frame: round(cursor * fps), frames: max(1, round(length * fps)) }
  cursor += length
off_target = cursor - target

fit_to_target():
  scale = target / cursor
  for clip: override clip.duration = clip.duration * scale`,
  sections: [
    {
      heading: 'Timing, kept apart from drawing',
      body: 'Retiming here never touches the drawings: an override is stored per panel, and an override that says nothing is removed, so a reset leaves the shot following the board again.',
    },
    {
      heading: 'Fit to target',
      body: '“It has to be 60 seconds”: every shot is scaled by target ÷ current length, keeping their proportions.',
    },
  ],
  settings: [
    { name: 'Target length', effect: 'What the cut is measured against, and what Fit to target scales it to.' },
    { name: 'min duration / max duration (rules)', effect: 'Clamp every shot’s length.' },
  ],
  cost: 'One pass over the panels.',
  resources: [{ title: 'Animatic', url: 'https://en.wikipedia.org/wiki/Animatic', note: 'What an animatic is for.' }],
  source: ['packages/shared/src/flows/animatic.ts — resolveAnimaticCut, fitCutToTarget'],
};
