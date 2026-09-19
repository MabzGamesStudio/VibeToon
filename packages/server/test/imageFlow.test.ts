import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-image-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { pngDataUrl, tinyPngBase64 } from './pngFixture';
import {
  emptyImageFlowData,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type ImageFlowData,
  type Project,
} from '@vibetoon/shared';

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

async function raw(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const IMAGE_ID = 'flow_image';
let project: Project;

function imageNode(data: ImageFlowData): FlowNode {
  return {
    id: IMAGE_ID,
    kind: 'art.image',
    name: 'Reference',
    position: { x: 80, y: 80 },
    notes: '',
    data,
    outputs: [],
  };
}

async function setData(data: ImageFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) =>
      node.id === IMAGE_ID ? ({ ...node, data } as FlowNode) : node,
    ),
  });
}

async function upload(fileName: string, dataUrl: string): Promise<ArtifactRef> {
  const result = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${IMAGE_ID}/outputs/image`,
    { fileName, data: dataUrl },
  );
  project = result.project;
  return result.artifact;
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${IMAGE_ID}/generate`,
  );
  project = result.project;
  return result;
}

async function notes(): Promise<string> {
  return (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${IMAGE_ID}/source.md`)
  ).text();
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Image flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [imageNode(emptyImageFlowData())],
    connections: [],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- nothing yet ---------------- */

test('a flow with no picture warns rather than writing an empty note', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((warning) => /No image yet/.test(warning)), run.warnings.join('; '));
});

/* ---------------- uploading ---------------- */

test('an uploaded picture lands on the port as a real file with a hash', async () => {
  const artifact = await upload('hero.png', `data:image/png;base64,${tinyPngBase64()}`);
  assert.equal(artifact.kind, 'image');
  assert.equal(artifact.fileName, 'hero.png');
  assert.ok(artifact.hash.length > 0, 'a hash is what makes a downstream flow able to notice a change');

  const served = await fetch(`${base}/api/projects/${project.id}/files/${artifact.path}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.ok((await served.arrayBuffer()).byteLength > 50);
});

test('the note records what the file is and where it came from', async () => {
  await setData({
    ...emptyImageFlowData(),
    source: {
      origin: 'upload',
      fileName: 'hero.png',
      contentType: 'image/png',
      bytes: 77,
      addedAt: '2026-09-19T10:00:00.000Z',
      width: 2,
      height: 2,
    },
    description: 'A reference photo of the harbour at dusk.',
    credit: 'Photo: A. Nother, CC BY 4.0',
  });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  // A run reports everything the flow now holds, not only what it just wrote —
  // so the uploaded picture is listed alongside the note.
  const held = run.outputs.map((output) => output.fileName).sort();
  assert.deepEqual(held, ['hero.png', 'source.md']);

  const doc = await notes();
  assert.match(doc, /`hero\.png`/);
  assert.match(doc, /Format: PNG/);
  assert.match(doc, /2 × 2/);
  assert.match(doc, /harbour at dusk/);
  assert.match(doc, /CC BY 4\.0/);
  assert.match(doc, /Uploaded from this machine/);
});

test('generating does not disturb the picture already on the port', async () => {
  // The note is written to a different port, and outputs merge by port — so a run
  // that writes prose must not drop the image.
  const before = project.nodes.find((node) => node.id === IMAGE_ID)!.outputs.find((o) => o.port === 'image');
  await generate();
  const after = project.nodes.find((node) => node.id === IMAGE_ID)!.outputs.find((o) => o.port === 'image');
  assert.deepEqual(after, before);
});

test('an uncredited fetched picture is nudged about, not silently accepted', async () => {
  await setData({
    ...emptyImageFlowData(),
    source: {
      origin: 'link',
      fileName: 'plate.png',
      contentType: 'image/png',
      bytes: 77,
      url: 'https://example.com/plate.png',
      addedAt: '2026-09-19T10:00:00.000Z',
    },
  });
  await generate();
  const doc = await notes();
  assert.match(doc, /Fetched from: https:\/\/example\.com\/plate\.png/);
  assert.match(doc, /Not recorded/, 'a fetched picture belongs to someone');
});

test('an SVG is warned about, because it has no pixels of its own', async () => {
  await setData({
    ...emptyImageFlowData(),
    source: {
      origin: 'upload',
      fileName: 'mark.svg',
      contentType: 'image/svg+xml',
      bytes: 400,
      addedAt: '2026-09-19T10:00:00.000Z',
    },
  });
  const run = (await generate()).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => /no fixed pixel grid/.test(warning)),
    run.warnings.join('; '),
  );
  assert.ok(
    run.outputs.some((output) => output.fileName === 'source.md'),
    'and it still writes the note',
  );
});

/* ---------------- fetching ---------------- */

test('an address on this machine is refused before anything is requested', async () => {
  // A URL in a project file is an instruction to this server to make a request,
  // and this server can reach what the browser cannot.
  for (const url of ['http://127.0.0.1:9/x.png', 'http://localhost/x.png', 'http://169.254.169.254/latest/']) {
    const response = await raw(
      'POST',
      `/api/projects/${project.id}/flows/${IMAGE_ID}/outputs/image/fetch`,
      { url },
    );
    assert.equal(response.status, 400, url);
    assert.match(await response.text(), /this machine|private network/, url);
  }
});

test('a non-http scheme is refused', async () => {
  const response = await raw('POST', `/api/projects/${project.id}/flows/${IMAGE_ID}/outputs/image/fetch`, {
    url: 'file:///etc/passwd',
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /http and https/);
});

test('fetching onto a port that does not carry an image is refused', async () => {
  const response = await raw('POST', `/api/projects/${project.id}/flows/${IMAGE_ID}/outputs/source/fetch`, {
    url: 'https://example.com/x.png',
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /does not carry an image/);
});

test('fetching with no address says so rather than fetching nothing', async () => {
  const response = await raw('POST', `/api/projects/${project.id}/flows/${IMAGE_ID}/outputs/image/fetch`, {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /No address/);
});

/* ---------------- downstream ---------------- */

test('a picture on the port is what a downstream flow reads', async () => {
  // The whole point of the flow: the image becomes something the graph can wire.
  const artifact = await upload('plate.png', pngDataUrl([[[10, 20, 30]]]));
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  const held = current.nodes.find((node) => node.id === IMAGE_ID)!.outputs.find((o) => o.port === 'image')!;
  assert.equal(held.fileName, 'plate.png');
  assert.equal(held.hash, artifact.hash);
  assert.notEqual(held.hash, '', 'and the hash changed with the file');
});
