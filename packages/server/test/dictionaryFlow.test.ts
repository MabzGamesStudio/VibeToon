import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-dictflow-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';
delete process.env.VIBETOON_DICTIONARY_URL;
delete process.env.VIBETOON_DICTIONARY_KEY;

const { createApp } = await import('../src/app');
const { activeProvider, dictionaryUrlFor, hasDictionaryKey } = await import('../src/text/dictionary');
import {
  emptyDictionaryFlowData,
  emptyLexiconFlowData,
  type DictionaryFlowData,
  type DictionaryProviders,
  type FlowNode,
  type GenerateResponse,
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

const LEX_ID = 'flow_lex';
const DICT_ID = 'flow_dict';
let project: Project;

function dictNode(data: DictionaryFlowData): FlowNode {
  return {
    id: DICT_ID,
    kind: 'text.dictionary',
    name: 'Dictionary',
    position: { x: 440, y: 80 },
    notes: '',
    data,
    outputs: [],
  };
}

async function setDict(data: DictionaryFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...current,
    nodes: current.nodes.map((node) => (node.id === DICT_ID ? dictNode(data) : node)),
  });
}

async function generate(flowId: string): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${flowId}/generate`);
  project = result.project;
  return result;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Dictionary flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, {
    ...project,
    nodes: [
      {
        id: LEX_ID,
        kind: 'text.lexicon',
        name: 'Word Database',
        position: { x: 80, y: 80 },
        notes: '',
        data: emptyLexiconFlowData(),
        outputs: [],
      },
      dictNode(emptyDictionaryFlowData()),
    ],
    connections: [
      {
        id: 'c1',
        from: { nodeId: LEX_ID, portId: 'lexicon' },
        to: { nodeId: DICT_ID, portId: 'lexicon' },
        rules: '',
        settings: { enabled: true, mode: 'reference', weight: 1, notes: '' },
      },
    ],
  });
  await generate(LEX_ID);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

async function outputLexicon(): Promise<Lexicon> {
  const response = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${DICT_ID}/lexicon.json`);
  assert.equal(response.ok, true);
  return (await response.json()) as Lexicon;
}

/* ---------------- the flow itself ---------------- */

test('with nothing looked up, the database comes out as it went in, and it says so', async () => {
  const run = (await generate(DICT_ID)).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['lexicon.json', 'report.md']);
  assert.ok(
    run.warnings.some((warning) => warning.includes('Nothing has been looked up')),
    run.warnings.join('; '),
  );
  assert.ok((await outputLexicon()).lexemes.length > 100, 'and the words are all still there');
});

test('what was looked up is applied to the database', async () => {
  const before = (await outputLexicon()).lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;

  await setDict({
    ...emptyDictionaryFlowData(),
    meanings: {
      lamp: { type: 'verb', description: 'A made-up definition, to prove it lands.', source: 'dictionary' },
    },
  });
  const run = (await generate(DICT_ID)).runs[0]!;
  assert.equal(run.ok, true);

  const after = (await outputLexicon()).lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;
  assert.notEqual(after.type, before.type, 'the type changed');
  assert.equal(after.type, 'verb');
  assert.match(after.description, /prove it lands/);
  assert.equal(after.variations?.past, 'lamped', 'and the forms follow the type it now is');
  assert.equal(after.frequency, before.frequency, 'the counting is untouched — only the meaning changed');
});

test('the report says what changed and what is still unknown', async () => {
  const response = await fetch(`${base}/api/projects/${project.id}/files/artifacts/${DICT_ID}/report.md`);
  const report = await response.text();
  assert.match(report, /Types changed by this run: \*\*1\*\*/);
  assert.match(report, /Word types now/);
  assert.match(report, /never asked about/i);
  assert.match(report, /Service:/, 'and which service it is set to ask');
});

test('a flow with no word database wired in warns, and clobbers nothing', async () => {
  const before = (await outputLexicon()).lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;

  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, connections: [] });

  const run = (await generate(DICT_ID)).runs[0]!;
  assert.ok(
    run.warnings.some((warning) => warning.includes('No word database wired in')),
    run.warnings.join('; '),
  );

  // Nothing was written this run. What the last good run produced is kept, which
  // is what stops an unplugged wire from emptying a database downstream flows
  // are reading.
  const after = (await outputLexicon()).lexemes.find((lexeme) => lexeme.spelling === 'lamp')!;
  assert.deepEqual(after, before, 'the last good database is still there, untouched');
});

/* ---------------- keys ---------------- */

test('a key can be entered, and is never handed back', async () => {
  assert.equal(hasDictionaryKey('merriam-webster'), false);

  const listed = (await api<DictionaryProviders>('POST', '/api/text/dictionary/key', {
    id: 'merriam-webster',
    key: 'super-secret-token',
  }));

  const entry = listed.providers.find((provider) => provider.id === 'merriam-webster')!;
  assert.equal(entry.hasKey, true, 'the studio is told there is one');
  assert.equal(entry.available, true, 'so the service can now be picked');
  assert.ok(
    !JSON.stringify(listed).includes('super-secret-token'),
    'but the key itself never comes back to the browser',
  );
});

test('the key is used for that service, and stored outside every project', async () => {
  assert.equal(hasDictionaryKey('merriam-webster'), true);
  assert.match(
    dictionaryUrlFor('lamp', 'merriam-webster'),
    /key=super-secret-token/,
    'it is filled into the address the server builds',
  );
  assert.equal(activeProvider('merriam-webster').provider.id, 'merriam-webster');

  const settings = JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8')) as {
    dictionaryKeys?: Record<string, string>;
  };
  assert.equal(settings.dictionaryKeys?.['merriam-webster'], 'super-secret-token');

  const projectFile = await readFile(path.join(dataRoot, 'projects', project.id, 'project.json'), 'utf8');
  assert.ok(!projectFile.includes('super-secret-token'), 'and never into a project, which people copy around');
});

test('a key can be cleared, and the service becomes unpickable again', async () => {
  const listed = await api<DictionaryProviders>('POST', '/api/text/dictionary/key', {
    id: 'merriam-webster',
    key: '',
  });
  const entry = listed.providers.find((provider) => provider.id === 'merriam-webster')!;
  assert.equal(entry.hasKey, false);
  assert.equal(entry.available, false);
  assert.equal(hasDictionaryKey('merriam-webster'), false);
});

test('a service that takes no key refuses one', async () => {
  const response = await fetch(`${base}/api/text/dictionary/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'datamuse', key: 'x' }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /does not take a key/);
});

test('a flow can ask a different service from the studio', async () => {
  await api('POST', '/api/text/dictionary/provider', { id: 'wiktionary' });
  assert.equal(activeProvider().provider.id, 'wiktionary', 'the studio is set to one');
  assert.equal(activeProvider('datamuse').provider.id, 'datamuse', 'and a flow can override it');
  assert.equal(activeProvider('datamuse').reason, 'set on this flow');
  assert.equal(activeProvider('').provider.id, 'wiktionary', 'an empty choice follows the studio');
});

test('a flow asking a keyless-needing service falls back rather than firing doomed requests', async () => {
  const chosen = activeProvider('wordnik');
  assert.notEqual(chosen.provider.id, 'wordnik');
  assert.match(chosen.reason, /has no key yet/);
});
