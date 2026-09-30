import type { AlgorithmGuide } from '../guides';

export const LINES_GUIDE: AlgorithmGuide = {
  kinds: ['art.lines'],
  title: 'Finding lines: two sharp changes, close together, along a stroke',
  summary:
    'A drawn line is a narrow band of its own colour with a sharp change into it and a sharp change out of it. Walking across the picture in four directions, every run of one colour is tested for exactly that; the pixels that pass are joined into patches, and a patch only counts if it is several times longer than it is wide. Each line pixel gets a confidence from how sharp its edges are and how far past that ratio its patch reaches, and a width from the narrowest walk across it.',
  steps: [
    { kind: 'input', title: 'The picture', detail: 'Every pixel, as red, green, blue and opacity.' },
    {
      kind: 'loop',
      title: 'For each of four walks — across, down, and both diagonals',
      steps: [
        {
          kind: 'loop',
          title: 'For each chunk of the picture',
          detail: 'Chunk × chunk pixels, read with a margin round it so a line on the border still has its colours either side.',
          steps: [
            {
              kind: 'loop',
              title: 'For each straight walk through the chunk',
              steps: [
                { kind: 'step', title: 'Cut the walk into runs of one colour', detail: 'A run ends where the next pixel jumps by the Sharp change or more, or where the colour has drifted more than the Flatness from the run’s average.' },
                { kind: 'step', title: 'Fold soft edges away', detail: 'A run of 1–2 pixels whose colour lies between its neighbours’ is anti-aliasing: it joins the edge it softens.' },
                {
                  kind: 'loop',
                  title: 'For each run with runs either side',
                  steps: [
                    { kind: 'decision', title: 'Narrow enough?', detail: 'No wider than Widest line.', no: 'An area, not a line.' },
                    { kind: 'decision', title: 'A sharp change in, and a sharp change out?', no: 'An edge (one change) or a gradient (no sharp change).' },
                    { kind: 'decision', title: 'A colour of its own?', detail: 'Not a blend of the colours either side, and at least the Sharp change away from each.', no: 'A soft edge, or a smudge between two areas.' },
                    { kind: 'step', title: 'Mark its pixels as a crossing', detail: 'With its width across, and the softer of its two edges.' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      kind: 'loop',
      title: 'For each of the four walks again, and each chunk',
      steps: [
        { kind: 'step', title: 'Join crossings into patches', detail: '8-connected neighbours of the same colour, reaching up to half a chunk past the chunk.' },
        { kind: 'decision', title: 'Longer than wide by the ratio?', detail: 'Length along the line ÷ mean width.', no: 'A speck or a dash: not a line.' },
        { kind: 'step', title: 'Score each pixel', detail: '½ × sharpness + ½ × reach, and at least 20%. Keep the best score and the narrowest width over the four walks.' },
      ],
    },
    { kind: 'output', title: 'lines.png', detail: 'Black where there is no line; red for thin, blue for wide; brighter the surer.' },
  ],
  pseudocode: `for each walk direction d in [across, down, ↘, ↗]:
  crossings_d = empty map                   # pixel → (width, sharpness)
  for each chunk c:
    for each straight walk w through (c + margin) in direction d:
      runs = cut w where |step| >= contrast or |pixel - run.mean| > flatness
      runs = fold runs of 1–2 px that are a blend of their neighbours
      for each run r with a run before (b) and after (a):
        if width(r) > maxWidth:                 continue   # an area
        if not sharp(b→r) or not sharp(r→a):    continue   # an edge or a gradient
        if isBlend(b, r, a):                    continue   # a soft edge
        if dist(r, b) < contrast or dist(r, a) < contrast: continue
        for p in r inside c:
          crossings_d[p] = (width(r), min(sharp(b→r), sharp(r→a)))

  for each chunk c:
    for each patch P of crossings_d in c        # 8-connected, same colour,
                                                # reaching half a chunk past c
      ratio = length_along_line(P) / mean_width(P)
      if ratio < minRatio: continue             # a speck, not a stroke
      for p in P inside c:
        sharpness = min(1, crossings_d[p].sharp / (contrast * 2.5))
        reach     = min(1, ratio / (minRatio * 2))
        score     = max(0.2, 0.5 * sharpness + 0.5 * reach)
        confidence[p] = max(confidence[p], score)
        width[p]      = min(width[p], crossings_d[p].width * stepLength(d))`,
  sections: [
    {
      heading: 'What makes a line a line',
      body: `Look across a drawn line and the colour does three things: it is one colour, it changes **sharply** to the line's colour, and a few pixels later it changes **sharply** again to the colour beyond. Everything else that is not a line fails one of those:

- **An edge** — sky meeting grass — has one change, not two.
- **A gradient** changes a little at every pixel, never sharply.
- **A soft edge** has a pixel or two part-way between the colours either side. That pixel is a *blend*, not a colour of its own, so it is folded into the edge it softens; otherwise every anti-aliased edge would look like a one-pixel line.
- **A speck** or a short dash can pass all of that, which is why the last test is about shape: a line is longer than it is wide.`,
    },
    {
      heading: 'Why four walks',
      body: `A walk only sees a line it crosses. Walking left to right crosses upright lines; walking down crosses flat ones; the diagonal walks cross lines at 45°. Each pixel keeps the **best** score any walk gave it, and the **narrowest** width, because the narrowest crossing is the one most nearly straight across the line. A diagonal step is √2 pixels long, so widths and lengths from the diagonal walks are scaled by √2.`,
    },
    {
      heading: 'Runs, jumps and drift',
      body: `A walk is cut into runs of one colour. A run ends in one of two ways:

- a **jump**: the next pixel differs from this one by at least the **Sharp change** — that is the "sharp change" a line needs on each side;
- a **drift**: the pixel has wandered more than the **Flatness** from the run's average colour, without any single jump. This is how a gradient becomes a string of runs with no sharp change between them, so none of them can be a line.

Colour differences are measured over red, green, blue and opacity together, scaled so black against white is 100.`,
    },
    {
      heading: 'Longer than wide',
      body: `The crossings a walk found are joined into **patches**: neighbouring pixels (including diagonal neighbours) that were crossings and are the same colour. A patch's length is measured *along* the line — for the walk across, that is up and down — and its width is the average width of its crossings. The patch must be at least **Longer than wide by** times longer than it is wide. The patch may reach half a chunk beyond its own chunk, so a line crossing a chunk border is not measured short.`,
    },
    {
      heading: 'The confidence',
      body: `A line pixel's confidence from one walk is half **sharpness** and half **reach**:

- sharpness = the softer of its two edges ÷ (2.5 × Sharp change), at most 1 — an edge two and a half times the least that counts is as sharp as it gets;
- reach = the patch's ratio ÷ (2 × the ratio needed), at most 1 — a line twice as long for its width as it needs to be is as long as it gets.

It is never below 20% once the pixel has passed every test, so a faint but real line still shows.`,
    },
    {
      heading: 'Chunks',
      body: `The picture is read in square chunks, each with a margin of the widest line plus three pixels, so the colours either side of a line on the border are seen. Chunks keep each walk short and local: a walk across a whole large picture would see so many colours that a small line could be merged into something far away.`,
    },
    {
      heading: 'What it gets wrong',
      body: `- A line drawn with a soft brush, fading in over several pixels, has no sharp change: raise **Flatness** and lower **Sharp change**, or it is not found.
- Two lines closer together than their width are read as one wider line.
- A thin area between two others — a narrow stripe of a pattern — is a line by this definition, because it is one.`,
    },
  ],
  settings: [
    { name: 'Sharp change', effect: 'The least jump between two neighbouring pixels that counts as a sharp change. Lower finds fainter lines, and takes in more texture.' },
    { name: 'Flatness', effect: 'How far a pixel may drift from its run’s average colour and stay in the run. Higher lets a line with a little shading stay one run; too high merges a gradient into one run.' },
    { name: 'Widest line', effect: 'The widest run that can be a line. Wider is an area.' },
    { name: 'Longer than wide by', effect: 'How many times longer than wide a patch must be. Higher drops dashes and specks; too high drops short strokes.' },
    { name: 'Chunk size', effect: 'The side of the squares the picture is read in. Smaller is more local; a line must still fit its length within about a chunk and a half.' },
  ],
  cost: 'Each pixel is visited once per walk (four times) for the runs, and again when patches are joined: time grows with the number of pixels. A million pixels take well under a second.',
  resources: [
    { title: 'Edge detection', url: 'https://en.wikipedia.org/wiki/Edge_detection', note: 'The classic problem this is a variation on: here an edge alone is exactly what is not wanted.' },
    { title: 'Ridge detection', url: 'https://en.wikipedia.org/wiki/Ridge_detection', note: 'Finding thin bright or dark bands — the same idea, done with image derivatives instead of runs.' },
    { title: 'Run-length encoding', url: 'https://en.wikipedia.org/wiki/Run-length_encoding', note: 'Cutting a row of pixels into runs of one value, which is the first step of each walk.' },
    { title: 'Connected-component labelling', url: 'https://en.wikipedia.org/wiki/Connected-component_labeling', note: 'How crossings are joined into patches (8-connectivity).' },
    { title: 'Spatial anti-aliasing', url: 'https://en.wikipedia.org/wiki/Spatial_anti-aliasing', note: 'Why soft edges have blended pixels, and so why blends are folded away.' },
  ],
  source: ['packages/shared/src/flows/lines.ts — detectLines, explainLinePixel, crossingChecks, isBlend'],
  tryIt: 'Turn on **Explain a pixel** over the picture and click any pixel: the detection is run again with a note kept of it, and every walk, run, test and number is shown.',
};
