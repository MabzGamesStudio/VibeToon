import type { Bitmap } from './cutout';
import { FULL_BLUE_WIDTH, readLineImage, widthShade } from './lines';
import type { VectorImage, VectorLine } from './vector';

/**
 * The lines a Line Detection found, as a graph of vector lines.
 *
 * The line picture is read back — every pixel's confidence and width — and
 * the lines are **filled**: every connected area of line pixels is one fill.
 * Each fill is thinned to its middle, one pixel wide, and the vector lines are
 * laid along that middle, so each runs over the area it came from. Where a
 * middle ends there is an **end**; where three or more meet there is a
 * **junction**. Those are the graph's nodes, and the lines between them its
 * edges: lines that cross or branch are joined at the node they share.
 *
 * Each line keeps the width of the band it runs along (the mean of the widths
 * under it), so lines can be kept or left out by width. Thinning leaves short
 * spurs where a band is lumpy; a line from an end shorter than the spur length
 * is dropped, and a node left joining just two lines is taken out and the two
 * joined into one. Each line's points are then simplified to within the
 * simplify tolerance.
 */

export interface LineGraphOptions {
  /** A pixel of the line picture counts when it is at least this sure, 0..1. */
  minConfidence: number;
  /** How far a simplified line may stray from the middle it was traced along, in pixels. */
  simplify: number;
  /** A line from an end shorter than this is a spur of the thinning, and dropped, in pixels. */
  spur: number;
}

export const DEFAULT_LINE_GRAPH_OPTIONS: LineGraphOptions = { minConfidence: 0.2, simplify: 1, spur: 4 };

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphNode extends GraphPoint {
  id: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  points: GraphPoint[];
  /** Mean width of the band under it, in pixels. */
  width: number;
  /** Mean confidence of the pixels under it, 0..1. */
  confidence: number;
  length: number;
  /** Which fill it runs over. */
  fill: number;
}

export interface LineGraph {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Every pixel's fill, 0 for none. */
  fills: Int32Array;
  fillCount: number;
  stats: { linePixels: number; middlePixels: number; spurs: number; ms: number };
}

/* ------------------------------------------------------------------ *
 * Filling and thinning
 * ------------------------------------------------------------------ */

/** Label every 8-connected area of set pixels: 1, 2, … and 0 for unset. */
export function fillAreas(mask: Uint8Array, width: number, height: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height);
  let count = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    count += 1;
    labels[start] = count;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % width;
      const y = (at - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!mask[next] || labels[next]) continue;
          labels[next] = count;
          stack.push(next);
        }
      }
    }
  }
  return { labels, count };
}

/**
 * Thin a mask to its middle, one pixel wide, keeping it connected (Zhang–Suen).
 */
export function thinMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : out[y * width + x]!);
  const remove: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pass of [0, 1]) {
      remove.length = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (!out[y * width + x]) continue;
          // The eight neighbours, clockwise from north.
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
          const neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (neighbours < 2 || neighbours > 6) continue;
          let transitions = 0;
          for (let i = 0; i < 8; i += 1) if (!ring[i] && ring[(i + 1) % 8]) transitions += 1;
          if (transitions !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          remove.push(y * width + x);
        }
      }
      for (const index of remove) out[index] = 0;
      if (remove.length > 0) changed = true;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tracing
 * ------------------------------------------------------------------ */

const AROUND: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

/** Distance from a point to a segment. */
function toSegment(p: GraphPoint, a: GraphPoint, b: GraphPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Keep the fewest points that stay within `tolerance` of the line (Douglas–Peucker). */
export function simplifyPath(points: GraphPoint[], tolerance: number): GraphPoint[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let far = 0;
    for (let i = from + 1; i < to; i += 1) {
      const off = toSegment(points[i]!, points[from]!, points[to]!);
      if (off > far) {
        far = off;
        worst = i;
      }
    }
    if (worst >= 0 && far > tolerance) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function pathLength(points: readonly GraphPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

interface RawEdge {
  from: number;
  to: number;
  pixels: number[];
}

/**
 * The graph of a line picture: fill, thin, trace, tidy.
 */
export function buildLineGraph(picture: Bitmap, input: Partial<LineGraphOptions> = {}): LineGraph {
  const started = Date.now();
  const options = { ...DEFAULT_LINE_GRAPH_OPTIONS, ...input };
  const read = readLineImage(picture);
  const { width, height } = picture;
  const total = width * height;
  const mask = new Uint8Array(total);
  let linePixels = 0;
  for (let i = 0; i < total; i += 1) {
    if (read.confidence[i]! > 0 && read.confidence[i]! >= options.minConfidence) {
      mask[i] = 1;
      linePixels += 1;
    }
  }
  const { labels: fills, count: fillCount } = fillAreas(mask, width, height);
  const middle = thinMask(mask, width, height);
  let middlePixels = 0;
  for (const value of middle) middlePixels += value;

  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && middle[y * width + x] === 1;
  const neighboursOf = (index: number): number[] => {
    const x = index % width;
    const y = (index - x) / width;
    const out: number[] = [];
    for (const [dx, dy] of AROUND) if (on(x + dx, y + dy)) out.push((y + dy) * width + x + dx);
    return out;
  };

  // Nodes: every middle pixel that is not simply on the way through (one
  // neighbour: an end; three or more: a junction). Touching node pixels are
  // one node.
  const nodeOf = new Int32Array(total).fill(-1);
  const nodePixels: number[][] = [];
  for (let i = 0; i < total; i += 1) {
    if (!middle[i] || nodeOf[i]! >= 0) continue;
    const degree = neighboursOf(i).length;
    if (degree === 2) continue;
    const id = nodePixels.length;
    const group = [i];
    nodeOf[i] = id;
    for (let k = 0; k < group.length; k += 1) {
      for (const next of neighboursOf(group[k]!)) {
        if (nodeOf[next]! >= 0 || neighboursOf(next).length === 2) continue;
        nodeOf[next] = id;
        group.push(next);
      }
    }
    nodePixels.push(group);
  }

  // Edges: from every node pixel, along each way out, to the next node.
  const walked = new Uint8Array(total);
  const raw: RawEdge[] = [];
  const direct = new Set<string>();
  const walkFrom = (fromNode: number, start: number, first: number): RawEdge | null => {
    const pixels: number[] = [];
    let previous = start;
    let current = first;
    for (;;) {
      if (nodeOf[current]! >= 0) return { from: fromNode, to: nodeOf[current]!, pixels };
      if (walked[current]) return null;
      walked[current] = 1;
      pixels.push(current);
      // A junction can be several pixels, all touching the first steps out of
      // it: a walk must go a few pixels before it may come back to its own node.
      const onward = neighboursOf(current).filter(
        (next) => next !== previous && !(walked[next] && nodeOf[next]! < 0) && !(nodeOf[next] === fromNode && pixels.length < 3),
      );
      // Prefer a node, then a straight step, so a corner is not cut.
      const node = onward.find((next) => nodeOf[next]! >= 0 && next !== start);
      const next = node ?? onward[0];
      if (next === undefined) return { from: fromNode, to: -1, pixels };
      previous = current;
      current = next;
    }
  };
  nodePixels.forEach((group, id) => {
    for (const pixel of group) {
      for (const next of neighboursOf(pixel)) {
        if (nodeOf[next] === id) continue;
        if (nodeOf[next]! >= 0) {
          const key = id < nodeOf[next]! ? `${id}-${nodeOf[next]}` : `${nodeOf[next]}-${id}`;
          if (!direct.has(key)) {
            direct.add(key);
            raw.push({ from: id, to: nodeOf[next]!, pixels: [] });
          }
          continue;
        }
        if (walked[next]) continue;
        const edge = walkFrom(id, pixel, next);
        if (edge && edge.to >= 0) raw.push(edge);
      }
    }
  });

  // What is left is loops with no node on them: give each one where it starts.
  for (let i = 0; i < total; i += 1) {
    if (!middle[i] || walked[i] || nodeOf[i]! >= 0) continue;
    const id = nodePixels.length;
    nodePixels.push([i]);
    nodeOf[i] = id;
    const ways = neighboursOf(i);
    if (ways[0] !== undefined) {
      const edge = walkFrom(id, i, ways[0]);
      if (edge) raw.push({ ...edge, to: edge.to >= 0 ? edge.to : id });
    }
  }

  // Node positions: the middle of their pixels.
  const centre = (group: number[]): GraphPoint => {
    let sx = 0;
    let sy = 0;
    for (const pixel of group) {
      const x = pixel % width;
      sx += x + 0.5;
      sy += (pixel - x) / width + 0.5;
    }
    return { x: sx / group.length, y: sy / group.length };
  };
  const nodes = nodePixels.map(centre);

  interface Working {
    from: number;
    to: number;
    points: GraphPoint[];
    pixels: number[];
    alive: boolean;
  }
  const edges: Working[] = raw.map((edge) => ({
    from: edge.from,
    to: edge.to,
    pixels: edge.pixels,
    points: [nodes[edge.from]!, ...edge.pixels.map((pixel) => ({ x: (pixel % width) + 0.5, y: Math.floor(pixel / width) + 0.5 })), nodes[edge.to]!],
    alive: true,
  }));

  const degree = () => {
    const counts = new Map<number, number>();
    for (const edge of edges) {
      if (!edge.alive) continue;
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    }
    return counts;
  };

  // Spurs: a short line from an end into a junction.
  let spurs = 0;
  for (let changed = true; changed; ) {
    changed = false;
    const counts = degree();
    for (const edge of edges) {
      if (!edge.alive || edge.from === edge.to) continue;
      const fromEnd = counts.get(edge.from) === 1;
      const toEnd = counts.get(edge.to) === 1;
      if (fromEnd === toEnd) continue;
      if (pathLength(edge.points) >= options.spur) continue;
      edge.alive = false;
      spurs += 1;
      changed = true;
      break;
    }
  }

  // A node that only joins two lines is no node: join them into one.
  for (let changed = true; changed; ) {
    changed = false;
    const counts = degree();
    for (let node = 0; node < nodes.length && !changed; node += 1) {
      if (counts.get(node) !== 2) continue;
      const pair = edges.filter((edge) => edge.alive && (edge.from === node || edge.to === node));
      if (pair.length !== 2 || pair[0] === pair[1]) continue;
      const [a, b] = pair as [Working, Working];
      if (a.from === a.to || b.from === b.to) continue;
      // Turn both so they run a → node → b.
      const aPoints = a.to === node ? a.points : [...a.points].reverse();
      const aStart = a.to === node ? a.from : a.to;
      const bPoints = b.from === node ? b.points : [...b.points].reverse();
      const bEnd = b.from === node ? b.to : b.from;
      a.points = [...aPoints, ...bPoints.slice(1)];
      a.pixels = [...a.pixels, ...b.pixels];
      a.from = aStart;
      a.to = bEnd;
      b.alive = false;
      changed = true;
    }
  }

  const counts = degree();
  const usedNodes = [...counts.keys()].sort((x, y) => x - y);
  const nodeId = new Map(usedNodes.map((node, index) => [node, `n${index + 1}`]));
  const kept = edges.filter((edge) => edge.alive);
  return {
    width,
    height,
    nodes: usedNodes.map((node) => ({ id: nodeId.get(node)!, x: round(nodes[node]!.x), y: round(nodes[node]!.y) })),
    edges: kept.map((edge, index) => {
      const under = edge.pixels.length > 0 ? edge.pixels : [];
      let widthSum = 0;
      let sureSum = 0;
      for (const pixel of under) {
        widthSum += read.lineWidth[pixel]!;
        sureSum += read.confidence[pixel]!;
      }
      const points = simplifyPath(edge.points, options.simplify).map((point) => ({ x: round(point.x), y: round(point.y) }));
      const anyPixel = under[0] ?? nodePixels[edge.from]![0]!;
      return {
        id: `e${index + 1}`,
        from: nodeId.get(edge.from)!,
        to: nodeId.get(edge.to)!,
        points,
        width: under.length > 0 ? round(widthSum / under.length) : round(read.lineWidth[anyPixel]! || 1),
        confidence: under.length > 0 ? round(sureSum / under.length) : round(read.confidence[anyPixel]!),
        length: round(pathLength(edge.points)),
        fill: fills[anyPixel]!,
      };
    }),
    fills,
    fillCount,
    stats: { linePixels, middlePixels, spurs, ms: Date.now() - started },
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

export interface WidthRange {
  min: number;
  max: number;
}

export interface LineGraphFlowData {
  editor: 'lineGraph';
  options: LineGraphOptions;
  /** Only lines this wide are kept, in pixels. */
  widthRange: WidthRange;
  /** Lines taken out by hand, by id. */
  hidden: string[];
  /** Nodes moved by hand, by id. */
  moved: Record<string, GraphPoint>;
  /**
   * The line picture and settings the hand edits were made on. Ids are only
   * the same for the same picture traced the same way, so edits made on
   * another are set aside rather than applied to the wrong lines.
   */
  basis?: string;
  selected: string[];
  /** Show the filled areas under the lines. */
  showFill: boolean;
}

export const MAX_GRAPH_WIDTH = FULL_BLUE_WIDTH;

export function emptyLineGraphFlowData(): LineGraphFlowData {
  return {
    editor: 'lineGraph',
    options: { ...DEFAULT_LINE_GRAPH_OPTIONS },
    widthRange: { min: 0, max: MAX_GRAPH_WIDTH },
    hidden: [],
    moved: {},
    selected: [],
    showFill: true,
  };
}

/** What the hand edits are keyed to: the picture and the tracing settings. */
export function graphBasis(pictureHash: string | undefined, options: LineGraphOptions): string {
  return `${pictureHash ?? '?'}|${options.minConfidence}|${options.simplify}|${options.spur}`;
}

/** Is a line inside the width range? A range whose top is the widest there is keeps everything above it too. */
export function inWidthRange(edge: GraphEdge, range: WidthRange): boolean {
  const top = range.max >= MAX_GRAPH_WIDTH ? Infinity : range.max;
  return edge.width >= range.min - 1e-9 && edge.width <= top + 1e-9;
}

export interface EditedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Lines left out by the width range. */
  filtered: GraphEdge[];
  /** Lines taken out by hand. */
  hidden: GraphEdge[];
}

/**
 * The graph with the hand edits on it: moved nodes (and the ends of their
 * lines with them), lines taken out, and only the lines in the width range.
 * Nodes no kept line touches are left out.
 */
export function editedGraph(graph: LineGraph, data: Pick<LineGraphFlowData, 'widthRange' | 'hidden' | 'moved'>): EditedGraph {
  const moved = (node: GraphNode): GraphNode => (data.moved[node.id] ? { ...node, ...data.moved[node.id] } : node);
  const nodes = new Map(graph.nodes.map((node) => [node.id, moved(node)]));
  const hidden = new Set(data.hidden);
  const kept: GraphEdge[] = [];
  const filtered: GraphEdge[] = [];
  const out: GraphEdge[] = [];
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from)!;
    const to = nodes.get(edge.to)!;
    const points = edge.points.map((point, index) => (index === 0 ? { x: from.x, y: from.y } : index === edge.points.length - 1 ? { x: to.x, y: to.y } : point));
    const placed = { ...edge, points };
    if (hidden.has(edge.id)) out.push(placed);
    else if (!inWidthRange(edge, data.widthRange)) filtered.push(placed);
    else kept.push(placed);
  }
  const touched = new Set(kept.flatMap((edge) => [edge.from, edge.to]));
  return { nodes: [...nodes.values()].filter((node) => touched.has(node.id)), edges: kept, filtered, hidden: out };
}

/** A colour for a width: red for thin, blue for wide, as the line picture has it. */
export function widthColour(width: number): string {
  const shade = widthShade(width);
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  return `#${hex(230 * (1 - shade) + 30 * shade)}${hex(40)}${hex(40 * (1 - shade) + 230 * shade)}`;
}

/** `graph.json`: the nodes and the lines between them. */
export function graphFile(graph: LineGraph, edited: EditedGraph): string {
  return `${JSON.stringify(
    {
      kind: 'lineGraph',
      version: 1,
      width: graph.width,
      height: graph.height,
      nodes: edited.nodes,
      edges: edited.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, width: edge.width, confidence: edge.confidence, length: edge.length, points: edge.points })),
    },
    null,
    2,
  )}\n`;
}

/** The kept lines as a vector drawing, for the Vector Editor and the flows after it. */
export function graphVector(graph: LineGraph, edited: EditedGraph, colour = '#1a1a1a'): VectorImage {
  return {
    width: graph.width,
    height: graph.height,
    shapes: edited.edges.map(
      (edge): VectorLine => ({
        id: edge.id,
        kind: 'line',
        color: colour,
        width: edge.width,
        points: edge.points.map((point) => ({ x: point.x, y: point.y })),
        curved: false,
        closed: edge.from === edge.to && edge.points.length > 3,
      }),
    ),
  };
}

/** The kept lines as an SVG, each coloured by its width. */
export function graphSvg(graph: LineGraph, edited: EditedGraph): string {
  const lines = edited.edges.map(
    (edge) =>
      `  <polyline points="${edge.points.map((point) => `${point.x},${point.y}`).join(' ')}" stroke="${widthColour(edge.width)}" stroke-width="${edge.width}" />`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}">`,
    '  <g fill="none" stroke-linecap="round" stroke-linejoin="round">',
    ...lines,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

export function summariseGraph(graph: LineGraph, edited: EditedGraph): string {
  return `${edited.edges.length} of ${graph.edges.length} line(s), ${edited.nodes.length} node(s), over ${graph.fillCount} fill(s) · ${graph.stats.ms} ms`;
}

export function graphReport(graph: LineGraph, edited: EditedGraph, data: LineGraphFlowData, source: string): string {
  const range = `${data.widthRange.min}–${data.widthRange.max >= MAX_GRAPH_WIDTH ? `${MAX_GRAPH_WIDTH}+` : data.widthRange.max} px`;
  return [
    '# Line graph',
    '',
    `Traced from **${source}**, ${graph.width} × ${graph.height}: ${graph.stats.linePixels.toLocaleString()} line pixels in ${graph.fillCount} fill(s), thinned to ${graph.stats.middlePixels.toLocaleString()}.`,
    '',
    `- Lines kept: **${edited.edges.length}** of ${graph.edges.length}, joined at ${edited.nodes.length} node(s).`,
    `- Left out by width (keeping ${range}): ${edited.filtered.length}.`,
    `- Taken out by hand: ${edited.hidden.length}. Nodes moved by hand: ${Object.keys(data.moved).length}.`,
    `- Spurs dropped: ${graph.stats.spurs}.`,
    '',
  ].join('\n');
}
