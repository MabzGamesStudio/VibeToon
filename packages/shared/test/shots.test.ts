import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  adoptDetection,
  detectShots,
  dropShortShots,
  embedFrame,
  emptyShotsFlowData,
  frameDifference,
  joinShots,
  shotsFile,
  shotsOf,
  shotsReport,
  splitShotAt,
  type FrameEmbedding,
} from '../src/flows/shots';

type Rgb = [number, number, number];

function flat(colour: Rgb, width = 32, height = 18): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...colour, 255], i * 4);
  return { width, height, data };
}

/** A room: a wall, with a box that moves across it as `t` goes 0..1. */
function room(wall: Rgb, t: number): Bitmap {
  const width = 32;
  const height = 18;
  const frame = flat(wall, width, height);
  const x0 = Math.round(t * 24);
  for (let y = 6; y < 12; y += 1) for (let x = x0; x < x0 + 6; x += 1) frame.data.set([30, 30, 30, 255], (y * width + x) * 4);
  return frame;
}

/**
 * A 10 second clip at 24 fps: a red room until frame 77, a blue room until
 * frame 181, a green room after. Each with a box sliding across.
 */
const FPS = 24;
const CUTS = [77, 181];
function clipFrame(frame: number): Bitmap {
  if (frame < CUTS[0]!) return room([200, 60, 50], frame / 77);
  if (frame < CUTS[1]!) return room([50, 80, 200], (frame - 77) / 104);
  return room([60, 170, 70], (frame - 181) / 59);
}

function clip(): { look: (time: number) => Promise<FrameEmbedding>; looked: number[] } {
  const looked: number[] = [];
  return {
    looked,
    look: async (time: number) => {
      const frame = Math.round(time * FPS);
      looked.push(frame);
      return embedFrame(clipFrame(frame));
    },
  };
}

test('a frame is the same as itself, and unlike a frame of another colour', () => {
  const red = embedFrame(flat([200, 60, 50]));
  assert.equal(frameDifference(red, red), 0);
  assert.ok(frameDifference(red, embedFrame(flat([50, 80, 200]))) > 0.5);
  assert.ok(frameDifference(red, embedFrame(flat([205, 62, 52]))) < 0.1, 'a slight change of light is not a cut');
});

test('a box moving across the same room is one shot', () => {
  const a = embedFrame(room([200, 60, 50], 0.1));
  const b = embedFrame(room([200, 60, 50], 0.3));
  assert.ok(frameDifference(a, b) < 0.3, `${frameDifference(a, b)}`);
});

test('the cuts are found to the exact frame', async () => {
  const { look } = clip();
  const found = await detectShots(10, { mode: 'fps', fps: 1, total: 10 }, { fps: FPS, threshold: 0.3, minShot: 0.5 }, look);
  assert.deepEqual(found.cuts.map((cut) => cut.frame), CUTS);
  assert.deepEqual(found.cuts.map((cut) => cut.time), CUTS.map((frame) => Math.round((frame / FPS) * 1000) / 1000));
});

test('the search halves the gap: a handful of looks per cut, not every frame', async () => {
  const { look, looked } = clip();
  const found = await detectShots(10, { mode: 'fps', fps: 0.5, total: 5 }, { fps: FPS, threshold: 0.3 }, look);
  assert.equal(found.cuts.length, 2);
  // Five samples, then about log2(48) ≈ 6 looks per cut.
  assert.ok(found.looks <= 5 + 2 * 7, `${found.looks} looks`);
  assert.equal(new Set(looked).size, looked.length, 'no frame is looked at twice');
});

test('a higher threshold finds fewer cuts', async () => {
  const soft = await detectShots(10, { mode: 'fps', fps: 1, total: 10 }, { fps: FPS, threshold: 0.99 }, clip().look);
  assert.equal(soft.cuts.length, 0);
});

test('a shot shorter than the minimum goes with the neighbour it is least unlike', () => {
  const cuts = [
    { frame: 48, time: 2, difference: 0.9 },
    { frame: 55, time: 2.3, difference: 0.4 },
    { frame: 120, time: 5, difference: 0.8 },
  ];
  // 2.0 to 2.3 is too short; its cut out (0.4) is weaker than its cut in (0.9).
  assert.deepEqual(dropShortShots(cuts, 8, 0.5).map((cut) => cut.time), [2, 5]);
  assert.deepEqual(dropShortShots(cuts, 8, 0).map((cut) => cut.time), [2, 2.3, 5]);
  // A first shot too short loses the cut that ends it.
  assert.deepEqual(dropShortShots([{ frame: 5, time: 0.2, difference: 0.9 }], 8, 0.5), []);
});

test('shots are the spans between cuts, from the start to the end', () => {
  assert.deepEqual(shotsOf([5, 2], 8), [
    { start: 0, end: 2 },
    { start: 2, end: 5 },
    { start: 5, end: 8 },
  ]);
  assert.deepEqual(shotsOf([], 3), [{ start: 0, end: 3 }]);
  assert.deepEqual(shotsOf([0, 3, 9], 8), [
    { start: 0, end: 3 },
    { start: 3, end: 8 },
  ]);
});

function split(): ReturnType<typeof emptyShotsFlowData> {
  const data = { ...emptyShotsFlowData(), options: { threshold: 0.3, minShot: 0.5, fps: 24 } };
  return adoptDetection(
    data,
    { cuts: [{ frame: 48, time: 2, difference: 0.9 }, { frame: 120, time: 5, difference: 0.7 }], samples: [], looks: 0 },
    { duration: 8, width: 640, height: 360 },
  );
}

test('a shot can be joined to the next', () => {
  const joined = joinShots(split(), 0);
  assert.deepEqual(joined.cuts, [5]);
  assert.equal(joined.edits, 1);
  assert.deepEqual(joinShots(joined, 5), joined, 'there is no shot after the last');
});

test('a shot can be split at a frame', () => {
  const data = splitShotAt(split(), 3.51);
  assert.deepEqual(data.cuts, [2, 3.5, 5], 'snapped to frame 84');
  assert.equal(data.selected, 2);
  assert.equal(splitShotAt(data, 3.5), data, 'splitting where a cut is does nothing');
  assert.equal(splitShotAt(data, 0), data);
  assert.equal(splitShotAt(data, 8), data);
});

test('the file lists each shot with its times and frames', () => {
  const file = JSON.parse(shotsFile(split()));
  assert.equal(file.kind, 'shots');
  assert.equal(file.shots.length, 3);
  assert.deepEqual(file.shots[1], { index: 2, start: 2, end: 5, duration: 3, startFrame: 48, endFrame: 119 });
  const report = shotsReport(joinShots(split(), 1));
  assert.match(report, /in \*\*2\*\* shot\(s\)/);
  assert.match(report, /1 change\(s\) made by hand/);
  assert.match(shotsReport(emptyShotsFlowData()), /Not split yet/);
});

test('each shot is recorded as a video when asked, or when the Shot clips output is wired', async () => {
  const { shotClipsWanted } = await import('../src/flows/shots');
  const { createConnection, createNode, createProject } = await import('../src/project/factory');
  const shots = { ...createNode('animation.video.shots', { x: 0, y: 0 }), id: 'shots' };
  const bg = { ...createNode('art.video.background', { x: 0, y: 0 }), id: 'bg' };
  const alone = { ...createProject('p'), nodes: [shots, bg] };
  assert.equal(shotClipsWanted(alone, shots), false);
  assert.equal(shotClipsWanted(alone, { ...shots, data: { ...shots.data, clips: true } as typeof shots.data }), true);
  const wired = { ...alone, connections: [createConnection({ nodeId: 'shots', portId: 'clips' }, { nodeId: 'bg', portId: 'video' })] };
  assert.equal(shotClipsWanted(wired, shots), true);
  const off = { ...wired, connections: wired.connections.map((c) => ({ ...c, settings: { ...c.settings, enabled: false } })) };
  assert.equal(shotClipsWanted(off, shots), false, 'not by a wire that is switched off');
});

test('frames are numbered by the video’s own measured frame rate, not the 24 fps default', async () => {
  const { emptyShotsFlowData, shotFrameRate, shotsFile, splitShotAt } = await import('../src/flows/shots');
  const base = { ...emptyShotsFlowData(), video: { hash: 'v', duration: 6, width: 64, height: 36 }, cuts: [2.5] };
  assert.equal(shotFrameRate(base), 24, 'nothing measured: the default');
  const at30 = { ...base, frameRate: 30, frameRateFor: 'v' };
  const file = JSON.parse(shotsFile(at30)) as { video: { fps: number }; shots: Array<{ startFrame: number; endFrame: number }> };
  assert.equal(file.video.fps, 30);
  assert.deepEqual(file.shots.map((shot) => [shot.startFrame, shot.endFrame]), [[0, 74], [75, 179]]);
  // A split snaps to a 30 fps frame: 1.01 s is frame 30, at 1 s.
  assert.ok(splitShotAt(at30, 1.01).cuts.includes(1));
});
