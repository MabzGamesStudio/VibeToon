import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-partsflow-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  adoptBound,
  emptyFaceFlowData,
  emptyPartsFlowData,
  moveShapesToPart,
  readRigParts,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
} from '@vibetoon/shared';
import { matchBody } from '../../shared/test/fixtures/matchBody';

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

const BIND = 'flow_bind';
const PARTS = 'flow_parts';
const DRAWN = 'flow_drawn';
const FACE = 'flow_face';
let project: Project;
let boundHash = '';

async function setData(id: string, data: FlowNode['data']): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, nodes: current.nodes.map((node) => (node.id === id ? ({ ...node, data } as FlowNode) : node)) });
}

async function generate(id: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${id}/generate`);
  project = result.project;
  return result;
}

const file = async (id: string, name: string) => (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${id}/${name}`)).text();
const wire = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { nodeId: from, portId: fp }, to: { nodeId: to, portId: tp }, rules: '', settings: { enabled: true, mode: 'reference' as const, weight: 1, notes: '' } });
const node = (id: string, kind: string, x: number, data: FlowNode['data']): FlowNode => ({ id, kind, name: id, position: { x, y: 0 }, notes: '', data, outputs: [] });

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Parts', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      node(BIND, 'animation.bind', 0, { editor: 'bind' } as never),
      node(PARTS, 'animation.parts', 300, emptyPartsFlowData()),
      node(DRAWN, 'art.vector.edit', 0, { editor: 'vectorEdit', image: null, selected: [], edits: 0 }),
      node(FACE, 'animation.face', 600, emptyFaceFlowData()),
    ],
    connections: [wire('w1', BIND, 'bound', PARTS, 'bound'), wire('w2', PARTS, 'parts', FACE, 'heads'), wire('w3', DRAWN, 'vector', FACE, 'heads')],
  });
  const upload = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${BIND}/outputs/bound`, {
    fileName: 'bound.json',
    data: Buffer.from(JSON.stringify(matchBody())).toString('base64'),
  });
  project = upload.project;
  boundHash = upload.artifact.hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('rig parts: nothing taken in says so', async () => {
  const run = (await generate(PARTS)).runs[0]!;
  assert.ok(run.warnings.some((line) => /Take it in/.test(line)), run.warnings.join('; '));
});

test('rig parts: every part is written, with its shapes, all together, and one drawing each', async () => {
  const data = moveShapesToPart(adoptBound(emptyPartsFlowData(), matchBody(), boundHash), ['hair'], 'head', 'neck');
  await setData(PARTS, data);
  const run = (await generate(PARTS)).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const parts = readRigParts(JSON.parse(await file(PARTS, 'parts.json')))!;
  assert.equal(parts.parts.length, data.parts.length);
  assert.ok(parts.parts.find((part) => part.id === 'neck')!.image.shapes.some((shape) => shape.id === 'hair'), 'as edited');
  const together = await file(PARTS, 'parts.svg');
  assert.equal((together.match(/<path/g) ?? []).length, matchBody().image.shapes.length);
  const set = project.nodes.find((one) => one.id === PARTS)!.outputs.find((output) => output.port === 'images')!;
  assert.ok(set.entries!.includes('head.svg'));
  assert.ok(set.entries!.includes('left-upper-arm.svg'));
});
