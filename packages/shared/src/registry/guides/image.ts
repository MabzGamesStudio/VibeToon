import type { AlgorithmGuide } from '../guides';

export const CROP_GUIDE: AlgorithmGuide = {
  kinds: ['art.crop'],
  title: 'Cropping: a box drawn by hand, or the smallest box round the solid pixels',
  summary:
    'By hand, the box is the one drawn, kept inside the picture. To the solid pixels, every row is scanned for its first and last pixel more opaque than a threshold; the smallest box holding all of them is the crop, with an optional margin and an optional growth to a square. What the box reaches past the picture is clear.',
  steps: [
    { kind: 'input', title: 'The picture' },
    { kind: 'decision', title: 'To the solid pixels?', no: 'By hand: take the box drawn, clamped inside the picture.' },
    {
      kind: 'loop',
      title: 'For each row',
      steps: [
        { kind: 'step', title: 'Find its first and last solid pixel', detail: 'Solid: opacity above Solid above.' },
        { kind: 'step', title: 'Widen the running left, right, top and bottom to take them in' },
      ],
    },
    { kind: 'decision', title: 'Any solid pixel at all?', no: 'Take the whole picture.' },
    { kind: 'step', title: 'Add the margin on every side', detail: 'It may reach past the picture: that part is clear.' },
    { kind: 'step', title: 'Square it, if asked', detail: 'The short side grows about the box’s middle.' },
    { kind: 'output', title: 'The picture cut to the box', detail: 'Pixels outside the picture are (0, 0, 0, 0).' },
  ],
  pseudocode: `if mode == manual:
  box = clamp(drawn_box or whole_picture, inside picture)
else:                                         # to the solid pixels
  left, right, top, bottom = +inf, -1, +inf, -1
  for y in rows:
    xs = [x for x in row y if alpha(x, y) > threshold]
    if xs: left = min(left, xs.first); right = max(right, xs.last)
           top = min(top, y);          bottom = y
  box = (left, top, right - left + 1, bottom - top + 1) or whole_picture
  box = box grown by margin on every side      # may go past the edge
if square: grow the short side about the middle
out = new picture of box size, all clear
copy the part of the picture inside box into out`,
  sections: [
    {
      heading: 'Why a scan and not a search',
      body: 'The smallest box round the solid pixels is set by only four pixels — the leftmost, rightmost, topmost and bottommost solid ones. One pass over every row, keeping the first and last solid pixel of each, finds them all; nothing cleverer is needed, and nothing faster is possible without skipping pixels.',
    },
    {
      heading: 'Solid, and the threshold',
      body: 'A pixel counts when its opacity is above **Solid above** (0–254). At 0 any pixel that is not completely clear counts, including the faint halo anti-aliasing leaves round a cut-out; raise it to ignore that halo, or a stray almost-invisible speck far from the subject.',
    },
    {
      heading: 'Past the edge',
      body: 'The margin and the squaring can take the box past the picture. That part of the result is clear — `(0, 0, 0, 0)` — so a subject can be centred in a square with room round it even when it touches the picture’s edge.',
    },
  ],
  settings: [
    { name: 'Solid above', effect: 'The opacity a pixel must be above to count as part of the subject.' },
    { name: 'Margin', effect: 'Clear pixels kept round the solid box on every side.' },
    { name: 'Square', effect: 'Grow the short side so the box is square, about its middle.' },
  ],
  cost: 'One pass over the pixels.',
  resources: [
    { title: 'Minimum bounding box', url: 'https://en.wikipedia.org/wiki/Minimum_bounding_box', note: 'The axis-aligned box round a set of points, which is what the solid crop is.' },
    { title: 'Alpha compositing', url: 'https://en.wikipedia.org/wiki/Alpha_compositing', note: 'What opacity (alpha) is, and why a cut-out has a faint halo.' },
  ],
  source: ['packages/shared/src/flows/crop.ts — opaqueBounds, cropRectFor, squared, cropBitmap'],
};

export const RESIZE_GUIDE: AlgorithmGuide = {
  kinds: ['art.resize'],
  title: 'Resizing: resampling through a kernel, across and then down',
  summary:
    'Each pixel of the new picture sits somewhere between pixels of the old one. Its colour is a weighted average of the old pixels near that spot, the weights given by a kernel — one pixel (nearest), a straight-line ramp (bilinear), a Catmull-Rom curve (bicubic) or a windowed sinc (Lanczos). It is done in two passes, across then down, with colours premultiplied by opacity, and when shrinking the kernel is widened so every old pixel is counted.',
  steps: [
    { kind: 'input', title: 'The picture, and the size to make it' },
    { kind: 'decision', title: 'A kernel other than Nearest?', no: 'Nearest: each new pixel copies the one old pixel under its centre. Done.' },
    { kind: 'step', title: 'Premultiply', detail: 'Red, green and blue are multiplied by opacity, so a clear pixel’s colour weighs nothing.' },
    {
      kind: 'loop',
      title: 'For each axis — across, then down',
      steps: [
        { kind: 'step', title: 'Work out the taps for each new position', detail: 'Its centre in old pixels = (i + 0.5) ÷ scale − 0.5; the kernel weighs each old pixel within its radius (times 1 ÷ scale when shrinking); the weights are made to add up to 1.' },
        { kind: 'step', title: 'Each new pixel = Σ weight × old pixel' },
      ],
    },
    { kind: 'step', title: 'Un-premultiply, and round to 0–255' },
    { kind: 'output', title: 'resized.png' },
  ],
  pseudocode: `kernel = { bilinear: tent(radius 1), bicubic: catmull_rom(radius 2),
           lanczos: sinc(x) * sinc(x / 3) (radius 3) }

def taps(from_len, to_len):
  scale  = to_len / from_len
  spread = 1 / scale if scale < 1 else 1          # shrink: widen the kernel
  for i in 0 .. to_len-1:
    centre = (i + 0.5) / scale - 0.5
    js = old positions within kernel.radius * spread of centre
    w[j] = kernel((j - centre) / spread) for j in js
    normalise w to sum 1

src = premultiply(picture)                          # rgb *= alpha
tmp = for each row:    new[x] = Σ w_x[j] * src[j]     # across
out = for each column: new[y] = Σ w_y[j] * tmp[j]     # down
return unpremultiply(out)`,
  sections: [
    {
      heading: 'The kernels',
      body: `- **Nearest** takes the single old pixel under the new one's centre. Blocky — and exactly right for pixel art, where each pixel is a deliberate mark.
- **Bilinear** weighs the two nearest old pixels each way by how close they are (a tent). Soft.
- **Bicubic** uses the Catmull-Rom curve over four pixels each way. It passes exactly through the old pixels and keeps edges crisper than bilinear, with little ringing: the default for drawings.
- **Lanczos** uses sinc(x)·sinc(x/3) over six pixels each way: the sharpest, and it can leave a faint light or dark ring beside a hard edge.`,
    },
    {
      heading: 'Two passes',
      body: 'Every kernel here is separable: weighing a square of pixels is the same as weighing across and then weighing down. Two passes of k taps cost 2k per pixel instead of k², which is the difference between instant and slow for Lanczos.',
    },
    {
      heading: 'Shrinking',
      body: 'Shrinking to a quarter with a kernel two pixels wide would read only one old pixel in four, and a thin line could vanish or flicker depending on where it fell. So when shrinking the kernel is stretched by as much as the picture shrinks: every old pixel contributes to some new one, which is proper area averaging.',
    },
    {
      heading: 'Premultiplied colour',
      body: 'A clear pixel has colour numbers too — often black. Averaged as they are, that black bleeds into the edge of a shape as a dark fringe. Multiplying each colour by its opacity first means a clear pixel contributes nothing to the colour, only to the opacity; dividing back afterwards restores the colour of what was actually there.',
    },
  ],
  settings: [
    { name: 'Scale / size', effect: 'The new size: by a factor, or in pixels (with the height following the width when the shape is kept).' },
    { name: 'Method', effect: 'The kernel: Nearest, Bilinear, Bicubic or Lanczos.' },
  ],
  cost: 'New pixels × kernel taps, twice (once per pass). Lanczos is about three times the work of bilinear.',
  resources: [
    { title: 'Image scaling', url: 'https://en.wikipedia.org/wiki/Image_scaling', note: 'An overview of the methods and their artefacts.' },
    { title: 'Bicubic interpolation', url: 'https://en.wikipedia.org/wiki/Bicubic_interpolation', note: 'Including the Catmull-Rom (a = −0.5) kernel used here.' },
    { title: 'Lanczos resampling', url: 'https://en.wikipedia.org/wiki/Lanczos_resampling', note: 'The windowed-sinc kernel, and why it rings.' },
    { title: 'Premultiplied alpha', url: 'https://en.wikipedia.org/wiki/Alpha_compositing#Straight_versus_premultiplied', note: 'Why colours are multiplied by opacity before blending.' },
  ],
  source: ['packages/shared/src/flows/resize.ts — resizeBitmap, taps, KERNELS, targetSize'],
};

export const PALETTE_GUIDE: AlgorithmGuide = {
  kinds: ['art.palette'],
  title: 'A palette by counting: the commonest colours, kept apart',
  summary:
    'Every pixel is counted, with near-identical colours rounded together. The counted colours are then walked from commonest to rarest: each joins the nearest group it is within the minimum distance of (measured in OKLab, where distance matches what the eye sees), or starts a group of its own until the palette is full. Each group is one mode of the picture, and the palette takes one colour from each — its commonest, or with temperature one nudged towards another member.',
  steps: [
    { kind: 'input', title: 'The picture' },
    {
      kind: 'loop',
      title: 'For each pixel',
      steps: [
        { kind: 'decision', title: 'Opaque enough to have a colour?', detail: 'Opacity above Ignore pixels more transparent than.', no: 'Counted as clear, not as a colour.' },
        { kind: 'step', title: 'Round its colour to the colour precision', detail: 'Only to group it: the group is named after the commonest exact colour in it.' },
        { kind: 'step', title: 'Add one to its group’s count' },
      ],
    },
    { kind: 'step', title: 'Sort the counted colours, commonest first' },
    {
      kind: 'loop',
      title: 'For each counted colour, commonest first',
      steps: [
        { kind: 'step', title: 'Find the nearest bucket', detail: 'OKLab distance ×100, with opacity as one more side.' },
        { kind: 'decision', title: 'Nearer than the minimum distance, or the palette full?', no: 'Start a new bucket with this colour as its seed.' },
        { kind: 'step', title: 'Join that bucket', detail: 'Its count grows by this colour’s count.' },
      ],
    },
    { kind: 'step', title: 'Drop buckets under the smallest share', detail: 'Never the first.' },
    { kind: 'step', title: 'Pick each bucket’s colour', detail: 'Its seed; with temperature, moved that far towards another member, chosen by how common it is, in OKLab.' },
    { kind: 'step', title: 'Lay your edits over it', detail: 'Changed, removed and added colours, kept by the colour they started from.' },
    { kind: 'output', title: 'palette.json, the swatches and the report' },
  ],
  pseudocode: `counts = {}
for pixel in picture (every stride-th):
  if alpha(pixel) <= alpha_floor: transparent += 1; continue
  key = round each channel to precision bits
  counts[key].add(pixel)                  # named later by its commonest exact pixel

buckets = []
for colour in sort(counts, by count desc):
  nearest, d = closest bucket to colour   # OKLab distance x100 (+ opacity)
  if nearest and (d < min_distance or len(buckets) >= wanted):
    nearest.members += colour; nearest.count += colour.count
  else:
    buckets += Bucket(seed = colour)

buckets = [b for b in buckets if b is first or b.count >= min_share * total]
palette = [pick(b, temperature) for b in buckets]
# pick: seed at 0; else mix_oklab(seed, member chosen by count, temperature)
apply the edits made by hand`,
  sections: [
    {
      heading: 'The mode, not the average',
      body: 'Averaging a picture’s colours — as k-means does — gives colours that sit between the real ones: a red jacket against green grass averages towards brown. Counting gives the colours the picture actually uses most. Each palette entry is a colour that really occurs.',
    },
    {
      heading: 'Why a minimum distance',
      body: 'A photograph of a sky has thousands of slightly different blues, and the five commonest are five near-identical blues. So a colour closer than **Minimum distance** to a bucket already started joins it instead of starting another. One bucket is one mode of the picture — one colour family — and its count is the family’s share of the picture.',
    },
    {
      heading: 'OKLab',
      body: 'Distances are measured in OKLab, a colour space built so that equal distances look equally different. In RGB, two dark blues can be far apart in numbers and look the same, while a yellow and a pale green are close in numbers and look different. The scale is ×100: under about 2 is the same colour to the eye; navy to royal blue is about 20; red to green is past 70.',
    },
    {
      heading: 'Rounding, but only for grouping',
      body: 'Colours are rounded to **Color precision** bits a channel before counting — 5 bits is 32 levels — so a photographed wall is one colour rather than thousands. The group is then *named* after the commonest exact colour in it, so the palette never contains a colour that is not in the picture.',
    },
    {
      heading: 'Temperature',
      body: 'At 0 each entry is its bucket’s commonest colour. Above 0 it moves that fraction of the way towards another member of the bucket, picked at random weighted by count (from a fixed seed, so it repeats). The blend is done in OKLab, so it stays within the family instead of greying out.',
    },
  ],
  settings: [
    { name: 'Colors', effect: 'How many buckets can be started: the most entries the palette has.' },
    { name: 'Minimum distance', effect: 'How far apart (OKLab ×100) two entries must be. Higher gives more distinct colours.' },
    { name: 'Temperature', effect: 'How far each entry moves from its bucket’s commonest colour towards another member.' },
    { name: 'Color precision', effect: 'Bits kept per channel when grouping pixels. Lower groups more.' },
    { name: 'Ignore pixels more transparent than', effect: 'Pixels this clear are counted as clear, not as a colour.' },
    { name: 'Drop groups under', effect: 'Buckets smaller than this share of the picture are left out.' },
  ],
  cost: 'One pass over the pixels to count, then distinct colours × buckets to group — a few thousand by a few dozen.',
  resources: [
    { title: 'OKLab', url: 'https://bottosson.github.io/posts/oklab/', note: 'Björn Ottosson’s description of the colour space, and why it was made.' },
    { title: 'Color quantization', url: 'https://en.wikipedia.org/wiki/Color_quantization', note: 'The wider problem, and the averaging methods this avoids.' },
    { title: 'Leader clustering', url: 'https://en.wikipedia.org/wiki/Cluster_analysis', note: 'Taking items in order and joining the first cluster close enough — the grouping used here, in count order.' },
  ],
  source: ['packages/shared/src/flows/palette.ts — countColors, quantise, derivePalette, pickFromBucket, colorDistance, toOklab'],
};

export const PALETTE_FILTER_GUIDE: AlgorithmGuide = {
  kinds: ['art.palette.filter'],
  title: 'Filtering against a palette: keep what matches, or snap everything to it',
  summary:
    'Every pixel is compared with every palette colour by hue, saturation, brightness and opacity. Keeping leaves a pixel exactly as it was if it is within the tolerance of some palette colour, and clears it otherwise. Snapping replaces every pixel with its nearest palette colour — colour and opacity — and can then give chunks smaller than a minimum size the colour of a neighbouring chunk.',
  steps: [
    { kind: 'input', title: 'The picture and the palette' },
    {
      kind: 'loop',
      title: 'For each distinct colour in the picture',
      steps: [{ kind: 'step', title: 'Find the nearest palette entry, and how far', detail: 'Distance in the HSB cone, with opacity as one more side (100 = black to white, or clear to solid).' }],
    },
    { kind: 'decision', title: 'Snapping?', no: 'Keeping: a pixel within the tolerance stays exactly as it was; any other becomes (0, 0, 0, 0).' },
    { kind: 'step', title: 'Every pixel becomes its nearest entry', detail: 'Exactly: the palette’s colour and opacity.' },
    { kind: 'decision', title: 'A smallest chunk set?', no: 'Done.' },
    {
      kind: 'loop',
      title: 'For each chunk smaller than it, smallest first',
      detail: 'A chunk: touching pixels (corners included) of one entry.',
      steps: [{ kind: 'step', title: 'Take the colour of a chunk it touches', detail: 'Of those, the entry nearest its own pixels’ original colours. It then joins that chunk.' }],
    },
    { kind: 'output', title: 'filtered.png, and a count of each entry' },
  ],
  pseudocode: `def hsba(c):        # a point in the HSB cone, plus opacity
  chroma = max(r,g,b) - min(r,g,b); v = max(r,g,b)
  return (chroma*cos(hue), chroma*sin(hue), v, alpha)

def distance(p, q):
  if p.alpha == 0 or q.alpha == 0: return 100 * |p.alpha - q.alpha|
  return 100 * hypot(p.x-q.x, p.y-q.y, p.v-q.v, p.alpha-q.alpha)

for each distinct colour c: nearest[c], d[c] = min over entries of distance

if mode == keep:
  out[p] = pixel[p] if d[colour(p)] <= tolerance else (0,0,0,0)
else:  # snap
  entry[p] = nearest[colour(p)]
  if min_chunk > 1:
    for chunk in chunks(entry) sorted by size, while size < min_chunk:
      touching = entries of chunks bordering it
      chunk takes argmin over touching of Σ distance(original pixel, entry)
  out[p] = palette[entry[p]]           # colour and opacity, exactly`,
  sections: [
    {
      heading: 'Why hue, saturation and brightness',
      body: 'The distance is taken in the HSB cone: hue is an angle, saturation times brightness the distance out from the middle, brightness the height. Because the cone narrows to a point at black, hue matters only as much as a colour has any — two greys are not pushed apart by the hue numbers rounding gives them, and a dark red is nearer black than a bright red is. Opacity is measured beside it; a fully clear pixel has no colour, so against it only opacity counts.',
    },
    {
      heading: 'Keep is exact',
      body: 'Keeping never recolours or fades anything: a pixel that matches comes out with exactly its own colour and opacity, and one that does not comes out clear. At **Tolerance** 0 only exact matches are kept, which is what flat artwork drawn from the palette needs; a photograph needs room.',
    },
    {
      heading: 'Snap is exact too',
      body: 'Snapping always takes the nearest entry, whatever the distance, and writes it exactly — so a palette of five colours and a clear one gives a picture with six values in it and no others. An anti-aliased edge pixel becomes the colour or clear depending which it is nearer, never a neighbouring colour.',
    },
    {
      heading: 'Smallest chunk',
      body: 'Snapping a photograph leaves specks: single pixels that happened to be nearer another entry. Chunks under **Smallest chunk** pixels take the colour of a chunk they touch — the touching entry nearest to what their pixels originally were, not simply the one surrounding them most. Smallest first, so a speck inside a speck is settled before the one round it; a chunk that takes a neighbour’s colour joins it, and they grow together.',
    },
  ],
  settings: [
    { name: 'Mode', effect: 'Keep only palette colours, or snap every pixel to the palette.' },
    { name: 'Tolerance', effect: 'Keep only: how far a pixel may be from a palette colour and still count as it.' },
    { name: 'Smallest chunk', effect: 'Snap only: chunks smaller than this take a neighbouring chunk’s colour.' },
  ],
  cost: 'Distinct colours × palette entries for the matching, one pass over the pixels to write, and a flood over the pixels for the chunks.',
  resources: [
    { title: 'HSL and HSV', url: 'https://en.wikipedia.org/wiki/HSL_and_HSV', note: 'The hue–saturation–brightness model, and the cone it is drawn as.' },
    { title: 'Connected-component labelling', url: 'https://en.wikipedia.org/wiki/Connected-component_labeling', note: 'How the chunks are found.' },
  ],
  source: ['packages/shared/src/flows/paletteFilter.ts — hsbaOf, hsbaDistance, mergeSmallChunks'],
};

export const CUTOUT_GUIDE: AlgorithmGuide = {
  kinds: ['art.cutout'],
  title: 'Cutting out: fills, cuts and regions replayed into a mask',
  summary:
    'The mask is never painted: it is rebuilt from the list of things you did, in the order you did them. Each fill floods out from its click to every neighbour within its tolerance of the clicked colour, stopping at cut lines; each region takes or gives back everything inside its outline. Then erase cuts are applied, small islands dropped, the mask grown or shrunk, and its edge feathered.',
  steps: [
    { kind: 'input', title: 'The picture, and your fills, cuts and regions' },
    { kind: 'step', title: 'Draw the cut lines as barriers', detail: 'Each a smooth curve through its points, the cut width wide.' },
    {
      kind: 'loop',
      title: 'For each fill and region, in the order made',
      steps: [
        { kind: 'decision', title: 'A fill?', no: 'A region: fill its outline by scanline (even-odd) and set everything inside to in or out.' },
        { kind: 'step', title: 'Flood from the click', detail: 'Take each neighbour (4 or 8 ways) within the tolerance of the clicked pixel’s colour, in OKLab; never cross a barrier.' },
        { kind: 'step', title: 'Set what it reached to in (include) or out (exclude)', detail: 'A later one covers an earlier one.' },
      ],
    },
    { kind: 'step', title: 'Apply erase cuts', detail: 'Everything under them goes out.' },
    { kind: 'step', title: 'Drop islands', detail: 'Pieces smaller than Drop islands under.' },
    { kind: 'step', title: 'Grow or shrink', detail: 'A pixel joins if any neighbour is in (grow), or leaves if any is out (shrink), once per pixel of Grow.' },
    { kind: 'step', title: 'Feather', detail: 'A box blur of the edge, three times over — close to a Gaussian.' },
    { kind: 'output', title: 'cutout.png, and the mask' },
  ],
  pseudocode: `blocked = rasterise(cut lines, width = cut width)      # barriers
inside = zeros
for object in fills_and_regions sorted by when made:
  if object is region:
    area = scanline_fill(outline(object))                # even-odd
  else:                                                  # a fill
    target = colour at object.click
    area = flood(from click, while oklab(pixel, target) <= tolerance
                 and not blocked, neighbours = 4 or 8)
  inside[area] = 1 if object.include else 0             # last one wins
inside[under erase cuts] = 0
drop connected pieces smaller than min_island
repeat |grow| times: dilate (grow > 0) or erode (grow < 0)
alpha = box_blur³(inside, feather) if feather else inside
cutout = picture with alpha`,
  sections: [
    {
      heading: 'Derived, never painted',
      body: 'What is stored is a list: fills dropped, lines cut, regions drawn. The mask is recomputed from it on every change. So each of them is a real object you can select, change or delete — deleting a fill takes its area with it — rather than a stroke of paint that is permanent the moment it lands.',
    },
    {
      heading: 'Tolerance against the clicked colour',
      body: 'A flood takes a neighbour when it is within the tolerance of the **clicked** pixel’s colour, not of the pixel beside it. Comparing neighbour to neighbour lets a gradient walk across the whole picture one tiny step at a time — the classic magic wand that selects everything. Colour distance is in OKLab (×100), so the tolerance means the same for dark and light colours. Each fill has its own tolerance, since the edge of a face and the edge of a sky need different ones.',
    },
    {
      heading: 'Order',
      body: 'Fills and regions are applied in the order they were made: an exclude after an include takes a bite out of it, and an include after that puts some back. That is what clicking feels like, so it is what the list means.',
    },
    {
      heading: 'Cuts',
      body: 'A cut is a smooth curve (Catmull-Rom through its points; two points make a straight cut) drawn as a barrier a fill cannot cross — at least a pixel wide, because a one-pixel line leaks through diagonal gaps. An erase cut also clears what it covers, after everything else.',
    },
    {
      heading: 'Cleaning up',
      body: '**Drop islands** removes pieces of the mask smaller than a size; **Grow** dilates (or with a negative value erodes) the mask a pixel at a time; **Feather** blurs its edge with a box blur run three times, which is very close to a Gaussian blur and much cheaper.',
    },
  ],
  settings: [
    { name: 'Tolerance', effect: 'The default tolerance for a new fill (each fill keeps its own).' },
    { name: 'Diagonal', effect: 'Whether a fill spreads to the 8 neighbours or only the 4.' },
    { name: 'Cut width', effect: 'How wide a new cut is.' },
    { name: 'Drop islands under', effect: 'Pieces of the mask smaller than this are dropped.' },
    { name: 'Grow', effect: 'Pixels added round the mask (negative: taken off).' },
    { name: 'Feather', effect: 'How soft the mask’s edge is, in pixels.' },
  ],
  cost: 'Each fill visits the pixels it takes once; the clean-up steps are a pass or a few over the picture.',
  resources: [
    { title: 'Flood fill', url: 'https://en.wikipedia.org/wiki/Flood_fill', note: 'The fill, done with an explicit stack so a large region cannot overflow.' },
    { title: 'Scanline polygon fill (even–odd rule)', url: 'https://en.wikipedia.org/wiki/Even%E2%80%93odd_rule', note: 'How a region’s outline is filled.' },
    { title: 'Mathematical morphology', url: 'https://en.wikipedia.org/wiki/Mathematical_morphology', note: 'Dilation and erosion: what Grow does.' },
    { title: 'Box blur', url: 'https://en.wikipedia.org/wiki/Box_blur', note: 'Three box blurs approximate a Gaussian: what Feather does.' },
    { title: 'Centripetal Catmull–Rom spline', url: 'https://en.wikipedia.org/wiki/Centripetal_Catmull%E2%80%93Rom_spline', note: 'The smooth curve cut lines and regions are drawn through.' },
  ],
  source: ['packages/shared/src/flows/cutout.ts — buildMask, floodFrom, blockedBy, fillOutline, grow, feather'],
};

export const VIDEO_BACKGROUND_GUIDE: AlgorithmGuide = {
  kinds: ['art.video.background'],
  title: 'A background from a video: lined up, what never changes, and what moved rebuilt patch by patch',
  summary:
    'The clip’s frames are read exactly as the file holds them. They are lined up with each other first, so a camera that shakes or drifts does not count as change. Every pixel whose colour stays within the tolerance in every frame is background. What changed is rebuilt a patch at a time: each frame’s version of the patch is grouped with the others it matches, and the biggest group — frames side by side in it counting more — is the background there, if it holds at least the agreement share of the frames. Anything left is clear, for marking by hand.',
  steps: [
    { kind: 'input', title: 'The video' },
    { kind: 'step', title: 'List its frames', detail: 'When each frame is shown, from the file’s own packets — not a grid worked out from a frame rate, which a clip recorded unevenly does not keep to.' },
    { kind: 'step', title: 'Pick the frames to read', detail: 'So many in all, spread through them by count; or so many a second, each the frame nearest that time. None twice.' },
    { kind: 'step', title: 'Read each one', detail: 'Decoded from the file at its own time, no bigger than all the frames together fit in 40 million pixels.' },
    {
      kind: 'loop',
      title: '1. Follow the camera — for each frame after the first',
      steps: [
        { kind: 'step', title: 'Search near where the frame before it sat', detail: 'On a picture halved four times first, then finer and finer: up to “Most it moves” pixels away.' },
        { kind: 'step', title: 'Score a shift by the mean brightness difference, each pixel’s capped', detail: 'Every pixel counts, so the edges of flat colours do; the cap keeps a character moving in front from pulling it.' },
        { kind: 'decision', title: 'Moved a quarter of the picture from the frame it is followed from?', no: 'Keep following from that frame.' },
        { kind: 'step', title: 'Follow the next frames from this one' },
      ],
    },
    { kind: 'step', title: 'Put the background where the frames were in the middle', detail: 'Each frame’s offset is from there.' },
    {
      kind: 'loop',
      title: '2. For each pixel',
      steps: [
        { kind: 'step', title: 'Its colour in every frame that sees it, lined up' },
        { kind: 'decision', title: 'Within the tolerance in all of them?', no: 'It changed: clear for now.' },
        { kind: 'step', title: 'Background: the average of them' },
      ],
    },
    {
      kind: 'loop',
      title: '3. For each patch with pixels that changed',
      steps: [
        { kind: 'step', title: 'The frames that see all of it' },
        { kind: 'step', title: 'Group their versions of it', detail: 'A version joins the first group whose first version it matches on 90% of the changed pixels, within the tolerance; or starts a group.' },
        { kind: 'step', title: 'Score each group', detail: 'One for each frame in it, and half again for each frame read just after another of its own.' },
        { kind: 'decision', title: 'Is the best group at least the agreement share of the frames?', no: 'Nothing is common enough: the patch’s changed pixels stay clear.' },
        { kind: 'step', title: 'Fill the changed pixels from that group’s frames', detail: 'The average of those that match the group’s first version there.' },
      ],
    },
    {
      kind: 'loop',
      title: 'For each mark, in the order made',
      steps: [{ kind: 'step', title: 'Paint in: take its frame’s pixels, moved by where the background sits in that frame; erase: clear them' }],
    },
    { kind: 'output', title: 'background.png, and the report with each frame’s offset' },
  ],
  pseudocode: `times  = pick(frame_times(clip), so_many_in_all or so_many_a_second)
frames = [decode(clip, t) for t in times]          # at the budgeted size

# 1. follow the camera
ref, ref_at = frames[0], (0, 0); offset[0] = (0, 0)
for f in frames[1:]:
  guess = offset[f-1] - ref_at
  s = argmin over shifts within most_it_moves of guess, coarse to fine:
        mean(min(|bright(f, x + shift) - bright(ref, x)|, 48))
  offset[f] = ref_at + s
  if |s| > a quarter of the picture: ref, ref_at = f, offset[f]
offset -= median(offset)                            # the frames' middle

# 2. what never changes
for each pixel p:
  seen = [f[p + offset[f]] for f in frames if inside]
  if range(seen) <= tolerance: background[p] = mean(seen)
  else: changed[p] = true

# 3. what moved, patch by patch
for each patch P with changed pixels:
  versions = [f[P + offset[f]] for f seeing all of P]
  groups = []
  for v in versions:
    g = first group whose first version matches v on 90% of P's changed pixels
    if g: g.add(v) else: groups += Group(v)
  score(g) = len(g) + 0.5 * (frames in g just after another frame in g)
  best = max score
  if len(best) / len(versions) >= agreement:
    for p in changed pixels of P:
      background[p] = mean(v[p] for v in best if v[p] ~ best.first[p])

for mark in marks (in order):
  for q in mark's region or stroke on its frame f:
    p = q - offset[f]
    background[p] = f[q] if include else clear`,
  sections: [
    {
      heading: 'Following the camera',
      body: 'A hand-held shot, or one that pans, moves the whole picture between frames, and a background compared pixel by pixel would then change everywhere. So each frame is lined up first: the shift that makes it match the frame it is followed from best. Every pixel counts in the match — a cartoon background of flat colours matches at many shifts except along its edges, and leaving out the pixels that match worst, as a trimmed mean would, leaves out exactly those edges — but each pixel’s difference is capped, so a character moving in front costs about the same at any shift and cannot pull the frames out of line. The search starts on a small copy of the picture and is made exact on bigger and bigger ones, and it starts from where the frame before sat, so it follows a pan however far it goes. Frames are matched against one frame rather than each against the one before, so a drift of a fraction of a pixel a frame adds up instead of rounding away; once the picture has moved a quarter of its width from that frame, the frames after are followed from the newest one.',
    },
    {
      heading: 'What never changes',
      body: 'With the frames lined up, a pixel whose colour stays within the **Tolerance** in every frame that sees it is background, as the average of its colours. That is most of a shot with a still background. A pixel that changes at all is left clear, for the next step to rebuild.',
    },
    {
      heading: 'Rebuilding what moved, patch by patch',
      body: 'Where something moved, each frame shows either the background or the thing in front of it. Taking each pixel’s commonest colour on its own mixes pixels from different frames into a background no frame ever showed, and lets the edges of a character through. Instead the picture is cut into square **patches**, and each frame’s version of a patch is compared with the others: versions that match on nearly all of the changed pixels are one group. The background is the biggest group — it is what that patch shows most often — and frames read one after another in it count half again, because a background seen in one frame is seen in the frames beside it, while a character passing over it is somewhere else a moment later. The patch’s changed pixels are filled from that group’s frames, so each patch is one coherent picture.',
    },
    {
      heading: 'Agreement',
      body: 'A patch is rebuilt only if its best group holds at least **Agreement** of the frames that see it. Below that no one picture of the patch is common enough to trust, and what changed in it is left clear rather than guessed. Lower it for a character that covers part of the background most of the time; raise it if a character that lingered is taken for the background.',
    },
    {
      heading: 'Putting back by hand',
      body: 'A character that never moves off part of the background leaves it clear, or wrong. Pick a frame where that part can be seen and paint it in, or draw round it: those pixels are taken from that frame, moved by where the background sits in that frame. The eraser takes pixels out. Marks are laid on in the order made, so a later erase clears an earlier paint.',
    },
    {
      heading: 'Where the background sits',
      body: 'The background is drawn where the frames were in the middle, so it lines up with a typical frame. The report lists, for every frame read, how far right and down that frame’s picture is from it: a frame’s pixel at (x + right, y + down) shows the background’s (x, y). That is what puts a character cut from a frame back in its place over the background.',
    },
  ],
  settings: [
    { name: 'Frames in all / a second', effect: 'How many frames are compared. More frames make the groups surer, and each is read smaller.' },
    { name: 'Follow the camera', effect: 'Line the frames up before comparing them. Off for a shot known to be still.' },
    { name: 'Most it moves between frames', effect: 'How far the search looks from where the frame before sat.' },
    { name: 'Tolerance', effect: 'How far a colour may change and still count as not changing.' },
    { name: 'Rebuild what moved from patches', effect: 'Off leaves every pixel that changed clear.' },
    { name: 'Patch', effect: 'The side of the square patches what moved is rebuilt from.' },
    { name: 'Agreement', effect: 'The share of frames a patch’s best group must hold for the patch to be rebuilt.' },
    { name: 'Brush', effect: 'The radius of the brush that paints or erases.' },
  ],
  cost: 'Lining up: a few shifts per frame on each level, each over the picture — about frames × pixels × 15. Still pixels: pixels × frames. Patches: for each that changed, frames × groups × up to 96 pixels. A few seconds of frames take a second or two, worked a slice at a time so the page stays responsive.',
  resources: [
    { title: 'Background subtraction', url: 'https://en.wikipedia.org/wiki/Background_subtraction', note: 'The wider problem of separating a still background from what moves over it.' },
    { title: 'Image registration', url: 'https://en.wikipedia.org/wiki/Image_registration', note: 'Lining pictures of the same scene up with each other.' },
    { title: 'Pyramid (image processing)', url: 'https://en.wikipedia.org/wiki/Pyramid_(image_processing)', note: 'Searching coarse to fine on halved copies of a picture.' },
    { title: 'Mode (statistics)', url: 'https://en.wikipedia.org/wiki/Mode_(statistics)', note: 'The most common value: what each patch’s biggest group is.' },
  ],
  source: [
    'packages/shared/src/flows/videoBackground.ts — steadyWork, backgroundWork, applyMarks, backgroundInFrame, backgroundFrameSize',
    'packages/shared/src/flows/clipFrames.ts — pickFrameTimes, gridFrameTimes',
    'packages/client/src/components/common/frames.ts — openVideoFrames, useVideoFrameTimes',
  ],
  tryIt: 'Read the frames, then pick one below the picture: the green tint over it is what is background already, lined up with that frame. Untick Rebuild what moved to see what never changed on its own.',
};
