import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALGORITHM_GUIDES, FLOW_KINDS, NO_ALGORITHM, guideFor, type GuideStep } from '../src/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('every flow with an editor has a guide, or says why it needs none', () => {
  const missing = FLOW_KINDS.filter(
    (kind) => kind.maturity === 'editor' && !guideFor(kind.kind) && !NO_ALGORITHM[kind.kind],
  ).map((kind) => kind.kind);
  assert.deepEqual(missing, []);
});

test('no flow both has a guide and is said to need none', () => {
  const both = Object.keys(NO_ALGORITHM).filter((kind) => guideFor(kind));
  assert.deepEqual(both, []);
});

test('every guide and exemption names a flow that exists, once', () => {
  const kinds = new Set(FLOW_KINDS.map((kind) => kind.kind));
  const seen = new Set<string>();
  for (const guide of ALGORITHM_GUIDES) {
    for (const kind of guide.kinds) {
      assert.ok(kinds.has(kind), `${guide.title}: no flow kind ${kind}`);
      assert.ok(!seen.has(kind), `${kind} has two guides`);
      seen.add(kind);
    }
  }
  for (const kind of Object.keys(NO_ALGORITHM)) assert.ok(kinds.has(kind), `exemption for unknown kind ${kind}`);
});

function checkSteps(steps: readonly GuideStep[], where: string): void {
  assert.ok(steps.length > 0, `${where}: empty steps`);
  for (const step of steps) {
    assert.ok(step.title.trim(), `${where}: a step with no title`);
    if (step.kind === 'decision') assert.ok(step.no.trim(), `${where}: decision "${step.title}" says nothing for no`);
    if (step.kind === 'loop') checkSteps(step.steps, `${where} › ${step.title}`);
  }
}

test('every guide says it all four ways, and points at code that is there', () => {
  for (const guide of ALGORITHM_GUIDES) {
    const name = guide.title;
    assert.ok(guide.summary.length > 80, `${name}: summary too short`);
    checkSteps(guide.steps, name);
    assert.equal(guide.steps[0]!.kind, 'input', `${name}: steps should start with the input`);
    assert.equal(guide.steps[guide.steps.length - 1]!.kind, 'output', `${name}: steps should end with the output`);
    assert.ok(guide.pseudocode.split('\n').length >= 5, `${name}: pseudocode too short`);
    assert.ok(guide.sections.length >= 2, `${name}: needs at least two sections`);
    for (const section of guide.sections) assert.ok(section.heading && section.body, `${name}: an empty section`);
    assert.ok(guide.resources.length >= 1, `${name}: no resources`);
    for (const resource of guide.resources) {
      if (resource.url) assert.match(resource.url, /^https:\/\//, `${name}: ${resource.title} is not https`);
    }
    assert.ok(guide.source.length >= 1, `${name}: no source`);
    for (const entry of guide.source) {
      // `path — functions in it`.
      const [path, names = ''] = entry.split(' — ');
      const file = resolve(ROOT, path!.trim());
      assert.ok(existsSync(file), `${name}: ${path} does not exist`);
      // Names in code (camelCase or CONSTANTS) must be in the file they are said to be in.
      const text = readFileSync(file, 'utf8');
      for (const id of names.split(/[\s,]+/).filter((word) => /^[a-z]+[A-Z]\w*$|^[A-Z][A-Z_]{2,}$/.test(word))) {
        assert.ok(new RegExp(`\\b${id}\\b`).test(text), `${name}: ${id} is not in ${path}`);
      }
    }
  }
});
