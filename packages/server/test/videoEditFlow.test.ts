import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-videoedit-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  emptyVideoEditFlowData,
  splitSegmentAt,
  toggleSegment,
  type ArtifactRef,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type VideoEditFlowData,
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

const EDIT = 'flow_edit';
let project: Project;
let videoHash = '';

async function setData(data: VideoEditFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === EDIT ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${EDIT}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result;
}

const webm = (text: string) => `data:video/webm;base64,${Buffer.from(text).toString('base64')}`;

/** A 10s video split at 2s and 6s, with the middle deleted. */
function cut(output: VideoEditFlowData['output']): VideoEditFlowData {
  const base: VideoEditFlowData = { ...emptyVideoEditFlowData(), video: { hash: videoHash, duration: 10, width: 640, height: 360 }, fps: 25, output };
  return toggleSegment(splitSegmentAt(splitSegmentAt(base, 2), 6), 1);
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Video edit', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [{ id: EDIT, kind: 'animation.video.edit', name: 'Edit', position: { x: 0, y: 0 }, notes: '', data: emptyVideoEditFlowData(), outputs: [] }],
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

test('the edit is written even before anything is recorded, and says where to record it', async () => {
  const uploaded = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${EDIT}/outputs/source`, {
    fileName: 'film.webm',
    data: Buffer.from('not really a video').toString('base64'),
  });
  project = uploaded.project;
  videoHash = uploaded.artifact.hash ?? '';
  await setData(cut('joined'));
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /recorded in the editor/.test(line)), run.warnings.join('; '));
  const edit = (await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${EDIT}/edit.json`)).json()) as { keep: unknown[]; deleted: unknown[]; duration: number };
  assert.deepEqual(edit.keep, [
    { start: 0, end: 2 },
    { start: 6, end: 10 },
  ]);
  assert.deepEqual(edit.deleted, [{ start: 2, end: 6 }]);
  assert.equal(edit.duration, 6);
});

test('one video: what the editor recorded goes on the Edited video port', async () => {
  const run = (await generate([{ name: 'edited.webm', data: webm('the kept segments') }])).runs[0]!;
  assert.equal(run.ok, true, run.error);
  assert.deepEqual(run.warnings, []);
  const written = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${EDIT}/edited.webm`)).text();
  assert.equal(written, 'the kept segments');
  assert.ok(run.log.some((line) => /0:10\.00 → 0:06\.00 · 2 of 3 segment\(s\) kept · one video/.test(line)), run.log.join('; '));
});

test('a clip each: the clips go in a folder on the Clips port', async () => {
  await setData(cut('clips'));
  const run = (await generate([
    { name: 'clips/clip-01.webm', data: webm('first') },
    { name: 'clips/clip-02.webm', data: webm('second') },
  ])).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const clips = project.nodes.find((node) => node.id === EDIT)!.outputs.find((ref) => ref.port === 'clips')!;
  assert.equal(clips.kind, 'videoSet');
  assert.deepEqual(clips.entries, ['clip-01.webm', 'clip-02.webm']);
  const second = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${EDIT}/clips/clip-02.webm`)).text();
  assert.equal(second, 'second');
});

test('everything deleted leaves just the edit, and a changed video is noted', async () => {
  const all = toggleSegment(toggleSegment(cut('joined'), 0), 2);
  await setData({ ...all, video: { ...all.video!, hash: 'another-video' } });
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /Every segment is deleted/.test(line)), run.warnings.join('; '));
  assert.ok(run.warnings.some((line) => /video has changed/.test(line)), run.warnings.join('; '));
});
