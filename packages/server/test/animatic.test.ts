import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-animatic-'));
process.env.VIBETOON_DATA = dataRoot;

const { createApp } = await import('../src/app');
import {
  emptyAnimaticData,
  type AnimaticFlowData,
  type GenerateResponse,
  type Project,
  type StoryboardFlowData,
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

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

interface Cut {
  durationSec: number;
  boardDurationSec: number;
  targetSeconds: number;
  offTargetSec: number;
  clipCount: number;
  renderableClipCount: number;
  adjustedCount: number;
  skipped: Array<{ panelId: string }>;
  pacing: string;
  clips: Array<{ index: number; panelId: string; durationSec: number; image: string | null; note: string }>;
}

let project: Project;
let boardId = '';
const animaticId = 'flow_animatic1';

async function readCut(): Promise<Cut> {
  const response = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${animaticId}/animatic.json`);
  assert.equal(response.status, 200);
  return (await response.json()) as Cut;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Animatic test' });
  boardId = project.nodes.find((node) => node.kind === 'animation.storyboard')!.id;

  // Fill the board from the dialog, then generate it with panel images, which
  // is what gives the animatic something to show.
  await api<GenerateResponse>('POST', `/api/projects/${project.id}/generate`);
  await api<unknown>('POST', `/api/projects/${project.id}/flows/${boardId}/sync`, {});
  const withPanels = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${boardId}/generate`,
    {
      attachments: Array.from({ length: 8 }, (_unused, index) => ({
        name: `panels/panel-${String(index + 1).padStart(3, '0')}.png`,
        data: PNG,
      })),
    },
  );
  project = withPanels.project;

  const data = emptyAnimaticData();
  data.pacing = 'let the last line land';
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      ...project.nodes,
      {
        id: animaticId,
        kind: 'animation.animatic',
        name: 'Animatic',
        position: { x: 1120, y: 180 },
        notes: '',
        data,
        outputs: [],
      },
    ],
    connections: [
      ...project.connections,
      {
        id: 'conn_board_cut',
        from: { nodeId: boardId, portId: 'storyboard' },
        to: { nodeId: animaticId, portId: 'storyboard' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
      {
        id: 'conn_board_panels',
        from: { nodeId: boardId, portId: 'panels' },
        to: { nodeId: animaticId, portId: 'panels' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('the animatic lays the board out in time', async () => {
  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${animaticId}/generate`,
  );
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.deepEqual(run.outputs.map((output) => output.fileName), ['animatic.json']);

  const cut = await readCut();
  const board = (project.nodes.find((node) => node.id === boardId)!.data as StoryboardFlowData).scenes;
  const panelCount = board.reduce((sum, scene) => sum + scene.panels.length, 0);
  assert.equal(cut.clipCount, panelCount);
  assert.equal(cut.renderableClipCount, panelCount, 'every shot found its panel image');
  assert.equal(cut.durationSec, cut.boardDurationSec, 'nothing retimed yet');
  assert.equal(cut.pacing, 'let the last line land');
  assert.match(
    cut.clips[0]!.image ?? '',
    new RegExp(`^artifacts/${boardId}/panels/panel-001\\.png$`),
    'images are project-relative so the render flow can find them',
  );
});

test('holding and cutting shots changes the runtime, not the board', async () => {
  const before = await readCut();
  const firstPanel = before.clips[0]!.panelId;
  const secondPanel = before.clips[1]!.panelId;

  const data: AnimaticFlowData = {
    editor: 'animatic',
    pacing: 'let the last line land',
    targetSeconds: 12,
    overrides: {
      [firstPanel]: { durationSec: 5, note: 'hold the lamp' },
      [secondPanel]: { skip: true },
    },
  };
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: project.nodes.map((node) => (node.id === animaticId ? { ...node, data } : node)),
  });

  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${animaticId}/generate`,
  );
  project = result.project;
  const cut = await readCut();

  assert.equal(cut.clipCount, before.clipCount - 1);
  assert.equal(cut.clips[0]!.durationSec, 5);
  assert.equal(cut.clips[0]!.note, 'hold the lamp');
  assert.equal(cut.adjustedCount, 1);
  assert.deepEqual(cut.skipped.map((skip) => skip.panelId), [secondPanel]);
  assert.equal(cut.boardDurationSec, before.boardDurationSec, 'the board is untouched');
  assert.equal(cut.targetSeconds, 12);
  assert.equal(cut.offTargetSec, Math.round((cut.durationSec - 12) * 100) / 100);

  const run = result.runs[0]!;
  assert.ok(run.log.some((line) => /1 shot\(s\) cut out/.test(line)), run.log.join(' | '));
  assert.ok(run.log.some((line) => /1 shot\(s\) retimed/.test(line)), run.log.join(' | '));
});

test('a target length on the wire stands in for one that is not set', async () => {
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === animaticId
        ? { ...node, data: { ...(node.data as AnimaticFlowData), targetSeconds: 0 } }
        : node,
    ),
    connections: project.connections.map((connection) =>
      connection.id === 'conn_board_cut'
        ? { ...connection, rules: 'target length: 1m30\nmax duration: 3' }
        : connection,
    ),
  });

  await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${animaticId}/generate`);
  const cut = await readCut();
  assert.equal(cut.targetSeconds, 90);
  assert.ok(
    cut.clips.every((clip) => clip.durationSec <= 3),
    'max duration clamps every shot',
  );
});

test('without ffmpeg the plan says how to get the file anyway', async () => {
  const plan = await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${animaticId}/animatic-plan.md`)
  ).text();
  assert.match(plan, /# Animatic — animatic/);
  assert.match(plan, /ffmpeg -y -f concat/, 'the exact command is always written');
  // This machine has no ffmpeg, so the plan points at the browser recorder.
  assert.match(plan, /Export video/);
});

test('a video recorded in the browser survives regenerating the flow', async () => {
  const uploaded = await api<{ project: Project; artifact: { fileName: string; bytes: number } }>(
    'POST',
    `/api/projects/${project.id}/flows/${animaticId}/outputs/preview`,
    { fileName: 'animatic.webm', data: PNG },
  );
  project = uploaded.project;
  assert.equal(uploaded.artifact.fileName, 'animatic.webm');

  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${animaticId}/generate`,
  );
  project = result.project;
  const preview = result.runs[0]!.outputs.find((output) => output.port === 'preview');
  assert.ok(preview, 'the recording is still on the Preview port');
  assert.equal(preview!.fileName, 'animatic.webm');

  const served = await fetch(`${base}/api/projects/${project.id}/files/${preview!.path}`);
  assert.equal(served.status, 200);
});
