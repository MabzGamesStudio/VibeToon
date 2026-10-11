import type { Bitmap } from './cutout';

/**
 * Splitting what moves in a video into characters.
 *
 * The input is a video's frames with the background taken out (Video
 * Foreground): only what moves is left, on clear. Each frame's pieces — what
 * is kept, in touching patches — are found, and each piece is given an
 * **embedding**: the colours it is made of, as a soft histogram. Then:
 *
 * 1. **Characters from where they are apart.** Pieces from every frame are
 *    grouped by embedding — those whose colours are alike within the
 *    **sameness** are one character — taking first the frames with the most
 *    pieces in them, where characters are most likely apart. A group whose
 *    colours are a blend of two others' — two characters touching, read as
 *    one piece — is not a character: its pieces are split below.
 * 2. **Each piece, in each frame.** A piece of one character's group, with
 *    no other character near it, is that character's. A piece where two or
 *    more could be — a blend, or one that another character's place in the
 *    frames before and after says it reaches into — is split patch by patch:
 *    each pixel goes to the character most likely to be there, by how alike
 *    its colour is to that character's embedding and how near its patch is to
 *    where that character was in the frames next to it, moved on by how it
 *    was moving.
 * 3. Characters seen in fewer than **least frames** frames are left out.
 *
 * What comes out is each character's own frames: its pixels in each frame it
 * is in, clear everywhere else, the size the frames were.
 */

export interface CharacterSplitFlowData {
  editor: 'characterSplit';
  /** Pieces this close together, in pixels, are one piece: the side of a patch. */
  join: number;
  /** Pieces smaller than this many pixels are left out. */
  minArea: number;
  /** How alike two pieces' colours must be to be one character, in percent. */
  sameness: number;
  /** The furthest a character may move from one frame to the next, in pixels. */
  maxMove: number;
  /** A character must be in at least this many frames. */
  minFrames: number;
  /** Names given to characters, by id. */
  names: Record<string, string>;
  /** Characters left out by hand, by id. */
  dropped: string[];
  /** Characters joined by hand: the second is the first. */
  joined: Array<[string, string]>;
  /** The frames read: how many, and their size. */
  frames?: { hash?: string; count: number; width: number; height: number };
  /** The character shown on its own, by id; null shows them all. */
  current: string | null;
  /** The frame shown, by its place. */
  frame: number | null;
}

export const DEFAULT_CHARACTER_JOIN = 6;
export const DEFAULT_CHARACTER_MIN_AREA = 60;
export const DEFAULT_CHARACTER_SAMENESS = 80;
export const DEFAULT_CHARACTER_MAX_MOVE = 120;
export const DEFAULT_CHARACTER_MIN_FRAMES = 2;

export function emptyCharacterSplitFlowData(): CharacterSplitFlowData {
  return {
    editor: 'characterSplit',
    join: DEFAULT_CHARACTER_JOIN,
    minArea: DEFAULT_CHARACTER_MIN_AREA,
    sameness: DEFAULT_CHARACTER_SAMENESS,
    maxMove: DEFAULT_CHARACTER_MAX_MOVE,
    minFrames: DEFAULT_CHARACTER_MIN_FRAMES,
    names: {},
    dropped: [],
    joined: [],
    current: null,
    frame: null,
  };
}

export type CharacterOptions = Pick<CharacterSplitFlowData, 'join' | 'minArea' | 'sameness' | 'maxMove' | 'minFrames'>;

/* ---------------- embeddings ---------------- */

/** Levels each of red, green and blue is binned into: 6 × 6 × 6 colours. */
const LEVELS = 6;
export const COLOUR_EMBEDDING_SIZE = LEVELS * LEVELS * LEVELS;
const STEP = 255 / (LEVELS - 1);

/**
 * Add a colour to a histogram softly: shared between the eight bins around
 * it by how near it is to each, so a colour that compression nudges across a
 * bin's edge counts nearly the same.
 */
function addColour(hist: Float64Array, r: number, g: number, b: number, weight = 1): void {
  const fr = r / STEP;
  const fg = g / STEP;
  const fb = b / STEP;
  const r0 = Math.min(LEVELS - 2, Math.floor(fr));
  const g0 = Math.min(LEVELS - 2, Math.floor(fg));
  const b0 = Math.min(LEVELS - 2, Math.floor(fb));
  const wr = fr - r0;
  const wg = fg - g0;
  const wb = fb - b0;
  for (let i = 0; i < 2; i += 1) {
    const kr = i ? wr : 1 - wr;
    for (let j = 0; j < 2; j += 1) {
      const kg = j ? wg : 1 - wg;
      for (let k = 0; k < 2; k += 1) {
        const kb = k ? wb : 1 - wb;
        const bin = ((r0 + i) * LEVELS + (g0 + j)) * LEVELS + (b0 + k);
        hist[bin] = hist[bin]! + weight * kr * kg * kb;
      }
    }
  }
}

/** The bin a colour falls nearest. */
function binOf(r: number, g: number, b: number): number {
  return (Math.round(r / STEP) * LEVELS + Math.round(g / STEP)) * LEVELS + Math.round(b / STEP);
}

/** The embedding of some pixels of a picture: the share of their colour in each bin. */
export function embedPixels(data: Uint8ClampedArray, pixels: ArrayLike<number>): Float64Array {
  const hist = new Float64Array(COLOUR_EMBEDDING_SIZE);
  for (let i = 0; i < pixels.length; i += 1) {
    const at = pixels[i]! * 4;
    addColour(hist, data[at]!, data[at + 1]!, data[at + 2]!);
  }
  return normalise(hist);
}

function normalise(hist: Float64Array): Float64Array {
  let sum = 0;
  for (const value of hist) sum += value;
  if (sum > 0) for (let i = 0; i < hist.length; i += 1) hist[i] = hist[i]! / sum;
  return hist;
}

/** How alike two embeddings are, 0..1: the Bhattacharyya coefficient, 1 for the same colours in the same shares. */
export function embeddingSimilarity(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.sqrt(a[i]! * b[i]!);
  return Math.min(1, sum);
}

/** The best blend of two embeddings for a third, and how alike that blend is to it. */
export function bestBlend(target: Float64Array, a: Float64Array, b: Float64Array): { weight: number; similarity: number } {
  let best = { weight: 0.5, similarity: -1 };
  const mix = new Float64Array(target.length);
  for (let step = 1; step < 20; step += 1) {
    const weight = step / 20;
    for (let i = 0; i < mix.length; i += 1) mix[i] = weight * a[i]! + (1 - weight) * b[i]!;
    const similarity = embeddingSimilarity(target, mix);
    if (similarity > best.similarity) best = { weight, similarity };
  }
  return best;
}

/* ---------------- pieces ---------------- */

export interface Piece {
  frame: number;
  /** The pixels, by index into the frame. */
  pixels: Int32Array;
  /** The patches it covers, by index into the patch grid. */
  cells: Int32Array;
  area: number;
  cx: number;
  cy: number;
  box: { x0: number; y0: number; x1: number; y1: number };
  embedding: Float64Array;
}

interface Grid {
  size: number;
  cols: number;
  rows: number;
}

function gridFor(width: number, height: number, join: number): Grid {
  const size = Math.max(2, Math.round(join));
  return { size, cols: Math.ceil(width / size), rows: Math.ceil(height / size) };
}

/**
 * A frame's pieces: its kept pixels in touching patches — patches `join`
 * pixels across, so parts of one character no further apart than that are one
 * piece. Pieces smaller than `minArea` are left out.
 */
export function framePieces(frame: Bitmap, frameIndex: number, options: Pick<CharacterOptions, 'join' | 'minArea'>): Piece[] {
  const { width: w, height: h, data } = frame;
  const grid = gridFor(w, h, options.join);
  const occupied = new Uint8Array(grid.cols * grid.rows);
  for (let y = 0; y < h; y += 1) {
    const row = Math.floor(y / grid.size) * grid.cols;
    for (let x = 0; x < w; x += 1) if (data[(y * w + x) * 4 + 3]! > 0) occupied[row + Math.floor(x / grid.size)] = 1;
  }
  const label = new Int32Array(occupied.length).fill(-1);
  const groups: number[][] = [];
  for (let start = 0; start < occupied.length; start += 1) {
    if (!occupied[start] || label[start]! >= 0) continue;
    const cells = [start];
    label[start] = groups.length;
    for (let i = 0; i < cells.length; i += 1) {
      const c = cells[i]!;
      const cx = c % grid.cols;
      const cy = (c - cx) / grid.cols;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
          const n = ny * grid.cols + nx;
          if (occupied[n] && label[n]! < 0) {
            label[n] = groups.length;
            cells.push(n);
          }
        }
      }
    }
    groups.push(cells);
  }
  const pixelsOf: number[][] = groups.map(() => []);
  for (let y = 0; y < h; y += 1) {
    const row = Math.floor(y / grid.size) * grid.cols;
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (data[p * 4 + 3]! > 0) pixelsOf[label[row + Math.floor(x / grid.size)]!]!.push(p);
    }
  }
  const pieces: Piece[] = [];
  groups.forEach((cells, index) => {
    const pixels = pixelsOf[index]!;
    if (pixels.length < Math.max(1, options.minArea)) return;
    let sx = 0;
    let sy = 0;
    const box = { x0: w, y0: h, x1: -1, y1: -1 };
    for (const p of pixels) {
      const x = p % w;
      const y = (p - x) / w;
      sx += x;
      sy += y;
      if (x < box.x0) box.x0 = x;
      if (y < box.y0) box.y0 = y;
      if (x > box.x1) box.x1 = x;
      if (y > box.y1) box.y1 = y;
    }
    pieces.push({
      frame: frameIndex,
      pixels: Int32Array.from(pixels),
      cells: Int32Array.from(cells),
      area: pixels.length,
      cx: sx / pixels.length,
      cy: sy / pixels.length,
      box,
      embedding: embedPixels(data, pixels),
    });
  });
  return pieces;
}

/* ---------------- characters ---------------- */

export interface CharacterAppearance {
  frame: number;
  area: number;
  box: { x: number; y: number; width: number; height: number };
  /** Its pixels in this frame came from a piece shared with another character, split between them. */
  split: boolean;
}

export interface FoundCharacter {
  id: string;
  /** Its embedding: the share of its colour in each bin. */
  embedding: Float64Array;
  /** Its commonest colours, most first, as #rrggbb. */
  palette: string[];
  frames: CharacterAppearance[];
}

export interface CharacterResult {
  width: number;
  height: number;
  frameCount: number;
  characters: FoundCharacter[];
  /** For each frame, each pixel's character: 0 for none, else its place in `characters` plus one. */
  owners: Uint8Array[];
  stats: {
    pieces: number;
    /** Pieces split between characters. */
    split: number;
    /** Groups of pieces found to be blends of two characters. */
    blends: number;
    /** Characters left out for being in too few frames. */
    tooFew: number;
  };
}

export interface CharacterProgress {
  stage: 'pieces' | 'group' | 'assign';
  done: number;
  total: number;
}

interface Group {
  sum: Float64Array;
  weight: number;
  pieces: Piece[];
  /** Set when the group is a blend of two others. */
  blendOf?: [number, number];
}

const meanOf = (group: Group): Float64Array => {
  const mean = new Float64Array(group.sum.length);
  for (let i = 0; i < mean.length; i += 1) mean[i] = group.sum[i]! / Math.max(1e-9, group.weight);
  return mean;
};

const hex = (bin: number): string => {
  const b = bin % LEVELS;
  const g = Math.floor(bin / LEVELS) % LEVELS;
  const r = Math.floor(bin / (LEVELS * LEVELS));
  return `#${[r, g, b].map((level) => Math.round(level * STEP).toString(16).padStart(2, '0')).join('')}`;
};

function paletteOf(embedding: Float64Array): string[] {
  return [...embedding.keys()]
    .sort((a, b) => embedding[b]! - embedding[a]!)
    .slice(0, 4)
    .filter((bin) => embedding[bin]! > 0.04)
    .map(hex);
}

/** How far each pixel of a box is from the nearest marked one, in pixels (a two-pass chamfer, near enough to straight-line). */
export function chamferDistance(mask: Uint8Array, width: number, height: number): Float32Array {
  const d = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  for (let p = 0; p < mask.length; p += 1) if (mask[p]) d[p] = 0;
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      let v = d[p]!;
      if (x > 0) v = Math.min(v, d[p - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[p - width]! + 1);
        if (x > 0) v = Math.min(v, d[p - width - 1]! + diagonal);
        if (x < width - 1) v = Math.min(v, d[p - width + 1]! + diagonal);
      }
      d[p] = v;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const p = y * width + x;
      let v = d[p]!;
      if (x < width - 1) v = Math.min(v, d[p + 1]! + 1);
      if (y < height - 1) {
        v = Math.min(v, d[p + width]! + 1);
        if (x < width - 1) v = Math.min(v, d[p + width + 1]! + diagonal);
        if (x > 0) v = Math.min(v, d[p + width - 1]! + diagonal);
      }
      d[p] = v;
    }
  }
  return d;
}

/**
 * Find the characters in the frames and give each pixel to one (see the top
 * of this file). All frames must be the same size. A generator, yielding as
 * it goes, so a page can run it a slice at a time.
 */
export function* characterWork(frames: readonly Bitmap[], options: CharacterOptions): Generator<CharacterProgress, CharacterResult> {
  const first = frames[0];
  const width = first?.width ?? 0;
  const height = first?.height ?? 0;
  if (frames.some((frame) => frame.width !== width || frame.height !== height)) throw new Error('the frames are not all the same size');
  const grid = gridFor(width, height, options.join);
  const sameness = Math.max(0, Math.min(100, options.sameness)) / 100;

  // Pieces, frame by frame.
  const byFrame: Piece[][] = [];
  for (let f = 0; f < frames.length; f += 1) {
    yield { stage: 'pieces', done: f, total: frames.length };
    byFrame.push(framePieces(frames[f]!, f, options));
  }
  const all = byFrame.flat();

  // 1. Group pieces by embedding, the frames with the most pieces first: there the characters are apart.
  yield { stage: 'group', done: 0, total: 1 };
  const order = [...all].sort((a, b) => byFrame[b.frame]!.length - byFrame[a.frame]!.length || b.area - a.area);
  const groups: Group[] = [];
  const groupOf = new Map<Piece, number>();
  for (const piece of order) {
    let best = -1;
    let bestSimilarity = sameness;
    groups.forEach((group, index) => {
      const similarity = embeddingSimilarity(piece.embedding, meanOf(group));
      if (similarity >= bestSimilarity) {
        best = index;
        bestSimilarity = similarity;
      }
    });
    if (best < 0) {
      groups.push({ sum: new Float64Array(COLOUR_EMBEDDING_SIZE), weight: 0, pieces: [] });
      best = groups.length - 1;
    }
    const group = groups[best]!;
    for (let i = 0; i < COLOUR_EMBEDDING_SIZE; i += 1) group.sum[i] = group.sum[i]! + piece.embedding[i]! * piece.area;
    group.weight += piece.area;
    group.pieces.push(piece);
    groupOf.set(piece, best);
  }

  // Blends: a group whose colours are two others' mixed, in frames where those two are not apart.
  const means = groups.map(meanOf);
  const framesOf = groups.map((group) => new Set(group.pieces.map((piece) => piece.frame)));
  let blends = 0;
  for (;;) {
    let found: { group: number; of: [number, number]; gain: number } | null = null;
    for (let c = 0; c < groups.length; c += 1) {
      if (groups[c]!.blendOf) continue;
      for (let a = 0; a < groups.length; a += 1) {
        if (a === c || groups[a]!.blendOf) continue;
        for (let b = a + 1; b < groups.length; b += 1) {
          if (b === c || groups[b]!.blendOf) continue;
          const blend = bestBlend(means[c]!, means[a]!, means[b]!);
          const alone = Math.max(embeddingSimilarity(means[c]!, means[a]!), embeddingSimilarity(means[c]!, means[b]!));
          const gain = blend.similarity - alone;
          if (blend.similarity < sameness || gain < 0.04 || blend.weight < 0.1 || blend.weight > 0.9) continue;
          // Where it is, the two are mostly not apart: a blend is the two of them together.
          let apart = 0;
          for (const frame of framesOf[c]!) if (framesOf[a]!.has(frame) && framesOf[b]!.has(frame)) apart += 1;
          if (apart > framesOf[c]!.size / 2) continue;
          if (!found || gain > found.gain) found = { group: c, of: [a, b], gain };
        }
      }
    }
    if (!found) break;
    groups[found.group]!.blendOf = found.of;
    blends += 1;
  }

  // The characters: the groups that are not blends.
  const characterGroups = groups.map((group, index) => (group.blendOf ? -1 : index)).filter((index) => index >= 0);
  const characterOf = new Map(characterGroups.map((group, index) => [group, index]));
  const count = characterGroups.length;

  // Where each character is, cleanly, in each frame: its own group's pieces.
  const clean: Array<Map<number, Piece[]>> = characterGroups.map(() => new Map());
  for (const piece of all) {
    const character = characterOf.get(groupOf.get(piece)!);
    if (character === undefined) continue;
    const list = clean[character]!.get(piece.frame) ?? [];
    list.push(piece);
    clean[character]!.set(piece.frame, list);
  }
  const cleanFrames = clean.map((map) => [...map.keys()].sort((a, b) => a - b));
  const centreOf = (pieces: Piece[]) => {
    const area = pieces.reduce((sum, piece) => sum + piece.area, 0);
    return { x: pieces.reduce((sum, piece) => sum + piece.cx * piece.area, 0) / area, y: pieces.reduce((sum, piece) => sum + piece.cy * piece.area, 0) / area };
  };

  /**
   * Where a character is expected in a frame it is not cleanly in: its pieces
   * in the nearest frame it was, moved by how far its centre moved between
   * the frames either side (by `dx`, `dy` pixels). Null if it is nowhere near
   * in time.
   */
  const expectedPlace = (character: number, frame: number): { from: Piece[]; dx: number; dy: number } | null => {
    const known = cleanFrames[character]!;
    let before = -1;
    let after = -1;
    for (const f of known) {
      if (f < frame) before = f;
      else if (f > frame && after < 0) after = f;
    }
    if (before < 0 && after < 0) return null;
    const nearest = before < 0 ? after : after < 0 ? before : frame - before <= after - frame ? before : after;
    if (Math.abs(nearest - frame) > 3) return null;
    const from = clean[character]!.get(nearest)!;
    const centre = centreOf(from);
    let target = centre;
    if (before >= 0 && after >= 0) {
      const a = centreOf(clean[character]!.get(before)!);
      const b = centreOf(clean[character]!.get(after)!);
      const t = (frame - before) / (after - before);
      target = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    return { from, dx: Math.round(target.x - centre.x), dy: Math.round(target.y - centre.y) };
  };
  /** The same, as patches. */
  const expected = (character: number, frame: number): Set<number> | null => {
    const place = expectedPlace(character, frame);
    if (!place) return null;
    const sx = Math.round(place.dx / grid.size);
    const sy = Math.round(place.dy / grid.size);
    const cells = new Set<number>();
    for (const piece of place.from) {
      for (const cell of piece.cells) {
        const x = (cell % grid.cols) + sx;
        const y = Math.floor(cell / grid.cols) + sy;
        if (x >= 0 && y >= 0 && x < grid.cols && y < grid.rows) cells.add(y * grid.cols + x);
      }
    }
    return cells;
  };

  // 2. Each piece, frame by frame.
  const owners = frames.map(() => new Uint8Array(width * height));
  const splitIn: Array<Set<number>> = Array.from({ length: count }, () => new Set());
  let splitPieces = 0;
  const reach = Math.max(1, Math.ceil(options.maxMove / grid.size));
  const sigma = Math.max(3, grid.size * 1.5);
  for (let f = 0; f < frames.length; f += 1) {
    yield { stage: 'assign', done: f, total: frames.length };
    const pieces = byFrame[f]!;
    const present = new Set(pieces.map((piece) => characterOf.get(groupOf.get(piece)!)).filter((character): character is number => character !== undefined));
    const predicted = new Map<number, Set<number>>();
    for (let character = 0; character < count; character += 1) {
      if (present.has(character)) {
        const cells = new Set<number>();
        for (const piece of clean[character]!.get(f) ?? []) for (const cell of piece.cells) cells.add(cell);
        predicted.set(character, cells);
      } else {
        const cells = expected(character, f);
        if (cells) predicted.set(character, cells);
      }
    }
    for (const piece of pieces) {
      const group = groups[groupOf.get(piece)!]!;
      const own = characterOf.get(groupOf.get(piece)!);
      const candidates = new Set<number>();
      if (own !== undefined) candidates.add(own);
      if (group.blendOf) for (const part of group.blendOf) candidates.add(characterOf.get(part)!);
      // Another character that is not cleanly anywhere in this frame, but is expected where this piece is.
      for (const [character, cells] of predicted) {
        if (candidates.has(character) || present.has(character)) continue;
        let near = false;
        for (const cell of piece.cells) {
          const x = cell % grid.cols;
          const y = (cell - x) / grid.cols;
          for (let dy = -1; dy <= 1 && !near; dy += 1) for (let dx = -1; dx <= 1 && !near; dx += 1) if (cells.has((y + dy) * grid.cols + (x + dx))) near = true;
          if (near) break;
        }
        if (near) candidates.add(character);
      }
      const list = [...candidates];
      const owner = owners[f]!;
      if (list.length === 1) {
        for (const p of piece.pixels) owner[p] = list[0]! + 1;
        continue;
      }
      if (list.length === 0) continue;
      // Split: each pixel to the likeliest character, by its colour and how near its patch is to where each was.
      splitPieces += 1;
      const embeddings = list.map((character) => means[characterGroups[character]!]!);
      // Where each was, to the pixel, not counting this piece: elsewhere in this frame, or else the frames either side.
      const margin = reach * grid.size;
      const bx0 = Math.max(0, piece.box.x0 - margin);
      const by0 = Math.max(0, piece.box.y0 - margin);
      const bw = Math.min(width, piece.box.x1 + margin + 1) - bx0;
      const bh = Math.min(height, piece.box.y1 + margin + 1) - by0;
      const distance = list.map((character) => {
        const mask = new Uint8Array(bw * bh);
        let any = false;
        const mark = (pieces: Piece[], dx: number, dy: number) => {
          for (const other of pieces) {
            for (const q of other.pixels) {
              const x = (q % width) + dx - bx0;
              const y = Math.floor(q / width) + dy - by0;
              if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
              mask[y * bw + x] = 1;
              any = true;
            }
          }
        };
        const elsewhere = (clean[character]!.get(f) ?? []).filter((other) => other !== piece);
        if (elsewhere.length > 0) mark(elsewhere, 0, 0);
        else {
          const place = expectedPlace(character, f);
          if (place) mark(place.from, place.dx, place.dy);
        }
        return any ? chamferDistance(mask, bw, bh) : null;
      });
      const data = frames[f]!.data;
      const counts = new Map<number, number>();
      for (const p of piece.pixels) {
        const bin = binOf(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!);
        const local = (Math.floor(p / width) - by0) * bw + ((p % width) - bx0);
        let best = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < list.length; i += 1) {
          const d = distance[i]?.[local];
          // Nowhere known near: neither near nor far.
          const near = d === undefined || !Number.isFinite(d) ? 0.05 : Math.exp(-(d * d) / (2 * sigma * sigma));
          const score = Math.log(embeddings[i]![bin]! + 1e-4) + Math.log(near + 1e-4);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        owner[p] = list[best]! + 1;
        counts.set(list[best]!, (counts.get(list[best]!) ?? 0) + 1);
      }
      // A stray pixel or two that went the other way among its neighbours follows them.
      for (const p of piece.pixels) {
        const x = p % width;
        const y = (p - x) / width;
        const tally = new Map<number, number>();
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const value = owner[ny * width + nx]!;
            if (value) tally.set(value, (tally.get(value) ?? 0) + 1);
          }
        }
        let top = owner[p]!;
        let topCount = tally.get(top) ?? 0;
        for (const [value, n] of tally) if (n > topCount + 2) {
          top = value;
          topCount = n;
        }
        owner[p] = top;
      }
      for (const character of counts.keys()) splitIn[character]!.add(f);
    }
  }

  // 3. Each character's frames, and too few left out.
  const appearances = (index: number): CharacterAppearance[] => {
    const out: CharacterAppearance[] = [];
    for (let f = 0; f < frames.length; f += 1) {
      const owner = owners[f]!;
      let area = 0;
      let x0 = width;
      let y0 = height;
      let x1 = -1;
      let y1 = -1;
      for (let p = 0; p < owner.length; p += 1) {
        if (owner[p] !== index + 1) continue;
        area += 1;
        const x = p % width;
        const y = (p - x) / width;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      if (area > 0) out.push({ frame: f, area, box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, split: splitIn[index]!.has(f) });
    }
    return out;
  };
  const found = characterGroups.map((group, index) => ({ index, embedding: means[group]!, frames: appearances(index) }));
  const kept = found.filter((character) => character.frames.length >= Math.max(1, options.minFrames));
  // In the order they come in: first frame, then left to right.
  kept.sort((a, b) => a.frames[0]!.frame - b.frames[0]!.frame || a.frames[0]!.box.x - b.frames[0]!.box.x);
  const renumber = new Uint8Array(count + 1);
  kept.forEach((character, place) => (renumber[character.index + 1] = place + 1));
  for (const owner of owners) for (let p = 0; p < owner.length; p += 1) if (owner[p]) owner[p] = renumber[owner[p]!]!;
  return {
    width,
    height,
    frameCount: frames.length,
    characters: kept.map((character, place) => ({ id: `c${place + 1}`, embedding: character.embedding, palette: paletteOf(character.embedding), frames: character.frames })),
    owners,
    stats: { pieces: all.length, split: splitPieces, blends, tooFew: found.length - kept.length },
  };
}

/** `characterWork`, all at once. */
export function findCharacters(frames: readonly Bitmap[], options: CharacterOptions): CharacterResult {
  const work = characterWork(frames, options);
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

/* ---------------- edits by hand ---------------- */

/** A character's name: the one given, or "Character n". */
export function characterName(data: Pick<CharacterSplitFlowData, 'names'>, id: string): string {
  return data.names[id]?.trim() || `Character ${id.replace(/^c/, '')}`;
}

/**
 * The characters as edited by hand: those joined made one (the second's
 * frames go to the first), those left out gone. Owners are renumbered to
 * match. Edits naming characters that are not there are passed over.
 */
export function applyCharacterEdits(result: CharacterResult, data: Pick<CharacterSplitFlowData, 'joined' | 'dropped'>): CharacterResult {
  const ids = result.characters.map((character) => character.id);
  // Where each character goes: itself, or the one it was joined to (followed through chains).
  const into = new Map(ids.map((id) => [id, id]));
  const root = (id: string): string => {
    let at = id;
    for (let guard = 0; guard < ids.length && into.get(at) !== at; guard += 1) at = into.get(at)!;
    return at;
  };
  for (const [keep, gone] of data.joined) {
    if (!into.has(keep) || !into.has(gone)) continue;
    const a = root(keep);
    const b = root(gone);
    if (a !== b) into.set(b, a);
  }
  const dropped = new Set(data.dropped);
  const survivors = ids.filter((id) => root(id) === id && !dropped.has(id));
  const place = new Map(survivors.map((id, index) => [id, index + 1]));
  const remap = new Uint8Array(ids.length + 1);
  ids.forEach((id, index) => (remap[index + 1] = place.get(root(id)) ?? 0));
  const owners = result.owners.map((owner) => {
    const out = new Uint8Array(owner.length);
    for (let p = 0; p < owner.length; p += 1) if (owner[p]) out[p] = remap[owner[p]!]!;
    return out;
  });
  const characters = survivors.map((id) => {
    const members = result.characters.filter((character) => root(character.id) === id);
    const frames = new Map<number, CharacterAppearance>();
    for (const member of members) {
      for (const appearance of member.frames) {
        const was = frames.get(appearance.frame);
        if (!was) {
          frames.set(appearance.frame, { ...appearance, box: { ...appearance.box } });
          continue;
        }
        const x0 = Math.min(was.box.x, appearance.box.x);
        const y0 = Math.min(was.box.y, appearance.box.y);
        const x1 = Math.max(was.box.x + was.box.width, appearance.box.x + appearance.box.width);
        const y1 = Math.max(was.box.y + was.box.height, appearance.box.y + appearance.box.height);
        frames.set(appearance.frame, { frame: appearance.frame, area: was.area + appearance.area, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, split: was.split || appearance.split });
      }
    }
    const lead = members[0]!;
    return { ...lead, frames: [...frames.values()].sort((a, b) => a.frame - b.frame) };
  });
  return { ...result, characters, owners };
}

/* ---------------- what is written ---------------- */

/** One character's pixels in one frame, clear elsewhere. */
export function characterImage(frame: Bitmap, owner: Uint8Array, place: number): Bitmap {
  const data = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let p = 0; p < owner.length; p += 1) {
    if (owner[p] !== place + 1) continue;
    data[p * 4] = frame.data[p * 4]!;
    data[p * 4 + 1] = frame.data[p * 4 + 1]!;
    data[p * 4 + 2] = frame.data[p * 4 + 2]!;
    data[p * 4 + 3] = frame.data[p * 4 + 3]!;
  }
  return { width: frame.width, height: frame.height, data };
}

/** The box round everything a character is in, over all its frames, a few pixels wider, with even sides (for video). */
export function characterBox(character: FoundCharacter, width: number, height: number, pad = 4): { x: number; y: number; width: number; height: number } {
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (const appearance of character.frames) {
    x0 = Math.min(x0, appearance.box.x);
    y0 = Math.min(y0, appearance.box.y);
    x1 = Math.max(x1, appearance.box.x + appearance.box.width);
    y1 = Math.max(y1, appearance.box.y + appearance.box.height);
  }
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width, x1 + pad);
  y1 = Math.min(height, y1 + pad);
  let w = Math.max(2, x1 - x0);
  let h = Math.max(2, y1 - y0);
  if (w % 2) w = x0 + w + 1 <= width ? w + 1 : w - 1;
  if (h % 2) h = y0 + h + 1 <= height ? h + 1 : h - 1;
  return { x: x0, y: y0, width: Math.max(2, w), height: Math.max(2, h) };
}

/** Where each cell of a character's sheet goes: its frames in order, in rows of up to `perRow`. */
export function sheetLayout(frames: number, cell: { width: number; height: number }, perRow = 8): { width: number; height: number; at: (index: number) => { x: number; y: number } } {
  const cols = Math.max(1, Math.min(perRow, frames));
  const rows = Math.max(1, Math.ceil(frames / cols));
  return { width: cols * cell.width, height: rows * cell.height, at: (index) => ({ x: (index % cols) * cell.width, y: Math.floor(index / cols) * cell.height }) };
}

/** A character's files, by its place: `character-1`, so they sort and stay apart from another flow's. */
export function characterSlug(place: number): string {
  return `character-${place + 1}`;
}

export function characterFrameName(place: number, frameName: string): string {
  return `${characterSlug(place)}-${frameName.replace(/^.*\//, '')}`;
}

/** The frames' rate from their times, for a character's clip: one less than the frames over the time they span. */
export function frameRateOfTimes(times: readonly (number | null)[], fallback = 12): number {
  const known = times.filter((time): time is number => time !== null);
  if (known.length < 2) return fallback;
  const span = known[known.length - 1]! - known[0]!;
  if (!(span > 0)) return fallback;
  return Math.max(0.5, Math.min(120, Math.round(((known.length - 1) / span) * 100) / 100));
}

/** characters.json: each character, its colours, and every frame it is in. */
export function charactersFile(
  data: CharacterSplitFlowData,
  result: CharacterResult,
  frameNames: readonly string[],
  times: readonly (number | null)[],
  boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): string {
  return `${JSON.stringify(
    {
      kind: 'characters',
      version: 1,
      size: { width: result.width, height: result.height },
      frames: result.frameCount,
      settings: { join: data.join, minArea: data.minArea, sameness: data.sameness, maxMove: data.maxMove, minFrames: data.minFrames },
      characters: result.characters.map((character, place) => ({
        id: character.id,
        name: characterName(data, character.id),
        files: { clip: `${characterSlug(place)}.webm`, sheet: `${characterSlug(place)}.png`, box: boxes[place] ?? null },
        palette: character.palette,
        embedding: Array.from(character.embedding, (value) => Math.round(value * 10_000) / 10_000),
        frames: character.frames.map((appearance) => ({
          frame: appearance.frame,
          source: frameNames[appearance.frame] ?? null,
          file: characterFrameName(place, frameNames[appearance.frame] ?? `frame-${appearance.frame + 1}.png`),
          time: times[appearance.frame] ?? null,
          area: appearance.area,
          box: appearance.box,
          split: appearance.split,
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

/** The report, in words. */
export function charactersReport(data: CharacterSplitFlowData, result: CharacterResult | null, frameNames: readonly string[] = []): string {
  const lines = ['# Characters', ''];
  if (!result) return `${lines.join('\n')}Not worked out yet: open the flow and press Read the frames.\n`;
  lines.push(
    `${result.frameCount} frame(s), ${result.width} × ${result.height}: ${result.stats.pieces} piece(s) found, ${result.characters.length} character(s).`,
    '',
    `- Pieces within ${data.join} px are one; under ${data.minArea} px left out. Colours ${data.sameness}% alike are one character.`,
    `- ${result.stats.blends} group(s) of pieces were two characters together; ${result.stats.split} piece(s) were split between characters, by colour and by where each was in the frames next to it (up to ${data.maxMove} px a frame).`,
    result.stats.tooFew > 0 ? `- ${result.stats.tooFew} character(s) in fewer than ${data.minFrames} frame(s) left out.` : `- Every character is in at least ${data.minFrames} frame(s).`,
    data.dropped.length > 0 || data.joined.length > 0 ? `- By hand: ${data.joined.length} joined, ${data.dropped.length} left out.` : '- Nothing changed by hand.',
    '',
  );
  result.characters.forEach((character, place) => {
    lines.push(
      `## ${characterName(data, character.id)} (\`${characterSlug(place)}\`)`,
      '',
      `Colours ${character.palette.join(', ') || '—'}; in ${character.frames.length} of ${result.frameCount} frame(s)${character.frames.some((appearance) => appearance.split) ? `, split from another in ${character.frames.filter((appearance) => appearance.split).length}` : ''}.`,
      '',
      ...character.frames.map((appearance) => `- ${frameNames[appearance.frame] ?? `frame ${appearance.frame + 1}`}: ${appearance.area} px at ${appearance.box.x}, ${appearance.box.y} (${appearance.box.width} × ${appearance.box.height})${appearance.split ? ', split' : ''}`),
      '',
    );
  });
  return lines.join('\n');
}

export function summariseCharacters(data: CharacterSplitFlowData): string {
  if (!data.frames) return 'No frames read yet.';
  return `${data.frames.count} frame(s), ${data.frames.width} × ${data.frames.height}; colours ${data.sameness}% alike are one character`;
}
