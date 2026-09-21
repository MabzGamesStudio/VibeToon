import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-cutout-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng, tinyPngBase64 } from './pngFixture';
import {
  emptyCutoutFlowData,
  emptyImageFlowData,
  type ArtifactRef,
  type CutLine,
  type CutoutFlowData,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type Seed,
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

const SOURCE_ID = 'flow_source';
const CUT_ID = 'flow_cut';
let project: Project;

const seed = (over: Partial<Seed> = {}): Seed => ({
  id: 'seed_a',
  mode: 'include',
  x: 1,
  y: 1,
  tolerance: 12,
  ...over,
});

const line = (over: Partial<CutLine> = {}): CutLine => ({
  id: 'cut_a',
  points: [0, 0, 8, 8],
  width: 2,
  mode: 'block',
  ...over,
});

/** A 1x1 PNG as a data URL, standing in for what the editor rasterised. */
function rendered(): string {
  return `data:image/png;base64,${encodePng([[[20, 180, 90]]]).toString('base64')}`;
}

async function setCutout(data: CutoutFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === CUT_ID ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(attachments: Array<{ name: string; data: string }> = []): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${CUT_ID}/generate`,
    { attachments },
  );
  project = result.project;
  return result;
}

const bothPngs = () => [
  { name: 'cutout.png', data: rendered() },
  { name: 'mask.png', data: rendered() },
];

async function doc(): Promise<string> {
  return (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${CUT_ID}/cutout.md`)).text();
}

let sourceHash = '';

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Cutout flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: SOURCE_ID,
        kind: 'art.image',
        name: 'Reference',
        position: { x: 80, y: 80 },
        notes: '',
        data: emptyImageFlowData(),
        outputs: [],
      },
      {
        id: CUT_ID,
        kind: 'art.cutout',
        name: 'Cutout',
        position: { x: 440, y: 80 },
        notes: '',
        data: emptyCutoutFlowData(),
        outputs: [],
      },
    ],
    connections: [
      {
        id: 'c1',
        from: { nodeId: SOURCE_ID, portId: 'image' },
        to: { nodeId: CUT_ID, portId: 'image' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });

  const upload = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${SOURCE_ID}/outputs/image`,
    { fileName: 'hero.png', data: `data:image/png;base64,${tinyPngBase64()}` },
  );
  project = upload.project;
  sourceHash = upload.artifact.hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- nothing selected ---------------- */

test('a cutout with nothing selected warns instead of writing a blank picture', async () => {
  // An empty selection must not quietly mean "keep everything" — that would write
  // a copy of the input and look like it worked.
  const run = (await generate(bothPngs())).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(
    run.warnings.some((warning) => /Nothing has been selected/.test(warning)),
    run.warnings.join('; '),
  );
});

test('selections with no rendered picture warn rather than writing the notes alone', async () => {
  // The notes without the cutout would be a flow that claims to have produced
  // something it has not.
  await setCutout({ ...emptyCutoutFlowData(), seeds: [seed()], imageHash: sourceHash });
  const run = (await generate()).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((warning) => /has not been rendered/.test(warning)), run.warnings.join('; '));
});

/* ---------------- what it writes ---------------- */

test('a cutout writes the picture, the mask and the notes', async () => {
  await setCutout({
    ...emptyCutoutFlowData(),
    seeds: [seed()],
    lines: [line()],
    imageHash: sourceHash,
    imageWidth: 2,
    imageHeight: 2,
  });
  const run = (await generate(bothPngs())).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(
    run.outputs.map((output) => output.fileName).sort(),
    ['cutout.md', 'cutout.png', 'mask.png'],
  );

  const png = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${CUT_ID}/cutout.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
});

test('the mask is optional — the cutout alone is still worth writing', async () => {
  await setCutout({ ...emptyCutoutFlowData(), seeds: [seed()], imageHash: sourceHash });
  const run = (await generate([{ name: 'cutout.png', data: rendered() }])).runs[0]!;
  assert.ok(run.outputs.some((output) => output.fileName === 'cutout.png'));
  assert.ok(run.log.some((entry) => /mask was not rendered/.test(entry)), run.log.join('; '));
});

test('the notes list every object in the terms of what it does', async () => {
  await setCutout({
    ...emptyCutoutFlowData(),
    seeds: [seed(), seed({ id: 'seed_b', mode: 'exclude', x: 0, y: 1, tolerance: 30 })],
    lines: [line(), line({ id: 'cut_b', mode: 'erase', points: [0, 0, 4, 4, 8, 0] })],
    imageHash: sourceHash,
    imageWidth: 2,
    imageHeight: 2,
  });
  await generate(bothPngs());
  const body = await doc();

  assert.match(body, /Include 1/);
  assert.match(body, /Exclude 1/);
  assert.match(body, /Cut 1/);
  assert.match(body, /Erase 2/);
  assert.match(body, /fills a region in/);
  assert.match(body, /takes a region out/);
  assert.match(body, /blocks a fill from crossing/);
  assert.match(body, /clears what it covers/);
  assert.match(body, /curved/);
});

test('the notes explain how a fill decides, not just that there was one', async () => {
  const body = await doc();
  // The distinction that makes the tool trustworthy rather than magic.
  assert.match(body, /of the pixel that was clicked/);
  assert.match(body, /OKLab/);
  assert.match(body, /rebuilt from that list every time/);
});

test('an object switched off is written as off rather than left out', async () => {
  await setCutout({
    ...emptyCutoutFlowData(),
    seeds: [seed(), seed({ id: 'seed_b', mode: 'exclude', muted: true })],
    imageHash: sourceHash,
  });
  await generate(bothPngs());
  const body = await doc();
  assert.match(body, /\*\(off\)\*/);
  assert.match(body, /Excluded regions: 0/, 'a muted object is not counted as doing something');
});

test('the edge settings are explained only when they are doing something', async () => {
  await setCutout({ ...emptyCutoutFlowData(), seeds: [seed()], imageHash: sourceHash });
  await generate(bothPngs());
  assert.ok(!/## Edge/.test(await doc()), 'no edge section when nothing was grown or feathered');

  await setCutout({
    ...emptyCutoutFlowData(),
    options: { ...emptyCutoutFlowData().options, grow: 2, feather: 3 },
    seeds: [seed()],
    imageHash: sourceHash,
  });
  await generate(bothPngs());
  const body = await doc();
  assert.match(body, /## Edge/);
  assert.match(body, /Grown by 2px/);
  assert.match(body, /Feathered by 3px/);
});

/* ---------------- staleness ---------------- */

test('a changed image is reported rather than cut against the old one', async () => {
  await setCutout({
    ...emptyCutoutFlowData(),
    seeds: [seed()],
    imageHash: 'some-older-hash',
  });
  const before = (await api<Project>('GET', `/api/projects/${project.id}`)).nodes.find(
    (node) => node.id === CUT_ID,
  )!.outputs;

  const run = (await generate()).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => /has changed since the cutout was made/.test(warning)),
    run.warnings.join('; '),
  );
  // A run reports what the flow holds, and it still holds the files earlier runs
  // wrote — so what matters is that this run wrote nothing new over them.
  const after = project.nodes.find((node) => node.id === CUT_ID)!.outputs;
  assert.deepEqual(after, before, 'a stale run must not overwrite the good cutout');
});

/* ---------------- nothing wired in ---------------- */

test('no image wired in is a warning about wiring, not about pixels', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });

  const run = (await generate(bothPngs())).runs[0]!;
  assert.ok(run.warnings.some((warning) => /No image wired in/.test(warning)), run.warnings.join('; '));
});
