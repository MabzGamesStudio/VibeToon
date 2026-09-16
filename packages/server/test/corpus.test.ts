import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-corpus-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  SAMPLE_CORPUS,
  emptyCorpusFlowData,
  emptyTextData,
  samplePart,
  type Connection,
  type CorpusFlowData,
  type CorpusPart,
  type FlowNode,
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

async function artifact(flowId: string, fileName: string): Promise<string> {
  const response = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${flowId}/${fileName}`);
  assert.equal(response.ok, true, `${flowId}/${fileName} should exist`);
  return await response.text();
}

const CORPUS_ID = 'flow_corpus';
const TEXT_ID = 'flow_text';
let project: Project;

function pasted(id: string, name: string, text: string): CorpusPart {
  return { id, name, kind: 'pasted', text, addedAt: '2026-01-01T00:00:00.000Z' };
}

function corpusNode(data: CorpusFlowData): FlowNode {
  return {
    id: CORPUS_ID,
    kind: 'text.corpus',
    name: 'Corpus',
    position: { x: 80, y: 80 },
    notes: '',
    data,
    outputs: [],
  };
}

/** Generating bumps the project's revision, so always write against a fresh read. */
async function setCorpus(data: CorpusFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === CORPUS_ID ? corpusNode(data) : node)),
  });
}

async function generate(flowId = CORPUS_ID): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flowId}/generate`);
  project = result.project;
  return result;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Corpus test', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [corpusNode(emptyCorpusFlowData())],
    connections: [],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- what it writes ---------------- */

test('a new corpus flow writes the bundled sample', async () => {
  const run = (await generate()).runs[0]!;

  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['corpus.txt', 'report.md']);
  assert.equal((await artifact(CORPUS_ID, 'corpus.txt')).trim(), SAMPLE_CORPUS.trim());
});

test('parts are written in their order, joined by the separator', async () => {
  await setCorpus({
    editor: 'corpus',
    parts: [pasted('p1', 'One', 'The lamp is old.'), pasted('p2', 'Two', 'The gear turns.')],
    included: ['p2', 'p1'],
    separator: '\n\n',
  });
  await generate();

  assert.equal(
    (await artifact(CORPUS_ID, 'corpus.txt')).trim(),
    'The gear turns.\n\nThe lamp is old.',
    'the order in the editor is the order in the file',
  );

  await setCorpus({
    editor: 'corpus',
    parts: [pasted('p1', 'One', 'The lamp is old.'), pasted('p2', 'Two', 'The gear turns.')],
    included: ['p1', 'p2'],
    separator: ' ',
  });
  await generate();
  assert.equal((await artifact(CORPUS_ID, 'corpus.txt')).trim(), 'The lamp is old. The gear turns.');
});

test('an unticked part is left out without being lost', async () => {
  await setCorpus({
    editor: 'corpus',
    parts: [pasted('p1', 'One', 'The lamp is old.'), pasted('p2', 'Two', 'The gear turns.')],
    included: ['p1'],
    separator: '\n\n',
  });
  await generate();

  assert.equal((await artifact(CORPUS_ID, 'corpus.txt')).trim(), 'The lamp is old.');
  const data = project.nodes.find((node) => node.id === CORPUS_ID)!.data as CorpusFlowData;
  assert.equal(data.parts.length, 2, 'the unticked part is still in the flow');
});

test('an address that cannot be read is reported, and the rest is still written', async () => {
  await setCorpus({
    editor: 'corpus',
    parts: [
      pasted('p1', 'One', 'The lamp is old.'),
      {
        id: 'p2',
        name: 'A book',
        kind: 'url',
        url: 'https://nothing.invalid/book.txt',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    included: ['p1', 'p2'],
    separator: '\n\n',
  });
  const run = (await generate()).runs[0]!;

  assert.equal(run.ok, true, 'one bad part does not fail the run');
  assert.ok(run.warnings.some((warning) => warning.includes('A book')), run.warnings.join('; '));
  assert.equal((await artifact(CORPUS_ID, 'corpus.txt')).trim(), 'The lamp is old.', 'the good part is written');

  const data = project.nodes.find((node) => node.id === CORPUS_ID)!.data as CorpusFlowData;
  const failed = data.parts.find((part) => part.id === 'p2')!;
  assert.ok(failed.lastError, 'and the part remembers what went wrong, for the editor to show');

  const report = await artifact(CORPUS_ID, 'report.md');
  assert.match(report, /could not be read/i);
  assert.match(report, /A book/);
});

test('the report says what went into it', async () => {
  const report = await artifact(CORPUS_ID, 'report.md');
  assert.match(report, /What went into it/);
  assert.match(report, /\| One \|/, 'each part is a row');
});

/* ---------------- what arrives over a wire ---------------- */

test('text wired in is a part too, read fresh on every run', async () => {
  const text = emptyTextData();
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: [
      ...current.nodes,
      {
        id: TEXT_ID,
        kind: 'text.random',
        name: 'Source text',
        position: { x: 500, y: 80 },
        notes: '',
        data: { ...text, input: 'the kettle boils.', options: { ...text.options, mode: 'alter', alterTemperature: 0 } },
        outputs: [],
      },
    ],
    connections: [
      {
        id: 'conn_text',
        from: { nodeId: TEXT_ID, portId: 'text' },
        to: { nodeId: CORPUS_ID, portId: 'text' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      } satisfies Connection,
    ],
  });

  await setCorpus({
    editor: 'corpus',
    parts: [pasted('p1', 'One', 'The lamp is old.')],
    included: ['p1'],
    separator: '\n\n',
  });
  await generate(TEXT_ID);
  await generate();

  const written = await artifact(CORPUS_ID, 'corpus.txt');
  assert.match(written, /The lamp is old\./, 'the stored part is there');
  assert.match(written, /kettle/i, 'and so is what came over the wire');

  const data = project.nodes.find((node) => node.id === CORPUS_ID)!.data as CorpusFlowData;
  assert.equal(data.parts.length, 1, 'wired text is not stored as a part — it is read fresh each run');
});

/* ---------------- nothing to write ---------------- */

test('a corpus with nothing included says so rather than writing silence', async () => {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });
  await setCorpus({ editor: 'corpus', parts: [samplePart()], included: [], separator: '\n\n' });

  const result = await generate();
  assert.ok(
    result.runs[0]!.warnings.some((warning) => warning.includes('Nothing is included')),
    result.runs[0]!.warnings.join('; '),
  );
  assert.equal((await artifact(CORPUS_ID, 'corpus.txt')).trim(), '');
});
