import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  animaticPayload,
  clearOverrides,
  cutLimitsFromRules,
  emptyAnimaticData,
  fitCutToTarget,
  parseDuration,
  resolveAnimaticCut,
  withOverride,
} from '../src/flows/animatic';
import { newPanel, storyboardPayload } from '../src/flows/storyboard';
import { defaultRulesForConnection } from '../src/project/factory';
import type { StoryboardScene } from '../src/types/project';

const SETTINGS = { fps: 24, width: 1920, height: 1080, defaultShotSeconds: 2, styleNote: '' };

function board() {
  const scenes: StoryboardScene[] = [
    {
      id: 'sc1',
      title: '1. INT. WORKSHOP - NIGHT',
      setName: 'Workshop',
      panels: [
        newPanel({ id: 'p1', shot: 'WS', durationSec: 2, action: 'Mabz drags the lamp round.' }),
        newPanel({ id: 'p2', shot: 'MCU', durationSec: 4, dialog: 'MABZ: It did it yesterday.' }),
        newPanel({ id: 'p3', shot: 'CU', durationSec: 3, sound: 'one small clack' }),
      ],
    },
  ];
  return storyboardPayload(scenes, SETTINGS);
}

test('a cut follows the board until the animatic changes something', () => {
  const cut = resolveAnimaticCut(board(), emptyAnimaticData(), SETTINGS);
  assert.equal(cut.clips.length, 3);
  assert.equal(cut.durationSec, 9);
  assert.equal(cut.boardDurationSec, 9);
  assert.equal(cut.adjustedCount, 0);
  assert.deepEqual(
    cut.clips.map((clip) => [clip.startSec, clip.endSec]),
    [
      [0, 2],
      [2, 6],
      [6, 9],
    ],
  );
  assert.equal(cut.clips[1]!.frames, 96, 'four seconds at 24fps');
  assert.equal(cut.clips[0]!.image, 'panels/panel-001.png');
});

test('holding a shot retimes the cut without touching the board', () => {
  const data = withOverride(emptyAnimaticData(), 'p2', { durationSec: 6.5 });
  const cut = resolveAnimaticCut(board(), data, SETTINGS);
  assert.equal(cut.clips[1]!.durationSec, 6.5);
  assert.equal(cut.clips[1]!.boardDurationSec, 4, 'what the board said is kept alongside');
  assert.equal(cut.clips[1]!.adjusted, true);
  assert.equal(cut.clips[2]!.startSec, 8.5, 'everything after it moves');
  assert.equal(cut.durationSec, 11.5);
  assert.equal(cut.boardDurationSec, 9, 'the board is unchanged');
  assert.equal(cut.adjustedCount, 1);
});

test('cutting a shot out drops it from the cut and offers it back', () => {
  const data = withOverride(emptyAnimaticData(), 'p1', { skip: true });
  const cut = resolveAnimaticCut(board(), data, SETTINGS);
  assert.equal(cut.clips.length, 2);
  assert.equal(cut.durationSec, 7);
  assert.equal(cut.clips[0]!.startSec, 0, 'the cut closes up');
  assert.deepEqual(
    cut.skipped.map((skip) => skip.panelId),
    ['p1'],
  );
  assert.equal(cut.boardDurationSec, 9, 'the board still has the shot');
});

test('resetting a shot leaves no trace in the project file', () => {
  const held = withOverride(emptyAnimaticData(), 'p2', { durationSec: 6.5 });
  assert.deepEqual(Object.keys(held.overrides), ['p2']);

  const released = withOverride(held, 'p2', { durationSec: undefined });
  assert.deepEqual(released.overrides, {}, 'an empty override is removed, not stored as noise');

  const noted = withOverride(held, 'p2', { note: 'let it land' });
  assert.equal(noted.overrides.p2?.note, 'let it land');
  assert.equal(noted.overrides.p2?.durationSec, 6.5);
  assert.deepEqual(clearOverrides(noted).overrides, {});
});

test('rules on the wire clamp every shot and can set the target', () => {
  const limits = cutLimitsFromRules('min duration: 2.5\nmax duration: 3\ntarget length: 1m30');
  assert.deepEqual(limits, { minDuration: 2.5, maxDuration: 3, targetSeconds: 90 });

  const cut = resolveAnimaticCut(board(), emptyAnimaticData(), SETTINGS, limits);
  assert.deepEqual(
    cut.clips.map((clip) => clip.durationSec),
    [2.5, 3, 3],
  );
  assert.equal(cut.clips[0]!.adjusted, true, 'a clamped shot counts as retimed');
});

test('durations are written the way people write them', () => {
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('1m30'), 90);
  assert.equal(parseDuration('1:30'), 90);
  assert.equal(parseDuration('2 min'), 120);
  assert.equal(parseDuration('1:07.5'), 67.5);
  assert.equal(parseDuration('soon'), undefined);
});

test('fitting to the target scales the shots and keeps their proportions', () => {
  const data = { ...emptyAnimaticData(), targetSeconds: 18 };
  const before = resolveAnimaticCut(board(), data, SETTINGS);
  assert.equal(before.offTargetSec, -9, 'nine seconds short of the target');

  const fitted = fitCutToTarget(data, before);
  const after = resolveAnimaticCut(board(), fitted, SETTINGS);
  assert.ok(Math.abs(after.durationSec - 18) < 0.05, `${after.durationSec}s`);
  assert.ok(Math.abs(after.offTargetSec) < 0.05);
  assert.deepEqual(
    after.clips.map((clip) => clip.durationSec),
    [4, 8, 6],
    'every shot doubled, so the rhythm is the same',
  );
});

test('the cut list says what it is and what changed', () => {
  const data = withOverride({ ...emptyAnimaticData(), targetSeconds: 10, pacing: 'let it breathe' }, 'p3', {
    durationSec: 5,
    note: 'hold on the gear',
  });
  const cut = resolveAnimaticCut(board(), data, SETTINGS);
  const payload = animaticPayload(cut, {
    name: 'Animatic',
    pacing: data.pacing,
    source: 'artifacts/flow_board/storyboard.json',
    audio: null,
  }) as Record<string, unknown>;

  assert.equal(payload.durationSec, 11);
  assert.equal(payload.boardDurationSec, 9);
  assert.equal(payload.targetSeconds, 10);
  assert.equal(payload.offTargetSec, 1);
  assert.equal(payload.clipCount, 3);
  assert.equal(payload.adjustedCount, 1);
  assert.equal(payload.pacing, 'let it breathe');

  const clips = payload.clips as Array<Record<string, unknown>>;
  assert.equal(clips.length, 3);
  assert.equal(clips[2]!.note, 'hold on the gear');
  assert.equal(clips[2]!.adjusted, true);
  assert.equal(clips[0]!.index, 1, 'clips are numbered from one for people to read');
});

test('with no board there is simply no cut', () => {
  const cut = resolveAnimaticCut(null, emptyAnimaticData(), SETTINGS);
  assert.deepEqual(cut.clips, []);
  assert.equal(cut.durationSec, 0);
  assert.equal(cut.fps, 24);
});

test('a wire onto the animatic is seeded per port', () => {
  // The storyboard wire is what a target length is about; the panel images wire
  // is just pictures, so it starts empty.
  assert.match(defaultRulesForConnection({ kind: 'animation.storyboard', portId: 'storyboard' }, { kind: 'animation.animatic', portId: 'storyboard' }), /target length/);
  assert.equal(defaultRulesForConnection({ kind: 'animation.storyboard', portId: 'panels' }, { kind: 'animation.animatic', portId: 'panels' }), '');
});
