import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-custom-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { tinyPngBase64 } from './pngFixture';
import {
  adopt,
  createCustomFlow,
  emptyImageFlowData,
  emptyVectorEditFlowData,
  emptyVectorizeFlowData,
  flowStatus,
  instantiateCustomFlow,
  membersOf,
  proposePorts,
  readVectorImage,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type VectorImage,
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
const VEC = 'flow_vec';
const EDIT = 'flow_edit';
let project: Project;
let group = '';

const square: VectorImage = {
  width: 20,
  height: 20,
  shapes: [{ id: 'p1', kind: 'polygon', color: '#de2929', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
};

const wire = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({
  id,
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: to, portId: toPort },
  rules: '',
  settings: { enabled: true, mode: 'reference' as const, weight: 1, notes: '' },
});

async function save(next: Project): Promise<void> {
  project = await api<Project>('PUT', `/api/projects/${project.id}`, next);
}

async function generate(id: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${id}/generate`);
  project = result.project;
  return result;
}

const node = (id: string, kind: string, name: string, x: number, data: FlowNode['data']): FlowNode => ({
  id,
  kind,
  name,
  position: { x, y: 60 },
  notes: '',
  data,
  outputs: [],
});

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Custom', template: 'empty' });
  await save({
    ...project,
    nodes: [
      node(IMG, 'art.image', 'Source', 60, emptyImageFlowData()),
      node(VEC, 'art.vectorize', 'Decompose', 420, { ...emptyVectorizeFlowData(), result: square }),
      node(EDIT, 'art.vector.edit', 'Edit', 780, { ...adopt(emptyVectorEditFlowData(), square, undefined), edits: 1 }),
    ],
    connections: [wire('w1', IMG, 'image', VEC, 'image'), wire('w2', VEC, 'vector', EDIT, 'vector')],
  });
  const upload = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${IMG}/outputs/image`,
    { fileName: 'hero.png', data: `data:image/png;base64,${tinyPngBase64()}` },
  );
  project = upload.project;
  const made = createCustomFlow(project, { name: 'Trace', memberIds: [VEC, EDIT], ...proposePorts(project, [VEC, EDIT]) });
  group = made.nodeId;
  await save(made.project);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a project keeps its custom flows and which flows are behind which card', async () => {
  const read = await api<Project>('GET', `/api/projects/${project.id}`);
  assert.equal(read.customFlows?.length, 1);
  assert.equal(read.customFlows![0]!.name, 'Trace');
  assert.deepEqual(membersOf(read, group).map((one) => one.id).sort(), [EDIT, VEC]);
});

test('generating a custom flow generates every flow behind it, upstream first', async () => {
  const result = await generate(group);
  assert.deepEqual(result.runs.map((run) => run.flowId), [VEC, EDIT]);
  assert.ok(result.runs.every((run) => run.ok), result.runs.map((run) => run.error).join('; '));
  const written = readVectorImage(
    JSON.parse(await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${EDIT}/vector.json`)).text()),
  );
  assert.equal(written.shapes.length, 1);
  assert.equal(flowStatus(project, project.nodes.find((one) => one.id === group)!), 'ready');
});

test('generating everything leaves the card out and runs its flows', async () => {
  const other = instantiateCustomFlow(project, project.customFlows![0]!.id, { x: 0, y: 400 });
  await save(other.project);
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/generate`);
  project = result.project;
  const ran = new Set(result.runs.map((run) => run.flowId));
  assert.ok(!ran.has(other.nodeId), 'the card is not a flow to run');
  for (const member of membersOf(project, other.nodeId)) assert.ok(ran.has(member.id), member.name);
});
