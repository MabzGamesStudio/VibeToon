import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  applyMarks,
  backgroundFrameSize,
  backgroundInFrame,
  backgroundReport,
  backgroundWork,
  buildBackground,
  emptyVideoBackgroundFlowData,
  markMask,
  nearestFrame,
  steadyOffsets,
  areasOfFit,
  areasPicture,
  buildVoronoiBackground,
  sharedPaletteWork,
  voronoiBackgroundWork,
  BACKGROUND_PIXEL_BUDGET,
  PIXEL_CLEAR,
  PIXEL_REBUILT,
  PIXEL_STILL,
  type BackgroundOptions,
  type FrameOffset,
  type VoronoiBackgroundOptions,
} from '../src/flows/videoBackground';
import { fitWork, workPicture } from '../src/flows/voronoi';

const W = 20;
const H = 10;

/** A grey wall with a red box whose left edge is at `x`, three wide. */
function frame(x: number | null, noise = 0): Bitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let px = 0; px < W; px += 1) {
      const inBox = x !== null && px >= x && px < x + 3 && y >= 3 && y < 7;
      const grey = 120 + ((px + y) % 2 === 0 ? noise : -noise);
      data.set(inBox ? [220, 30, 30, 255] : [grey, grey, grey, 255], (y * W + px) * 4);
    }
  }
  return { width: W, height: H, data };
}

const alphaAt = (image: Bitmap, x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]!;
const redAt = (image: Bitmap, x: number, y: number) => image.data[(y * image.width + x) * 4]!;
const still: BackgroundOptions = { tolerance: 8, agreement: 30, steady: false, maxShift: 0, rebuild: false, patch: 4 };
const rebuilt: BackgroundOptions = { ...still, rebuild: true };
const zero: FrameOffset = { dx: 0, dy: 0 };
const at = (bitmap: Bitmap) => ({ bitmap, offset: zero });

/** A picture with something to line up on at every scale: blocks of colour, and finer speckle. */
function texture(width: number, height: number, seed = 7): Bitmap {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const blocks = Array.from({ length: Math.ceil(height / 8) * Math.ceil(width / 8) }, () => [random() * 255, random() * 255, random() * 255]);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const block = blocks[Math.floor(y / 8) * Math.ceil(width / 8) + Math.floor(x / 8)]!;
      const speck = random() * 40 - 20;
      data.set([block[0]! + speck, block[1]! + speck, block[2]! + speck, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** What a camera at `(sx, sy)` sees of a picture: a window of it, with a box in front where asked. */
function view(scene: Bitmap, width: number, height: number, sx: number, sy: number, box?: { x: number; y: number }): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((y + sy) * scene.width + (x + sx)) * 4;
      const inBox = box && x >= box.x && x < box.x + 6 && y >= box.y && y < box.y + 6;
      data.set(inBox ? [250, 250, 20, 255] : scene.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test('what never changes is the background, and what changed is clear when nothing rebuilds it', () => {
  // The box passes each spot in one frame of three.
  const { image, source, stats } = buildBackground([frame(2), frame(8), frame(14)], still);
  assert.equal(alphaAt(image, 0, 0), 255);
  assert.equal(image.data[0], 120, 'the wall’s own grey');
  assert.equal(source[0], PIXEL_STILL);
  for (const x of [2, 3, 4, 8, 9, 10, 14, 15, 16]) assert.equal(alphaAt(image, x, 5), 0, `(${x}, 5) had the box in a frame`);
  assert.equal(alphaAt(image, 6, 5), 255, 'a gap the box never passed');
  assert.equal(stats.still, W * H - 9 * 4);
  assert.equal(stats.rebuilt, 0);
});

test('what moved is rebuilt, patch by patch, from the frames that show the background there', () => {
  const { image, source, stats } = buildBackground([frame(2), frame(8), frame(14)], rebuilt);
  for (const x of [2, 3, 4, 8, 9, 10, 14, 15, 16]) {
    assert.equal(alphaAt(image, x, 5), 255, `(${x}, 5) is back`);
    assert.equal(redAt(image, x, 5), 120, `as the wall, not the box, at (${x}, 5)`);
    assert.equal(source[5 * W + x], PIXEL_REBUILT);
  }
  assert.equal(stats.rebuilt, 9 * 4);
  assert.equal(stats.still + stats.rebuilt, W * H);
});

test('a patch whose background is in fewer frames than the agreement is left clear', () => {
  const frames = [frame(2), frame(8), frame(14)];
  // Two frames in three show the wall at each spot the box passed.
  assert.equal(buildBackground(frames, { ...rebuilt, agreement: 66 }).stats.rebuilt, 36);
  const strict = buildBackground(frames, { ...rebuilt, agreement: 70 });
  assert.equal(strict.stats.rebuilt, 0);
  assert.equal(alphaAt(strict.image, 3, 5), 0);
  assert.equal(strict.source[5 * W + 3], PIXEL_CLEAR);
});

test('the biggest group of a patch’s versions wins: a box that lingers is taken for the background', () => {
  const lingering = buildBackground([frame(2), frame(2), frame(14)], rebuilt);
  assert.deepEqual([...lingering.image.data.slice((5 * W + 3) * 4, (5 * W + 3) * 4 + 4)], [220, 30, 30, 255]);
  assert.equal(redAt(lingering.image, 15, 5), 120, 'where it passed only once, the wall');
});

test('of two groups the same size, the one whose frames come one after another wins', () => {
  // At the box’s spot the frames go wall, box, wall, box, box, wall: three of each, but the box's two are side by side.
  const frames = [frame(null), frame(8), frame(null), frame(8), frame(8), frame(null)];
  const result = buildBackground(frames, rebuilt);
  assert.equal(redAt(result.image, 9, 5), 220, 'the box, seen in frames next to each other');
  // Swap them about and the wall is the steady one.
  const other = buildBackground([frame(8), frame(null), frame(8), frame(null), frame(null), frame(8)], rebuilt);
  assert.equal(redAt(other.image, 9, 5), 120);
});

test('a version joins a group only where nearly all of the patch matches, and the fill averages its frames', () => {
  const near = frame(null);
  near.data[0] = 126; // close to the wall: within the tolerance, so the same version
  const odd = frame(null);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) odd.data[(y * W + x) * 4] = 250; // a whole patch off
  const result = buildBackground([frame(null), near, odd, frame(null)], rebuilt);
  // (0, 0) changed (126 and 250 against 120): rebuilt from the three frames that agree with the first, which average 122.
  assert.equal(result.source[0], PIXEL_REBUILT);
  assert.equal(redAt(result.image, 0, 0), 122);
  // The tolerance decides how much change still counts as the same colour.
  const flicker = [frame(null, 0), frame(null, 6), frame(null, -6)];
  assert.equal(buildBackground(flicker, { ...still, tolerance: 2 }).stats.still, 0, 'too strict: the wall changes in every frame');
  assert.equal(buildBackground(flicker, still).stats.still, W * H, 'loose enough: it never changes');
});

test('an edge that wavers by a pixel from frame to frame is still the same edge, not something moving', () => {
  // A dark wall meeting a light one at x = 10 or 11 — compression noise, or a camera lined up to the nearest pixel.
  const edge = (at: number): Bitmap => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set(x < at ? [40, 40, 40, 255] : [200, 200, 200, 255], (y * W + x) * 4);
    return { width: W, height: H, data };
  };
  const result = buildBackground([edge(10), edge(11), edge(10), edge(11)], { ...rebuilt, agreement: 60 });
  assert.equal(result.stats.still, W * H - H, 'only the column the edge wavers over changed');
  assert.equal(result.stats.rebuilt, H, 'and every version of it is one group: rebuilt, not left clear');
  assert.equal(alphaAt(result.image, 10, 5), 255);
});

test('a shaking camera is followed: each frame is lined up with the others, and the background stays put', () => {
  const scene = texture(96, 72);
  const shakes = [
    [0, 0],
    [3, 1],
    [1, 4],
    [5, 2],
    [2, 2],
    [4, 5],
    [0, 3],
  ] as const;
  const frames = shakes.map(([sx, sy], index) => view(scene, 64, 48, 12 + sx, 10 + sy, { x: 4 + index * 7, y: 20 }));
  const offsets = steadyOffsets(frames, 8);
  // The middle of where the camera was is (2, 2): a camera further right sees the background further left.
  assert.deepEqual(offsets, shakes.map(([sx, sy]) => ({ dx: 2 - sx, dy: 2 - sy })));
  const steadied = buildBackground(frames, { ...rebuilt, steady: true, maxShift: 8 });
  assert.deepEqual(steadied.offsets, offsets);
  assert.equal(steadied.stats.moved, Math.round(Math.hypot(2, 3) * 10) / 10, 'the furthest: the frame the camera saw from (4, 5)');
  // Lined up, the scene never changes: everything but the box’s path is still, and that is rebuilt.
  const inside = (x: number, y: number) => x >= 5 && x < 59 && y >= 5 && y < 43;
  let wrong = 0;
  for (let y = 0; y < 48; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      if (!inside(x, y)) continue;
      const truth = ((y + 12) * scene.width + (x + 14)) * 4;
      const got = (y * 64 + x) * 4;
      if (Math.abs(steadied.image.data[got]! - scene.data[truth]!) > 3 || steadied.image.data[got + 3] !== 255) wrong += 1;
    }
  }
  assert.equal(wrong, 0, 'the background is the scene, as the middle frame sees it');
  // Not lined up, the shake makes nearly everything change.
  const shaken = buildBackground(frames, { ...rebuilt, steady: false });
  assert.ok(shaken.stats.still < steadied.stats.still / 4, `${shaken.stats.still} still unsteadied, ${steadied.stats.still} steadied`);
});

test('a pan is followed however far it goes, from frame to frame', () => {
  const scene = texture(400, 200, 11);
  const frames = Array.from({ length: 9 }, (_, index) => view(scene, 320, 180, index * 7, 5 + (index % 2)));
  const offsets = steadyOffsets(frames, 12);
  // The camera moves 7 px right a frame, and bobs a pixel: the middle frame is the fifth.
  assert.deepEqual(offsets, frames.map((_, index) => ({ dx: 28 - index * 7, dy: 0 - (index % 2) })));
  // With no room to look that far, it cannot follow.
  assert.notDeepEqual(steadyOffsets(frames, 2), offsets);
  // And a still camera stays put.
  assert.deepEqual(steadyOffsets([frames[0]!, frames[0]!, frames[0]!], 12), [zero, zero, zero]);
});

test('the work can be run a slice at a time, and comes to the same', () => {
  const frames = [frame(2), frame(8), frame(14)];
  const work = backgroundWork(frames, rebuilt);
  let slices = 0;
  let next = work.next();
  while (!next.done) {
    slices += 1;
    assert.ok(['steady', 'still', 'patches'].includes(next.value.stage));
    next = work.next();
  }
  assert.ok(slices > 1);
  assert.deepEqual([...next.value.image.data], [...buildBackground(frames, rebuilt).image.data]);
  // Offsets worked out before are used as they are.
  const given = buildBackground(frames, { ...rebuilt, steady: true, maxShift: 8 }, [zero, { dx: 1, dy: 0 }, zero]);
  assert.deepEqual(given.offsets[1], { dx: 1, dy: 0 });
});

test('a region marked on a frame puts that frame’s pixels into the background', () => {
  const frames = [frame(2), frame(8), frame(14)];
  const base = buildBackground(frames, still);
  // In the first frame the box is at 2..4; draw round 8..10 — clear wall there.
  const marked = applyMarks(base, [{ id: 'r', kind: 'region', time: 0, mode: 'include', points: [8, 3, 11, 3, 11, 7, 8, 7] }], () => at(frames[0]!));
  for (const x of [8, 9, 10]) assert.equal(alphaAt(marked.image, x, 5), 255, `(${x}, 5) is back`);
  assert.equal(marked.image.data[(5 * W + 9) * 4], 120, 'as the wall, from that frame');
  assert.equal(alphaAt(marked.image, 3, 5), 0, 'outside the region is untouched');
  assert.equal(marked.stats.marked, 12);
  assert.equal(alphaAt(base.image, 9, 5), 0, 'and the background it was laid on is not changed');
});

test('a painted stroke includes, and the eraser takes out', () => {
  const frames = [frame(2), frame(14)];
  const base = buildBackground(frames, still);
  const painted = applyMarks(
    base,
    [
      { id: 'a', kind: 'stroke', time: 1, mode: 'include', radius: 1.5, points: [3, 5] },
      { id: 'b', kind: 'stroke', time: 1, mode: 'exclude', radius: 0.6, points: [0.5, 0.5] },
    ],
    () => at(frames[1]!),
  );
  assert.equal(alphaAt(painted.image, 3, 5), 255);
  assert.equal(alphaAt(painted.image, 0, 0), 0, 'erased');
});

test('a mark on a frame the camera moved in lands where that frame shows the background', () => {
  const frames = [frame(null), frame(null)];
  const base = buildBackground(frames, still);
  const erased = applyMarks(base, [{ id: 'e', kind: 'stroke', time: 0, mode: 'exclude', radius: 0.6, points: [5.5, 5.5] }], () => ({ bitmap: frames[0]!, offset: { dx: 2, dy: 1 } }));
  assert.equal(alphaAt(erased.image, 3, 4), 0, 'the frame’s (5, 5) is the background’s (3, 4)');
  assert.equal(alphaAt(erased.image, 5, 5), 255);
  // And what is background already, laid over that frame, is moved the same way.
  const shown = backgroundInFrame(erased, { dx: 2, dy: 1 });
  assert.equal(shown[5 * W + 5], 0);
  assert.equal(shown[0], 0, 'the frame’s corner is outside the background');
  assert.equal(shown[5 * W + 6], 1);
});

test('a stroke covers the path between its points, a region its inside', () => {
  const stroke = markMask({ id: 's', kind: 'stroke', time: 0, mode: 'include', radius: 1, points: [2, 5, 17, 5] }, W, H);
  for (let x = 2; x <= 16; x += 1) assert.equal(stroke[5 * W + x], 1);
  assert.equal(stroke[0], 0);
  const region = markMask({ id: 'r', kind: 'region', time: 0, mode: 'include', points: [0, 0, 4, 0, 4, 4, 0, 4] }, W, H);
  assert.equal(region.reduce((sum, value) => sum + value, 0), 16);
  assert.equal(markMask({ id: 'x', kind: 'region', time: 0, mode: 'include', points: [0, 0, 4, 4] }, W, H).some(Boolean), false, 'two points is no region');
});

test('frames are read small enough to hold them all', () => {
  const small = backgroundFrameSize({ width: 640, height: 360 }, 24);
  assert.deepEqual(small, { width: 640, height: 360 });
  const many = backgroundFrameSize({ width: 3840, height: 2160 }, 300);
  assert.ok(many.width * many.height * 300 <= BACKGROUND_PIXEL_BUDGET * 1.01);
  assert.ok(Math.abs(many.height / many.width - 2160 / 3840) < 0.01, 'keeping its shape');
  assert.ok(backgroundFrameSize({ width: 4000, height: 1000 }, 1).width <= 1280);
});

test('the nearest frame read is used for a mark, and the report says what was kept', () => {
  const frames = [{ time: 0 }, { time: 0.5 }, { time: 1 }];
  assert.equal(nearestFrame(frames, 0.7)?.time, 0.5);
  const data = { ...emptyVideoBackgroundFlowData(), video: { duration: 2, width: 20, height: 10 }, frameSize: { width: 20, height: 10 } };
  const stats = buildBackground([frame(2), frame(8)], rebuilt).stats;
  const report = backgroundReport({ ...data, agreement: 30 }, stats);
  assert.match(report, /Never changed, within 8: 176 pixels \(88\.0%\)/);
  assert.match(report, /rebuilt from 16 px patches: 24 pixels \(12\.0%\)/);
  assert.match(report, /the picture did not move/);
  assert.match(backgroundReport(emptyVideoBackgroundFlowData(), null), /Not worked out yet/);
  const moved = backgroundReport(data, { ...stats, moved: 2.2 }, [{ time: 0, offset: { dx: 2, dy: -1 } }, { time: 0.5, offset: zero }]);
  assert.match(moved, /\| 0\.000s \| \+2 \| −1 \|/);
});

test('a wire that carries no video yet says which flow has to make it, not that nothing is wired', async () => {
  const { noVideoMessage } = await import('../src/index');
  const node = { id: 'bg', kind: 'art.video.background', name: 'Video Background', outputs: [], data: {} } as never;
  const source = { id: 'src', kind: 'animation.video.source', name: 'Clip', outputs: [], data: {} } as never;
  const wire = { id: 'c', from: { nodeId: 'src', portId: 'video' }, to: { nodeId: 'bg', portId: 'video' }, rules: '', settings: { enabled: true } } as never;
  const project = { nodes: [source, node], connections: [wire] } as never;
  assert.match(noVideoMessage(project, node), /Clip is wired in, but has not made its video yet/);
  assert.match(noVideoMessage({ nodes: [source, node], connections: [] } as never, node), /No video — wire one/);
});

test('a Video Background made before patches gets the new settings, and the new agreement if it had the old default', async () => {
  const { migrateProject } = await import('../src/project/migrate');
  const { createNode, createProject } = await import('../src/project/factory');
  const old = { editor: 'videoBackground', sampling: { mode: 'total', fps: 2, total: 24 }, tolerance: 8, agreement: 50, marks: [], current: null, tool: 'paint', brush: 12 };
  const tuned = { ...old, agreement: 70 };
  const nodes = [old, tuned].map((data, index) => ({ ...createNode('art.video.background', { x: 0, y: 0 }, `Bg ${index}`), id: `bg${index}`, data: data as never }));
  const migrated = migrateProject({ ...createProject('old'), nodes });
  const [a, b] = migrated.nodes.map((node) => node.data as ReturnType<typeof emptyVideoBackgroundFlowData>);
  assert.equal(a!.steady, true);
  assert.equal(a!.rebuild, true);
  assert.equal(a!.patch, 16);
  assert.equal(a!.maxShift, 24);
  assert.equal(a!.agreement, 30, 'the old default becomes the new one');
  assert.equal(b!.agreement, 70, 'a value someone chose is kept');
  // And one already up to date is left alone.
  const again = migrateProject(migrated);
  assert.deepEqual(again.nodes.map((node) => node.data), migrated.nodes.map((node) => node.data));
});

/* ---------------- by Voronoi areas ---------------- */

/** A scene of big flat blocks — green, blue and a yellow band — wider than the frame. */
function blockScene(width: number, height: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = y >= 20 && y < 28 ? [230, 210, 40] : x < width / 2 ? [40, 160, 70] : [40, 80, 200];
      data.set([...colour, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** What a camera at (sx, sy) sees of the scene, with a red box 10 across at (bx, by). */
function boxView(scene: Bitmap, sx: number, sy: number, bx: number, by: number): Bitmap {
  const width = 64;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inBox = x >= bx && x < bx + 10 && y >= by && y < by + 10;
      const from = ((y + sy) * scene.width + (x + sx)) * 4;
      data.set(inBox ? [230, 30, 40, 255] : scene.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const byAreas: VoronoiBackgroundOptions = { steady: false, maxShift: 0, nodes: 120, colours: 4, moving: 35 };
const scene = blockScene(80, 60);
const red = (image: Bitmap, p: number) => image.data[p * 4]! > 180 && image.data[p * 4 + 1]! < 80 && image.data[p * 4 + 2]! < 80;

test('one palette for every frame: k-means finds the colours they share', () => {
  const frames = [0, 1, 2].map((index) => boxView(scene, 8, 6, 4 + index * 20, 30));
  const work = sharedPaletteWork(frames, 4);
  let next = work.next();
  while (!next.done) next = work.next();
  const found = next.value.map((colour) => `${colour.r},${colour.g},${colour.b}`).sort();
  assert.deepEqual(found, ['230,210,40', '230,30,40', '40,160,70', '40,80,200']);
  const fewer = sharedPaletteWork([boxView(scene, 8, 6, 0, 0)], 12);
  let left = fewer.next();
  while (!left.done) left = fewer.next();
  assert.equal(left.value.length, 4, 'no more colours than there are');
});

test('a frame’s diagram as areas: cells that touch and share a colour are one', () => {
  const frame = boxView(scene, 8, 6, 30, 30);
  const palette = [
    { r: 40, g: 160, b: 70, a: 255 },
    { r: 40, g: 80, b: 200, a: 255 },
    { r: 230, g: 210, b: 40, a: 255 },
    { r: 230, g: 30, b: 40, a: 255 },
  ];
  const run = fitWork(workPicture(frame, 40_000), { nodes: 120, refine: 6 }, palette);
  let next = run.next();
  while (!next.done) next = run.next();
  const areas = areasOfFit(next.value);
  // Green, blue, the band either side of the box (one: the band runs behind it… or two, cut by it), and the red box.
  assert.ok(areas.sizes.length >= 4 && areas.sizes.length <= 6, `${areas.sizes.length} areas`);
  assert.equal(areas.sizes.reduce((sum, size) => sum + size, 0), 64 * 48);
  // Next to each other, two areas are never the same colour.
  for (let p = 0; p + 1 < areas.area.length; p += 1) {
    if ((p + 1) % 64 === 0) continue;
    const a = areas.area[p]!;
    const b = areas.area[p + 1]!;
    if (a !== b) assert.notEqual(areas.entries[a], areas.entries[b]);
  }
  const box = areas.area[35 * 64 + 35]!;
  assert.equal(areas.entries[box], 3, 'the box is the red area');
});

test('by Voronoi areas: the box that moves is animated, and the background is put back from the frames where it was not', () => {
  const frames = [0, 1, 2, 3, 4, 5].map((index) => boxView(scene, 8, 6, 2 + index * 10, 32));
  const result = buildVoronoiBackground(frames, byAreas);
  assert.ok(result.areas);
  assert.ok(result.stats.areas && result.stats.areas.animated >= 6, `${JSON.stringify(result.stats.areas)}: the box in each frame at least`);
  for (const [index, frame] of result.areas.frames.entries()) {
    const box = frame.area[37 * 64 + 6 + index * 10]!;
    assert.ok(frame.change[box]! > 0.9, `frame ${index}: the box changed by ${frame.change[box]}`);
    assert.ok(frame.change[frame.area[5 * 64 + 5]!]! < 0.2, `frame ${index}: the green barely changed`);
  }
  let redLeft = 0;
  for (let p = 0; p < 64 * 48; p += 1) if (red(result.image, p)) redLeft += 1;
  assert.equal(redLeft, 0, 'no box in the background');
  assert.ok(result.stats.rebuilt >= 6 * 100, `${result.stats.rebuilt} rebuilt: where the box went`);
  assert.equal(result.stats.still + result.stats.rebuilt, 64 * 48, 'every pixel is shown somewhere without the box');
  // Behind the box, the scene: the blue it stood on.
  const behind = (36 * 64 + 50) * 4;
  assert.deepEqual([...result.image.data.slice(behind, behind + 4)], [40, 80, 200, 255]);
});

test('the areas are worked out once: a change of how much counts as animated only lays the frames over each other again', () => {
  const frames = [0, 1, 2, 3].map((index) => boxView(scene, 8, 6, 2 + index * 14, 32));
  const first = buildVoronoiBackground(frames, byAreas);
  const stages = new Set<string>();
  const again = voronoiBackgroundWork(frames, { ...byAreas, moving: 90 }, undefined, first.areas);
  let next = again.next();
  while (!next.done) {
    stages.add(next.value.stage);
    next = again.next();
  }
  assert.deepEqual([...stages], ['combine']);
  assert.equal(next.value.areas, first.areas);
  assert.ok(next.value.stats.areas!.animated <= first.stats.areas!.animated);
  // Other nodes are other areas: drawn again.
  const redrawn = voronoiBackgroundWork(frames, { ...byAreas, nodes: 90 }, undefined, first.areas);
  let step = redrawn.next();
  const more = new Set<string>();
  while (!step.done) {
    more.add(step.value.stage);
    step = redrawn.next();
  }
  assert.ok(more.has('diagrams') && more.has('motion'));
  // Nothing ever counts as animated at 100% unless it is like nothing anywhere: the box still is.
  const strict = buildVoronoiBackground(frames, { ...byAreas, moving: 100 }, undefined, first.areas);
  assert.ok(strict.stats.areas!.animated >= 1);
});

test('by Voronoi areas, a shaking camera is followed and the box still taken out', () => {
  const big = blockScene(96, 72);
  const shakes = [
    [10, 8],
    [13, 9],
    [11, 12],
    [14, 10],
    [12, 11],
  ] as const;
  const frames = shakes.map(([sx, sy], index) => boxView(big, sx, sy, 2 + index * 12, 34));
  const result = buildVoronoiBackground(frames, { ...byAreas, steady: true, maxShift: 8 });
  assert.equal(result.offsets.length, 5);
  assert.ok(result.stats.moved > 0);
  let redLeft = 0;
  for (let p = 0; p < 64 * 48; p += 1) if (result.image.data[p * 4 + 3]! > 0 && red(result.image, p)) redLeft += 1;
  assert.equal(redLeft, 0);
  // The band is where the scene has it, as the middle of where the camera was sees it.
  const mid = { dx: 12, dy: 10 };
  const y = 24 - mid.dy + 1;
  assert.deepEqual([...result.image.data.slice((y * 64 + 30) * 4, (y * 64 + 30) * 4 + 3)], [230, 210, 40]);
});

test('a frame’s areas as a picture: each its colour, edges dark, animated ones striped', () => {
  const frames = [0, 1, 2].map((index) => boxView(scene, 8, 6, 2 + index * 20, 32));
  const result = buildVoronoiBackground(frames, byAreas);
  const picture = areasPicture(result.areas!, 0, 64, 48, 35);
  assert.deepEqual([picture.width, picture.height], [64, 48]);
  const at = (x: number, y: number) => [...picture.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  assert.deepEqual(at(5, 5), [40, 160, 70], 'the green, as the palette has it');
  const stripes = new Set<string>();
  for (let y = 33; y < 41; y += 1) for (let x = 3; x < 11; x += 1) stripes.add(at(x, y).join(','));
  assert.ok(stripes.has('255,40,60'), 'the box is striped: animated');
});

test('the report says the background was found by Voronoi areas, and how many were animated', () => {
  const frames = [0, 1, 2].map((index) => boxView(scene, 8, 6, 2 + index * 20, 32));
  const stats = buildVoronoiBackground(frames, byAreas).stats;
  const data = { ...emptyVideoBackgroundFlowData(), algorithm: 'voronoi' as const, nodes: 120, colours: 4, video: { duration: 1, width: 64, height: 48 }, frameSize: { width: 64, height: 48 } };
  const report = backgroundReport(data, stats);
  assert.match(report, /By Voronoi areas: each frame drawn as a diagram of 120 node\(s\) in the same 4 colour\(s\)/);
  assert.match(report, new RegExp(`${stats.areas!.animated} animated, changing by 35% or more`));
  assert.match(report, /Never in an animated area: /);
  assert.doesNotMatch(report, /patches/);
});

test('a Video Background made before Voronoi areas is by pixels and patches, with the new settings ready', async () => {
  const { migrateProject } = await import('../src/project/migrate');
  const { createNode, createProject } = await import('../src/project/factory');
  const { algorithm: _a, nodes: _n, colours: _c, moving: _m, showAreas: _s, ...before } = emptyVideoBackgroundFlowData();
  const node = { ...createNode('art.video.background', { x: 0, y: 0 }, 'Bg'), id: 'bg', data: { ...before, tolerance: 14 } as never };
  const migrated = migrateProject({ ...createProject('old'), nodes: [node] }).nodes[0]!.data as ReturnType<typeof emptyVideoBackgroundFlowData>;
  assert.deepEqual([migrated.algorithm, migrated.nodes, migrated.colours, migrated.moving, migrated.showAreas, migrated.tolerance], ['patches', 400, 12, 35, false, 14]);
});
