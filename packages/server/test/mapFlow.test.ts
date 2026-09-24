import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-map-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  decodePng,
  emptyWorldMapFlowData,
  placeElement,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type WorldMapFlowData,
} from '@vibetoon/shared';
import { inflateSync } from 'node:zlib';

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

const ID = 'flow_map';
let project: Project;

function node(data: WorldMapFlowData): FlowNode {
  return { id: ID, kind: 'world.map', name: 'World Map', position: { x: 80, y: 80 }, notes: '', data, outputs: [] };
}

async function setData(data: WorldMapFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, nodes: [node(data)] });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${ID}/generate`);
  project = result.project;
  return result;
}

const file = async (name: string) => fetch(`${base}/api/projects/${project.id}/files/artifacts/${ID}/${name}`);

function sample(): WorldMapFlowData {
  let data = emptyWorldMapFlowData();
  data = placeElement(data, 'geo/region', 500, 500, { name: 'Northmarch' });
  data = placeElement(data, 'place/city', 505, 505, { name: 'Karth', description: 'A walled port.' });
  data = placeElement(data, 'geo/jetty', 506, 505, { name: 'Old Jetty' });
  return data;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Map flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, nodes: [node(sample())], connections: [] });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('the map writes its data, its places, a picture and notes', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['locations.json', 'map.json', 'map.md', 'map.png']);
  const map = (await (await file('map.json')).json()) as { settings: { seed: string }; elements: unknown[] };
  assert.equal(map.settings.seed, 'vibetoon');
  assert.ok(map.elements.length > 20, 'generated features and the placed ones');
});

test('locations carry the path of places they lie within, for a timeline to use', async () => {
  const { world, locations } = (await (await file('locations.json')).json()) as { world: string; locations: Array<{ name: string; kind: string; kindName: string; path: string[] }> };
  assert.equal(world, 'The World');
  const jetty = locations.find((location) => location.name === 'Old Jetty')!;
  assert.deepEqual(jetty.path, ['The World', 'Northmarch', 'Karth', 'Old Jetty']);
  assert.equal(jetty.kindName, 'Jetty');
  assert.ok(locations.some((location) => location.kind === 'place/city'));
});

test('the picture is the whole world at the map’s proportions', async () => {
  const bytes = new Uint8Array(await (await file('map.png')).arrayBuffer());
  const image = await decodePng(bytes, (data) => new Uint8Array(inflateSync(data)));
  assert.equal(image.width, 1200);
  assert.equal(image.height, 750);
});

test('the notes list places by kind, biggest kinds first, with descriptions', async () => {
  const doc = await (await file('map.md')).text();
  assert.match(doc, /^# The World/);
  assert.match(doc, /## City/);
  assert.match(doc, /\*\*Karth\*\* — Northmarch, 18 km\. A walled port\./);
  assert.ok(doc.indexOf('## Region') < doc.indexOf('## Jetty'), 'regions before jetties');
});

test('a map with nothing named says so', async () => {
  const data = emptyWorldMapFlowData();
  await setData({ ...data, elements: [] });
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((warning) => /Nothing on the map is named/.test(warning)));
});

