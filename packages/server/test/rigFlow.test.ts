import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-rig-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  emptyBriefData,
  emptyRigFlowData,
  requireFlowKind,
  setBoneLimits,
  setChain,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type RigFlowData,
  type RigKind,
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

const SPEC_ID = 'flow_spec';
const RIG_ID = 'flow_rig';
let project: Project;

function rigNode(data: RigFlowData): FlowNode {
  return {
    id: RIG_ID,
    kind: 'animation.rig',
    name: 'Skeletal Rig',
    position: { x: 440, y: 80 },
    notes: '',
    data,
    outputs: [],
  };
}

async function setRig(data: RigFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === RIG_ID ? rigNode(data) : node)),
  });
}

async function generate(flowId: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flowId}/generate`);
  project = result.project;
  return result;
}

interface WrittenRig {
  kind: RigKind;
  chains: Array<{ id: string; floppiness: number; bones: string[] }>;
  bones: Array<{
    id: string;
    parent?: string;
    length: number;
    rest?: { from: { x: number; y: number }; to: { x: number; y: number } };
    angles: { min: number; max: number; stiffness: number };
    stretch: { min: number; max: number; stiffness: number };
    chain?: string;
    anglesFrom?: string;
  }>;
}

async function outputRig(): Promise<WrittenRig> {
  const response = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${RIG_ID}/rig.json`);
  assert.equal(response.ok, true);
  return (await response.json()) as WrittenRig;
}

async function outputDoc(): Promise<string> {
  return (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${RIG_ID}/rig.md`)).text();
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Rig flow', template: 'empty' });
  const brief = requireFlowKind('animation.style');
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: SPEC_ID,
        kind: 'animation.style',
        name: 'Style',
        position: { x: 80, y: 80 },
        notes: '',
        data: {
          ...emptyBriefData(brief),
          fields: { ...emptyBriefData(brief).fields, line: 'Thick, wobbly, hand drawn.' },
        },
        outputs: [],
      },
      rigNode(emptyRigFlowData('human')),
    ],
    connections: [],
  });
  await generate(SPEC_ID);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- what it writes ---------------- */

test('a rig with nothing wired in still writes a skeleton', async () => {
  const run = (await generate(RIG_ID)).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['rig.json', 'rig.md']);
  assert.deepEqual(run.warnings, [], 'the default human rig has nothing wrong with it');

  const rig = await outputRig();
  assert.equal(rig.kind, 'human');
  assert.ok(rig.bones.length > 15, `${rig.bones.length} bones`);
  assert.ok(rig.bones.every((bone) => bone.length > 0 || !bone.parent));
});

test('every bone is written with its place in the rest pose worked out', async () => {
  const rig = await outputRig();
  const byId = new Map(rig.bones.map((bone) => [bone.id, bone]));

  // A consumer should not have to walk the hierarchy to find out where a bone is,
  // so the resolved positions go in the file.
  for (const bone of rig.bones) {
    assert.ok(bone.rest, `${bone.id} has no resolved position`);
    if (!bone.parent) continue;
    assert.deepEqual(bone.rest!.from, byId.get(bone.parent)!.rest!.to, `${bone.id} is not attached`);
  }
  assert.deepEqual(byId.get('hips')!.rest!.from, { x: 0, y: 0 });
});

test('limits are resolved before they are written, and say where they came from', async () => {
  await setRig(emptyRigFlowData('octopus'));
  await generate(RIG_ID);
  const rig = await outputRig();

  const arm = rig.bones.filter((bone) => bone.chain === 'arm-1');
  assert.equal(arm.length, 5);
  // Nothing downstream should have to know that a tentacle's angles live on its
  // chain in order to find out how far its third joint bends.
  assert.ok(arm.every((bone) => bone.angles.max > 0), JSON.stringify(arm.map((bone) => bone.angles)));
  assert.ok(arm.every((bone) => bone.anglesFrom === 'the Arm 1 chain'));
  assert.equal(rig.chains.length, 8);

  // And the chain itself is in the file, so a number can be changed in the right
  // place rather than eight times.
  assert.equal(rig.chains.find((chain) => chain.id === 'arm-1')!.bones.length, 5);
});

test('the rig’s own multipliers are baked into what is written', async () => {
  const plain = emptyRigFlowData('human');
  await setRig(plain);
  await generate(RIG_ID);
  const before = (await outputRig()).bones.find((bone) => bone.id === 'left-forearm')!;

  await setRig({ ...plain, options: { ...plain.options, squashAndStretch: 3, looseness: 0.5 } });
  await generate(RIG_ID);
  const after = (await outputRig()).bones.find((bone) => bone.id === 'left-forearm')!;

  assert.ok(after.stretch.max > before.stretch.max, `${after.stretch.max} vs ${before.stretch.max}`);
  assert.equal(after.angles.max, before.angles.max * 0.5);
  assert.equal(after.angles.min, 0, 'and an elbow still only bends one way');
});

test('the notes explain what the numbers mean, not just what they are', async () => {
  await setRig(emptyRigFlowData('quadruped'));
  await generate(RIG_ID);
  const doc = await outputDoc();

  assert.match(doc, /Character type: \*\*Quadruped\*\*/);
  assert.match(doc, /## Bones/);
  assert.match(doc, /`left-rear-upper`/);
  assert.match(doc, /## Chains/, 'a quadruped has a tail');
  assert.match(doc, /Floppiness/);
  assert.match(doc, /## What the numbers mean/);
  assert.match(doc, /hard stop/, 'because a range and a stiffness are different things');
  assert.match(doc, /pulls back to/);
});

/* ---------------- problems ---------------- */

test('a joint whose rest pose is outside its own range is reported, not written silently', async () => {
  // The one that wastes an afternoon: the character starts the shot already out of
  // bounds and nothing says so.
  const broken = setBoneLimits(emptyRigFlowData('human'), 'spine', {
    angles: { min: 20, max: 40, stiffness: 0.5 },
  });
  await setRig(broken);
  const run = (await generate(RIG_ID)).runs[0]!;

  assert.ok(
    run.warnings.some((warning) => /spine: its rest pose is outside its own range/.test(warning)),
    run.warnings.join('; '),
  );
  assert.equal(run.outputs.length, 2, 'and it still writes the rig, because a broken rig is worth reading');
  assert.match(await outputDoc(), /## Problems/);
});

test('a welded chain comes out welded rather than quietly loose', async () => {
  let data = emptyRigFlowData('octopus');
  for (const chain of data.chains) data = setChain(data, chain.id, { floppiness: 0 });
  await setRig(data);
  await generate(RIG_ID);

  const rig = await outputRig();
  const chained = rig.bones.filter((bone) => bone.chain);
  assert.equal(chained.length, 40);
  assert.ok(chained.every((bone) => bone.angles.max === 0 && bone.angles.stiffness === 1));
  assert.match(await outputDoc(), /Joints that cannot move: 40/);
});

/* ---------------- what is wired in ---------------- */

test('a spec wired in is quoted as context, and the rig is not derived from it', async () => {
  const withoutSpec = await outputRig();

  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    connections: [
      {
        id: 'c1',
        from: { nodeId: SPEC_ID, portId: 'style' },
        to: { nodeId: RIG_ID, portId: 'spec' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });
  await generate(RIG_ID);

  const doc = await outputDoc();
  assert.match(doc, /## The spec this was rigged against/);
  assert.match(doc, /> /, 'quoted rather than inlined');
  assert.match(doc, /wobbly/, 'and it is the spec that was actually wired in');

  // The skeleton comes from the character type. A spec cannot change it, and
  // should not appear to.
  const withSpec = await outputRig();
  assert.deepEqual(withSpec.bones, withoutSpec.bones);
});

test('changing the character type changes the file, not just the label', async () => {
  await setRig(emptyRigFlowData('snake'));
  await generate(RIG_ID);
  const snake = await outputRig();

  await setRig(emptyRigFlowData('human'));
  await generate(RIG_ID);
  const human = await outputRig();

  assert.equal(snake.kind, 'snake');
  assert.equal(snake.chains.length, 1);
  assert.notEqual(snake.bones.length, human.bones.length);
  assert.ok(snake.bones.some((bone) => bone.id === 'body-14'));
  assert.ok(human.bones.some((bone) => bone.id === 'left-forearm'));
  assert.ok(!human.bones.some((bone) => bone.id === 'body-1'));
});

test('generating twice writes the same rig', async () => {
  await setRig(emptyRigFlowData('arachnid'));
  await generate(RIG_ID);
  const once = await outputRig();
  await generate(RIG_ID);
  assert.deepEqual(await outputRig(), once);
});
