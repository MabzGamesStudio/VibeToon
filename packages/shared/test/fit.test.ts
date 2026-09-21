import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FIT_WEIGHTS,
  boxOf,
  compare,
  cost,
  coverageFor,
  fillInto,
  fitStroke,
  mergeHidden,
  prunePoints,
  pruneStroke,
  scorePieces,
  scoreStroke,
  shareInk,
  strokeInto,
  type Box,
} from '../src/flows/fit';

const W = 20;
const H = 20;
const box: Box = { x: 0, y: 0, width: W, height: H };
const weights = DEFAULT_FIT_WEIGHTS;

/** A filled rectangle of pixel indices, `[x0, x1)` by `[y0, y1)`. */
function rect(x0: number, y0: number, x1: number, y1: number): Set<number> {
  const out = new Set<number>();
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) out.add(y * W + x);
  return out;
}

const corners = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/* ---------------- measuring ---------------- */

test('a shape that covers exactly what it should is not wrong at all', () => {
  const target = rect(4, 4, 10, 10);
  const drawn = fillInto(corners(4, 4, 10, 10), box, coverageFor(box));
  const mismatch = compare(target, drawn, box, W);
  assert.equal(mismatch.missed, 0);
  assert.equal(mismatch.extra, 0);
  assert.equal(mismatch.wrong, 0);
});

test('missing and over-covering are both wrong, and count the same', () => {
  const target = rect(4, 4, 10, 10);

  const short = compare(target, fillInto(corners(4, 4, 8, 10), box, coverageFor(box)), target ? box : box, W);
  assert.equal(short.missed, 12, 'two columns of six');
  assert.equal(short.extra, 0);

  const over = compare(target, fillInto(corners(4, 4, 12, 10), box, coverageFor(box)), box, W);
  assert.equal(over.missed, 0);
  assert.equal(over.extra, 12);
  assert.equal(over.wrong, short.wrong, 'both are twelve pixels wrong');
});

test('coverage is counted in fractions of a pixel, not in whole ones', () => {
  // The distinction the whole fit rests on: a band two wide over three pixels of
  // ink paints each outer one half, and calling that "covered" makes a stroke a
  // third too thin without anything noticing.
  const ink = rect(5, 2, 8, 12);
  const centre = [
    { x: 6.5, y: 2.5 },
    { x: 6.5, y: 11.5 },
  ];
  const at = (width: number) =>
    compare(ink, strokeInto(centre, width, box, coverageFor(box)), box, W).wrong;

  assert.ok(at(3) < at(2), `three should beat two (${at(3)} vs ${at(2)})`);
  assert.ok(at(3) < at(4), `three should beat four (${at(3)} vs ${at(4)})`);
});

test('what is painted over afterwards is not counted either way', () => {
  // Without this an enclosing shape is punished for everything standing on it,
  // and the fit answers by eating it away from its neighbours — which leaves
  // real gaps, because the thing it was overlapping was going to cover the seam.
  const background = rect(0, 0, 20, 20);
  const subject = rect(6, 6, 14, 14);
  const drawn = fillInto(corners(0, 0, 20, 20), box, coverageFor(box));

  const naive = compare(background, drawn, box, W);
  const aware = compare(
    // The background is only responsible for what the subject does not cover.
    new Set([...background].filter((index) => !subject.has(index))),
    drawn,
    box,
    W,
    (index) => subject.has(index),
  );
  assert.equal(naive.wrong, 0, 'the full background covers the full background');
  assert.equal(aware.wrong, 0, 'and is not charged for the subject either');
});

test('the cost is the error plus what the shape itself is worth', () => {
  const mismatch = { missed: 5, extra: 5, wrong: 10, target: 100 };
  assert.equal(cost(mismatch, 4, 1, { pixel: 1, point: 6, polygon: 40 }), 10 + 24 + 40);
  // Free points and polygons means accuracy is all that matters.
  assert.equal(cost(mismatch, 4, 1, { pixel: 1, point: 0, polygon: 0 }), 10);
});

/* ---------------- fitting an area ---------------- */

test('a fill is scored as one shape, so a shared seam is not counted twice', () => {
  const target = rect(4, 4, 12, 12);
  const halves = [corners(4, 4, 8, 12), corners(8, 4, 12, 12)];
  const fit = scorePieces(halves, target, box, W, weights);
  assert.equal(fit.mismatch.wrong, 0, 'two pieces meeting cover the join once between them');
});

test('pruning drops the anchors that are not paying for themselves', () => {
  const target = rect(4, 4, 12, 12);
  // A square with pointless extra anchors along its edges.
  const wordy = [
    { x: 4, y: 4 },
    { x: 8, y: 4 },
    { x: 12, y: 4 },
    { x: 12, y: 8 },
    { x: 12, y: 12 },
    { x: 8, y: 12 },
    { x: 4, y: 12 },
    { x: 4, y: 8 },
  ];
  const before = scorePieces([wordy], target, box, W, weights);
  const after = prunePoints([wordy], target, box, W, weights);

  assert.ok(after.pieces[0]!.length < wordy.length, 'it dropped some');
  assert.equal(after.mismatch.wrong, 0, 'without getting any pixels wrong');
  assert.ok(after.cost < before.cost);
});

test('an anchor that is earning its place is kept', () => {
  const target = rect(4, 4, 12, 12);
  const square = corners(4, 4, 12, 12);
  const fit = prunePoints([square], target, box, W, weights);
  assert.equal(fit.pieces[0]!.length, 4, 'a square cannot lose a corner for free');
});

test('the weights decide where the balance sits', () => {
  const target = rect(3, 3, 15, 15);
  // A rough circle: many anchors, all of them doing a little.
  const round = Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return { x: 9 + Math.cos(angle) * 6, y: 9 + Math.sin(angle) * 6 };
  });

  const exact = prunePoints([round], target, box, W, { pixel: 1, point: 0, polygon: 0 });
  const terse = prunePoints([round], target, box, W, { pixel: 1, point: 60, polygon: 200 });
  assert.ok(
    terse.pieces[0]!.length < exact.pieces[0]!.length,
    `expensive points should buy fewer of them (${terse.pieces[0]!.length} vs ${exact.pieces[0]!.length})`,
  );
  assert.ok(terse.mismatch.wrong >= exact.mismatch.wrong, 'and cost accuracy to do it');
});

/* ---------------- fitting a stroke ---------------- */

test('a stroke widens until it fills the gap it was traced from', () => {
  // The whole point: the width that leaves fewest wrong pixels *is* the width of
  // the contrast gap, found by measuring rather than estimated.
  for (const thickness of [1, 2, 3, 4, 5]) {
    const ink = rect(8, 3, 8 + thickness, 16);
    const centre = [
      { x: 8 + thickness / 2, y: 3.5 },
      { x: 8 + thickness / 2, y: 15.5 },
    ];
    const fit = fitStroke(centre, ink, box, W, 12, weights);
    assert.ok(
      Math.abs(fit.width - thickness) <= 0.75,
      `ink ${thickness} wide came out ${fit.width}`,
    );
  }
});

test('a stroke does not widen past what it is allowed', () => {
  const ink = rect(6, 3, 14, 16);
  const centre = [
    { x: 10, y: 3.5 },
    { x: 10, y: 15.5 },
  ];
  const fit = fitStroke(centre, ink, box, W, 4, weights);
  assert.ok(fit.width <= 4 + 1e-9, `${fit.width} is over the limit`);
});

test('a stroke grows in length while growing keeps helping, and stops when it does not', () => {
  // Thinning eats the ends of a stroke, so a line drawn from the skeleton alone
  // stops short at both. Extending by a fixed guess would overshoot as often.
  const ink = rect(9, 2, 12, 18);
  const short = [
    { x: 10.5, y: 8 },
    { x: 10.5, y: 11 },
  ];
  const fit = fitStroke(short, ink, box, W, 6, weights);
  const top = Math.min(...fit.points.map((point) => point.y));
  const bottom = Math.max(...fit.points.map((point) => point.y));

  assert.ok(top < 4, `it did not reach the top of the ink (${top})`);
  assert.ok(bottom > 16, `it did not reach the bottom (${bottom})`);
  assert.ok(top > -2 && bottom < 21, 'and it did not run off past it');
});

test('a stroke finds its middle when the ink has no middle column', () => {
  // Two pixels wide: the skeleton lands on one of them, half a pixel off centre,
  // and no symmetric width fits an off-centre line.
  const ink = rect(9, 4, 11, 15);
  const offCentre = [
    { x: 9.5, y: 4.5 },
    { x: 9.5, y: 14.5 },
  ];
  const fit = fitStroke(offCentre, ink, box, W, 8, weights);
  assert.ok(Math.abs(fit.width - 2) <= 0.75, `width came out ${fit.width}`);
  const centre = fit.points[0]!.x;
  assert.ok(Math.abs(centre - 10) <= 0.6, `centre came out ${centre}, wanted about 10`);
});

test('pruning a stroke keeps its ends, because they are where it stops', () => {
  const ink = rect(9, 3, 12, 16);
  const wordy = Array.from({ length: 13 }, (_, index) => ({ x: 10.5, y: 3.5 + index }));
  const fit = scoreStroke(wordy, 3, ink, box, W, weights);
  const pruned = pruneStroke(fit, ink, box, W, weights);

  assert.ok(pruned.points.length < wordy.length, 'it dropped the middle ones');
  assert.deepEqual(pruned.points[0], wordy[0], 'and kept the first');
  assert.deepEqual(pruned.points[pruned.points.length - 1], wordy[wordy.length - 1], 'and the last');
});

/* ---------------- sharing ink ---------------- */

test('crossing strokes divide the ink between them', () => {
  // Strokes that touch are one region, and scoring each against all of it makes
  // the others read as ink this one failed to cover.
  const ink = new Set([...rect(9, 2, 12, 18), ...rect(2, 9, 18, 12)]);
  const vertical = [
    { x: 10.5, y: 2.5 },
    { x: 10.5, y: 17.5 },
  ];
  const horizontal = [
    { x: 2.5, y: 10.5 },
    { x: 17.5, y: 10.5 },
  ];
  const [forVertical, forHorizontal] = shareInk([vertical, horizontal], ink, W);

  // A pixel at the top belongs to the vertical stroke.
  const top = 3 * W + 10;
  assert.equal(forVertical!(top), false, 'the vertical stroke owns its own ink');
  assert.equal(forHorizontal!(top), true, 'and the horizontal one is not judged on it');

  // A pixel out at the left belongs to the horizontal one.
  const left = 10 * W + 3;
  assert.equal(forHorizontal!(left), false);
  assert.equal(forVertical!(left), true);
});

test('a lone stroke owns all of its region', () => {
  const ink = rect(9, 2, 12, 18);
  const [only] = shareInk([[{ x: 10.5, y: 2.5 }, { x: 10.5, y: 17.5 }]], ink, W);
  assert.equal(only!(3 * W + 10), false);
});

test('sharing lets a crossing stroke find its real width', () => {
  const ink = new Set([...rect(9, 2, 12, 18), ...rect(2, 9, 18, 12)]);
  const vertical = [
    { x: 10.5, y: 2.5 },
    { x: 10.5, y: 17.5 },
  ];
  const horizontal = [
    { x: 2.5, y: 10.5 },
    { x: 17.5, y: 10.5 },
  ];
  const [share] = shareInk([vertical, horizontal], ink, W);

  const blind = fitStroke(vertical, ink, box, W, 10, weights);
  const shared = fitStroke(vertical, ink, box, W, 10, weights, { hidden: share });
  assert.ok(
    Math.abs(shared.width - 3) < Math.abs(blind.width - 3) + 1e-9,
    `sharing should not be worse (${shared.width} vs ${blind.width}, ink is 3)`,
  );
  assert.ok(Math.abs(shared.width - 3) <= 0.75, `came out ${shared.width}`);
});

/* ---------------- odds and ends ---------------- */

test('two hidden sets as one are hidden by either', () => {
  const one = (index: number) => index < 5;
  const two = (index: number) => index > 15;
  const both = mergeHidden(one, two)!;
  assert.equal(both(1), true);
  assert.equal(both(20), true);
  assert.equal(both(10), false);
  assert.equal(mergeHidden(one, undefined), one);
  assert.equal(mergeHidden(undefined, two), two);
  assert.equal(mergeHidden(undefined, undefined), undefined);
});

test('a box is the area a fit is judged over, with room to overshoot into', () => {
  const measured = boxOf(rect(5, 5, 9, 9), W, 2);
  assert.deepEqual(measured, { x: 3, y: 3, width: 8, height: 8 });
  assert.deepEqual(boxOf(new Set(), W), { x: 0, y: 0, width: 0, height: 0 });
});
