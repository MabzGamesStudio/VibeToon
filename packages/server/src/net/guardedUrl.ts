import { HttpError } from '../storage';

/**
 * Addresses the studio will not fetch on someone's behalf.
 *
 * A URL in a project file is an instruction to this server to make a request,
 * and the server can reach things the browser cannot: the loopback interface,
 * the private network around it, and a cloud instance's metadata endpoint on
 * 169.254.169.254. None of those are "the web", and a project that asks for one
 * is either a mistake or an attempt to read something it should not.
 */
const BLOCKED_HOSTS = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|::1$|\[::1\])/i;

/** Private range 172.16.0.0/12 — 172.16 through 172.31, but not 172.32+. */
const BLOCKED_172 = /^172\.(1[6-9]|2\d|3[01])\./;

/**
 * Parse a URL and refuse the ones that are not on the web. Shared by everything
 * that fetches on a project's behalf, so a new fetcher cannot be added that
 * quietly lacks the check.
 */
export function guardedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `That is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https addresses can be fetched.');
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(host) || BLOCKED_172.test(host)) {
    throw new HttpError(400, 'That address is on this machine or its private network, not the web.');
  }
  return parsed;
}
