import { nameFromUrl, stripGutenbergBoilerplate } from '@vibetoon/shared';
import { recordApiCall } from '../logs';
import { HttpError } from '../storage';

const MAX_BYTES = 8 * 1024 * 1024;
const BLOCKED_HOSTS = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|::1$|\[::1\])/i;

export interface FetchedCorpus {
  name: string;
  text: string;
  bytes: number;
  truncated: boolean;
  url: string;
}

/**
 * Fetch a corpus by URL. This is the one part of building a word database that
 * needs the network, and it is deliberately a plain text download: anything
 * public domain with a URL works, and a Project Gutenberg file is trimmed of the
 * licence header and footer so several thousand words of legal English do not
 * end up counted as the author's vocabulary.
 */
export async function fetchCorpus(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedCorpus> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `That is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https addresses can be fetched.');
  }
  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    throw new HttpError(400, 'That address is on this machine, not the web.');
  }

  const started = Date.now();
  const log = (outcome: Parameters<typeof recordApiCall>[0]['outcome'], extra: { status?: number; bytes?: number; detail?: string }) =>
    recordApiCall({
      service: 'corpus',
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

  const raw = await response.text();
  const truncated = raw.length > MAX_BYTES;
  const text = stripGutenbergBoilerplate(truncated ? raw.slice(0, MAX_BYTES) : raw);

  if (text.trim().length === 0) {
    log('failed', { status: response.status, bytes: raw.length, detail: 'nothing that looks like text' });
    throw new HttpError(422, 'That address returned nothing that looks like text.');
  }

  log('ok', {
    status: response.status,
    bytes: raw.length,
    ...(truncated ? { detail: `truncated to ${MAX_BYTES} bytes` } : {}),
  });
  return { name: nameFromUrl(parsed.toString()), text, bytes: raw.length, truncated, url: parsed.toString() };
}
