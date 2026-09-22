import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-pose-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  emptyPoseFlowData,
  emptyRigFlowData,
  type ArtifactRef,
  type BoundRig,
  type FlowNode,
  type GenerateResponse,
  type PoseFlowData,
  type Project,
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
const POSE = 'flow_pose';
let project: Project;
let sourceHash = '';

const image: VectorImage = {
  width: 60,
  height: 60,
  shapes: [
    { id: 'arm', kind: 'polygon', color: '#de2929', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }] },
    { id: 'loose', kind: 'polygon', color: '#2840dc', points: [{ x: 30, y: 30 }, { x: 36, y: 30 }, { x: 36, y: 36 }] },
  ],
};

const bound: BoundRig = { rig: emptyRigFlowData('human'), image, binding: { arm: 'left-upper-arm' } };

async function setPose(data: PoseFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === POSE ? ({ ...node, data } as FlowNode) : node)),
  });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${POSE}/generate`);
  project = result.project;
  return result;
}

const file = async (name: string) =>
  (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${POSE}/${name}`)).text();

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Pose', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      { id: BIND, kind: 'animation.bind', name: 'Bound', position: { x: 60, y: 60 }, notes: '', data: { editor: 'bind', rig: null, image: null, binding: {}, selected: [], boneId: null, edits: 0 } as unknown as FlowNode['data'], outputs: [] },
      { id: POSE, kind: 'animation.pose', name: 'Pose', position: { x: 440, y: 60 }, notes: '', data: emptyPoseFlowData(), outputs: [] },
    ],
    connections: [
      {
        id: 'w1',
        from: { nodeId: BIND, portId: 'bound' },
        to: { nodeId: POSE, portId: 'bound' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });
  const content = `${JSON.stringify(bound, null, 2)}\n`;
  const up = await api<{ project: Project; artifact: ArtifactRef }>(
    'POST',
    `/api/projects/${project.id}/flows/${BIND}/outputs/bound`,
    { fileName: 'bound.json', data: Buffer.from(content, 'utf8').toString('base64') },
  );
  project = up.project;
  sourceHash = up.artifact.hash;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a pose with nothing taken in warns rather than writing an empty drawing', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.outputs.length, 0);
  assert.ok(run.warnings.some((w) => /Nothing taken in to pose/.test(w)), run.warnings.join('; '));
});

test('a pose writes the angles and the drawing in them', async () => {
  await setPose({ ...emptyPoseFlowData(), bound, pose: { 'left-upper-arm': 40 }, sourceHash });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((o) => o.fileName).sort(), ['pose.json', 'pose.svg']);
});

test('the pose file holds the angles and where every bone ended up', async () => {
  const written = JSON.parse(await file('pose.json'));
  assert.equal(written.angles['left-upper-arm'], 40);
  const arm = written.bones.find((bone: { id: string }) => bone.id === 'left-upper-arm');
  assert.equal(arm.own, 40);
  assert.ok(arm.to && typeof arm.to.x === 'number', 'and where it points');

  // Everything below it inherited the turn.
  const forearm = written.bones.find((bone: { id: string }) => bone.id === 'left-forearm');
  assert.equal(forearm.angle, 40, 'its own turn plus the arm’s');
  assert.equal(forearm.own, 0);
});

test('the drawing moves with the bone it is bound to, and not otherwise', async () => {
  const svg = await file('pose.svg');
  assert.match(svg, /^<svg/);
  // The loose shape was drawn at 30,30 and is bound to nothing, so it is still there.
  assert.match(svg, /M 30 30/);
  // The bound one started at 0,0 and cannot still be there after a 40 degree turn.
  assert.ok(!/d="M 0 0 L 8 0/.test(svg), 'the bound shape did not move');
});

test('the rest pose is written too, and said to be the rest pose', async () => {
  await setPose({ ...emptyPoseFlowData(), bound, pose: {}, sourceHash });
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true);
  assert.ok(run.log.some((entry) => /rest pose/.test(entry)), run.log.join('; '));
});

test('angles for bones that are gone are ignored, and reported', async () => {
  await setPose({
    ...emptyPoseFlowData(),
    bound,
    pose: { 'left-upper-arm': 20, 'a-bone-that-was-deleted': 90 },
    sourceHash,
  });
  const run = (await generate()).runs[0]!;
  assert.ok(
    run.warnings.some((w) => /no longer in the rig, and were ignored/.test(w)),
    run.warnings.join('; '),
  );
  assert.ok(run.outputs.length > 0, 'and it still writes the pose');
});

test('a changed input is reported but the angles are kept', async () => {
  await setPose({ ...emptyPoseFlowData(), bound, pose: { 'left-upper-arm': 33 }, sourceHash: 'older' });
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((w) => /has changed since this pose was made/.test(w)), run.warnings.join('; '));
  assert.equal(JSON.parse(await file('pose.json')).angles['left-upper-arm'], 33);
});

test('nothing wired in is a warning about wiring', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });
  assert.ok((await generate()).runs[0]!.warnings.some((w) => /No bound rig wired in/.test(w)));
});
