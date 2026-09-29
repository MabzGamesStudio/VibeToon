import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-batch-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  batchItems,
  defaultDataForKind,
  emptyVideoEditFlowData,
  encodePng,
  flowStatus,
  isBatchNode,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type VideoEditFlowData,
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

let project: Project;
const node = (id: string) => project.nodes.find((candidate) => candidate.id === id)!;

async function generate(flowId: string, body?: { attachments?: Array<{ name: string; data: string }>; item?: string }): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flowId}/generate`, body);
  project = result.project;
  return result;
}

/** A 16 × 16 grey picture with a thin dark line across it: something to find lines in. */
async function picture(): Promise<string> {
  const size = 16;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) data.set(y === 8 ? [10, 10, 10, 255] : [200, 200, 200, 255], (y * size + x) * 4);
  return `data:image/png;base64,${Buffer.from(await encodePng({ width: size, height: size, data }, (raw) => new Uint8Array(deflateSync(raw)))).toString('base64')}`;
}

const webm = (text: string) => `data:video/webm;base64,${Buffer.from(text).toString('base64')}`;

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Batches', template: 'empty' });
  const flow = (id: string, kind: string, name: string): FlowNode =>
    ({ id, kind, name, position: { x: 0, y: 0 }, notes: '', data: defaultDataForKind(kind), outputs: [] }) as FlowNode;
  const wire = (id: string, from: [string, string], to: [string, string]) => ({
    id,
    from: { nodeId: from[0], portId: from[1] },
    to: { nodeId: to[0], portId: to[1] },
    rules: '',
    settings: { enabled: true, mode: 'suggest', weight: 1, notes: '' },
  });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { ...flow('edit', 'animation.video.edit', 'Edit'), data: emptyVideoEditFlowData() },
      flow('bg', 'art.video.background', 'Background'),
      flow('lines', 'art.lines', 'Lines'),
    ],
    connections: [wire('c1', ['edit', 'clips'], ['bg', 'video']), wire('c2', ['bg', 'image'], ['lines', 'image'])],
  });
  // Two clips out of the edit.
  const uploaded = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/edit/outputs/source`, {
    fileName: 'film.webm',
    data: Buffer.from('a film').toString('base64'),
  });
  project = uploaded.project;
  const data: VideoEditFlowData = { ...emptyVideoEditFlowData(), video: { hash: uploaded.artifact.hash, duration: 4, width: 64, height: 36 }, output: 'clips', segments: [{ start: 0, end: 2, deleted: false }, { start: 2, end: 4, deleted: false }] };
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, nodes: project.nodes.map((n) => (n.id === 'edit' ? { ...n, data } : n)) });
  await generate('edit', { attachments: [{ name: 'clips/clip-01.webm', data: webm('first') }, { name: 'clips/clip-02.webm', data: webm('second') }] });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a folder of clips wired into a flow that takes one video makes it a batch of them', () => {
  const clips = node('edit').outputs.find((ref) => ref.port === 'clips')!;
  assert.deepEqual(Object.keys(clips.entryHashes ?? {}), ['clip-01.webm', 'clip-02.webm'], 'each clip hashed on its own');
  assert.equal(isBatchNode(project, node('bg')), true);
  assert.deepEqual(batchItems(project, node('bg')).map((item) => item.key), ['clip-01.webm', 'clip-02.webm']);
  assert.equal(isBatchNode(project, node('lines')), true, 'and what comes out of it, down the graph');
});

test('a batch flow runs each item on its own', async () => {
  const { runs } = await generate('bg');
  assert.deepEqual(runs.map((run) => [run.flowName, run.item]), [
    ['Background · clip-01', 'clip-01.webm'],
    ['Background · clip-02', 'clip-02.webm'],
  ]);
  // A background is made in the editor: run here, each item says so.
  assert.ok(runs.every((run) => run.warnings.some((line) => /worked out in the editor/.test(line))));
  assert.match(node('bg').lastRun!.log.join(' '), /2 of 2 item\(s\) run/);
  assert.equal(flowStatus(project, node('bg')), 'empty');
});

test('files sent from the editor go to the one item they were made for, in a folder of its own', async () => {
  const { runs } = await generate('bg', { item: 'clip-02.webm', attachments: [{ name: 'background.png', data: await picture() }] });
  assert.equal(runs.length, 1);
  let image = node('bg').outputs.find((ref) => ref.port === 'image')!;
  assert.deepEqual(image.items!.map((item) => [item.key, item.artifact?.path ?? null]), [
    ['clip-01.webm', null],
    ['clip-02.webm', 'artifacts/bg/items/clip-02.webm/background.png'],
  ]);
  assert.equal(flowStatus(project, node('bg')), 'stale', 'one item of two');
  await generate('bg', { item: 'clip-01.webm', attachments: [{ name: 'background.png', data: await picture() }] });
  image = node('bg').outputs.find((ref) => ref.port === 'image')!;
  assert.equal(image.items!.filter((item) => item.artifact).length, 2, 'the flow’s own output stands for both');
  assert.equal(flowStatus(project, node('bg')), 'ready');
  await assert.rejects(generate('bg', { item: 'clip-09.webm' }), /404/);
});

test('downstream, each item reads its own upstream item', async () => {
  const { runs } = await generate('lines');
  const byItem = new Map(runs.map((run) => [run.item, run]));
  assert.equal(byItem.size, 2);
  const second = node('lines').batch!.items['clip-02.webm']!.outputs.find((ref) => ref.port === 'image')!;
  assert.equal(second.path, 'artifacts/lines/items/clip-02.webm/lines.png');
  const bytes = await fetch(`${base}/api/projects/${project.id}/files/${second.path}`).then((response) => response.arrayBuffer());
  assert.ok(bytes.byteLength > 0);
  assert.equal(flowStatus(project, node('lines')), 'ready');
});

test('generating what is stale runs only the items that need it', async () => {
  const { runs } = await api<GenerateResponse>('POST', `/api/projects/${project.id}/generate`);
  project = (await api<Project>('GET', `/api/projects/${project.id}`));
  assert.deepEqual(runs.map((run) => run.flowName), [], 'everything is up to date');
});

test('an item edited on its own is the only one that goes stale', async () => {
  const bg = node('bg');
  const own = { ...bg.data, agreement: 90 } as FlowNode['data'];
  const edited = { ...bg, batch: { items: { ...bg.batch!.items, 'clip-01.webm': { ...bg.batch!.items['clip-01.webm']!, data: own } } } };
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, nodes: project.nodes.map((n) => (n.id === 'bg' ? edited : n)) });
  assert.equal(flowStatus(project, node('bg')), 'stale');
  const { runs } = await api<GenerateResponse>('POST', `/api/projects/${project.id}/generate`);
  assert.deepEqual(runs.filter((run) => run.flowId === 'bg').map((run) => run.item), ['clip-01.webm']);
  assert.deepEqual(runs.filter((run) => run.flowId === 'lines').map((run) => run.item), [], 'its background kept, so nothing downstream changed');
  project = await api<Project>('GET', `/api/projects/${project.id}`);
  assert.equal((node('bg').batch!.items['clip-01.webm']!.data as { agreement: number }).agreement, 90, 'its own settings are kept');
});

test('clearing a batch flow’s files clears every item’s, and keeps their own settings', async () => {
  project = await api<Project>('DELETE', `/api/projects/${project.id}/flows/bg/artifacts`);
  const bg = node('bg');
  assert.deepEqual(bg.outputs, []);
  assert.deepEqual(Object.values(bg.batch!.items).map((state) => state.outputs.length), [0, 0]);
  assert.ok(bg.batch!.items['clip-01.webm']!.data);
});
