import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  DEFAULT_VECTORIZE_OPTIONS,
  centreline,
  findRegions,
  isLineRegion,
  looksCurved,
  simplify,
  simplifyClosed,
  strokeWidth,
  summariseVectorize,
  thin,
  toBudget,
  toConvexPieces,
  traceOutline,
  vectorize,
  type VectorizeOptions,
} from '../src/flows/vectorize';
import { isConvex, type VectorLine, type VectorPolygon } from '../src/flows/vector';

const RED: [number, number, number, number] = [220, 40, 40, 255];
const BLUE: [number, number, number, number] = [40, 60, 220, 255];
const BLACK: [number, number, number, number] = [20, 20, 20, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

const PALETTE: Record<string, [number, number, number, number]> = {
  R: RED,
  B: BLUE,
  K: BLACK,
  '.': CLEAR,
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
// floor would throw most of them away. It has a test of its own below.
const options = (over: Partial<VectorizeOptions> = {}): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  minArea: 0,
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
  // The color the ink actually was, not a value rounded to a quantisation step:
  // a region wears the average of its own pixels.
  assert.equal(linesOf(result)[0]!.color, '#141414');
});

test('a thin shape bordering only one thing is an area, not a stroke', () => {
  // Thin is half the rule. A sliver of color on its own is a shape.
  const result = run([
    '..........',
    '..KK......',
    '..KK......',
    '..KK......',
    '..KK......',
    '..........',
  ]);
  assert.equal(result.report.lines, 0, 'nothing for it to separate');
  assert.equal(result.report.polygons, 1);
  assert.equal(result.report.thinButNotSeparating, 1, 'and it is reported as the near miss it is');
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

test('an outline is traced on the corners, so it lands on the edge of the shape', () => {
  const width = 6;
  const pixels = new Set<number>();
  for (let y = 1; y <= 3; y += 1) for (let x = 1; x <= 3; x += 1) pixels.add(y * width + x);
  const outline = traceOutline(pixels, width, 6);

  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  // The block covers pixels 1..3, whose outer corners are 1 and 4.
  assert.equal(Math.min(...xs), 1);
  assert.equal(Math.max(...xs), 4);
  assert.equal(Math.min(...ys), 1);
  assert.equal(Math.max(...ys), 4);
});

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

test('every polygon a run produces is convex', () => {
  const result = run([
    '.RRRRRR...',
    '.RRRRRR...',
    '.RR...RR..',
    '.RR....RR.',
    '.RRRRRRRR.',
    '..........',
  ]);
  for (const polygon of polygonsOf(result)) {
    assert.ok(isConvex(polygon.points), `concave: ${JSON.stringify(polygon.points)}`);
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

test('a line region with nothing traceable is reported rather than dropped in silence', () => {
  const region = { id: 0, color: { r: 0, g: 0, b: 0 }, pixels: [], neighbours: new Set([1, 2]), thickness: 1 };
  assert.equal(isLineRegion(region, options()), true, 'thin and separating');
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
  const width = 4;
  const pixels = new Set<number>();
  for (let y = 1; y <= 2; y += 1) for (let x = 1; x <= 2; x += 1) pixels.add(y * width + x);
  const traced = traceOutline(pixels, width, 4);

  assert.ok(simplifyClosed(traced, 1.8).length < 3, 'the tolerance really is bigger than the shape');
  const kept = toBudget(traced, 1.8, 20, 3, true);
  assert.ok(kept.length >= 3, `it came back as ${kept.length} point(s)`);
  assert.equal(toConvexPieces(kept).length, 1, 'and it is still a shape that can be filled');
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
  const result = vectorize({ width: size, height: size, data }, options(), (prefix) => `${prefix}_${(n += 1)}`);
  const took = performance.now() - start;

  assert.ok(result.image.shapes.length > 0, 'it found nothing');
  assert.ok(took < 3000, `it took ${Math.round(took)}ms`);

  const points = result.image.shapes.reduce((sum, shape) => sum + shape.points.length, 0);
  assert.ok(points < 200, `it spent ${points} points on three shapes`);
});

/* ---------------- what covers what ---------------- */

test('an outline round a shape does not swallow the shape', () => {
  /*
   * A black outline is a *ring*, and an outline is traced on the outside, so
   * filling one gives a disc rather than a ring. That is fine — the thing inside
   * is painted over it and only the rim shows — but only if the ring goes down
   * first.
   *
   * Ordered by how many pixels each region held, it does not: the ring is the
   * thinner of the two and goes on last, and a face comes back as a black blob.
   * So areas are ordered by what their outline *encloses*.
   */
  const size = 40;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const away = Math.hypot(x - size / 2, y - size / 2);
      const [r, g, b] = away > 15 ? [40, 60, 220] : away > 12 ? [20, 20, 20] : [220, 40, 40];
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }

  let n = 0;
  const result = vectorize({ width: size, height: size, data }, options({ lineWidth: 1 }), (prefix) => `${prefix}_${(n += 1)}`);

  const painted = result.image.shapes.map((shape) => shape.color);
  const black = painted.findIndex((hex) => /^#1/.test(hex));
  const red = painted.findIndex((hex) => /^#[c-f]/.test(hex));
  assert.ok(black >= 0, `no outline in ${painted.join(' ')}`);
  assert.ok(red >= 0, `no inside in ${painted.join(' ')}`);
  assert.ok(black < red, 'the outline is painted before what it encloses, not over it');

  // And the proof that it looks right: almost nothing is the wrong color.
  assert.ok(
    result.report.wrongPixels / result.report.drawnPixels < 0.05,
    `${((result.report.wrongPixels / result.report.drawnPixels) * 100).toFixed(1)}% of the picture is wrong`,
  );
});
