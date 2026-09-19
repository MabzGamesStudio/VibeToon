import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-dictionary-'));
process.env.VIBETOON_DATA = dataRoot;

/**
 * A stand-in for the dictionary service that can be told to misbehave, so the
 * batching, pacing, retrying and giving-up paths are all exercised without
 * depending on anything outside this machine.
 */
type Mode = 'ok' | 'limited' | 'flaky' | 'down' | 'forbidden' | 'slow' | 'several' | 'odd-pos' | 'absent';
let mode: Mode = 'ok';
let calls: string[] = [];
/** How many times each word has been asked about, for the flaky and limited modes. */
let asked = new Map<string, number>();
let retryAfter: string | null = '1';

const stub = express();
stub.get('/entries/en/:word', (req, res) => {
  const word = req.params.word;
  calls.push(word);
  const seen = (asked.get(word) ?? 0) + 1;
  asked.set(word, seen);

  if (mode === 'forbidden') {
    res.status(403).send('no');
    return;
  }
  if (mode === 'down') {
    res.status(503).send('unavailable');
    return;
  }
  if (mode === 'slow') {
    // Never answers, so the per-request timeout is what ends it.
    return;
  }
  if (mode === 'absent') {
    res.status(404).json({ title: 'No Definitions Found' });
    return;
  }
  if (mode === 'several') {
    res.json([
      {
        word,
        meanings: [
          { partOfSpeech: 'noun', definitions: [{ definition: 'What lets you see.' }] },
          { partOfSpeech: 'verb', definitions: [{ definition: 'To set burning.' }] },
          { partOfSpeech: 'adjective', definitions: [{ definition: 'Not heavy.' }] },
        ],
      },
    ]);
    return;
  }
  if (mode === 'odd-pos') {
    res.json([
      { word, meanings: [{ partOfSpeech: 'gerund', definitions: [{ definition: 'Something a gerund does.' }] }] },
    ]);
    return;
  }
  if ((mode === 'limited' || mode === 'flaky') && seen === 1) {
    if (retryAfter !== null) res.setHeader('retry-after', retryAfter);
    res.status(mode === 'limited' ? 429 : 502).send('slow down');
    return;
  }
  res.json([
    {
      word,
      meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: `A definition of ${word}.` }] }],
    },
  ]);
});
const stubServer = stub.listen(0);
const stubPort = await new Promise<number>((resolve) => {
  stubServer.on('listening', () => resolve((stubServer.address() as AddressInfo).port));
});
process.env.VIBETOON_DICTIONARY_URL = `http://127.0.0.1:${stubPort}/entries/en/{word}`;

const { lookupWords, retryAfterMs } = await import('../src/text/dictionary');

/** Fast settings: the waiting is what the defaults are for, not what is tested. */
const FAST = { retryDelaysMs: [0, 0, 0], pauseMs: 0, concurrency: 2 } as const;

before(() => {
  mode = 'ok';
});

after(async () => {
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

function reset(next: Mode = 'ok'): void {
  mode = next;
  calls = [];
  asked = new Map();
}

test('a lookup is one batch, and says what it did not get to', async () => {
  reset();
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const first = await lookupWords(words, { ...FAST, limit: 2 });

  assert.equal(first.found.length, 2, 'two words is all it was asked for');
  assert.equal(first.requested, 2, 'and two requests is all it made');
  assert.deepEqual(first.remaining, ['charlie', 'delta', 'echo'], 'the rest come back to ask about next');
  assert.equal(first.unreachable, undefined, 'a full batch is not a failure');

  const second = await lookupWords(first.remaining, { ...FAST, limit: 2 });
  assert.deepEqual(second.remaining, ['echo']);

  const third = await lookupWords(second.remaining, { ...FAST, limit: 2 });
  assert.deepEqual(third.remaining, [], 'and the queue empties');
  assert.equal(third.found.length, 1);
  assert.equal(calls.length, 5, 'each word was fetched exactly once across the three batches');
});

test('a word already on disk costs no request in a later batch', async () => {
  reset();
  const result = await lookupWords(['alpha', 'bravo'], { ...FAST, limit: 50 });
  assert.equal(result.cached, 2, 'both came out of the cache from the batching test');
  assert.equal(result.requested, 0);
  assert.equal(calls.length, 0);
  assert.match(result.meanings.alpha!.senses[0]!.description, /A definition of alpha/);
  assert.equal(result.meanings.alpha!.senses[0]!.type, 'noun');
});

/**
 * The service is asked once and answers with everything it has, so a word with
 * three meanings is one request and three senses.
 */
test('a word with several meanings comes back as several senses, from one request', async () => {
  reset('several');
  const result = await lookupWords(['light'], { ...FAST, limit: 50 });

  assert.equal(calls.length, 1, 'one request');
  assert.deepEqual(
    result.meanings.light!.senses.map((sense) => sense.type),
    ['noun', 'verb', 'adjective'],
  );
  assert.equal(result.meanings.light!.source, 'dictionary');
  assert.deepEqual(result.found, ['light']);
});

test('a definition with a part of speech nothing recognises keeps the definition', async () => {
  reset('odd-pos');
  const result = await lookupWords(['gerundy'], { ...FAST, limit: 50 });
  const meaning = result.meanings.gerundy!;

  assert.equal(meaning.senses.length, 1);
  assert.equal(meaning.senses[0]!.type, 'unknown', 'because that is what is known about its type');
  assert.equal(meaning.senses[0]!.description, 'Something a gerund does.');
  assert.equal(meaning.source, 'dictionary', 'the service did answer, and what it said is kept');
});

test('a word the service has no entry for is recorded so it is not asked twice', async () => {
  reset('absent');
  const result = await lookupWords(['zzzznoword'], { ...FAST, limit: 50 });

  assert.deepEqual(result.missing, ['zzzznoword']);
  assert.deepEqual(result.meanings.zzzznoword, {
    senses: [],
    source: 'none',
    fetchedAt: result.meanings.zzzznoword!.fetchedAt,
  });

  reset('absent');
  const again = await lookupWords(['zzzznoword'], { ...FAST, limit: 50 });
  assert.equal(calls.length, 0, 'the second time it is answered from the cache');
  assert.equal(again.meanings.zzzznoword!.source, 'none');
});

test('being asked to slow down is waited out, not treated as an answer', async () => {
  reset('limited');
  const result = await lookupWords(['foxtrot', 'golf'], { ...FAST, limit: 50 });

  assert.equal(result.found.length, 2, 'both words were defined in the end');
  assert.equal(result.rateLimited, 2, 'and both were told to slow down first');
  assert.equal(result.retryAfterMs, 1000, 'the wait the service asked for is reported');
  assert.equal(result.requested, 4, 'one refusal and one answer each');
  assert.equal(result.unreachable, undefined);
});

test('a one-off server error is retried', async () => {
  reset('flaky');
  const result = await lookupWords(['hotel', 'india'], { ...FAST, limit: 50 });
  assert.equal(result.found.length, 2);
  assert.equal(result.rateLimited, 0, 'a 502 is not the service asking us to slow down');
  assert.equal(result.unreachable, undefined, 'a hiccup does not end the batch');
});

test('a service that keeps refusing ends the batch early', async () => {
  reset('down');
  const words = ['juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec'];
  const result = await lookupWords(words, { ...FAST, limit: 50, maxFailures: 2 });

  assert.match(result.unreachable ?? '', /503/, 'the caller is told what the service said');
  assert.equal(result.found.length, 0);
  assert.ok(result.failed.length >= 2, `${result.failed.length} words ran out of retries`);
  assert.equal(
    result.failed.length + result.remaining.length,
    words.length,
    'and nothing is lost: every word is either failed or still to ask about',
  );
  assert.ok(calls.length < words.length * 4, `stopped after ${calls.length} requests`);
});

test('an answer that will never change is not retried', async () => {
  reset('forbidden');
  const result = await lookupWords(['romeo', 'sierra'], { ...FAST, limit: 50 });
  assert.match(result.unreachable ?? '', /403/);
  assert.deepEqual(
    [...asked.values()],
    calls.map(() => 1),
    'a 403 means the same thing however often it is asked, so no word is asked twice',
  );
  assert.ok(calls.length <= 2, `${calls.length} requests — only the ones already in flight`);
});

test('a request that never answers is given up on', async () => {
  reset('slow');
  const result = await lookupWords(['tango'], { ...FAST, limit: 50, timeoutMs: 60, maxFailures: 1 });
  assert.match(result.unreachable ?? '', /timed out/);
  assert.deepEqual(result.failed, ['tango']);
});

test('marks and numbers are typed without asking anyone', async () => {
  reset();
  const result = await lookupWords(['.', '42', "'"], { ...FAST, limit: 50 });
  assert.equal(calls.length, 0);
  assert.equal(result.meanings['.']!.senses[0]!.type, 'punctuation');
  assert.equal(result.meanings['.']!.source, 'token', 'read off the token, not claimed as a dictionary answer');
  assert.equal(result.meanings['42']!.senses[0]!.type, 'number');
  assert.equal(result.requested, 0);
});

test('a token no dictionary could know gets no entry rather than a guessed one', async () => {
  reset();
  // Not `—`, which is a mark the studio does describe. A section sign is not.
  const result = await lookupWords(['§'], { ...FAST, limit: 50 });
  assert.equal(calls.length, 0, 'no dictionary has an entry for it, so none is asked');
  assert.equal(
    result.meanings['§'],
    undefined,
    'nothing invents a type for it; it stays unlooked-up, which is what it is',
  );
});

test('Retry-After is read as seconds or as a date', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs('nonsense'), undefined);
  const inTwoSeconds = new Date(Date.now() + 2_000).toUTCString();
  const fromDate = retryAfterMs(inTwoSeconds)!;
  assert.ok(fromDate > 500 && fromDate <= 2_000, `${fromDate}ms read off an HTTP date`);
});

test('the route hands back a batch the caller can carry on from', async () => {
  reset();
  const { createApp } = await import('../src/app');
  const server = createApp().listen(0);
  const port = await new Promise<number>((resolve) => {
    server.on('listening', () => resolve((server.address() as AddressInfo).port));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/text/dictionary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ words: ['uniform', 'victor', 'whiskey'], limit: 1 }),
    });
    assert.equal(response.ok, true);
    const result = (await response.json()) as { found: string[]; remaining: string[] };
    assert.equal(result.found.length, 1);
    assert.deepEqual(result.remaining, ['victor', 'whiskey']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
