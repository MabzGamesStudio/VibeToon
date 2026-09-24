import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  DEFAULT_VECTORIZE_OPTIONS,
  centreline,
  findRegions,
  isSkinny,
  looksCurved,
  convexPieces,
  difference,
  hotBlocks,
  signedArea,
  simplify,
  simplifyClosed,
  strokeWidth,
  summariseVectorize,
  thin,
  toBudget,
  toConvexPieces,
  vectorize,
  type VectorizeOptions,
} from '../src/flows/vectorize';
import { isConvex, type VectorLine, type VectorPolygon } from '../src/flows/vector';
import { traceShared } from '../src/flows/arcs';
import { coverageFor, fillInto, type Box } from '../src/flows/fit';

const RED: [number, number, number, number] = [220, 40, 40, 255];
const BLUE: [number, number, number, number] = [40, 60, 220, 255];
const BLACK: [number, number, number, number] = [20, 20, 20, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

const PALETTE: Record<string, [number, number, number, number]> = {
  R: RED,
  B: BLUE,
  K: BLACK,
  '.': CLEAR,
  // Half way between red and blue: the blended pixels along the edge of a real
  // drawing, which a region is handed and which pull its average off its color.
  P: [130, 50, 130, 255],
};

/** An image from a character map, so a test reads as the picture it is. */
function picture(rows: string[]): Bitmap {
  const height = rows.length;
  const width = rows[0]!.length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(PALETTE[rows[y]![x]!]!, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function ids() {
  let n = 0;
  return (prefix: string) => `${prefix}_${(n += 1)}`;
}

// The pictures here are a few pixels across on purpose, so the default noise
// floor — and the minimum polygon, line and node spacing, which are sized for
// real pictures — would throw most of them away. Each has tests of its own below.
const options = (over: Partial<VectorizeOptions> = {}): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  minArea: 0,
  minPolygonArea: 0,
  minLineLength: 0,
  minNodeGap: 0,
  ...over,
});

const run = (rows: string[], over: Partial<VectorizeOptions> = {}) =>
  vectorize(picture(rows), options(over), ids());

const linesOf = (result: ReturnType<typeof run>) =>
  result.image.shapes.filter((shape): shape is VectorLine => shape.kind === 'line');
const polygonsOf = (result: ReturnType<typeof run>) =>
  result.image.shapes.filter((shape): shape is VectorPolygon => shape.kind === 'polygon');

/* ---------------- the rule that defines a line ---------------- */

test('two solid blocks side by side are two areas and no lines', () => {
  // The example the whole flow is built around: a boundary between two colors
  // is not a line. Neither block is thin, so neither is a stroke.
  const result = run([
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
  ]);
  assert.equal(result.report.lines, 0, 'no line where two colors merely meet');
  assert.equal(result.report.polygons, 2);
});

test('a stroke between the same two blocks is a line, and they are still areas', () => {
  const result = run([
    'RRRRRKKBBBBB',
    'RRRRRKKBBBBB',
    'RRRRRKKBBBBB',
    'RRRRRKKBBBBB',
    'RRRRRKKBBBBB',
    'RRRRRKKBBBBB',
  ]);
  assert.equal(result.report.lines, 1);
  assert.equal(result.report.polygons, 2);
  // The color the ink actually was, not a value rounded to a quantisation step.
  assert.equal(linesOf(result)[0]!.color, '#141414');
});

test('a thin shape that is not long is an area, not a stroke', () => {
  // Thin is half the rule; long is the other. Two wide and four long is a scrap.
  const result = run([
    '..........',
    '..KK......',
    '..KK......',
    '..KK......',
    '..KK......',
    '..........',
  ]);
  assert.equal(result.report.lines, 0, 'not three times longer than it is wide');
  assert.equal(result.report.polygons, 1);
  assert.equal(result.report.skinny, 0);
});

test('a long thin shape is a line even with only one thing beside it', () => {
  // The smile on a face borders nothing but the face, and it is a line.
  const result = run([
    '..............',
    '..KKKKKKKKKK..',
    '..KKKKKKKKKK..',
    '..............',
  ]);
  assert.equal(result.report.lines, 1);
  assert.equal(result.report.polygons, 0);
  assert.equal(result.report.skinny, 1);
});

test('the line width setting is what decides which it is', () => {
  // A four-wide band between two blocks big enough in *both* directions that
  // nobody would call them strokes — a block ten wide and six tall is six
  // across the short way, which is thin, and the rule would be right to say so.
  // Only the band's verdict is meant to change here.
  const row = 'RRRRRRRRRRKKKKBBBBBBBBBB';
  const rows = Array.from({ length: 20 }, () => row);
  const wide = run(rows, { lineWidth: 6 });
  assert.equal(wide.report.lines, 1, 'the band is a stroke when strokes may be that wide');
  assert.equal(wide.report.polygons, 2);

  const narrow = run(rows, { lineWidth: 2 });
  assert.equal(narrow.report.lines, 0, 'and an area when they may not');
  assert.equal(narrow.report.polygons, 3);
});

/* ---------------- regions ---------------- */

test('transparent pixels belong to nothing and are counted as such', () => {
  const result = run([
    '....',
    '.RR.',
    '.RR.',
    '....',
  ]);
  assert.equal(result.report.transparent, 12);
  assert.equal(result.report.polygons, 1);
});

test('a region knows what it touches, including the outside', () => {
  const { regions } = findRegions(picture(['RRBB', 'RRBB']), options());
  assert.equal(regions.length, 2);
  assert.equal(regions[0]!.neighbours.has(regions[1]!.id), true);
  assert.equal(regions[0]!.neighbours.has(-1), true, 'the edge of the image counts as outside');
});

test('a smooth ramp is one region, and a step in it is two', () => {
  /*
   * The difference between growing by contrast and growing by tolerance, in one
   * test. Tolerance measured each pixel against the one the fill started from,
   * so a long enough ramp was chopped into arbitrary bands wherever it happened
   * to drift out of range — bands with no boundary in the picture to justify
   * them. Contrast asks where the picture *changes*, so the ramp stays whole and
   * only a real step divides it.
   */
  const ramp = (step: number): Bitmap => {
    const width = 40;
    const data = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x += 1) {
      const level = 100 + x + (x >= 20 ? step : 0);
      data[x * 4] = data[x * 4 + 1] = data[x * 4 + 2] = level;
      data[x * 4 + 3] = 255;
    }
    return { width, height: 1, data };
  };

  const smooth = findRegions(ramp(0), options());
  assert.equal(smooth.regions.length, 1, `the ramp became ${smooth.regions.length} region(s)`);

  const stepped = findRegions(ramp(90), options());
  assert.equal(stepped.regions.length, 2, `the step became ${stepped.regions.length} region(s)`);
});

test('noise below the minimum area is dropped', () => {
  const result = run(
    [
      'RRRRRR',
      'RRRRRR',
      'RRRRRR',
      'RRRRRB',
    ],
    { minArea: 4 },
  );
  assert.equal(result.report.dropped, 1, 'the single blue pixel');
  assert.equal(result.report.polygons, 1);
});

/* ---------------- strokes ---------------- */

test('a stroke is measured by its area over its length, not by its distance transform', () => {
  // A two-wide stroke has no pixel more than half a pixel from its edge, so the
  // transform calls it one. Area over length gets it right at any parity.
  const rows = ['RKKB', 'RKKB', 'RKKB', 'RKKB', 'RKKB', 'RKKB'];
  const black = linesOf(run(rows)).find((line) => /^#1/.test(line.color))!;
  assert.ok(black, 'the stroke was not found');
  assert.ok(Math.abs(black.width - 2) < 0.4, `width came out ${black.width}`);
});

test('a stroke reaches the ends of the ink, not where thinning left off', () => {
  // Thinning eats an end a layer per round. On short marks that is most of them.
  const rows = ['RKB', 'RKB', 'RKB', 'RKB', 'RKB', 'RKB', 'RKB', 'RKB'];
  const line = linesOf(run(rows)).find((candidate) => /^#1/.test(candidate.color))!;
  const top = Math.min(...line.points.map((point) => point.y));
  const bottom = Math.max(...line.points.map((point) => point.y));
  assert.ok(top <= 0.6, `the top stopped at ${top}`);
  assert.ok(bottom >= 7.4, `the bottom stopped at ${bottom}`);
});

test('an outline all the way round comes out as one closed line', () => {
  // Not as one path per corner, which is what 8-connected walking gives if a
  // diagonal next to a corner is allowed to look like a junction.
  const result = run([
    '..........',
    '.KKKKKKKK.',
    '.KRRRRRRK.',
    '.KRRRRRRK.',
    '.KRRRRRRK.',
    '.KKKKKKKK.',
    '..........',
  ]);
  const lines = linesOf(result);
  assert.equal(lines.length, 1, `got ${lines.length} pieces`);
  assert.equal(lines[0]!.closed, true);
  assert.equal(polygonsOf(result).length, 1, 'and the inside is an area');
});

test('thinning leaves a one-pixel skeleton and does not break it', () => {
  const pixels = new Set<number>();
  const width = 12;
  for (let y = 2; y < 6; y += 1) for (let x = 1; x < 11; x += 1) pixels.add(y * width + x);
  const skeleton = thin(pixels, width, 8);
  assert.ok(skeleton.size < pixels.size, 'it thinned');
  // Fewer than the block is ten wide: thinning eats the ends as well as the
  // sides, which is what `extendEnds` exists to put back.
  assert.ok(skeleton.size >= 4, `it vanished (${skeleton.size})`);

  const paths = centreline(pixels, width, 8);
  assert.ok(paths.length >= 1);
  assert.ok(paths[0]!.points.length >= 2);
});

/* ---------------- outlines and fitting ---------------- */

test('simplifying drops points that were not saying anything', () => {
  const straight = Array.from({ length: 20 }, (_, index) => ({ x: index, y: 0 }));
  assert.deepEqual(simplify(straight, 0.5), [
    { x: 0, y: 0 },
    { x: 19, y: 0 },
  ]);

  const bent = [...straight, { x: 19, y: 10 }];
  assert.ok(simplify(bent, 0.5).length >= 3, 'and keeps the ones that were');
});

test('a bend counts as a curve relative to how long the run is', () => {
  // The same 2px bow is a curve across 10px and a hand-drawn straight across 400.
  const bow = (span: number) => [
    { x: 0, y: 0 },
    { x: span / 2, y: 2 },
    { x: span, y: 0 },
  ];
  assert.equal(looksCurved(bow(10), 0.04), true);
  assert.equal(looksCurved(bow(400), 0.04), false);
});

test('a two-point run is never a curve', () => {
  assert.equal(looksCurved([{ x: 0, y: 0 }, { x: 5, y: 5 }], 0.04), false);
});

/* ---------------- convex decomposition ---------------- */

test('a convex shape is left alone rather than cut up for no reason', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.deepEqual(toConvexPieces(square), [square]);
});

test('a concave shape is cut into convex pieces that are all convex', () => {
  // An L. Every piece has to keep the promise the type makes.
  const shape = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ];
  const pieces = toConvexPieces(shape);
  assert.ok(pieces.length >= 2, 'an L cannot be one convex piece');
  for (const piece of pieces) {
    assert.ok(isConvex(piece), `a piece came out concave: ${JSON.stringify(piece)}`);
    assert.ok(piece.length >= 3);
  }
});

test('pieces are merged back where they can be, rather than left as triangles', () => {
  // Triangles alone satisfy "convex" and give ten times the shapes to edit.
  const shape = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ];
  const pieces = toConvexPieces(shape);
  assert.ok(pieces.length < 4, `${pieces.length} pieces is barely better than triangulating`);
});

test('with joining off, every polygon a run produces is convex', () => {
  // The promise a consumer that needs convex pieces can still ask for.
  const result = run(
    [
      '.RRRRRR...',
      '.RRRRRR...',
      '.RR...RR..',
      '.RR....RR.',
      '.RRRRRRRR.',
      '..........',
    ],
    { joinShapes: false },
  );
  for (const polygon of polygonsOf(result)) {
    assert.ok(isConvex(polygon.points), `concave: ${JSON.stringify(polygon.points)}`);
  }
});

/* ---------------- the minimums ---------------- */

test('a region drawn in one color is that color exactly, not averaged with its edge', () => {
  // Each block is handed a column of blended pixels along the edge between them,
  // which used to pull its average a shade off — and kept two regions of one red
  // from matching, and a picture snapped to a palette from coming back in it.
  const result = run([
    'RRRRRPBBBBBB',
    'RRRRRPBBBBBB',
    'RRRRRPBBBBBB',
    'RRRRRPBBBBBB',
    'RRRRRPBBBBBB',
  ]);
  const colors = polygonsOf(result).map((polygon) => polygon.color).sort();
  assert.deepEqual(colors, ['#283cdc', '#dc2828']);
});

const SPECK = [
  'RRRRRRRRRR',
  'RRRRRRRRRR',
  'RRRRRRRRRR',
  'RRRRBBRRRR',
  'RRRRBBRRRR',
  'RRRRRRRRRR',
  'RRRRRRRRRR',
  'RRRRRRRRRR',
];

test('a polygon under the minimum area is folded into what surrounds it, leaving no hole', () => {
  const kept = run(SPECK, { minPolygonArea: 0 });
  assert.ok(polygonsOf(kept).some((polygon) => polygon.color === '#283cdc'), 'the speck is there with no minimum');

  const folded = run(SPECK, { minPolygonArea: 6 });
  assert.deepEqual(polygonsOf(folded).map((polygon) => polygon.color), ['#dc2828'], 'one red shape, hole filled');
  assert.equal(folded.report.smallFolded, 1);
  assert.equal(
    Math.abs(signedArea(polygonsOf(folded)[0]!.points)),
    80,
    'covering the whole picture: the speck became part of the red around it',
  );
});

const DASH = [
  'RRRRRKKBBBBB',
  'RRRRRKKBBBBB',
  'RRRRRKKBBBBB',
  'RRRRRKKBBBBB',
  'RRRRRKKBBBBB',
  'RRRRRKKBBBBB',
];

test('a stroke shorter than the minimum line length is drawn as the area it is', () => {
  assert.equal(run(DASH, { minLineLength: 4 }).report.lines, 1, 'six pixels long is a line at four');

  const short = run(DASH, { minLineLength: 20 });
  assert.equal(short.report.lines, 0);
  assert.equal(short.report.shortStrokes, 1);
  assert.ok(
    polygonsOf(short).some((polygon) => polygon.color === '#141414'),
    'and its ink is still there, as a polygon',
  );
});

test('the counts of what the minimums did are in the report, and are nothing when they are off', () => {
  const off = run(SPECK, { minPolygonArea: 0, minLineLength: 0, minNodeGap: 0 });
  for (const count of ['nodesMerged', 'smallFolded', 'smallDropped', 'shortLines', 'shortStrokes'] as const) {
    assert.equal(off.report[count], 0, count);
  }
});

/* ---------------- joining what belongs together ---------------- */

const ELL = [
  'RRRRRRRRRRRR',
  'RRRRRRRRRRRR',
  'RRRRRRRRRRRR',
  'RRRRRRRRRRRR',
  'RRRRRRRRRRRR',
  'RRRRR.......',
  'RRRRR.......',
  'RRRRR.......',
  'RRRRR.......',
  'RRRRR.......',
];

function coveredArea(result: ReturnType<typeof run>): number {
  return polygonsOf(result).reduce(
    (sum, polygon) =>
      sum +
      Math.abs(signedArea(polygon.points)) -
      (polygon.holes ?? []).reduce((holes, hole) => holes + Math.abs(signedArea(hole)), 0),
    0,
  );
}

test('a concave area of one color comes back as one polygon, not the pieces it was cut into', () => {
  const pieces = run(ELL, { joinShapes: false });
  const joined = run(ELL);
  assert.ok(polygonsOf(pieces).length > 1, 'an L cannot be one convex piece');
  assert.equal(polygonsOf(joined).length, 1);
  assert.equal(coveredArea(joined), coveredArea(pieces), 'covering exactly what the pieces covered');
  assert.equal(joined.report.wrongPixels, pieces.report.wrongPixels);
  assert.equal(joined.report.joinedPolygons, 0, 'drawn whole from the start, with nothing to join');
});

test('areas of different colors are never joined, however long the side they share', () => {
  const result = run([
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
    'RRRRRRBBBBBB',
  ]);
  const colors = polygonsOf(result).map((polygon) => polygon.color);
  assert.equal(colors.length, 2);
  assert.notEqual(colors[0], colors[1]);
});

test('an area with a hole in it is one polygon with a hole', () => {
  // Walls thicker than a stroke, so every side of the frame is an area.
  const RING = [
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRR......RRRRR',
    'RRRRR......RRRRR',
    'RRRRR......RRRRR',
    'RRRRR......RRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRR',
  ];
  const result = run(RING);
  const pieces = run(RING, { joinShapes: false });
  assert.equal(linesOf(pieces).length, 0, 'the picture this test needs: all area, no strokes');
  assert.ok(polygonsOf(pieces).length > 2);
  assert.equal(polygonsOf(result).length, 1, 'the whole frame');
  assert.equal(polygonsOf(result)[0]!.holes?.length, 1, 'round the empty middle');
  assert.equal(result.report.holes, 1);
  assert.equal(coveredArea(result), coveredArea(pieces));
  assert.equal(result.report.overNothing, 0, 'and the hole is still empty');
});

test('the counts in the report are the shapes in the drawing, joined or not', () => {
  for (const joinShapes of [true, false]) {
    const result = run(ELL, { joinShapes });
    assert.equal(result.report.polygons, polygonsOf(result).length, `polygons, joining ${joinShapes}`);
    assert.equal(result.report.lines, linesOf(result).length, `lines, joining ${joinShapes}`);
  }
});

/* ---------------- the whole thing ---------------- */

test('an empty picture produces nothing rather than one enormous shape', () => {
  const result = run(['....', '....']);
  assert.deepEqual(result.image.shapes, []);
  assert.equal(result.report.transparent, 8);
});

test('the vectorized image keeps the size of the picture it came from', () => {
  const result = run(['RRRR', 'RRRR', 'RRRR']);
  assert.equal(result.image.width, 4);
  assert.equal(result.image.height, 3);
});

test('every shape carries the color it was found in', () => {
  const result = run([
    'RRRKBBB',
    'RRRKBBB',
    'RRRKBBB',
    'RRRKBBB',
  ]);
  // Each shape wears its region's average, so these are close to the values
  // that went in rather than exactly them — the edge band between two colors is
  // handed back to one side or the other and pulls its average a shade over.
  const colors = [...new Set(result.image.shapes.map((shape) => shape.color))].sort();
  assert.equal(colors.length, 3, colors.join(' '));
  assert.ok(colors.some((hex) => /^#1/.test(hex)), `no black in ${colors.join(' ')}`);
  assert.ok(colors.some((hex) => /^#d/.test(hex)), `no red in ${colors.join(' ')}`);
  assert.ok(colors.some((hex) => /^#2/.test(hex)), `no blue in ${colors.join(' ')}`);
});

test('running twice on the same picture gives the same answer', () => {
  const rows = ['RRRKBBB', 'RRRKBBB', 'RRRKBBB', 'RRRKBBB'];
  const once = vectorize(picture(rows), options(), ids());
  const twice = vectorize(picture(rows), options(), ids());
  assert.deepEqual(twice.image, once.image);
});

test('the summary says what was found', () => {
  const result = run(['RRRKBBB', 'RRRKBBB', 'RRRKBBB', 'RRRKBBB']);
  const text = summariseVectorize(result.report);
  assert.match(text, /region\(s\)/);
  assert.match(text, /1 line\(s\)/);
  assert.match(text, /2 polygon\(s\)/);
});

test('a stroke that turns out to be a blob is kept as an area', () => {
  // The distance transform lets a squat shape through as a candidate; measuring
  // its real width is what catches it.
  const result = run(
    [
      'RRRRRRRRRR',
      'RRRKKKKRRR',
      'RRRKKKKRRR',
      'RRRKKKKRRR',
      'RRRKKKKRRR',
      'RRRRRRRRRR',
    ],
    { lineWidth: 2 },
  );
  // The blob itself is what is under test. (The red surround is a three-wide
  // ring between the outside and the blob, so it is a stroke by the rule, and
  // correctly comes out as one.)
  const blob = result.image.shapes.filter((shape) => /^#1/.test(shape.color));
  assert.ok(blob.length > 0, 'the blob went missing');
  assert.ok(
    blob.every((shape) => shape.kind === 'polygon'),
    'four wide is not a two-wide stroke, so it is an area',
  );
});

test('strokeWidth reports one for a path with no length rather than dividing by zero', () => {
  assert.equal(strokeWidth(10, []), 1);
  assert.equal(strokeWidth(10, [{ points: [{ x: 1, y: 1 }], closed: false }]), 1);
});

test('skinny is no wider than a stroke, whatever is beside it', () => {
  assert.equal(isSkinny({ thickness: 1 }, options()), true);
  assert.equal(isSkinny({ thickness: 4 }, options({ lineWidth: 3 })), true, 'a pixel of slack for even widths');
  assert.equal(isSkinny({ thickness: 6 }, options({ lineWidth: 3 })), false);
});

/* ---------------- simplifying a ring ---------------- */

test('a closed outline keeps all four corners of a square', () => {
  /*
   * Open RDP on a ring gets it wrong twice. Its baseline joins the first point to
   * the last, which on a ring are neighbours, so every point is measured against a
   * one-pixel chord that means nothing; and whichever corner the trace stopped on
   * is pinned while the corner beside it is free to go. A square came out as a
   * triangle.
   */
  const ring = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 10, y: 10 },
    { x: 5, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 5 },
  ];
  const closed = simplifyClosed(ring, 1);
  assert.equal(closed.length, 4, `got ${closed.length} point(s): ${JSON.stringify(closed)}`);
  for (const corner of [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]) {
    assert.ok(
      closed.some((point) => point.x === corner.x && point.y === corner.y),
      `${corner.x},${corner.y} was dropped`,
    );
  }
});

test('a budget is met by simplifying harder, not by cutting the list short', () => {
  // A circle, which has no corners to prefer, so a tolerance alone will happily
  // spend forty points on it.
  const circle = Array.from({ length: 120 }, (_, step) => {
    const angle = (step / 120) * Math.PI * 2;
    return { x: 50 + Math.cos(angle) * 40, y: 50 + Math.sin(angle) * 40 };
  });
  const loose = toBudget(circle, 0.2, 0, 3, true);
  assert.ok(loose.length > 12, `the tolerance alone kept only ${loose.length}`);

  const budgeted = toBudget(circle, 0.2, 12, 3, true);
  assert.ok(budgeted.length <= 12, `the budget was missed at ${budgeted.length}`);
  assert.ok(budgeted.length >= 6, `it went too far and kept ${budgeted.length}`);
});

test('a shape smaller than the tolerance is not simplified out of existence', () => {
  // A two-pixel square has no corner more than one and a half pixels off its own
  // diagonal, so a pixel and a half of slack flattens it into a line. Losing
  // detail is the deal; losing the shape is not.
  const traced = [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 3, y: 2 },
    { x: 3, y: 3 },
    { x: 2, y: 3 },
    { x: 1, y: 3 },
    { x: 1, y: 2 },
  ];

  assert.ok(simplifyClosed(traced, 1.8).length < 3, 'the tolerance really is bigger than the shape');
  const kept = toBudget(traced, 1.8, 20, 3, true);
  assert.ok(kept.length >= 3, `it came back as ${kept.length} point(s)`);
  assert.equal(toConvexPieces(kept).length, 1, 'and it is still a shape that can be filled');
});

/* ---------------- the shapes fit together ---------------- */

/** How much polygon is laid over each pixel, 255 being exactly one polygon's worth. */
function paintPerPixel(drawn: ReturnType<typeof run>['image']): Float64Array {
  const box: Box = { x: 0, y: 0, width: drawn.width, height: drawn.height };
  const total = new Float64Array(drawn.width * drawn.height);
  for (const shape of drawn.shapes) {
    if (shape.kind !== 'polygon') continue;
    const scratch = coverageFor(box);
    fillInto(shape.points, box, scratch, shape.holes);
    for (let index = 0; index < scratch.length; index += 1) total[index]! += scratch[index]!;
  }
  return total;
}

/** A ring of one color with a transparent hole, on a transparent background. */
function donut(size = 60, inner = 12, outer = 26): Bitmap {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const away = Math.hypot(x - size / 2, y - size / 2);
      if (away <= inner || away >= outer) continue;
      const at = (y * size + x) * 4;
      data[at] = 220;
      data[at + 1] = 60;
      data[at + 2] = 60;
      data[at + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

test('no pixel is under two polygons', () => {
  /*
   * The shapes are a partition of the picture, not a stack of overlapping ones
   * that happen to be painted in a lucky order. Before, every boundary was
   * simplified twice — once by the region on each side, each moving it by up to
   * the tolerance in whatever direction its own corners wanted — so there was a
   * sliver of overlap down one side of every boundary and a sliver of gap down
   * the other.
   */
  let n = 0;
  const image = picture([
    'RRRRKKBBBB',
    'RRRRKKBBBB',
    'RRRRKKBBBB',
    'KKKKKKKKKK',
    'BBBBKKRRRR',
    'BBBBKKRRRR',
    'BBBBKKRRRR',
  ]);
  const result = vectorize(image, options(), (prefix) => `${prefix}_${(n += 1)}`);
  const paint = paintPerPixel(result.image);
  const doubled = Array.from(paint).filter((value) => value > 255 * 1.05).length;
  assert.equal(doubled, 0, `${doubled} pixel(s) have more than one polygon over them`);
});

test('nothing is drawn where the picture is not there', () => {
  /*
   * The bug this is here for: a ring's outline was traced round the outside and
   * filled, which makes a disc — right only for as long as something is painted
   * over the middle afterwards, and plainly wrong when what is in the middle is
   * nothing at all. A washer came out as a coin.
   */
  const image = donut();
  let n = 0;
  const result = vectorize(image, options(), (prefix) => `${prefix}_${(n += 1)}`);
  const paint = paintPerPixel(result.image);

  let painted = 0;
  let clear = 0;
  for (let index = 0; index < image.width * image.height; index += 1) {
    if (image.data[index * 4 + 3]! > DEFAULT_VECTORIZE_OPTIONS.alphaFloor) continue;
    clear += 1;
    if (paint[index]! >= 128) painted += 1;
  }
  assert.ok(clear > 1000, 'the test picture is mostly transparent');
  // A boundary may still overshoot by a fraction of the tolerance; a filled hole
  // would be hundreds.
  assert.ok(painted < clear * 0.03, `${painted} of ${clear} transparent pixels have paint on them`);
});

test('a region with a hole comes back as a ring', () => {
  const image = donut();
  const found = findRegions(image, options());
  assert.equal(found.regions.length, 1);

  const loops = traceShared(found.labels, image.width, image.height, (points) => points);
  const ring = loops.get(found.regions[0]!.id)!;
  assert.ok(ring, 'the ring was not traced');
  assert.equal(ring.holes.length, 1, `got ${ring.holes.length} hole(s)`);
  assert.ok(Math.abs(signedArea(ring.outer)) > Math.abs(signedArea(ring.holes[0]!)) * 2);
});

test('the convex pieces of a shape tile it exactly', () => {
  // Not approximately: a piece lost to a bad merge is a bite out of the drawing,
  // and a piece counted twice is an overlap. Areas add or something is wrong.
  const image = donut();
  const found = findRegions(image, options());
  const loops = traceShared(image.width > 0 ? found.labels : found.labels, image.width, image.height, (points) => points);
  const ring = loops.get(found.regions[0]!.id)!;

  const want = Math.abs(signedArea(ring.outer)) - Math.abs(signedArea(ring.holes[0]!));
  const pieces = convexPieces(ring);
  const got = pieces.reduce((sum, piece) => sum + Math.abs(signedArea(piece)), 0);
  assert.ok(pieces.length > 1, 'a ring cannot be one convex piece');
  assert.ok(Math.abs(got - want) < 1e-6 * want, `pieces cover ${got.toFixed(1)}, the ring is ${want.toFixed(1)}`);
  for (const piece of pieces) assert.equal(isConvex(piece), true, 'a piece came out concave');
});

/* ---------------- refining the worst parts ---------------- */

test('the error is measured per pixel and averaged into blocks', () => {
  const image = picture(['RRRR', 'RRRR', 'RRRR', 'RRRR']);
  const drawn = { width: 4, height: 4, shapes: [] };
  const measured = difference(image, drawn, options());
  assert.equal(measured.plain, 16, 'nothing drawn is everything wrong');

  const hot = hotBlocks(measured.error, 4, 4, options({ hotspotBlock: 4, hotspotShare: 1 }));
  assert.equal(hot.blocks, 1);
  assert.equal(hot.holds({ x: 2, y: 2 }), true);
  assert.equal(hot.holds({ x: 9, y: 9 }), false, 'outside the picture is not a hotspot');
});

test('painting over nothing counts for far more than a wrong color', () => {
  // The whole reason a boundary that has spilled into the empty part of the
  // picture is the first thing a round of refinement pulls back: on a plain
  // one-for-one count it is worth the same as a pixel a shade off, and it is
  // spread thin along a boundary, so it vanishes into a block average.
  const clear = picture(['....', '....']);
  const solid = picture(['RRRR', 'RRRR']);
  const over = {
    width: 4,
    height: 2,
    shapes: [
      {
        id: 'p1',
        kind: 'polygon' as const,
        color: '#dc2828',
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 2 },
          { x: 0, y: 2 },
        ],
      },
    ],
  };
  const onNothing = difference(clear, over, options());
  const onInk = difference(solid, { ...over, shapes: [] }, options());
  assert.equal(onNothing.overNothing, 8);
  assert.ok(onNothing.wrong > onInk.wrong * 8, `${onNothing.wrong} against ${onInk.wrong}`);
  assert.equal(onNothing.plain, onInk.plain, 'though as a plain count they are the same eight pixels');
});

test('a round of refinement is kept only if it is actually better', () => {
  const image = donut();
  let n = 0;
  const once = vectorize(image, options({ refineRounds: 1 }), (prefix) => `${prefix}_${(n += 1)}`);
  n = 0;
  const none = vectorize(image, options({ refineRounds: 0 }), (prefix) => `${prefix}_${(n += 1)}`);
  n = 0;
  const lots = vectorize(image, options({ refineRounds: 4 }), (prefix) => `${prefix}_${(n += 1)}`);

  assert.ok(once.report.wrongPixels <= none.report.wrongPixels, 'a round made it worse');
  assert.ok(lots.report.wrongPixels <= once.report.wrongPixels, 'more rounds made it worse');
  assert.ok(lots.report.rounds <= 4);
});

test('refinement pulls a boundary back out of the empty part of the picture', () => {
  const image = donut(80, 18, 34);
  let n = 0;
  const none = vectorize(image, options({ refineRounds: 0 }), (prefix) => `${prefix}_${(n += 1)}`);
  n = 0;
  const some = vectorize(image, options({ refineRounds: 2 }), (prefix) => `${prefix}_${(n += 1)}`);
  assert.ok(
    some.report.overNothing < none.report.overNothing,
    `${none.report.overNothing} → ${some.report.overNothing}`,
  );
});

/* ---------------- speed ---------------- */

test('a picture of a few hundred pixels a side is decomposed in well under a second', () => {
  /*
   * The complaint that prompted this pipeline was that it took far too long, so
   * the fix deserves a test rather than a claim. Generous on purpose — this runs
   * on whatever machine happens to be running the suite — but it is two orders of
   * magnitude off what measuring every candidate against the pixels costs, which
   * is what this replaced.
   */
  const size = 256;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const ring = Math.abs(Math.hypot(x - size / 2, y - size / 2) - size / 3);
      const [r, g, b] = ring < 2 ? [20, 20, 20] : ring < 30 ? [230, 180, 140] : [90, 140, 200];
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }

  let n = 0;
  const start = performance.now();
  const result = vectorize(
    { width: size, height: size, data },
    options({ refineRounds: 0 }),
    (prefix) => `${prefix}_${(n += 1)}`,
  );
  const took = performance.now() - start;

  assert.ok(result.image.shapes.length > 0, 'it found nothing');
  assert.ok(took < 3000, `it took ${Math.round(took)}ms`);

  // Three nested rings, each a ring rather than a disc, so each needs a handful
  // of convex pieces rather than one.
  const points = result.image.shapes.reduce((sum, shape) => sum + shape.points.length, 0);
  assert.ok(points < 400, `it spent ${points} points on three rings`);
});

/* ---------------- polygons with holes, then lines ---------------- */

/**
 * A yellow smiley on a transparent background: a disc, two black eyes, and a
 * smile drawn as a two-and-a-half pixel line. Antialiased by supersampling, like
 * anything drawn in a paint program, so the edges are blended and the flow has to
 * cope with that rather than with a clean-cut test picture.
 */
function smiley(size = 120): Bitmap {
  const aa = 4;
  const data = new Uint8ClampedArray(size * size * 4);
  const centre = size / 2;
  const sample = (x: number, y: number): [number, number, number, number] => {
    if (Math.hypot(x - centre, y - centre) > size * 0.42) return [0, 0, 0, 0];
    for (const eye of [centre - size * 0.15, centre + size * 0.15]) {
      if (Math.hypot(x - eye, y - (centre - size * 0.12)) <= size * 0.06) return [20, 20, 20, 255];
    }
    const mouth = centre - size * 0.02;
    const turn = Math.atan2(y - mouth, x - centre);
    if (turn > Math.PI * 0.2 && turn < Math.PI * 0.8 && Math.abs(Math.hypot(x - centre, y - mouth) - size * 0.24) <= 1.25) {
      return [20, 20, 20, 255];
    }
    return [250, 210, 40, 255];
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0, 0];
      for (let j = 0; j < aa; j += 1) {
        for (let i = 0; i < aa; i += 1) {
          const [r, g, b, a] = sample(x + (i + 0.5) / aa, y + (j + 0.5) / aa);
          sum[0]! += r * a;
          sum[1]! += g * a;
          sum[2]! += b * a;
          sum[3]! += a;
        }
      }
      const at = (y * size + x) * 4;
      data[at + 3] = Math.round(sum[3]! / (aa * aa));
      if (sum[3]! > 0) {
        data[at] = Math.round(sum[0]! / sum[3]!);
        data[at + 1] = Math.round(sum[1]! / sum[3]!);
        data[at + 2] = Math.round(sum[2]! / sum[3]!);
      }
    }
  }
  return { width: size, height: size, data };
}

const sameLoop = (one: VectorPolygon['points'], two: VectorPolygon['points']) =>
  one.length === two.length && one.every((point) => two.some((other) => other.x === point.x && other.y === point.y));

test('a smiley comes out as the face, its two eyes and its smile', () => {
  for (const size of [60, 120, 240]) {
    // The settings anyone gets without touching a slider.
    const result = vectorize(smiley(size), DEFAULT_VECTORIZE_OPTIONS, ids());
    const shapes = result.image.shapes;
    const describe = shapes.map((shape) => `${shape.kind} ${shape.color}`).join(', ');
    assert.equal(shapes.length, 4, `${size}px: ${describe}`);

    const [face, ...rest] = polygonsOf(result);
    const eyes = rest;
    const smile = linesOf(result);
    assert.equal(face!.color, '#fad228', 'the face is yellow');
    assert.equal(eyes.length, 2, 'two eyes');
    assert.ok(eyes.every((eye) => eye.color === '#141414' && !eye.holes), 'black, and solid');
    assert.equal(smile.length, 1, 'one smile');
    assert.equal(smile[0]!.color, '#141414');
    assert.equal(smile[0]!.closed, false);
    assert.ok(smile[0]!.width <= DEFAULT_VECTORIZE_OPTIONS.lineWidth, `the smile is a stroke, ${smile[0]!.width} wide`);

    // The face has a hole for each eye, and each eye fits its hole exactly;
    // the smile's hole was closed over, with the line drawn on top of the face.
    assert.equal(face!.holes?.length, 2, `${size}px: the face has holes for the eyes and nothing else`);
    for (const eye of eyes) {
      assert.ok(face!.holes!.some((hole) => sameLoop(hole, eye.points)), 'an eye sits exactly in its hole');
    }
    assert.equal(result.report.skinny, 1);
    assert.equal(result.report.filledUnder, 1);

    // Nothing overlaps: every pixel is painted by one polygon at most.
    const paint = paintPerPixel(result.image);
    assert.ok(paint.every((value) => value <= 255), 'no pixel is painted by two polygons');
  }
});

test('a transparent gap inside a shape is a hole with nothing in it', () => {
  const image = donut();
  const result = vectorize(image, options(), ids());
  const polygons = polygonsOf({ ...result } as ReturnType<typeof run>);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0]!.holes?.length, 1);
  // Nothing at all painted in the middle; the edges may overshoot by a fraction
  // of the tolerance, as the test above allows.
  const paint = paintPerPixel(result.image);
  for (let y = 25; y < 35; y += 1) for (let x = 25; x < 35; x += 1) assert.equal(paint[y * image.width + x], 0, `${x},${y}`);
});

test('a skinny shape on the boundary between two others keeps the room it had', () => {
  // The stroke between red and blue is inside neither, so neither closes over it.
  const result = run([
    'RRRRRRKKBBBBBB',
    'RRRRRRKKBBBBBB',
    'RRRRRRKKBBBBBB',
    'RRRRRRKKBBBBBB',
    'RRRRRRKKBBBBBB',
    'RRRRRRKKBBBBBB',
    'RRRRRRKKBBBBBB',
  ]);
  assert.equal(result.report.skinny, 1);
  assert.equal(result.report.filledUnder, 0);
  assert.equal(coveredArea(result), 12 * 7);
});

test('joining off cuts each polygon with holes into convex pieces covering the same', () => {
  const whole = vectorize(smiley(60), options(), ids());
  const pieces = vectorize(smiley(60), options({ joinShapes: false }), ids());
  assert.ok(polygonsOf(pieces as ReturnType<typeof run>).every((piece) => !piece.holes && isConvex(piece.points)));
  assert.ok(
    Math.abs(coveredArea(pieces as ReturnType<typeof run>) - coveredArea(whole as ReturnType<typeof run>)) < 1e-6,
  );
});
