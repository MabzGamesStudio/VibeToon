import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DURATION_OPTIONS,
  beatDuration,
  characterById,
  countWords,
  dialogDuration,
  emptyDialogData,
  formatDialogText,
  formatSoundCues,
  newBeat,
  newCharacter,
  newScene,
  newSet,
  sceneDuration,
  setById,
} from '../src/flows/dialog';
import type { DialogBeat, DialogFlowData } from '../src/types/project';

function line(text: string, over: Partial<DialogBeat> = {}): DialogBeat {
  return { ...newBeat('line'), text, ...over };
}

/** A small scene, built the way the editor builds one. */
function scene(): DialogFlowData {
  const data = emptyDialogData();
  const mabz = { ...newCharacter(0), name: 'Mabz', personality: 'Dry', voice: 'flat' };
  const workshop = { ...newSet(0), name: 'Workshop', description: 'Cluttered', timeOfDay: 'night' };
  const built = { ...newScene(), slug: 'Cold open', summary: 'The lamp will not light.', setId: workshop.id };
  built.beats = [
    line('It did not work yesterday.', { characterId: mabz.id }),
    { ...newBeat('action'), text: 'She turns the gear.' },
    { ...newBeat('sound'), text: 'A dry click.' },
  ];
  return { ...data, logline: 'A lamp refuses.', characters: [mabz], sets: [workshop], scenes: [built] };
}

/* ---------------- the pieces the editor makes ---------------- */

test('a new dialog flow is empty but usable', () => {
  const data = emptyDialogData();
  assert.equal(data.editor, 'dialog');
  assert.deepEqual([data.characters, data.sets, data.scenes], [[], [], []]);
  assert.equal(data.logline, '');
});

test('new characters, sets and scenes get their own ids', () => {
  const ids = [newCharacter(0).id, newCharacter(1).id, newSet(0).id, newScene().id, newBeat().id];
  assert.equal(new Set(ids).size, ids.length, 'nothing collides, so nothing is edited by accident');
  assert.equal(newBeat().type, 'line', 'a beat is a line unless it is told otherwise');
  assert.equal(newBeat('action').type, 'action');
  assert.ok(newScene().beats.length >= 0);
});

test('a character or set is found by id, and a missing one is not invented', () => {
  const data = scene();
  assert.equal(characterById(data, data.characters[0]!.id)?.name, 'Mabz');
  assert.equal(characterById(data, 'nope'), undefined);
  assert.equal(characterById(data, undefined), undefined);
  assert.equal(setById(data, data.sets[0]!.id)?.name, 'Workshop');
  assert.equal(setById(data, 'nope'), undefined);
});

/* ---------------- timing ---------------- */

test('words are counted the way a person would count them', () => {
  assert.equal(countWords('It did not work yesterday.'), 5);
  assert.equal(countWords('   spaced   out   words '), 3, 'runs of whitespace are one gap');
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   '), 0);
});

test('a line is timed from its length, and everything else takes the default', () => {
  const options = DEFAULT_DURATION_OPTIONS;
  const spoken = line('one two three four five six seven eight nine ten');
  assert.equal(beatDuration(spoken, options), 3.8, 'ten words at 2.6 a second');

  const action = { ...newBeat('action'), text: 'She turns the gear.' };
  assert.equal(beatDuration(action, options), options.defaultSeconds, 'an action is not read aloud');
});

test('an explicit duration wins over anything worked out', () => {
  const beat = line('one two three', { durationSec: 5 });
  assert.equal(beatDuration(beat, DEFAULT_DURATION_OPTIONS), 5);
  assert.equal(
    beatDuration(line('one two three', { durationSec: 0 }), DEFAULT_DURATION_OPTIONS),
    1.2,
    'zero means “work it out”, not “no time at all”',
  );
});

test('a duration is clamped at both ends', () => {
  const options = { ...DEFAULT_DURATION_OPTIONS, minSeconds: 1, maxSeconds: 3 };
  assert.equal(beatDuration(line('hi'), options), 1, 'a one-word line still needs a moment');
  assert.equal(beatDuration(line('x '.repeat(200)), options), 3, 'and a speech does not run away');
  assert.equal(beatDuration(line('one two three', { durationSec: 99 }), options), 3, 'even when set by hand');
});

test('a scene and the whole flow are the sum of their beats', () => {
  const data = scene();
  const beats = data.scenes[0]!.beats.map((beat) => beatDuration(beat, DEFAULT_DURATION_OPTIONS));
  const expected = Math.round(beats.reduce((sum, value) => sum + value, 0) * 10) / 10;

  assert.equal(sceneDuration(data.scenes[0]!, DEFAULT_DURATION_OPTIONS), expected);
  assert.equal(dialogDuration(data, DEFAULT_DURATION_OPTIONS), expected);
  assert.equal(dialogDuration(emptyDialogData(), DEFAULT_DURATION_OPTIONS), 0, 'nothing takes no time');
});

/* ---------------- what it writes ---------------- */

test('the script reads as a script', () => {
  const text = formatDialogText(scene(), 'Cold open');

  assert.match(text, /^COLD OPEN\n=+/, 'it opens with the title');
  assert.match(text, /Logline: A lamp refuses\./);
  assert.match(text, /CHARACTERS\n\s+MABZ — Dry — voice: flat/, 'a character carries what was written about them');
  assert.match(text, /SETS\n\s+Workshop — Cluttered — night/);
  assert.match(text, /SCENE 1 — COLD OPEN/);
  assert.match(text, /Set: Workshop \(night\)/);
  assert.match(text, /MABZ\n\s+It did not work yesterday\./, 'a line is under the name that says it');
});

test('a line with nobody assigned says so rather than pretending', () => {
  const data = emptyDialogData();
  const built = { ...newScene(), slug: 'x' };
  built.beats = [line('Who said this?')];
  const text = formatDialogText({ ...data, scenes: [built] }, 'Test');
  assert.match(text, /UNASSIGNED/);
});

test('an empty line is marked rather than left blank', () => {
  const data = emptyDialogData();
  const built = { ...newScene(), slug: 'x' };
  built.beats = [line('   ')];
  assert.match(formatDialogText({ ...data, scenes: [built] }, 'Test'), /\.\.\./);
});

test('a flow with nothing in it still writes something openable', () => {
  const text = formatDialogText(emptyDialogData(), '');
  assert.match(text, /UNTITLED/);
  assert.ok(text.trim().length > 0);
});

test('sound cues are pulled out on their own', () => {
  const data = scene();
  data.scenes[0]!.beats.push(line('Quietly now.', { characterId: data.characters[0]!.id, sound: 'a hinge' }));

  const cues = formatSoundCues(data);
  assert.match(cues, /A dry click\./, 'a sound beat is a cue');
  assert.match(cues, /a hinge/, 'and so is a sound hung on a line');
  assert.ok(!cues.includes('It did not work yesterday'), 'but the dialog itself is not');
});

test('a flow with no sounds says so instead of writing an empty file', () => {
  const cues = formatSoundCues(emptyDialogData());
  assert.ok(cues.trim().length > 0, 'the file is never empty, so it is never mistaken for a failed run');
});
