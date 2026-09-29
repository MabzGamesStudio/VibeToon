import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-lines-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng } from './pngFixture';
import {
  decodePng,
  emptyImageFlowData,
  emptyLinesFlowData,
  type ArtifactRef,
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

const IMG = 'flow_img';
const LINES = 'flow_lines';
let project: Project;

async function generate(attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${LINES}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result;
}

async function file(name: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${LINES}/${name}`)).arrayBuffer());
}

async function upload(fileName: string, bytes: Uint8Array): Promise<void> {
  const result = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${IMG}/outputs/image`, {
    fileName,
    data: Buffer.from(bytes).toString('base64'),
  });
  project = result.project;
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Lines', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: IMG, kind: 'art.image', name: 'Sketch', position: { x: 0, y: 0 }, notes: '', data: emptyImageFlowData(), outputs: [] },
      { id: LINES, kind: 'art.lines', name: 'Lines', position: { x: 400, y: 0 }, notes: '', data: emptyLinesFlowData(), outputs: [] },
    ],
    connections: [
      { id: 'w1', from: { nodeId: IMG, portId: 'image' }, to: { nodeId: LINES, portId: 'image' }, rules: '', settings: { enabled: true, mode: 'reference', weight: 1, notes: '' } },
    ],
  });
  // A black stroke two pixels wide down a white page.
  await upload('sketch.png', encodePng(Array.from({ length: 30 }, () => Array.from({ length: 30 }, (_, x) => (x === 14 || x === 15 ? BLACK : WHITE)))));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('the lines are written black, with red where the stroke is', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const out = await decodePng(await file('lines.png'), (packed) => new Uint8Array(inflateSync(packed)));
  assert.deepEqual([out.width, out.height], [30, 30]);
  assert.deepEqual(Array.from(out.data.slice(0, 4)), [0, 0, 0, 255]);
  const on = (15 * 30 + 14) * 4;
  assert.ok(out.data[on]! > 0);
  assert.equal(out.data[on + 1], 0);
  assert.ok(run.log.some((line) => /60 line pixels/.test(line)), run.log.join('; '));
});

test('the report gives the settings and what was found', async () => {
  const report = Buffer.from(await file('lines.md')).toString('utf8');
  assert.match(report, /Found in \*\*Sketch\*\*/);
  assert.match(report, /Longer than wide by \| ×3/);
});

test('a picture the server cannot decode waits for the editor, then takes what it sends', async () => {
  await upload('sketch.jpg', new TextEncoder().encode('not a png, standing in for a JPEG'));
  const waiting = (await generate()).runs[0]!;
  assert.ok(waiting.warnings.some((line) => /not a PNG/.test(line)), waiting.warnings.join('; '));
  const png = encodePng([[BLACK, [255, 0, 0]]]);
  const run = (await generate([{ name: 'lines.png', data: `data:image/png;base64,${png.toString('base64')}` }])).runs[0]!;
  assert.equal(run.ok, true);
  const out = await decodePng(await file('lines.png'), (packed) => new Uint8Array(inflateSync(packed)));
  assert.equal(out.width, 2);
});
