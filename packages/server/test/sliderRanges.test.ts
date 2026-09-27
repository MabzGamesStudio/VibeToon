import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-ranges-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
const { setDictionaryKey } = await import('../src/settings');

const server = createApp().listen(0);
const port = await new Promise<number>((resolve) => {
  server.on('listening', () => resolve((server.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

const put = (overrides: unknown) =>
  fetch(`${base}/api/settings/slider-ranges`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides }),
  });

test('no slider has been changed to begin with', async () => {
  const response = await fetch(`${base}/api/settings/slider-ranges`);
  assert.deepEqual(await response.json(), { overrides: {} });
});

test('a change is kept, and read back', async () => {
  const saved = await put({ 'map.land': { min: 0, max: 0.3 }, 'rig.stretchMax': { max: 6, step: 0.1 } });
  assert.equal(saved.status, 200);
  const read = (await (await fetch(`${base}/api/settings/slider-ranges`)).json()) as { overrides: Record<string, unknown> };
  assert.deepEqual(read.overrides, { 'map.land': { max: 0.3 }, 'rig.stretchMax': { max: 6, step: 0.1 } });
  const file = JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8')) as { sliderRanges: unknown };
  assert.deepEqual(file.sliderRanges, read.overrides);
});

test('a bad change is refused and the saved ones stay', async () => {
  for (const bad of [{ 'map.land': { min: 1, max: 0 } }, { 'no.such.slider': { max: 2 } }, { 'map.land': { max: 'far' } }]) {
    const response = await put(bad);
    assert.equal(response.status, 400);
  }
  const read = (await (await fetch(`${base}/api/settings/slider-ranges`)).json()) as { overrides: Record<string, unknown> };
  assert.ok(read.overrides['map.land']);
});

test('the ranges are all the browser is sent from the settings file', async () => {
  await setDictionaryKey('merriam-webster', 'secret-key-123');
  const text = await (await fetch(`${base}/api/settings/slider-ranges`)).text();
  assert.doesNotMatch(text, /secret-key-123/);
  assert.doesNotMatch(text, /dictionary/i);
});
