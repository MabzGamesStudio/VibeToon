import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  DEFAULT_LINE_OPTIONS,
  detectLines,
  emptyLinesFlowData,
  isBlend,
  lineImage,
  linesReport,
  readLineImage,
  widthShade,
  normaliseLineOptions,
  summariseLines,
} from '../src/flows/lines';

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const SKY: Rgb = [90, 150, 230];
const GRASS: Rgb = [70, 170, 60];

/** A picture painted by a function of each pixel. */
function paint(width: number, height: number, colour: (x: number, y: number) => Rgb): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function at(result: ReturnType<typeof detectLines>, x: number, y: number): number {
  return result.confidence[y * result.width + x]!;
}

function count(result: ReturnType<typeof detectLines>): number {
  return result.confidence.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
}

test('a stroke between two areas is a line, and only the stroke', () => {
  const picture = paint(60, 40, (x) => (x >= 30 && x < 33 ? BLACK : WHITE));
  const result = detectLines(picture);
  for (let y = 0; y < 40; y += 1) {
    for (const x of [30, 31, 32]) assert.ok(at(result, x, y) > 0, `(${x}, ${y}) is on the line`);
    for (const x of [0, 10, 28, 29, 33, 34, 50]) assert.equal(at(result, x, y), 0, `(${x}, ${y}) is not`);
  }
});

test('a line between two different colours is still a line', () => {
  const picture = paint(60, 40, (x) => (x < 28 ? SKY : x < 30 ? BLACK : GRASS));
  const result = detectLines(picture);
  assert.ok(at(result, 28, 20) > 0 && at(result, 29, 20) > 0);
  assert.equal(count(result), 2 * 40);
});

test('where one colour meets another there is an edge, not a line', () => {
  const picture = paint(60, 40, (x) => (x < 30 ? SKY : GRASS));
  assert.equal(count(detectLines(picture)), 0);
});

test('a gradient is not a line', () => {
  const picture = paint(80, 40, (x) => {
    const v = Math.round((x / 79) * 255);
    return [v, v, v];
  });
  assert.equal(count(detectLines(picture)), 0);
});

test('a soft edge, one blended pixel wide, is not a line', () => {
  const picture = paint(60, 40, (x) => (x < 30 ? BLACK : x === 30 ? [128, 128, 128] : WHITE));
  assert.equal(count(detectLines(picture)), 0);
  assert.ok(isBlend([0, 0, 0, 255], [128, 128, 128, 255], [255, 255, 255, 255]));
  assert.ok(!isBlend([255, 255, 255, 255], [0, 0, 0, 255], [255, 255, 255, 255]), 'black between white is its own colour');
});

test('a line must be longer than it is wide, by the ratio', () => {
  // A black dash 3 wide and 6 long on white.
  const picture = paint(40, 40, (x, y) => (x >= 18 && x < 21 && y >= 17 && y < 23 ? BLACK : WHITE));
  assert.equal(count(detectLines(picture, { ratio: 3 })), 0, 'twice as long as wide is not three times');
  assert.ok(count(detectLines(picture, { ratio: 1.5 })) > 0, 'but is one and a half');
});

test('anything wider than the widest line is an area', () => {
  const band = paint(60, 40, (x) => (x >= 20 && x < 32 ? BLACK : WHITE));
  assert.equal(count(detectLines(band, { maxWidth: 8 })), 0);
  assert.ok(count(detectLines(band, { maxWidth: 16 })) > 0);
});

test('a diagonal line is found by the diagonal walks', () => {
  const picture = paint(60, 60, (x, y) => (Math.abs(x - y) <= 1 ? BLACK : WHITE));
  const result = detectLines(picture);
  let on = 0;
  for (let i = 5; i < 55; i += 1) if (at(result, i, i) > 0) on += 1;
  assert.ok(on >= 45, `${on} of 50 pixels along the diagonal`);
  assert.equal(at(result, 40, 10), 0);
});

test('a line across chunk borders is found all along it', () => {
  const picture = paint(100, 100, (x) => (x >= 47 && x < 50 ? BLACK : WHITE));
  const result = detectLines(picture, { chunk: 16 });
  for (let y = 0; y < 100; y += 1) assert.ok(at(result, 48, y) > 0, `row ${y}`);
});

test('a sharper line is a surer one', () => {
  const strong = detectLines(paint(60, 40, (x) => (x >= 30 && x < 32 ? BLACK : WHITE)));
  const faint = detectLines(paint(60, 40, (x) => (x >= 30 && x < 32 ? [200, 200, 200] : WHITE)));
  assert.ok(at(faint, 30, 20) > 0, 'a faint line is still a line');
  assert.ok(at(strong, 30, 20) > at(faint, 30, 20));
});

test('the line picture is black, with thin lines red and brighter the surer', () => {
  const result = detectLines(paint(60, 40, (x) => (x >= 30 && x < 31 ? BLACK : WHITE)));
  const image = lineImage(result);
  assert.deepEqual([...image.data.subarray(0, 4)], [0, 0, 0, 255]);
  const on = (20 * 60 + 30) * 4;
  assert.equal(image.data[on]!, Math.round(at(result, 30, 20) * 255), 'a one-pixel line is all red');
  assert.equal(image.data[on + 1], 0);
  assert.equal(image.data[on + 2], 0);
});

test('each line pixel knows how wide its line is, straight across', () => {
  const upright = detectLines(paint(60, 40, (x) => (x >= 30 && x < 34 ? BLACK : WHITE)));
  assert.equal(upright.lineWidth[20 * 60 + 31], 4);
  assert.equal(upright.lineWidth[20 * 60 + 10], 0, 'no line, no width');
  // A 45° band three pixels thick along the diagonal.
  const slanted = detectLines(paint(60, 60, (x, y) => (Math.abs(x - y) <= 1 ? BLACK : WHITE)));
  const across = slanted.lineWidth[30 * 60 + 30]!;
  // Straight across it is 3/√2 ≈ 2.1; a diagonal walk steps over every other pixel, so it reads 1.4 or 2.8.
  assert.ok(across > 1.2 && across < 3.5, `${across}`);
});

test('the wider the line, the bluer', () => {
  const thin = lineImage(detectLines(paint(60, 40, (x) => (x >= 30 && x < 32 ? BLACK : WHITE))));
  const wide = lineImage(detectLines(paint(60, 40, (x) => (x >= 26 && x < 36 ? BLACK : WHITE)), { maxWidth: 16 }));
  const blueShare = (image: typeof thin, x: number) => {
    const at = (20 * 60 + x) * 4;
    return image.data[at + 2]! / (image.data[at]! + image.data[at + 2]!);
  };
  assert.ok(blueShare(wide, 30) > blueShare(thin, 30) + 0.4);
  assert.equal(widthShade(1), 0);
  assert.equal(widthShade(99), 1);
});

test('a line picture reads back as the confidence and width it was drawn from', () => {
  const result = detectLines(paint(60, 40, (x) => (x >= 20 && x < 26 ? BLACK : x === 40 ? BLACK : WHITE)));
  const read = readLineImage(lineImage(result));
  for (const x of [22, 40]) {
    const i = 20 * 60 + x;
    assert.ok(Math.abs(read.confidence[i]! - result.confidence[i]!) < 0.01);
    assert.ok(Math.abs(read.lineWidth[i]! - result.lineWidth[i]!) < 0.1, `${read.lineWidth[i]} against ${result.lineWidth[i]}`);
  }
  assert.equal(read.confidence[20 * 60 + 5], 0);
});

test('settings are kept in range, and the report says what was found', () => {
  const options = normaliseLineOptions({ contrast: -5, maxWidth: 0.2, chunk: 2, ratio: 0 });
  assert.equal(options.contrast, 1);
  assert.equal(options.maxWidth, 1);
  assert.equal(options.chunk, 8);
  assert.ok(options.ratio > 0);
  assert.deepEqual(emptyLinesFlowData().options, DEFAULT_LINE_OPTIONS);
  const result = detectLines(paint(30, 30, (x) => (x === 15 ? BLACK : WHITE)));
  assert.match(summariseLines(result), /30 × 30 · 30 line pixels/);
  assert.match(linesReport(result, DEFAULT_LINE_OPTIONS, 'Sketch'), /Found in \*\*Sketch\*\*/);
});

test('where a walk clips a corner, the colour beside a line is not taken for part of it', () => {
  // A black-outlined box standing where sky meets grass: the diagonal walks
  // cut short runs of sky between the grass and the outline.
  const picture = paint(120, 100, (x, y) => {
    const inBox = x >= 30 && x < 90 && y >= 20 && y < 80;
    if (inBox && (x < 33 || x >= 87 || y < 23 || y >= 77)) return BLACK;
    if (inBox) return [220, 200, 170];
    return y < 50 ? SKY : GRASS;
  });
  const result = detectLines(picture);
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 120; x += 1) {
      const onOutline = x >= 30 && x < 90 && y >= 20 && y < 80 && (x < 33 || x >= 87 || y < 23 || y >= 77);
      if (!onOutline) assert.equal(at(result, x, y), 0, `(${x}, ${y}) is not on the outline`);
    }
  }
  assert.ok(at(result, 31, 50) > 0 && at(result, 60, 21) > 0);
});
