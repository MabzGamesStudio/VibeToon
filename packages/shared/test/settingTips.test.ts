import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SETTING_TIPS, settingTip, settingTipKeys } from '../src/registry/settingTips';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(here, '../../client/src');

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every `tip="…"` the studio asks for, with the file that asks for it. */
async function referencedTips(): Promise<Array<{ key: string; file: string }>> {
  const refs: Array<{ key: string; file: string }> = [];
  for (const file of await sourceFiles(CLIENT_SRC)) {
    const body = await readFile(file, 'utf8');
    for (const match of body.matchAll(/tip="([^"]+)"/g)) {
      refs.push({ key: match[1]!, file: path.relative(CLIENT_SRC, file) });
    }
  }
  return refs;
}

test('every setting the studio asks for a tip about has one', async () => {
  const refs = await referencedTips();
  assert.ok(refs.length > 30, `${refs.length} settings carry an (i)`);

  const missing = refs.filter((ref) => settingTip(ref.key) === undefined);
  assert.deepEqual(
    missing,
    [],
    `these are asked for but not written: ${missing.map((ref) => `${ref.key} (${ref.file})`).join(', ')}`,
  );
});

test('every tip written is one the studio actually shows', async () => {
  const asked = new Set((await referencedTips()).map((ref) => ref.key));
  const unused = settingTipKeys().filter((key) => !asked.has(key));
  assert.deepEqual(unused, [], `written but never shown: ${unused.join(', ')}`);
});

test('a tip says what the setting does and gives examples of it', () => {
  for (const [key, tip] of Object.entries(SETTING_TIPS)) {
    assert.ok(tip.what.trim().length > 20, `${key}: “${tip.what}” is not an explanation`);
    assert.ok(tip.what.trim().endsWith('.'), `${key}: the explanation should be a sentence`);
    assert.ok(tip.examples.length >= 1, `${key}: no examples`);
    for (const example of tip.examples) {
      assert.ok(example.trim().length > 3, `${key}: “${example}” is not an example`);
    }
    assert.equal(new Set(tip.examples).size, tip.examples.length, `${key}: the examples repeat`);
  }
});

test('an unwritten tip is nothing rather than an error', () => {
  assert.equal(settingTip('nothing.here'), undefined);
});
