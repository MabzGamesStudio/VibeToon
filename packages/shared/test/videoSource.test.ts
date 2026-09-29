import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VIDEO_TYPES,
  emptyVideoSourceFlowData,
  formatMegabytes,
  sniffVideoType,
  summariseVideoSource,
  videoNameFrom,
  videoSourceReport,
  videoTypeLabel,
  type VideoSourceInfo,
} from '../src/flows/videoSource';

const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand)]);

const LINKED: VideoSourceInfo = {
  origin: 'link',
  fileName: 'clip.mp4',
  contentType: 'video/mp4',
  bytes: 3_500_000,
  url: 'https://example.org/clip.mp4',
  addedAt: '2026-09-29T00:00:00Z',
  duration: 12.5,
  width: 1280,
  height: 720,
};

test('an MP4 is known by its ftyp box, whatever its brand', () => {
  assert.equal(sniffVideoType(ftyp('isom')), 'video/mp4');
  assert.equal(sniffVideoType(ftyp('mp42')), 'video/mp4');
  assert.equal(sniffVideoType(ftyp('M4V ')), 'video/mp4');
});

test('a QuickTime movie is told apart from an MP4', () => {
  assert.equal(sniffVideoType(ftyp('qt  ')), 'video/quicktime');
  assert.equal(sniffVideoType(new Uint8Array([0, 0, 0, 0x08, 0x77, 0x69, 0x64, 0x65])), 'video/quicktime', 'an old movie opening on a wide atom');
});

test('WebM and Matroska share a header and are told apart by what it says', () => {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84];
  assert.equal(sniffVideoType(new Uint8Array([...ebml, ...new TextEncoder().encode('webm')])), 'video/webm');
  assert.equal(sniffVideoType(new Uint8Array([...ebml, ...new TextEncoder().encode('matroska')])), 'video/x-matroska');
  assert.equal(sniffVideoType(new TextEncoder().encode('OggS\u0000')), 'video/ogg');
});

test('a picture or a web page is not a video', () => {
  assert.equal(sniffVideoType(ftyp('avif')), undefined);
  assert.equal(sniffVideoType(ftyp('heic')), undefined);
  assert.equal(sniffVideoType(new TextEncoder().encode('<!doctype html><html>')), undefined);
  assert.equal(sniffVideoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), undefined);
});

test('the file is named from its address, with the extension its bytes earned', () => {
  assert.equal(videoNameFrom(new URL('https://example.org/films/My%20Clip.MOV?x=1'), 'video/mp4'), 'My-20Clip.mp4');
  assert.equal(videoNameFrom(new URL('https://example.org/'), 'video/webm'), 'video.webm');
  assert.equal(videoNameFrom('/watch', 'video/quicktime'), 'watch.mov');
  assert.equal(VIDEO_TYPES['video/ogg'], 'ogv');
});

test('the video is summed up in one line', () => {
  assert.equal(summariseVideoSource(LINKED), 'MP4 · 3.3 MB · 0:12.50 · 1280 × 720 · from example.org');
  assert.equal(summariseVideoSource({ ...LINKED, origin: 'upload', url: undefined, duration: undefined, width: undefined }), 'MP4 · 3.3 MB · uploaded');
  assert.equal(summariseVideoSource(null), 'No video yet.');
  assert.equal(videoTypeLabel('video/webm'), 'WebM');
  assert.equal(videoTypeLabel('video/x-other'), 'video/x-other');
});

test('sizes are given in kilobytes or megabytes', () => {
  assert.equal(formatMegabytes(2048), '2 KB');
  assert.equal(formatMegabytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatMegabytes(Number.NaN), '—');
});

test('the notes say where it came from, and ask for credit for a fetched one', () => {
  const data = { ...emptyVideoSourceFlowData(), source: LINKED };
  const report = videoSourceReport('Clip', data);
  assert.match(report, /Fetched from: https:\/\/example\.org\/clip\.mp4/);
  assert.match(report, /Length: 0:12\.50/);
  assert.match(report, /Not recorded\. A video fetched from a link belongs to someone/);
  const credited = videoSourceReport('Clip', { ...data, credit: 'CC BY 4.0, Example Films' });
  assert.match(credited, /CC BY 4\.0, Example Films/);
  assert.match(videoSourceReport('Clip', emptyVideoSourceFlowData()), /No video yet/);
});
