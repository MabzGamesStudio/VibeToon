import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxOf, coverageFor, fillInto, strokeInto, type Box } from '../src/flows/fit';

const W = 20;
const H = 20;
const box: Box = { x: 0, y: 0, width: W, height: H };

const corners = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const covered = (drawn: Uint8Array) => Array.from(drawn).filter((value) => value >= 128).length;

test('a filled rectangle covers the pixels it encloses, and no others', () => {
  const drawn = fillInto(corners(4, 4, 10, 10), box, coverageFor(box));
  assert.equal(covered(drawn), 36, 'six by six');
  assert.equal(drawn[4 * W + 4]! >= 128, true, 'the first pixel inside');
  assert.equal(drawn[3 * W + 4]! >= 128, false, 'the row above is outside');
  assert.equal(drawn[10 * W + 4]! >= 128, false, 'and so is the row past the end');
});

test('two shapes sharing an edge tile it rather than both claiming the seam', () => {
  /*
   * With the span closed at both ends, an edge landing exactly on a pixel centre
   * is inside the shape on its left *and* the shape on its right, and every pixel
   * down a 45° boundary gets painted twice. Invisible when shapes are painted in
   * an order — the later one wins — and not invisible at all once the shapes are
   * meant to be a partition and something counts them.
   */
  const left = fillInto([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }], box, coverageFor(box));
  const right = fillInto([{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }], box, coverageFor(box));

  let both = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! + right[index]! > 255 * 1.05) both += 1;
  }
  assert.equal(both, 0, `${both} pixel(s) are claimed by both halves of the square`);
});

test('coverage is counted in fractions of a pixel, not in whole ones', () => {
  /*
   * A band two units wide over three pixels of ink paints the middle one fully
   * and each outer one half. Thresholded at "more than half covered" that is
   * indistinguishable from a band three wide, so a search reports 2 where the ink
   * is 3 and every line comes out a third too thin.
   */
  const thin = strokeInto([{ x: 10, y: 4 }, { x: 10, y: 16 }], 2, box, coverageFor(box));
  const fat = strokeInto([{ x: 10, y: 4 }, { x: 10, y: 16 }], 3, box, coverageFor(box));

  const ink = (drawn: Uint8Array) => Array.from(drawn).reduce((sum, value) => sum + value, 0);
  assert.ok(ink(fat) > ink(thin) * 1.2, `a 3px stroke lays down ${ink(fat)}, a 2px one ${ink(thin)}`);

  const partial = Array.from(thin).filter((value) => value > 0 && value < 255).length;
  assert.ok(partial > 0, 'nothing is half covered, so coverage is being rounded to yes or no');
});

test('a stroke is round-capped, so a single point is a dot of its own width', () => {
  // Coordinates are on the corner lattice, so a point at 10 sits between pixels
  // 9 and 10 and a radius of 2 reaches pixels 8 through 11.
  const drawn = strokeInto([{ x: 10, y: 10 }], 4, box, coverageFor(box));
  assert.equal(drawn[9 * W + 9]! >= 128, true, 'the pixel the point sits on');
  assert.equal(drawn[9 * W + 11]! >= 128, true, 'and the far side of its width');
  assert.equal(drawn[9 * W + 12]! >= 128, false, 'but not the pixel past its radius');
  assert.equal(covered(drawn), 12, 'a disc four across, on a square grid');
});

test('a box is the area being drawn into, with room to overshoot into', () => {
  const pixels = new Set([5 * W + 5, 5 * W + 6, 6 * W + 5]);
  assert.deepEqual(boxOf(pixels, W), { x: 5, y: 5, width: 2, height: 2 });
  assert.deepEqual(boxOf(pixels, W, 2), { x: 3, y: 3, width: 6, height: 6 });
  assert.deepEqual(boxOf([], W), { x: 0, y: 0, width: 0, height: 0 });
});

test('drawing outside the box is clipped rather than written past the end', () => {
  const small: Box = { x: 8, y: 8, width: 4, height: 4 };
  const drawn = fillInto(corners(0, 0, 20, 20), small, coverageFor(small));
  assert.equal(drawn.length, 16);
  assert.equal(covered(drawn), 16, 'the whole of the little box, and nothing beyond it');
  void H;
});
