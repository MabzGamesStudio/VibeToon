import { deflateSync } from 'node:zlib';

/**
 * A PNG encoder, for tests that need a real image on a port.
 *
 * No generator decodes an image — the editor does that — but a flow only runs
 * when a real image artifact with a real hash is on the port, so a test puts a
 * real one there rather than bytes that happen to be named `.png`. Written out by
 * hand because the alternative is a dependency for four test files.
 *
 * Not named `*.test.ts`, so the runner does not try to run it as a suite.
 */

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, tail]);
}

/**
 * An opaque truecolour PNG from a grid of `[r, g, b]` rows.
 *
 * `pixels[y][x]` is one pixel, and every row must be the same length.
 */
export function encodePng(pixels: Array<Array<[number, number, number]>>): Buffer {
  const height = pixels.length;
  const width = pixels[0]!.length;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  // Each scanline is prefixed with its filter type; 0 means "stored as is".
  const raw = Buffer.concat(
    pixels.map((row) => Buffer.from([0, ...row.flatMap(([r, g, b]) => [r, g, b])])),
  );

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The same, as a data URL ready to upload onto a port. */
export function pngDataUrl(pixels: Array<Array<[number, number, number]>>): string {
  return `data:image/png;base64,${encodePng(pixels).toString('base64')}`;
}

const RED: [number, number, number] = [0xcc, 0x33, 0x22];
const BLUE: [number, number, number] = [0x4a, 0x6f, 0xd4];

/** A 2×2: two reds over two blues. Enough to be a real file with a real hash. */
export function tinyPngBase64(): string {
  return encodePng([
    [RED, RED],
    [BLUE, BLUE],
  ]).toString('base64');
}
