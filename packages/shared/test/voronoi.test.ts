import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import type { Rgba } from '../src/flows/palette';
import { area, containsPoint } from '../src/flows/vector';
import {
  cellPolygon,
  diagramFromNodes,
  emptyVoronoiFlowData,
  fitVoronoi,
  fitWork,
  NearestGrid,
  readVoronoiNodes,
  sameColorAreas,
  seededRandom,
  summariseVoronoi,
  voronoiImage,
  voronoiNodesFile,
  voronoiReport,
  voronoiVector,
  voronoiWork,
  workPicture,
  workPixelsFor,
  type VoronoiFit,
} from '../src/flows/voronoi';

function paint(width: number, height: number, colour: (x: number, y: number) => [number, number, number, number]): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(colour(x, y), (y * width + x) * 4);
  return { width, height, data };
}

/** Blobs of colour on a background: something with edges to fit. */
const blobs = paint(60, 40, (x, y) => {
  if ((x - 18) ** 2 + (y - 20) ** 2 < 100) return [220, 40, 40, 255];
  if (x > 34 && x < 52 && y > 8 && y < 30) return [40, 60, 220, 255];
  return [240, 230, 200, 255];
});

/** The mean difference per pixel of a diagram whose nodes are at (xs, ys), each its cell's average. */
function diagramError(image: Bitmap, xs: number[], ys: number[]): number {
  const owner = new Int32Array(image.width * image.height);
  const sums = xs.map(() => new Float64Array(5));
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      let best = 0;
      let bestD = Infinity;
      xs.forEach((nx, i) => {
        const d = (x + 0.5 - nx) ** 2 + (y + 0.5 - ys[i]!) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const p = y * image.width + x;
      owner[p] = best;
      const s = sums[best]!;
      for (let c = 0; c < 4; c += 1) s[c] = s[c]! + image.data[p * 4 + c]!;
      s[4] = s[4]! + 1;
    }
  }
  let total = 0;
  for (let p = 0; p < owner.length; p += 1) {
    const s = sums[owner[p]!]!;
    let e = 0;
    for (let c = 0; c < 4; c += 1) e += (image.data[p * 4 + c]! - s[c]! / s[4]!) ** 2;
    total += Math.sqrt(e);
  }
  return total / owner.length;
}

test('a new Voronoi Diagram has 300 nodes, a dozen rounds, and writes a picture', () => {
  const data = emptyVoronoiFlowData();
  assert.equal(data.editor, 'voronoi');
  assert.deepEqual([data.nodes, data.refine, data.output, data.merge, data.usePalette], [300, 12, 'picture', true, true]);
  assert.equal(summariseVoronoi(data), '300 node(s), 12 round(s)');
  assert.equal(summariseVoronoi({ ...data, output: 'both' }), '300 node(s), 12 round(s), as a picture and shapes');
  assert.equal(workPixelsFor(10), 40_000);
  assert.equal(workPixelsFor(100_000), 300_000);
  const work = workPicture(paint(800, 600, () => [255, 0, 0, 128]), 40_000);
  assert.ok(work.width * work.height <= 40_000 && work.width > 200, `${work.width}×${work.height}`);
  assert.ok(Math.abs(work.values[0]! - 128) < 1e-3, 'premultiplied: half-opaque red is 128');
  assert.ok(Math.abs(work.values[3]! - 128) < 1e-3);
});

test('the nearest node is found as looking at every node finds it, at the edges and past them too', () => {
  const random = seededRandom(7);
  const count = 150;
  const xs = Array.from({ length: count }, () => random() * 90);
  const ys = Array.from({ length: count }, () => random() * 50);
  const skip = Uint8Array.from({ length: count }, (_, i) => (i % 7 === 3 ? 1 : 0));
  for (const skipping of [undefined, skip]) {
    const grid = new NearestGrid(xs, ys, count, 90, 50, skipping);
    for (let k = 0; k < 2000; k += 1) {
      const x = random() * 110 - 10;
      const y = random() * 70 - 10;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < count; i += 1) {
        if (skipping?.[i]) continue;
        const d = (xs[i]! - x) ** 2 + (ys[i]! - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      assert.equal(grid.nearest(x, y), best, `(${x.toFixed(2)}, ${y.toFixed(2)})`);
    }
  }
  assert.equal(new NearestGrid([], [], 0, 10, 10).nearest(5, 5), -1);
});

test('the same picture and settings give the same diagram, and the fit beats nodes on a grid', () => {
  const one = fitVoronoi(blobs, { nodes: 24, refine: 8, seed: 3 });
  const two = fitVoronoi(blobs, { nodes: 24, refine: 8, seed: 3 });
  assert.deepEqual(one.nodes, two.nodes);
  assert.deepEqual([...one.owner], [...two.owner]);
  const gridXs: number[] = [];
  const gridYs: number[] = [];
  for (let j = 0; j < 4; j += 1) for (let i = 0; i < 6; i += 1) (gridXs.push((i + 0.5) * 10), gridYs.push((j + 0.5) * 10));
  const regular = diagramError(blobs, gridXs, gridYs);
  assert.ok(one.error.mean < regular * 0.6, `fitted ${one.error.mean.toFixed(2)} against ${regular.toFixed(2)} on a grid`);
  const brief = fitVoronoi(blobs, { nodes: 24, refine: 1, seed: 3 });
  assert.ok(one.error.mean <= brief.error.mean, 'more rounds fit no worse');
  assert.equal(one.error.mean, diagramError(blobs, one.nodes.map((n) => n.x), one.nodes.map((n) => n.y)), 'the error reported is the error of the diagram');
});

test('a picture of one color is fitted exactly, whatever the nodes', () => {
  const flat = paint(30, 20, () => [10, 200, 90, 255]);
  const fit = fitVoronoi(flat, { nodes: 12, refine: 3 });
  assert.equal(fit.error.mean, 0);
  assert.equal(fit.error.psnr, 99);
  assert.ok(fit.nodes.every((node) => node.color.r === 10 && node.color.g === 200 && node.color.b === 90 && node.color.a === 255));
  assert.equal(sameColorAreas(fit).count, 1, 'every cell one color: one area');
  assert.equal(fit.nodes.reduce((sum, node) => sum + node.pixels, 0), 600);
});

test('with a palette, every node takes one of its colors — the one that fits its cell best', () => {
  const palette: Rgba[] = [
    { r: 255, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 255, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
  ];
  const fit = fitVoronoi(blobs, { nodes: 30, refine: 6 }, palette);
  const allowed = new Set(['255,0,0,255', '0,0,255,255', '255,255,255,255']);
  for (const node of fit.nodes) {
    assert.ok(allowed.has(`${node.color.r},${node.color.g},${node.color.b},${node.color.a}`), JSON.stringify(node.color));
    assert.ok(node.entry >= 0 && node.entry < 3);
  }
  const used = new Set(fit.nodes.filter((node) => node.pixels > 0).map((node) => node.entry));
  assert.deepEqual([...used].sort(), [0, 1, 2], 'red for the round blob, blue for the box, white for the rest');
  assert.deepEqual(fit.palette, palette);
  const image = voronoiImage(fit);
  for (let p = 0; p < image.width * image.height; p += 1) assert.ok(allowed.has(`${image.data[p * 4]},${image.data[p * 4 + 1]},${image.data[p * 4 + 2]},${image.data[p * 4 + 3]}`));
});

test('two halves are split down the middle', () => {
  const halves = paint(40, 30, (x) => (x < 20 ? [200, 0, 0, 255] : [0, 0, 200, 255]));
  const fit = fitVoronoi(halves, { nodes: 6, refine: 12, seed: 5 });
  const wrong = [...fit.owner].filter((owner, p) => (p % 40 < 20) !== fit.nodes[owner]!.color.r > 100).length;
  assert.ok(wrong <= 12, `${wrong} pixel(s) on the wrong side`);
  assert.ok(fit.error.mean < 12, `${fit.error.mean}`);
});

test('a start puts the nodes where they were: from a diagram already fitted, they hardly move', () => {
  const first = fitVoronoi(blobs, { nodes: 12, refine: 10, seed: 4 });
  const start = first.nodes.map((node) => ({ x: node.x, y: node.y }));
  const work = workPicture(blobs, workPixelsFor(12));
  const run = fitWork(work, { nodes: 12, refine: 2, start }, null);
  let next = run.next();
  const stages = new Set<string>();
  while (!next.done) {
    stages.add(next.value.stage);
    next = run.next();
  }
  assert.deepEqual([...stages].sort(), ['refine', 'start']);
  const moved = start.map((at, i) => Math.hypot(next.value.xs[i]! / work.sx - at.x, next.value.ys[i]! / work.sy - at.y));
  assert.ok(moved.reduce((sum, d) => sum + d, 0) / moved.length < 1.5, `moved ${moved.map((d) => d.toFixed(1)).join(', ')}`);
  const again = voronoiWork(blobs, { nodes: 12, refine: 2, start }, null);
  let step = again.next();
  while (!step.done) step = again.next();
  assert.ok(step.value.error.mean <= first.error.mean * 1.05, 'and fit as well');
  assert.equal(fitVoronoi(blobs, { nodes: 12, refine: 1, start: start.slice(0, 5) }).nodes.length, 12, 'a shorter start: the rest are scattered');
});

test('each cell outline is exactly the pixels nearest its node', () => {
  const fit = fitVoronoi(blobs, { nodes: 20, refine: 2, seed: 9 });
  const xs = fit.nodes.map((node) => node.x);
  const ys = fit.nodes.map((node) => node.y);
  const grid = new NearestGrid(xs, ys, xs.length, fit.width, fit.height);
  const cells = fit.nodes.map((_, i) => cellPolygon(fit, i, grid));
  let total = 0;
  for (const [i, cell] of cells.entries()) {
    assert.ok(area(cell.points) > 0, `cell ${i} winds one way`);
    total += area(cell.points);
    assert.equal(cell.sides.length, cell.points.length);
  }
  assert.ok(Math.abs(total - fit.width * fit.height) < 1e-6, 'the cells tile the picture');
  for (let p = 0; p < fit.owner.length; p += 7) {
    const point = { x: (p % fit.width) + 0.5, y: Math.floor(p / fit.width) + 0.5 };
    const cell = cells[fit.owner[p]!]!;
    assert.ok(containsPoint({ id: 'c', kind: 'polygon', color: '#000000', points: cell.points }, point), `pixel ${p} is inside its cell`);
  }
});

test('as shapes: one per cell, or same-colored cells joined, with a hole where another color is inside', () => {
  // A blue square inside red, inside a white border: with this palette the red is a ring round the blue.
  const palette: Rgba[] = [
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 255, a: 255 },
  ];
  const ring = paint(48, 48, (x, y) => (x >= 18 && x < 30 && y >= 18 && y < 30 ? [0, 0, 255, 255] : x >= 6 && x < 42 && y >= 6 && y < 42 ? [255, 0, 0, 255] : [255, 255, 255, 255]));
  const fit = fitVoronoi(ring, { nodes: 60, refine: 8, seed: 2 }, palette);
  const cellsOnly = voronoiVector(fit, false);
  assert.equal(cellsOnly.shapes.length, fit.nodes.filter((node) => node.pixels > 0).length);
  const merged = voronoiVector(fit, true);
  assert.ok(merged.shapes.length < cellsOnly.shapes.length);
  const filled = (image: typeof merged) =>
    image.shapes.reduce((sum, shape) => sum + area(shape.points) + (shape.kind === 'polygon' ? (shape.holes ?? []).reduce((h, hole) => h + area(hole), 0) : 0), 0);
  assert.ok(Math.abs(filled(cellsOnly) - 48 * 48) < 0.5, `${filled(cellsOnly)}`);
  assert.ok(Math.abs(filled(merged) - 48 * 48) < 0.5, `merged, holes taken out: ${filled(merged)}`);
  const red = merged.shapes.filter((shape) => shape.color === '#ff0000');
  assert.ok(red.some((shape) => shape.kind === 'polygon' && (shape.holes?.length ?? 0) > 0), 'the red ring has the blue square as a hole');
  for (const shape of merged.shapes) assert.ok(['#ffffff', '#ff0000', '#0000ff'].includes(shape.color));
});

test('see-through cells make no shape, and nodes.json and the report say what was fitted', () => {
  const half = paint(30, 20, (x) => (x < 15 ? [0, 0, 0, 0] : [250, 120, 10, 255]));
  const fit: VoronoiFit = fitVoronoi(half, { nodes: 8, refine: 4 });
  const vector = voronoiVector(fit, true);
  assert.ok(vector.shapes.length >= 1);
  assert.ok(vector.shapes.every((shape) => shape.color !== '#00000000'));
  const covered = vector.shapes.reduce((sum, shape) => sum + area(shape.points), 0);
  assert.ok(covered > 200 && covered < 400, `about the opaque half: ${covered}`);
  const data = { ...emptyVoronoiFlowData(), nodes: 8, refine: 4, output: 'both' as const };
  const json = JSON.parse(voronoiNodesFile(data, fit));
  assert.equal(json.kind, 'voronoi');
  assert.deepEqual([json.width, json.height, json.nodes.length], [30, 20, 8]);
  assert.deepEqual(json.settings, { nodes: 8, refine: 4, palette: null });
  assert.match(json.nodes[0].color, /^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  const report = voronoiReport(data, fit, vector);
  assert.match(report, /A 30 × 20 picture as 8 node\(s\)/);
  assert.match(report, /each node its cell’s average/);
  assert.match(report, /As shapes: \d+ polygon\(s\), same-colored cells joined/);
  assert.match(voronoiReport(data, null), /Not fitted yet/);
});

test('nodes.json reads back into the same diagram, on the picture or a bigger one', () => {
  const data = { ...emptyVoronoiFlowData(), nodes: 16, refine: 3 };
  const fit = fitVoronoi(blobs, { nodes: 16, refine: 3, seed: 8 });
  const file = readVoronoiNodes(JSON.parse(voronoiNodesFile(data, fit, 'sha-of-picture')));
  assert.ok(file);
  assert.equal(file.source, 'sha-of-picture');
  assert.deepEqual(file.settings, { nodes: 16, refine: 3, palette: null });
  assert.equal(file.nodes.length, 16);
  const back = diagramFromNodes(blobs, file);
  const differ = [...back.owner].filter((owner, p) => owner !== fit.owner[p]).length;
  assert.ok(differ <= 6, `${differ} pixel(s) changed cell: places are written to a hundredth of a pixel`);
  assert.deepEqual(back.nodes.map((node) => node.color), fit.nodes.map((node) => node.color));
  assert.ok(Math.abs(back.error.mean - fit.error.mean) < 0.5);
  const big = paint(120, 80, (x, y) => [...blobs.data.subarray(((y >> 1) * 60 + (x >> 1)) * 4, ((y >> 1) * 60 + (x >> 1)) * 4 + 4)] as [number, number, number, number]);
  const scaled = diagramFromNodes(big, file);
  assert.ok(Math.abs(scaled.nodes[0]!.x - fit.nodes[0]!.x * 2) < 0.02, 'twice the size: the nodes twice as far out');
  assert.equal(readVoronoiNodes({ kind: 'vector', nodes: [] }), null);
  assert.equal(readVoronoiNodes({ kind: 'voronoi', width: 10, height: 10, nodes: [{ x: 'a', y: 1, color: '#fff' }] }), null, 'no readable node');
  assert.equal(readVoronoiNodes(null), null);
});
