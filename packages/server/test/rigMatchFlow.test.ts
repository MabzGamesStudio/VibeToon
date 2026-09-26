import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { deflateSync, inflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-rigmatch-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  bodyPivot,
  decodePng,
  emptyRigFlowData,
  emptyRigMatchFlowData,
  encodePng,
  fitSignature,
  fittedBones,
  readBoundRig,
  restPose,
  type ArtifactRef,
  type BoundRig,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type RigFit,
  type RigMatchFlowData,
  type VectorImage,
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

const BIND = 'flow_bind';
const IMAGE = 'flow_image';
const MATCH = 'flow_match';
let project: Project;
let boundHash = '';
let imageHash = '';

// A small body: a torso and an arm, each a block of color.
const rig = { ...emptyRigFlowData('human'), origin: { x: 50, y: 50 } };
const image: VectorImage = {
  width: 100,
  height: 100,
  shapes: [
    { id: 'torso', kind: 'polygon', color: '#d9483b', points: [{ x: 44, y: 20 }, { x: 56, y: 20 }, { x: 56, y: 52 }, { x: 44, y: 52 }] },
    { id: 'arm', kind: 'polygon', color: '#f1c6a0', points: [{ x: 38, y: 22 }, { x: 42, y: 22 }, { x: 42, y: 40 }, { x: 38, y: 40 }] },
  ],
};
const bound: BoundRig = {
  rig,
  image,
  points: { torso: ['chest', 'chest', 'spine', 'spine'], arm: ['left-upper-arm', 'left-upper-arm', 'left-upper-arm', 'left-upper-arm'] },
};
const fit: RigFit = { pivot: bodyPivot(bound), x: 80, y: 60, scale: 1.5, rotation: 10, angles: { 'left-upper-arm': 35 }, sizes: { 'left-upper-arm': 1.1 } };

function gray(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < width * height; at += 1) pixels.set([200, 200, 200, 255], at * 4);
  return pixels;
}

async function setMatch(data: RigMatchFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === MATCH ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${MATCH}/generate`);
  project = result.project;
  return result;
}

const file = (name: string) => fetch(`${base}/api/projects/${project.id}/files/artifacts/${MATCH}/${name}`);

async function upload(node: string, portId: string, fileName: string, bytes: Uint8Array): Promise<ArtifactRef> {
  const up = await api<{ project: Project; artifact: ArtifactRef }>('POST', `/api/projects/${project.id}/flows/${node}/outputs/${portId}`, {
    fileName,
    data: Buffer.from(bytes).toString('base64'),
  });
  project = up.project;
  return up.artifact;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Rig match', template: 'empty' });
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
      { id: BIND, kind: 'animation.bind', name: 'Bound', position: { x: 60, y: 60 }, notes: '', data: { editor: 'bind', rig: null, image: null, nodes: {}, selected: [], boneId: null, edits: 0 } as unknown as FlowNode['data'], outputs: [] },
      { id: IMAGE, kind: 'art.image', name: 'Picture', position: { x: 60, y: 300 }, notes: '', data: { editor: 'image', source: null, description: '', credit: '' } as unknown as FlowNode['data'], outputs: [] },
      { id: MATCH, kind: 'animation.match', name: 'Rig Match', position: { x: 440, y: 60 }, notes: '', data: emptyRigMatchFlowData(), outputs: [] },
    ],
    connections: [wire('w1', BIND, 'bound', MATCH, 'bound'), wire('w2', IMAGE, 'image', MATCH, 'image')],
  });
  boundHash = (await upload(BIND, 'bound', 'bound.json', Buffer.from(`${JSON.stringify(bound)}\n`, 'utf8'))).hash;
  const png = await encodePng({ width: 160, height: 120, data: new Uint8ClampedArray(gray(160, 120)) }, (raw) => new Uint8Array(deflateSync(raw)));
  imageHash = (await upload(IMAGE, 'image', 'picture.png', png)).hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('with nothing taken in, or nothing matched, it says what to do rather than writing', async () => {
  let run = (await generate()).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((warning) => /Take it in/.test(warning)), run.warnings.join('; '));
  await setMatch({ ...emptyRigMatchFlowData(), bound, boundHash });
  run = (await generate()).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((warning) => /Match/.test(warning)), run.warnings.join('; '));
});

test('a match writes its numbers, the fitted rig, the drawing and an overlay', async () => {
  await setMatch({
    ...emptyRigMatchFlowData(),
    bound,
    boundHash,
    imageHash,
    picture: { width: 160, height: 120 },
    fit,
    report: {
      confidence: 0.72,
      parts: { chest: { confidence: 0.8, similarity: 0.9, features: 4 }, 'left-upper-arm': { confidence: 0.1, similarity: 0.3, features: 3 } },
      features: [],
      rigFeatures: 7,
      imageFeatures: 900,
      agreeing: 5,
      ms: 1200,
      at: '2026-09-26T10:00:00.000Z',
      forFit: fitSignature(fit),
      notes: [],
    },
  });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['fitted.json', 'fitted.svg', 'match.json', 'overlay.png']);
  assert.ok(run.warnings.some((warning) => /Left Upper Arm|left upper arm/i.test(warning)), 'a part found weakly is named');
});

test('the match file holds the placement, the pose, each part’s size, place and confidence', async () => {
  const match = (await (await file('match.json')).json()) as {
    placement: { x: number; scale: number; rotation: number };
    pose: Record<string, number>;
    confidence: number;
    confidenceIsForThisFit: boolean;
    parts: Array<{ id: string; angle: number; size: number; confidence: number | null; to: { x: number; y: number } }>;
  };
  assert.equal(match.placement.x, 80);
  assert.equal(match.placement.rotation, 10);
  assert.deepEqual(match.pose, { 'left-upper-arm': 35 });
  assert.equal(match.confidence, 0.72);
  assert.equal(match.confidenceIsForThisFit, true);
  const arm = match.parts.find((part) => part.id === 'left-upper-arm')!;
  assert.equal(arm.size, 1.1);
  const placed = fittedBones(rig, fit).get('left-upper-arm')!;
  assert.ok(Math.abs(arm.to.x - placed.to.x) < 0.01);
  assert.equal(match.parts.find((part) => part.id === 'head')!.confidence, null);
});

test('the fitted rig reads back as a bound rig whose rest pose is the match', async () => {
  const fitted = readBoundRig(await (await file('fitted.json')).json());
  assert.ok(fitted);
  const placed = fittedBones(rig, fit);
  for (const [id, place] of restPose(fitted!.rig)) {
    assert.ok(Math.abs(place.to.x - placed.get(id)!.to.x) < 1e-6 && Math.abs(place.to.y - placed.get(id)!.to.y) < 1e-6, id);
  }
  assert.equal(fitted!.image.width, 160);
});

test('the overlay is the picture with the body over it', async () => {
  const bytes = new Uint8Array(await (await file('overlay.png')).arrayBuffer());
  const overlay = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
  assert.equal(overlay.width, 160);
  assert.equal(overlay.height, 120);
  const torso = placedPixel(fittedBones(rig, fit).get('chest')!.to);
  const pixel = (x: number, y: number) => [...overlay.data.slice((y * 160 + x) * 4, (y * 160 + x) * 4 + 3)];
  assert.notDeepEqual(pixel(torso.x, torso.y), [200, 200, 200], 'the body is drawn where the chest is');
  assert.deepEqual(pixel(2, 2), [200, 200, 200], 'and the picture is untouched away from it');
});

function placedPixel(point: { x: number; y: number }) {
  return { x: Math.round(point.x), y: Math.round(point.y + 4) };
}

test('a picture that has changed since the match is flagged, and a JPEG picture gets no overlay', async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const before = project.nodes.find((node) => node.id === MATCH)!.outputs.find((output) => output.port === 'overlay')!;
  await upload(IMAGE, 'image', 'picture.jpg', jpeg);
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((warning) => /changed since this match/.test(warning)), run.warnings.join('; '));
  assert.ok(run.warnings.some((warning) => /only drawn over a PNG/.test(warning)), run.warnings.join('; '));
  // Not drawn again: what is on the port is the earlier one, as with any output a run leaves out.
  const after = project.nodes.find((node) => node.id === MATCH)!.outputs.find((output) => output.port === 'overlay')!;
  assert.equal(after.generatedAt, before.generatedAt);
});
