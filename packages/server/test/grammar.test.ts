import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-grammar-'));
process.env.VIBETOON_DATA = dataRoot;

const { createApp } = await import('../src/app');
import {
  DEFAULT_RANDOM_TEXT_OPTIONS,
  emptyGrammarFlowData,
  emptyLexiconFlowData,
  emptyTextData,
  masterGrammar,
  parsePattern,
  type Connection,
  type GenerateResponse,
  type GrammarDataset,
  type GrammarFlowData,
  type Project,
  type FlowNode,
  type RandomTextOptions,
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

const LEXICON_ID = 'flow_lex';
const SOURCE_ID = 'flow_src';
const GRAMMAR_ID = 'flow_gram';
const WRITER_ID = 'flow_writer';

/** Short, plain sentences whose shapes repeat, so the counting is predictable. */
const CORPUS = [
  'The lamp hangs over the bench.',
  'The gear turns on the bench.',
  'The kettle sits on the shelf.',
  'The lamp hangs over the shelf.',
  'The gear turns on the shelf.',
].join(' ');

function textNode(id: string, name: string, overrides: Partial<RandomTextOptions> = {}): FlowNode {
  const data = emptyTextData();
  return {
    id,
    kind: 'text.random',
    name,
    position: { x: 80, y: 80 },
    notes: '',
    data: {
      ...data,
      options: {
        ...data.options,
        ...overrides,
        length: { ...data.options.length, ...(overrides.length ?? {}) },
      },
    },
    outputs: [],
  };
}

function wire(id: string, from: [string, string], to: [string, string]): Connection {
  return {
    id,
    from: { nodeId: from[0], portId: from[1] },
    to: { nodeId: to[0], portId: to[1] },
    rules: '',
    settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
  };
}

let project: Project;

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Grammar test', template: 'empty' });

  // A source flow that hands the corpus straight through: alter mode with the
  // alter temperature at zero rewrites nothing.
  const source = textNode(SOURCE_ID, 'Source text', {
    mode: 'alter',
    alterTemperature: 0,
    grammarWeight: 0,
  });

  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: LEXICON_ID,
        kind: 'text.lexicon',
        name: 'Word Database',
        position: { x: 80, y: 80 },
        notes: '',
        data: emptyLexiconFlowData(),
        outputs: [],
      },
      { ...source, data: { ...(source.data as object), input: CORPUS } },
      {
        id: GRAMMAR_ID,
        kind: 'text.grammar',
        name: 'Grammar Database',
        position: { x: 400, y: 80 },
        notes: '',
        // Start empty rather than with the bundled sample, so what the wires
        // bring in is the only thing counted.
        data: { ...emptyGrammarFlowData(), datasets: [], included: [], options: { ...emptyGrammarFlowData().options, minCount: 2 } },
        outputs: [],
      },
      textNode(WRITER_ID, 'Writer', {
        mode: 'generate',
        seed: 'writer',
        grammarWeight: 0.8,
        length: { ...DEFAULT_RANDOM_TEXT_OPTIONS.length, mode: 'words', words: 40 },
      }),
    ],
    connections: [
      wire('conn_lex_gram', [LEXICON_ID, 'lexicon'], [GRAMMAR_ID, 'lexicon']),
      wire('conn_src_gram', [SOURCE_ID, 'text'], [GRAMMAR_ID, 'corpus']),
      wire('conn_gram_writer', [GRAMMAR_ID, 'grammar'], [WRITER_ID, 'grammar']),
    ],
  });

  await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${LEXICON_ID}/generate`);
  const source_ = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${SOURCE_ID}/generate`);
  project = source_.project;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

function grammarData(): GrammarFlowData {
  return project.nodes.find((node) => node.id === GRAMMAR_ID)!.data as GrammarFlowData;
}

test('a corpus read against a word database becomes a grammar database', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${GRAMMAR_ID}/generate`);
  project = result.project;
  const run = result.runs[0]!;

  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['grammar.json', 'report.md']);
  assert.deepEqual(run.warnings, [], 'both inputs were wired, so there is nothing to warn about');

  const dataset = JSON.parse(await artifact(GRAMMAR_ID, 'grammar.json')) as GrammarDataset;
  assert.equal(dataset.stats.sentences, 5, 'five sentences were read');
  assert.ok(dataset.sentences.length > 0, 'and they left sentence shapes behind');
  assert.ok(
    dataset.sentences.every(([signature]) => parsePattern(signature).at(-1)?.type === 'punctuation'),
    'a sentence shape ends on a mark',
  );
  assert.ok(dataset.phrases.length > 0, `${dataset.phrases.length} phrase shapes`);
  assert.equal(dataset.options.minCount, 2, 'the reading options are the ones the flow is set to');
});

test('the wired corpus becomes a dataset of its own, replaced on each run', async () => {
  const after = grammarData();
  assert.equal(after.datasets.length, 1, 'the wire brought a dataset');
  assert.deepEqual(after.included, [after.datasets[0]!.id], 'and it is included straight away');
  assert.equal(after.datasets[0]!.name, 'Source text');
  assert.equal(after.datasets[0]!.source.kind, 'flow');
  const sentencesOnce = after.datasets[0]!.stats.sentences;

  const again = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${GRAMMAR_ID}/generate`);
  project = again.project;
  const twice = grammarData();
  assert.equal(twice.datasets.length, 1, 'generating again replaces it rather than adding another');
  assert.equal(twice.datasets[0]!.stats.sentences, sentencesOnce, 'so nothing is counted twice');
});

test('the report says what was read and what was found', async () => {
  const report = await artifact(GRAMMAR_ID, 'report.md');
  assert.match(report, /Sentence shapes/);
  assert.match(report, /Words typed by the database/);
  assert.match(report, /Source text/, 'the corpus it read is named');
});

test('unticking the corpus empties the database again', () => {
  const data = grammarData();
  assert.ok(masterGrammar(data).sentences.length > 0);
  const none = masterGrammar({ ...data, included: [] });
  assert.deepEqual(none.sentences, [], 'nothing included, nothing counted');
  assert.deepEqual(none.phrases, []);
});

test('a grammar database with no word database wired in warns rather than guessing quietly', async () => {
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    connections: project.connections.filter((connection) => connection.id !== 'conn_lex_gram'),
  });
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${GRAMMAR_ID}/generate`);
  project = result.project;

  assert.ok(
    result.runs[0]!.warnings.some((warning) => warning.includes('No word database wired in')),
    result.runs[0]!.warnings.join('; '),
  );

  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    connections: [...project.connections, wire('conn_lex_gram', [LEXICON_ID, 'lexicon'], [GRAMMAR_ID, 'lexicon'])],
  });
  await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${GRAMMAR_ID}/generate`);
});

test('a wired grammar database shapes what the random text flow writes', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${WRITER_ID}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));

  const text = await artifact(WRITER_ID, 'text.txt');
  assert.ok(text.trim().length > 0, 'it wrote something');

  const report = await artifact(WRITER_ID, 'report.md');
  const grammarLine = /- Grammar: (\d+) sentence shape\(s\), (\d+) used/.exec(report);
  assert.ok(grammarLine, 'the report says what the grammar database gave it');
  assert.ok(Number(grammarLine![1]) > 0, 'shapes were available');
  assert.ok(Number(grammarLine![2]) > 0, `${grammarLine![2]} of them were written into`);
});
