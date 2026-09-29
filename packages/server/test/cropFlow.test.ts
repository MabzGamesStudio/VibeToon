import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-crop-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng as encodeRgb } from './pngFixture';
import {
  decodePng,
  emptyCropFlowData,
  emptyImageFlowData,
  encodePng,
  type ArtifactRef,
  type CropFlowData,
  type FlowNode,
  type GenerateResponse,
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

const IMG = 'flow_img';
const CROP = 'flow_crop';
let project: Project;

async function setData(over: Partial<CropFlowData>): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === CROP ? ({ ...node, data: { ...emptyCropFlowData(), ...over } } as FlowNode) : node)),
  });
}

async function generate(attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${CROP}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result;
}

async function file(name: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${CROP}/${name}`)).arrayBuffer());
}

async function upload(fileName: string, bytes: Uint8Array): Promise<void> {
  const result = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${IMG}/outputs/image`, {
    fileName,
    data: Buffer.from(bytes).toString('base64'),
  });
  project = result.project;
}

/** A 12 × 8 clear sheet with a solid 3 × 2 sprite at (5, 4). */
async function sprite(): Promise<Uint8Array> {
  const width = 12;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y < 6; y += 1) for (let x = 5; x < 8; x += 1) data.set([200, 40, 40, 255], (y * width + x) * 4);
  return encodePng({ width, height, data }, (raw) => new Uint8Array(deflateSync(raw)));
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Crop', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: IMG, kind: 'art.image', name: 'Sprite', position: { x: 0, y: 0 }, notes: '', data: emptyImageFlowData(), outputs: [] },
      { id: CROP, kind: 'art.crop', name: 'Crop', position: { x: 400, y: 0 }, notes: '', data: emptyCropFlowData(), outputs: [] },
    ],
    connections: [
      { id: 'w1', from: { nodeId: IMG, portId: 'image' }, to: { nodeId: CROP, portId: 'image' }, rules: '', settings: { enabled: true, mode: 'reference', weight: 1, notes: '' } },
    ],
  });
  await upload('sprite.png', await sprite());
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a transparent picture is cropped to its solid pixels, and the box is written beside it', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const out = await decodePng(await file('cropped.png'), (packed) => new Uint8Array(inflateSync(packed)));
  assert.deepEqual([out.width, out.height], [3, 2]);
  assert.deepEqual(Array.from(out.data.slice(0, 4)), [200, 40, 40, 255]);
  const box = JSON.parse(Buffer.from(await file('crop.json')).toString('utf8'));
  assert.deepEqual(box.box, { x: 5, y: 4, width: 3, height: 2 });
  assert.ok(run.log.some((line) => /12 × 8 → 3 × 2/.test(line)), run.log.join('; '));
});

test('with a margin, the clear pixels round it are kept', async () => {
  await setData({ padding: 1 });
  await generate();
  const out = await decodePng(await file('cropped.png'), (packed) => new Uint8Array(inflateSync(packed)));
  assert.deepEqual([out.width, out.height], [5, 4]);
  assert.equal(out.data[3], 0);
});

test('a box drawn by hand is cut out as drawn', async () => {
  await setData({ mode: 'manual', rect: { x: 1, y: 1, width: 4, height: 3 } });
  await generate();
  const out = await decodePng(await file('cropped.png'), (packed) => new Uint8Array(inflateSync(packed)));
  assert.deepEqual([out.width, out.height], [4, 3]);
});

test('a picture the server cannot decode waits for the editor, then takes what it sends', async () => {
  await upload('sprite.jpg', new TextEncoder().encode('not a png, standing in for a JPEG'));
  const waiting = (await generate()).runs[0]!;
  assert.ok(waiting.warnings.some((line) => /not a PNG/.test(line)), waiting.warnings.join('; '));
  const png = encodeRgb([[[1, 2, 3]]]);
  const box = Buffer.from(JSON.stringify({ kind: 'crop', box: { x: 0, y: 0, width: 1, height: 1 } }));
  const run = (await generate([
    { name: 'cropped.png', data: `data:image/png;base64,${png.toString('base64')}` },
    { name: 'crop.json', data: `data:application/json;base64,${box.toString('base64')}` },
  ])).runs[0]!;
  assert.equal(run.ok, true);
  assert.equal(JSON.parse(Buffer.from(await file('crop.json')).toString('utf8')).box.width, 1);
});
