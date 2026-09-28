import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_VIDEO_FRAMES,
  blendFits,
  emptyVideoMatchFlowData,
  fitAt,
  frameFound,
  frameTimes,
  readRigAnimation,
  rigAnimationOf,
  segmentsOf,
  summariseVideoMatch,
  videoMatchReport,
  videoMatchState,
  videoSourceOf,
  type VideoFrame,
  type VideoMatchFlowData,
} from '../src/flows/videoMatch';
import { normaliseFlowData } from '../src/project/migrate';
import { createConnection, createNode, createProject } from '../src/project/factory';
import type { RigFit } from '../src/flows/rigMatch';
import type { BoundRig } from '../src/flows/rigBind';
import { emptyRigFlowData } from '../src/flows/rig';
import type { ArtifactRef } from '../src/types/artifacts';

const fit = (x: number, angle = 0, rotation = 0): RigFit => ({
  pivot: { x: 0, y: 0 },
  x,
  y: 10,
  scale: 1,
  rotation,
  angles: { arm: angle },
  sizes: {},
});

const frame = (time: number, confidence: number, x = time * 10, angle = 0): VideoFrame => ({ time, confidence, fit: fit(x, angle) });

const bound = (): BoundRig => ({ rig: emptyRigFlowData('human'), image: { width: 100, height: 100, shapes: [] }, points: {} });

function matched(frames: VideoFrame[]): VideoMatchFlowData {
  return {
    ...emptyVideoMatchFlowData(),
    bound: bound(),
    boundHash: 'b1',
    video: { hash: 'v1', duration: 2, width: 640, height: 360 },
    frameSize: { width: 640, height: 360 },
    sampling: { mode: 'total', fps: 6, total: frames.length },
    frames,
  };
}

test('frames are sampled by rate or by total, never at the very end, and never too many', () => {
  assert.deepEqual(frameTimes(2, { mode: 'fps', fps: 2, total: 0 }), [0, 0.5, 1, 1.5]);
  assert.deepEqual(frameTimes(2, { mode: 'total', fps: 0, total: 4 }), [0, 0.5, 1, 1.5]);
  assert.deepEqual(frameTimes(1.2, { mode: 'fps', fps: 1, total: 0 }), [0, 1]);
  assert.equal(frameTimes(3600, { mode: 'fps', fps: 30, total: 0 }).length, MAX_VIDEO_FRAMES);
  assert.equal(frameTimes(10, { mode: 'total', fps: 0, total: 5000 }).length, MAX_VIDEO_FRAMES);
  assert.deepEqual(frameTimes(0, { mode: 'fps', fps: 6, total: 0 }), []);
  assert.deepEqual(frameTimes(5, { mode: 'total', fps: 0, total: 1 }), [0]);
});

test('frames below the threshold split the animation into segments', () => {
  const frames = [frame(0, 0.8), frame(0.5, 0.7), frame(1, 0.1), frame(1.5, 0.6), frame(2, 0.9)];
  const segments = segmentsOf(frames, 0.3);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0]!.frames, [0, 1]);
  assert.equal(segments[0]!.start, 0);
  assert.equal(segments[0]!.end, 0.5);
  assert.ok(Math.abs(segments[0]!.confidence - 0.75) < 1e-9);
  assert.deepEqual(segments[1]!.frames, [3, 4]);
  assert.equal(segmentsOf(frames, 0.05).length, 1, 'a threshold below every frame keeps one segment');
  assert.equal(segmentsOf(frames, 0.95).length, 0, 'and one above every frame keeps none');
});

test('a frame whose match failed outright is never found, whatever the threshold', () => {
  const failed: VideoFrame = { time: 1, confidence: 0.9, fit: null };
  assert.equal(frameFound(failed, 0), false);
  const segments = segmentsOf([frame(0, 0.9), failed, frame(2, 0.9)], 0);
  assert.equal(segments.length, 2);
});

test('segments follow time, whatever order the frames were matched in', () => {
  const frames = [frame(1, 0.9), frame(0, 0.9), frame(0.5, 0.1)];
  const segments = segmentsOf(frames, 0.3);
  assert.deepEqual(segments.map((segment) => segment.frames), [[1], [0]]);
});

test('between two frames the body is blended, turns the short way round', () => {
  const a = { ...fit(0, 170, 170), sizes: { arm: 1 } };
  const b = { ...fit(10, -170, -170), sizes: { arm: 2 } };
  const half = blendFits(a, b, 0.5);
  assert.equal(half.x, 5);
  assert.ok(Math.abs(Math.abs(half.angles.arm!) - 180) < 1e-9, 'across ±180, not through 0');
  assert.ok(Math.abs(Math.abs(half.rotation) - 180) < 1e-9);
  assert.equal(half.sizes.arm, 1.5);
  assert.deepEqual(blendFits(a, b, 0).x, 0);
  assert.deepEqual(blendFits(a, b, 2).x, 10, 'clamped');
});

test('playing back: inside a segment the body moves between frames, outside it is not there', () => {
  const frames = [frame(0, 0.9, 0), frame(1, 0.9, 10), frame(2, 0.1), frame(3, 0.9, 30)];
  const segments = segmentsOf(frames, 0.3);
  assert.equal(fitAt(frames, segments, 0.25)!.fit.x, 2.5);
  assert.equal(fitAt(frames, segments, 0.25)!.segment, 0);
  assert.equal(fitAt(frames, segments, 1.5), null, 'the character is gone');
  assert.equal(fitAt(frames, segments, 3)!.fit.x, 30, 'a segment of one frame is a still');
  assert.equal(fitAt(frames, segments, 3.2), null);
  assert.equal(fitAt(frames, segments, 3.2, 0.5)!.segment, 1, 'unless it is held');
});

test('the state: taken in, matched, part matched, and stale for another body, video or sampling', () => {
  assert.equal(videoMatchState(emptyVideoMatchFlowData(), 'b1', 'v1'), 'none');
  const four = matched([frame(0, 0.9), frame(0.5, 0.9), frame(1, 0.9), frame(1.5, 0.9)]);
  assert.equal(videoMatchState({ ...four, frames: [], video: undefined }, 'b1', 'v1'), 'unmatched');
  assert.equal(videoMatchState(four, 'b1', 'v1'), 'ready');
  assert.equal(videoMatchState({ ...four, frames: four.frames.slice(0, 2) }, 'b1', 'v1'), 'partial');
  assert.equal(videoMatchState(four, 'b2', 'v1'), 'stale');
  assert.equal(videoMatchState(four, 'b1', 'v2'), 'stale');
  assert.equal(videoMatchState({ ...four, sampling: { mode: 'fps', fps: 3, total: 4 } }, 'b1', 'v1'), 'stale', 'other frames would be sampled');
});

test('the animation written: one segment per run, each key a placement, a pose and sizes', () => {
  const data = matched([frame(0, 0.9, 0, 12.3456), frame(0.5, 0.8, 5), frame(1, 0.1), frame(1.5, 0.7, 15)]);
  const animation = rigAnimationOf(data)!;
  assert.equal(animation.kind, 'rigAnimation');
  assert.equal(animation.segments.length, 2);
  assert.equal(animation.dropped, 1);
  assert.equal(animation.segments[0]!.keys.length, 2);
  const key = animation.segments[0]!.keys[0]!;
  assert.equal(key.pose.arm, 12.35);
  assert.equal(key.placement.x, 0);
  assert.deepEqual(key.sizes, {});
  assert.equal(animation.video.sampled, 4);
  assert.ok(animation.bones.length > 0);
  assert.deepEqual(readRigAnimation(JSON.parse(JSON.stringify(animation))), animation);
  assert.equal(readRigAnimation({ kind: 'something else' }), null);
  assert.equal(rigAnimationOf(emptyVideoMatchFlowData()), null);
});

test('the report and the summary say what was found and what was dropped', () => {
  const data = matched([frame(0, 0.9), frame(0.5, 0.2), frame(1, 0.9)]);
  const report = videoMatchReport(data);
  assert.match(report, /\| 1 \| 0\.00s \| 0\.00s \| 1 \| 90% \|/);
  assert.match(report, /Dropped 1 frame\(s\): 0\.50s \(20%\)/);
  assert.match(summariseVideoMatch(data), /2 segment\(s\)/);
  assert.match(summariseVideoMatch(emptyVideoMatchFlowData()), /Nothing taken in/);
});

test('the video is the one wired in, or failing that the one uploaded here', () => {
  const base = createProject('Video');
  const node = createNode('animation.video.match', { x: 0, y: 0 });
  const uploaded: ArtifactRef = { port: 'source', kind: 'video', path: 'artifacts/x/video.mp4', fileName: 'video.mp4', hash: 'up', bytes: 1, generatedAt: '' };
  const own = { ...node, outputs: [uploaded] };
  assert.equal(videoSourceOf({ ...base, nodes: [own] }, own)?.artifact.hash, 'up');
  const clip = { ...createNode('production.render', { x: 0, y: 0 }), outputs: [{ ...uploaded, port: 'clip', hash: 'wired' }] };
  const project = { ...base, nodes: [clip, own], connections: [createConnection({ nodeId: clip.id, portId: 'clip' }, { nodeId: own.id, portId: 'video' })] };
  assert.deepEqual(videoSourceOf(project, own), { artifact: clip.outputs[0], wired: true });
  assert.equal(videoSourceOf({ ...base, nodes: [node] }, node), undefined);
});

test('a flow stored before a setting existed is filled in, not broken', () => {
  const old = { editor: 'videoMatch', bound: null, options: { features: 20 }, frames: [] } as unknown as VideoMatchFlowData;
  const fixed = normaliseFlowData(old) as VideoMatchFlowData;
  assert.equal(fixed.options.features, 20, 'what was set is kept');
  assert.equal(fixed.options.scaleRange, 1.6);
  assert.equal(fixed.sampling.mode, 'fps');
  assert.equal(typeof fixed.threshold, 'number');
  assert.equal(fixed.showBody, true);
  assert.equal(normaliseFlowData(fixed), fixed, 'and a whole one is left alone');
});
