import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyGrammarFlowData } from '../src/flows/grammar';
import { emptyLexiconFlowData } from '../src/flows/lexicon';
import {
  DEFAULT_PALETTE_OPTIONS,
  applyEdits,
  derivePalette,
  emptyPaletteFlowData,
  type PaletteFlowData,
} from '../src/flows/palette';
import { emptyTextData } from '../src/flows/text';
import { DEFAULT_VECTORIZE_OPTIONS } from '../src/flows/vectorize';
import { migrateFlowData, migrateNode, migrateProject, normaliseFlowData } from '../src/project/migrate';
import { DEFAULT_EXTRACT_OPTIONS } from '../src/text/corpus';
import { DEFAULT_GRAMMAR_OPTIONS } from '../src/text/grammarDatabase';
import type { FlowData, FlowNode, Project } from '../src/types/project';
import { DEFAULT_RANDOM_TEXT_OPTIONS } from '../src/types/text';

function node(kind: string, data: FlowData): FlowNode {
  return { id: 'n1', kind, name: 'A flow', position: { x: 0, y: 0 }, notes: '', data, outputs: [] };
}

function project(nodes: FlowNode[]): Project {
  return {
    schema: 1,
    revision: 1,
    view: { pan: { x: 0, y: 0 }, zoom: 1 },
    id: 'prj_1',
    name: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: { fps: 24, width: 1280, height: 720, defaultShotSeconds: 2.5, styleNote: '' },
    nodes,
    connections: [],
  };
}

/** A flow saved before a setting existed, which is what a stored project is. */
function without(data: FlowData, path: string): FlowData {
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const parts = path.split('.');
  let cursor = copy;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  delete cursor[parts[parts.length - 1]!];
  return copy as unknown as FlowData;
}

/* ---------------- settings a stored project predates ---------------- */

test('a setting added after a project was saved is filled in', () => {
  // The bug this guards: an older project has no `grammarWeight`, the slider
  // reads `undefined`, and `undefined.toFixed(2)` takes the editor down.
  const old = without(emptyTextData(), 'options.grammarWeight');
  assert.equal((old as never as { options: { grammarWeight?: number } }).options.grammarWeight, undefined);

  const fixed = normaliseFlowData(old) as ReturnType<typeof emptyTextData>;
  assert.equal(fixed.options.grammarWeight, DEFAULT_RANDOM_TEXT_OPTIONS.grammarWeight);
  assert.ok(Number.isFinite(fixed.options.grammarWeight), 'and it is a number a slider can render');
});

test('every random text setting comes back, however old the project', () => {
  let data = emptyTextData();
  for (const key of Object.keys(DEFAULT_RANDOM_TEXT_OPTIONS)) data = without(data, `options.${key}`) as typeof data;
  for (const key of Object.keys(DEFAULT_RANDOM_TEXT_OPTIONS.length)) {
    data = without(emptyTextData(), `options.length.${key}`) as typeof data;
    const filled = normaliseFlowData(data) as typeof data;
    assert.ok(
      filled.options.length[key as keyof typeof filled.options.length] !== undefined,
      `length.${key} was not filled in`,
    );
  }

  const stripped = normaliseFlowData({ editor: 'text', input: '', output: '', lexicon: { lexemes: [] } } as never);
  const options = (stripped as ReturnType<typeof emptyTextData>).options;
  assert.deepEqual(
    Object.keys(options).sort(),
    Object.keys(DEFAULT_RANDOM_TEXT_OPTIONS).sort(),
    'a flow with no options at all still gets the full set',
  );
  assert.ok(
    Object.values(options).every((value) => value !== undefined),
    'and not one of them is undefined',
  );
});

test('a value that was saved is never overwritten by its default', () => {
  const data = emptyTextData();
  data.options.pickTemperature = 0.99;
  data.options.seed = 'take-4';
  const filled = normaliseFlowData(without(data, 'options.grammarWeight')) as typeof data;

  assert.equal(filled.options.pickTemperature, 0.99, 'a deliberate setting survives');
  assert.equal(filled.options.seed, 'take-4');
  assert.equal(filled.options.grammarWeight, DEFAULT_RANDOM_TEXT_OPTIONS.grammarWeight, 'only the gap is filled');
});

test('the word database and grammar flows are filled in the same way', () => {
  const lexicon = normaliseFlowData(without(emptyLexiconFlowData(), 'extract.maxWords')) as ReturnType<
    typeof emptyLexiconFlowData
  >;
  assert.equal(lexicon.extract.maxWords, DEFAULT_EXTRACT_OPTIONS.maxWords);
  assert.ok(lexicon.datasets.length > 0, 'and the corpora it already had are untouched');

  const grammar = normaliseFlowData(without(emptyGrammarFlowData(), 'options.minCount')) as ReturnType<
    typeof emptyGrammarFlowData
  >;
  assert.equal(grammar.options.minCount, DEFAULT_GRAMMAR_OPTIONS.minCount);
});

test('a flow that is already complete is handed back untouched', () => {
  const data = emptyTextData();
  assert.equal(normaliseFlowData(data), data, 'the same object, so nothing downstream sees a change');

  const unchanged = node('text.random', data);
  assert.equal(migrateNode(unchanged), unchanged);

  const whole = project([unchanged]);
  assert.equal(migrateProject(whole), whole, 'and a loaded project does not churn on every read');
});

test('a project is normalised as a whole, on the way out of storage', () => {
  const stale = project([
    node('text.random', without(emptyTextData(), 'options.grammarWeight')),
    node('text.grammar', without(emptyGrammarFlowData(), 'options.useForms')),
  ]);
  const fixed = migrateProject(stale);

  assert.notEqual(fixed, stale, 'something was missing, so something changed');
  const text = fixed.nodes[0]!.data as ReturnType<typeof emptyTextData>;
  const grammar = fixed.nodes[1]!.data as ReturnType<typeof emptyGrammarFlowData>;
  assert.equal(text.options.grammarWeight, DEFAULT_RANDOM_TEXT_OPTIONS.grammarWeight);
  assert.equal(grammar.options.useForms, DEFAULT_GRAMMAR_OPTIONS.useForms);
});

/* ---------------- a flow that changed editor ---------------- */

test('a flow whose editor changed keeps what still means the same thing', () => {
  const brief: FlowData = { editor: 'brief', fields: { look: 'muted', pacing: 'slow', target: '90s' } };

  const design = migrateFlowData('animation.character.design', brief) as { editor: string; fields: Record<string, string> };
  assert.equal(design.editor, 'design');
  assert.equal(design.fields.look, 'muted', 'the written spec survives the move to a drawing surface');

  const animatic = migrateFlowData('animation.animatic', brief) as { editor: string; targetSeconds: number; pacing: string };
  assert.equal(animatic.editor, 'animatic');
  assert.equal(animatic.targetSeconds, 90, 'and a written target becomes a real one');
  assert.match(animatic.pacing, /slow/);
});

test('data that fits no editor is replaced rather than carried', () => {
  const nonsense = { editor: 'dialog', logline: 'x', characters: [], sets: [], scenes: [] } as FlowData;
  const migrated = migrateFlowData('text.random', nonsense) as { editor: string };
  assert.equal(migrated.editor, 'text', 'the flow gets data its editor can actually open');
});

/* ---------------- a palette whose pins were kept by position ---------------- */

test('pins kept by position become edits kept by color group', () => {
  /*
   * Position is not identity: ask for four colors instead of eight and entry three
   * is a different color, so a pin stored against "3" would quietly apply to
   * something nobody chose. Converting the two needs the palette those positions
   * referred to, which is why this derives it from the histogram the flow carries.
   */
  const colors = [
    { r: 255, g: 0, b: 0, count: 100 },
    { r: 0, g: 255, b: 0, count: 50 },
  ];
  const histogram = {
    source: 'a.png',
    hash: 'h1',
    width: 4,
    height: 4,
    pixels: 150,
    transparent: 0,
    precision: 8,
    readAt: '2026-01-01T00:00:00.000Z',
    colors,
  };
  const legacy = {
    editor: 'palette',
    options: { ...DEFAULT_PALETTE_OPTIONS, count: 2, minDistance: 10 },
    histogram,
    pinned: { '1': '#000000' },
  } as unknown as FlowData;

  const migrated = normaliseFlowData(legacy) as PaletteFlowData;
  assert.deepEqual(migrated.edits.changed, { '#00ff00': '#000000' }, 'the pin followed its color');
  assert.deepEqual(migrated.edits.removed, []);
  assert.deepEqual(migrated.edits.added, []);

  const palette = applyEdits(derivePalette(histogram, migrated.options), migrated.edits);
  assert.equal(palette.entries[0]!.hex, '#ff0000');
  assert.equal(palette.entries[1]!.hex, '#000000');
});

test('a palette flow with no counted image has nothing for its pins to mean', () => {
  const legacy = {
    editor: 'palette',
    options: { ...DEFAULT_PALETTE_OPTIONS },
    pinned: { '0': '#000000' },
  } as unknown as FlowData;

  const migrated = normaliseFlowData(legacy) as PaletteFlowData;
  assert.deepEqual(migrated.edits, { changed: {}, removed: [], added: [] });
});

test('a palette flow already on edits is left as it is', () => {
  const data = { ...emptyPaletteFlowData(), edits: { changed: { '#ff0000': '#123456' }, removed: [], added: [] } };
  assert.equal(normaliseFlowData(data), data, 'nothing was missing, so nothing was rebuilt');
});

/* ---------------- a decomposition whose settings were renamed ---------------- */

test('a decomposition saved before the rebuild gets the settings it now needs', () => {
  // Every option was renamed when the flow moved onto edge detection. Reading a
  // missing one is how a tolerance arrives as `undefined` and a whole picture
  // comes back as one polygon with a thousand points in it.
  const old = {
    editor: 'vectorize',
    options: { lineWidth: 4, tolerance: 6, simplify: 1.2, fitToPixels: true, precision: 5 },
  } as unknown as FlowData;

  const migrated = normaliseFlowData(old) as unknown as { options: Record<string, unknown> };
  assert.equal(migrated.options.lineWidth, 4, 'a setting that was saved is never overwritten');
  assert.equal(migrated.options.detail, DEFAULT_VECTORIZE_OPTIONS.detail);
  assert.equal(migrated.options.edgeThreshold, DEFAULT_VECTORIZE_OPTIONS.edgeThreshold);
  assert.equal(migrated.options.maxPoints, DEFAULT_VECTORIZE_OPTIONS.maxPoints);
  assert.equal(migrated.options.refine, DEFAULT_VECTORIZE_OPTIONS.refine);
});
