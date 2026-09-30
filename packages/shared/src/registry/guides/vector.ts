import type { AlgorithmGuide } from '../guides';

export const VECTORIZE_GUIDE: AlgorithmGuide = {
  kinds: ['art.vectorize'],
  title: 'Turning a picture into shapes: edges, fills, outlines, then lines',
  summary:
    'Boundaries are found once for the whole picture with Canny edge detection in OKLab. The spaces between the edges are flooded into regions, and each region’s outline is traced, simplified (Ramer–Douglas–Peucker) and drawn as one polygon, with holes where something else is inside it. A polygon no wider than a stroke is drawn again as a line down its middle. Shapes of one colour that meet are joined, the minimums are applied, flat shapes become lines and shallow corners become curves. Optional rounds of refinement redraw the parts that came out worst.',
  steps: [
    { kind: 'input', title: 'The picture' },
    { kind: 'step', title: '1. Edges (Canny, on OKLab)', detail: 'Gradient by Sobel; thinned to one pixel; weak edge pixels kept only where they join strong ones.' },
    { kind: 'step', title: '2. Regions', detail: 'Flood the space between the edges; hand the edge band to whichever side it looks like; drop regions under the smallest area.' },
    {
      kind: 'loop',
      title: '3. For each region',
      steps: [
        { kind: 'step', title: 'Trace its outline, each boundary once and shared with its neighbour' },
        { kind: 'step', title: 'Simplify', detail: 'Drop points the outline can lose moving no more than Simplify to within; loosen it for a shape over its point budget.' },
        { kind: 'step', title: 'A polygon, with holes where something else is inside' },
        { kind: 'decision', title: 'Skinny: no wider than the widest stroke, and long?', no: 'It stays a polygon.' },
        { kind: 'step', title: '4. Draw it as a line down its middle', detail: 'Thin to a one-pixel skeleton, walk it, simplify; curved if it bends by more than the threshold.' },
      ],
    },
    { kind: 'step', title: '5. Join and tidy', detail: 'Same-colour polygons that share a side become one; lines whose ends meet become one; drop what is under the minimums.' },
    { kind: 'step', title: 'Finish', detail: 'Flat polygons become lines; shallow corners become curves.' },
    {
      kind: 'loop',
      title: 'Rounds of refinement (if any)',
      steps: [
        { kind: 'step', title: 'Draw the result and compare it with the picture, block by block' },
        { kind: 'step', title: 'Redraw the worst blocks’ boundaries with a tighter tolerance' },
      ],
    },
    { kind: 'output', title: 'vector.json and vector.svg' },
  ],
  pseudocode: `lab = to_oklab(picture)
edges = canny(lab, strong = contrast, weak = keep_going)
regions = flood the non-edge pixels; give each edge pixel to the side it looks like
regions = [r for r in regions if area(r) >= min_area]

shapes = []
for r in regions:
  outline = trace(r)                         # shared boundaries traced once
  outline = rdp(outline, detail)             # Ramer-Douglas-Peucker
  while points(outline) > max_points: outline = rdp(outline, looser)
  poly = Polygon(colour(r), outline, holes = inner outlines)
  if thickness(r) <= widest_stroke and long(r):
    skeleton = zhang_suen_thin(r)
    shapes += Line(walk(skeleton), width = stroke_width(r),
                   curved = bend > curve_threshold)
  else:
    shapes += poly

shapes = join(shapes)                        # same colour, touching
shapes = drop(shapes under min polygon area / min line length / node gap)
shapes = flat_to_lines(shapes, flat_tolerance)
shapes = smooth_shallow_nodes(shapes, smooth_angle)

repeat refine_rounds:
  error = compare(render(shapes), picture) per block
  retrace boundaries through the worst blocks more tightly`,
  sections: [
    {
      heading: 'Edges first',
      body: `Finding the boundaries once, up front, is what makes the rest cheap: every later step reads the answer instead of comparing colours again. Canny does it in three steps, each for a reason:

- **On OKLab**, so a gradient means "how different this looks": in RGB a boundary between two blues reads steeper than one between two greens that are plainly further apart.
- **Thinned** to one pixel, because a gradient is a ridge several pixels wide and a boundary is a line; a fat boundary eats the regions either side and swallows thin strokes.
- **Joined** by hysteresis: a pixel over the weaker threshold is a boundary only where it touches one over the stronger. A boundary that fades for a pixel stays unbroken, and noise does not become boundaries.`,
    },
    {
      heading: 'Regions by flooding between edges',
      body: 'Each region is the space between boundaries, flooded the way a fill tool floods — with no colour comparison while spreading. That asks where the picture **changes**, one answer for the whole image, instead of asking each pixel whether it is near the colour the fill started from (which leaks wherever shading is gradual). The pixels on the edge itself are then given to whichever side they look like, so a region includes the blended edge of what it stands for.',
    },
    {
      heading: 'Polygons, then lines',
      body: 'Every region is first a polygon, and the polygons partition the picture: neighbours share their boundary exactly, so there are no gaps or overlaps. A region no wider than **Widest a stroke may be** and long is a drawn mark rather than an area, so it is drawn again as a line down its middle: thinned to a one-pixel skeleton (Zhang–Suen), walked end to end, and simplified.',
    },
    {
      heading: 'Simplifying',
      body: 'A traced outline has a point at every pixel step — far more than any shape needs. Ramer–Douglas–Peucker keeps the point furthest from the straight line between two kept points whenever it is further than **Simplify to within**, and drops the rest. **At most, per shape** is a budget: a shape over it has its tolerance loosened until it fits.',
    },
    {
      heading: 'Refinement',
      body: 'Nothing in the fast path measures the result against the pixels. Each round of refinement draws the shapes, compares them with the picture in blocks, and retraces the boundaries through the worst blocks with a tighter tolerance — so the effort goes where the drawing is wrong.',
    },
  ],
  settings: [
    { name: 'Widest a stroke may be', effect: 'Regions no wider than this, and long, become lines.' },
    { name: 'Contrast that counts / …and to keep one going', effect: 'Canny’s strong and weak thresholds.' },
    { name: 'Drop regions under', effect: 'Regions smaller than this are merged away.' },
    { name: 'Simplify to within / At most, per shape', effect: 'How far an outline may move to lose a point, and a point budget.' },
    { name: 'Curved if bent by', effect: 'How bent a line must be to be drawn curved.' },
    { name: 'Nodes at least / Smallest polygon / Shortest line / Join line ends within', effect: 'The clean-up minimums.' },
    { name: 'Flat shapes become lines / Smooth shallow corners', effect: 'The finishing touches, by angle.' },
    { name: 'Rounds of refinement / Measured over blocks of / Worst blocks to work on', effect: 'The slower pass that redraws the worst parts.' },
  ],
  cost: 'A few passes over the pixels for edges and regions, then work in proportion to the outlines. Each round of refinement draws and compares the whole picture again.',
  resources: [
    { title: 'Canny edge detector', url: 'https://en.wikipedia.org/wiki/Canny_edge_detector', note: 'Gradient, non-maximum suppression and hysteresis.' },
    { title: 'Ramer–Douglas–Peucker', url: 'https://en.wikipedia.org/wiki/Ramer%E2%80%93Douglas%E2%80%93Peucker_algorithm', note: 'How outlines lose points.' },
    { title: 'Zhang–Suen thinning', url: 'https://rosettacode.org/wiki/Zhang-Suen_thinning_algorithm', note: 'How a stroke is thinned to its middle.' },
    { title: 'Image tracing', url: 'https://en.wikipedia.org/wiki/Image_tracing', note: 'The wider problem of turning pixels into vector shapes.' },
  ],
  source: ['packages/shared/src/flows/vectorize.ts — vectorize, findRegions, simplify, centreline, thin', 'packages/shared/src/flows/edges.ts — detectEdges', 'packages/shared/src/flows/join.ts', 'packages/shared/src/flows/tidy.ts', 'packages/shared/src/flows/vectorSmooth.ts'],
};

export const VECTOR_EDIT_GUIDE: AlgorithmGuide = {
  kinds: ['art.vector.edit'],
  title: 'Editing shapes: anchors that are the truth, curves derived from them',
  summary:
    'A shape is stored as its anchors and, for each, how curved the outline is through it and how much it turns. The Bézier curves an SVG needs are worked out from the anchors whenever the drawing is written, so dragging a point never means fixing up handles. Shapes that share a boundary share its nodes, so moving one moves both. The smooth brush averages the brushed nodes of a run a few at a time into one.',
  steps: [
    { kind: 'input', title: 'A vector drawing' },
    { kind: 'step', title: 'Anchors, each with a curve and a turn', detail: 'Curve 0 is a corner; 1 is smooth, with handles a third of each segment long.' },
    { kind: 'step', title: 'Handles derived', detail: 'The direction through a node is from the node before to the node after, turned by its turn.' },
    {
      kind: 'loop',
      title: 'The smooth brush, for each shape it touches',
      steps: [
        { kind: 'step', title: 'Find the runs of brushed nodes along the outline' },
        { kind: 'step', title: 'Take them a window at a time; replace each window with one node at their average', detail: 'In every shape sharing them, so neighbours still meet. An open line’s ends stay.' },
        { kind: 'step', title: 'Make the remaining nodes curved by How curved' },
      ],
    },
    { kind: 'output', title: 'vector.json and vector.svg' },
  ],
  pseudocode: `def handles(node, prev, next):
  direction = rotate(next - prev, node.turn)          # the tangent
  ahead  = node + direction.unit * |next - node| / 3 * node.curve
  behind = node - direction.unit * |node - prev| / 3 * node.curve
  return ahead, behind                                # cubic Bézier handles

brush(shape, centre, radius, window, amount):
  for run in runs of nodes within radius of centre:
    for group in chunks(run, window):
      p = mean(group positions)
      move group[0] to p in every shape sharing it; delete the others
  set curve = amount on the nodes left`,
  sections: [
    {
      heading: 'Why anchors, not control points',
      body: 'An SVG stores cubic control points, and editing them is miserable: dragging one point means fixing up four numbers either side to keep the curve smooth, and adding a point mid-curve means solving for a split. Here the anchors are the truth; the Béziers are derived when the SVG is written. How curved a node is, and how it turns, are stored relative to its neighbours, so they survive the drawing being moved, turned or posed.',
    },
    {
      heading: 'Shared nodes',
      body: 'Neighbouring shapes share the points along the boundary between them. A node is a place, not a point of one shape: moving it moves every shape that has it, so a boundary can bend but never tear open.',
    },
    {
      heading: 'The smooth brush',
      body: 'A jagged traced outline has many nodes close together. Brushing over it averages them a window at a time — **Nodes averaged into one** — into single nodes at their average position, then curves the result by **How curved**. It never leaves an outline with too few nodes to be a shape.',
    },
  ],
  settings: [
    { name: 'How curved / Turn', effect: 'A selected node’s curve (0 corner, 1 smooth) and turn.' },
    { name: 'Brush size', effect: 'The smooth brush’s radius.' },
    { name: 'Nodes averaged into one', effect: 'How many brushed nodes become one.' },
    { name: 'How curved (brush)', effect: 'How curved the brushed nodes are made.' },
  ],
  resources: [
    { title: 'Bézier curve', url: 'https://en.wikipedia.org/wiki/B%C3%A9zier_curve', note: 'The cubic curves the SVG is written with.' },
    { title: 'Cardinal spline', url: 'https://en.wikipedia.org/wiki/Cubic_Hermite_spline#Cardinal_spline', note: 'Tangents from the neighbours either side, as the handles are derived here.' },
  ],
  source: ['packages/shared/src/flows/vector.ts — toCubics, nodeTangent, changeNodes', 'packages/shared/src/flows/vectorSmooth.ts — averageNodeRuns, curveNodes'],
};

export const LINE_GRAPH_GUIDE: AlgorithmGuide = {
  kinds: ['art.lines.graph'],
  title: 'Lines as a graph: fill, thin to the middle, trace between nodes',
  summary:
    'The line picture is read back into each pixel’s confidence and width. The sure-enough pixels are filled into connected areas; each area is thinned to a one-pixel middle (Zhang–Suen); ends and junctions on the middle are the graph’s nodes, and the paths between them its lines. Each line keeps the mean width of the band it runs over. Short spurs are dropped, nodes joining just two lines are merged away, and each line is simplified.',
  steps: [
    { kind: 'input', title: 'A line picture from Line Detection' },
    { kind: 'step', title: 'Read back confidence and width per pixel' },
    { kind: 'step', title: 'Keep the surest pixels', detail: 'Confidence at least Surest pixels only.' },
    { kind: 'step', title: 'Fill: every connected area is one fill' },
    { kind: 'step', title: 'Thin each fill to its middle, one pixel wide' },
    { kind: 'step', title: 'Nodes: middle pixels with one neighbour (ends) or three or more (junctions)' },
    { kind: 'step', title: 'Lines: walk the middle from node to node', detail: 'Each keeps the mean width under it.' },
    { kind: 'decision', title: 'A line from an end shorter than the spur length?', no: 'Kept.' },
    { kind: 'step', title: 'Drop it; merge any node left joining two lines' },
    { kind: 'step', title: 'Simplify each line (Ramer–Douglas–Peucker)' },
    { kind: 'output', title: 'graph.json and graph.svg — filtered by width, edited by hand' },
  ],
  pseudocode: `conf, width = read_line_image(picture)
mask = conf >= min_confidence
labels = connected_areas(mask)                   # the fills
middle = zhang_suen_thin(mask)
nodes = [p in middle with neighbours(p) == 1 or >= 3]
edges = walk middle between nodes; width(edge) = mean(width under it)
repeat:
  drop edges from an end shorter than spur
  merge nodes of degree 2 (join their two edges)
until nothing changes
for e in edges: e.points = rdp(e.points, simplify)`,
  sections: [
    {
      heading: 'Why fill, then thin',
      body: 'A band of line pixels is several pixels wide; a vector line has none. Thinning the band to its middle and laying the line along that middle means every line runs over the area it came from, and lines that cross or branch meet at a shared node.',
    },
    {
      heading: 'Spurs',
      body: 'Thinning a lumpy band leaves short side branches. A line from an end shorter than **Drop spurs shorter than** is dropped, and a node left joining only two lines is removed so they become one.',
    },
    {
      heading: 'Width',
      body: 'Each line keeps the mean width of the pixels it runs over (from the line picture’s red-to-blue colour), so lines can be kept or hidden by width — only the thin outlines, say.',
    },
  ],
  settings: [
    { name: 'Surest pixels only', effect: 'The least confidence a pixel needs to be part of a line.' },
    { name: 'Simplify', effect: 'How far a line may move to lose a point.' },
    { name: 'Drop spurs shorter than', effect: 'Side branches shorter than this are dropped.' },
    { name: 'Width from / to', effect: 'Only lines this wide are kept.' },
  ],
  cost: 'A few passes over the pixels; thinning takes one pass per pixel of band width.',
  resources: [
    { title: 'Zhang–Suen thinning', url: 'https://rosettacode.org/wiki/Zhang-Suen_thinning_algorithm', note: 'Thinning a band to a connected one-pixel middle.' },
    { title: 'Topological skeleton', url: 'https://en.wikipedia.org/wiki/Topological_skeleton', note: 'What the middle of a shape is.' },
    { title: 'Ramer–Douglas–Peucker', url: 'https://en.wikipedia.org/wiki/Ramer%E2%80%93Douglas%E2%80%93Peucker_algorithm', note: 'How lines lose points.' },
  ],
  source: ['packages/shared/src/flows/lineGraph.ts — buildLineGraph, fillAreas, thinMask, simplifyPath'],
};
