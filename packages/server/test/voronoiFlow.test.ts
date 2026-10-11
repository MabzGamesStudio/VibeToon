import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-voronoi-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng } from './pngFixture';
import {
  decodePng,
  emptyImageFlowData,
  emptyVoronoiFlowData,
  readVectorImage,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type VoronoiFlowData,
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
const PAL = 'flow_palette';
const VOR = 'flow_voronoi';
let project: Project;

const RED: [number, number, number] = [220, 30, 30];
const BLUE: [number, number, number] = [30, 40, 220];
const CREAM: [number, number, number] = [240, 230, 200];
/** A red disc and a blue box on cream. */
const picture = Array.from({ length: 24 }, (_, y) =>
  Array.from({ length: 36 }, (_, x): [number, number, number] => ((x - 9) ** 2 + (y - 12) ** 2 < 36 ? RED : x > 20 && x < 32 && y > 4 && y < 18 ? BLUE : CREAM)),
);

const wire = (from: string, fromPort: string, toPort: string) => ({
  id: `w_${from}_${toPort}`,
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: VOR, portId: toPort },
  rules: '',
  settings: { enabled: true, mode: 'reference' as const, weight: 1, notes: '' },
});

async function generate(attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse['runs'][number]> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${VOR}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result.runs.find((run) => run.flowId === VOR) ?? result.runs[0]!;
}

async function file(name: string): Promise<Uint8Array> {
  const response = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${VOR}/${name}`);
  assert.equal(response.ok, true, `${name}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

async function setData(over: Partial<VoronoiFlowData>): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === VOR ? ({ ...node, data: { ...(node.data as VoronoiFlowData), ...over } } as FlowNode) : node)),
  });
}

async function upload(fileName: string, bytes: Uint8Array): Promise<void> {
  const result = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${IMG}/outputs/image`, {
    fileName,
    data: Buffer.from(bytes).toString('base64'),
  });
  project = result.project;
}

async function putPalette(body: unknown): Promise<void> {
  const dir = path.join(dataRoot, 'projects', project.id, 'artifacts', PAL);
  await mkdir(dir, { recursive: true });
  const content = `${JSON.stringify(body, null, 2)}\n`;
  await writeFile(path.join(dir, 'palette.json'), content, 'utf8');
  const result = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${PAL}/outputs/palette`, {
    fileName: 'palette.json',
    data: Buffer.from(content, 'utf8').toString('base64'),
  });
  project = result.project;
}

const pixelsOf = async (name: string) => decodePng(await file(name), (packed) => new Uint8Array(inflateSync(packed)));

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Voronoi', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: IMG, kind: 'art.image', name: 'Plate', position: { x: 0, y: 0 }, notes: '', data: emptyImageFlowData(), outputs: [] },
      {
        id: PAL,
        kind: 'art.palette',
        name: 'Palette',
        position: { x: 0, y: 200 },
        notes: '',
        data: { editor: 'palette', options: {}, histogram: null, edits: { changed: {}, removed: [], added: [] } } as unknown as FlowNode['data'],
        outputs: [],
      },
      { id: VOR, kind: 'art.voronoi', name: 'Cells', position: { x: 400, y: 0 }, notes: '', data: { ...emptyVoronoiFlowData(), nodes: 30, refine: 6 }, outputs: [] },
    ],
    connections: [],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('with nothing wired in, it says so and writes nothing', async () => {
  const run = await generate();
  assert.ok(run.warnings.some((line) => /No image wired in/.test(line)), run.warnings.join('; '));
  assert.equal(project.nodes.find((node) => node.id === VOR)!.outputs.length, 0);
});

test('a PNG is fitted on the server: the diagram, its nodes and the report', async () => {
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, connections: [wire(IMG, 'image', 'image')] });
  await upload('plate.png', encodePng(picture));
  const run = await generate();
  assert.equal(run.ok, true, run.error);
  assert.ok(run.log.some((line) => /Fitted here: 30 node\(s\), 6 round\(s\)/.test(line)), run.log.join('; '));
  const out = await pixelsOf('voronoi.png');
  assert.deepEqual([out.width, out.height], [36, 24]);
  const nodes = JSON.parse(text(await file('nodes.json')));
  assert.equal(nodes.kind, 'voronoi');
  assert.equal(nodes.nodes.length, 30);
  assert.equal(nodes.source, project.nodes.find((node) => node.id === IMG)!.outputs[0]!.hash);
  assert.match(text(await file('voronoi.md')), /A 36 × 24 picture as 30 node\(s\)/);
  const ports = project.nodes.find((node) => node.id === VOR)!.outputs.map((artifact) => artifact.port).sort();
  assert.deepEqual(ports, ['image', 'nodes', 'report'], 'a picture only: no shapes');
});

test('as shapes too: vector.json for the vector editor and an SVG, same-colored cells joined', async () => {
  await setData({ output: 'both', merge: true });
  const run = await generate();
  assert.equal(run.ok, true, run.error);
  const vector = readVectorImage(JSON.parse(text(await file('vector.json'))));
  assert.deepEqual([vector.width, vector.height], [36, 24]);
  assert.ok(vector.shapes.length >= 3 && vector.shapes.length < 30, `${vector.shapes.length} shape(s): fewer than the cells`);
  const svg = text(await file('voronoi.svg'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="36" height="24"/);
  assert.equal((svg.match(/<path /g) ?? []).length, vector.shapes.length);
  await setData({ merge: false });
  await generate();
  const cells = readVectorImage(JSON.parse(text(await file('vector.json'))));
  assert.ok(cells.shapes.length > vector.shapes.length, 'one per cell when not joined');
});

test('shapes only: the picture from before is taken away', async () => {
  await setData({ output: 'vector' });
  const run = await generate();
  assert.equal(run.ok, true, run.error);
  const ports = project.nodes.find((node) => node.id === VOR)!.outputs.map((artifact) => artifact.port).sort();
  assert.deepEqual(ports, ['nodes', 'report', 'svg', 'vector']);
  assert.match(text(await file('voronoi.md')), /As shapes: \d+ polygon\(s\), one per cell/);
});

test('with a palette wired in, every node takes one of its colors — unless told not to', async () => {
  await setData({ output: 'picture', merge: true });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, connections: [wire(IMG, 'image', 'image'), wire(PAL, 'palette', 'palette')] });
  await putPalette({ colors: [{ hex: '#ff0000' }, { hex: '#0000ff' }, { hex: '#ffffff' }] });
  const run = await generate();
  assert.equal(run.ok, true, run.error);
  const out = await pixelsOf('voronoi.png');
  const seen = new Set<string>();
  for (let p = 0; p < out.width * out.height; p += 1) seen.add(`${out.data[p * 4]},${out.data[p * 4 + 1]},${out.data[p * 4 + 2]}`);
  assert.deepEqual([...seen].sort(), ['0,0,255', '255,0,0', '255,255,255']);
  assert.deepEqual(JSON.parse(text(await file('nodes.json'))).settings.palette, ['#ff0000', '#0000ff', '#ffffff']);
  await setData({ usePalette: false });
  await generate();
  const free = await pixelsOf('voronoi.png');
  assert.ok(free.data[0] !== 255 || free.data[1] !== 255, 'its own colors: the cream, not white');
});

test('a picture the server cannot decode waits for the editor, then writes what it sends — the SVG made here', async () => {
  await setData({ output: 'both', usePalette: true });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, connections: [wire(IMG, 'image', 'image')] });
  await upload('plate.jpg', new TextEncoder().encode('not a png, standing in for a JPEG'));
  const waiting = await generate();
  assert.ok(waiting.warnings.some((line) => /not a PNG/.test(line)), waiting.warnings.join('; '));
  const nodes = { kind: 'voronoi', version: 1, width: 2, height: 1, source: null, settings: { nodes: 2, refine: 2, palette: null }, nodes: [{ x: 0.5, y: 0.5, color: '#ff0000', pixels: 1 }, { x: 1.5, y: 0.5, color: '#00ff00', pixels: 1 }] };
  const vector = { width: 2, height: 1, shapes: [{ id: 'cell-1', kind: 'polygon', color: '#ff0000', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, { id: 'bad', kind: 'polygon', color: 'not a color', points: [] }] };
  const json = (body: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(body)).toString('base64')}`;
  const run = await generate([
    { name: 'nodes.json', data: json(nodes) },
    { name: 'voronoi.png', data: `data:image/png;base64,${encodePng([[[255, 0, 0], [0, 255, 0]]]).toString('base64')}` },
    { name: 'vector.json', data: json(vector) },
    { name: 'voronoi.svg', data: `data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}` },
    { name: 'voronoi.md', data: `data:text/markdown;base64,${Buffer.from('# Voronoi diagram\n\nFrom the editor.\n').toString('base64')}` },
  ]);
  assert.equal(run.ok, true, run.error);
  assert.ok(run.log.some((line) => /Fitted in the editor: 2 node\(s\)/.test(line)), run.log.join('; '));
  assert.deepEqual([(await pixelsOf('voronoi.png')).width], [2]);
  assert.equal(readVectorImage(JSON.parse(text(await file('vector.json')))).shapes.length, 1, 'what could not be read is left out');
  const svg = text(await file('voronoi.svg'));
  assert.doesNotMatch(svg, /script/, 'the SVG is made from the shapes, not taken as sent');
  assert.match(svg, /fill="#ff0000"/);
  assert.match(text(await file('voronoi.md')), /From the editor/);
});

test('nodes the editor sent that are not a diagram’s are refused', async () => {
  const run = await generate([{ name: 'nodes.json', data: `data:application/json;base64,${Buffer.from('{"kind":"vector"}').toString('base64')}` }]);
  assert.ok(run.warnings.some((line) => /could not be read/.test(line)), run.warnings.join('; '));
  const missing = await generate([{ name: 'nodes.json', data: `data:application/json;base64,${Buffer.from(JSON.stringify({ kind: 'voronoi', width: 1, height: 1, nodes: [{ x: 0.5, y: 0.5, color: '#000000' }] })).toString('base64')}` }]);
  assert.ok(missing.warnings.some((line) => /no picture of the diagram/.test(line)), missing.warnings.join('; '));
});
