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
  foldSmallAreas,
  nearestEntry,
  readPalette,
  summariseFilter,
  type PaletteFilterOptions,
} from '../src/flows/paletteFilter';

const RED = '#dc2828';
const BLUE = '#283cdc';
const GREEN = '#28a028';
/* Red at half opacity. The palette writes an eight-digit hex when, and only
 * when, the entry is not solid. */
const FAINT_RED = '#dc282880';

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
  ...over,
});

/** Pixels of every color and opacity, the same every run. */
function noise(count: number): Bitmap {
  const data = new Uint8ClampedArray(count * 4);
  let seed = 12345;
  for (let index = 0; index < data.length; index += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[index] = seed >>> 24;
  }
  // A good share of them fully transparent, with junk color numbers.
  for (let pixel = 0; pixel < count; pixel += 7) data[pixel * 4 + 3] = 0;
  return { width: count, height: 1, data };
}

const alphaOf = (pixels: Uint8ClampedArray) =>
  Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4 + 3]!);

/* ---------------- reading a palette ---------------- */

test('a palette is read from what the palette flow writes', () => {
  const written = { entries: [{ hex: RED, share: 0.5 }, { hex: BLUE, share: 0.5 }] };
  assert.deepEqual(readPalette(written).hexes, [RED, BLUE]);
});

test('an entry that is not solid keeps its opacity through the read', () => {
  const read = readPalette([FAINT_RED, RED]);
  assert.deepEqual(read.hexes, [FAINT_RED, RED], 'and stays a separate entry from the solid one');
  assert.equal(read.colors[0]!.a, 0x80);
  assert.equal(read.colors[1]!.a, 255, 'a six-digit entry is fully opaque');
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

test('the nearest entry is the nearest by hue, saturation and brightness', () => {
  const near = nearestEntry({ r: 0xd0, g: 0x30, b: 0x30 }, palette)!;
  assert.equal(palette.hexes[near.index], RED);
  assert.ok(near.distance < 12, `${near.distance}`);
});

test('distance is by hue, saturation, brightness and opacity, in the HSB cone', async () => {
  const { hsbaOf, hsbaDistance, hsbOf } = await import('../src/flows/paletteFilter');
  const d = (a: [number, number, number, number], b: [number, number, number, number]) =>
    hsbaDistance(hsbaOf({ r: a[0], g: a[1], b: a[2], a: a[3] }), hsbaOf({ r: b[0], g: b[1], b: b[2], a: b[3] }));
  assert.equal(Math.round(d([0, 0, 0, 255], [255, 255, 255, 255])), 100, 'black to white is 100');
  assert.equal(Math.round(d([255, 0, 0, 255], [255, 0, 0, 0])), 100, 'solid to clear is 100');
  assert.equal(d([10, 20, 30, 0], [200, 0, 0, 0]), 0, 'two clear pixels are the same whatever their numbers');
  // Two greys a step apart differ only by that step, whatever hue their rounding gives them.
  assert.ok(d([128, 128, 128, 255], [129, 128, 128, 255]) < 1);
  // Opposite hues at full saturation are further apart than a hue a little round.
  assert.ok(d([255, 0, 0, 255], [0, 255, 255, 255]) > d([255, 0, 0, 255], [255, 80, 0, 255]) * 3);
  // A dark red is nearer black than a bright red is.
  assert.ok(d([80, 0, 0, 255], [0, 0, 0, 255]) < d([255, 0, 0, 255], [0, 0, 0, 255]));
  const hsb = hsbOf({ r: 0, g: 255, b: 0 });
  assert.deepEqual([Math.round(hsb.h), hsb.s, hsb.b], [120, 1, 1]);
});

test('snap takes the absolute nearest entry: a dim red goes to dark red, not to a mid grey', () => {
  const two = readPalette(['#700000', '#8a8a8a']);
  const { pixels } = filterImage(image([[0x90, 0x40, 0x40, 255]]), two, options({ mode: 'snap' }));
  assert.deepEqual(Array.from(pixels), [0x70, 0x00, 0x00, 255]);
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

test('a tolerance of zero means the exact palette value and nothing else', () => {
  // What flat artwork wants: a drawing made from a palette contains those colors
  // and no others, so a pixel one step off is a pixel that is not the color.
  const source = image([
    [0xdc, 0x28, 0x28, 255], // exactly red
    [0xdb, 0x28, 0x28, 255], // one step off, invisibly
  ]);
  assert.deepEqual(alphaOf(filterImage(source, palette, options({ tolerance: 0 })).pixels), [255, 0]);
});

test('keep hands the source pixel back untouched, not the palette value', () => {
  // The point of a tolerance is to take in shading; recoloring to the entry it
  // matched would throw that shading away again.
  const shaded = image([[0xd2, 0x32, 0x2e, 255]]);
  const { pixels } = filterImage(shaded, palette, options({ tolerance: 10 }));
  assert.deepEqual(Array.from(pixels), [0xd2, 0x32, 0x2e, 255]);
});

test('what keep does not keep is fully transparent — four zeros, not a faded color', () => {
  const green = image([[0x28, 0xa0, 0x28, 255]]);
  const { pixels } = filterImage(green, palette, options({ tolerance: 10 }));
  assert.deepEqual(Array.from(pixels), [0, 0, 0, 0]);
});

test('keep writes nothing but source pixels and clear ones, however varied the picture', () => {
  // The rule, checked by counting: every output pixel is either exactly the pixel
  // that was there or (0, 0, 0, 0). A variety of pixels, and nothing invented.
  const source = noise(2000);
  const { pixels } = filterImage(source, palette, options({ tolerance: 30 }));
  let kept = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    const same = [0, 1, 2, 3].every((channel) => pixels[at + channel] === source.data[at + channel]);
    const clear = [0, 1, 2, 3].every((channel) => pixels[at + channel] === 0);
    assert.ok(same || clear, `pixel ${at / 4} is neither the source nor clear: ${Array.from(pixels.slice(at, at + 4))}`);
    if (same && !clear) kept += 1;
  }
  assert.ok(kept > 20, `${kept} kept — the test picture has to keep something to prove anything`);
});

test('keep writes a transparent pixel as (0, 0, 0, 0), not with the color numbers it carried', () => {
  const withClear = readPalette([RED, '#00000000']);
  const cut = image([
    [0xff, 0xff, 0xff, 0],
    [0x0c, 0x22, 0x38, 0],
    [0xdc, 0x28, 0x28, 255],
  ]);
  const { pixels } = filterImage(cut, withClear, options({ tolerance: 0 }));
  assert.deepEqual(Array.from(pixels), [0, 0, 0, 0, 0, 0, 0, 0, 0xdc, 0x28, 0x28, 255]);
});

test('keeping the other colors is how you drop one', () => {
  // There is no remove mode: an inverted answer is the same question asked about
  // the rest of the palette, and this is the whole of what it used to do.
  const source = image([
    [0xdc, 0x28, 0x28, 255],
    [0x28, 0x3c, 0xdc, 255],
  ]);
  const withoutRed = options({ tolerance: 10, only: [BLUE] });
  assert.deepEqual(alphaOf(filterImage(source, palette, withoutRed).pixels), [0, 255]);
});

test('keep matches opacity as well as color: solid red is not the half-transparent red entry', () => {
  const source = image([
    [0xdc, 0x28, 0x28, 255],
    [0xdc, 0x28, 0x28, 0x80],
  ]);
  const { pixels } = filterImage(source, readPalette([FAINT_RED]), options({ tolerance: 0 }));
  assert.deepEqual(Array.from(pixels), [0, 0, 0, 0, 0xdc, 0x28, 0x28, 0x80]);
});

test('a fainter pixel of a palette color is kept only when the tolerance takes it in, and then as it was', () => {
  const faint = image([[0xdc, 0x28, 0x28, 100]]);
  assert.deepEqual(Array.from(filterImage(faint, palette, options({ tolerance: 0 })).pixels), [0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(filterImage(faint, palette, options({ tolerance: 65 })).pixels),
    [0xdc, 0x28, 0x28, 100],
    'kept means "as it was", not "opaque now"',
  );
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

test('snap takes the entry’s opacity as well as its color', () => {
  // Which is what an opacity in a palette is for: naming a see-through color and
  // snapping to it fades the part of the picture that is that color.
  const source = image([[0xd0, 0x30, 0x30, 255]]);
  const { pixels, report } = filterImage(source, readPalette([FAINT_RED]), options({ mode: 'snap' }));
  assert.deepEqual(Array.from(pixels), [0xdc, 0x28, 0x28, 0x80]);
  assert.equal(report.kept, 1, 'faded is not gone');
});

test('a snapped pixel takes the entry’s opacity exactly, whatever its own was', () => {
  // Nothing is multiplied: a pixel becomes the entry's four numbers, so the result
  // holds palette values and no others.
  const half = image([[0xd0, 0x30, 0x30, 128]]);
  const { pixels } = filterImage(half, readPalette([FAINT_RED]), options({ mode: 'snap' }));
  assert.deepEqual(Array.from(pixels), [0xdc, 0x28, 0x28, 0x80]);
});

test('snap leaves exactly as many values in the picture as the palette has, and no others', () => {
  /*
   * The rule, checked by counting. Five colors and a clear one: two thousand
   * pixels of noise — every color, every opacity, fully transparent ones with
   * junk color numbers — come out as those six RGBA values and nothing else.
   */
  const six = readPalette([RED, BLUE, GREEN, '#ffffff', '#101010', '#00000000']);
  const { pixels } = filterImage(noise(2000), six, options({ mode: 'snap' }));
  const allowed = new Set(six.colors.map(({ r, g, b, a }) => `${r},${g},${b},${a}`));
  const seen = new Set<string>();
  for (let at = 0; at < pixels.length; at += 4) seen.add(Array.from(pixels.slice(at, at + 4)).join(','));
  for (const value of seen) assert.ok(allowed.has(value), `${value} is not a palette value`);
  assert.equal(seen.size, 6, 'and with this much noise, every one of them is used');
});

test('snapping soft edges gives each one its own color or clear, never a neighbour', () => {
  // Opaque colors and a clear entry, the palette a cut-out drawing gets. An edge
  // pixel of any of them, at any opacity, snaps to itself above half and to clear
  // below — so a snapped cut-out has no colored fringes.
  const hexes = [RED, BLUE, '#e6c828', GREEN, '#ffffff', '#101010', '#00000000'];
  const cut = readPalette(hexes);
  for (const hex of hexes.slice(0, -1)) {
    const color = cut.colors[cut.hexes.indexOf(hex)]!;
    for (let a = 1; a < 255; a += 1) {
      const landed = cut.hexes[nearestEntry({ ...color, a }, cut)!.index];
      assert.equal(landed, a >= 128 ? hex : '#00000000', `${hex} at alpha ${a}`);
    }
  }
});

test('a transparent pixel snaps to the clear entry, whatever color numbers it carries', () => {
  const withClear = readPalette([RED, BLUE, '#00000000']);
  const cut = image([
    [0xdc, 0x28, 0x28, 0],
    [0xff, 0xff, 0xff, 0],
    [0xdc, 0x28, 0x28, 3], // all but gone
  ]);
  const { pixels, report } = filterImage(cut, withClear, options({ mode: 'snap' }));
  assert.deepEqual(Array.from(pixels), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(report.filled, 0);
  assert.deepEqual(report.problems, []);
});

test('with no clear entry in play, snap has to give transparent pixels a color — and says so', () => {
  const cut = image([
    [0xdc, 0x28, 0x28, 0],
    [0xdc, 0x28, 0x28, 255],
  ]);
  const { pixels, report } = filterImage(cut, palette, options({ mode: 'snap' }));
  assert.equal(pixels[3], 255, 'every pixel is a palette value, and this palette has no clear one');
  assert.equal(report.filled, 1);
  assert.ok(report.problems.some((problem) => /transparent pixel\(s\) were given a color/.test(problem)));
});

test('an entry with no opacity at all erases what snaps to it', () => {
  const source = image([[0xd0, 0x30, 0x30, 255]]);
  const { pixels, report } = filterImage(source, readPalette(['#dc282800']), options({ mode: 'snap' }));
  assert.equal(pixels[3], 0);
  assert.equal(report.dropped, 1);
  assert.equal(report.kept, 0);
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

test('a pixel that was already transparent stays transparent, in both modes, given a clear entry', () => {
  // This flow takes the cutout flow's output, and re-deciding pixels that were
  // deliberately cut away would undo that work.
  const cut = image([[0xdc, 0x28, 0x28, 0]]);
  const withClear = readPalette([RED, BLUE, '#00000000']);
  for (const mode of FILTER_MODES) {
    const { pixels, report } = filterImage(cut, withClear, options({ mode }));
    assert.equal(pixels[3], 0, mode);
    assert.equal(report.considered, 0, `${mode} counted a cut-away pixel as part of the picture`);
    assert.equal(report.clearIn, 1);
  }
});

test('keep decides, rather than fading — a pixel is the color or it is not', () => {
  // There is no soft band around the tolerance any more. Keep answers a question
  // about the source pixels, and half an answer is not one.
  const borderline = image([[0xc0, 0x50, 0x50, 255]]);
  for (const tolerance of [0, 4, 8, 12, 20, 40]) {
    const alpha = filterImage(borderline, palette, options({ tolerance })).pixels[3]!;
    assert.ok(alpha === 0 || alpha === 255, `tolerance ${tolerance} gave ${alpha}`);
  }
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

  const exact = filterImage(green, palette, options({ mode: 'keep', tolerance: 0 }));
  assert.ok(exact.report.problems.some((problem) => /exactly/.test(problem)), exact.report.problems.join('; '));

  // Snap matched everything by definition, so it has nothing to complain about.
  const snap = filterImage(green, palette, options({ mode: 'snap', tolerance: 0 }));
  assert.deepEqual(snap.report.problems, []);
});

/* ---------------- the flow ---------------- */

test('there are three modes, and removing is not one of them', () => {
  assert.deepEqual([...FILTER_MODES], ['keep', 'snap', 'fold']);
});

test('every mode is labelled and explained', () => {
  for (const mode of FILTER_MODES) {
    assert.ok(FILTER_MODE_LABEL[mode].length > 5, mode);
    assert.ok(FILTER_MODE_HINT[mode].length > 30, `${mode} needs a real explanation`);
  }
});

test('a fresh flow keeps rather than snaps, so a first run shows something', () => {
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
  assert.match(summariseFilter(keep.report, options({ mode: 'keep' })), /50\.0% kept exactly as it was, 50\.0% made transparent/);

  const snap = filterImage(source, palette, options({ mode: 'snap' }));
  // Only the green pixel changes: the red one is already the palette's red.
  assert.match(summariseFilter(snap.report, options({ mode: 'snap' })), /50\.0% of what shows was recolored/);

  const faded = filterImage(source, readPalette(['#dc282800']), options({ mode: 'snap' }));
  assert.match(summariseFilter(faded.report, options({ mode: 'snap' })), /snapped to transparent/);

  const empty = filterImage(image([[0, 0, 0, 0]]), palette, options());
  assert.match(summariseFilter(empty.report, options()), /already transparent/);
});

test('a green-only palette snaps a red image to green, not to nothing', () => {
  // The sanity check that the whole thing is wired the right way round.
  const source = image([[0xdc, 0x28, 0x28, 255]]);
  const { pixels } = filterImage(source, readPalette([GREEN]), options({ mode: 'snap' }));
  assert.deepEqual([pixels[0], pixels[1], pixels[2], pixels[3]], [0x28, 0xa0, 0x28, 255]);
});

/* ---------------- the smallest chunk ---------------- */

/** An image from a character map: R red, B blue, G green, D dark red, . clear. */
function grid(rows: string[]): Bitmap {
  const colors: Record<string, [number, number, number, number]> = {
    R: [220, 40, 40, 255],
    B: [40, 60, 220, 255],
    G: [40, 160, 40, 255],
    D: [120, 20, 20, 255],
    '.': [0, 0, 0, 0],
  };
  const height = rows.length;
  const width = rows[0]!.length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((c, x) => data.set(colors[c]!, (y * width + x) * 4)));
  return { width, height, data };
}

const hexAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => {
  const at = (y * width + x) * 4;
  return `#${[pixels[at]!, pixels[at + 1]!, pixels[at + 2]!].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
};

test('a single stray pixel takes the color around it', () => {
  const picture = grid(['RRRRR', 'RRRRR', 'RRBRR', 'RRRRR', 'RRRRR']);
  const off = filterImage(picture, palette, options({ mode: 'snap' }));
  assert.equal(hexAt(off.pixels, 5, 2, 2), BLUE, 'off by default: the dot stays');
  const on = filterImage(picture, palette, options({ mode: 'snap', minChunk: 2 }));
  assert.equal(hexAt(on.pixels, 5, 2, 2), RED);
  assert.equal(on.report.chunksMerged, 1);
  assert.equal(on.report.chunkPixels, 1);
  assert.equal(on.report.perEntry.find((entry) => entry.hex === BLUE)!.pixels, 0);
});

test('a chunk at or over the minimum is left alone', () => {
  const picture = grid(['RRRRR', 'RBBRR', 'RBBRR', 'RRRRR']);
  const result = filterImage(picture, palette, options({ mode: 'snap', minChunk: 4 }));
  assert.equal(result.report.chunksMerged, 0);
  assert.equal(hexAt(result.pixels, 5, 1, 1), BLUE);
  assert.equal(filterImage(picture, palette, options({ mode: 'snap', minChunk: 5 })).report.chunksMerged, 1);
});

test('corners count as touching, so a thin diagonal line is one chunk, not specks', () => {
  const picture = grid(['BRRRR', 'RBRRR', 'RRBRR', 'RRRBR', 'RRRRB']);
  const result = filterImage(picture, palette, options({ mode: 'snap', minChunk: 4 }));
  assert.equal(result.report.chunksMerged, 0, 'five pixels joined corner to corner');
});

test('a small chunk takes the neighbouring color closest to what it was, not the one around it most', () => {
  // A dark red speck on the border between a big blue area and a thin red one:
  // it touches blue more, but it was a red, so it goes red.
  const three = readPalette([RED, BLUE, '#781414']);
  const picture = grid(['BBBBBB', 'BBBBBB', 'BBDBBB', 'RRRRRR']);
  const result = filterImage(picture, three, options({ mode: 'snap', minChunk: 2 }));
  assert.equal(hexAt(result.pixels, 6, 2, 2), RED);
});

test('the transparent entry is a color like any other: a pinhole closes and a speck in nothing goes', () => {
  const withClear = readPalette([RED, BLUE, '#00000000']);
  const picture = grid(['.......', '.RRRR..', '.R.RR.B', '.RRRR..', '.......']);
  const result = filterImage(picture, withClear, options({ mode: 'snap', minChunk: 3 }));
  assert.equal(hexAt(result.pixels, 7, 2, 2), RED, 'the pinhole in the red is red');
  assert.equal(result.pixels[(2 * 7 + 6) * 4 + 3], 0, 'the blue speck in empty space is empty');
  assert.equal(result.report.chunksMerged, 2);
});

test('after merging every value is still a palette value', () => {
  const picture = noise(400);
  const withClear = readPalette([RED, BLUE, GREEN, '#00000000']);
  const result = filterImage({ ...picture, width: 20, height: 20 }, withClear, options({ mode: 'snap', minChunk: 6 }));
  const values = new Set<string>();
  for (let at = 0; at < result.pixels.length; at += 4) values.add(Array.from(result.pixels.slice(at, at + 4)).join(','));
  const allowed = new Set(withClear.colors.map((color) => [color.r, color.g, color.b, color.a].join(',')));
  assert.ok([...values].every((value) => allowed.has(value)), [...values].join(' '));
  assert.ok(result.report.chunksMerged > 0);
});

test('keep ignores the minimum chunk', () => {
  const picture = grid(['RRRRR', 'RRBRR', 'RRRRR']);
  const result = filterImage(picture, palette, options({ mode: 'keep', minChunk: 5 }));
  assert.equal(result.report.chunksMerged, 0);
  assert.equal(hexAt(result.pixels, 5, 2, 1), BLUE);
});

test('a picture all one color has nothing to merge into', () => {
  const result = filterImage(grid(['RR', 'RR']), palette, options({ mode: 'snap', minChunk: 10 }));
  assert.equal(result.report.chunksMerged, 0);
});

/* ---------------- folding small areas into big close ones ---------------- */

/** A picture drawn by a function of x and y, in hex colors. */
function drawn(width: number, height: number, colour: (x: number, y: number) => string): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const hex = colour(x, y).replace('#', '');
      const value = [0, 2, 4, 6].map((at) => (at < hex.length ? Number.parseInt(hex.slice(at, at + 2), 16) : 255));
      data.set(value, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const SKIN = '#e0a080';
const SHADE = '#d09070';
const EYE = '#202020';
const faces = readPalette([SKIN, SHADE, EYE]);
const colourAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) =>
  `#${[0, 1, 2].map((c) => pixels[(y * width + x) * 4 + c]!.toString(16).padStart(2, '0')).join('')}`;

test('fold: a fleck of a close shade folds into the big area round it, and a small area of a far color stays', () => {
  // A face of skin, a fleck of shade on the cheek, and an eye.
  const face = drawn(20, 20, (x, y) => (x >= 4 && x < 7 && y >= 12 && y < 15 ? SHADE : x >= 12 && x < 15 && y >= 5 && y < 8 ? EYE : SKIN));
  const run = filterImage(face, faces, options({ mode: 'fold', foldArea: 50, foldCloseness: 25, foldRatio: 4 }));
  assert.equal(colourAt(run.pixels, 20, 5, 13), SKIN, 'the fleck took the skin');
  assert.equal(colourAt(run.pixels, 20, 13, 6), EYE, 'the eye is far in color: it stays');
  assert.deepEqual([run.report.areasFolded, run.report.foldedPixels], [1, 9]);
  assert.ok(run.folded);
  assert.equal(run.folded.reduce((sum, one) => sum + one, 0), 9);
  assert.equal(run.folded[13 * 20 + 5], 1);
  assert.equal(run.folded[6 * 20 + 13], 0);
  // Snap alone keeps both.
  const snapped = filterImage(face, faces, options({ mode: 'snap' }));
  assert.equal(colourAt(snapped.pixels, 20, 5, 13), SHADE);
  assert.equal(snapped.folded, undefined);
});

test('fold: the neighbour must be the given times bigger, and the area smaller than the given size', () => {
  // Forty pixels of shade beside a hundred of skin: two and a half times as big.
  const strip = drawn(14, 10, (x) => (x < 4 ? SHADE : SKIN));
  const strict = filterImage(strip, faces, options({ mode: 'fold', foldArea: 100, foldRatio: 4 }));
  assert.equal(strict.report.areasFolded, 0);
  assert.match(summariseFilter(strict.report, options({ mode: 'fold' })), /no small area had a big enough, close enough neighbour/);
  const loose = filterImage(strip, faces, options({ mode: 'fold', foldArea: 100, foldRatio: 2 }));
  assert.equal(loose.report.areasFolded, 1);
  assert.equal(colourAt(loose.pixels, 14, 0, 0), SKIN);
  const big = filterImage(strip, faces, options({ mode: 'fold', foldArea: 40, foldRatio: 2 }));
  assert.equal(big.report.areasFolded, 0, 'forty pixels is not smaller than forty');
});

test('fold: of the close neighbours big enough, the closest color wins, then the longer border', () => {
  const WARM = '#d8a078';
  const COOL = '#e0b0a0';
  const palette3 = readPalette([SKIN, WARM, COOL]);
  // A small block of warm between two big areas: skin above, cool below — cool shares more border.
  const picture = drawn(10, 30, (x, y) => (y >= 9 && y < 12 && x >= 3 && x < 6 ? WARM : y < 10 ? SKIN : COOL));
  const run = filterImage(picture, palette3, options({ mode: 'fold', foldArea: 20, foldCloseness: 50, foldRatio: 2 }));
  assert.equal(run.report.areasFolded, 1);
  assert.equal(colourAt(run.pixels, 10, 4, 10), SKIN, 'skin is the closer color, so it wins though it shares less border');
  // As close as each other, the longer border wins: a strip down the left, skin to its right, cool below it.
  const assigned = new Int32Array(10 * 20);
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 10; x += 1) assigned[y * 10 + x] = x < 2 && y >= 2 && y < 8 ? 1 : x < 2 && y >= 8 ? 2 : 0;
  const even = (one: number, two: number) => (one === two ? 0 : 5);
  foldSmallAreas(assigned, 10, 20, even, { area: 20, closeness: 10, ratio: 2 });
  assert.equal(assigned[4 * 10], 0, 'skin shares the longer border');
  for (let y = 2; y < 8; y += 1) for (let x = 0; x < 2; x += 1) assigned[y * 10 + x] = 1;
  const nearerCool = (one: number, two: number) => (one === two ? 0 : (one === 1 && two === 2) || (one === 2 && two === 1) ? 2 : 5);
  foldSmallAreas(assigned, 10, 20, nearerCool, { area: 20, closeness: 10, ratio: 2 });
  assert.equal(assigned[4 * 10], 2, 'a closer color beats a longer border');
});

test('fold: an area left because its neighbour was too small folds once that neighbour has grown', () => {
  const assigned = new Int32Array([...Array(10).fill(1), ...Array(35).fill(0), ...Array(20).fill(2), ...Array(300).fill(0)]);
  // Entries 1 and 2 are close to 0, and to each other.
  const distance = (one: number, two: number) => (one === two ? 0 : 3);
  const result = foldSmallAreas(assigned, assigned.length, 1, distance, { area: 50, closeness: 25, ratio: 4 });
  // The twenty fold first (smallest that can: the 300 beside them), joining the 35 to the 300; then the ten can.
  assert.equal(result.areas, 2);
  assert.equal(result.pixels, 30);
  assert.ok(assigned.every((entry) => entry === 0));
});

test('fold: every pixel is still exactly a palette value, and clear specks stay clear', () => {
  const CLEAR = '#00000000';
  const palette4 = readPalette([SKIN, SHADE, CLEAR]);
  const picture = drawn(16, 16, (x, y) => ((x + y) % 7 === 0 ? SHADE : x === 8 && y === 8 ? CLEAR : SKIN));
  const run = filterImage(picture, palette4, options({ mode: 'fold', foldArea: 30, foldCloseness: 25, foldRatio: 3 }));
  const allowed = new Set(['224,160,128,255', '208,144,112,255', '0,0,0,0']);
  for (let p = 0; p < 256; p += 1) assert.ok(allowed.has(Array.from(run.pixels.slice(p * 4, p * 4 + 4)).join(',')));
  assert.equal(run.pixels[(8 * 16 + 8) * 4 + 3], 0, 'clear is far from any color: a pinhole stays');
  assert.match(summariseFilter(run.report, options({ mode: 'fold' })), /small area\(s\) \(\d+ px\) folded into a bigger, close-colored neighbour/);
});
