import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.VIBETOON_LOG_FILE = 'off';

const { guardedUrl } = await import('../src/net/guardedUrl');
const { fetchImage, imageNameFrom, sniffImageType } = await import('../src/net/fetchImage');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const AVIF = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
const HTML = new TextEncoder().encode('<!DOCTYPE html><html><body>Sign in to continue</body></html>');

function serving(bytes: Uint8Array, init: { status?: number; type?: string } = {}): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status: init.status ?? 200,
      headers: { 'content-type': init.type ?? 'application/octet-stream' },
    })) as unknown as typeof fetch;
}

/* ---------------- the guard ---------------- */

test('an address on this machine is refused, whichever way it is written', () => {
  // A URL in a project file is an instruction to the server to make a request,
  // and the server can reach things the browser cannot.
  for (const url of [
    'http://localhost/x.png',
    'http://127.0.0.1/x.png',
    'http://127.1.2.3/x.png',
    'http://[::1]/x.png',
    'http://0.0.0.0/x.png',
  ]) {
    assert.throws(() => guardedUrl(url), /this machine|private network/, url);
  }
});

test('the private ranges are refused, including 172.16/12', () => {
  for (const url of [
    'http://10.0.0.5/x.png',
    'http://192.168.1.1/x.png',
    'http://172.16.0.1/x.png',
    'http://172.20.10.4/x.png',
    'http://172.31.255.255/x.png',
  ]) {
    assert.throws(() => guardedUrl(url), /private network|this machine/, url);
  }
});

test('172.32 and 172.15 are public, and are not refused with the private block', () => {
  // The range is 172.16–172.31. Blocking all of 172.* would refuse real hosts.
  assert.equal(guardedUrl('http://172.32.0.1/x.png').hostname, '172.32.0.1');
  assert.equal(guardedUrl('http://172.15.0.1/x.png').hostname, '172.15.0.1');
});

test('a cloud metadata address is refused', () => {
  // 169.254.169.254 is where an instance's credentials live.
  assert.throws(() => guardedUrl('http://169.254.169.254/latest/meta-data/'), /private network|this machine/);
});

test('only http and https can be fetched', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x.png', 'data:image/png;base64,AAAA']) {
    assert.throws(() => guardedUrl(url), /http and https/, url);
  }
  assert.throws(() => guardedUrl('not a url at all'), /not a URL/);
});

test('an ordinary web address passes', () => {
  assert.equal(guardedUrl('https://example.com/a/b.png').hostname, 'example.com');
});

/* ---------------- sniffing ---------------- */

test('the format is read from the bytes, not the header', async () => {
  // A server saying octet-stream for a good PNG is common; a server saying
  // image/png for an HTML error page is not rare either.
  const fetched = await fetchImage('https://example.com/x', serving(PNG, { type: 'application/octet-stream' }));
  assert.equal(fetched.contentType, 'image/png');
});

test('every format the browser decodes is recognised', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.equal(sniffImageType(AVIF), 'image/avif');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
});

test('a web page dressed as an image is refused, and says why', async () => {
  // The common failure: a login wall or a 404 served with a 200.
  await assert.rejects(
    () => fetchImage('https://example.com/x.png', serving(HTML, { type: 'image/png' })),
    /returned a web page, not an image/,
  );
});

test('something unrecognisable is refused rather than stored to fail later', async () => {
  const noise = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  await assert.rejects(() => fetchImage('https://example.com/x', serving(noise)), /not an image/);
});

test('an empty response is refused', async () => {
  await assert.rejects(() => fetchImage('https://example.com/x', serving(new Uint8Array())), /empty file/);
});

test('a failing status is reported with the status in it', async () => {
  await assert.rejects(
    () => fetchImage('https://example.com/x', serving(PNG, { status: 403 })),
    /answered 403/,
  );
});

test('an unreachable host is reported as unreachable, not as a bad image', async () => {
  const dead = (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  await assert.rejects(() => fetchImage('https://nowhere.invalid/x.png', dead), /Could not reach nowhere.invalid/);
});

/* ---------------- naming ---------------- */

test('the file is named from the address, with the extension its bytes earned', () => {
  assert.equal(imageNameFrom(new URL('https://e.com/art/hero.JPG'), 'image/png'), 'hero.png');
  assert.equal(imageNameFrom(new URL('https://e.com/a/b/plate-2.png'), 'image/png'), 'plate-2.png');
  assert.equal(imageNameFrom(new URL('https://e.com/'), 'image/jpeg'), 'image.jpg');
  assert.equal(imageNameFrom(new URL('https://e.com/x.png?v=2'), 'image/webp'), 'x.webp');
});

test('a name cannot escape the flow’s own folder', () => {
  // The name goes on disk, so a path in it would be a path traversal.
  for (const path of ['https://e.com/../../etc/passwd', 'https://e.com/a/..%2f..%2fpasswd']) {
    const name = imageNameFrom(new URL(path), 'image/png');
    assert.ok(!name.includes('/'), name);
    assert.ok(!name.includes('\\'), name);
    assert.ok(!name.startsWith('.'), name);
  }
});

test('a fetched image carries its bytes, its type and the address it came from', async () => {
  const fetched = await fetchImage('https://example.com/art/hero.png', serving(PNG, { type: 'image/png' }));
  assert.deepEqual(fetched.bytes, PNG);
  assert.equal(fetched.contentType, 'image/png');
  assert.equal(fetched.fileName, 'hero.png');
  assert.equal(fetched.url, 'https://example.com/art/hero.png');
});
