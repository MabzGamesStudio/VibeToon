import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-vectoredit-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { tinyPngBase64 } from './pngFixture';
import {
  adopt,
  emptyImageFlowData,
  emptyVectorEditFlowData,
  emptyVectorizeFlowData,
  readVectorImage,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type VectorEditFlowData,
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
let imageHash = '';

/** A small vectorized image, standing in for what the editor would produce. */
function sample(): VectorImage {
  return {
    width: 20,
    height: 20,
    shapes: [
      {
        id: 'p1',
        kind: 'polygon',
        color: '#de2929',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
      {
        id: 'l1',
        kind: 'line',
        color: '#101010',
        width: 2,
        points: [
          { x: 10, y: 0 },
          { x: 10, y: 20 },
        ],
        curved: false,
        closed: false,
      },
    ],
  };
}

async function setData(id: string, data: FlowNode['data']): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === id ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(id: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${id}/generate`);
  project = result.project;
  return result;
}

async function file(id: string, name: string): Promise<string> {
  return (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${id}/${name}`)).text();
}

const wire = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({
  id,
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: to, portId: toPort },
  rules: '',
  settings: { enabled: true, mode: 'reference' as const, weight: 1, notes: '' },
});

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Vector', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: IMG,
        kind: 'art.image',
        name: 'Source',
        position: { x: 60, y: 60 },
        notes: '',
        data: emptyImageFlowData(),
        outputs: [],
      },
      {
        id: VEC,
        kind: 'art.vectorize',
        name: 'Decompose',
        position: { x: 420, y: 60 },
        notes: '',
        data: emptyVectorizeFlowData(),
        outputs: [],
      },
      {
        id: EDIT,
        kind: 'art.vector.edit',
        name: 'Edit',
        position: { x: 780, y: 60 },
        notes: '',
        data: emptyVectorEditFlowData(),
        outputs: [],
      },
    ],
    connections: [wire('w1', IMG, 'image', VEC, 'image'), wire('w2', VEC, 'vector', EDIT, 'vector')],
  });

  const upload = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${IMG}/outputs/image`,
    { fileName: 'hero.png', data: `data:image/png;base64,${tinyPngBase64()}` },
  );
  project = upload.project;
  imageHash = upload.artifact.hash;

  // Give the decomposition something to have produced, so the editor has an
  // input with a hash to be stale against.
  await setData(VEC, { ...emptyVectorizeFlowData(), result: sample(), imageHash });
  await generate(VEC);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- editing ---------------- */

test('an editor with nothing taken in warns rather than writing an empty drawing', async () => {
  const run = (await generate(EDIT)).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((w) => /Nothing has been taken in/.test(w)), run.warnings.join('; '));
});

test('an editor writes what it holds, not what its input says', async () => {
  // The point of the flow: the edits are the work, so they are what is written.
  const edited: VectorImage = {
    ...sample(),
    shapes: [sample().shapes[0]!],
  };
  const source = project.nodes.find((node) => node.id === VEC)!.outputs.find((o) => o.port === 'vector')!;
  await setData(EDIT, {
    ...adopt(emptyVectorEditFlowData(), edited, source.hash),
    edits: 4,
  } satisfies VectorEditFlowData);

  const run = (await generate(EDIT)).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  const written = readVectorImage(JSON.parse(await file(EDIT, 'vector.json')));
  assert.equal(written.shapes.length, 1, 'the deleted line stayed deleted');
  assert.ok(run.log.some((entry) => /4 edit\(s\)/.test(entry)), run.log.join('; '));
});

test('an upstream change is reported but the edits are still written', async () => {
  // Losing an afternoon's work to someone re-running the decomposition would
  // make the flow not worth using, so it warns and writes anyway.
  await setData(EDIT, {
    ...adopt(emptyVectorEditFlowData(), sample(), 'an-older-hash'),
    edits: 9,
  } satisfies VectorEditFlowData);
  const run = (await generate(EDIT)).runs[0]!;
  assert.ok(run.warnings.some((w) => /has changed since these edits/.test(w)), run.warnings.join('; '));
  assert.ok(run.outputs.some((output) => output.fileName === 'vector.json'), 'and it still wrote them');
});

test('a polygon made concave by editing is reported', async () => {
  // Dragging a point can do it, and anything relying on convexity should know.
  const dart: VectorImage = {
    width: 20,
    height: 20,
    shapes: [
      {
        id: 'bad',
        kind: 'polygon',
        color: '#de2929',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 5, y: 5 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
    ],
  };
  await setData(EDIT, adopt(emptyVectorEditFlowData(), dart, undefined));
  const run = (await generate(EDIT)).runs[0]!;
  assert.ok(run.warnings.some((w) => /no longer convex/.test(w)), run.warnings.join('; '));
});

test('nothing wired in is a warning about wiring', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });
  assert.ok((await generate(EDIT)).runs[0]!.warnings.some((w) => /No vector wired in/.test(w)));
});
