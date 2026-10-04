import { sniffVideoType, videoNameFrom } from '@vibetoon/shared';
import { recordApiCall } from '../logs';
import { HttpError } from '../storage';
import { playableVideo } from './playableVideo';
import { guardedUrl } from './guardedUrl';

/** The largest video a link may bring in. */
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

export interface FetchedVideo {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  url: string;
}

/**
 * Download a video by address, checked the same way as a picture: the address
 * must be public http(s), and the bytes must be a video, whatever the header
 * says. A response that says how long it is and is too long is refused before
 * it is read; one that does not say is stopped once it passes the limit.
 */
export async function fetchVideo(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedVideo> {
  const parsed = guardedUrl(url);
  const started = Date.now();
  const log = (outcome: Parameters<typeof recordApiCall>[0]['outcome'], extra: { status?: number; bytes?: number; detail?: string }) =>
    recordApiCall({ service: 'video', url: parsed.toString(), subject: parsed.hostname, outcome, durationMs: Date.now() - started, ...extra });

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
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
    log('failed', { status: response.status, bytes: declared, detail: 'too large' });
    throw new HttpError(413, `That video is ${Math.round(declared / 1024 / 1024)}MB; the limit is ${MAX_VIDEO_BYTES / 1024 / 1024}MB.`);
  }

  // Read it in pieces, so a video with no stated length cannot run past the limit.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel();
        log('failed', { status: response.status, bytes: total, detail: 'too large' });
        throw new HttpError(413, `That video is over ${MAX_VIDEO_BYTES / 1024 / 1024}MB, the limit.`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) {
    log('failed', { status: response.status, detail: 'nothing came back' });
    throw new HttpError(422, 'That address returned an empty file.');
  }

  const contentType = sniffVideoType(bytes);
  if (!contentType) {
    const looksLikeHtml = new TextDecoder().decode(bytes.slice(0, 200)).trimStart().startsWith('<');
    log('failed', { status: response.status, bytes: bytes.byteLength, detail: 'not a video' });
    throw new HttpError(
      422,
      looksLikeHtml
        ? 'That address returned a web page, not a video. Use the address of the video file itself — a page that plays a video is not the video.'
        : 'That address returned something that is not a video this studio can read (MP4, WebM, QuickTime, Ogg, Matroska, AVI, Windows Media, Flash or MPEG).',
    );
  }
  log('ok', { status: response.status, bytes: bytes.byteLength });
  // Kept as a browser can play it: converted to MP4 if it has to be.
  const playable = await playableVideo(bytes, videoNameFrom(parsed, contentType));
  return {
    bytes: playable.bytes,
    contentType: playable.convertedFrom ? 'video/mp4' : contentType,
    fileName: playable.fileName,
    url: parsed.toString(),
  };
}
