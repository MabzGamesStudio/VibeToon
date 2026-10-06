import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-foreground-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import { encodePng } from './pngFixture';
import {
  batchItems,
  createConnection,
  emptyCharacterSplitFlowData,
  emptyImageFlowData,
  emptyVideoBackgroundFlowData,
  emptyVideoForegroundFlowData,
  emptyVideoSourceFlowData,
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

const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const SRC = 'flow_src';
const IMG = 'flow_img';
const FG = 'flow_fg';
const CS = 'flow_cs';
const NEXT = 'flow_next';
let project: Project;

const node = (id: string, kind: string, name: string, data: unknown) => ({ id, kind, name, position: { x: 0, y: 0 }, notes: '', data, outputs: [] });
const png = (rgb: [number, number, number]) => `data:image/png;base64,${encodePng([[rgb, rgb], [rgb, rgb]]).toString('base64')}`;
const text = (body: string, type = 'text/markdown') => `data:${type};base64,${Buffer.from(body).toString('base64')}`;

async function generate(flowId: string, attachments?: Array<{ name: string; data: string }>): Promise<GenerateResponse['runs'][number]> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flowId}/generate`, attachments ? { attachments } : undefined);
  project = result.project;
  return result.runs.find((run) => run.flowId === flowId) ?? result.runs[0]!;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Characters', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      node(SRC, 'animation.video.source', 'Clip', emptyVideoSourceFlowData()),
      node(IMG, 'art.image', 'Plate', emptyImageFlowData()),
      node(FG, 'art.video.foreground', 'Foreground', emptyVideoForegroundFlowData()),
      node(CS, 'art.video.characters', 'Characters', emptyCharacterSplitFlowData()),
      node(NEXT, 'art.video.background', 'Per character', emptyVideoBackgroundFlowData()),
    ],
    connections: [
      createConnection({ nodeId: FG, portId: 'frames' }, { nodeId: CS, portId: 'frames' }),
      createConnection({ nodeId: CS, portId: 'characters' }, { nodeId: NEXT, portId: 'video' }),
    ],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('Video Foreground with no video, or no background, says which is missing', async () => {
  let run = await generate(FG);
  assert.ok(run.warnings.some((line) => /No video/.test(line)), run.warnings.join('; '));
  project = (await api<{ project: Project }>('POST', `/api/projects/${project.id}/flows/${SRC}/outputs/video`, { fileName: 'clip.mp4', data: Buffer.from(MP4).toString('base64') })).project;
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, connections: [...project.connections, createConnection({ nodeId: SRC, portId: 'video' }, { nodeId: FG, portId: 'video' })] });
  run = await generate(FG);
  assert.ok(run.warnings.some((line) => /No background/.test(line)), run.warnings.join('; '));
});

test('with both but nothing from the editor, it says where the work is done', async () => {
  project = (await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${IMG}/outputs/image`, { fileName: 'plate.png', data: png([90, 90, 90]) })).project;
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, connections: [...project.connections, createConnection({ nodeId: IMG, portId: 'image' }, { nodeId: FG, portId: 'background' })] });
  const run = await generate(FG);
  assert.ok(run.warnings.some((line) => /taken apart in the editor/.test(line)), run.warnings.join('; '));
});

test('the frames the editor sends are written as a folder, with the frame list and the report', async () => {
  const run = await generate(FG, [
    { name: 'frames/frame-0001-at-0.000s.png', data: png([200, 30, 30]) },
    { name: 'frames/frame-0002-at-0.500s.png', data: png([30, 30, 200]) },
    { name: 'foreground.json', data: text('{"kind":"foreground"}\n', 'application/json') },
    { name: 'foreground.md', data: text('# Foreground\n\nTwo frames.\n') },
  ]);
  assert.equal(run.ok, true, run.error);
  const fg = project.nodes.find((one) => one.id === FG)!;
  assert.deepEqual(fg.outputs.map((ref) => ref.port).sort(), ['data', 'frames', 'report']);
  const frames = fg.outputs.find((ref) => ref.port === 'frames')!;
  assert.equal(frames.kind, 'imageSet');
  assert.deepEqual(frames.entries, ['frame-0001-at-0.000s.png', 'frame-0002-at-0.500s.png']);
  assert.ok(run.log.some((line) => /2 frame\(s\)/.test(line)), run.log.join('; '));
});

test('Character Split with the frames but nothing from the editor says where the work is done', async () => {
  const run = await generate(CS);
  assert.ok(run.warnings.some((line) => /found in the editor/.test(line)), run.warnings.join('; '));
});

test('the characters the editor sends are written, and their clips go on as a batch of the characters', async () => {
  const run = await generate(CS, [
    { name: 'characters/character-1.webm', data: `data:video/webm;base64,${Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]).toString('base64')}` },
    { name: 'characters/character-2.webm', data: `data:video/webm;base64,${Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 1, 1, 1]).toString('base64')}` },
    { name: 'sheets/character-1.png', data: png([200, 30, 30]) },
    { name: 'sheets/character-2.png', data: png([30, 30, 200]) },
    { name: 'frames/character-1-frame-0001-at-0.000s.png', data: png([200, 30, 30]) },
    { name: 'frames/character-2-frame-0002-at-0.500s.png', data: png([30, 30, 200]) },
    { name: 'characters.json', data: text('{"kind":"characters","characters":[{},{}]}\n', 'application/json') },
    { name: 'characters.md', data: text('# Characters\n\nTwo.\n') },
  ]);
  assert.equal(run.ok, true, run.error);
  const cs = project.nodes.find((one) => one.id === CS)!;
  assert.deepEqual(cs.outputs.map((ref) => ref.port).sort(), ['characters', 'frames', 'list', 'report', 'sheets']);
  assert.equal(cs.outputs.find((ref) => ref.port === 'characters')!.kind, 'videoSet');
  const items = batchItems(project, project.nodes.find((one) => one.id === NEXT)!);
  assert.deepEqual(items.map((item) => item.key), ['character-1.webm', 'character-2.webm'], 'one item per character');
});
