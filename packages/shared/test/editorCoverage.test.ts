import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FLOW_KINDS } from '../src/registry/flowKinds';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_TEST = here;
const CLIENT_EDITORS = path.resolve(here, '../../client/src/components/editors');
const SERVER_TEST = path.resolve(here, '../../server/test');

/**
 * A flow with an editor of its own is a flow with logic of its own, and logic of
 * its own needs tests of its own. This walks the registry rather than a list
 * kept by hand, so adding a custom editor without testing it fails the build
 * instead of being noticed a year later.
 *
 * `brief` is the generic editor every flow falls back to — it has no per-kind
 * logic, so it is not in here.
 */
const CUSTOM_EDITORS = [...new Set(FLOW_KINDS.map((kind) => kind.editor))]
  .filter((editor) => editor !== 'brief')
  .sort();

/** `text` is covered by `text.test.ts`; `corpus` by `corpusFlow.test.ts`. Either name counts. */
function candidates(editor: string): string[] {
  return [`${editor}.test.ts`, `${editor}Flow.test.ts`];
}

async function files(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

function countTests(body: string): number {
  return body.match(/^test\(/gm)?.length ?? 0;
}

test('there is at least one custom editor to check', () => {
  assert.ok(CUSTOM_EDITORS.length >= 8, `${CUSTOM_EDITORS.join(', ')}`);
});

test('every flow editor has its own unit tests', async () => {
  const present = await files(SHARED_TEST);
  const missing = CUSTOM_EDITORS.filter(
    (editor) => !candidates(editor).some((name) => present.includes(name)),
  );
  assert.deepEqual(
    missing,
    [],
    `no shared tests for: ${missing.map((editor) => `${editor} (add test/${editor}.test.ts)`).join(', ')}`,
  );
});

test('those tests are comprehensive rather than a file that exists', async () => {
  const present = await files(SHARED_TEST);
  const thin: string[] = [];

  for (const editor of CUSTOM_EDITORS) {
    const name = candidates(editor).find((candidate) => present.includes(candidate))!;
    const body = await readFile(path.join(SHARED_TEST, name), 'utf8');
    const count = countTests(body);
    // Eight is what it takes to cover a flow's data model, its edges and what it
    // writes. A file below that has not been thought about.
    if (count < 8) thin.push(`${name} has ${count}`);
  }

  assert.deepEqual(thin, [], `too few tests: ${thin.join(', ')}`);
});

test('every flow editor has a component for the studio to open', async () => {
  const present = await files(CLIENT_EDITORS);
  const registry = await readFile(path.join(CLIENT_EDITORS, 'FlowEditor.tsx'), 'utf8');

  const missing = CUSTOM_EDITORS.filter((editor) => !registry.includes(`case '${editor}':`));
  assert.deepEqual(missing, [], `not wired into FlowEditor: ${missing.join(', ')}`);
  assert.ok(present.length > CUSTOM_EDITORS.length, 'and each has a file of its own');
});

test('the flows that write files are tested against a running server too', async () => {
  const present = await files(SERVER_TEST);
  // These have a generator that writes artifacts, so what they write is worth
  // checking end to end and not only as a pure function.
  const withGenerators = [
    'corpus',
    'dictionary',
    'grammar',
    'lexicon',
    'text',
    'animatic',
    'design',
    'palette',
    'rig',
  ];
  const missing = withGenerators.filter(
    (editor) => !candidates(editor).some((name) => present.includes(name)),
  );
  assert.deepEqual(missing, [], `no server tests for: ${missing.join(', ')}`);
});

test('every flow kind declares an editor the studio knows how to open', () => {
  const known = new Set([...CUSTOM_EDITORS, 'brief']);
  const strange = FLOW_KINDS.filter((kind) => !known.has(kind.editor)).map((kind) => kind.kind);
  assert.deepEqual(strange, []);
});

test('every flow kind is coherent: a name, a summary, and somewhere to put its work', () => {
  const problems: string[] = [];
  for (const kind of FLOW_KINDS) {
    if (!kind.label.trim()) problems.push(`${kind.kind}: no label`);
    if (kind.summary.trim().length < 20) problems.push(`${kind.kind}: summary says too little`);
    if (kind.outputs.length === 0) problems.push(`${kind.kind}: writes nothing`);
    for (const port of [...kind.inputs, ...kind.outputs]) {
      if (port.kinds.length === 0) problems.push(`${kind.kind}.${port.id}: carries nothing`);
    }
    const ports = [...kind.inputs.map((port) => port.id), ...kind.outputs.map((port) => port.id)];
    if (new Set(kind.inputs.map((port) => port.id)).size !== kind.inputs.length) {
      problems.push(`${kind.kind}: two inputs share an id`);
    }
    if (new Set(kind.outputs.map((port) => port.id)).size !== kind.outputs.length) {
      problems.push(`${kind.kind}: two outputs share an id`);
    }
    if (ports.length === 0) problems.push(`${kind.kind}: no ports at all`);
  }
  assert.deepEqual(problems, []);
});

test('flow kind ids are unique, which is what the graph looks them up by', () => {
  const ids = FLOW_KINDS.map((kind) => kind.kind);
  assert.equal(new Set(ids).size, ids.length);
});
