import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-design-'));
process.env.VIBETOON_DATA = dataRoot;

const { createApp } = await import('../src/app');
import {
  emptyDesignData,
  plateFileName,
  requireFlowKind,
  type DesignFlowData,
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

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let project: Project;
const designId = 'flow_design1';

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Design test', template: 'empty' });
  const data = emptyDesignData(requireFlowKind('animation.character.design'));
  data.fields.silhouette = 'Tall, round shoulders, readable at thumbnail size.';
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: designId,
        kind: 'animation.character.design',
        name: 'Mabz design',
        position: { x: 80, y: 80 },
        notes: 'Keep the hands simple.',
        data,
        outputs: [],
      },
    ],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a design flow starts with plates to draw on', () => {
  const data = project.nodes[0]!.data as DesignFlowData;
  assert.deepEqual(
    data.plates.map((plate) => plate.label),
    ['Front', 'Three-quarter', 'Expressions'],
  );
  assert.ok(data.plates.every((plate) => plate.sketch === null));
});

test('without drawings it still writes the spec, and says what is missing', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${designId}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.deepEqual(run.outputs.map((output) => output.fileName), ['design.md']);
  assert.ok(run.warnings.some((warning) => /No plate has been drawn/.test(warning)), run.warnings.join(' | '));

  const spec = await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${designId}/design.md`)
  ).text();
  assert.match(spec, /Tall, round shoulders/);
  assert.match(spec, /Keep the hands simple/);
});

test('the drawings sent with a run become the key image and the model sheet', async () => {
  const data = project.nodes[0]!.data as DesignFlowData;
  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${designId}/generate`,
    {
      attachments: [
        { name: 'design.png', data: PNG },
        { name: `modelSheet/${plateFileName(0, data.plates[0]!.label)}`, data: PNG },
        { name: `modelSheet/${plateFileName(1, data.plates[1]!.label)}`, data: PNG },
      ],
    },
  );
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);

  const key = run.outputs.find((output) => output.port === 'design');
  assert.ok(key, 'the first plate lands on the image port');
  assert.equal(key!.fileName, 'character.png');

  const sheet = run.outputs.find((output) => output.port === 'modelSheet');
  assert.deepEqual(sheet!.entries, ['plate-001-front.png', 'plate-002-three-quarter.png']);

  const image = await fetch(`${base}/api/projects/${project.id}/files/${key!.path}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('a regenerate without the drawings keeps the images already on the ports', async () => {
  // The editor saves strokes before it sends anything, so this is the state a
  // flow is in when someone presses Generate from the graph instead.
  const data = project.nodes[0]!.data as DesignFlowData;
  const drawn: DesignFlowData = {
    ...data,
    plates: data.plates.map((plate, index) =>
      index > 1
        ? plate
        : {
            ...plate,
            sketch: {
              width: 720,
              height: 560,
              strokes: [{ points: [10, 10, 200, 300], width: 3, color: '#1d1a17' }],
              updatedAt: new Date().toISOString(),
            },
          },
    ),
  };
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: project.nodes.map((node) => (node.id === designId ? { ...node, data: drawn } : node)),
  });

  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${designId}/generate`);
  project = result.project;
  const ports = result.runs[0]!.outputs.map((output) => output.port).sort();
  assert.deepEqual(ports, ['design', 'modelSheet', 'spec'], 'the pictures are not dropped');
  assert.ok(
    result.runs[0]!.warnings.some((warning) => /no images were sent/.test(warning)),
    result.runs[0]!.warnings.join(' | '),
  );
});
