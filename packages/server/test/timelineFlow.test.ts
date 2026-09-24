import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-timeline-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

const { createApp } = await import('../src/app');
import {
  addEvent,
  emptyTimelineFlowData,
  updateEvent,
  type FlowNode,
  type GenerateResponse,
  type Project,
  type TimelineFlowData,
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

const ID = 'flow_timeline';
let project: Project;

function node(data: TimelineFlowData): FlowNode {
  return { id: ID, kind: 'story.timeline', name: 'Timeline', position: { x: 80, y: 80 }, notes: '', data, outputs: [] };
}

async function setData(data: TimelineFlowData): Promise<void> {
  const current = await api<Project>('GET', `/api/projects/${project.id}`);
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...current, nodes: [node(data)] });
}

async function generate(): Promise<GenerateResponse> {
  const result = await api<GenerateResponse>('POST', `/api/projects/${project.id}/flows/${ID}/generate`);
  project = result.project;
  return result;
}

const file = async (name: string) => (await fetch(`${base}/api/projects/${project.id}/files/artifacts/${ID}/${name}`)).text();

function sample(): TimelineFlowData {
  let data = addEvent(emptyTimelineFlowData(), { year: 2004, month: 3, day: 15 }, 'The heist');
  data = updateEvent(data, 'evt_1', {
    characters: ['Ada', 'Bo'],
    places: [{ path: ['Europe', 'France', 'Paris'] }],
    tags: ['crime'],
    details: 'They take the vault.',
    dialog: [{ character: 'Bo', line: 'Now!', direction: 'whispered' }],
    end: { year: 2004, month: 3, day: 16 },
  });
  data = addEvent(data, { year: 2001 }, 'They meet');
  data = addEvent(data, {}, 'Somewhen');
  return data;
}

before(async () => {
  project = await api<Project>('POST', '/api/projects', { name: 'Timeline flow', template: 'empty' });
  project = await api<Project>('PUT', `/api/projects/${project.id}`, { ...project, nodes: [node(sample())], connections: [] });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test('the timeline writes every event as data, in time order', async () => {
  const run = (await generate()).runs[0]!;
  assert.equal(run.ok, true, run.warnings.join('; '));
  assert.deepEqual(run.outputs.map((output) => output.fileName).sort(), ['timeline.json', 'timeline.md']);
  const json = JSON.parse(await file('timeline.json'));
  assert.deepEqual(json.events.map((event: { title: string }) => event.title), ['They meet', 'The heist', 'Somewhen']);
  const heist = json.events[1];
  assert.equal(heist.from, '2004-03-15T00:00:00.000Z');
  assert.equal(heist.to, '2004-03-17T00:00:00.000Z');
  assert.equal(heist.duration, '1 day');
  assert.deepEqual(heist.characters, ['Ada', 'Bo']);
  assert.equal(heist.places[0].label, 'Europe / France / Paris');
  assert.equal(heist.dialog[0].line, 'Now!');
  assert.equal(json.span.start, '2000-01-01T00:00:00.000Z');
  assert.equal(json.span.endIsToday, true);
});

test('the doc reads as a chronology, dialog and all', async () => {
  const doc = await file('timeline.md');
  assert.match(doc, /### 15 Mar 2004 – 16 Mar 2004 — The heist/);
  assert.match(doc, /\*\*Who:\*\* Ada, Bo/);
  assert.match(doc, /> \*\*Bo\*\* _\(whispered\)_: Now!/);
  assert.match(doc, /1 undated/);
});

test('a filter in the editor does not drop events from the output, and says so', async () => {
  await setData({ ...sample(), filter: { text: 'vault', characters: [], places: [], tags: [] } });
  await generate();
  assert.equal(JSON.parse(await file('timeline.json')).events.length, 3);
  assert.match(await file('timeline.md'), /filtering \(1 of 3 shown\)/);
});

test('events outside the span, and ones that end before they start, are warned about', async () => {
  let data = addEvent(sample(), { year: 1950 }, 'Long ago');
  data = updateEvent(data, 'evt_1', { end: { year: 2003 } });
  await setData(data);
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((warning) => /outside the timeline's span/.test(warning) && /Long ago/.test(warning)), run.warnings.join('; '));
  assert.ok(run.warnings.some((warning) => /ends before it starts/.test(warning)));
});

test('an empty timeline says so rather than writing nothing silently', async () => {
  await setData(emptyTimelineFlowData());
  const run = (await generate()).runs[0]!;
  assert.ok(run.warnings.some((warning) => /no events yet/.test(warning)));
});
