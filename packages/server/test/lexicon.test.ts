import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-lexicon-'));
process.env.VIBETOON_DATA = dataRoot;

// A stand-in for the dictionary service, so the parsing, caching and failure
// paths are exercised without depending on anything outside this machine.
const dictionary = express();
let dictionaryCalls = 0;
let dictionaryDown = false;
dictionary.get('/entries/en/:word', (req, res) => {
  dictionaryCalls += 1;
  if (dictionaryDown) {
    res.status(503).send('unavailable');
    return;
  }
  if (req.params.word === 'zzzz') {
    res.status(404).json({ title: 'No Definitions Found' });
    return;
  }
  res.json([
    {
      word: req.params.word,
      meanings: [
        {
          partOfSpeech: req.params.word === 'quietly' ? 'adverb' : 'noun',
          definitions: [{ definition: `A definition of ${req.params.word}.` }],
        },
      ],
    },
  ]);
});
const dictionaryServer = dictionary.listen(0);
const dictionaryPort = await new Promise<number>((resolve) => {
  dictionaryServer.on('listening', () => resolve((dictionaryServer.address() as AddressInfo).port));
});
process.env.VIBETOON_DICTIONARY_URL = `http://127.0.0.1:${dictionaryPort}/entries/en/{word}`;

const { createApp } = await import('../src/app');
const { lookupWords } = await import('../src/text/dictionary');
import {
  emptyLexiconFlowData,
  masterDataset,
  type GenerateResponse,
  type LexiconFlowData,
  type Lexicon,
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

let project: Project;
const lexiconId = 'flow_lex1';

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Lexicon test', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: lexiconId,
        kind: 'text.lexicon',
        name: 'Word Database',
        position: { x: 80, y: 80 },
        notes: '',
        data: emptyLexiconFlowData(),
        outputs: [],
      },
    ],
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => dictionaryServer.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('a new word database is built from the sample corpus', () => {
  const data = project.nodes[0]!.data as LexiconFlowData;
  assert.equal(data.datasets.length, 1);
  assert.equal(data.included.length, 1);
  const master = masterDataset(data);
  assert.ok(master.tokenCount > 400, `${master.tokenCount} tokens`);
  assert.ok(master.entries.length > 100, `${master.entries.length} words`);
});

test('generating writes the database and a report of what went into it', async () => {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${lexiconId}/generate`);
  project = result.project;
  const run = result.runs[0]!;
  assert.equal(run.ok, true);
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['lexicon.json', 'report.md']);

  const lexicon = (await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${lexiconId}/lexicon.json`)
  ).json()) as Lexicon;
  assert.ok(lexicon.lexemes.length > 100);
  const lamp = lexicon.lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;
  assert.ok(lamp.stats!.count > 1, 'entries carry the count they came from');
  assert.ok(lamp.contexts.length > 0, 'and the contexts counted out of the corpus');

  const report = await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${lexiconId}/report.md`)
  ).text();
  assert.match(report, /Workshop sample/);
  assert.match(report, /The most common words/);
});

test('the dictionary fills in types and definitions, and caches them', async () => {
  const before = dictionaryCalls;
  const first = await api<{ meanings: Record<string, { type: string; description: string; source: string }>; found: string[]; cached: number }>(
    'POST',
    '/api/text/dictionary',
    { words: ['lamp', 'quietly', 'zzzz', '.', '42'] },
  );

  assert.equal(first.meanings.lamp!.source, 'dictionary');
  assert.match(first.meanings.lamp!.description, /A definition of lamp/);
  assert.equal(first.meanings.quietly!.type, 'adverb', 'the part of speech is mapped onto a word type');
  assert.equal(first.meanings.zzzz!.source, 'inferred', 'a word with no entry falls back to a guess');
  assert.equal(first.meanings['.']!.type, 'punctuation', 'no dictionary is asked about a full stop');
  assert.equal(first.meanings['42']!.type, 'number');
  assert.equal(dictionaryCalls - before, 3, 'only the three real words were fetched');

  const second = await api<{ cached: number }>('POST', '/api/text/dictionary', {
    words: ['lamp', 'quietly', 'zzzz'],
  });
  assert.equal(second.cached, 3, 'the second run comes out of the cache');
  assert.equal(dictionaryCalls - before, 3, 'and asks the service nothing');
});

test('a dictionary that is down stops the run instead of hammering it', async () => {
  dictionaryDown = true;
  const before = dictionaryCalls;
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  // Retries are what make a hiccup survivable, so they are kept — just without
  // the waiting, which would otherwise make this test take seconds.
  const result = await lookupWords(words, { retryDelaysMs: [0, 0], pauseMs: 0, concurrency: 2 });
  dictionaryDown = false;

  assert.ok(result.unreachable, 'the caller is told why');
  assert.match(result.unreachable!, /503/);
  assert.equal(result.found.length, 0);
  assert.ok(result.failed.length >= 1, 'the words it kept asking about are reported as failed');
  assert.equal(
    result.failed.length + result.remaining.length,
    words.length,
    'and every other word is handed back to ask about again',
  );
  assert.ok(
    dictionaryCalls - before < words.length * 3,
    `stopped after ${dictionaryCalls - before} requests rather than retrying all ${words.length}`,
  );
});

test('meanings collected from the dictionary reach the generated database', async () => {
  const data = project.nodes[0]!.data as LexiconFlowData;
  const lookup = await api<{ meanings: Record<string, unknown> }>('POST', '/api/text/dictionary', {
    words: ['lamp', 'gear', 'quietly'],
  });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === lexiconId
        ? { ...node, data: { ...data, meanings: { ...data.meanings, ...lookup.meanings } } }
        : node,
    ),
  });

  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${lexiconId}/generate`);
  project = result.project;
  const lexicon = (await (
    await fetch(`${base}/api/projects/${project.id}/files/artifacts/${lexiconId}/lexicon.json`)
  ).json()) as Lexicon;
  const lamp = lexicon.lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;
  assert.match(lamp.description, /A definition of lamp/);
});

test('text wired into the Corpus input is counted, and only once', async () => {
  // A Random Text flow feeding the database its own output.
  const textId = 'flow_text_src';
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      ...project.nodes,
      {
        id: textId,
        kind: 'text.random',
        name: 'Source text',
        position: { x: 600, y: 80 },
        notes: '',
        data: {
          editor: 'text',
          input: 'the kettle boils and the kettle sings. the kettle is loud.',
          output: '',
          options: {
            mode: 'alter',
            seed: 'x',
            length: { mode: 'keep', words: 40, characters: 200, wordPercent: 0, charPercent: 0, temperature: 0 },
            alterTemperature: 0,
            pickTemperature: 0.45,
            contextWindow: 3,
            contextDecay: 0.55,
            frequencyBias: 0.45,
            contextSymmetry: 0.5,
            grammarBias: 0.85,
            sentenceLength: 12,
          },
          lexicon: { lexemes: [] },
        },
        outputs: [],
      },
    ],
    connections: [
      {
        id: 'conn_corpus',
        from: { nodeId: textId, portId: 'text' },
        to: { nodeId: lexiconId, portId: 'corpus' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });

  await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${textId}/generate`);
  const first = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${lexiconId}/generate`);
  project = first.project;
  const afterOne = project.nodes.find((node) => node.id === lexiconId)!.data as LexiconFlowData;
  assert.equal(afterOne.datasets.length, 2, 'the wire brought a dataset of its own');
  const wired = afterOne.datasets.find((dataset) => dataset.source.kind === 'flow')!;
  assert.equal(wired.name, 'Source text');
  const kettleOnce = wired.entries.find((entry) => entry.spelling === 'kettle')!.count;

  const second = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${lexiconId}/generate`);
  project = second.project;
  const afterTwo = project.nodes.find((node) => node.id === lexiconId)!.data as LexiconFlowData;
  assert.equal(afterTwo.datasets.length, 2, 'generating again replaces it rather than adding another');
  const again = afterTwo.datasets.find((dataset) => dataset.source.kind === 'flow')!;
  assert.equal(again.entries.find((entry) => entry.spelling === 'kettle')!.count, kettleOnce);
});

test('unticking a corpus takes it back out of the database exactly', async () => {
  const data = project.nodes.find((node) => node.id === lexiconId)!.data as LexiconFlowData;
  const sample = data.datasets.find((dataset) => dataset.source.kind === 'builtin')!;
  const wired = data.datasets.find((dataset) => dataset.source.kind === 'flow')!;

  const both = masterDataset(data);
  assert.ok(both.entries.some((entry) => entry.spelling === 'kettle'));
  assert.ok(both.entries.some((entry) => entry.spelling === 'workshop'));

  const sampleOnly = masterDataset({ ...data, included: [sample.id] });
  assert.ok(!sampleOnly.entries.some((entry) => entry.spelling === 'kettle'), 'the wired words are gone');
  assert.equal(
    sampleOnly.entries.find((entry) => entry.spelling === 'workshop')!.count,
    sample.entries.find((entry) => entry.spelling === 'workshop')!.count,
    'and what is left matches the corpus it came from',
  );

  const wiredOnly = masterDataset({ ...data, included: [wired.id] });
  assert.ok(!wiredOnly.entries.some((entry) => entry.spelling === 'workshop'));
});
