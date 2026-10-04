import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-select-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { emptyBatchSelectFlowData, emptyShotsFlowData, selectKey, type ArtifactRef, type FlowNode, type GenerateResponse, type Project } from '@vibetoon/shared';

const server = createApp().listen(0);
const port = await new Promise<number>((resolve) => server.on('listening', () => resolve((server.address() as AddressInfo).port)));
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
const node = (id: string, kind: string, data: unknown): FlowNode => ({ id, kind, name: id, position: { x: 0, y: 0 }, notes: '', data: data as FlowNode['data'], outputs: [] });
const webm = (text: string) => `data:video/webm;base64,${Buffer.from(text).toString('base64')}`;

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Select', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [node('shots', 'animation.video.shots', emptyShotsFlowData()), node('pick', 'production.batch.select', emptyBatchSelectFlowData())],
    connections: [{ id: 'c1', from: { nodeId: 'shots', portId: 'clips' }, to: { nodeId: 'pick', portId: 'items' }, rules: '', settings: { enabled: true, mode: 'reference', weight: 1, notes: '' } }],
  });
  const uploaded = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/shots/outputs/source`, { fileName: 'film.mp4', data: Buffer.from('a film').toString('base64') });
  const current = uploaded.project;
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((n) => (n.id === 'shots' ? { ...n, data: { ...emptyShotsFlowData(), video: { hash: uploaded.artifact.hash, duration: 6, width: 64, height: 36 }, cuts: [2, 4], clips: true } } : n)),
  });
  // Three clips recorded "in the editor".
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/shots/generate`, {
    attachments: ['one', 'two', 'three'].map((text, index) => ({ name: `shots/shot-0${index + 1}.webm`, data: webm(text) })),
  });
  project = result.project;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('the ticked clips go out on Selected as one folder, the rest on The rest, copied as they are', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  const excluded = [selectKey({ from: { nodeId: 'shots', portId: 'clips' } }, 'shot-02.webm')];
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, nodes: current.nodes.map((n) => (n.id === 'pick' ? { ...n, data: { ...emptyBatchSelectFlowData(), excluded } } : n)) });
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/pick/generate`);
  const run = result.runs[0]!;
  const selected = run.outputs.find((ref) => ref.port === 'selected')!;
  const rest = run.outputs.find((ref) => ref.port === 'rest')!;
  assert.equal(selected.kind, 'videoSet');
  assert.deepEqual(selected.entries, ['shot-01.webm', 'shot-03.webm']);
  assert.deepEqual(rest.entries, ['shot-02.webm']);
  const body = await (await fetch(`${base}/api/projects/${project.id}/files/${selected.path}/shot-03.webm`)).text();
  assert.equal(body, 'three');
  assert.ok(run.log.some((line) => /2 selected · 1 left out/.test(line)), run.log.join('; '));
});

test('with nothing ticked, nothing goes out on Selected, and it says so', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  const excluded = ['shot-01.webm', 'shot-02.webm', 'shot-03.webm'].map((key) => selectKey({ from: { nodeId: 'shots', portId: 'clips' } }, key));
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, nodes: current.nodes.map((n) => (n.id === 'pick' ? { ...n, data: { ...emptyBatchSelectFlowData(), excluded } } : n)) });
  const run = (await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/pick/generate`)).runs[0]!;
  assert.equal(run.outputs.some((ref) => ref.port === 'selected'), false);
  assert.ok(run.warnings.some((line) => /No item is ticked/.test(line)), run.warnings.join('; '));
});
