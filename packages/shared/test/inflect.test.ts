import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, conjugate, formOf, inflect, lemmaOf, pluralize } from '../src/text/inflect';

test('regular verbs take the five forms', () => {
  assert.deepEqual(conjugate('walk'), {
    infinitive: 'walk',
    third_person_singular: 'walks',
    present_progressive: 'walking',
    past: 'walked',
    past_participle: 'walked',
  });
});

test('verb spelling rules', () => {
  assert.equal(conjugate('watch').third_person_singular, 'watches', 'a sibilant takes -es');
  assert.equal(conjugate('carry').third_person_singular, 'carries', 'consonant + y takes -ies');
  assert.equal(conjugate('go').third_person_singular, 'goes');
  assert.equal(conjugate('take').present_progressive, 'taking', 'a silent e is dropped');
  assert.equal(conjugate('see').present_progressive, 'seeing', 'but a double e is not');
  assert.equal(conjugate('die').present_progressive, 'dying');
  assert.equal(conjugate('stop').present_progressive, 'stopping', 'one syllable, consonant-vowel-consonant');
  assert.equal(conjugate('visit').present_progressive, 'visiting', 'but not when the stress is earlier');
  assert.equal(conjugate('carry').past, 'carried');
  assert.equal(conjugate('hope').past, 'hoped');
});

test('irregular verbs come from the table', () => {
  assert.equal(conjugate('go').past, 'went');
  assert.equal(conjugate('be').past_participle, 'been');
  assert.equal(conjugate('think').past, 'thought');
  assert.equal(conjugate('cut').past, 'cut');
  assert.equal(conjugate('write').past_participle, 'written');
});

test('modals only have the forms they have', () => {
  const can = conjugate('can');
  assert.equal(can.past, 'could');
  assert.equal(can.present_progressive, undefined, 'there is no “canning”');
  assert.equal(conjugate('must').past, undefined);
});

test('plurals', () => {
  assert.equal(pluralize('lamp'), 'lamps');
  assert.equal(pluralize('box'), 'boxes');
  assert.equal(pluralize('church'), 'churches');
  assert.equal(pluralize('city'), 'cities');
  assert.equal(pluralize('day'), 'days', 'a vowel before the y just takes s');
  assert.equal(pluralize('knife'), 'knives');
  assert.equal(pluralize('leaf'), 'leaves');
  assert.equal(pluralize('roof'), 'roofs', 'but not every f');
  assert.equal(pluralize('potato'), 'potatoes');
  assert.equal(pluralize('piano'), 'pianos');
  assert.equal(pluralize('child'), 'children');
  assert.equal(pluralize('person'), 'people');
  assert.equal(pluralize('sheep'), 'sheep');
});

test('comparatives take -er or more, depending on length', () => {
  assert.deepEqual(compare('cold'), { positive: 'cold', comparative: 'colder', superlative: 'coldest' });
  assert.equal(compare('big').comparative, 'bigger');
  assert.equal(compare('nice').comparative, 'nicer');
  assert.equal(compare('happy').comparative, 'happier');
  assert.equal(compare('careful').comparative, 'more careful');
  assert.equal(compare('beautiful').superlative, 'most beautiful');
  assert.equal(compare('quietly', 'adverb').comparative, 'more quietly', 'an -ly adverb never takes -er');
  assert.equal(compare('good').comparative, 'better');
  assert.equal(compare('bad').superlative, 'worst');
});

test('a lexeme gets the forms its type has, and nothing else', () => {
  assert.deepEqual(Object.keys(inflect('walk', 'verb')!).sort(), [
    'infinitive',
    'past',
    'past_participle',
    'present_progressive',
    'third_person_singular',
  ]);
  assert.deepEqual(Object.keys(inflect('lamp', 'noun')!).sort(), ['plural', 'singular']);
  assert.deepEqual(Object.keys(inflect('cold', 'adjective')!).sort(), [
    'comparative',
    'positive',
    'superlative',
  ]);
  assert.equal(inflect('the', 'determiner'), undefined, 'a determiner does not inflect');
  assert.equal(inflect('.', 'punctuation'), undefined);
});

test('an inflected spelling is traced back to its base form', () => {
  assert.equal(lemmaOf('walks', 'verb'), 'walk');
  assert.equal(lemmaOf('walking', 'verb'), 'walk');
  assert.equal(lemmaOf('walked', 'verb'), 'walk');
  assert.equal(lemmaOf('taking', 'verb'), 'take');
  assert.equal(lemmaOf('stopping', 'verb'), 'stop');
  assert.equal(lemmaOf('carried', 'verb'), 'carry');
  assert.equal(lemmaOf('went', 'verb'), 'go');
  assert.equal(lemmaOf('children', 'noun'), 'child');
  assert.equal(lemmaOf('knives', 'noun'), 'knife');
  assert.equal(lemmaOf('cities', 'noun'), 'city');
  assert.equal(lemmaOf('bigger', 'adjective'), 'big');
  assert.equal(lemmaOf('happiest', 'adjective'), 'happy');
  assert.equal(lemmaOf('better', 'adjective'), 'good');
  assert.equal(lemmaOf('better', 'adverb'), 'well', 'the same spelling, read as an adverb');
  assert.equal(lemmaOf('lamp', 'noun'), 'lamp', 'a base form is left alone');
});

test('the whole table is built from an inflected spelling, not just the base', () => {
  assert.deepEqual(inflect('walking', 'verb'), inflect('walk', 'verb'));
  assert.deepEqual(inflect('children', 'noun'), { singular: 'child', plural: 'children' });
});

test('which form a spelling is', () => {
  assert.equal(formOf('walks', 'verb'), 'third_person_singular');
  assert.equal(formOf('walking', 'verb'), 'present_progressive');
  assert.equal(formOf('walked', 'verb'), 'past', 'the first match wins when two forms share a spelling');
  assert.equal(formOf('lamps', 'noun'), 'plural');
  assert.equal(formOf('lamp', 'noun'), 'singular');
  assert.equal(formOf('coldest', 'adjective'), 'superlative');
  assert.equal(formOf('the', 'determiner'), undefined);
});

/* ---------------- singular nouns that end in s ---------------- */

test('a singular noun ending in s is not mistaken for a plural', () => {
  // Stripping the `s` off `cactus` gives a stem that pluralises straight back to
  // `cactus`, so the usual guard waves it through and the word database ends up
  // holding `cactu`.
  assert.equal(lemmaOf('cactus', 'noun'), 'cactus');
  assert.deepEqual(inflect('cactus', 'noun'), { singular: 'cactus', plural: 'cacti' });

  assert.equal(lemmaOf('analysis', 'noun'), 'analysis');
  assert.equal(inflect('analysis', 'noun')?.plural, 'analyses');

  for (const word of ['focus', 'fungus', 'nucleus', 'basis', 'crisis', 'thesis']) {
    assert.equal(lemmaOf(word, 'noun'), word, `${word} is already singular`);
  }
});

test('the -ss, -us and -is endings are read as singular', () => {
  assert.equal(lemmaOf('glass', 'noun'), 'glass');
  assert.equal(inflect('glass', 'noun')?.plural, 'glasses');
  assert.equal(lemmaOf('virus', 'noun'), 'virus');
  assert.equal(inflect('virus', 'noun')?.plural, 'viruses');
  assert.equal(lemmaOf('lens', 'noun'), 'lens', 'and the awkward ones are named');
  assert.equal(lemmaOf('gas', 'noun'), 'gas');
});

test('a real plural still resolves to its singular', () => {
  assert.equal(lemmaOf('crises', 'noun'), 'crisis', 'the reverse table is consulted first');
  assert.equal(lemmaOf('cacti', 'noun'), 'cactus');
  assert.equal(lemmaOf('glasses', 'noun'), 'glass');
  assert.equal(lemmaOf('lamps', 'noun'), 'lamp');
});

/* ---------------- an irregular verb behind a prefix ---------------- */

test('a prefixed verb keeps the pattern of the verb underneath it', () => {
  assert.equal(conjugate('forgive').past, 'forgave');
  assert.equal(conjugate('forgive').past_participle, 'forgiven');
  assert.equal(conjugate('understand').past, 'understood');
  assert.equal(conjugate('rewrite').past_participle, 'rewritten');
  assert.equal(conjugate('become').past, 'became');
  assert.equal(conjugate('overhear').past, 'overheard');
  assert.equal(conjugate('withdraw').past_participle, 'withdrawn');
  assert.equal(conjugate('undo').past, 'undid');
  assert.equal(conjugate('misread').past, 'misread');
  assert.equal(conjugate('outrun').past, 'outran');
});

test('a prefix that is not a prefix is left alone', () => {
  // `beat` is not `be` + `at`, and `unite` is not `un` + `ite`.
  assert.equal(conjugate('beat').past, 'beat');
  assert.equal(conjugate('unite').past, 'united');
  assert.equal(conjugate('render').past, 'rendered', 'not `re` + `nder`');
  assert.equal(conjugate('forest').past, 'forested');
});

test('a prefixed verb round-trips back to itself', () => {
  for (const verb of ['forgive', 'understand', 'rewrite', 'become']) {
    const forms = conjugate(verb);
    assert.equal(lemmaOf(forms.past!, 'verb'), verb, `${forms.past} should lemmatise to ${verb}`);
  }
});
