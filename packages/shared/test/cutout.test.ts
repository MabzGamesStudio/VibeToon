import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMask,
  fillOutline,
  paintOrder,
  regionOutline,
  setRegion,
  takeSeq,
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
  type Region,
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

test('a click includes the region of like-colored pixels it landed in', () => {
  const { mask, report } = buildMask(TWO_TONE, withSeeds(seed({ x: 1, y: 1 })));
  assert.equal(report.inside, 12, 'the red square is 3x4');
  // And only the red square: the white band is a different color.
  assert.equal(mask.alpha[0], 255);
  assert.equal(mask.alpha[3], 0, 'the white band is out');
  assert.equal(mask.alpha[4], 0, 'and so is the blue');
});

test('a fill stops at a color further away than its tolerance', () => {
  // Red to white is a long way in OKLab, so a tight tolerance holds the line.
  assert.equal(inside(withSeeds(seed({ tolerance: 5 }))), 12);
  // And a tolerance wide enough to swallow the whole image does exactly that.
  assert.equal(inside(withSeeds(seed({ tolerance: 200 }))), 28);
});

test('tolerance is measured against the seed color, not each neighbour', () => {
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
  // them without the colors having to differ.
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
  const sampled = linePoints({ ...line(), points });
  for (let index = 0; index + 1 < points.length; index += 2) {
    const wanted = { x: points[index]!, y: points[index + 1]! };
    assert.ok(
      sampled.some((point) => Math.abs(point.x - wanted.x) < 0.01 && Math.abs(point.y - wanted.y) < 0.01),
      `the curve misses ${JSON.stringify(wanted)}`,
    );
  }
  assert.ok(sampled.length > points.length / 2, 'and it is smoothed, not just the corners');
});

test('two points is a straight cut, which is why there is no straight tool', () => {
  // A two-point spline is a straight line, so the straight variety costs nothing
  // to remove: click twice and the cut is straight.
  const sampled = linePoints({ ...line(), points: [0, 0, 4, 4] });
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

test('applying a mask makes everything outside transparent and touches no color', () => {
  const { mask } = buildMask(TWO_TONE, withSeeds(seed({ x: 1, y: 1 })));
  const out = applyMask(TWO_TONE, mask);
  assert.deepEqual([out[0], out[1], out[2], out[3]], [220, 40, 40, 255], 'inside keeps its color');
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


/* ---------------- drawn regions ---------------- */

const region = (over: Partial<Region> = {}): Region => ({
  id: 'g1',
  // The red square: x 0..2, y 0..3.
  points: [0, 0, 2, 0, 2, 3, 0, 3],
  curved: false,
  mode: 'include',
  ...over,
});

function withRegions(...regions: Region[]): CutoutFlowData {
  return { ...emptyCutoutFlowData(), regions };
}

test('a region takes everything inside it, whatever the pixels say', () => {
  // The case no tolerance can answer: a subject sharing its colors with the
  // background everywhere. Drawing round it is the honest tool.
  //
  // Points are corners, not pixels: the box (0,0)-(7,2) encloses the centres of
  // the top two rows of a 7-wide image, which is 14 pixels.
  const { report } = buildMask(TWO_TONE, withRegions(region({ points: [0, 0, 7, 0, 7, 2, 0, 2] })));
  assert.equal(report.inside, 14, 'the whole top two rows, across all three colors');
});

test('a region can drop everything inside it instead', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'a', tolerance: 200, seq: 1 })],
    regions: [region({ id: 'g', mode: 'exclude', points: [0, 0, 7, 0, 7, 2, 0, 2], seq: 2 })],
  };
  assert.equal(inside(data), 28 - 14);
});

test('a region and a fill paint in the order they were drawn', () => {
  // "The one I drew last wins" is the only rule that matches what it looks like.
  const fillThenRegion: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'a', x: 1, y: 1, tolerance: 200, seq: 1 })],
    regions: [region({ id: 'g', mode: 'exclude', points: [0, 0, 7, 0, 7, 2, 0, 2], seq: 2 })],
  };
  const regionThenFill: CutoutFlowData = {
    ...fillThenRegion,
    seeds: [seed({ id: 'a', x: 1, y: 1, tolerance: 200, seq: 3 })],
  };
  assert.equal(inside(fillThenRegion), 14, 'the region cut into what the fill took');
  assert.equal(inside(regionThenFill), 28, 'and the fill put it back when it came second');
});

test('paint order is by when it was drawn, across both kinds', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'late', seq: 9 }), seed({ id: 'early', seq: 1 })],
    regions: [region({ id: 'middle', seq: 5 })],
  };
  assert.deepEqual(paintOrder(data).map((object) => object.id), ['early', 'middle', 'late']);
});

test('a cutout made before regions existed keeps the order it had', () => {
  // No seq at all: the array order is the order, and nothing shifts under it.
  const old: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'first' }), seed({ id: 'second' }), seed({ id: 'third' })],
  };
  assert.deepEqual(paintOrder(old).map((object) => object.id), ['first', 'second', 'third']);
});

test('the sequence counter never hands out a number already used', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    seeds: [seed({ id: 'a', seq: 7 })],
    nextSeq: 2,
  };
  const { seq, data: bumped } = takeSeq(data);
  assert.ok(seq > 7, `${seq} would paint under an object drawn before it`);
  assert.equal(takeSeq(bumped).seq, seq + 1);
});

test('a curved region closes without a seam', () => {
  // Smoothing an open line leaves a kink where the last point meets the first,
  // which on a shape drawn by hand is exactly where the eye goes.
  const square = region({ curved: true, points: [0, 0, 10, 0, 10, 10, 0, 10] });
  const outline = regionOutline(square);
  assert.ok(outline.length > 20, 'it is sampled, not just the corners');

  const first = outline[0]!;
  const last = outline[outline.length - 1]!;
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  const longest = Math.max(
    ...outline.map((point, index) => {
      const next = outline[(index + 1) % outline.length]!;
      return Math.hypot(next.x - point.x, next.y - point.y);
    }),
  );
  assert.ok(gap <= longest + 0.001, `the closing step (${gap}) is not longer than the rest (${longest})`);
});

test('a cornered region is exactly the points it was given', () => {
  const square = region({ curved: false, points: [0, 0, 10, 0, 10, 10, 0, 10] });
  assert.deepEqual(regionOutline(square), [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]);
});

test('filling an outline is even-odd, so a shape drawn over itself has a hole', () => {
  // Falls out of the rule rather than being special-cased.
  const ring = fillOutline(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
      { x: 3, y: 3 },
      { x: 3, y: 7 },
      { x: 7, y: 7 },
      { x: 7, y: 3 },
      { x: 3, y: 3 },
    ],
    10,
    10,
  );
  assert.equal(ring[5 * 10 + 5], 0, 'the middle is a hole');
  assert.equal(ring[1 * 10 + 1], 1, 'and the ring itself is filled');
});

test('a horizontal edge does not spring a leak', () => {
  // The vertex-on-scanline case: counted twice or not at all, a shape bleeds
  // along every flat edge, and it looks like the fill algorithm misbehaving.
  const box = fillOutline(
    [
      { x: 1, y: 1 },
      { x: 8, y: 1 },
      { x: 8, y: 8 },
      { x: 1, y: 8 },
    ],
    10,
    10,
  );
  for (let x = 0; x < 10; x += 1) {
    assert.equal(box[0 * 10 + x], 0, `row 0 leaked at ${x}`);
    assert.equal(box[9 * 10 + x], 0, `row 9 leaked at ${x}`);
  }
  assert.equal(box[4 * 10 + 4], 1, 'and the inside is filled');
});

test('a region with too few points to enclose anything is reported', () => {
  const { report } = buildMask(TWO_TONE, withRegions(region({ points: [0, 0, 2, 2] })));
  assert.ok(report.problems.some((problem) => /too few points/.test(problem)), report.problems.join('; '));
});

test('a region off the edge of the image is reported rather than silently empty', () => {
  const { report } = buildMask(
    TWO_TONE,
    withRegions(region({ points: [50, 50, 60, 50, 60, 60, 50, 60] })),
  );
  assert.ok(report.problems.some((problem) => /encloses nothing/.test(problem)), report.problems.join('; '));
});

test('regions are named for what they do and counted in the summary', () => {
  const data: CutoutFlowData = {
    ...emptyCutoutFlowData(),
    regions: [region({ id: 'a' }), region({ id: 'b', mode: 'exclude' }), region({ id: 'c' })],
  };
  const named = objectsOf(data).map((object) => labelOf(data, object));
  assert.deepEqual(named, ['Keep inside 1', 'Drop inside 1', 'Keep inside 2']);
  assert.match(summariseCutout(data, null), /3 regions/);
});

test('a muted region does nothing but is still there', () => {
  const data = withRegions(region({ points: [0, 0, 7, 0, 7, 2, 0, 2], muted: true }));
  assert.equal(inside(data), 0);
  assert.equal(data.regions.length, 1);
});

test('a region can be edited and deleted like anything else', () => {
  let data = withRegions(region({ id: 'g', points: [0, 0, 7, 0, 7, 2, 0, 2] }));
  assert.equal(inside(data), 14);

  data = setRegion(data, 'g', { mode: 'exclude' });
  assert.equal(inside(data), 0, 'nothing was included for it to take from');

  data = deleteObject(data, 'g');
  assert.deepEqual(data.regions, []);
});

test('a region\u2019s points are corners, and pixels are their centres', () => {
  // Worth pinning: the off-by-one here is the difference between a region that
  // selects what you drew round and one a row short on every side.
  const oneRow = fillOutline(
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 0, y: 1 },
    ],
    4,
    4,
  );
  assert.equal(
    oneRow.reduce((sum: number, value) => sum + value, 0),
    4,
    'a box one unit tall covers one row of centres',
  );
  for (let x = 0; x < 4; x += 1) assert.equal(oneRow[x], 1);
});
