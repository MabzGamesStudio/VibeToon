import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PALETTE_OPTIONS,
  NO_PALETTE_EDITS,
  addColor,
  applyEdits,
  changeColor,
  colorDistance,
  countColors,
  derivePalette,
  emptyPaletteFlowData,
  fromHex,
  fromOklab,
  histogramState,
  mixOklab,
  quantise,
  removeColor,
  restoreColor,
  summarisePalette,
  toHex,
  toOklab,
  type ColorCount,
  type ImageHistogram,
  type PaletteOptions,
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
  assert.deepEqual(fromHex('#ff8800'), { r: 255, g: 136, b: 0, a: 255 }, 'a color with no opacity written is solid');
  assert.deepEqual(fromHex('f80'), { r: 255, g: 136, b: 0, a: 255 }, 'three digits expand');
  assert.equal(toHex({ r: 255, g: 136, b: 0 }), '#ff8800');
  assert.equal(toHex({ r: -5, g: 300, b: 7.6 }), '#00ff08', 'and anything out of range is clamped');
  assert.equal(fromHex('nonsense'), undefined);
  assert.equal(fromHex('#ff88f'), undefined, 'five digits is not a color');
});

test('an opacity is written down only when there is one worth writing', () => {
  /*
   * Six digits for a solid color, so nothing that reads a palette — or a
   * drawing's shape colors, which have no opacity at all — sees anything new.
   * Eight only when something is actually see-through, where the alternative is
   * a palette that silently forgets it.
   */
  assert.equal(toHex({ r: 255, g: 136, b: 0, a: 255 }), '#ff8800');
  assert.equal(toHex({ r: 255, g: 136, b: 0, a: 128 }), '#ff880080');
  assert.equal(toHex({ r: 255, g: 136, b: 0, a: 0 }), '#ff880000');
  assert.deepEqual(fromHex('#ff880080'), { r: 255, g: 136, b: 0, a: 128 });
  assert.deepEqual(fromHex('#f808'), { r: 255, g: 136, b: 0, a: 136 }, 'four digits expand too');
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
  const plain = (hex: string) => {
    const { r, g, b } = fromHex(hex)!;
    return { r, g, b };
  };
  assert.deepEqual(mixOklab(fromHex('#123456')!, fromHex('#654321')!, 0), plain('#123456'), 'at 0 nothing moves');
  assert.deepEqual(mixOklab(fromHex('#123456')!, fromHex('#654321')!, 1), plain('#654321'), 'at 1 it arrives');
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

/* ---------------- counting ---------------- */

function rgba(...pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flat());
}

test('a counted color is one the picture really contains, not its rounded value', () => {
  /*
   * The bug this guards: `#dc2828` rounds to `#de2929` at five bits, and naming
   * the group after that put a color in the palette that no pixel has. A filter
   * keeping pixels that are exactly a palette color then kept nothing, on the flat
   * artwork exact matching exists for.
   */
  assert.equal(toHex({ r: quantise(0xdc, 5), g: quantise(0x28, 5), b: quantise(0x28, 5) }), '#de2929');
  const { colors } = countColors(rgba([0xdc, 0x28, 0x28, 255], [0xdc, 0x28, 0x28, 255]), {
    precision: 5,
    alphaFloor: 8,
  });
  assert.deepEqual(colors.map((color) => toHex(color)), ['#dc2828']);
});

test('pixels that round together are one group, named after the commonest of them', () => {
  const { colors } = countColors(
    rgba([100, 100, 100, 255], [101, 100, 100, 255], [101, 100, 100, 255], [102, 101, 100, 255]),
    { precision: 5, alphaFloor: 8 },
  );
  assert.equal(colors.length, 1, 'still grouped, which is what rounding is for');
  assert.equal(colors[0]!.count, 4);
  assert.equal(toHex(colors[0]!), '#656464', 'and named after the one seen twice');
});

test('a group is named the same way whatever order its pixels come in', () => {
  const one = countColors(rgba([100, 100, 100, 255], [101, 100, 100, 255]), { precision: 5, alphaFloor: 8 });
  const two = countColors(rgba([101, 100, 100, 255], [100, 100, 100, 255]), { precision: 5, alphaFloor: 8 });
  assert.deepEqual(one.colors, two.colors);
});

test('counting keeps an average opacity, and leaves it off a solid color', () => {
  const { colors, counted, transparent } = countColors(
    rgba([10, 20, 30, 255], [200, 0, 0, 100], [200, 0, 0, 200], [5, 5, 5, 3]),
    { precision: 8, alphaFloor: 8 },
  );
  assert.equal(counted, 3);
  assert.equal(transparent, 1, 'below the floor is not a color');
  const red = colors.find((color) => color.r === 200)!;
  assert.equal(red.a, 150);
  assert.equal('a' in colors.find((color) => color.r === 10)!, false);
});

test('a stride counts every nth pixel and nothing else', () => {
  const pixels = rgba([255, 0, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255], [0, 0, 255, 255]);
  const { colors, counted } = countColors(pixels, { precision: 5, alphaFloor: 8, stride: 2 });
  assert.equal(counted, 2);
  assert.deepEqual(colors.map((color) => toHex(color)), ['#ff0000']);
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

/* ---------------- editing the palette ---------------- */

const sky = () => histogram(counts(['#ff0000', 100], ['#00ff00', 50], ['#0000ff', 20]));
const derived = (over: Partial<PaletteOptions> = {}) =>
  derivePalette(sky(), { count: 3, minDistance: 10, ...over });

/* ---------------- opacity ---------------- */

test('a color read out of the image carries how opaque its pixels were', () => {
  const palette = derivePalette(histogram(counts(['#ff000080', 100], ['#00ff00', 50])), {
    count: 2,
    minDistance: 10,
  });
  assert.equal(palette.entries[0]!.a, 0x80);
  assert.equal(palette.entries[0]!.hex, '#ff000080', 'and the hex says so');
  assert.equal(palette.entries[1]!.a, 255);
  assert.equal(palette.entries[1]!.hex, '#00ff00', 'a solid color is still six digits');
});

test('a group’s opacity is its pixels’ average, weighted by how many there were', () => {
  /*
   * One color drawn solid across a wall and the same color half-faded in a shadow
   * are one entry. Its opacity is what those pixels were between them — not what
   * the one that happened to seed the bucket was.
   */
  const palette = derivePalette(histogram(counts(['#4a6fd4', 300], ['#4b70d500', 100])), {
    count: 1,
    minDistance: 10,
  });
  assert.equal(palette.entries.length, 1, 'the two are one group');
  assert.equal(palette.entries[0]!.a, Math.round((255 * 300 + 0 * 100) / 400));
});

test('an entry is found by its color, so a faded picture keeps the edits made to it', () => {
  // The reason a group is keyed on color alone. Fade the artwork and every edit
  // would otherwise be stored against a bucket that no longer exists.
  const solid = derivePalette(histogram(counts(['#ff0000', 100])), { count: 1, minDistance: 10 });
  const faded = derivePalette(histogram(counts(['#ff000080', 100])), { count: 1, minDistance: 10 });
  assert.equal(solid.entries[0]!.modeHex, faded.entries[0]!.modeHex);
});

test('opacity is edited the same way a color is, and reset the same way', () => {
  const entry = derived().entries[1]!;
  const edits = changeColor(NO_PALETTE_EDITS, entry, toHex({ r: entry.r, g: entry.g, b: entry.b, a: 64 }));
  const palette = applyEdits(derived(), edits);

  assert.equal(palette.entries[1]!.a, 64);
  assert.equal(palette.entries[1]!.hex, '#00ff0040');
  assert.equal(palette.entries[1]!.shifted, 0, 'the color did not move, only the opacity');

  const back = applyEdits(derived(), changeColor(edits, entry, ''));
  assert.equal(back.entries[1]!.a, 255, 'and resetting puts the opacity back with the color');
});

test('a color added by hand can be see-through, which is how you erase one', () => {
  const palette = applyEdits(derived(), addColor(NO_PALETTE_EDITS, '#33445500'));
  const added = palette.entries.at(-1)!;
  assert.equal(added.a, 0);
  assert.equal(added.hex, '#33445500');
  assert.ok(added.byHand);
});

test('the same color at two opacities is two entries, because it filters differently', () => {
  const edits = addColor(addColor(NO_PALETTE_EDITS, '#334455'), '#33445580');
  assert.deepEqual(edits.added, ['#334455', '#33445580']);
});

/* ---------------- changing, taking out, adding ---------------- */

test('an entry can be changed by hand, and says how far from the image it now is', () => {
  const edits = changeColor(NO_PALETTE_EDITS, derived().entries[1]!, '#000000');
  const palette = applyEdits(derived(), edits);

  assert.equal(palette.entries[0]!.hex, '#ff0000', 'the entry beside it is untouched');
  assert.equal(palette.entries[1]!.hex, '#000000');
  assert.ok(palette.entries[1]!.shifted > 50, 'and it is measured from the color that was counted');
});

test('nonsense typed into a hex box leaves the entry alone rather than blanking it', () => {
  const palette = applyEdits(derived(), { changed: { '#ff0000': 'not a color' }, removed: [], added: [] });
  assert.equal(palette.entries[0]!.hex, '#ff0000');
});

test('a change is remembered against its color group, not its position', () => {
  /*
   * The reason edits are keyed the way they are. Ask for two colors instead of
   * three and every position below the change means something else — so an edit
   * stored against "2" would land on a color nobody chose.
   */
  const green = derived().entries[1]!;
  assert.equal(green.hex, '#00ff00');
  const edits = changeColor(NO_PALETTE_EDITS, green, '#000000');

  // Reversed, so the position that was green is now blue.
  const reversed = derivePalette(
    histogram(counts(['#0000ff', 100], ['#00ff00', 50], ['#ff0000', 20])),
    { count: 3, minDistance: 10 },
  );
  const applied = applyEdits(reversed, edits);
  const black = applied.entries.filter((entry) => entry.hex === '#000000');
  assert.equal(black.length, 1, 'the edit was applied once');
  assert.equal(black[0]!.modeHex, '#00ff00', 'and to the green it was made for');
});

test('an entry can be taken out, and put back', () => {
  const green = derived().entries[1]!;
  const taken = removeColor(NO_PALETTE_EDITS, green);
  const fewer = applyEdits(derived(), taken);

  assert.equal(fewer.entries.length, 2);
  assert.ok(!fewer.entries.some((entry) => entry.hex === '#00ff00'), 'the green is gone');
  assert.ok(fewer.entries.every((entry) => entry.share > 0), 'and what is left still stands for pixels');
  // What it accounted for is no longer covered, and the summary says so rather
  // than quietly re-crediting its share to a neighbour.
  assert.ok(applyEdits(derived()).entries.reduce((sum, e) => sum + e.share, 0) > 0.99);
  assert.ok(fewer.entries.reduce((sum, entry) => sum + entry.share, 0) < 0.8);

  const back = applyEdits(derived(), restoreColor(taken, '#00ff00'));
  assert.equal(back.entries.length, 3);
  assert.ok(back.entries.some((entry) => entry.hex === '#00ff00'));
});

test('taking an entry out forgets the change made to it', () => {
  // Otherwise undoing the removal brings back an edit you had stopped thinking
  // about, and the color comes back as something other than what was counted.
  const green = derived().entries[1]!;
  const edited = changeColor(NO_PALETTE_EDITS, green, '#123456');
  const taken = removeColor(edited, green);
  assert.deepEqual(taken.changed, {});

  const back = applyEdits(derived(), restoreColor(taken, '#00ff00'));
  assert.equal(back.entries[1]!.hex, '#00ff00');
});

test('a color can be added that is not in the picture at all', () => {
  const edits = addColor(NO_PALETTE_EDITS, '#ff00ff');
  const palette = applyEdits(derived(), edits);

  assert.equal(palette.entries.length, 4);
  const added = palette.entries[3]!;
  assert.equal(added.hex, '#ff00ff');
  assert.equal(added.byHand, true);
  assert.equal(added.share, 0, 'it stands for none of the image');
  assert.equal(added.count, 0);
  assert.ok(added.nearest > 0, 'and it knows how close it sits to the rest');
});

test('the same color is not added twice', () => {
  const once = addColor(NO_PALETTE_EDITS, '#ff00ff');
  assert.deepEqual(addColor(once, '#FF00FF').added, ['#ff00ff'], 'case and hash do not make it new');
  assert.deepEqual(addColor(once, 'not a color').added, ['#ff00ff']);
});

test('a color you added is edited where it stands, and forgotten when dropped', () => {
  const edits = addColor(NO_PALETTE_EDITS, '#ff00ff');
  const mine = applyEdits(derived(), edits).entries[3]!;

  const moved = changeColor(edits, mine, '#00ffff');
  assert.deepEqual(moved.added, ['#00ffff']);
  assert.deepEqual(moved.changed, {}, 'no second record of the same color');

  assert.deepEqual(removeColor(edits, mine).added, []);
});

test('an edit for a color the settings no longer produce waits rather than vanishing', () => {
  const blue = derived().entries[2]!;
  const edits = changeColor(NO_PALETTE_EDITS, blue, '#000000');

  const two = derived({ count: 2 });
  assert.equal(two.entries.length, 2, 'the blue is no longer its own entry');
  const applied = applyEdits(two, edits);
  assert.ok(!applied.entries.some((entry) => entry.hex === '#000000'), 'the edit does nothing');

  const summary = summarisePalette(applied, { ...emptyPaletteFlowData(), edits });
  assert.equal(summary.changed, 0);
  assert.equal(summary.waiting, 1, 'and it is reported as waiting rather than applied');

  // And it comes back when the setting does.
  assert.ok(applyEdits(derived(), edits).entries.some((entry) => entry.hex === '#000000'));
});

test('the closest pair is worked out again after an edit', () => {
  // The figure exists to answer "is the minimum distance being met", and two
  // colors chosen by hand can sit far closer than any bucketing would put them.
  const edits = addColor(NO_PALETTE_EDITS, '#fe0000');
  const palette = applyEdits(derived(), edits);
  const summary = summarisePalette(palette, { ...emptyPaletteFlowData(), edits });
  assert.ok(summary.closest < 1, `the closest pair reads ${summary.closest}`);
});

test('a new flow has settings, no image, and no edits', () => {
  const data = emptyPaletteFlowData();
  assert.deepEqual(data.options, DEFAULT_PALETTE_OPTIONS);
  assert.equal(data.histogram, undefined);
  assert.deepEqual(data.edits, { changed: {}, removed: [], added: [] });

  const summary = summarisePalette(derivePalette(histogram(counts(['#ff0000', 10], ['#00ff00', 9]))), data);
  assert.equal(summary.colors, 2);
  assert.equal(summary.changed + summary.removed + summary.added + summary.waiting, 0);
  assert.ok(Math.abs(summary.covered - 1) < 1e-9);
  assert.ok(summary.closest > 0);
});
