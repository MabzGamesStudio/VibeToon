import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-videosource-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
const { fetchVideo, MAX_VIDEO_BYTES } = await import('../src/net/fetchVideo');
import { emptyVideoSourceFlowData, type ArtifactRef, type FlowNode, type GenerateResponse, type Project, type VideoSourceFlowData } from '@vibetoon/shared';

const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode('<!DOCTYPE html><html><body>Watch the video</body></html>');

function serving(bytes: Uint8Array, init: { status?: number; length?: number } = {}): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/octet-stream', ...(init.length !== undefined ? { 'content-length': String(init.length) } : {}) },
    })) as unknown as typeof fetch;
}

/* ---------------- fetching a link ---------------- */

test('a video at a link is fetched and known by its bytes', async () => {
  const fetched = await fetchVideo('https://example.org/media/walk%20cycle.mp4', serving(MP4));
  assert.equal(fetched.contentType, 'video/mp4');
  assert.equal(fetched.fileName, 'walk-20cycle.mp4');
  assert.equal(fetched.bytes.byteLength, MP4.byteLength);
});

test('a page that plays a video is not the video', async () => {
  await assert.rejects(fetchVideo('https://example.org/watch?v=1', serving(HTML)), /web page, not a video/);
});

test('an address on this machine or the private network is refused before anything is asked', async () => {
  let asked = false;
  const spy = (async () => {
    asked = true;
    return new Response(MP4);
  }) as unknown as typeof fetch;
  await assert.rejects(fetchVideo('http://127.0.0.1/clip.mp4', spy), /this machine/);
  await assert.rejects(fetchVideo('http://192.168.1.5/clip.mp4', spy), /private network/);
  assert.equal(asked, false);
});

test('a video over the limit is refused, whether or not it says how big it is', async () => {
  await assert.rejects(fetchVideo('https://example.org/big.mp4', serving(MP4, { length: MAX_VIDEO_BYTES + 1 })), /limit is/);
  await assert.rejects(fetchVideo('https://example.org/gone.mp4', serving(MP4, { status: 404 })), /answered 404/);
});

/* ---------------- the flow ---------------- */

const server = createApp().listen(0);
const port = await new Promise<number>((resolve) => {
  server.on('listening', () => resolve((server.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const SOURCE = 'flow_video';
let project: Project;

async function setData(over: Partial<VideoSourceFlowData>): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === SOURCE ? ({ ...node, data: { ...emptyVideoSourceFlowData(), ...over } } as FlowNode) : node)),
  });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${SOURCE}/generate`);
  project = result.project;
  return result;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Video source', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [{ id: SOURCE, kind: 'animation.video.source', name: 'Clip', position: { x: 0, y: 0 }, notes: '', data: emptyVideoSourceFlowData(), outputs: [] }],
    connections: [],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('with no video it says how to add one', async () => {
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /upload a file or fetch a link/.test(line)), run.warnings.join('; '));
});

test('an uploaded video is kept on the port, and a run writes where it came from', async () => {
  const uploaded = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${SOURCE}/outputs/video`, {
    fileName: 'walk.mp4',
    data: Buffer.from(MP4).toString('base64'),
  });
  project = uploaded.project;
  assert.equal(uploaded.artifact.kind, 'video');
  await setData({
    source: { origin: 'upload', fileName: 'walk.mp4', contentType: 'video/mp4', bytes: MP4.byteLength, addedAt: '2026-09-29T00:00:00Z', duration: 4, width: 320, height: 180 },
    credit: 'Shot for this project.',
  });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.error);
  assert.ok(run.log.some((line) => /MP4 · 1 KB · 0:04\.00 · 320 × 180 · uploaded/.test(line)), run.log.join('; '));
  const notes = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${SOURCE}/source.md`)).text();
  assert.match(notes, /Shot for this project\./);
  assert.deepEqual(project.nodes.find((node) => node.id === SOURCE)!.outputs.map((ref) => ref.port).sort(), ['source', 'video']);
});

test('the fetch route refuses a link on this machine for a video port', async () => {
  const response = await fetch(`${base}/api/projects/${project.id}/flows/${SOURCE}/outputs/video/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://localhost/clip.mp4' }),
  });
  assert.equal(response.ok, false);
  assert.match(await response.text(), /this machine/);
});

/* ---------------- a big file ---------------- */

test('a video sent as its own bytes is kept, bigger than a JSON upload can carry', async () => {
  // Past the JSON body limit, and far past what a browser can make into one base64 string.
  const big = new Uint8Array(100 * 1024 * 1024 + 7);
  big.set(MP4);
  for (let i = MP4.byteLength; i < big.byteLength; i += 4099) big[i] = i % 251;
  const response = await fetch(`${base}/api/projects/${project.id}/flows/${SOURCE}/outputs/video?name=${encodeURIComponent('long walk.mp4')}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: big,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const uploaded = (await response.json()) as { project: Project; artifact: ArtifactRef };
  project = uploaded.project;
  assert.equal(uploaded.artifact.fileName, 'long walk.mp4');
  assert.equal(uploaded.artifact.bytes, big.byteLength);
  const back = new Uint8Array(await (await fetch(`${base}/api/projects/${project.id}/files/${uploaded.artifact.path}`)).arrayBuffer());
  assert.equal(back.byteLength, big.byteLength);
  assert.deepEqual(back.subarray(0, 64), big.subarray(0, 64));
  assert.equal(back[big.byteLength - 4], big[big.byteLength - 4]);
});

test('a raw upload with no bytes, or a path for a name, is refused', async () => {
  const empty = await fetch(`${base}/api/projects/${project.id}/flows/${SOURCE}/outputs/video?name=x.mp4`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(0) });
  assert.equal(empty.status, 400);
  const sneaky = await fetch(`${base}/api/projects/${project.id}/flows/${SOURCE}/outputs/video?name=${encodeURIComponent('../../settings.json')}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: MP4,
  });
  assert.equal(sneaky.status, 200, 'the name is cut to its last part');
  assert.equal(((await sneaky.json()) as { artifact: ArtifactRef }).artifact.fileName, 'settings.json');
});
