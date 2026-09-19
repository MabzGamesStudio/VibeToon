import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IMAGE_CONTENT_TYPES,
  describeSize,
  emptyImageFlowData,
  formatBytes,
  hostOf,
  imageTypeLabel,
  imageWarnings,
  summariseImage,
  type ImageSource,
} from '../src/flows/image';

const source = (over: Partial<ImageSource> = {}): ImageSource => ({
  origin: 'upload',
  fileName: 'hero.png',
  contentType: 'image/png',
  bytes: 204_800,
  addedAt: '2026-09-19T10:00:00.000Z',
  ...over,
});

test('a fresh flow has no picture and says nothing else', () => {
  const fresh = emptyImageFlowData();
  assert.equal(fresh.editor, 'image');
  assert.equal(fresh.source, null);
  assert.equal(summariseImage(fresh), 'No image yet.');
  assert.deepEqual(imageWarnings(null), []);
});

test('the accepted formats are the ones a browser decodes', () => {
  // The list exists because nothing on the server decodes an image, so anything
  // outside it would be stored and then fail to draw.
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.ok(IMAGE_CONTENT_TYPES.includes(type), type);
  }
  assert.ok(!IMAGE_CONTENT_TYPES.includes('image/tiff'), 'no browser reads TIFF');
  assert.ok(!IMAGE_CONTENT_TYPES.includes('application/pdf'));
});

test('every accepted format has a name worth showing', () => {
  for (const type of IMAGE_CONTENT_TYPES) {
    const label = imageTypeLabel(type);
    assert.ok(label.length > 0 && !label.includes('/'), `${type} -> ${label}`);
  }
  assert.equal(imageTypeLabel('image/jpeg'), 'JPEG');
  assert.equal(imageTypeLabel('image/svg+xml'), 'SVG');
  // Something unknown falls back to the type rather than to nothing.
  assert.equal(imageTypeLabel('image/heic'), 'image/heic');
});

test('a size is readable at a glance rather than a number to divide', () => {
  assert.equal(formatBytes(640), '640 B');
  assert.equal(formatBytes(831_488), '812 kB');
  assert.equal(formatBytes(1_468_006), '1.4 MB');
  assert.equal(formatBytes(0), '0 B');
});

test('a nonsense size reads as unknown rather than as NaN', () => {
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(-5), '—');
  assert.equal(formatBytes(Infinity), '—');
});

test('dimensions carry the pixel count, which is what decides whether things are slow', () => {
  assert.equal(describeSize(source({ width: 1920, height: 1080 })), '1920 × 1080 · 2.1M pixels');
  assert.equal(describeSize(source({ width: 240, height: 160 })), '240 × 160 · 38k pixels');
});

test('an unmeasured picture says so instead of claiming zero', () => {
  // Nothing on the server decodes an image, so the size is unknown until the
  // editor has had it in a browser.
  assert.equal(describeSize(source()), 'not measured yet');
  assert.equal(describeSize(source({ width: 100 })), 'not measured yet', 'one dimension is not a size');
});

test('an SVG is flagged, because it has no pixels of its own', () => {
  const warnings = imageWarnings(source({ contentType: 'image/svg+xml' }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /no fixed pixel grid/);
});

test('a GIF is flagged, because only its first frame is read', () => {
  assert.ok(imageWarnings(source({ contentType: 'image/gif' })).some((w) => /first frame/.test(w)));
});

test('a very large picture is flagged rather than left to be slow in silence', () => {
  const huge = imageWarnings(source({ width: 4000, height: 3000 }));
  assert.ok(huge.some((warning) => /large/.test(warning)), huge.join('; '));
  assert.deepEqual(imageWarnings(source({ width: 800, height: 600 })), [], 'and an ordinary one is not');
});

test('an ordinary PNG has nothing to warn about', () => {
  assert.deepEqual(imageWarnings(source({ width: 1200, height: 800 })), []);
});

test('the summary says what the file is and where it came from', () => {
  const uploaded = summariseImage({ ...emptyImageFlowData(), source: source({ width: 800, height: 600 }) });
  assert.match(uploaded, /PNG/);
  assert.match(uploaded, /200 kB/);
  assert.match(uploaded, /800 × 600/);
  assert.match(uploaded, /uploaded\.$/);

  const fetched = summariseImage({
    ...emptyImageFlowData(),
    source: source({ origin: 'link', url: 'https://example.com/a/b.jpg', contentType: 'image/jpeg' }),
  });
  assert.match(fetched, /JPEG/);
  assert.match(fetched, /from example\.com\.$/);
});

test('a host is just the host, so a caption fits', () => {
  assert.equal(hostOf('https://images.example.com/very/long/path/to/a/file.png?token=abc'), 'images.example.com');
  assert.equal(hostOf(undefined), 'a link');
  // Something unparseable is shown rather than swallowed, truncated to fit.
  assert.equal(hostOf('not a url'), 'not a url');
  assert.ok(hostOf('x'.repeat(200)).length <= 40);
});

test('description and credit are the flow’s own text and start empty', () => {
  const fresh = emptyImageFlowData();
  assert.equal(fresh.description, '');
  assert.equal(fresh.credit, '');
});
