import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PALETTE_OPTIONS,
  applyPinned,
  colorDistance,
  derivePalette,
  emptyPaletteFlowData,
  fromHex,
  fromOklab,
  histogramState,
  mixOklab,
  quantise,
  summarisePalette,
  toHex,
  toOklab,
  type ColorCount,
  type ImageHistogram,
} from '../src/flows/palette';

function counts(...rows: Array<[string, number]>): ColorCount[] {
  return rows.map(([hex, count]) => ({ ...fromHex(hex)!, count }));
}

function histogram(colors: ColorCount[], over: Partial<ImageHistogram> = {}): ImageHistogram {
  return {
    source: 'test.png',
    hash: 'h1',
    width: 10,
    height: 10,
    pixels: colors.reduce((sum, color) => sum + color.count, 0),
    transparent: 0,
    precision: 5,
    colors,
    readAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/* ---------------- measuring color ---------------- */

test('hex round-trips, in both the long and the short form', () => {
  assert.deepEqual(fromHex('#ff8800'), { r: 255, g: 136, b: 0 });
  assert.deepEqual(fromHex('f80'), { r: 255, g: 136, b: 0 }, 'three digits expand');
  assert.equal(toHex({ r: 255, g: 136, b: 0 }), '#ff8800');
  assert.equal(toHex({ r: -5, g: 300, b: 7.6 }), '#00ff08', 'and anything out of range is clamped');
  assert.equal(fromHex('nonsense'), undefined);
  assert.equal(fromHex('#ff88'), undefined);
});

/**
 * The whole point of measuring in OKLab rather than RGB. In RGB these two pairs
 * are exactly the same distance apart, which is why one minimum distance cannot
 * serve a palette measured that way.
 */
test('distance follows the eye, not the channel values', () => {
  const navyVsBlue = colorDistance(fromHex('#000080')!, fromHex('#0000ff')!);
  const redVsGreen = colorDistance(fromHex('#ff0000')!, fromHex('#00ff00')!);

  assert.ok(navyVsBlue < redVsGreen, `navy/blue ${navyVsBlue.toFixed(1)} < red/green ${redVsGreen.toFixed(1)}`);
  assert.ok(redVsGreen > 50, `red to green is ${redVsGreen.toFixed(1)}, which should be a long way`);
  assert.equal(colorDistance(fromHex('#123456')!, fromHex('#123456')!), 0, 'and a color is no distance from itself');

  // Black to white is what the 0..100 scale is pinned to.
  const blackToWhite = colorDistance({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
  assert.ok(blackToWhite > 95 && blackToWhite < 105, `${blackToWhite.toFixed(1)} should be about 100`);

  // Two colors a person would call the same sit under the just-noticeable mark.
  assert.ok(colorDistance(fromHex('#808080')!, fromHex('#828282')!) < 2);
});

test('OKLab round-trips back to the color it came from', () => {
  for (const hex of ['#000000', '#ffffff', '#ff0000', '#0000ff', '#3d7a52', '#c0ffee']) {
    const rgb = fromHex(hex)!;
    const back = fromOklab(toOklab(rgb));
    assert.ok(
      Math.abs(back.r - rgb.r) <= 1 && Math.abs(back.g - rgb.g) <= 1 && Math.abs(back.b - rgb.b) <= 1,
      `${hex} came back as ${toHex(back)}`,
    );
  }
});

test('blending happens in OKLab, so a blend of two blues stays blue', () => {
  const mid = mixOklab(fromHex('#0000ff')!, fromHex('#00ffff')!, 0.5);
  assert.ok(mid.b > mid.r, `${toHex(mid)} should still be blue-ish`);
  assert.deepEqual(mixOklab(fromHex('#123456')!, fromHex('#654321')!, 0), fromHex('#123456'), 'at 0 nothing moves');
  assert.deepEqual(mixOklab(fromHex('#123456')!, fromHex('#654321')!, 1), fromHex('#654321'), 'at 1 it arrives');
});

test('rounding groups near-identical pixels without moving the extremes', () => {
  assert.equal(quantise(255, 5), 255, 'white stays white rather than drifting');
  assert.equal(quantise(0, 5), 0);
  assert.equal(quantise(200, 8), 200, 'eight bits is no rounding at all');

  // Five bits is thirty-two levels a channel, and nothing outside 0..255.
  const levels = new Set(Array.from({ length: 256 }, (_, value) => quantise(value, 5)));
  assert.equal(levels.size, 32);
  assert.ok(Math.min(...levels) === 0 && Math.max(...levels) === 255);

  // Which means a step of about eight: values a step apart land together often
  // enough for a wall to count as one color, and a visible difference survives.
  assert.equal(quantise(100, 5), quantise(102, 5));
  assert.notEqual(quantise(100, 5), quantise(120, 5));

  // A coarser setting groups harder, which is the whole point of the control.
  const coarse = new Set(Array.from({ length: 256 }, (_, value) => quantise(value, 2)));
  assert.equal(coarse.size, 4);
});

/* ---------------- the palette ---------------- */

test('the commonest colors are the palette, in order', () => {
  const palette = derivePalette(
    histogram(counts(['#ff0000', 100], ['#00ff00', 50], ['#0000ff', 25])),
    { count: 3, minDistance: 10 },
  );

  assert.deepEqual(palette.entries.map((entry) => entry.hex), ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(palette.entries.map((entry) => entry.count), [100, 50, 25]);
  assert.equal(palette.entries[0]!.share, 100 / 175);
  assert.equal(palette.pixels, 175);
});

/**
 * The reason the minimum distance exists. Four near-identical blues and one red:
 * without a minimum the palette is four blues, which describes the picture far
 * worse than two colors would.
 */
test('colors too close together share one entry rather than filling the palette', () => {
  const sky = counts(
    ['#4a6fd4', 400],
    ['#4b70d5', 380],
    ['#4c71d6', 360],
    ['#4d72d7', 340],
    ['#cc3322', 200],
  );

  const loose = derivePalette(histogram(sky), { count: 4, minDistance: 0 });
  assert.deepEqual(
    loose.entries.map((entry) => entry.hex),
    ['#4a6fd4', '#4b70d5', '#4c71d6', '#4d72d7'],
    'with no minimum, the gradient takes the whole palette and the red is lost',
  );

  const tight = derivePalette(histogram(sky), { count: 4, minDistance: 10 });
  assert.equal(tight.entries.length, 2, 'the four blues are one mode');
  assert.deepEqual(tight.entries.map((entry) => entry.hex), ['#4a6fd4', '#cc3322']);
  assert.equal(tight.entries[0]!.members, 4, 'and the entry says how many colors it stands for');
  assert.equal(tight.entries[0]!.count, 1480, 'carrying the whole bucket’s tally, not just its own');
  assert.ok(tight.shortfall, 'four were asked for and the image has two that far apart');
});

test('a bucket is seeded by its own commonest color, whatever order it was met in', () => {
  // The dimmer blue is listed first but counted less, so the brighter one seeds.
  const palette = derivePalette(
    histogram(counts(['#4a6fd4', 10], ['#4d72d7', 900], ['#cc3322', 200])),
    { count: 2, minDistance: 10 },
  );
  assert.equal(palette.entries[0]!.hex, '#4d72d7');
  assert.equal(palette.entries[0]!.modeHex, '#4d72d7');
});

test('every pixel ends up in a bucket, so the shares add up', () => {
  // Six distinct colors, a palette of two: the four with nowhere to go still
  // have to be counted somewhere.
  const palette = derivePalette(
    histogram(counts(['#ff0000', 60], ['#00ff00', 50], ['#0000ff', 40], ['#ffff00', 30], ['#00ffff', 20], ['#ff00ff', 10])),
    { count: 2, minDistance: 15 },
  );
  assert.equal(palette.entries.length, 2);
  const covered = palette.entries.reduce((sum, entry) => sum + entry.share, 0);
  assert.ok(Math.abs(covered - 1) < 1e-9, `${covered} should be the whole image`);
  assert.equal(palette.entries.reduce((sum, entry) => sum + entry.count, 0), 210);
});

test('each entry reports how far it is from its nearest neighbour', () => {
  const palette = derivePalette(histogram(counts(['#ff0000', 10], ['#00ff00', 9])), {
    count: 2,
    minDistance: 5,
  });
  const [first, second] = palette.entries;
  assert.equal(first!.nearest, second!.nearest, 'which is the same number read from either side');
  assert.ok(first!.nearest > 50, `${first!.nearest} — red and green are far apart`);
});

test('a single-color image gives a palette of one rather than an error', () => {
  const palette = derivePalette(histogram(counts(['#336699', 500])), { count: 5, minDistance: 10 });
  assert.equal(palette.entries.length, 1);
  assert.equal(palette.entries[0]!.share, 1);
  assert.equal(palette.entries[0]!.nearest, 0, 'with nothing to be near');
  assert.match(palette.shortfall ?? '', /not 5/);
});

test('an image with nothing in it does not throw', () => {
  const palette = derivePalette(histogram([]), { count: 4 });
  assert.deepEqual(palette.entries, []);
  assert.equal(palette.pixels, 0);
});

/* ---------------- seed and temperature ---------------- */

test('temperature 0 is always the mode, and the same seed is always the same palette', () => {
  const sky = histogram(counts(['#4a6fd4', 400], ['#4b70d5', 380], ['#4c71d6', 360]));
  const cold = derivePalette(sky, { count: 1, minDistance: 10, temperature: 0 });
  assert.equal(cold.entries[0]!.hex, '#4a6fd4');
  assert.equal(cold.entries[0]!.shifted, 0);

  const once = derivePalette(sky, { count: 1, minDistance: 10, temperature: 0.8, seed: 'a' });
  const again = derivePalette(sky, { count: 1, minDistance: 10, temperature: 0.8, seed: 'a' });
  assert.deepEqual(once.entries, again.entries, 'same seed, same answer');
});

test('temperature moves an entry off the mode but never out of its own bucket', () => {
  const sky = histogram(counts(['#4a6fd4', 400], ['#4b70d5', 380], ['#4c71d6', 360], ['#4d72d7', 340]));
  const hot = derivePalette(sky, { count: 1, minDistance: 10, temperature: 1, seed: 'shift' });
  const entry = hot.entries[0]!;

  assert.notEqual(entry.hex, entry.modeHex, 'it moved');
  assert.ok(entry.shifted > 0);
  // The bucket's members span a small distance, and the entry stays inside it —
  // so a palette color is always a color the image contains.
  const members = ['#4a6fd4', '#4b70d5', '#4c71d6', '#4d72d7'].map((hex) => fromHex(hex)!);
  const widest = Math.max(...members.map((a) => Math.max(...members.map((b) => colorDistance(a, b)))));
  assert.ok(
    entry.shifted <= widest + 0.5,
    `moved ${entry.shifted} where the bucket is only ${widest.toFixed(1)} wide`,
  );
});

test('a different seed gives a different palette at the same temperature', () => {
  const sky = histogram(
    counts(['#4a6fd4', 400], ['#556699', 380], ['#3c5fc0', 360], ['#5878e0', 340], ['#425aa8', 320]),
  );
  const seeds = ['a', 'b', 'c', 'd'].map(
    (seed) => derivePalette(sky, { count: 1, minDistance: 20, temperature: 1, seed }).entries[0]!.hex,
  );
  assert.ok(new Set(seeds).size > 1, `${seeds.join(' ')} — rerolling should change something`);
});

/* ---------------- the flow's own state ---------------- */

test('a tiny bucket can be dropped, but never the biggest one', () => {
  const rows = counts(['#ff0000', 1000], ['#00ff00', 5]);
  assert.equal(derivePalette(histogram(rows), { count: 4, minDistance: 10, minShare: 0 }).entries.length, 2);

  const lean = derivePalette(histogram(rows), { count: 4, minDistance: 10, minShare: 0.05 });
  assert.equal(lean.entries.length, 1, 'the green is under 5% of the image');
  assert.equal(lean.dropped, 1);

  // Even an absurd floor leaves the commonest color, so a palette is never empty.
  assert.equal(derivePalette(histogram(rows), { minShare: 1 }).entries.length, 1);
});

test('a counted image goes stale when the picture behind it changes', () => {
  const data = emptyPaletteFlowData();
  assert.equal(histogramState(data, 'h1'), 'none', 'nothing read yet');

  const read = { ...data, histogram: histogram(counts(['#ff0000', 10])) };
  assert.equal(histogramState(read, 'h1'), 'fresh');
  assert.equal(histogramState(read, 'h2'), 'stale', 'the image was replaced');
  assert.equal(histogramState(read, undefined), 'stale', 'and an unwired image is not fresh either');
});

test('an entry can be pinned by hand and survives a change of settings', () => {
  const sky = histogram(counts(['#ff0000', 100], ['#00ff00', 50]));
  const pinned = applyPinned(derivePalette(sky, { count: 2, minDistance: 10 }), { '1': '#000000' });

  assert.equal(pinned.entries[0]!.hex, '#ff0000', 'the unpinned entry is untouched');
  assert.equal(pinned.entries[1]!.hex, '#000000');
  assert.ok(pinned.entries[1]!.shifted > 50, 'and it says how far from the counted color it now is');

  // Nonsense in the pin table is ignored rather than blanking the entry.
  const bad = applyPinned(derivePalette(sky, { count: 2, minDistance: 10 }), { '0': 'not a color' });
  assert.equal(bad.entries[0]!.hex, '#ff0000');
});

test('a new flow has settings and no image', () => {
  const data = emptyPaletteFlowData();
  assert.deepEqual(data.options, DEFAULT_PALETTE_OPTIONS);
  assert.equal(data.histogram, undefined);
  assert.deepEqual(data.pinned, {});

  const summary = summarisePalette(derivePalette(histogram(counts(['#ff0000', 10], ['#00ff00', 9]))), data);
  assert.equal(summary.colors, 2);
  assert.equal(summary.pinned, 0);
  assert.ok(Math.abs(summary.covered - 1) < 1e-9);
  assert.ok(summary.closest > 0);
});
