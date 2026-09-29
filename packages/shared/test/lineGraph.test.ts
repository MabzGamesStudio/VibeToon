import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  buildLineGraph,
  editedGraph,
  emptyLineGraphFlowData,
  fillAreas,
  graphBasis,
  graphFile,
  graphReport,
  graphSvg,
  graphVector,
  inWidthRange,
  simplifyPath,
  thinMask,
  widthColour,
} from '../src/flows/lineGraph';
import { detectLines, lineImage } from '../src/flows/lines';

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function paint(width: number, height: number, colour: (x: number, y: number) => Rgb): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set([...colour(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

/** The line picture a Line Detection would write for a drawing. */
function linesOf(drawing: Bitmap): Bitmap {
  return lineImage(detectLines(drawing, { maxWidth: 12 }));
}

/** A plus: a 3-wide stroke across and a 3-wide stroke down, crossing in the middle. */
const PLUS = paint(80, 80, (x, y) => ((y >= 39 && y < 42 && x >= 10 && x < 70) || (x >= 39 && x < 42 && y >= 10 && y < 70) ? BLACK : WHITE));

test('filling labels each connected area of line pixels', () => {
  const mask = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 1, 1]);
  const { labels, count } = fillAreas(mask, 3, 3);
  assert.equal(count, 2);
  assert.equal(labels[0], labels[1]);
  assert.equal(labels[7], labels[8]);
  assert.notEqual(labels[0], labels[8]);
});

test('thinning leaves the middle of a band, one pixel wide', () => {
  const width = 30;
  const height = 9;
  const mask = new Uint8Array(width * height);
  for (let y = 3; y < 6; y += 1) for (let x = 2; x < 28; x += 1) mask[y * width + x] = 1;
  const middle = thinMask(mask, width, height);
  for (let x = 5; x < 25; x += 1) {
    const column = [3, 4, 5].map((y) => middle[y * width + x]);
    assert.deepEqual(column, [0, 1, 0], `column ${x}`);
  }
});

test('a straight stroke is one line between two ends', () => {
  const drawing = paint(80, 30, (x, y) => (y >= 14 && y < 17 && x >= 10 && x < 70 ? BLACK : WHITE));
  const graph = buildLineGraph(linesOf(drawing));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes.length, 2);
  const [edge] = graph.edges;
  assert.ok(edge!.length > 50, `${edge!.length}`);
  assert.ok(Math.abs(edge!.width - 3) < 0.6, `width ${edge!.width}`);
  assert.equal(edge!.points.length, 2, 'simplified to its two ends');
  for (const point of edge!.points) assert.ok(Math.abs(point.y - 15.5) < 1, 'along the middle of the band');
});

test('lines that cross are joined at the node they share', () => {
  const graph = buildLineGraph(linesOf(PLUS));
  assert.equal(graph.edges.length, 4, JSON.stringify(graph.edges.map((edge) => [edge.from, edge.to, edge.length])));
  const counts = new Map<string, number>();
  for (const edge of graph.edges) for (const end of [edge.from, edge.to]) counts.set(end, (counts.get(end) ?? 0) + 1);
  const junction = [...counts.entries()].find(([, count]) => count === 4);
  assert.ok(junction, 'one node joins all four arms');
  const node = graph.nodes.find((one) => one.id === junction![0])!;
  assert.ok(Math.abs(node.x - 40.5) < 2 && Math.abs(node.y - 40.5) < 2, `${node.x}, ${node.y}`);
  assert.equal(new Set(graph.edges.map((edge) => edge.fill)).size, 1, 'all over one fill');
});

test('a closed outline is one line that comes back to where it starts', () => {
  const ring = paint(60, 60, (x, y) => {
    const inside = x >= 12 && x < 48 && y >= 12 && y < 48;
    const hole = x >= 15 && x < 45 && y >= 15 && y < 45;
    return inside && !hole ? BLACK : WHITE;
  });
  const graph = buildLineGraph(linesOf(ring));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.from, graph.edges[0]!.to);
  assert.ok(graph.edges[0]!.length > 100);
});

test('each line keeps the width of its band, and the range keeps only those wide enough', () => {
  const drawing = paint(80, 60, (x, y) => ((y >= 14 && y < 16 && x >= 10 && x < 70) || (y >= 38 && y < 46 && x >= 10 && x < 70) ? BLACK : WHITE));
  const graph = buildLineGraph(linesOf(drawing));
  assert.equal(graph.edges.length, 2);
  const [thinLine, wideLine] = [...graph.edges].sort((a, b) => a.width - b.width);
  assert.ok(thinLine!.width < 3 && wideLine!.width > 6, `${thinLine!.width}, ${wideLine!.width}`);
  const data = emptyLineGraphFlowData();
  const wideOnly = editedGraph(graph, { ...data, widthRange: { min: 5, max: 16 } });
  assert.deepEqual(wideOnly.edges.map((edge) => edge.id), [wideLine!.id]);
  assert.deepEqual(wideOnly.filtered.map((edge) => edge.id), [thinLine!.id]);
  assert.equal(wideOnly.nodes.length, 2, 'only the nodes a kept line touches');
  assert.ok(inWidthRange({ ...wideLine!, width: 40 }, { min: 0, max: 16 }), 'the top of the scale keeps anything wider');
  assert.ok(!inWidthRange({ ...wideLine!, width: 40 }, { min: 0, max: 12 }));
});

test('a line taken out by hand is left out, and a moved node takes its lines’ ends with it', () => {
  const graph = buildLineGraph(linesOf(PLUS));
  const data = emptyLineGraphFlowData();
  const [first] = graph.edges;
  const hidden = editedGraph(graph, { ...data, hidden: [first!.id] });
  assert.equal(hidden.edges.length, 3);
  assert.equal(hidden.hidden.length, 1);
  const end = graph.nodes.find((node) => node.id === first!.from)!;
  const moved = editedGraph(graph, { ...data, moved: { [end.id]: { x: 5, y: 5 } } });
  const line = moved.edges.find((edge) => edge.id === first!.id)!;
  assert.deepEqual(line.points[0], { x: 5, y: 5 });
  assert.equal(moved.nodes.find((node) => node.id === end.id)!.x, 5);
});

test('simplifying keeps corners and drops the points in between', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 5, y: 0.2 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 10, y: 10 },
  ];
  assert.deepEqual(simplifyPath(points, 0.5), [points[0], points[2], points[4]]);
  assert.deepEqual(simplifyPath(points, 0), points);
});

test('thin lines are red, wide ones blue', () => {
  assert.equal(widthColour(1), '#e62828');
  assert.equal(widthColour(16), '#1e28e6');
});

test('it writes a graph, a vector drawing and an SVG of the kept lines', () => {
  const graph = buildLineGraph(linesOf(PLUS));
  const data = emptyLineGraphFlowData();
  const edited = editedGraph(graph, data);
  const file = JSON.parse(graphFile(graph, edited));
  assert.equal(file.kind, 'lineGraph');
  assert.equal(file.edges.length, 4);
  const vector = graphVector(graph, edited);
  assert.equal(vector.shapes.length, 4);
  assert.equal(vector.shapes[0]!.kind, 'line');
  assert.match(graphSvg(graph, edited), /<polyline points="[^"]+" stroke="#[0-9a-f]{6}" stroke-width="[\d.]+" \/>/);
  assert.match(graphReport(graph, edited, data, 'Lines'), /Lines kept: \*\*4\*\* of 4/);
  assert.notEqual(graphBasis('abc', data.options), graphBasis('abc', { ...data.options, simplify: 2 }), 'edits are keyed to the settings too');
});
