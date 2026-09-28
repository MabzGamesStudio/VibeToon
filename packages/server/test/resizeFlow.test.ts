import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-resize-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng } from './pngFixture';
import {
  decodePng,
  emptyImageFlowData,
  emptyResizeFlowData,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type ResizeFlowData,
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
const RESIZE = 'flow_resize';
let project: Project;

async function setOptions(over: Partial<ResizeFlowData['options']>): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === RESIZE ? ({ ...node, data: { ...emptyResizeFlowData(), options: { ...emptyResizeFlowData().options, ...over } } } as FlowNode) : node)),
  });
}

async function generate(attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${RESIZE}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result;
}

async function written() {
  const bytes = new Uint8Array(await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${RESIZE}/resized.png`)).arrayBuffer());
  return decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
}

async function upload(fileName: string, bytes: Buffer): Promise<void> {
  const result = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${IMG}/outputs/image`, {
    fileName,
    data: bytes.toString('base64'),
  });
  project = result.project;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Resize', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: IMG, kind: 'art.image', name: 'Picture', position: { x: 0, y: 0 }, notes: '', data: emptyImageFlowData(), outputs: [] },
      { id: RESIZE, kind: 'art.resize', name: 'Resize', position: { x: 400, y: 0 }, notes: '', data: emptyResizeFlowData(), outputs: [] },
    ],
    connections: [
      { id: 'w1', from: { nodeId: IMG, portId: 'image' }, to: { nodeId: RESIZE, portId: 'image' }, rules: '', settings: { enabled: true, mode: 'reference', weight: 1, notes: '' } },
    ],
  });
  const red: [number, number, number] = [220, 30, 30];
  const blue: [number, number, number] = [30, 30, 220];
  await upload('picture.png', encodePng(Array.from({ length: 6 }, () => Array.from({ length: 8 }, (_, x) => (x < 4 ? red : blue)))));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a PNG is resized on the server by the factor', async () => {
  await setOptions({ mode: 'scale', scale: 3, method: 'nearest' });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const out = await written();
  assert.equal(out.width, 24);
  assert.equal(out.height, 18);
  assert.deepEqual(Array.from(out.data.slice(0, 4)), [220, 30, 30, 255]);
  assert.ok(run.log.some((line) => /8 × 6 → 24 × 18/.test(line)), run.log.join('; '));
});

test('to a size, with the shape kept', async () => {
  await setOptions({ mode: 'size', width: 4, keepAspect: true, method: 'bicubic' });
  await generate();
  const out = await written();
  assert.deepEqual([out.width, out.height], [4, 3]);
});

test('a picture the server cannot decode waits for the editor, then takes what it sends', async () => {
  await upload('picture.jpg', Buffer.from('not a png, standing in for a JPEG'));
  const waiting = (await generate()).runs[0]!;
  assert.ok(waiting.warnings.some((line) => /not a PNG/.test(line)), waiting.warnings.join('; '));
  const png = encodePng([[[1, 2, 3], [4, 5, 6]]]);
  const run = (await generate([{ name: 'resized.png', data: `data:image/png;base64,${png.toString('base64')}` }])).runs[0]!;
  assert.equal(run.ok, true);
  const out = await written();
  assert.deepEqual([out.width, out.height], [2, 1]);
});

test('with nothing wired in it says so', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /No image wired in/.test(line)));
});
