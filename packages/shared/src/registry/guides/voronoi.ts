import type { AlgorithmGuide } from '../guides';

export const VORONOI_GUIDE: AlgorithmGuide = {
  kinds: ['art.voronoi'],
  title: 'A picture as a Voronoi diagram: nodes placed and colored to make the diagram as like the picture as it can be',
  summary:
    'A Voronoi diagram of so many nodes gives every pixel the color of the node nearest it. What is made small is the difference between the diagram and the picture: the sum, over every pixel, of the squared difference in red, green, blue and opacity. For nodes where they are, each node’s best color is the average of its cell (with a palette, the palette color nearest that average); so the work is in where the nodes go. They start where the picture has detail, then each in turn tries a step left, right, up and down and keeps one that makes the whole diagram fit better — worked out exactly, but only round the node — and every other round the nodes that do least are moved to where the fit is worst.',
  steps: [
    { kind: 'input', title: 'The picture, and a palette if one is wired in' },
    { kind: 'step', title: 'Make it smaller to work on', detail: 'About 64 pixels a node, between 40 000 and 300 000 pixels, each the average of the pixels it covers; colors premultiplied by opacity.' },
    { kind: 'step', title: 'Scatter the nodes', detail: 'More where the picture has edges (a Sobel filter), some everywhere; stratified, so evenly spread through the detail. Seeded, so the same every time.' },
    { kind: 'step', title: 'Label every pixel with its nearest node', detail: 'A grid of buckets: only the buckets round a pixel are looked in. Each cell keeps the sums of its pixels and of their squares.' },
    {
      kind: 'loop',
      title: 'For each round',
      steps: [
        {
          kind: 'loop',
          title: 'For each node, in a shuffled order',
          steps: [
            { kind: 'step', title: 'Try a step each way', detail: 'Move the node, move the pixels that change cell (only round it), and work out each changed cell’s best color and error from its sums.' },
            { kind: 'decision', title: 'Does a step make the diagram fit better?', no: 'Put it back and go on to the next node.' },
            { kind: 'step', title: 'Keep the best step, and try it again', detail: 'Up to four steps the same way.' },
          ],
        },
        { kind: 'decision', title: 'Every other round: are there nodes doing little?', no: 'Go on.' },
        { kind: 'step', title: 'Move them to where the fit is worst', detail: 'A node whose cell is like its neighbour’s (the least Ward cost of joining them) is taken out and put down in the cell with the most error, at the middle of the part of it that fits worst — kept only if the diagram fits better for it.' },
        { kind: 'step', title: 'Make the steps smaller', detail: '× 0.72 a round.' },
      ],
    },
    { kind: 'step', title: 'At the picture’s own size', detail: 'Every pixel labelled again with its nearest node, and each node’s color fitted again from the picture’s own pixels.' },
    { kind: 'step', title: 'As shapes, if asked', detail: 'Each cell exactly: the picture’s rectangle cut by the line halfway to every node near enough. Same-colored cells that share an edge are joined; an area inside another is a hole in it.' },
    { kind: 'output', title: 'voronoi.png, vector.json and voronoi.svg, nodes.json and the report' },
  ],
  pseudocode: `work = shrink(picture, about 64 pixels a node)   # premultiplied RGBA
nodes = scatter(n, density = edges(work) + some)  # seeded
label every pixel with its nearest node           # bucket grid
for each cell c: S[c] = Σ pixel, Q[c] = Σ |pixel|², N[c] = pixels
error(c) = Q - |S|²/N                       # its best color: the average S/N
         = Q + min over palette e of (N|e|² - 2 e·S)   # with a palette
step = 0.35 × spacing
repeat rounds times:
  for node i in shuffle(nodes):
    for d in (→, ←, ↓, ↑):
      move i by step·d; move only the pixels that change cell
      Δ = Σ error(changed cells) after - before; undo
    keep the best d while Δ < 0, up to 4 times
  every other round:
    for the worst cells w (most error), the cheapest nodes k
      (empty, or least Ward cost N_a N_b/(N_a+N_b)·|c_a - c_b|² to join a neighbour):
      take k out; put it at the middle of w's worse-than-average pixels
      keep it if the total error went down, else undo
  step = max(0.5, step × 0.72); label again
at full size: label again; color = average (or nearest palette color)
shapes: cell(i) = rectangle ∩ { x : |x - p_i| ≤ |x - p_j| } for the near j`,
  sections: [
    {
      heading: 'What is made small',
      body: 'The diagram is compared with the picture pixel by pixel: for each, the squared difference of red, green, blue and opacity, with the colors premultiplied by opacity so a see-through pixel’s color counts for nothing. Squared differences make the best color for a cell easy — the average of its pixels — and make the error of a cell a sum that can be kept as the pixels come and go: with S the sum of a cell’s pixels, Q the sum of their squared lengths and N how many, its error is Q − |S|²/N. With a palette, the error of giving the cell entry e is Q + N|e|² − 2 e·S, smallest for the palette color nearest the cell’s average.',
    },
    {
      heading: 'Where the nodes go',
      body: 'For colors fitted to where the nodes are, the error is a function of the nodes’ places, but not a smooth one — a node’s step moves whole pixels from cell to cell. So each move is tried and measured rather than worked out from a gradient: the node is put in its new place, only the pixels round it are looked at (those of its cell now nearer another node, and those of other cells now nearer it), and the error of each cell that changed is worked out again from its sums. A move that pays is kept; one that does not is undone from a log of what it moved. Steps start at a third of the distance between nodes and shrink each round, so the nodes settle.',
    },
    {
      heading: 'Moving the nodes that do least',
      body: 'Nudging only goes downhill: a node that started where it is not needed stays there. So every other round, the nodes whose cells cost least to lose — none, if empty, otherwise the Ward cost of joining the cell to a neighbour, which is small when the neighbour is the same color — are taken out and put where the fit is worst: in the cell with the most error, at the weighted middle of its pixels that fit worse than its average. Each is kept only if the whole diagram fits better for it.',
    },
    {
      heading: 'Smaller, then full size',
      body: 'The fitting is done on the picture made smaller — about 64 pixels a node — because every move is measured in pixels. At the end the nodes are scaled back, every pixel of the picture at its own size is labelled with its nearest node, and each node’s color is fitted again from those pixels. The same picture and settings give the same diagram every time: the scattering and the order the nodes are nudged in come from a seeded random number.',
    },
    {
      heading: 'As shapes',
      body: 'A Voronoi cell is the set of points nearer its node than any other: the picture’s rectangle cut by the line halfway between its node and each other node. Only nodes nearer than twice the cell’s furthest corner can cut it, so they are looked for ring by ring. Every edge knows the node across it, so same-colored cells that share an edge are joined into one polygon: its outline is the edges that face another color or the picture’s edge, and a loop of them that winds the other way is a hole. A node whose cell holds no pixel is left out, its neighbours closing over it as they do in the picture.',
    },
    {
      heading: 'Limits',
      body: '- It finds a good diagram, not the best: the problem of placing nodes is hard, and the nudging stops where no single step pays.\n- Cells are convex, so a long thin or curved shape takes many nodes. Same-colored cells joined as shapes hide the joins, but the outline is still made of straight cuts.\n- More nodes fit better and take longer: the work grows with the nodes and the rounds, about a second for 300 nodes on a 720p picture, five for 6000.',
    },
  ],
  settings: [
    { name: 'Nodes', effect: 'How many cells.' },
    { name: 'Rounds', effect: 'How long the nodes are nudged; more fits a little better.' },
    { name: 'Use the palette', effect: 'With a palette wired in, the nodes take only its colors.' },
    { name: 'Write', effect: 'The diagram as a picture, as shapes, or both.' },
    { name: 'Join same-colored cells', effect: 'As shapes: one polygon for each area of same-colored cells that touch.' },
  ],
  cost: 'Labelling: one nearest-node look-up per pixel, a few buckets each. A round: each node tries about six moves, each looking at the pixels round its cell. Shapes: each cell cut by the 20 to 50 nodes round it.',
  resources: [
    { title: 'Voronoi diagram', url: 'https://en.wikipedia.org/wiki/Voronoi_diagram', note: 'Every point the cell of its nearest node.' },
    { title: 'Centroidal Voronoi tessellation', url: 'https://en.wikipedia.org/wiki/Centroidal_Voronoi_tessellation', note: 'The usual way to spread nodes out: each at the middle of its cell. Here the nodes go where the colors fit instead.' },
    { title: 'Ward’s method', url: 'https://en.wikipedia.org/wiki/Ward%27s_method', note: 'What joining two clusters adds to the squared error: how much a node does.' },
    { title: 'Sobel operator', url: 'https://en.wikipedia.org/wiki/Sobel_operator', note: 'Where the picture has edges: where the nodes start thicker.' },
  ],
  source: ['packages/shared/src/flows/voronoi.ts — workPicture, NearestGrid, Fitter (place, takeOut, putIn, settle, undo), fitWork, relocate, finishWork, cellPolygon, voronoiVector'],
  tryIt: 'Press Fit with a few dozen nodes, then switch on Edges and Nodes: the nodes gather along the picture’s edges and the cells follow its shapes.',
};
