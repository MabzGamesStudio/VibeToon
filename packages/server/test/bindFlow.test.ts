import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-bind-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  bindNodes,
  emptyBindFlowData,
  nodeKey,
  emptyRigFlowData,
  readBoundRig,
  type ArtifactRef,
  type BindFlowData,
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

const RIG = 'flow_rig';
const VEC = 'flow_vec';
const BIND = 'flow_bind';
let project: Project;
let rigHash = '';
let vectorHash = '';

const drawing: VectorImage = {
  width: 60,
  height: 60,
  shapes: [
    { id: 'a', kind: 'polygon', color: '#de2929', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }] },
    { id: 'b', kind: 'polygon', color: '#2840dc', points: [{ x: 20, y: 0 }, { x: 28, y: 0 }, { x: 28, y: 8 }] },
  ],
};

/** Every node of the named shapes. */
const nodesOfShapes = (...ids: string[]) =>
  drawing.shapes.filter((shape) => ids.includes(shape.id)).flatMap((shape) => shape.points.map(nodeKey));

/** Put a file on a flow's port by hand; what is under test is the binding. */
async function put(flow: string, portId: string, fileName: string, body: unknown): Promise<ArtifactRef> {
  const content = `${JSON.stringify(body, null, 2)}\n`;
  const result = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${flow}/outputs/${portId}`,
    { fileName, data: Buffer.from(content, 'utf8').toString('base64') },
  );
  project = result.project;
  return result.artifact;
}

async function setBind(data: BindFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === BIND ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${BIND}/generate`);
  project = result.project;
  return result;
}

const file = async (name: string) =>
  (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${BIND}/${name}`)).text();

const wire = (id: string, from: string, fromPort: string, toPort: string) => ({
  id,
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: BIND, portId: toPort },
  rules: '',
  settings: { enabled: true, mode: 'reference' as const, weight: 1, notes: '' },
});

function held(): BindFlowData {
  return {
    ...emptyBindFlowData(),
    rig: emptyRigFlowData('human'),
    image: drawing,
    rigHash,
    vectorHash,
  };
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Bind', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: RIG, kind: 'animation.rig', name: 'Rig', position: { x: 60, y: 40 }, notes: '', data: emptyRigFlowData('human'), outputs: [] },
      { id: VEC, kind: 'art.vectorize', name: 'Shapes', position: { x: 60, y: 240 }, notes: '', data: { editor: 'vectorize', options: {}, result: null } as unknown as FlowNode['data'], outputs: [] },
      { id: BIND, kind: 'animation.bind', name: 'Bind', position: { x: 440, y: 140 }, notes: '', data: emptyBindFlowData(), outputs: [] },
    ],
    connections: [wire('w1', RIG, 'rig', 'rig'), wire('w2', VEC, 'vector', 'vector')],
  });
  rigHash = (await put(RIG, 'rig', 'rig.json', emptyRigFlowData('human'))).hash;
  vectorHash = (await put(VEC, 'vector', 'vector.json', drawing)).hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a binding with nothing taken in warns rather than writing an empty one', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((w) => /Nothing taken in to bind/.test(w)), run.warnings.join('; '));
});

test('a binding writes the map, a preview and a report', async () => {
  await setBind(bindNodes(held(), nodesOfShapes('a'), 'hips'));
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((o) => o.fileName).sort(), ['bound.json', 'bound.md', 'bound.svg']);
});

test('what is written is the rig, the drawing and the map between them', async () => {
  const bound = readBoundRig(JSON.parse(await file('bound.json')))!;
  assert.ok(bound.rig.bones.length > 0);
  assert.equal(bound.image.shapes.length, 2);
  assert.deepEqual(bound.points, { a: ['hips', 'hips', 'hips'] });
});

test('the preview draws the skeleton over the drawing', async () => {
  // So a binding can be looked at rather than read.
  const svg = await file('bound.svg');
  assert.match(svg, /^<svg/);
  assert.match(svg, /data-bone="hips"/);
  assert.match(svg, /fill="#de2929"/);
  assert.equal((svg.match(/<circle[^>]*data-bone="hips"/g) ?? []).length, 3, 'and each bound node as a dot');
  assert.match(svg, /<\/svg>\s*$/);
});

test('an unbound node is warned about, because it will not move', async () => {
  const run = (await generate()).runs[0]!;
  assert.ok(
    run.warnings.some((w) => /bound to nothing and will stay put/.test(w)),
    run.warnings.join('; '),
  );
});

test('binding nothing at all is reported as the bigger problem', async () => {
  await setBind(held());
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((w) => /Nothing is bound yet/.test(w)), run.warnings.join('; '));
});

test('the report says what moves with what, node by node', async () => {
  await setBind(bindNodes(held(), nodesOfShapes('a', 'b'), 'spine'));
  await generate();
  const doc = await file('bound.md');
  assert.match(doc, /## What moves with what/);
  assert.match(doc, /\| Spine \| 6 \| 2 \|/, 'six nodes, across both shapes');
  assert.match(doc, /bends where they meet/);
  assert.match(doc, /cannot tear two shapes apart/);
  assert.match(doc, /stays where it was drawn/);
});

test('a changed input is reported but the binding is kept', async () => {
  // Redoing a binding is an afternoon, and nobody would thank a flow that threw
  // it away on somebody else's re-run.
  await setBind({ ...bindNodes(held(), nodesOfShapes('a'), 'hips'), rigHash: 'an-older-hash' });
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((w) => /has changed since this was bound/.test(w)), run.warnings.join('; '));
  assert.ok(run.outputs.some((o) => o.fileName === 'bound.json'), 'and it still wrote it');
  assert.deepEqual(readBoundRig(JSON.parse(await file('bound.json')))!.points, { a: ['hips', 'hips', 'hips'] });
});

test('each missing input is named, so it is clear which wire to add', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    connections: [wire('w1', RIG, 'rig', 'rig')],
  });
  assert.ok((await generate()).runs[0]!.warnings.some((w) => /No drawing wired in/.test(w)));

  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...(await api<Project>('GET', `/api/projects/${project.id}`)),
    connections: [],
  });
  assert.ok((await generate()).runs[0]!.warnings.some((w) => /No rig wired in/.test(w)));
});
