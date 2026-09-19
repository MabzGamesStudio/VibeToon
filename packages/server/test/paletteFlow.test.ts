import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-palette-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { tinyPngBase64 } from './pngFixture';
import {
  emptyDesignData,
  emptyPaletteFlowData,
  fromHex,
  requireFlowKind,
  type ColorCount,
  type FlowNode,
  type GenerateResponse,
  type ImageHistogram,
  type PaletteFlowData,
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

const DESIGN_ID = 'flow_design';
const PALETTE_ID = 'flow_palette';
let project: Project;

/* ------------------------------------------------------------------ *
 * A real image to put on the port
 * ------------------------------------------------------------------ */

function counts(...rows: Array<[string, number]>): ColorCount[] {
  return rows.map(([hex, count]) => ({ ...fromHex(hex)!, count }));
}

function histogram(hash: string, colors = counts(['#cc3322', 3], ['#4a6fd4', 1])): ImageHistogram {
  return {
    source: 'character.png',
    hash,
    width: 2,
    height: 2,
    pixels: colors.reduce((sum, color) => sum + color.count, 0),
    transparent: 0,
    precision: 5,
    colors,
    readAt: new Date().toISOString(),
  };
}

function paletteNode(data: PaletteFlowData): FlowNode {
  return {
    id: PALETTE_ID,
    kind: 'art.palette',
    name: 'Palette',
    position: { x: 440, y: 80 },
    notes: '',
    data,
    outputs: [],
  };
}

async function setPalette(data: PaletteFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === PALETTE_ID ? paletteNode(data) : node)),
  });
}

async function generate(flowId: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flowId}/generate`);
  project = result.project;
  return result;
}

/** The hash of the image now sitting on the design flow's output port. */
function imageHash(): string {
  const design = project.nodes.find((node) => node.id === DESIGN_ID)!;
  return design.outputs.find((output) => output.port === 'design')!.hash;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Palette flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: DESIGN_ID,
        kind: 'animation.character.design',
        name: 'Character Design',
        position: { x: 80, y: 80 },
        notes: '',
        data: emptyDesignData(requireFlowKind('animation.character.design')),
        outputs: [],
      },
      paletteNode(emptyPaletteFlowData()),
    ],
    connections: [
      {
        id: 'c1',
        from: { nodeId: DESIGN_ID, portId: 'design' },
        to: { nodeId: PALETTE_ID, portId: 'image' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });

  const uploaded = await api<{ project: Project }>(
    'POST',
    `/api/projects/${project.id}/flows/${DESIGN_ID}/outputs/design`,
    { fileName: 'character.png', data: tinyPngBase64() },
  );
  project = uploaded.project;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

async function outputPalette(): Promise<{ colors: Array<{ hex: string; share: number; count: number }> }> {
  const response = await fetch(
    `${base}/api/projects/${project.id}/files/artifacts/${PALETTE_ID}/palette.json`,
  );
  assert.equal(response.ok, true);
  return (await response.json()) as { colors: Array<{ hex: string; share: number; count: number }> };
}

/* ---------------- the flow ---------------- */

test('with nothing counted, the run says so and writes nothing', async () => {
  const run = (await generate(PALETTE_ID)).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs, [], 'no palette rather than an empty one');
  assert.ok(
    run.warnings.some((warning) => /has not been counted yet/.test(warning)),
    run.warnings.join('; '),
  );
  assert.ok(
    run.warnings.some((warning) => /Read the image/.test(warning)),
    'and it says what to do about it',
  );
});

test('a counted image becomes a palette and a report', async () => {
  await setPalette({
    ...emptyPaletteFlowData(),
    histogram: histogram(imageHash()),
    options: { ...emptyPaletteFlowData().options, count: 4, minDistance: 10 },
  });
  const run = (await generate(PALETTE_ID)).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['palette.json', 'report.md']);

  const palette = await outputPalette();
  assert.deepEqual(palette.colors.map((color) => color.hex), ['#cc3322', '#4a6fd4']);
  assert.deepEqual(palette.colors.map((color) => color.share), [0.75, 0.25]);
  assert.equal(palette.colors[0]!.count, 3, 'commonest first, and carrying its own count');
});

test('two colours the image has equally often come out in a fixed order', async () => {
  // A tie has to break the same way every run or the palette changes under you
  // for no reason anybody edited. It breaks on the hex.
  await setPalette({
    ...emptyPaletteFlowData(),
    histogram: histogram(imageHash(), counts(['#cc3322', 2], ['#4a6fd4', 2])),
    options: { ...emptyPaletteFlowData().options, count: 4, minDistance: 10 },
  });
  await generate(PALETTE_ID);
  const once = (await outputPalette()).colors.map((color) => color.hex);
  await generate(PALETTE_ID);
  assert.deepEqual((await outputPalette()).colors.map((color) => color.hex), once);
  assert.deepEqual(once, ['#4a6fd4', '#cc3322']);
});

test('the report says how the palette was arrived at, not just what it is', async () => {
  await setPalette({
    ...emptyPaletteFlowData(),
    histogram: histogram(imageHash()),
    options: { ...emptyPaletteFlowData().options, count: 4, minDistance: 10 },
  });
  await generate(PALETTE_ID);
  const report = await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${PALETTE_ID}/report.md`)
  ).text();

  assert.match(report, /## The palette/);
  assert.match(report, /`#cc3322`/);
  assert.match(report, /Minimum distance asked for: 10/);
  assert.match(report, /closest pair/i);
  assert.match(report, /OKLab/, 'because the distance numbers mean nothing without it');
  assert.match(report, /temperature 0 every entry is/, 'and what temperature did, which here is nothing');
});

test('a palette shorter than asked for warns instead of padding itself', async () => {
  const run = (await generate(PALETTE_ID)).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => /not 4/.test(warning)),
    run.warnings.join('; '),
  );
});

test('changing the image without recounting is refused rather than described wrongly', async () => {
  // The palette still holds the tally of the old picture, and its hash no longer
  // matches. Writing a palette from it would describe an image that is gone.
  await setPalette({
    ...emptyPaletteFlowData(),
    histogram: histogram('a-hash-from-some-other-image'),
  });
  const run = (await generate(PALETTE_ID)).runs[0]!;
  assert.deepEqual(run.outputs, []);
  assert.ok(
    run.warnings.some((warning) => /has changed since it was counted/.test(warning)),
    run.warnings.join('; '),
  );

  // And what the last good run wrote is still there, so an unrecounted image does
  // not empty a palette that downstream flows are reading.
  const palette = await outputPalette();
  assert.equal(palette.colors.length, 2);
});

test('counting at one precision and asking for another says which was used', async () => {
  await setPalette({
    ...emptyPaletteFlowData(),
    histogram: { ...histogram(imageHash()), precision: 3 },
    options: { ...emptyPaletteFlowData().options, precision: 6 },
  });
  const run = (await generate(PALETTE_ID)).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => /counted at 3 bits a channel but the setting is now 6/.test(warning)),
    run.warnings.join('; '),
  );
  assert.equal(run.outputs.length, 2, 'but it still writes a palette from what it has');
});

test('a flow with no image wired in warns, and clobbers nothing', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });

  const run = (await generate(PALETTE_ID)).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => /No image wired in/.test(warning)),
    run.warnings.join('; '),
  );
  const palette = await outputPalette();
  assert.equal(palette.colors.length, 2, 'the last good palette is still there');
});

test('the uploaded image really is a readable PNG', async () => {
  // The generator never decodes it, but the editor does, so a test that puts
  // nonsense on the port would pass while the studio could not open it.
  const design = project.nodes.find((node) => node.id === DESIGN_ID)!;
  const artifact = design.outputs.find((output) => output.port === 'design')!;
  const response = await fetch(`${base}/api/projects/${project.id}/files/${artifact.path}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 2, 'two pixels wide');
  assert.equal(bytes.readUInt32BE(20), 2, 'and two tall');
});
