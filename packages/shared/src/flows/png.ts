import type { Bitmap } from './cutout';

/**
 * PNG, read and written byte for byte.
 *
 * A browser will decode a PNG for you, but only through a canvas, and a canvas
 * stores every pixel multiplied by its own opacity. Reading back divides again,
 * and the rounding in between moves the color of anything half see-through: a
 * pixel written as `#283cdc80` reads back as `#283cdb80`. The same happens on the
 * way out, so a picture filtered to exactly six palette colors came back from
 * `toDataURL` with more than six in it. For flows whose whole promise is
 * exactness — keep this color and nothing else, snap to these colors and no
 * others — that is not a rounding error, it is the answer being wrong.
 *
 * So PNG, which is what every flow here writes, is decoded and encoded here,
 * without a canvas. Other formats still go through the browser: a JPEG has no
 * opacity to lose, and a GIF's is all or nothing.
 *
 * Compression is passed in rather than imported, because the browser and Node
 * each have their own: `DecompressionStream` in one, `zlib` in the other. Both
 * speak the zlib format PNG uses.
 */

export type Inflate = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;
export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((value, index) => bytes[index] === value);
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let index = start; index < end; index += 1) c = crcTable[(c ^ bytes[index]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

/** A PNG's size from its header, without decoding it — for refusing one that is too big. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const name = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (name !== 'IHDR') return null;
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

/** Channels a pixel has, for each PNG color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The seven passes of Adam7 interlacing: where each starts and how far it steps.
 * A progressive PNG sends a coarse picture first and fills it in, and has to be
 * put back together pass by pass.
 */
const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
];

/**
 * Decode a PNG to straight (not premultiplied) 8-bit RGBA.
 *
 * Every color type, every bit depth, palettes and their transparency, and
 * interlacing. Sixteen-bit channels keep their high byte, which is what an 8-bit
 * pipeline would have seen anyway. Color-management chunks — gamma, ICC profiles
 * — are ignored on purpose: the numbers in the file are the colors, and a flow
 * asked to match `#dc2828` should find the pixels the file says are `#dc2828`.
 */
export async function decodePng(bytes: Uint8Array, inflate: Inflate): Promise<Bitmap> {
  if (!isPng(bytes)) throw new Error('not a PNG file');

  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlaced = false;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const compressed: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = readUint32(bytes, at);
    const name = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new Error(`the ${name} chunk is cut short`);
    if (name === 'IHDR') {
      width = readUint32(body, 0);
      height = readUint32(body, 4);
      depth = body[8]!;
      type = body[9]!;
      interlaced = body[12] === 1;
    } else if (name === 'PLTE') {
      palette = body;
    } else if (name === 'tRNS') {
      transparency = body;
    } else if (name === 'IDAT') {
      compressed.push(body);
    } else if (name === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  if (!(type in CHANNELS)) throw new Error(`unknown PNG color type ${type}`);
  if (width <= 0 || height <= 0) throw new Error('the PNG has no size');
  if (type === 3 && !palette) throw new Error('a palette PNG with no palette');

  const joined = new Uint8Array(compressed.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of compressed) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = await inflate(joined);

  const channels = CHANNELS[type]!;
  const bitsPerPixel = channels * depth;
  const stride = (width: number) => Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);
  const out = new Uint8ClampedArray(width * height * 4);

  // The one gray, or the one RGB, that a tRNS chunk makes transparent in a
  // type 0 or type 2 image. Compared at the file's own depth.
  const clearGray = type === 0 && transparency ? (transparency[0]! << 8) | transparency[1]! : -1;
  const clearRgb =
    type === 2 && transparency
      ? [
          (transparency[0]! << 8) | transparency[1]!,
          (transparency[2]! << 8) | transparency[3]!,
          (transparency[4]! << 8) | transparency[5]!,
        ]
      : null;

  const sample = (row: Uint8Array, index: number): number => {
    // Sample `index` of a row, at whatever depth the file uses.
    if (depth === 8) return row[index]!;
    if (depth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
    const perByte = 8 / depth;
    const byte = row[Math.floor(index / perByte)]!;
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const toByte = (value: number): number =>
    depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / ((1 << depth) - 1));

  const put = (row: Uint8Array, column: number, x: number, y: number) => {
    const target = (y * width + x) * 4;
    const first = column * channels;
    if (type === 3) {
      const entry = sample(row, first);
      out[target] = palette![entry * 3] ?? 0;
      out[target + 1] = palette![entry * 3 + 1] ?? 0;
      out[target + 2] = palette![entry * 3 + 2] ?? 0;
      out[target + 3] = transparency && entry < transparency.length ? transparency[entry]! : 255;
      return;
    }
    if (type === 0 || type === 4) {
      const gray = sample(row, first);
      const value = toByte(gray);
      out[target] = value;
      out[target + 1] = value;
      out[target + 2] = value;
      out[target + 3] = type === 4 ? toByte(sample(row, first + 1)) : gray === clearGray ? 0 : 255;
      return;
    }
    const r = sample(row, first);
    const g = sample(row, first + 1);
    const b = sample(row, first + 2);
    out[target] = toByte(r);
    out[target + 1] = toByte(g);
    out[target + 2] = toByte(b);
    out[target + 3] =
      type === 6
        ? toByte(sample(row, first + 3))
        : clearRgb && r === clearRgb[0] && g === clearRgb[1] && b === clearRgb[2]
          ? 0
          : 255;
  };

  let cursor = 0;
  const unfilterPass = (passWidth: number, passHeight: number, place: (x: number, y: number) => [number, number]) => {
    if (passWidth === 0 || passHeight === 0) return;
    const length = stride(passWidth);
    let previous = new Uint8Array(length);
    for (let y = 0; y < passHeight; y += 1) {
      const filter = raw[cursor]!;
      const row = raw.slice(cursor + 1, cursor + 1 + length);
      if (row.length !== length) throw new Error('the PNG image data is cut short');
      cursor += 1 + length;
      for (let index = 0; index < length; index += 1) {
        const left = index >= step ? row[index - step]! : 0;
        const up = previous[index]!;
        const corner = index >= step ? previous[index - step]! : 0;
        let value = row[index]!;
        if (filter === 1) value += left;
        else if (filter === 2) value += up;
        else if (filter === 3) value += (left + up) >> 1;
        else if (filter === 4) {
          const guess = left + up - corner;
          const toLeft = Math.abs(guess - left);
          const toUp = Math.abs(guess - up);
          const toCorner = Math.abs(guess - corner);
          value += toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
        } else if (filter !== 0) throw new Error(`unknown PNG row filter ${filter}`);
        row[index] = value & 255;
      }
      for (let column = 0; column < passWidth; column += 1) {
        const [x, y2] = place(column, y);
        put(row, column, x, y2);
      }
      previous = row;
    }
  };

  if (interlaced) {
    for (const pass of ADAM7) {
      const passWidth = Math.ceil((width - pass.x) / pass.dx);
      const passHeight = Math.ceil((height - pass.y) / pass.dy);
      unfilterPass(Math.max(0, passWidth), Math.max(0, passHeight), (x, y) => [
        pass.x + x * pass.dx,
        pass.y + y * pass.dy,
      ]);
    }
  } else {
    unfilterPass(width, height, (x, y) => [x, y]);
  }

  return { width, height, data: out };
}

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = name.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
  return out;
}

/**
 * Encode straight 8-bit RGBA as a PNG, exactly.
 *
 * Every row is filtered whichever of the five ways makes it smallest by the
 * usual measure — the sum of the bytes read as signed — which is what keeps a
 * flat-colored picture a few kilobytes rather than a few hundred.
 */
export async function encodePng(bitmap: Bitmap, deflate: Deflate): Promise<Uint8Array> {
  const { width, height, data } = bitmap;
  const length = width * 4;
  const raw = new Uint8Array((length + 1) * height);
  const candidate = new Uint8Array(length);
  const best = new Uint8Array(length);

  for (let y = 0; y < height; y += 1) {
    const row = y * length;
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter += 1) {
      let score = 0;
      for (let index = 0; index < length; index += 1) {
        const value = data[row + index]!;
        const left = index >= 4 ? data[row + index - 4]! : 0;
        const up = y > 0 ? data[row - length + index]! : 0;
        const corner = y > 0 && index >= 4 ? data[row - length + index - 4]! : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const guess = left + up - corner;
          const toLeft = Math.abs(guess - left);
          const toUp = Math.abs(guess - up);
          const toCorner = Math.abs(guess - corner);
          predicted = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
        }
        const byte = (value - predicted) & 255;
        candidate[index] = byte;
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best.set(candidate);
      }
    }
    raw[y * (length + 1)] = bestFilter;
    raw.set(best, y * (length + 1) + 1);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits a channel
  header[9] = 6; // RGBA
  const compressed = await deflate(raw);

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** How many different RGBA values a picture holds — the measure of an exact filter. */
export function distinctColors(bitmap: Bitmap): number {
  const seen = new Set<number>();
  const { data } = bitmap;
  for (let at = 0; at < data.length; at += 4) {
    seen.add(data[at]! * 16777216 + ((data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!));
  }
  return seen.size;
}
