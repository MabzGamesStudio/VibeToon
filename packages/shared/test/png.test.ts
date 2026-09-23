import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng, distinctColors, encodePng, isPng } from '../src/flows/png';

const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));
const deflate = (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes));

/**
 * PNGs written by another encoder (pypng), one of each kind a file can be, with
 * the pixels they hold worked out from the raw samples and — for the 8-bit ones —
 * checked against Pillow's own decode when the fixtures were made.
 */
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/png.json', import.meta.url), 'utf8')) as Array<{
  name: string;
  png: string;
  width: number;
  height: number;
  rgba: number[];
}>;

for (const fixture of fixtures) {
  test(`decodes a ${fixture.name} PNG to exactly the pixels it holds`, async () => {
    const bitmap = await decodePng(new Uint8Array(Buffer.from(fixture.png, 'base64')), inflate);
    assert.equal(bitmap.width, fixture.width);
    assert.equal(bitmap.height, fixture.height);
    assert.deepEqual(Array.from(bitmap.data), fixture.rgba);
  });
}

test('the fixtures cover every color type, sub-byte and 16-bit depths, and interlacing', () => {
  const names = fixtures.map((fixture) => fixture.name).join(' ');
  for (const kind of ['rgba8', 'rgb8-trns', 'gray1', 'gray4-trns', 'graya8', 'palette2', 'rgba16', 'gray16']) {
    assert.ok(names.includes(kind), kind);
  }
  assert.ok(names.includes('interlaced'));
});

test('what is encoded decodes to the same bytes, half-transparent pixels included', async () => {
  /*
   * The whole reason this exists. Through a canvas, `#283cdc80` comes back as
   * `#283cdb80`, because the canvas stores it multiplied by its opacity and the
   * rounding on the way back cannot find the lost fraction.
   */
  const width = 13;
  const height = 9;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 1) data[index] = (index * 97 + 13) % 256;
  data.set([0x28, 0x3c, 0xdc, 0x80], 0);
  data.set([0xff, 0xff, 0xff, 0x00], 4);

  const bytes = await encodePng({ width, height, data }, deflate);
  assert.ok(isPng(bytes));
  const back = await decodePng(bytes, inflate);
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  assert.deepEqual(Array.from(back.data), Array.from(data));
});

test('a flat picture encodes small, because each row picks its best filter', async () => {
  const width = 200;
  const height = 200;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set([220, 40, 40, 255], index * 4);
  const bytes = await encodePng({ width, height, data }, deflate);
  assert.ok(bytes.length < 2000, `${bytes.length} bytes for a 200 × 200 flat square`);
});

test('anything that is not a PNG is refused rather than misread', async () => {
  assert.equal(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false, 'a JPEG');
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3]), inflate), /not a PNG/);
});

test('distinct colors are counted as whole RGBA values', () => {
  const data = new Uint8ClampedArray([
    10, 20, 30, 255,
    10, 20, 30, 255,
    10, 20, 30, 128, // the same color at another opacity is another value
    0, 0, 0, 0,
  ]);
  assert.equal(distinctColors({ width: 4, height: 1, data }), 3);
});
