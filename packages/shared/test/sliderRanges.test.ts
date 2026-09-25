import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SLIDER_RANGES,
  effectiveRange,
  sliderRange,
  sliderRangeKeys,
  validateSliderOverrides,
} from '../src/registry/sliderRanges';
import { FLOW_KINDS } from '../src/registry/flowKinds';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(here, '../../client/src');

/** Range inputs that are not settings: a playhead's ends are the length of the clip. */
const NOT_SETTINGS = new Set(['components/editors/Playblast.tsx', 'components/common/Slider.tsx']);

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

async function sources(): Promise<Array<{ file: string; body: string }>> {
  return Promise.all(
    (await sourceFiles(CLIENT_SRC)).map(async (file) => ({ file: path.relative(CLIENT_SRC, file), body: await readFile(file, 'utf8') })),
  );
}

/** Every slider key the client names, however it names it. */
async function referencedKeys(): Promise<Array<{ key: string; file: string }>> {
  const refs: Array<{ key: string; file: string }> = [];
  for (const { file, body } of await sources()) {
    for (const pattern of [/\brange="([^"]+)"/g, /useSliderRange\('([^']+)'\)/g, /\brange: '([^']+)'/g]) {
      for (const match of body.matchAll(pattern)) refs.push({ key: match[1]!, file });
    }
  }
  return refs;
}

test('every slider in the studio names its range', async () => {
  const unnamed: string[] = [];
  for (const { file, body } of await sources()) {
    for (const match of body.matchAll(/<Slider\b([\s\S]*?)\/>/g)) {
      if (!/\brange=/.test(match[1]!)) unnamed.push(`${file}: ${match[0].slice(0, 80)}`);
    }
    if (NOT_SETTINGS.has(file)) continue;
    // A bare range input takes its ends from the registry too.
    for (const match of body.matchAll(/type="range"([\s\S]*?)\/>/g)) {
      if (/\bmin=\{-?[\d.]+\}|\bmax=\{-?[\d.]+\}/.test(match[1]!)) unnamed.push(`${file}: a range input with its ends written in`);
    }
  }
  assert.deepEqual(unnamed, []);
});

test('every range the studio names is in the registry, and every one in the registry is used', async () => {
  const refs = await referencedKeys();
  assert.ok(refs.length >= SLIDER_RANGES.length, `${refs.length} references`);
  const missing = refs.filter((ref) => !sliderRange(ref.key));
  assert.deepEqual(missing, [], `named but not registered: ${missing.map((ref) => `${ref.key} (${ref.file})`).join(', ')}`);
  const used = new Set(refs.map((ref) => ref.key));
  const unused = sliderRangeKeys().filter((key) => !used.has(key));
  assert.deepEqual(unused, [], `registered but no slider uses it: ${unused.join(', ')}`);
});

test('each registered range makes sense and belongs to real flows', () => {
  const kinds = new Set(FLOW_KINDS.map((kind) => kind.kind));
  assert.equal(new Set(sliderRangeKeys()).size, SLIDER_RANGES.length, 'keys are unique');
  for (const range of SLIDER_RANGES) {
    assert.ok(range.label.trim(), `${range.key}: no label`);
    assert.ok(range.section.trim(), `${range.key}: no section`);
    assert.ok(range.max > range.min, `${range.key}: ends the wrong way round`);
    assert.ok(range.step > 0 && range.step <= range.max - range.min, `${range.key}: step`);
    for (const flow of range.flows) assert.ok(kinds.has(flow), `${range.key}: no flow kind ${flow}`);
  }
});

test('a saved change is checked: unknown sliders, bad numbers and crossed ends are refused', () => {
  assert.equal(validateSliderOverrides({ nope: { max: 2 } }).ok, false);
  assert.equal(validateSliderOverrides({ 'map.land': { max: 'lots' } }).ok, false);
  assert.equal(validateSliderOverrides({ 'map.land': { min: 0.5, max: 0.2 } }).ok, false);
  assert.equal(validateSliderOverrides({ 'map.land': { step: 0 } }).ok, false);
  assert.equal(validateSliderOverrides({ 'map.land': { step: 5 } }).ok, false, 'a step wider than the range');
  assert.equal(validateSliderOverrides({ 'map.land': { max: Number.POSITIVE_INFINITY } }).ok, false);
  assert.equal(validateSliderOverrides([]).ok, false);
});

test('only real changes are kept: an end set back to its default is dropped', () => {
  const checked = validateSliderOverrides({ 'map.land': { min: 0, max: 0.3 }, 'rig.stretchMax': { max: 3 } });
  assert.ok(checked.ok);
  if (!checked.ok) return;
  assert.deepEqual(checked.value, { 'map.land': { max: 0.3 } });
});

test('a slider uses its defaults, or the changed ends, and falls back when a pair stops making sense', () => {
  assert.deepEqual(effectiveRange('rig.stretchMax', {}), { min: 1, max: 3, step: 0.01 });
  assert.deepEqual(effectiveRange('rig.stretchMax', { 'rig.stretchMax': { max: 6 } }), { min: 1, max: 6, step: 0.01 });
  assert.deepEqual(effectiveRange('rig.stretchMax', { 'rig.stretchMax': { min: 5 } }), { min: 1, max: 3, step: 0.01 });
  assert.deepEqual(effectiveRange('not.a.slider', {}), { min: 0, max: 1, step: 0.05 });
});

test('every flow with a slider is listed, so the settings page can be laid out by flow', () => {
  const flows = new Set(SLIDER_RANGES.flatMap((range) => range.flows));
  for (const expected of ['world.map', 'story.timeline', 'animation.rig', 'art.vectorize', 'text.random', 'art.palette']) {
    assert.ok(flows.has(expected), expected);
  }
});
