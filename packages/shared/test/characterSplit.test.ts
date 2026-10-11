import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bitmap } from '../src/flows/cutout';
import {
  applyCharacterEdits,
  bestBlend,
  characterBox,
  characterFrameName,
  characterImage,
  characterName,
  characterWork,
  charactersFile,
  charactersReport,
  embedPixels,
  embeddingSimilarity,
  emptyCharacterSplitFlowData,
  findCharacters,
  framePieces,
  frameRateOfTimes,
  sheetLayout,
  type CharacterOptions,
} from '../src/flows/characterSplit';
import { migrateProject } from '../src/project/migrate';
import { createNode, createProject } from '../src/project/factory';

const W = 100;
const H = 40;
const SKIN: [number, number, number] = [240, 190, 150];
const RED: [number, number, number] = [210, 40, 40];
const BLUE: [number, number, number] = [40, 60, 210];
const options: CharacterOptions = { join: 4, minArea: 20, sameness: 80, maxMove: 40, minFrames: 2 };

/** A figure: a skin-coloured head over a body of its own colour, its left edge at x. */
function drawFigure(data: Uint8ClampedArray, owner: Uint8Array | null, x: number, body: [number, number, number], who: number): void {
  const put = (px: number, py: number, colour: [number, number, number]) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    data.set([...colour, 255], (py * W + px) * 4);
    if (owner) owner[py * W + px] = who;
  };
  for (let y = 8; y < 16; y += 1) for (let px = x + 2; px < x + 10; px += 1) put(px, y, SKIN);
  for (let y = 16; y < 34; y += 1) for (let px = x; px < x + 12; px += 1) put(px, y, body);
}

/** Two figures walking towards each other: red from the left, blue from the right; blue in front where they meet. */
function crossing(frames: number, step = 6): { frames: Bitmap[]; truth: Uint8Array[] } {
  const out: Bitmap[] = [];
  const truth: Uint8Array[] = [];
  for (let f = 0; f < frames; f += 1) {
    const data = new Uint8ClampedArray(W * H * 4);
    const owner = new Uint8Array(W * H);
    drawFigure(data, owner, 4 + f * step, RED, 1);
    drawFigure(data, owner, 84 - f * step, BLUE, 2);
    out.push({ width: W, height: H, data });
    truth.push(owner);
  }
  return { frames: out, truth };
}

test('a new Character Split groups by colours 80% alike, and has nothing changed by hand', () => {
  const data = emptyCharacterSplitFlowData();
  assert.equal(data.editor, 'characterSplit');
  assert.equal(data.sameness, 80);
  assert.deepEqual([data.names, data.dropped, data.joined], [{}, [], []]);
  assert.equal(characterName(data, 'c3'), 'Character 3');
  assert.equal(characterName({ names: { c3: ' Pip ' } }, 'c3'), 'Pip');
});

test('an embedding is the share of each colour: alike for one character, unlike for two, and a blend of both is found as one', () => {
  const { frames } = crossing(1);
  const pixelsWhere = (colour: [number, number, number] | null, x0: number, x1: number) => {
    const out: number[] = [];
    for (let p = 0; p < W * H; p += 1) {
      const x = p % W;
      if (x < x0 || x >= x1 || frames[0]!.data[p * 4 + 3] === 0) continue;
      if (!colour || (frames[0]!.data[p * 4] === colour[0] && frames[0]!.data[p * 4 + 2] === colour[2])) out.push(p);
    }
    return out;
  };
  const red = embedPixels(frames[0]!.data, pixelsWhere(null, 0, 50));
  const blue = embedPixels(frames[0]!.data, pixelsWhere(null, 50, 100));
  assert.ok(Math.abs(embeddingSimilarity(red, red) - 1) < 1e-9);
  assert.ok(embeddingSimilarity(red, blue) < 0.6, `${embeddingSimilarity(red, blue)}`);
  const both = embedPixels(frames[0]!.data, pixelsWhere(null, 0, 100));
  const blend = bestBlend(both, red, blue);
  assert.ok(blend.similarity > 0.99 && Math.abs(blend.weight - 0.5) < 0.06, JSON.stringify(blend));
});

test('a frame’s pieces are what is kept in touching patches: pieces closer than a patch are one', () => {
  const data = new Uint8ClampedArray(W * H * 4);
  drawFigure(data, null, 10, RED, 1);
  drawFigure(data, null, 25, BLUE, 2); // 3 px apart
  drawFigure(data, null, 60, BLUE, 2);
  const frame = { width: W, height: H, data };
  assert.equal(framePieces(frame, 0, { join: 2, minArea: 20 }).length, 3);
  assert.equal(framePieces(frame, 0, { join: 6, minArea: 20 }).length, 2, 'a gap of 3 px is inside a 6 px patch');
  assert.equal(framePieces(frame, 0, { join: 2, minArea: 10_000 }).length, 0, 'too small to count');
});

test('two characters apart in every frame are two characters, each with all its frames, numbered left to right', () => {
  const { frames } = crossing(4, 3); // never meet
  const result = findCharacters(frames, options);
  assert.equal(result.characters.length, 2);
  assert.deepEqual(result.characters.map((character) => character.id), ['c1', 'c2']);
  assert.ok(result.characters[0]!.palette.includes('#cc3333') || result.characters[0]!.palette.some((colour) => colour.startsWith('#cc')), result.characters[0]!.palette.join());
  for (const character of result.characters) {
    assert.equal(character.frames.length, 4);
    assert.ok(character.frames.every((appearance) => !appearance.split && appearance.area === 64 + 216));
  }
  assert.equal(result.stats.split, 0);
});

test('where they touch, the one piece is split between them by colour and by where each was', () => {
  const { frames, truth } = crossing(12);
  const result = findCharacters(frames, options);
  assert.equal(result.characters.length, 2, `${result.characters.length} characters, ${result.stats.blends} blends`);
  assert.ok(result.stats.split > 0, 'some pieces were shared');
  // Red is c1 (it starts on the left).
  let right = 0;
  let total = 0;
  for (let f = 0; f < frames.length; f += 1) {
    for (let p = 0; p < W * H; p += 1) {
      if (!truth[f]![p]) continue;
      total += 1;
      if (result.owners[f]![p] === truth[f]![p]) right += 1;
    }
  }
  assert.ok(right / total > 0.97, `${((right / total) * 100).toFixed(1)}% of pixels to the right character`);
  // The skin of both heads is the same colour: where the heads touch, which is whose comes from where each was.
  const touching = frames.findIndex((_, f) => framePieces(frames[f]!, f, options).length === 1);
  assert.ok(touching >= 0, 'they do touch');
  const heads = [...truth[touching]!.keys()].filter((p) => frames[touching]!.data[p * 4] === SKIN[0] && truth[touching]![p]);
  const headsRight = heads.filter((p) => result.owners[touching]![p] === truth[touching]![p]).length;
  assert.ok(headsRight / heads.length > 0.9, `${headsRight} of ${heads.length} head pixels`);
});

test('a character in fewer frames than the least is left out, and colours less alike than the sameness are apart', () => {
  const { frames } = crossing(4, 3);
  // A green speck in one frame only.
  for (let y = 2; y < 8; y += 1) for (let x = 46; x < 54; x += 1) frames[2]!.data.set([20, 220, 40, 255], (y * W + x) * 4);
  const result = findCharacters(frames, options);
  assert.equal(result.characters.length, 2);
  assert.equal(result.stats.tooFew, 1);
  assert.equal(findCharacters(frames, { ...options, minFrames: 1 }).characters.length, 3);
  // So unalike-minded that red and blue figures are one.
  assert.equal(findCharacters(frames, { ...options, sameness: 20 }).characters.length, 1);
});

test('the work runs a slice at a time', () => {
  const { frames } = crossing(3, 3);
  const work = characterWork(frames, options);
  const stages = new Set<string>();
  let next = work.next();
  while (!next.done) {
    stages.add(next.value.stage);
    next = work.next();
  }
  assert.deepEqual([...stages].sort(), ['assign', 'group', 'pieces']);
  assert.equal(next.value.frameCount, 3);
});

test('characters joined by hand are one, those left out are gone, and the rest are renumbered', () => {
  const { frames } = crossing(4, 3);
  const result = findCharacters(frames, options);
  const joined = applyCharacterEdits(result, { joined: [['c1', 'c2']], dropped: [] });
  assert.equal(joined.characters.length, 1);
  assert.equal(joined.characters[0]!.frames.length, 4);
  assert.equal(joined.characters[0]!.frames[0]!.area, 2 * (64 + 216));
  assert.ok(joined.owners[0]!.every((value) => value <= 1));
  const dropped = applyCharacterEdits(result, { joined: [], dropped: ['c1'] });
  assert.deepEqual(dropped.characters.map((character) => character.id), ['c2']);
  assert.equal(Math.max(...dropped.owners[0]!), 1, 'c2 is first now');
  assert.equal(applyCharacterEdits(result, { joined: [['c9', 'c1']], dropped: ['c7'] }).characters.length, 2, 'edits naming nobody are passed over');
});

test('each character’s frames, box, sheet, rate and names are as written', () => {
  const { frames } = crossing(4, 3);
  const result = findCharacters(frames, options);
  const image = characterImage(frames[0]!, result.owners[0]!, 0);
  let opaque = 0;
  for (let p = 0; p < W * H; p += 1) if (image.data[p * 4 + 3]) opaque += 1;
  assert.equal(opaque, 64 + 216);
  const box = characterBox(result.characters[0]!, W, H);
  assert.equal(box.width % 2, 0);
  assert.equal(box.height % 2, 0);
  assert.ok(box.x <= 4 && box.x + box.width >= 4 + 9 + 12);
  const sheet = sheetLayout(10, { width: 20, height: 30 }, 4);
  assert.deepEqual([sheet.width, sheet.height], [80, 90]);
  assert.deepEqual(sheet.at(5), { x: 20, y: 30 });
  assert.equal(frameRateOfTimes([0, 0.5, 1, 1.5]), 2);
  assert.equal(frameRateOfTimes([null, null]), 12, 'no times: the fallback');
  assert.equal(characterFrameName(1, 'frames/frame-0003-at-0.250s.png'), 'character-2-frame-0003-at-0.250s.png');
});

test('characters.json lists every frame each character is in, and the report says how they were found', () => {
  const { frames } = crossing(12);
  const data = { ...emptyCharacterSplitFlowData(), join: 4, minArea: 20, maxMove: 40, names: { c1: 'Red' } };
  const result = findCharacters(frames, data);
  const names = frames.map((_, f) => `frame-${String(f + 1).padStart(4, '0')}-at-${(f / 12).toFixed(3)}s.png`);
  const times = frames.map((_, f) => f / 12);
  const json = JSON.parse(charactersFile(data, result, names, times, result.characters.map((character) => characterBox(character, W, H))));
  assert.equal(json.characters.length, 2);
  assert.equal(json.characters[0].name, 'Red');
  assert.equal(json.characters[0].files.clip, 'character-1.webm');
  assert.equal(json.characters[0].frames[0].source, names[0]);
  assert.equal(json.characters[0].frames[0].file, `character-1-${names[0]}`);
  assert.ok(json.characters.some((character: { frames: Array<{ split: boolean }> }) => character.frames.some((frame) => frame.split)));
  const report = charactersReport(data, result, names);
  assert.match(report, /2 character\(s\)/);
  assert.match(report, /## Red \(`character-1`\)/);
  assert.match(charactersReport(data, null), /Not worked out yet/);
});

test('a Character Split saved with fields missing is filled in on load', () => {
  const node = { ...createNode('art.video.characters', { x: 0, y: 0 }, 'Characters'), id: 'cs', data: { editor: 'characterSplit', join: 9 } as never };
  const migrated = migrateProject({ ...createProject('old'), nodes: [node] });
  const data = migrated.nodes[0]!.data as ReturnType<typeof emptyCharacterSplitFlowData>;
  assert.equal(data.join, 9, 'what was there is kept');
  assert.equal(data.sameness, 80);
  assert.deepEqual(data.joined, []);
});
