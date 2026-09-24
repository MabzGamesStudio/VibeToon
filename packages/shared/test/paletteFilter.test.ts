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
    Array.from(filterImage(faint, palette, options({ tolerance: 60 })).pixels),
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

test('there are two modes, and removing is not one of them', () => {
  assert.deepEqual([...FILTER_MODES], ['keep', 'snap']);
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
