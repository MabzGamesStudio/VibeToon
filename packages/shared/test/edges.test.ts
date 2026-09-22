import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import { DEFAULT_EDGE_OPTIONS, detectEdges, growRegions } from '../src/flows/edges';

const RED: [number, number, number, number] = [220, 40, 40, 255];
const BLUE: [number, number, number, number] = [40, 60, 220, 255];
const BLACK: [number, number, number, number] = [20, 20, 20, 255];
const GREY: [number, number, number, number] = [130, 50, 130, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

const PALETTE: Record<string, [number, number, number, number]> = {
  R: RED,
  B: BLUE,
  K: BLACK,
  '/': GREY,
  '.': CLEAR,
};

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

const grow = (rows: string[], minArea = 0) => {
  const image = picture(rows);
  const map = detectEdges(image, DEFAULT_EDGE_OPTIONS);
  return {
    image,
    map,
    ...growRegions(image, map, minArea, DEFAULT_EDGE_OPTIONS.edgeThreshold),
  };
};

/** Which region each row of the picture's first column ended up in. */
const columnLabels = (labels: Int32Array, width: number, x: number, height: number) =>
  Array.from({ length: height }, (_, y) => labels[y * width + x]!);

/* ---------------- edges ---------------- */

test('a boundary runs to the border of the picture, not one pixel short of it', () => {
  /*
   * A three-by-three gradient window cannot be centred on the outermost row, so
   * the obvious loop skips it — and a boundary with a one-pixel gap at each end
   * is no boundary at all. The regions either side of it leak through the gap and
   * come out as one. The samples are clamped instead.
   */
  const { map, regions } = grow(['RRBB', 'RRBB', 'RRBB', 'RRBB']);
  const topRow = Array.from({ length: map.width }, (_, x) => map.edges[x]!);
  assert.ok(topRow.includes(1), 'the top row has no boundary in it');
  assert.equal(regions.length, 2, `the two halves became ${regions.length} region(s)`);
});

test('transparency is a boundary in its own right', () => {
  const { map } = grow(['....', '.RR.', '.RR.', '....']);
  assert.ok(
    map.edges.some((edge, index) => edge === 1 && map.clear[index] === 0),
    'the silhouette of the shape is not an edge',
  );
});

/* ---------------- what the fill will not cross ---------------- */

test('a one-pixel line between two colors keeps its own ground', () => {
  /*
   * The case the whole flow is built around, and the one edge detection alone
   * gets wrong. Canny finds a *step*, and a one-pixel line is not two steps three
   * pixels apart — it is one ridge, thinned to whichever side was steeper. Take
   * the ridge out and the line has nothing left to defend it; the fill's local
   * step test gives it back.
   */
  const { regions, labels } = grow(['RRRKBBB', 'RRRKBBB', 'RRRKBBB', 'RRRKBBB']);
  assert.equal(regions.length, 3, `got ${regions.length} region(s)`);

  const middle = columnLabels(labels, 7, 3, 4);
  assert.equal(new Set(middle).size, 1, 'the line is not one region down its length');
  const line = regions.find((region) => region.id === middle[0])!;
  assert.equal(line.pixels.length, 4, 'the line is one pixel wide and four tall');
  assert.ok(line.color.r < 60 && line.color.g < 60, `the line came out ${JSON.stringify(line.color)}`);
});

test('a black outline is not handed to the color it encloses', () => {
  /*
   * A ring thin enough that every one of its pixels reads as a boundary has only
   * the inside to be near. Nearest-of-its-neighbours on its own therefore turns
   * the outline into more red, and the drawing loses its lines — so a pixel is
   * only claimed when it is closer to a side than the sides are to each other.
   */
  const { regions } = grow([
    '..........',
    '.KKKKKKKK.',
    '.KRRRRRRK.',
    '.KRRRRRRK.',
    '.KRRRRRRK.',
    '.KKKKKKKK.',
    '..........',
  ]);
  assert.equal(regions.length, 2, `got ${regions.length} region(s)`);
  const ring = regions.find((region) => region.color.r < 60)!;
  const inside = regions.find((region) => region.color.r > 150)!;
  assert.ok(ring, 'the outline vanished into the red');
  assert.equal(ring.pixels.length, 22, 'the whole ring, not part of it');
  assert.equal(inside.pixels.length, 18);
  assert.equal(ring.neighbours.has(inside.id), true);
});

test('a blended boundary pixel *is* handed to the side it looks like', () => {
  // The other half of the same rule. A pixel half way between two colors is
  // their boundary and belongs to one of them; it must not become a hairline
  // region of its own along every soft edge in the picture.
  const rows = ['RR/BB', 'RR/BB', 'RR/BB', 'RR/BB', 'RR/BB'];
  const { regions, labels } = grow(rows);
  assert.equal(regions.length, 2, `the soft boundary became ${regions.length} region(s)`);
  const column = columnLabels(labels, 5, 2, 5);
  assert.ok(
    column.every((label) => label === column[0]),
    'the boundary was split down its own length',
  );
});

test('a shape made entirely of boundary still becomes a region', () => {
  // Two pixels wide with transparency either side: every pixel is an edge, so the
  // fill gets no seed and the claim has nobody to give it to. Without a pass for
  // the leftovers the shape simply disappears from the picture.
  const { regions, transparent } = grow([
    '......',
    '..KK..',
    '..KK..',
    '..KK..',
    '......',
  ]);
  assert.equal(regions.length, 1, `got ${regions.length} region(s)`);
  assert.equal(regions[0]!.pixels.length, 6);
  assert.equal(transparent, 24);
});

test('a stroke gets its boundary pixels back, so it is its real width', () => {
  // A three-wide stroke has a boundary down both sides and only its middle
  // survives the edge pass. A region built from the gaps alone is a third of the
  // ink.
  const rows = Array.from({ length: 8 }, () => 'RRKKKBB');
  const { regions } = grow(rows);
  const stroke = regions.find((region) => region.color.r < 60)!;
  assert.ok(stroke, 'the stroke was not found');
  assert.equal(stroke.pixels.length, 24, 'three wide and eight tall, not one wide');
});

test('shading inside one outline stays one region however far it travels', () => {
  // The whole reason for growing between boundaries instead of by tolerance. Each
  // step along the ramp is tiny, so the fill crosses all of them; the total is
  // enormous, which is what a tolerance measured against the seed would stop at.
  const width = 60;
  const data = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x += 1) {
    data[x * 4] = 60 + x * 3;
    data[x * 4 + 1] = 60;
    data[x * 4 + 2] = 60;
    data[x * 4 + 3] = 255;
  }
  const image: Bitmap = { width, height: 1, data };
  const map = detectEdges(image, DEFAULT_EDGE_OPTIONS);
  const { regions } = growRegions(image, map, 0, DEFAULT_EDGE_OPTIONS.edgeThreshold);
  assert.equal(regions.length, 1, `the ramp became ${regions.length} region(s)`);
});

/* ---------------- housekeeping ---------------- */

test('a speck under the minimum area is folded into its neighbour, not left as a hole', () => {
  const { regions, folded, labels } = grow(['RRRR', 'RRRR', 'RRRR', 'RRRB'], 4);
  assert.equal(regions.length, 1);
  assert.equal(folded, 1);
  assert.ok(
    Array.from(labels).every((label) => label === regions[0]!.id),
    'the speck left a pixel belonging to nothing',
  );
  assert.equal(regions[0]!.pixels.length, 16);
});

test('a region knows what it touches, and the outside counts', () => {
  const { regions } = grow(['RRBB', 'RRBB', 'RRBB', 'RRBB']);
  assert.equal(regions.length, 2);
  assert.equal(regions[0]!.neighbours.has(regions[1]!.id), true);
  assert.equal(regions[0]!.neighbours.has(-1), true, 'the border of the image is outside');
});

test('every pixel that is there belongs to exactly one region', () => {
  const { labels, regions, transparent } = grow([
    '..........',
    '.KKKKKKKK.',
    '.KRRRKBBK.',
    '.KRRRKBBK.',
    '.KKKKKKKK.',
    '..........',
  ]);
  const counted = regions.reduce((sum, region) => sum + region.pixels.length, 0);
  assert.equal(counted + transparent, labels.length, 'some pixels belong to nothing');
  assert.ok(
    Array.from(labels).every((label) => label >= 0 || label === -1),
    'a pixel was left unclaimed',
  );
});
