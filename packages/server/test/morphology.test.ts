import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibetoon-morphology-'));
process.env.VIBETOON_DATA = dataRoot;
process.env.VIBETOON_LOG_FILE = 'off';

/**
 * A slice of AGID in its real format, including the parts that are easy to read
 * wrongly: a verb with three fields and one with four, the eight-field `be`, tags
 * that disown a form, variant levels, and explanations in braces.
 */
const AGID_FIXTURE = [
  'child N: children',
  'lamp N: lamps',
  'knife N: knives',
  'cactus N: cacti, cactuses 1, cactus 1.1',
  'gallows N: gallows',
  // Tags: `!` says the form belongs to a different word, `~` and `<` that it only
  // might belong to this one, `?` that it was never in the word list.
  'quern N: querns!',
  'wodge N: wodges~',
  'flange N: flanges<',
  'sprock N: sprocks?',
  // Level 2 is archaic, obscure, or a form AGID could find no evidence for.
  'brother N: brothers, brethren 2',
  // Three lemmas claim `crises` as their plural, and only one of them is a word.
  // AGID says which by leaving the `?` off its part of speech.
  'cris N?: crises',
  'crise N?: crises',
  'crisis N: crises',
  'old A: older | oldest',
  'good A: better | best',
  'quickly A: quicklier? | quickliest?',
  'walk V: walked | walking | walks',
  'hold V: held | held | holding | holds',
  'go V: went | gone | going | goes',
  'light V: lighted, lit 1 | lighting | lights',
  'be V: was | were | been | being | am | are | is | are',
  // English contains words that every JavaScript object claims to have already.
  'constructor N: constructors',
  'tostring V: tostringed | tostringing | tostrings',
  'valueof N: valueofs',
  'saw N: saws',
  'saw V: sawed | sawing | saws',
  'see V: saw | seen | seeing | sees',
  '',
].join('\n');

const SPECIALIST_FIXTURE = [
  'child,noun,children',
  'goose,noun,geese/goose',
  'walk,noun,walks',
  'walk,verb,walked,,walking,walks',
  'hold,verb,held,held,holding,holds',
  'beautiful,adj,,',
  'old,adj,older,oldest',
  'quickly,adv,,',
  '',
].join('\n');

const agidFile = path.join(dataRoot, 'agid-fixture.txt');
await writeFile(agidFile, AGID_FIXTURE, 'utf8');
process.env.VIBETOON_MORPHOLOGY_FILE = agidFile;

const { parseAgid, parseSpecialist, familyForType, morphologySourceById, MORPHOLOGY_SOURCES } =
  await import('../src/text/morphologySources');
const { buildMorphologyIndex, lookupForms, morphologyStatus, shardFor, resetMorphologyCache } =
  await import('../src/text/morphology');

after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function paradigm(text: string, lemma: string, family: string) {
  return parseAgid(text).find((entry) => entry.lemma === lemma && entry.family === family);
}

/* ---------------- reading AGID ---------------- */

test('a noun entry is a singular and a plural', () => {
  assert.deepEqual(paradigm(AGID_FIXTURE, 'child', 'noun')?.forms, {
    singular: 'child',
    plural: 'children',
  });
  assert.deepEqual(paradigm(AGID_FIXTURE, 'knife', 'noun')?.forms, {
    singular: 'knife',
    plural: 'knives',
  });
  assert.equal(
    paradigm(AGID_FIXTURE, 'gallows', 'noun')?.forms.plural,
    'gallows',
    'a word whose plural is its singular says so rather than being left out',
  );
});

test('the preferred alternative wins, and the explanations are not part of the word', () => {
  // `cacti` is level 0, `cactuses` level 1, `cactus` level 1.1.
  assert.equal(paradigm(AGID_FIXTURE, 'cactus', 'noun')?.forms.plural, 'cacti');
});

test('a form the dataset disowns is not taken', () => {
  // Each of these is AGID saying it is not sure the form belongs to this word,
  // which is the dataset guessing — the thing being avoided.
  assert.equal(paradigm(AGID_FIXTURE, 'quern', 'noun'), undefined, '`!` means another word’s form');
  assert.equal(paradigm(AGID_FIXTURE, 'wodge', 'noun'), undefined, '`~` means only a slight chance');
  assert.equal(paradigm(AGID_FIXTURE, 'flange', 'noun'), undefined, '`<` means only a good chance');
  assert.equal(paradigm(AGID_FIXTURE, 'sprock', 'noun'), undefined, '`?` means it was never in the word list');
  assert.equal(
    paradigm(AGID_FIXTURE, 'quickly', 'comparable'),
    undefined,
    'and so `quicklier` does not become a word',
  );
});

test('an archaic or unevidenced variant is left behind', () => {
  assert.equal(
    paradigm(AGID_FIXTURE, 'brother', 'noun')?.forms.plural,
    'brothers',
    'not `brethren`, which the dataset marks level 2',
  );
});

test('three verb fields mean the past participle matches the past; four spell it out', () => {
  assert.deepEqual(paradigm(AGID_FIXTURE, 'walk', 'verb')?.forms, {
    infinitive: 'walk',
    past: 'walked',
    past_participle: 'walked',
    present_progressive: 'walking',
    third_person_singular: 'walks',
  });
  assert.deepEqual(paradigm(AGID_FIXTURE, 'go', 'verb')?.forms, {
    infinitive: 'go',
    past: 'went',
    past_participle: 'gone',
    present_progressive: 'going',
    third_person_singular: 'goes',
  });
});

test('`be` is read from its own eight-field entry', () => {
  // The one word whose entry does not follow the pattern, and far too common to
  // skip: past, past 2nd, past participle, present participle, 1st, 2nd, 3rd, plural.
  assert.deepEqual(paradigm(AGID_FIXTURE, 'be', 'verb')?.forms, {
    infinitive: 'be',
    third_person_singular: 'is',
    present_progressive: 'being',
    past: 'was',
    past_participle: 'been',
  });
});

test('adjectives and adverbs share one set of forms, because the dataset cannot tell them apart', () => {
  assert.deepEqual(paradigm(AGID_FIXTURE, 'good', 'comparable')?.forms, {
    positive: 'good',
    comparative: 'better',
    superlative: 'best',
  });
  assert.equal(familyForType('adjective'), 'comparable');
  assert.equal(familyForType('adverb'), 'comparable');
  assert.equal(familyForType('noun'), 'noun');
  assert.equal(familyForType('number'), 'noun', 'a number counts like a noun');
  assert.equal(familyForType('determiner'), undefined, 'and a determiner has no forms at all');
  assert.equal(familyForType('unknown'), undefined);
});

/* ---------------- reading SPECIALIST ---------------- */

test('the SPECIALIST table is read for the same five forms', () => {
  const parsed = parseSpecialist(SPECIALIST_FIXTURE);
  const find = (lemma: string, family: string) =>
    parsed.find((entry) => entry.lemma === lemma && entry.family === family)?.forms;

  assert.deepEqual(find('child', 'noun'), { singular: 'child', plural: 'children' });
  assert.equal(find('goose', 'noun')?.plural, 'geese', 'the first alternative of a `/` pair');
  assert.deepEqual(find('hold', 'verb'), {
    infinitive: 'hold',
    third_person_singular: 'holds',
    present_progressive: 'holding',
    past: 'held',
    past_participle: 'held',
  });
  assert.equal(
    find('walk', 'verb')?.past_participle,
    'walked',
    'an empty field means the participle matches the past',
  );
  assert.deepEqual(find('old', 'comparable'), { positive: 'old', comparative: 'older', superlative: 'oldest' });
  assert.equal(
    find('beautiful', 'comparable'),
    undefined,
    'and a word with no inflected comparative is left out, deliberately',
  );
  assert.equal(find('quickly', 'comparable'), undefined);
});

test('both datasets are offered, and neither needs a key', () => {
  assert.deepEqual(MORPHOLOGY_SOURCES.map((source) => source.id), ['agid', 'specialist']);
  assert.ok(MORPHOLOGY_SOURCES.every((source) => source.url.startsWith('https://')));
  assert.equal(morphologySourceById('nonsense'), undefined);
});

/* ---------------- the local index ---------------- */

test('spellings are sharded on their first two letters', () => {
  assert.equal(shardFor('child'), 'ch');
  assert.equal(shardFor('Children'), 'ch', 'case does not put a word in another shard');
  assert.equal(shardFor('a'), '_', 'and anything that cannot make two letters shares one');
  assert.equal(shardFor('42'), '_');
});

test('nothing is known before the index is built', async () => {
  const status = await morphologyStatus();
  assert.equal(status.ready, false);
  assert.equal(status.paradigms, 0);
  assert.equal(await lookupForms('child', 'noun'), undefined, 'and a lookup says so rather than guessing');
});

test('building the index makes every form a way in', async () => {
  const built = await buildMorphologyIndex();
  assert.ok(built.meta.paradigms > 10, `${built.meta.paradigms} paradigms`);
  assert.ok(built.meta.spellings > built.meta.paradigms, 'every form is a key, not just the base word');

  const status = await morphologyStatus();
  assert.equal(status.ready, true);
  assert.equal(status.paradigms, built.meta.paradigms);
  assert.ok(status.builtAt);
  assert.match(status.reason, /VIBETOON_MORPHOLOGY_FILE/, 'and it says where the data came from');
});

test('a word is looked up by whichever of its forms the corpus happened to contain', async () => {
  // This is the whole reason every form is indexed: a corpus gives you
  // `children`, and nothing is allowed to strip letters off the end to find
  // `child`.
  const fromLemma = await lookupForms('child', 'noun');
  const fromPlural = await lookupForms('children', 'noun');
  assert.deepEqual(fromLemma, { singular: 'child', plural: 'children' });
  assert.deepEqual(fromPlural, fromLemma);

  assert.equal((await lookupForms('went', 'verb'))?.infinitive, 'go');
  assert.equal((await lookupForms('held', 'verb'))?.infinitive, 'hold');
  assert.equal((await lookupForms('best', 'adjective'))?.positive, 'good');
});

test('how a word is read decides which forms it has', async () => {
  // `saw` is the past of `see` and a tool you cut with, and the dataset holds
  // both. The type comes from the dictionary, so there is nothing to guess.
  assert.deepEqual(await lookupForms('saw', 'noun'), { singular: 'saw', plural: 'saws' });
  const asVerb = await lookupForms('saw', 'verb');
  assert.equal(
    asVerb?.infinitive,
    'saw',
    'the verb `saw` is its own word, and is preferred over `saw` as a form of `see`',
  );
});

test('an adjective and an adverb are answered from the same entry', async () => {
  assert.deepEqual(await lookupForms('old', 'adjective'), await lookupForms('old', 'adverb'));
});

test('a type with no forms is not looked up at all', async () => {
  assert.equal(await lookupForms('the', 'determiner'), undefined);
  assert.equal(await lookupForms('lamp', 'unknown'), undefined, 'including a word nobody has typed yet');
});

test('an ambiguous form is resolved by the dataset\u2019s own confidence, not by luck', async () => {
  // `crises` is listed under `crisis`, and also under `cris` and `crise`, which
  // are not words. Only `crisis` carries a confirmed part of speech. Without that
  // signal the answer is whichever the index saw first, and `crises` ends up with
  // a singular of `cris`.
  assert.deepEqual(await lookupForms('crises', 'noun'), { singular: 'crisis', plural: 'crises' });
  assert.equal(
    parseAgid(AGID_FIXTURE).find((entry) => entry.lemma === 'cris')?.certain,
    false,
    'and the uncertain entry is still kept — it is only ranked below',
  );
  assert.equal(parseAgid(AGID_FIXTURE).find((entry) => entry.lemma === 'crisis')?.certain, true);
});

test('a word that is also a property of every object is held like any other', async () => {
  // `shard['constructor']` on a plain object is a function, not a list of
  // paradigms, and reading it as one fails in a way that looks nothing like a
  // morphology problem. AGID contains all three of these.
  assert.deepEqual(await lookupForms('constructor', 'noun'), {
    singular: 'constructor',
    plural: 'constructors',
  });
  assert.equal((await lookupForms('tostringing', 'verb'))?.infinitive, 'tostring');
  assert.deepEqual(await lookupForms('valueof', 'noun'), { singular: 'valueof', plural: 'valueofs' });
  assert.equal(
    await lookupForms('hasOwnProperty', 'noun'),
    undefined,
    'and one the dataset does not have is still absent, rather than inherited',
  );
});

test('a word the dataset has never heard of comes back with nothing', async () => {
  assert.equal(
    await lookupForms('zzzznoword', 'noun'),
    undefined,
    'which is a fact about the dataset, and is reported as one rather than filled in',
  );
});

test('the shards survive being forgotten and read again', async () => {
  resetMorphologyCache();
  assert.deepEqual(await lookupForms('children', 'noun'), { singular: 'child', plural: 'children' });
});

test('rebuilding replaces the index rather than adding to it', async () => {
  const first = await buildMorphologyIndex();
  const second = await buildMorphologyIndex();
  assert.equal(second.meta.paradigms, first.meta.paradigms, 'the same file gives the same index');
  assert.equal(second.meta.spellings, first.meta.spellings);
});
