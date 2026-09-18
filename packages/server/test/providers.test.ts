import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { DictionaryProviders } from '@vibetoon/shared';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-providers-'));
process.env.VIBETOON_DATA = dataRoot;
// No address override and no key, so the selection rules are the live ones.
delete process.env.VIBETOON_DICTIONARY_URL;
delete process.env.VIBETOON_DICTIONARY_KEY;
delete process.env.VIBETOON_DICTIONARY;
process.env.VIBETOON_LOG_FILE = 'off';

const { DICTIONARY_PROVIDERS, CUSTOM_PROVIDER, providerById, stripHtml } = await import(
  '../src/text/dictionaryProviders'
);
const { activeProvider, dictionaryUrlFor, hasDictionaryKey } = await import('../src/text/dictionary');
const { createApp } = await import('../src/app');

const server = createApp().listen(0);
const port = await new Promise<number>((resolve) => {
  server.on('listening', () => resolve((server.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

function read(id: string, payload: unknown) {
  return providerById(id)!.read(payload);
}

/** The first sense, for the cases where only that is under test. */
function first(id: string, payload: unknown) {
  return read(id, payload).senses[0] ?? {};
}

/* ---------------- each service answers in its own shape ---------------- */

test('the Free Dictionary shape is read', () => {
  assert.deepEqual(
    read('free-dictionary', [
      { word: 'lamp', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A source of light.' }] }] },
    ]),
    { senses: [{ partOfSpeech: 'noun', definition: 'A source of light.' }] },
  );
  assert.deepEqual(read('free-dictionary', []), { senses: [] }, 'an empty answer is no answer');
  assert.deepEqual(read('free-dictionary', { title: 'No Definitions Found' }), { senses: [] });
});

/**
 * The part that matters most: a word is several words, and reading only the first
 * meaning is how `light` ends up in a database as a noun and nothing else.
 */
test('every meaning is read, not just the first', () => {
  assert.deepEqual(
    read('free-dictionary', [
      {
        word: 'light',
        meanings: [
          { partOfSpeech: 'noun', definitions: [{ definition: 'What lets you see.' }] },
          { partOfSpeech: 'verb', definitions: [{ definition: 'To set burning.' }] },
        ],
      },
      { word: 'light', meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'Not heavy.' }] }] },
    ]),
    {
      senses: [
        { partOfSpeech: 'noun', definition: 'What lets you see.' },
        { partOfSpeech: 'verb', definition: 'To set burning.' },
        { partOfSpeech: 'adjective', definition: 'Not heavy.' },
      ],
    },
    'across entries as well as within one',
  );
});

test('a service listing the same part of speech twice describes one word, not two', () => {
  const reading = read('free-dictionary', [
    {
      word: 'run',
      meanings: [
        { partOfSpeech: 'verb', definitions: [{ definition: 'To move quickly.' }] },
        { partOfSpeech: 'verb', definitions: [{ definition: 'To operate a machine.' }] },
        { partOfSpeech: 'noun', definitions: [{ definition: 'An act of running.' }] },
      ],
    },
  ]);
  assert.deepEqual(reading.senses.map((sense) => sense.partOfSpeech), ['verb', 'noun']);
  assert.equal(reading.senses[0]!.definition, 'To move quickly.', 'and the first description wins');
});

test('the Wiktionary shape is read, and its HTML taken out', () => {
  assert.deepEqual(
    first('wiktionary', {
      en: [
        {
          partOfSpeech: 'Noun',
          definitions: [{ definition: 'A device that <a href="/wiki/emit">emits</a> light.' }],
        },
      ],
    }),
    { partOfSpeech: 'noun', definition: 'A device that emits light.' },
    'the part of speech is lower-cased and the markup is gone',
  );
  assert.deepEqual(read('wiktionary', { de: [{ partOfSpeech: 'Substantiv' }] }).senses, [], 'only English is read');
});

test('the Datamuse shape is read, tag and all', () => {
  assert.deepEqual(
    first('datamuse', [{ word: 'lamp', defs: ['n\tan artificial source of light'] }]),
    { partOfSpeech: 'noun', definition: 'an artificial source of light' },
    'the letter before the tab is the part of speech',
  );
  assert.equal(first('datamuse', [{ word: 'walk', defs: ['v\tto move on foot'] }]).partOfSpeech, 'verb');
  assert.equal(first('datamuse', [{ word: 'old', defs: ['adj\tof great age'] }]).partOfSpeech, 'adjective');
  assert.equal(first('datamuse', [{ word: 'fast', defs: ['adv\tquickly'] }]).partOfSpeech, 'adverb');
  assert.deepEqual(
    first('datamuse', [{ word: 'x', defs: ['u\tsomething unclassified'] }]),
    { definition: 'something unclassified' },
    'a tag it will not commit to is a definition with no type, which is a real state to be in',
  );
  assert.deepEqual(read('datamuse', []).senses, [], 'a word it does not have comes back empty, not 404');

  // Datamuse gives one definition per part of speech, so this is where its
  // several meanings come from.
  assert.deepEqual(
    read('datamuse', [
      { word: 'light', defs: ['n\twhat lets you see', 'v\tto set burning', 'adj\tnot heavy'] },
    ]).senses.map((sense) => sense.partOfSpeech),
    ['noun', 'verb', 'adjective'],
  );
});

test('the Merriam-Webster shape is read, and its suggestions are not', () => {
  assert.deepEqual(
    first('merriam-webster', [{ fl: 'noun', shortdef: ['a vessel for burning a flammable liquid'] }]),
    { partOfSpeech: 'noun', definition: 'a vessel for burning a flammable liquid' },
  );
  assert.deepEqual(
    read('merriam-webster', ['lamp', 'lamps', 'lump']).senses,
    [],
    'a word it does not know comes back as spellings, which is a miss',
  );
  assert.deepEqual(
    read('merriam-webster', [
      { fl: 'noun', shortdef: ['what lets you see'] },
      { fl: 'verb', shortdef: ['to set burning'] },
    ]).senses.map((sense) => sense.partOfSpeech),
    ['noun', 'verb'],
    'and each entry it returns is one part of speech',
  );
});

test('the Wordnik shape is read', () => {
  assert.deepEqual(
    first('wordnik', [{ partOfSpeech: 'noun', text: 'A household <i>device</i> that produces light.' }]),
    { partOfSpeech: 'noun', definition: 'A household device that produces light.' },
  );
  assert.deepEqual(read('wordnik', []).senses, []);
  assert.deepEqual(
    read('wordnik', [
      { partOfSpeech: 'noun', text: 'What lets you see.' },
      { partOfSpeech: 'verb', text: 'To set burning.' },
    ]).senses.map((sense) => sense.partOfSpeech),
    ['noun', 'verb'],
  );
});

test('a custom address is read for whichever shape it turns out to be', () => {
  assert.deepEqual(
    CUSTOM_PROVIDER.read([{ meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To walk.' }] }] }])
      .senses,
    [{ partOfSpeech: 'verb', definition: 'To walk.' }],
  );
  assert.deepEqual(
    CUSTOM_PROVIDER.read({ en: [{ partOfSpeech: 'Adjective', definitions: [{ definition: 'Bright.' }] }] })
      .senses,
    [{ partOfSpeech: 'adjective', definition: 'Bright.' }],
  );
  assert.deepEqual(CUSTOM_PROVIDER.read({ nothing: 'useful' }).senses, []);
});

test('markup and entities are taken out of a definition', () => {
  assert.equal(stripHtml('<b>A</b> &quot;source&quot; of&nbsp;light'), 'A "source" of light');
  assert.equal(stripHtml('one\n   two'), 'one two', 'and it comes back as one line');
});

/* ---------------- which one gets asked ---------------- */

test('every provider is a usable definition of a service', () => {
  assert.ok(DICTIONARY_PROVIDERS.length >= 4, `${DICTIONARY_PROVIDERS.length} services to choose from`);
  for (const provider of DICTIONARY_PROVIDERS) {
    assert.ok(provider.url.includes('{word}'), `${provider.id}: the address has nowhere to put the word`);
    assert.equal(
      provider.url.includes('{key}'),
      provider.needsKey,
      `${provider.id}: a key is either used or not needed, never asked for and dropped`,
    );
    assert.ok(provider.note.length > 40, `${provider.id}: says too little about itself`);
    if (provider.needsKey) assert.ok(provider.keyUrl, `${provider.id}: nowhere to get a key`);
  }
  assert.equal(new Set(DICTIONARY_PROVIDERS.map((p) => p.id)).size, DICTIONARY_PROVIDERS.length);
});

test('with nothing configured, the keyless default is asked', () => {
  assert.equal(hasDictionaryKey(), false);
  assert.equal(activeProvider().provider.id, 'free-dictionary');
  assert.equal(activeProvider().reason, 'the default');
  assert.equal(dictionaryUrlFor('lamp'), 'https://api.dictionaryapi.dev/api/v2/entries/en/lamp');
});

test('a word is escaped into the address rather than pasted into it', async () => {
  await fetch(`${base}/api/text/dictionary/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'datamuse' }),
  });
  // A token counted out of a corpus can be anything, so it must not be able to
  // add a parameter of its own to the address.
  assert.equal(dictionaryUrlFor('a&b=c'), 'https://api.datamuse.com/words?sp=a%26b%3Dc&md=dp&max=1');
  assert.equal(dictionaryUrlFor('ad hoc'), 'https://api.datamuse.com/words?sp=ad%20hoc&md=dp&max=1');
});

/* ---------------- choosing one from the studio ---------------- */

test('the studio is told what it can choose between, and never the key', async () => {
  const listed = (await (await fetch(`${base}/api/text/dictionary/providers`)).json()) as DictionaryProviders;
  assert.ok(listed.providers.length >= 4);
  assert.equal(listed.hasKey, false);
  assert.equal(listed.pinnedByEnvironment, false);
  assert.deepEqual(
    listed.providers.filter((provider) => provider.needsKey).map((provider) => provider.available),
    [false, false],
    'a service whose key is missing cannot be picked',
  );
  assert.ok(
    listed.providers.every((provider) => !JSON.stringify(provider).includes('key=')),
    'no address with a key in it is handed to the browser',
  );
});

test('switching is remembered, and the reason says so', async () => {
  const switched = (await (
    await fetch(`${base}/api/text/dictionary/provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'wiktionary' }),
    })
  ).json()) as DictionaryProviders;

  assert.equal(switched.activeId, 'wiktionary');
  assert.equal(switched.reason, 'chosen in the studio');
  assert.equal(activeProvider().provider.id, 'wiktionary', 'and the next lookup uses it');
  assert.match(dictionaryUrlFor('lamp'), /wiktionary\.org/);

  const again = (await (await fetch(`${base}/api/text/dictionary/providers`)).json()) as DictionaryProviders;
  assert.equal(again.activeId, 'wiktionary', 'the choice outlives the request that made it');
});

test('a service that needs a key it has not been given is refused, not half-used', async () => {
  const response = await fetch(`${base}/api/text/dictionary/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'merriam-webster' }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /VIBETOON_DICTIONARY_KEY/, 'and it says what to do about it');
  assert.equal(activeProvider().provider.id, 'wiktionary', 'nothing changed');
});

test('an unknown service is refused', async () => {
  const response = await fetch(`${base}/api/text/dictionary/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'not-a-dictionary' }),
  });
  assert.equal(response.status, 400);
});
