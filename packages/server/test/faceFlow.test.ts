import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-faceflow-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  emptyFaceFlowData,
  emptyPartsFlowData,
  makeHead,
  setFeature,
  splitIntoParts,
  type ArtifactRef,
  type FaceFlowData,
  type FacePartsFile,
  type FlowNode,
  type GenerateResponse,
  type Project,
} from '@vibetoon/shared';
import { matchBody } from '../../shared/test/fixtures/matchBody';
import { faceDrawing } from '../../shared/test/fixtures/faceDrawing';

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
  // A head drawn as a vector, on the drawing flow's port.
  const drawn = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${DRAWN}/outputs/vector`, {
    fileName: 'vector.json',
    data: Buffer.from(JSON.stringify(faceDrawing())).toString('base64'),
  });
  project = drawn.project;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('face parts: heads from a parts file and a drawing, each feature written as set', async () => {
  const bodyHead = splitIntoParts(matchBody()).find((part) => part.id === 'head')!;
  const cartoon = makeHead(DRAWN, 'Cartoon', faceDrawing(), { node: DRAWN, part: null });
  let data: FaceFlowData = { ...emptyFaceFlowData(), heads: [makeHead(`${PARTS}:head`, 'Head', bodyHead.image, { node: PARTS, part: 'head' }), cartoon], current: cartoon.id };
  data = setFeature(data, cartoon.id, 'hair', { hidden: true });
  data = setFeature(data, `${PARTS}:head`, 'eye-left', { swap: { head: cartoon.id, feature: 'eye-left' } });
  await setData(FACE, data);
  const run = (await generate(FACE)).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const written = JSON.parse(await file(FACE, 'face.json')) as FacePartsFile;
  assert.equal(written.heads.length, 2);
  const eye = written.heads[0]!.features.find((feature) => feature.id === 'eye-left')!;
  assert.deepEqual(eye.swappedFrom, { head: cartoon.id, feature: 'eye-left' });
  assert.ok(eye.shapes.every((shape) => shape.id.startsWith(`${cartoon.id}~`)));
  assert.equal(written.heads[1]!.features.find((feature) => feature.id === 'hair')!.shapes.length, 0);
  const faces = project.nodes.find((one) => one.id === FACE)!.outputs.find((output) => output.port === 'faces')!;
  assert.deepEqual([...faces.entries!].sort(), ['cartoon.svg', 'head.svg']);
  const features = project.nodes.find((one) => one.id === FACE)!.outputs.find((output) => output.port === 'parts')!;
  assert.ok(features.entries!.includes('cartoon-mouth.svg'));
  assert.ok(!features.entries!.includes('cartoon-hair.svg'), 'a hidden feature has no drawing');
});

test('face parts: with nothing taken in, it says so', async () => {
  await setData(FACE, emptyFaceFlowData());
  const run = (await generate(FACE)).runs[0]!;
  assert.ok(run.warnings.some((line) => /Take them in/.test(line)), run.warnings.join('; '));
});
