import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-vectorize-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { tinyPngBase64 } from './pngFixture';
import {
  emptyImageFlowData,
  emptyVectorEditFlowData,
  emptyVectorizeFlowData,
  readVectorImage,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type VectorImage,
  type VectorizeFlowData,
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
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- decomposition ---------------- */

test('a decomposition that has not been run warns rather than writing nothing useful', async () => {
  const run = (await generate(VEC)).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((w) => /has not been decomposed yet/.test(w)), run.warnings.join('; '));
});

test('a stale decomposition is reported rather than describing the old picture', async () => {
  await setData(VEC, {
    ...emptyVectorizeFlowData(),
    result: sample(),
    imageHash: 'an-older-hash',
  } satisfies VectorizeFlowData);
  const run = (await generate(VEC)).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((w) => /has changed since it was decomposed/.test(w)), run.warnings.join('; '));
});

test('a decomposition writes the shapes, a drawing and a report', async () => {
  await setData(VEC, {
    ...emptyVectorizeFlowData(),
    result: sample(),
    imageHash,
  } satisfies VectorizeFlowData);
  const run = (await generate(VEC)).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(
    run.outputs.map((output) => output.fileName).sort(),
    ['vector.json', 'vector.md', 'vector.svg'],
  );
});

test('the drawing is a real svg with the shapes in it', async () => {
  const svg = await file(VEC, 'vector.svg');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 20 20"/);
  assert.match(svg, /fill="#de2929"/);
  assert.match(svg, /stroke="#101010"/);
  assert.match(svg, /<\/svg>/);

  // Areas first and strokes over them: the order they were in when the picture
  // was a picture.
  assert.ok(svg.indexOf('fill="#de2929"') < svg.indexOf('stroke="#101010"'));
});

test('the shapes read back as what was written', async () => {
  const read = readVectorImage(JSON.parse(await file(VEC, 'vector.json')));
  assert.deepEqual(read, sample());
});

test('the report explains the rule, not just the count', async () => {
  const doc = await file(VEC, 'vector.md');
  assert.match(doc, /## What counts as a line/);
  assert.match(doc, /Polygons come first, and only polygons/);
  assert.match(doc, /\*\*skinny\*\*/);
  assert.match(doc, /\*\*hole\*\*/);
  assert.match(doc, /red box beside a blue box/);
  assert.match(doc, /`#de2929`/, 'and the colors it found');
});

test('the report says whether same-color shapes were joined, and what that means', async () => {
  const joined = await file(VEC, 'vector.md');
  assert.match(joined, /Shapes of the same color that touch: joined/);
  assert.match(joined, /one filling a hole in the other/);

  await setData(VEC, {
    ...emptyVectorizeFlowData(),
    options: { ...emptyVectorizeFlowData().options, joinShapes: false },
    result: sample(),
    imageHash,
  } satisfies VectorizeFlowData);
  await generate(VEC);
  const pieces = await file(VEC, 'vector.md');
  assert.match(pieces, /every polygon cut into convex pieces with its holes bridged/);
  assert.match(pieces, /is convex: each region is cut into/);
});


test('nothing wired in is a warning about wiring', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });
  assert.ok((await generate(VEC)).runs[0]!.warnings.some((w) => /No image wired in/.test(w)));
});
