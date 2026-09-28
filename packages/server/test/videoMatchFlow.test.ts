import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-videomatch-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  emptyRigFlowData,
  emptyVideoMatchFlowData,
  readRigAnimation,
  type ArtifactRef,
  type BoundRig,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type RigFit,
  type VideoFrame,
  type VideoMatchFlowData,
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

const RIG = 'flow_bound';
const MATCH = 'flow_video';
let project: Project;
let boundHash = '';
let videoHash = '';

const bound: BoundRig = { rig: emptyRigFlowData('human'), image: { width: 100, height: 100, shapes: [] }, points: {} };
const fit = (x: number): RigFit => ({ pivot: { x: 50, y: 50 }, x, y: 40, scale: 1.5, rotation: 0, angles: { [bound.rig.bones[1]!.id]: 20 }, sizes: {} });

async function setData(id: string, data: FlowNode['data']): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === id ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(id: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${id}/generate`);
  project = result.project;
  return result;
}

async function file(name: string): Promise<string> {
  return (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${MATCH}/${name}`)).text();
}

function matched(frames: VideoFrame[]): VideoMatchFlowData {
  return {
    ...emptyVideoMatchFlowData(),
    bound,
    boundHash,
    video: { hash: videoHash, duration: 2, width: 640, height: 360 },
    frameSize: { width: 480, height: 270 },
    sampling: { mode: 'fps', fps: 2, total: 4 },
    frames,
  };
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Video', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: RIG, kind: 'animation.bind', name: 'Binding', position: { x: 0, y: 0 }, notes: '', data: { editor: 'bind' }, outputs: [] },
      { id: MATCH, kind: 'animation.video.match', name: 'Through the video', position: { x: 400, y: 0 }, notes: '', data: emptyVideoMatchFlowData(), outputs: [] },
    ],
    connections: [
      {
        id: 'w1',
        from: { nodeId: RIG, portId: 'bound' },
        to: { nodeId: MATCH, portId: 'bound' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });
  // Stand-ins for the binding's file and an uploaded video: the generator reads neither's bytes.
  const rigUpload = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${RIG}/outputs/bound`, {
    fileName: 'bound.json',
    data: Buffer.from(JSON.stringify(bound)).toString('base64'),
  });
  boundHash = rigUpload.artifact.hash;
  const videoUpload = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${MATCH}/outputs/source`, {
    fileName: 'walk.mp4',
    data: Buffer.from('not really a video').toString('base64'),
  });
  project = videoUpload.project;
  videoHash = videoUpload.artifact.hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('nothing taken in: it says so and writes nothing', async () => {
  const run = (await generate(MATCH)).runs[0]!;
  assert.equal(run.outputs.filter((output) => output.port !== 'source').length, 0);
  assert.ok(run.warnings.some((warning) => /Take it in/.test(warning)), run.warnings.join('; '));
});

test('the frames matched become a rig animation, split where the body was not found', async () => {
  await setData(MATCH, matched([
    { time: 0, confidence: 0.8, fit: fit(100) },
    { time: 0.5, confidence: 0.7, fit: fit(110) },
    { time: 1, confidence: 0.05, fit: fit(0) },
    { time: 1.5, confidence: 0.9, fit: fit(140) },
  ]));
  const run = (await generate(MATCH)).runs[0]!;
  assert.equal(run.ok, true);
  assert.deepEqual(run.warnings, []);
  const animation = readRigAnimation(JSON.parse(await file('animation.json')))!;
  assert.equal(animation.segments.length, 2);
  assert.deepEqual(animation.segments.map((segment) => segment.keys.length), [2, 1]);
  assert.equal(animation.dropped, 1);
  assert.equal(animation.picture.width, 480);
  assert.equal(animation.segments[0]!.keys[1]!.placement.x, 110);
  assert.equal(animation.segments[0]!.keys[0]!.pose[bound.rig.bones[1]!.id], 20);
  const report = await file('animation.md');
  assert.match(report, /Dropped 1 frame/);
});

test('the uploaded video is kept through a generate', async () => {
  await generate(MATCH);
  const node = project.nodes.find((one) => one.id === MATCH)!;
  assert.ok(node.outputs.some((output) => output.port === 'source' && output.hash === videoHash));
});

test('frames left unmatched, or a changed sampling, are warned about but still written', async () => {
  await setData(MATCH, matched([{ time: 0, confidence: 0.8, fit: fit(100) }]));
  let run = (await generate(MATCH)).runs[0]!;
  assert.ok(run.warnings.some((warning) => /Not every frame/.test(warning)), run.warnings.join('; '));
  // At three a second there is no frame at 0.5s.
  await setData(MATCH, { ...matched([{ time: 0.5, confidence: 0.8, fit: fit(100) }]), sampling: { mode: 'fps', fps: 3, total: 4 } });
  run = (await generate(MATCH)).runs[0]!;
  assert.ok(run.warnings.some((warning) => /has changed/.test(warning)), run.warnings.join('; '));
  assert.ok(run.outputs.some((output) => output.fileName === 'animation.json'));
});

test('a body found nowhere writes an empty animation and says what to do', async () => {
  await setData(MATCH, matched([
    { time: 0, confidence: 0.1, fit: fit(100) },
    { time: 0.5, confidence: 0.1, fit: fit(100) },
    { time: 1, confidence: 0.1, fit: fit(100) },
    { time: 1.5, confidence: 0.1, fit: fit(100) },
  ]));
  const run = (await generate(MATCH)).runs[0]!;
  assert.ok(run.warnings.some((warning) => /not found in any frame/.test(warning)), run.warnings.join('; '));
  const animation = readRigAnimation(JSON.parse(await file('animation.json')))!;
  assert.equal(animation.segments.length, 0);
  assert.equal(animation.dropped, 4);
});
