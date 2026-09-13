import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

// The data root is read when ./paths is first imported, so it has to be set
// before the app module is pulled in.
const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-test-'));
process.env.VIBETOON_DATA = dataRoot;

const { createApp } = await import('../src/app');
import type { GenerateResponse, Project, StoryboardFlowData, SyncResponse } from '@vibetoon/shared';

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
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

let project: Project;
let dialogId = '';
let boardId = '';

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'API test' });
  dialogId = project.nodes.find((n) => n.kind === 'story.dialog')!.id;
  boardId = project.nodes.find((n) => n.kind === 'animation.storyboard')!.id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a new project is the dialog to storyboard starter', () => {
  assert.equal(project.nodes.length, 2);
  assert.equal(project.connections.length, 1);
  assert.ok(dialogId && boardId);
});

test('the registry lists every flow kind and the rule directives', async () => {
  const registry = await api<{ flowKinds: unknown[]; ruleDirectives: unknown[] }>('GET', '/api/registry');
  assert.ok(registry.flowKinds.length >= 30, 'the catalogue is published to the client');
  assert.ok(registry.ruleDirectives.length > 5);
});

test('generating the project writes the dialog artifacts', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/generate`);
  project = result.project;
  const dialogRun = result.runs.find((run) => run.flowId === dialogId)!;
  assert.equal(dialogRun.ok, true);
  assert.deepEqual(
    dialogRun.outputs.map((o) => o.fileName).sort(),
    ['dialog.txt', 'scenes.json', 'soundcues.txt'],
  );

  const text = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${dialogId}/dialog.txt`);
  assert.equal(text.status, 200);
  const body = await text.text();
  assert.match(body, /SCENE 1 — INT\. WORKSHOP - NIGHT/);
  assert.match(body, /MABZ/);
});

test('the board reports a pending sync instead of silently rewriting itself', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${boardId}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.ok(
    run.warnings.some((w) => /change\(s\) waiting/.test(w)),
    'suggest mode waits to be accepted',
  );
  const board = project.nodes.find((n) => n.id === boardId)!.data as StoryboardFlowData;
  assert.equal(board.scenes.length, 0);
});

test('accepting the sync fills the board from the dialog', async () => {
  const proposal = await api<SyncResponse>('GET', `/api/projects/${project.id}/flows/${boardId}/sync`);
  assert.ok(proposal.plan.counts.add > 0);
  assert.equal(proposal.sourceFlowId, dialogId);

  const accepted = await api<SyncResponse & { project: Project }>(
    'POST',
    `/api/projects/${project.id}/flows/${boardId}/sync`,
    {},
  );
  project = accepted.project;
  const board = project.nodes.find((n) => n.id === boardId)!.data as StoryboardFlowData;
  assert.equal(board.scenes.length, 1);
  assert.equal(board.scenes[0]!.panels.length, 8);
  assert.ok(board.syncSignature);
});

// A 1x1 png, which is all the panel writer needs to prove the path works.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('panel images sent with a generate run land in panels/', async () => {
  const result = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${boardId}/generate`,
    {
      attachments: [
        { name: 'panels/panel-001.png', data: `data:image/png;base64,${PNG_1x1}` },
        { name: 'panels/panel-002.png', data: PNG_1x1 },
      ],
    },
  );
  project = result.project;
  const panels = result.runs[0]!.outputs.find((o) => o.port === 'panels');
  assert.ok(panels, 'a panels artifact is recorded');
  assert.deepEqual(panels!.entries, ['panel-001.png', 'panel-002.png']);

  const image = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${boardId}/panels/panel-001.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('an uploaded file on an output port survives a regenerate', async () => {
  const designNode = {
    id: 'flow_design01',
    kind: 'animation.character.design',
    name: 'Mabz design',
    position: { x: 0, y: 600 },
    notes: '',
    data: { editor: 'brief' as const, fields: { silhouette: 'tall, round shoulders' } },
    outputs: [],
  };
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [...project.nodes, designNode],
  });

  const uploaded = await api<{ project: Project; artifact: { fileName: string; bytes: number } }>(
    'POST',
    `/api/projects/${project.id}/flows/${designNode.id}/outputs/design`,
    { fileName: 'character.png', data: PNG_1x1 },
  );
  project = uploaded.project;
  assert.equal(uploaded.artifact.fileName, 'character.png');

  const regenerated = await api<GenerateResponse>(
    'POST',
    `/api/projects/${project.id}/flows/${designNode.id}/generate`,
  );
  project = regenerated.project;
  const ports = regenerated.runs[0]!.outputs.map((o) => o.port).sort();
  assert.ok(ports.includes('design'), 'the uploaded image is still on the port');
  assert.ok(ports.includes('spec'), 'the brief was written alongside it');
  assert.ok(
    regenerated.runs[0]!.log.some((line) => /make yourself/.test(line)),
    'the run says which outputs still need a real file',
  );
});

test('saving with a stale revision is refused', async () => {
  const stale = { ...project, revision: project.revision - 1, name: 'overwrite' };
  const response = await fetch(`${base}/api/projects/${project.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(stale),
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string; details?: { expectedRevision?: number } };
  assert.match(body.error, /changed since/);
  assert.equal(body.details?.expectedRevision, project.revision);
});

test('artifact paths cannot climb out of the project', async () => {
  const response = await fetch(`${base}/api/projects/${project.id}/files/../../../etc/hostname`);
  assert.ok(response.status === 400 || response.status === 404, `got ${response.status}`);
});

test('deleting a project removes it from the listing', async () => {
  const throwaway = await api<Project>('POST', '/api/projects', { name: 'Bin me', template: 'empty' });
  assert.equal(throwaway.nodes.length, 0);
  const before = await api<unknown[]>('GET', '/api/projects');
  await fetch(`${base}/api/projects/${throwaway.id}`, { method: 'DELETE' });
  const after = await api<unknown[]>('GET', '/api/projects');
  assert.equal(after.length, before.length - 1);
});
