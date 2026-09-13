import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveBoardFromDialog, planSync, timePanels } from '../src/flows/storyboard';
import type { DialogFlowData, Sketch, StoryboardScene } from '../src/types/project';

const SETTINGS = { defaultShotSeconds: 2, fps: 24, width: 1920, height: 1080 };

function dialog(): DialogFlowData {
  return {
    editor: 'dialog',
    logline: 'test',
    characters: [
      { id: 'c1', name: 'Mabz', personality: '', voice: '', color: '#fff' },
      { id: 'c2', name: 'Tully', personality: '', voice: '', color: '#000' },
    ],
    sets: [{ id: 's1', name: 'Workshop', description: '', timeOfDay: 'Night' }],
    scenes: [
      {
        id: 'scn1',
        slug: 'INT. WORKSHOP - NIGHT',
        setId: 's1',
        summary: 'It refuses.',
        beats: [
          { id: 'b1', type: 'action', text: 'Mabz drags the lamp round.' },
          { id: 'b2', type: 'action', text: 'The machine sits there.', sound: 'one small clack' },
          { id: 'b3', type: 'line', characterId: 'c1', text: 'It did it yesterday. Twice.' },
          { id: 'b4', type: 'line', characterId: 'c2', parenthetical: 'not moving', text: 'I am going to watch.' },
          { id: 'b5', type: 'direction', text: 'Push in on the gear.' },
        ],
      },
      {
        id: 'scn2',
        slug: 'EXT. STREET - DAY',
        summary: '',
        beats: [{ id: 'b6', type: 'action', text: 'They leave.' }],
      },
    ],
  };
}

test('one panel per beat by default, with shots from the rules', () => {
  const result = deriveBoardFromDialog(dialog(), 'shot for line: MCU\nshot for action: WS', SETTINGS);
  assert.equal(result.scenes.length, 2);
  const first = result.scenes[0]!;
  assert.equal(first.panels.length, 5);
  assert.equal(first.title, '1. INT. WORKSHOP - NIGHT');
  assert.equal(first.setName, 'Workshop');
  assert.equal(first.panels[0]!.shot, 'WS');
  assert.equal(first.panels[2]!.shot, 'MCU');
  assert.equal(first.panels[2]!.dialog, 'MABZ: It did it yesterday. Twice.');
  assert.equal(first.panels[3]!.dialog, 'TULLY (not moving): I am going to watch.');
  assert.equal(first.panels[4]!.camera, 'Push in on the gear.');
  assert.deepEqual(first.panels[0]!.sourceBeatIds, ['b1']);
});

test('merging consecutive action beats collapses them into one panel', () => {
  const result = deriveBoardFromDialog(dialog(), 'merge: consecutive action beats', SETTINGS);
  const panels = result.scenes[0]!.panels;
  assert.equal(panels.length, 4);
  assert.deepEqual(panels[0]!.sourceBeatIds, ['b1', 'b2']);
  assert.equal(panels[0]!.action, 'Mabz drags the lamp round. The machine sits there.');
  assert.equal(panels[0]!.sound, 'one small clack');
});

test('panel per line folds surrounding beats into the line panel', () => {
  const result = deriveBoardFromDialog(dialog(), 'panel per: line', SETTINGS);
  const panels = result.scenes[0]!.panels;
  assert.equal(panels.length, 2);
  assert.deepEqual(panels[0]!.sourceBeatIds, ['b1', 'b2', 'b3']);
  assert.equal(panels[0]!.dialog, 'MABZ: It did it yesterday. Twice.');
  // The trailing camera direction has no following line, so it rides the last panel.
  assert.deepEqual(panels[1]!.sourceBeatIds, ['b4', 'b5']);
  assert.equal(panels[1]!.camera, 'Push in on the gear.');
});

test('panel per scene makes one panel holding the whole scene', () => {
  const result = deriveBoardFromDialog(dialog(), 'panel per: scene\nshot default: WS', SETTINGS);
  assert.equal(result.scenes[0]!.panels.length, 1);
  assert.equal(result.scenes[0]!.panels[0]!.sourceBeatIds.length, 5);
});

test('ignore drops beat types, carry copies fields, scenes filters', () => {
  const result = deriveBoardFromDialog(
    dialog(),
    'ignore: direction\ncarry: sound -> notes\nscenes: 1',
    SETTINGS,
  );
  assert.equal(result.scenes.length, 1, 'scene 2 filtered out');
  const panels = result.scenes[0]!.panels;
  assert.equal(panels.length, 4, 'camera direction dropped');
  assert.equal(panels[1]!.notes, 'one small clack');
});

test('durations come from word count and are clamped by the rules', () => {
  const result = deriveBoardFromDialog(
    dialog(),
    'words per second: 2\nmin duration: 1\nmax duration: 2.5',
    SETTINGS,
  );
  for (const panel of result.scenes.flatMap((s) => s.panels)) {
    assert.ok(panel.durationSec >= 1 && panel.durationSec <= 2.5, `duration ${panel.durationSec} in range`);
  }
  const timed = timePanels(result.scenes, SETTINGS);
  assert.equal(timed[0]!.startSec, 0);
  assert.equal(timed[1]!.startSec, timed[0]!.endSec);
  assert.equal(timed[0]!.frames, Math.round(timed[0]!.panel.durationSec * 24));
});

test('a re-sync updates text but never destroys a sketch', () => {
  const source = dialog();
  const first = deriveBoardFromDialog(source, 'shot for action: WS', SETTINGS);
  const sketch: Sketch = {
    width: 480,
    height: 270,
    strokes: [{ points: [0, 0, 10, 10], width: 2, color: '#000' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const board: StoryboardScene[] = first.scenes.map((scene) => ({
    ...scene,
    panels: scene.panels.map((panel, index) =>
      index === 0 ? { ...panel, sketch, notes: 'keep me' } : panel,
    ),
  }));

  const edited = dialog();
  edited.scenes[0]!.beats[0]!.text = 'Mabz yanks the lamp round, hard.';
  const plan = planSync(board, deriveBoardFromDialog(edited, 'shot for action: WS', SETTINGS));

  const panel = plan.scenes[0]!.panels[0]!;
  assert.equal(panel.action, 'Mabz yanks the lamp round, hard.');
  assert.deepEqual(panel.sketch, sketch, 'sketch survives the sync');
  assert.equal(panel.notes, 'keep me', 'board-owned notes survive the sync');
  assert.equal(plan.counts.update, 1);
  assert.equal(plan.counts.unchanged, 5);
});

test('pinned panels keep their text', () => {
  const first = deriveBoardFromDialog(dialog(), '', SETTINGS);
  const board = first.scenes.map((scene, sceneIndex) => ({
    ...scene,
    panels: scene.panels.map((panel, index) =>
      sceneIndex === 0 && index === 0 ? { ...panel, pinned: true, action: 'my version' } : panel,
    ),
  }));

  const edited = dialog();
  edited.scenes[0]!.beats[0]!.text = 'something else entirely';
  const plan = planSync(board, deriveBoardFromDialog(edited, '', SETTINGS));
  assert.equal(plan.scenes[0]!.panels[0]!.action, 'my version');
  assert.equal(plan.counts.pinned, 1);
});

test('a deleted beat drops an empty panel but orphans a drawn one', () => {
  const first = deriveBoardFromDialog(dialog(), '', SETTINGS);
  const withSketch = first.scenes.map((scene) => ({
    ...scene,
    panels: scene.panels.map((panel) =>
      panel.sourceBeatIds.includes('b5')
        ? {
            ...panel,
            sketch: { width: 480, height: 270, strokes: [{ points: [1, 2], width: 2, color: '#000' }], updatedAt: 'x' },
          }
        : panel,
    ),
  }));

  const trimmed = dialog();
  // Remove the drawn camera beat and the undrawn line beat.
  trimmed.scenes[0]!.beats = trimmed.scenes[0]!.beats.filter((b) => b.id !== 'b5' && b.id !== 'b4');
  const plan = planSync(withSketch, deriveBoardFromDialog(trimmed, '', SETTINGS));

  assert.equal(plan.counts.remove, 1, 'the empty panel is dropped');
  assert.equal(plan.counts.orphan, 1, 'the drawn panel is kept');
  const orphanScene = plan.scenes.find((s) => s.title.includes('orphaned'));
  assert.ok(orphanScene, 'orphans land in their own scene');
  assert.equal(orphanScene!.panels[0]!.sketch!.strokes.length, 1);
});

test('hand-made panels are kept in their scene', () => {
  const first = deriveBoardFromDialog(dialog(), '', SETTINGS);
  const board = first.scenes.map((scene, index) =>
    index === 0
      ? {
          ...scene,
          panels: [
            ...scene.panels,
            {
              id: 'hand1',
              sourceBeatIds: [],
              shot: 'CU' as const,
              camera: '',
              action: 'insert I drew myself',
              dialog: '',
              sound: '',
              durationSec: 1.5,
              notes: '',
              sketch: null,
              pinned: false,
            },
          ],
        }
      : scene,
  );
  const plan = planSync(board, deriveBoardFromDialog(dialog(), '', SETTINGS));
  assert.ok(plan.scenes[0]!.panels.some((p) => p.id === 'hand1'));
  assert.equal(plan.counts.remove, 0);
});

test('the signature changes when the dialog or the rules change', () => {
  const a = deriveBoardFromDialog(dialog(), 'panel per: beat', SETTINGS).signature;
  const b = deriveBoardFromDialog(dialog(), 'panel per: beat', SETTINGS).signature;
  const c = deriveBoardFromDialog(dialog(), 'panel per: line', SETTINGS).signature;
  const edited = dialog();
  edited.logline = 'changed';
  const d = deriveBoardFromDialog(edited, 'panel per: beat', SETTINGS).signature;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});
