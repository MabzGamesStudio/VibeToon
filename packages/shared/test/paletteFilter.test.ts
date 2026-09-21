import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  DEFAULT_PALETTE_FILTER_OPTIONS,
  FILTER_MODES,
  FILTER_MODE_HINT,
  FILTER_MODE_LABEL,
  activePalette,
  emptyPaletteFilterFlowData,
  filterImage,
  nearestEntry,
  readPalette,
  summariseFilter,
  weigh,
  type PaletteFilterOptions,
} from '../src/flows/paletteFilter';

const RED = '#dc2828';
const BLUE = '#283cdc';
const GREEN = '#28a028';

const palette = readPalette([RED, BLUE]);

function image(pixels: Array<[number, number, number, number]>): Bitmap {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a], index) => {
    data.set([r, g, b, a], index * 4);
  });
  return { width: pixels.length, height: 1, data };
}

const options = (over: Partial<PaletteFilterOptions> = {}): PaletteFilterOptions => ({
  ...DEFAULT_PALETTE_FILTER_OPTIONS,
  softness: 0,
  ...over,
});

const alphaOf = (pixels: Uint8ClampedArray) =>
  Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4 + 3]!);

/* ---------------- reading a palette ---------------- */

test('a palette is read from what the palette flow writes', () => {
  const written = { entries: [{ hex: RED, share: 0.5 }, { hex: BLUE, share: 0.5 }] };
  assert.deepEqual(readPalette(written).hexes, [RED, BLUE]);
});

test('a palette can also be a plain list of hex strings', () => {
  // Hand-written, or from another tool. Neither should need a converter.
  assert.deepEqual(readPalette([RED, BLUE]).hexes, [RED, BLUE]);
  assert.deepEqual(readPalette({ colors: [RED] }).hexes, [RED]);
  assert.deepEqual(readPalette({ palette: [{ hex: BLUE }] }).hexes, [BLUE]);
});

test('nonsense reads as an empty palette rather than throwing', () => {
  for (const junk of [null, 42, 'red', {}, [], [{ nope: 1 }], ['#zzzzzz']]) {
    assert.deepEqual(readPalette(junk).hexes, [], JSON.stringify(junk));
  }
});

test('a color repeated in the palette is only one entry', () => {
  assert.deepEqual(readPalette([RED, RED.toUpperCase(), BLUE]).hexes, [RED, BLUE]);
});

test('switching entries off narrows what is matched against', () => {
  assert.deepEqual(activePalette(palette, options({ only: [RED] })).hexes, [RED]);
  assert.deepEqual(activePalette(palette, options({ only: [] })).hexes, [RED, BLUE], 'empty means all');
  // Case should not decide whether a brand color is in play.
  assert.deepEqual(activePalette(palette, options({ only: [RED.toUpperCase()] })).hexes, [RED]);
});

/* ---------------- nearest ---------------- */

test('the nearest entry is the one that looks nearest, not the one nearest in RGB', () => {
  const near = nearestEntry({ r: 0xd0, g: 0x30, b: 0x30 }, palette)!;
  assert.equal(palette.hexes[near.index], RED);
  assert.ok(near.distance < 5, `${near.distance}`);
});

test('an empty palette has no nearest, and says so rather than guessing one', () => {
  assert.equal(nearestEntry({ r: 1, g: 2, b: 3 }, readPalette([])), null);
});

/* ---------------- keep ---------------- */

test('keep leaves palette colors alone and makes the rest transparent', () => {
  const source = image([
    [0xdc, 0x28, 0x28, 255], // exactly red
    [0x28, 0x3c, 0xdc, 255], // exactly blue
    [0x28, 0xa0, 0x28, 255], // green: not in the palette
  ]);
  const { pixels, report } = filterImage(source, palette, options({ mode: 'keep', tolerance: 10 }));
  assert.deepEqual(alphaOf(pixels), [255, 255, 0]);
  assert.equal(report.kept, 2);
  assert.equal(report.dropped, 1);
  assert.equal(report.recolored, 0, 'keep never changes a color');
});

test('keep judges by tolerance, so a near-miss counts as the color', () => {
  const nearlyRed = image([[0xd2, 0x32, 0x2e, 255]]);
  assert.deepEqual(alphaOf(filterImage(nearlyRed, palette, options({ tolerance: 10 })).pixels), [255]);
  assert.deepEqual(alphaOf(filterImage(nearlyRed, palette, options({ tolerance: 0.5 })).pixels), [0]);
});

/* ---------------- remove ---------------- */

test('remove is the exact opposite of keep', () => {
  const source = image([
    [0xdc, 0x28, 0x28, 255],
    [0x28, 0xa0, 0x28, 255],
  ]);
  const kept = alphaOf(filterImage(source, palette, options({ mode: 'keep', tolerance: 10 })).pixels);
  const removed = alphaOf(filterImage(source, palette, options({ mode: 'remove', tolerance: 10 })).pixels);
  assert.deepEqual(kept, [255, 0]);
  assert.deepEqual(removed, [0, 255]);
});

/* ---------------- snap ---------------- */

test('snap recolors every pixel and makes nothing transparent', () => {
  const source = image([
    [0xd0, 0x30, 0x30, 255], // nearly red
    [0x30, 0x40, 0xd0, 255], // nearly blue
    [0x28, 0xa0, 0x28, 255], // green, nowhere near either
  ]);
  const { pixels, report } = filterImage(source, palette, options({ mode: 'snap' }));

  assert.deepEqual(alphaOf(pixels), [255, 255, 255], 'snap never drops a pixel');
  assert.deepEqual([pixels[0], pixels[1], pixels[2]], [0xdc, 0x28, 0x28]);
  assert.deepEqual([pixels[4], pixels[5], pixels[6]], [0x28, 0x3c, 0xdc]);
  assert.equal(report.recolored, 3);
  assert.equal(report.dropped, 0);
});

test('snap ignores the tolerance, because every pixel has a nearest', () => {
  // A green pixel has to become something, and refusing to pick would leave a
  // hole in an image the mode promises not to put holes in.
  const green = image([[0x28, 0xa0, 0x28, 255]]);
  const tight = filterImage(green, palette, options({ mode: 'snap', tolerance: 0 }));
  assert.equal(tight.pixels[3], 255);
  assert.ok(tight.pixels[0]! > 0 || tight.pixels[2]! > 0, 'it became one of the two');
});

test('a pixel already on the palette is not counted as recolored', () => {
  const exact = image([[0xdc, 0x28, 0x28, 255]]);
  assert.equal(filterImage(exact, palette, options({ mode: 'snap' })).report.recolored, 0);
});

test('snap reports where the pixels landed, which is what makes it readable', () => {
  const source = image([
    [0xd0, 0x30, 0x30, 255],
    [0xd4, 0x2c, 0x2c, 255],
    [0x30, 0x40, 0xd0, 255],
  ]);
  const { report } = filterImage(source, palette, options({ mode: 'snap' }));
  assert.deepEqual(report.perEntry, [
    { hex: RED, pixels: 2 },
    { hex: BLUE, pixels: 1 },
  ]);
});

/* ---------------- transparency ---------------- */

test('a pixel that was already transparent is left alone in every mode', () => {
  // This flow takes the cutout flow's output, and re-deciding pixels that were
  // deliberately cut away would undo that work.
  const cut = image([[0xdc, 0x28, 0x28, 0]]);
  for (const mode of FILTER_MODES) {
    const { pixels, report } = filterImage(cut, palette, options({ mode }));
    assert.equal(pixels[3], 0, mode);
    assert.equal(report.considered, 0, `${mode} considered a cut-away pixel`);
  }
});

test('softness gives a ramp at the boundary instead of a step', () => {
  assert.equal(weigh(5, 20, 0), 1, 'no softness is a step');
  assert.equal(weigh(25, 20, 0), 0);

  assert.equal(weigh(10, 20, 5), 1, 'well inside stays fully in');
  assert.equal(weigh(30, 20, 5), 0, 'well outside stays fully out');
  assert.equal(weigh(20, 20, 5), 0.5, 'and the threshold itself is halfway');
  assert.ok(weigh(18, 20, 5) > 0.5 && weigh(18, 20, 5) < 1);
});

test('a soft edge shows up as partial alpha in the result', () => {
  const borderline = image([[0xc0, 0x50, 0x50, 255]]);
  const soft = filterImage(borderline, palette, options({ tolerance: 12, softness: 8 })).pixels[3]!;
  assert.ok(soft > 0 && soft < 255, `${soft} should be partial`);
});

test('hard alpha turns a soft decision back into on or off', () => {
  // What you want when the result is going to be indexed color or a sprite.
  const borderline = image([[0xc0, 0x50, 0x50, 255]]);
  const hard = filterImage(borderline, palette, options({ tolerance: 12, softness: 8, hardAlpha: true }));
  assert.ok(hard.pixels[3] === 0 || hard.pixels[3] === 255, `${hard.pixels[3]}`);
});

test('a partly transparent pixel keeps its own transparency as a ceiling', () => {
  const faint = image([[0xdc, 0x28, 0x28, 100]]);
  const { pixels } = filterImage(faint, palette, options({ mode: 'keep', tolerance: 10 }));
  assert.equal(pixels[3], 100, 'kept means "as it was", not "opaque now"');
});

/* ---------------- nothing to do ---------------- */

test('an empty palette leaves the image untouched and says what is wrong', () => {
  // A blank rectangle would look like a bug; having no opinion is the truth.
  const source = image([[0xdc, 0x28, 0x28, 255]]);
  const { pixels, report } = filterImage(source, readPalette([]), options());
  assert.deepEqual(Array.from(pixels), Array.from(source.data));
  assert.ok(report.problems.some((problem) => /no colors/.test(problem)), report.problems.join('; '));
});

test('switching every color off is reported differently from an empty palette', () => {
  const source = image([[0xdc, 0x28, 0x28, 255]]);
  const { report } = filterImage(source, palette, options({ only: ['#000000'] }));
  assert.ok(report.problems.some((problem) => /switched off/.test(problem)), report.problems.join('; '));
});

test('a filter that matched nothing says which way to turn the tolerance', () => {
  const green = image([[0x28, 0xa0, 0x28, 255]]);
  const keep = filterImage(green, palette, options({ mode: 'keep', tolerance: 1 }));
  assert.ok(keep.report.problems.some((problem) => /Raise the tolerance/.test(problem)));

  const remove = filterImage(green, palette, options({ mode: 'remove', tolerance: 200 }));
  assert.ok(remove.report.problems.some((problem) => /Lower the tolerance/.test(problem)));
});

/* ---------------- the flow ---------------- */

test('every mode is labelled and explained', () => {
  for (const mode of FILTER_MODES) {
    assert.ok(FILTER_MODE_LABEL[mode].length > 5, mode);
    assert.ok(FILTER_MODE_HINT[mode].length > 30, `${mode} needs a real explanation`);
  }
});

test('a fresh flow keeps rather than removes, so a first run shows something', () => {
  const fresh = emptyPaletteFilterFlowData();
  assert.equal(fresh.options.mode, 'keep');
  assert.equal(fresh.editor, 'paletteFilter');
  assert.deepEqual(fresh.options.only, []);
});

test('the summary says what happened in the terms of the mode', () => {
  const source = image([
    [0xdc, 0x28, 0x28, 255],
    [0x28, 0xa0, 0x28, 255],
  ]);
  const keep = filterImage(source, palette, options({ mode: 'keep', tolerance: 10 }));
  assert.match(summariseFilter(keep.report, options({ mode: 'keep' })), /50.0% kept, 50.0% made transparent/);

  const snap = filterImage(source, palette, options({ mode: 'snap' }));
  assert.match(summariseFilter(snap.report, options({ mode: 'snap' })), /recolored; nothing was made transparent/);

  const empty = filterImage(image([[0, 0, 0, 0]]), palette, options());
  assert.match(summariseFilter(empty.report, options()), /already transparent/);
});

test('a green-only palette snaps a red image to green, not to nothing', () => {
  // The sanity check that the whole thing is wired the right way round.
  const source = image([[0xdc, 0x28, 0x28, 255]]);
  const { pixels } = filterImage(source, readPalette([GREEN]), options({ mode: 'snap' }));
  assert.deepEqual([pixels[0], pixels[1], pixels[2], pixels[3]], [0x28, 0xa0, 0x28, 255]);
});
