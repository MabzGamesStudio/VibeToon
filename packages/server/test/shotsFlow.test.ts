import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-shots-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { emptyShotsFlowData, type ArtifactRef, type FlowNode, type GenerateResponse, type Project, type ShotsFlowData } from '@vibetoon/shared';

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

const SHOTS = 'flow_shots';
let project: Project;
let videoHash = '';

async function setData(over: Partial<ShotsFlowData>): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === SHOTS ? ({ ...node, data: { ...emptyShotsFlowData(), ...over } } as FlowNode) : node)),
  });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${SHOTS}/generate`);
  project = result.project;
  return result;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Shots', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [{ id: SHOTS, kind: 'animation.video.shots', name: 'Shots', position: { x: 0, y: 0 }, notes: '', data: emptyShotsFlowData(), outputs: [] }],
    connections: [],
  });
  const uploaded = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${SHOTS}/outputs/source`, {
    fileName: 'film.mp4',
    data: Buffer.from('not really a video').toString('base64'),
  });
  project = uploaded.project;
  videoHash = uploaded.artifact.hash ?? '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('before the shots are found it says where to find them', async () => {
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /Find the shots/.test(line)), run.warnings.join('; '));
});

test('the shots are written as time segments and frames', async () => {
  await setData({
    video: { hash: videoHash, duration: 8, width: 640, height: 360 },
    cuts: [2, 5],
    detected: [
      { frame: 48, time: 2, difference: 0.9 },
      { frame: 120, time: 5, difference: 0.7 },
    ],
  });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.error);
  const file = (await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${SHOTS}/shots.json`)).json()) as {
    shots: Array<Record<string, number>>;
  };
  assert.equal(file.shots.length, 3);
  assert.deepEqual(file.shots[2], { index: 3, start: 5, end: 8, duration: 3, startFrame: 120, endFrame: 191 });
  const report = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${SHOTS}/shots.md`)).text();
  assert.match(report, /\| 2 \| 0:02\.00 \| 0:05\.00 \| 3\.00s \| 90% \|/);
  assert.ok(run.log.some((line) => /3 shot\(s\)/.test(line)), run.log.join('; '));
});

test('a changed video is noted, and the shots written as they are', async () => {
  await setData({ video: { hash: 'something-else', duration: 8, width: 640, height: 360 }, cuts: [4] });
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /video has changed/.test(line)), run.warnings.join('; '));
});

test('each shot as a video: the clips recorded in the editor go on the Shot clips port, a folder for a batch', async () => {
  await setData({ video: { hash: videoHash, duration: 8, width: 640, height: 360 }, cuts: [2, 5], clips: true });
  let run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((line) => /recorded as a video in the editor/.test(line)), run.warnings.join('; '));
  const webm = (text: string) => `data:video/webm;base64,${Buffer.from(text).toString('base64')}`;
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${SHOTS}/generate`, {
    attachments: ['one', 'two', 'three'].map((text, index) => ({ name: `shots/shot-0${index + 1}.webm`, data: webm(text) })),
  });
  project = result.project;
  run = result.runs[0]!;
  const clips = run.outputs.find((ref) => ref.port === 'clips')!;
  assert.equal(clips.kind, 'videoSet');
  assert.deepEqual(clips.entries, ['shot-01.webm', 'shot-02.webm', 'shot-03.webm']);
  assert.equal(Object.keys(clips.entryHashes ?? {}).length, 3, 'each clip with its own hash, to go on alone');
  assert.ok(run.log.some((line) => /3 shot clip\(s\) written/.test(line)), run.log.join('; '));
});
