import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import type { ApiLogEntry, ApiLogPage } from '@vibetoon/shared';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-logs-'));
process.env.VIBETOON_DATA = dataRoot;

/** A dictionary stand-in that can be told to refuse, so failures are logged too. */
let mode: 'ok' | 'limited' | 'down' = 'ok';
const stub = express();
stub.get('/entries/en/:word', (req, res) => {
  if (mode === 'down') {
    res.status(503).send('unavailable');
    return;
  }
  if (mode === 'limited') {
    res.setHeader('retry-after', '1');
    res.status(429).send('slow down');
    return;
  }
  if (req.params.word === 'zzzz') {
    res.status(404).json({ title: 'No Definitions Found' });
    return;
  }
  res.json([
    { word: req.params.word, meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A thing.' }] }] },
  ]);
});
const stubServer = stub.listen(0);
const stubPort = await new Promise<number>((resolve) => {
  stubServer.on('listening', () => resolve((stubServer.address() as AddressInfo).port));
});
process.env.VIBETOON_DICTIONARY_URL = `http://127.0.0.1:${stubPort}/entries/en/{word}`;

const { createApp } = await import('../src/app');
const { lookupWords } = await import('../src/text/dictionary');
const { LOG_FILE, clearLogs, flushLogs, readLogs, recordApiCall, redactUrl } = await import('../src/logs');
const { fetchCorpus } = await import('../src/text/corpusFetch');

const server = createApp().listen(0);
const port = await new Promise<number>((resolve) => {
  server.on('listening', () => resolve((server.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;
const FAST = { retryDelaysMs: [0, 0], pauseMs: 0, concurrency: 2, limit: 50 } as const;

before(() => clearLogs());

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  // Appends are chained and fire-and-forget, so the last one has to land before
  // the directory underneath it is removed.
  await flushLogs();
  await rm(dataRoot, { recursive: true, force: true });
});

/* ---------------- what gets recorded ---------------- */

test('a dictionary lookup writes a line per word', async () => {
  clearLogs();
  mode = 'ok';
  await lookupWords(['alpha', 'bravo', 'zzzz'], FAST);

  const entries = readLogs().entries.filter((entry) => entry.service === 'dictionary');
  assert.equal(entries.length, 3, 'one per word, none of them cached yet');
  assert.deepEqual(
    entries.map((entry) => `${entry.subject}:${entry.outcome}`).sort(),
    ['alpha:ok', 'bravo:ok', 'zzzz:missing'],
    'and each says what the service actually answered',
  );
  assert.ok(entries.every((entry) => entry.status === 200 || entry.status === 404));
  assert.ok(entries.every((entry) => entry.durationMs >= 0));
  assert.ok(entries.every((entry) => entry.url.includes('/entries/en/')));
});

test('a word answered from the cache is one line, not a thousand', async () => {
  clearLogs();
  mode = 'ok';
  await lookupWords(['alpha', 'bravo'], FAST);

  const entries = readLogs().entries;
  assert.equal(entries.length, 1, 'the batch reports its cache hits once');
  assert.equal(entries[0]!.outcome, 'cached');
  assert.match(entries[0]!.subject ?? '', /2 word/);
  assert.match(entries[0]!.detail ?? '', /nothing was sent/);
});

test('every attempt at a refused word is its own line', async () => {
  clearLogs();
  mode = 'down';
  await lookupWords(['charlie'], { ...FAST, maxFailures: 1 });
  mode = 'ok';

  const entries = readLogs({ service: 'dictionary' }).entries;
  assert.equal(entries.length, 3, 'the first go and both retries');
  assert.deepEqual(entries.map((entry) => entry.attempt), [1, 2, 3], 'numbered, so a retry storm is obvious');
  assert.ok(entries.every((entry) => entry.status === 503));
  assert.ok(entries.every((entry) => entry.outcome === 'retry'));
  assert.match(entries[0]!.detail ?? '', /503/);
});

test('being told to slow down is recorded as such', async () => {
  clearLogs();
  mode = 'limited';
  await lookupWords(['delta'], { ...FAST, maxFailures: 1 });
  mode = 'ok';

  const entries = readLogs({ service: 'dictionary' }).entries;
  assert.ok(entries.length > 0);
  assert.ok(
    entries.every((entry) => entry.outcome === 'rate-limited'),
    'a 429 is not just another failure',
  );
  assert.equal(entries[0]!.status, 429);
});

test('a corpus download is recorded, and so is what went wrong with it', async () => {
  clearLogs();
  const ok = new Response('The lamp is old. The gear turns.', { status: 200 });
  await fetchCorpus('https://books.example.org/lamp.txt', async () => ok);

  const missing = new Response('nope', { status: 404 });
  await assert.rejects(() => fetchCorpus('https://books.example.org/gone.txt', async () => missing));

  await assert.rejects(() =>
    fetchCorpus('https://books.example.org/down.txt', () => Promise.reject(new Error('socket hang up'))),
  );

  const entries = readLogs({ service: 'corpus' }).entries;
  assert.equal(entries.length, 3, 'the one that worked and the two that did not');
  assert.deepEqual(entries.map((entry) => entry.outcome), ['ok', 'failed', 'failed']);
  assert.ok(entries.every((entry) => entry.subject === 'books.example.org'));
  assert.equal(entries[0]!.bytes, 32, 'how much came back is worth knowing for a book');
  assert.equal(entries[1]!.status, 404);
  assert.match(entries[2]!.detail ?? '', /socket hang up/, 'a connection that died says so');
});

/* ---------------- what the viewer asks for ---------------- */

test('the log can be read, filtered and asked for only what is new', async () => {
  clearLogs();
  mode = 'ok';
  await lookupWords(['echo'], FAST);
  const first = await (await fetch(`${base}/api/logs`)).json() as ApiLogPage;
  assert.ok(first.entries.length > 0);
  assert.equal(first.latest, first.entries[first.entries.length - 1]!.seq);
  assert.equal(first.dropped, 0);

  await lookupWords(['foxtrot'], FAST);
  const next = await (await fetch(`${base}/api/logs?since=${first.latest}`)).json() as ApiLogPage;
  assert.equal(next.entries.length, 1, 'only what happened after the last one seen');
  assert.equal(next.entries[0]!.subject, 'foxtrot');

  const filtered = await (await fetch(`${base}/api/logs?service=corpus`)).json() as ApiLogPage;
  assert.deepEqual(filtered.entries, [], 'nothing was fetched in this test');
});

test('clearing empties it', async () => {
  mode = 'ok';
  await lookupWords(['golf'], FAST);
  assert.ok(readLogs().entries.length > 0);

  const response = await fetch(`${base}/api/logs`, { method: 'DELETE' });
  assert.equal(response.ok, true);
  assert.deepEqual(readLogs().entries, []);
});

test('the file keeps what a restart would lose', async () => {
  clearLogs();
  mode = 'ok';
  await lookupWords(['hotel'], FAST);
  await flushLogs();

  const body = await readFile(LOG_FILE, 'utf8');
  const lines = body.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as ApiLogEntry);
  assert.ok(lines.some((entry) => entry.subject === 'hotel'), 'it is on disk as well as in memory');

  const fromRoute = await (await fetch(`${base}/api/logs/file?limit=50`)).json() as { entries: ApiLogEntry[] };
  assert.ok(fromRoute.entries.some((entry) => entry.subject === 'hotel'));
  assert.equal(readLogs().file, LOG_FILE, 'and the viewer is told where it is');
});

/* ---------------- what must not be written down ---------------- */

test('a credential in an address is masked before it is stored', () => {
  assert.equal(
    redactUrl('https://api.example.com/v1/entries?word=lamp&key=SECRET123'),
    'https://api.example.com/v1/entries?word=lamp&key=%E2%80%A6',
    'an api key never reaches the log file or a screenshot of it',
  );
  assert.equal(
    redactUrl('https://api.example.com/e?app_id=abc&app_key=def&q=lamp'),
    'https://api.example.com/e?app_id=%E2%80%A6&app_key=%E2%80%A6&q=lamp',
  );
  assert.match(redactUrl('https://user:pw@example.com/x'), /%E2%80%A6@example\.com/);
  assert.equal(redactUrl('not a url'), 'not a url', 'and something unparseable is left alone');
});

test('the buffer is capped, and says how much it dropped', () => {
  clearLogs();
  for (let i = 0; i < 1_050; i += 1) {
    recordApiCall({ service: 'test', url: 'http://x/', outcome: 'ok', durationMs: 1 });
  }
  const page = readLogs({ limit: 2_000 });
  assert.equal(page.entries.length, 1_000, 'it does not grow without bound');
  assert.equal(page.dropped, 50, 'and it is honest about what fell off');
});
