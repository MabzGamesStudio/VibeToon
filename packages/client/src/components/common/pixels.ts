import { decodePng, encodePng, isPng, pngSize, type Bitmap } from '@vibetoon/shared';

/**
 * Pixels in and out of the browser, exactly.
 *
 * A canvas is the obvious way to read an image in a browser and the wrong one for
 * anything that promises exact colors: it keeps every pixel multiplied by its own
 * opacity, so a half-transparent pixel comes back a step off the one in the file,
 * and it writes them the same way. PNG — which is what every flow here writes —
 * is decoded and encoded by `png.ts` instead. Anything else still goes through
 * the browser: a JPEG has no opacity to lose, and a GIF's is all or nothing.
 */

/** Bytes as a Blob part. The DOM typings want a view over a plain ArrayBuffer. */
const part = (bytes: Uint8Array): BlobPart => bytes as Uint8Array<ArrayBuffer>;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([part(bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([part(bytes)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function tooBig(width: number, height: number, maxPixels: number | undefined): string | null {
  if (!maxPixels || width * height <= maxPixels) return null;
  return `${((width * height) / 1_000_000).toFixed(1)}M pixels is more than this can work with. Scale the picture down first.`;
}

/**
 * Read an image file into straight RGBA.
 *
 * `maxPixels` refuses a picture that is too big before it is decoded, rather
 * than after the browser has spent the memory on it.
 */
export async function readBitmap(url: string, options: { maxPixels?: number } = {}): Promise<Bitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the file could not be read (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (isPng(bytes)) {
    const size = pngSize(bytes);
    const refusal = size ? tooBig(size.width, size.height, options.maxPixels) : null;
    if (refusal) throw new Error(refusal);
    return decodePng(bytes, inflate);
  }

  const image = await createImageBitmap(new Blob([part(bytes)]));
  try {
    const refusal = tooBig(image.width, image.height, options.maxPixels);
    if (refusal) throw new Error(refusal);
    if (image.width === 0 || image.height === 0) throw new Error('the image has no size');
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('this browser gave no 2D canvas');
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
  } finally {
    image.close();
  }
}

/** A PNG of these exact pixels, as a data URL ready to upload. */
export async function pngDataUrl(bitmap: Bitmap): Promise<string> {
  const bytes = await encodePng(bitmap, deflate);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('the PNG could not be read back'));
    reader.readAsDataURL(new Blob([part(bytes)], { type: 'image/png' }));
  });
}
