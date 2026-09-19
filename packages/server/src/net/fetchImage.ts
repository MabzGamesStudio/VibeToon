import { recordApiCall } from '../logs';
import { HttpError } from '../storage';
import { guardedUrl } from './guardedUrl';

const MAX_BYTES = 24 * 1024 * 1024;

/**
 * What the browser can decode, and what this project therefore accepts. Nothing
 * here is decoded on the server — the bytes are stored as they arrived and the
 * editor hands them to an `<img>`, which is the one decoder worth trusting.
 */
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

export interface FetchedImage {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  url: string;
}

/**
 * Sniff the format from the first bytes rather than trusting the header.
 *
 * A server that says `application/octet-stream` for a perfectly good PNG is
 * common, and a server that says `image/png` for an HTML error page is not rare
 * either. The magic number is the thing that is actually true.
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b)) {
    return 'image/webp';
  }
  // ....ftypavif
  if ([0x66, 0x74, 0x79, 0x70].every((byte, index) => bytes[4 + index] === byte)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return undefined;
}

/** A name for the file, from the address, keeping the extension its bytes earned. */
export function imageNameFrom(url: URL, contentType: string): string {
  const extension = IMAGE_TYPES[contentType] ?? 'bin';
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const stem = last
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return `${stem || 'image'}.${extension}`;
}

/**
 * Download an image by address. The one part of the image source flow that needs
 * the network, and the reason the flow stores the bytes afterwards: a link that
 * works today is not a link that works when the project is opened again.
 */
export async function fetchImage(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedImage> {
  const parsed = guardedUrl(url);
  const started = Date.now();
  const log = (
    outcome: Parameters<typeof recordApiCall>[0]['outcome'],
    extra: { status?: number; bytes?: number; detail?: string },
  ) =>
    recordApiCall({
      service: 'image',
      url: parsed.toString(),
      subject: parsed.hostname,
      outcome,
      durationMs: Date.now() - started,
      ...extra,
    });

  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), { redirect: 'follow' });
  } catch (error) {
    log('failed', { detail: (error as Error).message });
    throw new HttpError(502, `Could not reach ${parsed.hostname}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    log('failed', { status: response.status, detail: `answered ${response.status}` });
    throw new HttpError(502, `${parsed.hostname} answered ${response.status} for that address.`);
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength === 0) {
    log('failed', { status: response.status, detail: 'nothing came back' });
    throw new HttpError(422, 'That address returned an empty file.');
  }
  if (raw.byteLength > MAX_BYTES) {
    log('failed', { status: response.status, bytes: raw.byteLength, detail: 'too large' });
    throw new HttpError(
      413,
      `That image is ${Math.round(raw.byteLength / 1024 / 1024)}MB; the limit is ${MAX_BYTES / 1024 / 1024}MB.`,
    );
  }

  const sniffed = sniffImageType(raw);
  if (!sniffed) {
    // Most often an HTML page: a login wall, a hotlink block, or a 404 served
    // with a 200. Saying so beats storing it and failing to draw it later.
    const looksLikeHtml = new TextDecoder()
      .decode(raw.slice(0, 200))
      .trimStart()
      .toLowerCase()
      .startsWith('<');
    log('failed', { status: response.status, bytes: raw.byteLength, detail: 'not an image' });
    throw new HttpError(
      422,
      looksLikeHtml
        ? 'That address returned a web page, not an image. Use the address of the image itself.'
        : 'That address returned something that is not an image this studio can read.',
    );
  }

  log('ok', { status: response.status, bytes: raw.byteLength });
  return {
    bytes: raw,
    contentType: sniffed,
    fileName: imageNameFrom(parsed, sniffed),
    url: parsed.toString(),
  };
}
