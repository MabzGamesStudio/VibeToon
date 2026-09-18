import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-text-'));
process.env.VIBETOON_DATA = dataRoot;

const { createApp } = await import('../src/app');
import { emptyTextData, type GenerateResponse, type Project, type TextFlowData } from '@vibetoon/shared';

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

let project: Project;
let dialogId = '';
const textId = 'flow_text01';

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Text flow test' });
  dialogId = project.nodes.find((node) => node.kind === 'story.dialog')!.id;

  const data = emptyTextData();
  data.options.seed = 'test-seed';
  data.options.length = { ...data.options.length, mode: 'words', words: 40, temperature: 0.2 };
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      ...project.nodes,
      {
        id: textId,
        kind: 'text.random',
        name: 'Random Text',
        position: { x: 120, y: 520 },
        notes: '',
        data,
        outputs: [],
      },
    ],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a new text flow comes with a word database it can write from', () => {
  const data = project.nodes.find((node) => node.id === textId)!.data as TextFlowData;
  assert.ok(data.lexicon.lexemes.length > 150);
  assert.ok(data.lexicon.lexemes.some((lexeme) => lexeme.spelling === 'apple'));
});

test('generating writes the text, the database and a report', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${textId}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), [
    'lexicon.json',
    'report.md',
    'text.txt',
  ]);

  const text = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${textId}/text.txt`)).text();
  const words = text.trim().split(/\s+/).length;
  assert.ok(words >= 36 && words <= 44, `${words} words against a target of 40 ±4`);
  assert.match(text.trim(), /\.$/, 'the text ends on a full stop');

  const report = await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${textId}/report.md`)
  ).text();
  assert.match(report, /Mode: \*\*generate\*\*/);
  assert.match(report, /seed `test-seed`/);
  assert.match(report, /Target: 40 words ±4/);

  const lexicon = (await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${textId}/lexicon.json`)
  ).json()) as { lexemes: unknown[] };
  assert.ok(lexicon.lexemes.length > 150, 'the database is published for other flows to use');
});

test('the same project generates the same text again', async () => {
  const first = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${textId}/text.txt`)).text();
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${textId}/generate`);
  project = result.project;
  const second = await (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${textId}/text.txt`)).text();
  assert.equal(second, first, 'the run is deterministic, so the flow does not churn');
});

test('rules on the wire rewrite the dialog instead of writing something new', async () => {
  // Dialog → Random Text, told to change a third of it and grow it by half.
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    connections: [
      ...project.connections,
      {
        id: 'conn_text01',
        from: { nodeId: dialogId, portId: 'dialog' },
        to: { nodeId: textId, portId: 'text' },
        rules: 'alter: 0.35\nlength: +50%\nseed: wired',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });

  await api<GenerateResponse>('POST', `/api/projects/${project.id}/generate`);
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${textId}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.ok(
    run.log.some((line) => /Read \d+ characters from Scene Dialog/.test(line)),
    `expected the dialog to be read: ${run.log.join(' | ')}`,
  );

  const report = await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${textId}/report.md`)
  ).text();
  assert.match(report, /Mode: \*\*alter\*\*/, 'the rule switched the flow to altering');
  assert.match(report, /seed `wired`/);
  assert.match(report, /Changed: [1-9]\d* replaced/);

  const words = report.match(/- Words: (\d+) → (\d+)/);
  assert.ok(words, `no word line in the report:\n${report}`);
  const before = Number(words![1]);
  const afterCount = Number(words![2]);
  assert.ok(before > 0, 'the dialog came in');
  assert.ok(afterCount > before * 1.3, `${before} → ${afterCount} should be about half as long again`);
});

test('a word database arriving over a wire is merged in', async () => {
  const second = 'flow_text02';
  const data = emptyTextData();
  data.lexicon = {
    lexemes: [
      { id: 'z1', spelling: 'zeppelin', type: 'noun', frequency: 0.9, description: 'A big one.', contexts: [] },
    ],
  };
  data.options.length = { ...data.options.length, mode: 'words', words: 20, temperature: 0 };

  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      ...project.nodes,
      { id: second, kind: 'text.random', name: 'Merged Text', position: { x: 620, y: 520 }, notes: '', data, outputs: [] },
    ],
    connections: [
      ...project.connections,
      {
        id: 'conn_lex01',
        from: { nodeId: textId, portId: 'lexicon' },
        to: { nodeId: second, portId: 'lexicon' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });

  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${second}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.ok(
    run.log.some((line) => /Merged \d+ word\(s\) from Random Text/.test(line)),
    `expected a merge line: log=${run.log.join(' | ')} warnings=${run.warnings.join(' | ')}`,
  );

  const merged = (await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${second}/lexicon.json`)
  ).json()) as { lexemes: Array<{ spelling: string }> };
  assert.ok(merged.lexemes.some((lexeme) => lexeme.spelling === 'zeppelin'), 'the local word survives');
  assert.ok(merged.lexemes.some((lexeme) => lexeme.spelling === 'apple'), 'the upstream words arrive');
});
