import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_FLOW_FILTER,
  FLOW_KINDS,
  activeFacetCount,
  filterFlowKinds,
  flowFacets,
  inputKinds,
  isFlowFilterEmpty,
  matchesFlowFilter,
  outputKinds,
  requireFlowKind,
  toggleFacet,
  type FlowFilter,
} from '../src/index';

const filter = (over: Partial<FlowFilter> = {}): FlowFilter => ({ ...EMPTY_FLOW_FILTER, ...over });
const ids = (defs: ReturnType<typeof filterFlowKinds>) => defs.map((def) => def.kind);

test('an empty filter lets the whole catalogue through', () => {
  assert.ok(isFlowFilterEmpty(EMPTY_FLOW_FILTER));
  assert.equal(filterFlowKinds(FLOW_KINDS, EMPTY_FLOW_FILTER).length, FLOW_KINDS.length);
  assert.equal(activeFacetCount(EMPTY_FLOW_FILTER), 0);
});

test('the text search reads labels, ids, summaries, port names and file names', () => {
  // A flow is remembered by any of these, so any of them should find it.
  for (const needle of ['colour palette', 'art.palette', 'commonest', 'palette.json']) {
    assert.ok(
      ids(filterFlowKinds(FLOW_KINDS, filter({ query: needle }))).includes('art.palette'),
      `“${needle}” did not find the palette flow`,
    );
  }
});

test('search words may arrive in any order', () => {
  // Someone types what they remember, not what is written.
  const forwards = ids(filterFlowKinds(FLOW_KINDS, filter({ query: 'skeletal rig' })));
  const backwards = ids(filterFlowKinds(FLOW_KINDS, filter({ query: 'rig skeletal' })));
  assert.deepEqual(backwards, forwards);
  assert.ok(forwards.includes('animation.rig'));
});

test('every search word has to appear, so a second word narrows', () => {
  const one = filterFlowKinds(FLOW_KINDS, filter({ query: 'database' }));
  const two = filterFlowKinds(FLOW_KINDS, filter({ query: 'database grammar' }));
  assert.ok(two.length < one.length, `${two.length} vs ${one.length}`);

  // Both survivors really do have both words: the grammar flow reads a word
  // database, and the random text flow takes a Grammar port. Matching on port
  // names is the point — it is how you find what a flow connects to.
  assert.ok(ids(two).includes('text.grammar'));
  assert.ok(ids(two).includes('text.random'));
  assert.ok(!ids(two).includes('text.corpus'), 'a flow with only one of the words is out');
});

test('filtering by what a flow takes finds somewhere to plug an image in', () => {
  const takesImage = filterFlowKinds(FLOW_KINDS, filter({ inputs: ['image'] }));
  assert.ok(takesImage.length > 0);
  assert.ok(ids(takesImage).includes('art.palette'));
  // And nothing in the result fails to accept one.
  for (const def of takesImage) assert.ok(inputKinds(def).has('image'), def.kind);
});

test('filtering by what a flow gives finds what could feed that port', () => {
  const givesImage = filterFlowKinds(FLOW_KINDS, filter({ outputs: ['image'] }));
  assert.ok(givesImage.length > 0);
  for (const def of givesImage) assert.ok(outputKinds(def).has('image'), def.kind);
  assert.ok(ids(givesImage).includes('animation.character.design'));
});

test('two values in one facet are alternatives, not extra requirements', () => {
  // Ticking two things and getting nothing back is a filter that feels broken.
  const image = filterFlowKinds(FLOW_KINDS, filter({ outputs: ['image'] }));
  const sets = filterFlowKinds(FLOW_KINDS, filter({ outputs: ['imageSet'] }));
  const either = filterFlowKinds(FLOW_KINDS, filter({ outputs: ['image', 'imageSet'] }));
  assert.ok(either.length >= Math.max(image.length, sets.length));
  const union = new Set([...ids(image), ...ids(sets)]);
  assert.deepEqual(new Set(ids(either)), union);
});

test('two different facets both have to hold', () => {
  const both = filterFlowKinds(FLOW_KINDS, filter({ categories: ['art'], inputs: ['image'] }));
  for (const def of both) {
    assert.equal(def.category, 'art');
    assert.ok(inputKinds(def).has('image'));
  }
  const artOnly = filterFlowKinds(FLOW_KINDS, filter({ categories: ['art'] }));
  assert.ok(both.length <= artOnly.length);
});

test('the text search and the facets combine', () => {
  const kind = requireFlowKind('art.palette');
  assert.ok(matchesFlowFilter(kind, filter({ query: 'palette', inputs: ['image'] })));
  // The query still has to match, whatever the facets say.
  assert.equal(matchesFlowFilter(kind, filter({ query: 'octopus', inputs: ['image'] })), false);
  // And the facets still have to hold, whatever the query says.
  assert.equal(matchesFlowFilter(kind, filter({ query: 'palette', categories: ['music'] })), false);
});

test('facet counts ignore their own facet, so a second tick shows what it would add', () => {
  const chosen = filter({ categories: ['art'] });
  const facets = flowFacets(FLOW_KINDS, chosen);
  const animation = facets.categories.find((option) => option.value === 'animation')!;
  // Were the count taken after its own facet, every other category would read 0
  // and the list would look empty the moment one was ticked.
  assert.ok(animation.count > 0, 'animation should still offer its flows');
  const art = facets.categories.find((option) => option.value === 'art')!;
  assert.equal(art.count, filterFlowKinds(FLOW_KINDS, filter({ categories: ['art'] })).length);
});

test('facet counts do respect the other facets', () => {
  const all = flowFacets(FLOW_KINDS, EMPTY_FLOW_FILTER);
  const narrowed = flowFacets(FLOW_KINDS, filter({ categories: ['art'] }));
  const kindOf = (facets: typeof all, value: string) =>
    facets.inputs.find((option) => option.value === value)?.count ?? 0;
  assert.ok(kindOf(narrowed, 'image') <= kindOf(all, 'image'));
  assert.ok(kindOf(narrowed, 'image') > 0, 'art flows do take images');
});

test('with nothing filtering, every option offered has something behind it', () => {
  const facets = flowFacets(FLOW_KINDS, EMPTY_FLOW_FILTER);
  for (const option of [...facets.categories, ...facets.inputs, ...facets.outputs]) {
    assert.ok(option.count > 0, `${option.value} is offered at 0`);
  }
});

test('an option the other facets rule out is still offered, at a count of nought', () => {
  // Removing it would reshuffle the row under the cursor as you tick things, and
  // "Music: 0" is the useful answer to why music flows and an image input cannot
  // be combined. Silence is not.
  const facets = flowFacets(FLOW_KINDS, filter({ inputs: ['image'] }));
  const music = facets.categories.find((option) => option.value === 'music');
  assert.ok(music, 'music should still be listed');
  assert.equal(music!.count, 0, 'and honestly reported as empty');

  // The set of options does not shrink as facets are ticked.
  const all = flowFacets(FLOW_KINDS, EMPTY_FLOW_FILTER);
  assert.equal(facets.categories.length, all.categories.length);
  assert.equal(facets.outputs.length, all.outputs.length);
});

test('a kind no flow has a port for is never offered at all', () => {
  // That one is permanent noise rather than a temporary nought.
  const facets = flowFacets(FLOW_KINDS, EMPTY_FLOW_FILTER);
  const offered = new Set(facets.inputs.map((option) => option.value));
  for (const kind of offered) {
    assert.ok(
      FLOW_KINDS.some((def) => inputKinds(def).has(kind)),
      `${kind} is offered but no flow takes one`,
    );
  }
});

test('a ticked option is still offered even once it matches nothing', () => {
  // Otherwise a filter can be got into and not out of.
  const stuck = filter({ categories: ['music'], inputs: ['image'] });
  const facets = flowFacets(FLOW_KINDS, stuck);
  assert.ok(facets.inputs.some((option) => option.value === 'image'));
  assert.ok(facets.categories.some((option) => option.value === 'music'));
});

test('every facet option is labelled in words rather than in its own id', () => {
  const facets = flowFacets(FLOW_KINDS, EMPTY_FLOW_FILTER);
  for (const option of [...facets.categories, ...facets.inputs, ...facets.outputs]) {
    assert.ok(option.label.trim().length > 0, `${option.value} has no label`);
    assert.notEqual(option.label, option.value, `${option.value} is labelled with its own id`);
  }
  // The pair that most needs saying in words: one file against a folder of them.
  assert.equal(facets.inputs.find((option) => option.value === 'image')!.label, 'Image');
  assert.equal(facets.inputs.find((option) => option.value === 'imageSet')!.label, 'Images (folder)');
});

test('ticking a facet value adds it and ticking again takes it away', () => {
  assert.deepEqual(toggleFacet<string>([], 'art'), ['art']);
  assert.deepEqual(toggleFacet(['art'], 'music'), ['art', 'music']);
  assert.deepEqual(toggleFacet(['art', 'music'], 'art'), ['music']);
  // And it never mutates what it was given.
  const before = ['art'];
  toggleFacet(before, 'music');
  assert.deepEqual(before, ['art']);
});

test('the active count is what the Filters badge shows, and ignores the query', () => {
  assert.equal(activeFacetCount(filter({ query: 'anything' })), 0);
  assert.equal(activeFacetCount(filter({ categories: ['art'], inputs: ['image'], outputs: ['json'] })), 3);
  assert.equal(isFlowFilterEmpty(filter({ query: 'x' })), false);
  assert.equal(isFlowFilterEmpty(filter({ outputs: ['json'] })), false);
});

test('a filter matching nothing returns nothing rather than everything', () => {
  // The failure that hides a bug: an over-narrow filter quietly falling open.
  const none = filterFlowKinds(FLOW_KINDS, filter({ query: 'zzzzz' }));
  assert.deepEqual(none, []);
  assert.deepEqual(filterFlowKinds(FLOW_KINDS, filter({ categories: ['music'], inputs: ['image'] })), []);
});

test('searching is case and padding insensitive', () => {
  const plain = ids(filterFlowKinds(FLOW_KINDS, filter({ query: 'palette' })));
  assert.deepEqual(ids(filterFlowKinds(FLOW_KINDS, filter({ query: '  PaLeTTe  ' }))), plain);
});
