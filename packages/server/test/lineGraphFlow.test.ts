import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-linegraph-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng } from './pngFixture';
import {
  emptyImageFlowData,
  emptyLineGraphFlowData,
  emptyLinesFlowData,
  graphBasis,
  type FlowNode,
  type GenerateResponse,
  type LineGraphFlowData,
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

const IMG = 'flow_img';
const LINES = 'flow_lines';
const GRAPH = 'flow_graph';
let project: Project;

async function setGraph(over: Partial<LineGraphFlowData>): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === GRAPH ? ({ ...node, data: { ...emptyLineGraphFlowData(), ...over } } as FlowNode) : node)),
  });
}

async function generate(flow: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flow}/generate`);
  project = result.project;
  return result;
}

async function graphFile(): Promise<{ nodes: unknown[]; edges: Array<{ id: string; width: number }> }> {
  return (await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${GRAPH}/graph.json`)).json()) as never;
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Line graph', template: 'empty' });
  const wire = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({
    id,
    from: { nodeId: from, portId: fromPort },
    to: { nodeId: to, portId: toPort },
    rules: '',
    settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
  });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: IMG, kind: 'art.image', name: 'Drawing', position: { x: 0, y: 0 }, notes: '', data: emptyImageFlowData(), outputs: [] },
      { id: LINES, kind: 'art.lines', name: 'Lines', position: { x: 300, y: 0 }, notes: '', data: { ...emptyLinesFlowData(), options: { ...emptyLinesFlowData().options, maxWidth: 12 } }, outputs: [] },
      { id: GRAPH, kind: 'art.lines.graph', name: 'Graph', position: { x: 600, y: 0 }, notes: '', data: emptyLineGraphFlowData(), outputs: [] },
    ],
    connections: [wire('w1', IMG, 'image', LINES, 'image'), wire('w2', LINES, 'image', GRAPH, 'lines')],
  });
  // A thin stroke across the top and a wide one across the bottom.
  const drawing = encodePng(
    Array.from({ length: 60 }, (_, y) => Array.from({ length: 80 }, (_, x) => (x >= 10 && x < 70 && ((y >= 14 && y < 16) || (y >= 38 && y < 46)) ? BLACK : WHITE))),
  );
  project = (await api<{ project: Project }>('POST', `/api/projects/${project.id}/flows/${IMG}/outputs/image`, { fileName: 'drawing.png', data: drawing.toString('base64') })).project;
  await generate(LINES);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('the lines a Line Detection found are traced into a graph, a vector drawing and an SVG', async () => {
  const run = (await generate(GRAPH)).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const graph = await graphFile();
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes.length, 4);
  const vector = (await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${GRAPH}/vector.json`)).json()) as { shapes: Array<{ kind: string }> };
  assert.equal(vector.shapes.length, 2);
  assert.equal(vector.shapes[0]!.kind, 'line');
  const svg = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${GRAPH}/lines.svg`)).text();
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2);
});

test('the width range keeps only the lines as wide as asked', async () => {
  await setGraph({ widthRange: { min: 5, max: 16 } });
  await generate(GRAPH);
  const graph = await graphFile();
  assert.equal(graph.edges.length, 1);
  assert.ok(graph.edges[0]!.width > 5);
  const report = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${GRAPH}/graph.md`)).text();
  assert.match(report, /Left out by width \(keeping 5–16\+ px\): 1/);
});

test('a line taken out by hand stays out, while the edits fit the tracing', async () => {
  await setGraph({});
  await generate(GRAPH);
  const all = await graphFile();
  const lines = project.nodes.find((node) => node.id === LINES)!.outputs.find((ref) => ref.port === 'image')!;
  const basis = graphBasis(lines.hash, emptyLineGraphFlowData().options);
  await setGraph({ hidden: [all.edges[0]!.id], basis });
  await generate(GRAPH);
  assert.equal((await graphFile()).edges.length, 1);

  // Traced differently, the ids no longer match: the edit is set aside, not misapplied.
  await setGraph({ hidden: [all.edges[0]!.id], basis: 'another picture' });
  const run = (await generate(GRAPH)).runs[0]!;
  assert.ok(run.warnings.some((line) => /set aside/.test(line)), run.warnings.join('; '));
  assert.equal((await graphFile()).edges.length, 2);
});
