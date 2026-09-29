import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-background-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng } from './pngFixture';
import { emptyVideoBackgroundFlowData, type ArtifactRef, type GenerateResponse, type Project } from '@vibetoon/shared';

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

const BG = 'flow_bg';
let project: Project;

async function generate(attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${BG}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Background', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [{ id: BG, kind: 'art.video.background', name: 'Background', position: { x: 0, y: 0 }, notes: '', data: emptyVideoBackgroundFlowData(), outputs: [] }],
    connections: [],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('with no video it says so', async () => {
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /No video/.test(line)), run.warnings.join('; '));
});

test('with a video but nothing from the editor, it says where the work is done', async () => {
  const uploaded = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${BG}/outputs/source`, {
    fileName: 'clip.mp4',
    data: Buffer.from('not really a video').toString('base64'),
  });
  project = uploaded.project;
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /worked out in the editor/.test(line)), run.warnings.join('; '));
});

test('the background the editor sends is written, with its report, and the video stays', async () => {
  const png = encodePng([[[120, 120, 120], [120, 120, 120]]]);
  const report = Buffer.from('# Background\n\nSomething held still.\n');
  const run = (await generate([
    { name: 'background.png', data: `data:image/png;base64,${png.toString('base64')}` },
    { name: 'background.md', data: `data:text/markdown;base64,${report.toString('base64')}` },
  ])).runs[0]!;
  assert.equal(run.ok, true, run.error);
  assert.ok(run.log.some((line) => /2 × 1/.test(line)), run.log.join('; '));
  const node = project.nodes.find((one) => one.id === BG)!;
  assert.deepEqual(node.outputs.map((ref) => ref.port).sort(), ['image', 'report', 'source']);
  const written = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${BG}/background.md`)).text();
  assert.match(written, /Something held still/);
});
