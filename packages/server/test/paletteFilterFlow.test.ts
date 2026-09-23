import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-filter-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng, tinyPngBase64 } from './pngFixture';
import {
  emptyImageFlowData,
  emptyPaletteFilterFlowData,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type PaletteFilterFlowData,
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

const IMAGE_ID = 'flow_image';
const PALETTE_ID = 'flow_palette';
const FILTER_ID = 'flow_filter';
let project: Project;
let imageHash = '';
let paletteHash = '';

const RED = '#dc2828';
const BLUE = '#283cdc';

/**
 * Put a palette file on a flow's port by hand.
 *
 * The palette flow's own generator needs a histogram the editor makes, so this
 * writes the artifact directly — what is under test here is the filter reading a
 * palette, not the palette flow producing one.
 */
async function putPalette(body: unknown): Promise<ArtifactRef> {
  const dir = path.join(dataRoot, 'projects', project.id, 'artifacts', PALETTE_ID);
  await mkdir(dir, { recursive: true });
  const content = `${JSON.stringify(body, null, 2)}\n`;
  await writeFile(path.join(dir, 'palette.json'), content, 'utf8');

  const upload = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${PALETTE_ID}/outputs/palette`,
    { fileName: 'palette.json', data: Buffer.from(content, 'utf8').toString('base64') },
  );
  project = upload.project;
  return upload.artifact;
}

async function setFilter(data: PaletteFilterFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === FILTER_ID ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(attachments: Array<{ name: string; data: string }> = []): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${FILTER_ID}/generate`,
    { attachments },
  );
  project = result.project;
  return result;
}

const png = () => [
  { name: 'filtered.png', data: `data:image/png;base64,${encodePng([[[20, 180, 90]]]).toString('base64')}` },
];

async function report(): Promise<string> {
  return (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${FILTER_ID}/filter.md`)).text();
}

function wire(from: string, fromPort: string, toPort: string) {
  return {
    id: `c_${from}_${toPort}`,
    from: { nodeId: from, portId: fromPort },
    to: { nodeId: FILTER_ID, portId: toPort },
    rules: '',
    settings: { enabled: true, mode: 'reference' as const, weight: 1, notes: '' },
  };
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Filter flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: IMAGE_ID,
        kind: 'art.image',
        name: 'Reference',
        position: { x: 80, y: 40 },
        notes: '',
        data: emptyImageFlowData(),
        outputs: [],
      },
      {
        id: PALETTE_ID,
        kind: 'art.palette',
        name: 'Palette',
        position: { x: 80, y: 220 },
        notes: '',
        data: { editor: 'palette', options: {}, histogram: null, edits: { changed: {}, removed: [], added: [] } } as unknown as FlowNode['data'],
        outputs: [],
      },
      {
        id: FILTER_ID,
        kind: 'art.palette.filter',
        name: 'Filter',
        position: { x: 460, y: 120 },
        notes: '',
        data: emptyPaletteFilterFlowData(),
        outputs: [],
      },
    ],
    connections: [wire(IMAGE_ID, 'image', 'image'), wire(PALETTE_ID, 'palette', 'palette')],
  });

  const upload = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${IMAGE_ID}/outputs/image`,
    { fileName: 'hero.png', data: `data:image/png;base64,${tinyPngBase64()}` },
  );
  project = upload.project;
  imageHash = upload.artifact.hash;

  const palette = await putPalette({ colors: [{ hex: RED, share: 0.6 }, { hex: BLUE, share: 0.4 }] });
  paletteHash = palette.hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- what it writes ---------------- */

test('a filter writes the picture and a report that names the palette', async () => {
  await setFilter({ ...emptyPaletteFilterFlowData(), imageHash, paletteHash });
  const run = (await generate(png())).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['filter.md', 'filtered.png']);

  const body = await report();
  assert.match(body, new RegExp(RED));
  assert.match(body, new RegExp(BLUE));
  assert.match(body, /Keep only palette colors/);
  assert.match(body, /OKLab/);
});

test('the report says what the mode does, not just which one it was', async () => {
  const body = await report();
  assert.match(body, /## What the mode does/);
  assert.match(body, /goes transparent/);
  assert.match(body, /already transparent is left alone/, 'so a cutout wired in keeps its shape');
});

test('snap is reported as having no threshold, because it has none', async () => {
  const data = emptyPaletteFilterFlowData();
  await setFilter({ ...data, options: { ...data.options, mode: 'snap' }, imageHash, paletteHash });
  await generate(png());
  const body = await report();
  assert.match(body, /Snap every pixel to the palette/);
  assert.match(body, /has no threshold/);
  assert.ok(!/- Tolerance:/.test(body), 'a tolerance line would be a lie in this mode');
});

test('the tolerance is reported where it applies, and spelled out at zero', async () => {
  const data = emptyPaletteFilterFlowData();
  await setFilter({
    ...data,
    options: { ...data.options, mode: 'keep', tolerance: 25 },
    imageHash,
    paletteHash,
  });
  await generate(png());
  assert.match(await report(), /Tolerance: 25$/m);

  // Zero is the value worth a sentence: it is the one a drawing wants, and it is
  // the one that looks broken if you do not know it means "exactly".
  await setFilter({
    ...data,
    options: { ...data.options, mode: 'keep', tolerance: 0 },
    imageHash,
    paletteHash,
  });
  await generate(png());
  assert.match(await report(), /Tolerance: 0 — an exact match and nothing else/);
});

test('a color switched off is written as switched off', async () => {
  const data = emptyPaletteFilterFlowData();
  await setFilter({ ...data, options: { ...data.options, only: [RED] }, imageHash, paletteHash });
  await generate(png());
  const body = await report();
  assert.match(body, /Colors in play: 1 of 2/);
  assert.match(body, new RegExp(`\`${BLUE}\` \\| switched off`));
});

/* ---------------- what it refuses ---------------- */

test('a palette with no readable colors is refused rather than filtered against nothing', async () => {
  await putPalette({ colors: [] });
  const run = (await generate(png())).runs[0]!;
  assert.ok(run.warnings.some((warning) => /no colors in it/.test(warning)), run.warnings.join('; '));
});

test('a palette file that is not JSON is reported as that, not as an empty palette', async () => {
  const dir = path.join(dataRoot, 'projects', project.id, 'artifacts', PALETTE_ID);
  await mkdir(dir, { recursive: true });
  const junk = 'this is not json at all';
  const upload = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${PALETTE_ID}/outputs/palette`,
    { fileName: 'palette.json', data: Buffer.from(junk, 'utf8').toString('base64') },
  );
  project = upload.project;

  const run = (await generate(png())).runs[0]!;
  assert.ok(run.warnings.some((warning) => /readable JSON/.test(warning)), run.warnings.join('; '));
});

test('every color switched off is refused with its own reason', async () => {
  await putPalette({ colors: [{ hex: RED }, { hex: BLUE }] });
  const data = emptyPaletteFilterFlowData();
  await setFilter({ ...data, options: { ...data.options, only: ['#00ff00'] }, imageHash });
  const run = (await generate(png())).runs[0]!;
  assert.ok(run.warnings.some((warning) => /switched off/.test(warning)), run.warnings.join('; '));
});

test('nothing rendered yet is a warning rather than a missing file', async () => {
  await setFilter({ ...emptyPaletteFilterFlowData(), imageHash, paletteHash });
  const run = (await generate()).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => /Nothing has been filtered yet|has changed since/.test(warning)),
    run.warnings.join('; '),
  );
});

test('each missing input is named specifically, so it is clear which wire to add', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    connections: [wire(IMAGE_ID, 'image', 'image')],
  });
  let run = (await generate(png())).runs[0]!;
  assert.ok(run.warnings.some((warning) => /No palette wired in/.test(warning)), run.warnings.join('; '));

  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...(await api<Project>('GET', `/api/projects/${project.id}`)),
    connections: [],
  });
  run = (await generate(png())).runs[0]!;
  assert.ok(run.warnings.some((warning) => /No image wired in/.test(warning)), run.warnings.join('; '));
});
