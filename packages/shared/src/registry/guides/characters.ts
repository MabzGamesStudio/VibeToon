import type { AlgorithmGuide } from '../guides';

export const VIDEO_FOREGROUND_GUIDE: AlgorithmGuide = {
  kinds: ['art.video.foreground'],
  title: 'What moves in front: each frame lined up with the background, and what matches it made clear',
  summary:
    'The video’s frames are read at the background’s size. Each is lined up with the background — a camera that shakes or pans moves the scene in the frame — and then every pixel whose colour is within the tolerance of the background behind it (or of a neighbour of that, for an edge that wavers by a pixel) is made clear. Specks are dropped, holes filled and the rest grown a pixel, so what is left is the characters on clear.',
  steps: [
    { kind: 'input', title: 'The video, and its background' },
    { kind: 'step', title: 'Pick the frames', detail: 'So many in all or so many a second, from the frames the file holds; no more than fit at the background’s size.' },
    { kind: 'step', title: 'Read each at the background’s size', detail: 'Decoded from the file, or shown and drawn where this browser cannot decode it.' },
    {
      kind: 'loop',
      title: 'For each frame',
      steps: [
        { kind: 'step', title: 'Line it up with the background', detail: 'The shift that matches best — coarse to fine, near where the frame before sat, the background’s clear pixels left out.' },
        {
          kind: 'loop',
          title: 'For each pixel',
          steps: [
            { kind: 'decision', title: 'Is there background behind it?', no: 'Nothing to compare: kept or cleared, as “where the background is clear” says.' },
            { kind: 'decision', title: 'Within the tolerance of the background there, or of a neighbour of it?', no: 'Something in front: kept.' },
            { kind: 'step', title: 'Background: clear' },
          ],
        },
        { kind: 'step', title: 'Remove thin lines', detail: 'Shrink the mask by “Remove lines up to” pixels and grow it back: lines that thin go, shapes stay.' },
        { kind: 'step', title: 'Drop specks', detail: 'Pieces smaller than the speck size.' },
        { kind: 'step', title: 'Fill holes', detail: 'Clear patches inside what is kept, up to the hole size, not touching the edge.' },
        { kind: 'step', title: 'Grow', detail: 'A pixel or two all round, for the soft edge.' },
      ],
    },
    { kind: 'output', title: 'frames/frame-0001-at-0.000s.png …, foreground.json and the report' },
  ],
  pseudocode: `bg = background picture                       # Video Background's, say
frames = [read(video, t, size(bg)) for t in pick(times, sampling)]
guess = (0, 0)
for f in frames:
  offset = best_shift(bg, f, near=guess, within=most_it_moves)   # see Video Background
  guess = offset
  for each pixel q of f:
    p = q - offset                                # the background behind it
    if bg has nothing at p: keep[q] = (where_clear == keep); continue
    keep[q] = no pixel b in bg[p and its 8 neighbours] with |f[q] - b| <= tolerance
  keep = keep and grow(shrink(keep, thin), thin)   # an opening: thin lines go
  remove pieces of keep smaller than speck
  fill holes in keep up to holes, not touching the edge
  grow keep by grow pixels
  out = f where keep, clear elsewhere`,
  sections: [
    {
      heading: 'Against the background, not against the other frames',
      body: 'Something standing still for the whole shot never changes from frame to frame, so comparing frames with each other would lose it. Comparing each frame with a picture of the scene alone — the background Video Background makes, or any plate with nothing in front — keeps a character whether it moves or not, as long as it is not in the background picture itself.',
    },
    {
      heading: 'Lined up first',
      body: 'A camera that shakes or pans moves the whole scene in the frame, and an unaligned comparison would take every edge for something in front. Each frame is lined up with the background the way Video Background lines frames up with each other: the shift that matches best, each pixel’s difference capped so the character in front cannot pull it, searched coarse to fine near where the frame before sat. Where Video Background left the background clear, those pixels are left out of the match.',
    },
    {
      heading: 'A pixel’s neighbours',
      body: 'Compression noise and a camera lined up to the nearest pixel make edges waver by a pixel. A frame pixel counts as background when it matches the background pixel behind it or any of that pixel’s eight neighbours, so a wavering edge is not taken for a thin character — while a character, whose colours are nowhere near the background’s, is.',
    },
    {
      heading: 'Tidying',
      body: 'What differs from the background is rarely exactly the characters. Video compression keeps colour at half the picture’s resolution, so along a thin, sharp line in the scene the colour differs a little in every frame — **Remove lines up to** opens the mask (shrinks it and grows it back), so lines that thin go and anything thicker stays as it was. Noise leaves specks, and a character’s colour that happens to match the wall behind it leaves holes. Pieces smaller than **Drop specks under** are removed; clear patches inside what is kept, no bigger than **Fill holes up to** and not touching the frame’s edge, are filled; and what is left is grown by **Grow** pixels, so the soft anti-aliased edge where a character meets the background comes with it.',
    },
    {
      heading: 'Where the background is clear',
      body: 'Where Video Background could not put anything back — a character stood there all the shot — or where a camera move shows past the background’s edge, there is nothing to compare with. **Keep the frame** keeps those pixels (usually right: what was never seen behind is likely the character); **Clear it** clears them.',
    },
  ],
  settings: [
    { name: 'Frames in all / a second', effect: 'How many frames are taken apart.' },
    { name: 'Follow the camera, Most it moves between frames', effect: 'Line each frame up with the background first, and how far to look.' },
    { name: 'Tolerance', effect: 'How far from the background’s colour is still background.' },
    { name: 'Remove lines up to', effect: 'Lines in front up to twice this thick are removed.' },
    { name: 'Drop specks under', effect: 'Smaller pieces in front are dropped.' },
    { name: 'Fill holes up to', effect: 'Smaller holes in what is kept are filled.' },
    { name: 'Grow', effect: 'What is kept grows by this much all round.' },
    { name: 'Where the background is clear', effect: 'Keep or clear the pixels with nothing behind them to compare.' },
  ],
  cost: 'Lining up as Video Background does; then nine comparisons a pixel, and a few passes to tidy — a fraction of a second a frame, worked a slice at a time.',
  resources: [
    { title: 'Background subtraction', url: 'https://en.wikipedia.org/wiki/Background_subtraction', note: 'Taking a known background away to leave what is in front.' },
    { title: 'Connected-component labeling', url: 'https://en.wikipedia.org/wiki/Connected-component_labeling', note: 'How specks and holes are found.' },
    { title: 'Mathematical morphology', url: 'https://en.wikipedia.org/wiki/Mathematical_morphology', note: 'Growing a mask by a pixel: a dilation.' },
  ],
  source: ['packages/shared/src/flows/videoForeground.ts — alignToBackgroundWork, foregroundOf, foregroundWork', 'packages/shared/src/flows/videoBackground.ts — bestShift, brightnessLevels'],
  tryIt: 'Pick a frame and switch between What is kept, The frame and The mask; raise the tolerance until the noise goes and the character stays whole.',
};

export const CHARACTER_SPLIT_GUIDE: AlgorithmGuide = {
  kinds: ['art.video.characters'],
  title: 'Characters from what moves: colour embeddings where they are apart, and pixel likelihoods where they touch',
  summary:
    'Each foreground frame is cut into pieces — kept pixels in touching patches — and each piece gets an embedding: the share of its pixels in each of 216 colours. Pieces are grouped by embedding, the frames where characters are apart first; a group that is a blend of two others is two characters touching, not a character. Each piece then goes to its group’s character; a piece two characters could share — a blend, or one where another character is expected from the frames either side — is split pixel by pixel, to the character likeliest there by its colours and by how near its patch is to where that character was.',
  steps: [
    { kind: 'input', title: 'Frames with only the characters left (Video Foreground)' },
    {
      kind: 'loop',
      title: 'For each frame',
      steps: [
        { kind: 'step', title: 'Find its pieces', detail: 'Patches “Join pieces within” across that hold kept pixels, touching patches together; pieces under the smallest left out.' },
        { kind: 'step', title: 'Embed each piece', detail: 'A soft histogram over 6 × 6 × 6 colours: the share of the piece in each.' },
      ],
    },
    { kind: 'step', title: 'Group pieces by embedding', detail: 'Frames with the most pieces first. A piece joins the group whose mean embedding is at least the sameness alike (Bhattacharyya), or starts one.' },
    { kind: 'step', title: 'Find blends', detail: 'A group whose mean is best explained as a mix of two others (by 4% or more), where those two are not apart, is two characters together.' },
    { kind: 'step', title: 'The characters are the groups that are not blends' },
    {
      kind: 'loop',
      title: 'For each frame, each piece',
      steps: [
        { kind: 'step', title: 'Who could it be?', detail: 'Its group’s character; a blend’s two; any character not apart in this frame that the frames either side expect where the piece is.' },
        { kind: 'decision', title: 'One?', no: 'Split it: each pixel to the likeliest.' },
        { kind: 'step', title: 'All of it is that character’s' },
      ],
    },
    { kind: 'step', title: 'Split a shared piece', detail: 'Likelihood = that character’s share of the pixel’s colour × nearness of the pixel to where it was (its pixels in the nearest frame, moved by its motion; Gaussian in distance). Then a stray pixel follows its neighbours.' },
    { kind: 'step', title: 'Leave out characters in too few frames' },
    { kind: 'output', title: 'A clip, a sheet and the frames of each character, characters.json and the report' },
  ],
  pseudocode: `for f, frame in frames:
  pieces[f] = connected patches of kept pixels (patch = join px), area >= smallest
  for piece: piece.embedding = soft_histogram(piece colours, 6x6x6) / area

groups = []
for piece in pieces sorted by (pieces in its frame desc, area desc):
  g = argmax_g bhattacharyya(piece.embedding, mean(g))
  if similarity >= sameness: g.add(piece) else: groups += Group(piece)

for C in groups:                                  # two characters touching?
  for A, B in other groups:
    w, s = best mix(mean(A), mean(B)) for mean(C)
    if s >= sameness and s - max(sim(C,A), sim(C,B)) >= 0.04 and A, B rarely apart where C is:
      C.blend_of = (A, B)
characters = groups that are not blends

for f, piece:
  who = {piece's character} | blend_of | {c expected near piece in f, not apart elsewhere in f}
  if len(who) == 1: give all pixels to it
  else for pixel p in piece:
    owner[p] = argmax_c log(c.embedding[colour(p)]) + log(exp(-d_c(p)^2 / 2 sigma^2))
    # d_c(p): distance to c's pixels in the nearest frame it was apart, moved by its motion
drop characters in < least frames`,
  sections: [
    {
      heading: 'An embedding that is the colours',
      body: 'A cartoon character is mostly its colours: its skin, its clothes, its hair, in roughly the same shares whichever way it turns. So a piece’s embedding is a histogram of its colours over a 6 × 6 × 6 grid of the colour cube, each pixel shared between the eight grid colours round it so that compression noise does not move it from one bin to another. Two embeddings are compared with the Bhattacharyya coefficient — the sum, over the colours, of the square root of the two shares multiplied — 1 for the same mix, near 0 for none in common.',
    },
    {
      heading: 'Learnt where they are apart',
      body: 'Where two characters are apart, each is a piece of its own and its embedding is clean. So the grouping starts from the frames with the most pieces in them: those set what each character looks like, and pieces from frames where characters run together join them afterwards. A piece that is two characters together has the colours of both, in the shares of how much of each shows, so its group’s mean is a blend of their two means; a group that is explained far better as such a blend than as either one — and whose two are not seen apart in the same frames — is taken for two characters together, not a third character.',
    },
    {
      heading: 'Shared out by colour and by place',
      body: 'A piece two characters could be in is split pixel by pixel. For each pixel, each character’s likelihood is its share of that pixel’s colour, times how near the pixel is to where that character was — its own pixels in the nearest frame where it was apart, moved on by how its centre was moving, with nearness falling off as a Gaussian of the distance. Colour decides where the characters differ (a red shirt against a blue one); place decides where they share colours (two heads of the same skin), which is why a character must be seen apart somewhere near in time. A pixel that went against all its neighbours follows them.',
    },
    {
      heading: 'What it cannot know',
      body: '- Where two characters overlap in the same colours, which one is in front cannot be told from colour or place: the pixels there may go to either.\n- Two characters dressed alike are one group unless they are apart in the same frames; raise Sameness, or leave one out and join by hand.\n- A character never seen apart from another, in any frame, has no clean embedding: it is found only if its blend can be explained by the others.',
    },
    {
      heading: 'What comes out',
      body: 'For each character: its frames, the size the frames were, clear but for it (`character-1-frame-0001-at-0.000s.png`); a sheet of them side by side, cut to the box round everything it does; and a see-through WebM clip of that box from its first frame to its last, clear in frames where it is not. The clips folder (and the sheets folder) into a flow that takes one video (or one picture) is a batch: one item per character. `characters.json` lists every character, its colours and embedding, and every frame it is in, with its box and whether it was split there.',
    },
  ],
  settings: [
    { name: 'Join pieces within', effect: 'Pixels this close are one piece.' },
    { name: 'Smallest piece', effect: 'Smaller pieces are left out.' },
    { name: 'Sameness', effect: 'How alike two pieces’ colours must be to be one character.' },
    { name: 'Most a character moves', effect: 'How far round a piece another character is looked for.' },
    { name: 'Least frames', effect: 'Fewer, and a character is left out.' },
    { name: 'Name, Leave out, Is …', effect: 'By hand: name a character, leave it out, or join it to another.' },
  ],
  cost: 'Pieces: one pass over each frame. Grouping: pieces × groups × 216. Blends: groups³ × 216 × 19. Splitting: for each shared piece, a distance map per character over the piece’s box, and one score per pixel per character.',
  resources: [
    { title: 'Color histogram', url: 'https://en.wikipedia.org/wiki/Color_histogram', note: 'A picture as the share of each colour in it: the embedding.' },
    { title: 'Bhattacharyya distance', url: 'https://en.wikipedia.org/wiki/Bhattacharyya_distance', note: 'How alike two embeddings are: the coefficient is the sum of the square roots of their products.' },
    { title: 'Distance transform', url: 'https://en.wikipedia.org/wiki/Distance_transform', note: 'How far each pixel is from where a character was: a two-pass chamfer.' },
    { title: 'Multiple object tracking', url: 'https://en.wikipedia.org/wiki/Video_tracking', note: 'The wider problem of following several things through a video.' },
  ],
  source: ['packages/shared/src/flows/characterSplit.ts — framePieces, embedPixels, embeddingSimilarity, bestBlend, characterWork, applyCharacterEdits, chamferDistance'],
  tryIt: 'Pick a frame where two characters touch: each pixel is tinted the colour of the character it went to. “Show only” one character to see its frames on their own.',
};
