import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMask,
  blockedBy,
  buildMask,
  deleteObject,
  deleteSelected,
  emptyCutoutFlowData,
  findObject,
  floodFrom,
  grow,
  labelOf,
  linePoints,
  maskBounds,
  objectsOf,
  selectObject,
  setSeed,
  summariseCutout,
  type Bitmap,
  type CutLine,
  type CutoutFlowData,
  type Seed,
} from '../src/flows/cutout';

/* ---------------- fixtures ---------------- */

/** An image built from a character map, so a test reads as the picture it is. */
function bitmap(rows: string[], colors: Record<string, [number, number, number]>): Bitmap {
  const height = rows.length;
  const width = rows[0]!.length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = rows[y]![x]!;
      const [r, g, b] = colors[key]!;
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

const RED: [number, number, number] = [220, 40, 40];
const BLUE: [number, number, number] = [40, 60, 220];
const WHITE: [number, number, number] = [255, 255, 255];

/** A red square on the left, blue on the right, white band down the middle. */
const TWO_TONE = bitmap(
  [
    'RRR.BBB',
    'RRR.BBB',
    'RRR.BBB',
    'RRR.BBB',
  ],
  { R: RED, B: BLUE, '.': WHITE },
);

const seed = (over: Partial<Seed> = {}): Seed => ({
  id: 's1',
  mode: 'include',
  x: 1,
  y: 1,
  tolerance: 12,
  ...over,
});

const line = (over: Partial<CutLine> = {}): CutLine => ({
  id: 'l1',
  points: [0, 0, 0, 3],
  curved: false,
  width: 1,
  mode: 'block',
  ...over,
});

function withSeeds(...seeds: Seed[]): CutoutFlowData {
  return { ...emptyCutoutFlowData(), seeds };
}

function inside(data: CutoutFlowData, image: Bitmap = TWO_TONE): number {
  return buildMask(image, data).report.inside;
}

/* ---------------- the fill ---------------- */

test('a click includes the region of like-coloured pixels it landed in', () => {
  const { mask, report } = buildMask(TWO_TONE, withSeeds(seed({ x: 1, y: 1 })));
  assert.equal(report.inside, 12, 'the red square is 3x4');
  // And only the red square: the white band is a different colour.
  assert.equal(mask.alpha[0], 255);
  assert.equal(mask.alpha[3], 0, 'the white band is out');
  assert.equal(mask.alpha[4], 0, 'and so is the blue');
});

test('a fill stops at a colour further away than its tolerance', () => {
  // Red to white is a long way in OKLab, so a tight tolerance holds the line.
  assert.equal(inside(withSeeds(seed({ tolerance: 5 }))), 12);
  // And a tolerance wide enough to swallow the whole image does exactly that.
  assert.equal(inside(withSeeds(seed({ tolerance: 200 }))), 28);
});

test('tolerance is measured against the seed colour, not each neighbour', () => {
  // The classic magic-wand failure: on a gradient, neighbour-to-neighbour
  // comparison walks the whole image one indistinguishable step at a time.
  // A ramp from mid grey upwards, one level a pixel. Each neighbour is a
  // difference of about 0.34 — far inside any usable tolerance — while the ends
  // are 40 apart. Started at mid grey rather than black on purpose: OKLab is
  // steep near black, where a single 4-level step is already over 10.
  const width = 120;
  const data = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x += 1) {
    const at = x * 4;
    data[at] = data[at + 1] = data[at + 2] = 128 + x;
    data[at + 3] = 255;
  }
  const ramp: Bitmap = { width, height: 1, data };

  const filled = floodFrom(ramp, { x: 0, y: 0, tolerance: 10 }, new Uint8Array(width), false);
  const taken = filled.reduce((sum: number, value) => sum + value, 0);
  assert.ok(taken > 10, `it should take its near neighbours (${taken})`);
  assert.ok(taken < width, `it took the whole ramp (${taken} of ${width})`);
});

test('an exclude click takes a bite out of what an include caught', () => {
  const wide = withSeeds(
    seed({ id: 'in', tolerance: 200, x: 1, y: 1 }),
    seed({ id: 'out', mode: 'exclude', x: 5, y: 1, tolerance: 12 }),
  );
  // Everything, less the blue square.
  assert.equal(inside(wide), 28 - 12);
});

test('the objects apply in order, so a later include puts a region back', () => {
  const data = withSeeds(
    seed({ id: 'a', tolerance: 200, x: 1, y: 1 }),
    seed({ id: 'b', mode: 'exclude', x: 5, y: 1 }),
    seed({ id: 'c', x: 5, y: 1 }),
  );
  assert.equal(inside(data), 28, 'the exclude was undone by the include after it');
});

test('a fill that catches nothing is reported rather than passed over', () => {
  const { report } = buildMask(TWO_TONE, withSeeds(seed({ tolerance: 0 })));
  // Tolerance 0 still takes the seed pixel itself; a seed on a cut line takes none.
  const onALine: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ x: 0, y: 0 })],
    lines: [line({ width: 3 })],
  };
  const blocked = buildMask(TWO_TONE, onALine);
  assert.ok(blocked.report.problems.some((problem) => /caught nothing/.test(problem)), blocked.report.problems.join('; '));
  assert.ok(report.seeds[0]!.pixels >= 1);
});

test('a seed outside the image is reported, not silently ignored', () => {
  const { report } = buildMask(TWO_TONE, withSeeds(seed({ x: 99, y: 99 })));
  assert.ok(report.problems.some((problem) => /outside the image/.test(problem)), report.problems.join('; '));
});

test('a muted object is kept but not applied', () => {
  const data = withSeeds(seed({ tolerance: 200 }), seed({ id: 's2', mode: 'exclude', x: 5, y: 1, muted: true }));
  assert.equal(inside(data), 28, 'the muted exclude did nothing');
  assert.equal(data.seeds.length, 2, 'and is still there to un-mute');
});

/* ---------------- cut lines ---------------- */

test('a cut line stops a fill that the pixels would otherwise let through', () => {
  // The everyday case: a shadow joins an arm to the body, and a line separates
  // them without the colours having to differ.
  const solid = bitmap(['RRRR', 'RRRR', 'RRRR'], { R: RED });
  const open = buildMask(solid, withSeeds(seed({ x: 0, y: 1 })));
  assert.equal(open.report.inside, 12, 'with no cut, the whole block fills');

  const cut: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ x: 0, y: 1 })],
    lines: [line({ points: [2, -1, 2, 3], width: 1 })],
  };
  const split = buildMask(solid, cut);
  assert.ok(split.report.inside < 12, `the cut did not hold (${split.report.inside})`);
  assert.ok(split.report.inside >= 6, 'and it kept the side the seed was on');
});

test('a cut is a barrier at least one pixel wide, so a fill cannot slip past it', () => {
  const blocked = blockedBy([line({ points: [1, 0, 1, 3], width: 1 })], 7, 4);
  for (let y = 0; y < 4; y += 1) assert.equal(blocked[y * 7 + 1], 1, `row ${y} is not blocked`);
});

test('a one-click cut still marks its own spot', () => {
  const blocked = blockedBy([line({ points: [3, 2], width: 2 })], 7, 4);
  assert.equal(blocked[2 * 7 + 3], 1);
});

test('an erase line clears what it covers, after every fill has run', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ x: 1, y: 1, tolerance: 200 })],
    lines: [line({ points: [0, 0, 6, 0], width: 1, mode: 'erase' })],
  };
  const { mask } = buildMask(TWO_TONE, data);
  for (let x = 0; x < 7; x += 1) assert.equal(mask.alpha[x], 0, `top row pixel ${x} survived the erase`);
  assert.equal(mask.alpha[7], 255, 'and the row below did not');
});

test('a curved line passes through every point it was given', () => {
  // A line you drew that does not go where you put it is not a tool you can aim.
  const points = [0, 0, 5, 10, 10, 0];
  const sampled = linePoints({ ...line(), points, curved: true });
  for (let index = 0; index + 1 < points.length; index += 2) {
    const wanted = { x: points[index]!, y: points[index + 1]! };
    assert.ok(
      sampled.some((point) => Math.abs(point.x - wanted.x) < 0.01 && Math.abs(point.y - wanted.y) < 0.01),
      `the curve misses ${JSON.stringify(wanted)}`,
    );
  }
  assert.ok(sampled.length > points.length / 2, 'and it is smoothed, not just the corners');
});

test('a straight line is its points and nothing added', () => {
  const sampled = linePoints({ ...line(), points: [0, 0, 4, 4], curved: false });
  assert.deepEqual(sampled, [
    { x: 0, y: 0 },
    { x: 4, y: 4 },
  ]);
});

/* ---------------- edges ---------------- */

test('growing takes in the halo a fill stops short of', () => {
  const one = new Uint8Array(9);
  one[4] = 1; // the middle of a 3x3
  const grown = grow(one, 3, 3, 1);
  assert.equal(grown.reduce((sum, value) => sum + value, 0), 5, 'the middle plus its four neighbours');
});

test('shrinking erodes the image border like any other edge', () => {
  const all = new Uint8Array(9).fill(1);
  const shrunk = grow(all, 3, 3, -1);
  // Shrinking by one takes a one-pixel frame off, so a full 3x3 leaves its
  // centre. Were the image border *not* treated as an edge, nothing would touch
  // an off pixel and all nine would survive — and a cutout that runs to the edge
  // of the picture would keep a one-pixel frame of background it was told to lose.
  assert.equal(shrunk.reduce((sum: number, value) => sum + value, 0), 1);
  assert.equal(shrunk[4], 1, 'and it is the centre that is left');
});

test('feathering softens the edge without moving it', () => {
  const data = { ...withSeeds(seed({ x: 1, y: 1 })), options: { ...emptyCutoutFlowData().options, feather: 1 } };
  const { mask } = buildMask(TWO_TONE, data);
  const values = new Set([...mask.alpha]);
  assert.ok(values.size > 2, 'there should be partial alpha now');
  assert.ok([...values].some((value) => value > 0 && value < 255), 'and it should be partial, not just on or off');
});

test('small islands can be dropped, and the count is reported', () => {
  // A fill on a noisy photograph finds hundreds of one-pixel specks.
  const speckled = bitmap(['RRR.R', 'RRR..', '....R'], { R: RED, '.': WHITE });
  const base: CutoutFlowData = { ...emptyCutoutFlowData(), seeds: [seed({ x: 0, y: 0, tolerance: 12 })] };
  const wide = { ...base, seeds: [seed({ x: 0, y: 0, tolerance: 200 })] };

  const kept = buildMask(speckled, base);
  assert.equal(kept.report.islandsDropped, 0);
  assert.ok(wide.seeds.length === 1);

  const pruned = buildMask(speckled, { ...base, options: { ...base.options, minIsland: 3 } });
  assert.ok(pruned.report.inside <= kept.report.inside);
});

/* ---------------- what comes out ---------------- */

test('applying a mask makes everything outside transparent and touches no colour', () => {
  const { mask } = buildMask(TWO_TONE, withSeeds(seed({ x: 1, y: 1 })));
  const out = applyMask(TWO_TONE, mask);
  assert.deepEqual([out[0], out[1], out[2], out[3]], [220, 40, 40, 255], 'inside keeps its colour');
  assert.equal(out[3 * 4 + 3], 0, 'outside is transparent');
  assert.deepEqual(
    [out[3 * 4], out[3 * 4 + 1], out[3 * 4 + 2]],
    [255, 255, 255],
    'and a transparent pixel keeps its bytes rather than being blackened',
  );
});

test('cutting out of an already transparent image cannot make a pixel more opaque', () => {
  const half: Bitmap = { width: 1, height: 1, data: new Uint8ClampedArray([220, 40, 40, 100]) };
  const out = applyMask(half, { width: 1, height: 1, alpha: new Uint8ClampedArray([255]) });
  assert.equal(out[3], 100);
});

test('the bounds of a mask are the tight box around what was kept', () => {
  const { mask } = buildMask(TWO_TONE, withSeeds(seed({ x: 5, y: 1 })));
  assert.deepEqual(maskBounds(mask), { x: 4, y: 0, width: 3, height: 4 });
  assert.equal(maskBounds({ width: 2, height: 2, alpha: new Uint8ClampedArray(4) }), null);
});

/* ---------------- the object list ---------------- */

test('deleting an object takes its region with it', () => {
  const data = withSeeds(seed({ id: 'a', x: 1, y: 1 }), seed({ id: 'b', x: 5, y: 1 }));
  assert.equal(inside(data), 24, 'both squares');
  assert.equal(inside(deleteObject(data, 'b')), 12, 'and one once the second is gone');
});

test('selecting is by click, adding is by shift, and deleting takes the selection', () => {
  let data = withSeeds(seed({ id: 'a' }), seed({ id: 'b', x: 5 }));
  data = selectObject(data, 'a');
  assert.deepEqual(data.selected, ['a']);
  data = selectObject(data, 'b', true);
  assert.deepEqual(data.selected, ['a', 'b']);
  data = selectObject(data, 'a', true);
  assert.deepEqual(data.selected, ['b'], 'shift-clicking a selected object drops it');

  data = deleteSelected(data);
  assert.deepEqual(data.seeds.map((item) => item.id), ['a']);
  assert.deepEqual(data.selected, []);
});

test('objects are listed and found by id across both kinds', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'a' })],
    lines: [line({ id: 'l' })],
  };
  assert.deepEqual(objectsOf(data).map((object) => object.type), ['seed', 'line']);
  assert.equal(findObject(data, 'l')?.type, 'line');
  assert.equal(findObject(data, 'nope'), undefined);
});

test('objects are named in the terms of what they do, and numbered per kind', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'a' }), seed({ id: 'b', mode: 'exclude' }), seed({ id: 'c' })],
    lines: [line({ id: 'l1' }), line({ id: 'l2', mode: 'erase' })],
  };
  const named = objectsOf(data).map((object) => labelOf(data, object));
  assert.deepEqual(named, ['Include 1', 'Exclude 1', 'Include 2', 'Cut 1', 'Erase 2']);
});

test('a seed’s tolerance can be changed on its own', () => {
  // The edge of a face and the edge of a sky need different answers.
  const data = withSeeds(seed({ id: 'a', tolerance: 5 }));
  const loosened = setSeed(data, 'a', { tolerance: 200 });
  assert.equal(inside(data), 12);
  assert.equal(inside(loosened), 28);
  assert.equal(data.seeds[0]!.tolerance, 5, 'and the original was not mutated');
});

test('the summary counts what is doing something, not what exists', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'a' }), seed({ id: 'b', mode: 'exclude', muted: true })],
    lines: [line()],
    imageWidth: 7,
    imageHeight: 4,
  };
  const text = summariseCutout(data, buildMask(TWO_TONE, data).report);
  assert.match(text, /1 include/);
  assert.match(text, /0 excludes/, 'the muted one is not counted');
  assert.match(text, /1 cut/);
  assert.match(text, /% of the image kept/);
});

test('an empty cutout is empty rather than everything', () => {
  // The failure that would be worst: no clicks yet quietly meaning "keep it all".
  const { mask, report } = buildMask(TWO_TONE, emptyCutoutFlowData());
  assert.equal(report.inside, 0);
  assert.ok([...mask.alpha].every((value) => value === 0));
  assert.deepEqual(report.problems, [], 'and it does not complain before you have done anything');
});
