import { fromHex } from './palette';
import { allPoints, area, boundsOf, holesOf, mapPoints, type VectorImage, type VectorPoint, type VectorShape } from './vector';

/**
 * A head taken apart into the features of a face.
 *
 * A head, as a drawing, is a pile of shapes: a face shape, hair over it, two
 * dark discs, a red band. This flow says which is which — hair, eyebrows, eyes,
 * ears, nose, mouth, and the face they sit on — from where each shape is on the
 * face, how big it is, what shape it is and what color, and which shapes mirror
 * each other left and right.
 *
 * What it finds is a starting point: any shape can be given to another feature.
 * Then each feature can be hidden, looked at alone, nudged, or **swapped** for
 * the same feature of another head, fitted into the place this head's own was.
 */

export type FaceFeature =
  | 'face'
  | 'hair'
  | 'ear-left'
  | 'ear-right'
  | 'brow-left'
  | 'brow-right'
  | 'eye-left'
  | 'eye-right'
  | 'nose'
  | 'mouth';

/** In drawing order, back to front. */
export const FACE_FEATURES: FaceFeature[] = ['face', 'hair', 'ear-left', 'ear-right', 'brow-left', 'brow-right', 'eye-left', 'eye-right', 'nose', 'mouth'];

/** Left and right are as seen: the left eye is the one on the left of the picture. */
export const FACE_FEATURE_LABEL: Record<FaceFeature, string> = {
  face: 'Face',
  hair: 'Hair',
  'ear-left': 'Left ear',
  'ear-right': 'Right ear',
  'brow-left': 'Left eyebrow',
  'brow-right': 'Right eyebrow',
  'eye-left': 'Left eye',
  'eye-right': 'Right eye',
  nose: 'Nose',
  mouth: 'Mouth',
};

/** A color each feature is outlined in, so which is which can be seen at a glance. */
export const FACE_FEATURE_COLOR: Record<FaceFeature, string> = {
  face: '#e0a060',
  hair: '#b070e0',
  'ear-left': '#40c0c0',
  'ear-right': '#40a0e0',
  'brow-left': '#e0d040',
  'brow-right': '#c0e040',
  'eye-left': '#40e070',
  'eye-right': '#20c0a0',
  nose: '#ff8040',
  mouth: '#ff4070',
};

/** A feature with its side taken off: both eyes are eyes. */
export function featureKind(feature: FaceFeature): string {
  return feature.replace(/-(left|right)$/, '');
}

/** What is done with one feature of one head. */
export interface FeatureSetting {
  /** Left out of the face. */
  hidden?: boolean;
  /** Drawn with another head's feature in its place. */
  swap?: { head: string; feature: FaceFeature } | null;
  /** Nudged, in the drawing's units, and sized about its middle. */
  dx: number;
  dy: number;
  scale: number;
}

export const NEUTRAL_SETTING: FeatureSetting = { dx: 0, dy: 0, scale: 1 };

export interface FaceHead {
  id: string;
  name: string;
  /** Where it came from, to tell when it has changed. */
  source: { node: string; part: string | null; hash?: string };
  image: VectorImage;
  /** Which feature each shape is, by shape id. A shape not in here is none of them. */
  assign: Record<string, FaceFeature>;
  settings: Partial<Record<FaceFeature, FeatureSetting>>;
}

export interface FaceFlowData {
  editor: 'face';
  heads: FaceHead[];
  current: string | null;
  /** Show one feature alone. */
  isolate: FaceFeature | null;
  /** What a click gives a shape to, in the editor: a feature, no feature, or nothing (it selects). */
  paint: FaceFeature | 'none' | null;
  selected: string[];
  edits: number;
}

export function emptyFaceFlowData(): FaceFlowData {
  return { editor: 'face', heads: [], current: null, isolate: null, paint: null, selected: [], edits: 0 };
}

export function settingOf(head: FaceHead, feature: FaceFeature): FeatureSetting {
  return { ...NEUTRAL_SETTING, ...(head.settings[feature] ?? {}) };
}

/* ------------------------------------------------------------------ *
 * Measuring shapes
 * ------------------------------------------------------------------ */

interface Measured {
  shape: VectorShape;
  box: { x: number; y: number; width: number; height: number };
  centre: VectorPoint;
  area: number;
  rgb: [number, number, number];
}

function measure(shape: VectorShape): Measured {
  const points = allPoints(shape);
  const box = boundsOf(points);
  let size: number;
  if (shape.kind === 'polygon') {
    size = Math.abs(area(shape.points)) - holesOf(shape).reduce((sum, hole) => sum + Math.abs(area(hole)), 0);
  } else {
    let length = 0;
    for (let i = 1; i < shape.points.length; i += 1) length += Math.hypot(shape.points[i]!.x - shape.points[i - 1]!.x, shape.points[i]!.y - shape.points[i - 1]!.y);
    size = length * shape.width;
  }
  const rgb = fromHex(shape.color) ?? { r: 0, g: 0, b: 0 };
  return { shape, box, centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, area: Math.max(0, size), rgb: [rgb.r, rgb.g, rgb.b] };
}

const colorGap = (a: Measured, b: Measured) => Math.hypot(a.rgb[0] - b.rgb[0], a.rgb[1] - b.rgb[1], a.rgb[2] - b.rgb[2]) / 441.7;
const inside = (point: VectorPoint, box: Measured['box']) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;

/* ------------------------------------------------------------------ *
 * Finding the features
 * ------------------------------------------------------------------ */

/**
 * Say which feature each shape of a head is.
 *
 * 1. **The face** is the big shape the others sit on: of the polygons at least
 *    a third the size of the largest, the lowest — hair is big too, but above.
 * 2. Everything else is placed on the face: across it from 0 (left) to 1
 *    (right), down it from 0 (top) to 1 (chin), and sized against it.
 * 3. **Hair**: a sizeable shape reaching the top of the head, out above or
 *    beside the face, or lying across the top of it as a fringe, in a color
 *    other than the face's.
 * 4. **Ears**: at the face's sides, halfway down, smaller than hair.
 * 5. **Eyes**: the best-matched pair across the middle of the upper face —
 *    alike in size and color, level, mirrored about the middle, and not long
 *    and thin (that is an eyebrow). A shape
 *    inside an eye (a pupil, a highlight) is part of it.
 * 6. **Eyebrows**: above each eye, wider than tall.
 * 7. **Mouth**: in the middle, below the eyes; the widest thing there that is
 *    wider than tall, with what is inside it (teeth, a tongue).
 * 8. **Nose**: in the middle between the eyes and the mouth.
 *
 * Whatever fits none of these is left as none, for you to give it to one.
 */
export function identifyFace(image: VectorImage): Record<string, FaceFeature> {
  const measured = image.shapes.map(measure).filter((one) => one.box.width > 0 || one.box.height > 0);
  const assign: Record<string, FaceFeature> = {};
  if (measured.length === 0) return assign;

  const polygons = measured.filter((one) => one.shape.kind === 'polygon');
  const largest = Math.max(0, ...polygons.map((one) => one.area));
  const big = polygons.filter((one) => one.area >= largest / 3);
  const face = [...big].sort((a, b) => b.centre.y - a.centre.y)[0];
  if (!face) return assign;
  assign[face.shape.id] = 'face';

  const head = boundsOf(measured.flatMap((one) => [{ x: one.box.x, y: one.box.y }, { x: one.box.x + one.box.width, y: one.box.y + one.box.height }]));
  const fb = face.box;
  const u = (one: Measured) => (one.centre.x - fb.x) / Math.max(1e-6, fb.width);
  const v = (one: Measured) => (one.centre.y - fb.y) / Math.max(1e-6, fb.height);
  const share = (one: Measured) => one.area / Math.max(1e-6, face.area);
  const rest = () => measured.filter((one) => !(one.shape.id in assign));

  // Hair.
  for (const one of rest()) {
    const reachesTop = one.box.y <= head.y + head.height * 0.08 + 1;
    const outAbove = one.box.y < fb.y - fb.height * 0.05;
    const besideHigh = (one.box.x < fb.x - fb.width * 0.05 || one.box.x + one.box.width > fb.x + fb.width * 1.05) && v(one) < 0.45;
    // A fringe: a band across the upper face, wider than any one eyebrow could be.
    const fringe = v(one) < 0.36 && one.box.width >= fb.width * 0.6;
    if (share(one) >= 0.03 && (reachesTop || outAbove || besideHigh || fringe) && colorGap(one, face) > 0.08) assign[one.shape.id] = 'hair';
  }
  // What sits on the hair in its color is hair too.
  const hair = measured.filter((one) => assign[one.shape.id] === 'hair');
  for (const one of rest()) {
    if (hair.some((strand) => inside(one.centre, strand.box) && colorGap(one, strand) < 0.12) && v(one) < 0.3) assign[one.shape.id] = 'hair';
  }

  // Ears.
  for (const one of rest()) {
    const across = u(one);
    const down = v(one);
    if ((across < 0.1 || across > 0.9) && down > 0.2 && down < 0.85 && share(one) > 0.005 && share(one) < 0.3) {
      assign[one.shape.id] = across < 0.5 ? 'ear-left' : 'ear-right';
    }
  }

  const features = () => rest().filter((one) => u(one) > 0.05 && u(one) < 0.95 && v(one) > 0.05 && v(one) < 1.02 && share(one) < 0.2);

  // Eyes: the best mirrored pair in the upper middle.
  let eyeRow: number | null = null;
  const eyes: Record<'eye-left' | 'eye-right', Measured | null> = { 'eye-left': null, 'eye-right': null };
  {
    // An eye is not a stroke: a long thin shape up there is an eyebrow.
    const candidates = features().filter((one) => v(one) > 0.15 && v(one) < 0.7 && Math.abs(u(one) - 0.5) > 0.06 && one.shape.kind === 'polygon' && one.box.width <= one.box.height * 3.5);
    let best: { left: Measured; right: Measured; score: number } | null = null;
    for (const left of candidates) {
      if (u(left) >= 0.5) continue;
      for (const right of candidates) {
        if (u(right) <= 0.5) continue;
        const level = Math.abs(v(left) - v(right));
        const mirror = Math.abs(u(left) - 0.5 + (u(right) - 0.5));
        const size = Math.abs(Math.log((left.area + 1e-6) / (right.area + 1e-6)));
        const score = level * 2 + mirror * 2 + size * 0.5 + colorGap(left, right) * 2 + Math.abs((v(left) + v(right)) / 2 - 0.42) * 0.5;
        if (level < 0.12 && mirror < 0.15 && size < 1.2 && (!best || score < best.score)) best = { left, right, score };
      }
    }
    if (best) {
      assign[best.left.shape.id] = 'eye-left';
      assign[best.right.shape.id] = 'eye-right';
      eyes['eye-left'] = best.left;
      eyes['eye-right'] = best.right;
      eyeRow = (v(best.left) + v(best.right)) / 2;
      for (const one of rest()) {
        for (const side of ['eye-left', 'eye-right'] as const) {
          const eye = eyes[side]!;
          if (inside(one.centre, eye.box) && one.area <= eye.area * 1.2) assign[one.shape.id] = side;
        }
      }
    }
  }

  // Eyebrows: above each eye, wider than tall.
  for (const side of ['left', 'right'] as const) {
    const eye = eyes[`eye-${side}`];
    const candidates = features().filter((one) => {
      const across = u(one);
      if (side === 'left' ? across >= 0.5 : across <= 0.5) return false;
      const wide = one.shape.kind === 'line' || one.box.width > one.box.height * 1.4;
      if (!wide) return false;
      if (eye) return one.centre.y < eye.box.y + eye.box.height * 0.2 && v(one) > v(eye) - 0.3 && Math.abs(one.centre.x - eye.centre.x) < fb.width * 0.2;
      return v(one) > 0.08 && v(one) < 0.4;
    });
    const brow = candidates.sort((a, b) => b.box.width - a.box.width)[0];
    if (brow) assign[brow.shape.id] = `brow-${side}`;
  }

  // Mouth: in the middle, below the eyes — the widest thing there that is
  // wider than tall, or failing that the lowest.
  const below = eyeRow ?? 0.45;
  const under = features().filter((one) => Math.abs(u(one) - 0.5) < 0.2 && v(one) > below + 0.08);
  const wide = under.filter((one) => one.box.width >= one.box.height * 1.3);
  const mouth = wide.length > 0 ? [...wide].sort((a, b) => b.box.width - a.box.width)[0] : [...under].sort((a, b) => b.centre.y - a.centre.y)[0];
  if (mouth) {
    assign[mouth.shape.id] = 'mouth';
    for (const one of rest()) if (inside(one.centre, mouth.box) && one.area <= mouth.area) assign[one.shape.id] = 'mouth';
  }

  // Nose: in the middle, between the eyes and the mouth.
  const noseTop = eyeRow ?? 0.35;
  const noseBottom = mouth ? v(mouth) : 0.8;
  for (const one of features()) {
    if (Math.abs(u(one) - 0.5) < 0.16 && v(one) > noseTop && v(one) < noseBottom) assign[one.shape.id] = 'nose';
  }

  return assign;
}

/* ------------------------------------------------------------------ *
 * Heads
 * ------------------------------------------------------------------ */

export function makeHead(id: string, name: string, image: VectorImage, source: FaceHead['source']): FaceHead {
  return { id, name, source, image, assign: identifyFace(image), settings: {} };
}

export function headById(data: FaceFlowData, id: string | null): FaceHead | undefined {
  return id === null ? undefined : data.heads.find((head) => head.id === id);
}

export function featureShapes(head: FaceHead, feature: FaceFeature): VectorShape[] {
  return head.image.shapes.filter((shape) => head.assign[shape.id] === feature);
}

/** Shapes none of the features has. */
export function unassignedShapes(head: FaceHead): VectorShape[] {
  return head.image.shapes.filter((shape) => !head.assign[shape.id]);
}

function updateHead(data: FaceFlowData, id: string, change: (head: FaceHead) => FaceHead): FaceFlowData {
  let changed = false;
  const heads = data.heads.map((head) => {
    if (head.id !== id) return head;
    changed = true;
    return change(head);
  });
  return changed ? { ...data, heads, edits: data.edits + 1 } : data;
}

/** Give shapes to a feature, or to none (null). */
export function assignShapes(data: FaceFlowData, headId: string, ids: readonly string[], feature: FaceFeature | null): FaceFlowData {
  return updateHead(data, headId, (head) => {
    const assign = { ...head.assign };
    for (const id of ids) {
      if (feature) assign[id] = feature;
      else delete assign[id];
    }
    return { ...head, assign };
  });
}

export function setFeature(data: FaceFlowData, headId: string, feature: FaceFeature, over: Partial<FeatureSetting>): FaceFlowData {
  return updateHead(data, headId, (head) => ({ ...head, settings: { ...head.settings, [feature]: { ...settingOf(head, feature), ...over } } }));
}

/** Find the features again from scratch, forgetting what was given where. */
export function reidentify(data: FaceFlowData, headId: string): FaceFlowData {
  return updateHead(data, headId, (head) => ({ ...head, assign: identifyFace(head.image) }));
}

/** A head's shapes replaced (edited); what is gone is no longer any feature. */
export function setHeadImage(data: FaceFlowData, headId: string, image: VectorImage): FaceFlowData {
  return updateHead(data, headId, (head) => {
    const alive = new Set(image.shapes.map((shape) => shape.id));
    return { ...head, image, assign: Object.fromEntries(Object.entries(head.assign).filter(([id]) => alive.has(id))) };
  });
}

/** What another head could give this one in place of a feature: its features of the same kind. */
export function swapChoices(data: FaceFlowData, headId: string, feature: FaceFeature): Array<{ head: string; feature: FaceFeature; label: string }> {
  const kind = featureKind(feature);
  const out: Array<{ head: string; feature: FaceFeature; label: string }> = [];
  for (const head of data.heads) {
    for (const other of FACE_FEATURES) {
      if (featureKind(other) !== kind) continue;
      if (head.id === headId && other === feature) continue;
      if (featureShapes(head, other).length === 0) continue;
      out.push({ head: head.id, feature: other, label: `${head.name} · ${FACE_FEATURE_LABEL[other]}` });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Putting a face together
 * ------------------------------------------------------------------ */

type Box = { x: number; y: number; width: number; height: number };

function boxOf(shapes: readonly VectorShape[]): Box | null {
  const points = shapes.flatMap((shape) => allPoints(shape));
  return points.length > 0 ? boundsOf(points) : null;
}

function transform(shapes: readonly VectorShape[], from: Box, to: Box, scale: number, idPrefix: string): VectorShape[] {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  return shapes.map((shape) => {
    const moved = mapPoints(shape, (point) => ({ ...point, x: round(tx + (point.x - fx) * scale), y: round(ty + (point.y - fy) * scale) }));
    const sized = moved.kind === 'line' ? { ...moved, width: Math.max(0.25, moved.width * scale) } : moved;
    return idPrefix ? { ...sized, id: `${idPrefix}${shape.id}` } : sized;
  });
}

/**
 * The shapes one feature of a head is drawn with: its own, or the swapped-in
 * one fitted to where its own was, then nudged and sized. Nothing when hidden.
 */
export function composeFeature(data: FaceFlowData, head: FaceHead, feature: FaceFeature): VectorShape[] {
  const setting = settingOf(head, feature);
  if (setting.hidden) return [];
  const own = featureShapes(head, feature);
  const ownBox = boxOf(own);
  let shapes: VectorShape[] = own;
  let box = ownBox;
  const swap = setting.swap ? headById(data, setting.swap.head) : undefined;
  if (setting.swap && swap) {
    const given = featureShapes(swap, setting.swap.feature);
    const givenBox = boxOf(given);
    if (givenBox) {
      let target: Box;
      let scale: number;
      if (ownBox) {
        target = ownBox;
        // As big as the one it replaces, by the mean of width and height.
        scale = ((ownBox.width || 1) / (givenBox.width || 1) + (ownBox.height || 1) / (givenBox.height || 1)) / 2;
      } else {
        // Nothing of its own there: put it where it sat on its own face.
        const theirFace = boxOf(featureShapes(swap, 'face')) ?? boxOf(swap.image.shapes)!;
        const ourFace = boxOf(featureShapes(head, 'face')) ?? boxOf(head.image.shapes)!;
        scale = (ourFace.width || 1) / (theirFace.width || 1);
        const cx = ourFace.x + ((givenBox.x + givenBox.width / 2 - theirFace.x) / (theirFace.width || 1)) * ourFace.width;
        const cy = ourFace.y + ((givenBox.y + givenBox.height / 2 - theirFace.y) / (theirFace.height || 1)) * ourFace.height;
        target = { x: cx, y: cy, width: 0, height: 0 };
      }
      shapes = transform(given, givenBox, target, scale, `${swap.id}~`);
      box = boxOf(shapes);
    }
  }
  if (!box || (setting.dx === 0 && setting.dy === 0 && setting.scale === 1)) return shapes;
  return transform(shapes, box, { x: box.x + setting.dx, y: box.y + setting.dy, width: box.width, height: box.height }, setting.scale, '');
}

/** The whole head, with its features as they are set: back to front, and anything no feature has kept where it was drawn. */
export function composeHead(data: FaceFlowData, head: FaceHead): VectorImage {
  const byFeature = new Map(FACE_FEATURES.map((feature) => [feature, composeFeature(data, head, feature)] as const));
  const order = new Map(head.image.shapes.map((shape, index) => [shape.id, index]));
  // Features in the order their own shapes were drawn, so hair over a face
  // stays over it; a feature with nothing of its own goes where its kind would.
  const firstOf = (feature: FaceFeature) => Math.min(...featureShapes(head, feature).map((shape) => order.get(shape.id) ?? 0), Number.MAX_SAFE_INTEGER);
  const loose = unassignedShapes(head).map((shape) => ({ rank: order.get(shape.id) ?? 0, shapes: [shape] }));
  const placed = FACE_FEATURES.map((feature, index) => {
    const rank = firstOf(feature);
    return { rank: rank === Number.MAX_SAFE_INTEGER ? head.image.shapes.length + index : rank, shapes: byFeature.get(feature)! };
  });
  const shapes = [...placed, ...loose].sort((a, b) => a.rank - b.rank).flatMap((entry) => entry.shapes);
  return { ...head.image, shapes };
}

/** Where a head's shapes are, padded, to look at it. */
export function headView(head: FaceHead, pad = 0.1): Box {
  const box = boxOf(head.image.shapes) ?? { x: 0, y: 0, width: head.image.width, height: head.image.height };
  const margin = Math.max(4, Math.max(box.width, box.height) * pad);
  return { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
}

/* ------------------------------------------------------------------ *
 * What it writes
 * ------------------------------------------------------------------ */

export interface FacePartsFile {
  kind: 'faceParts';
  version: 1;
  heads: Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    features: Array<{
      id: FaceFeature;
      kind: string;
      label: string;
      hidden: boolean;
      swappedFrom: { head: string; feature: FaceFeature } | null;
      bounds: Box | null;
      shapes: VectorShape[];
    }>;
    /** Shapes that are none of the features. */
    other: VectorShape[];
  }>;
}

export function facePartsFile(data: FaceFlowData): FacePartsFile {
  return {
    kind: 'faceParts',
    version: 1,
    heads: data.heads.map((head) => ({
      id: head.id,
      name: head.name,
      width: head.image.width,
      height: head.image.height,
      features: FACE_FEATURES.map((feature) => {
        const setting = settingOf(head, feature);
        const shapes = composeFeature(data, head, feature);
        return {
          id: feature,
          kind: featureKind(feature),
          label: FACE_FEATURE_LABEL[feature],
          hidden: Boolean(setting.hidden),
          swappedFrom: setting.swap ?? null,
          bounds: boxOf(shapes),
          shapes,
        };
      }),
      other: unassignedShapes(head),
    })),
  };
}

export function summariseFace(data: FaceFlowData): string {
  if (data.heads.length === 0) return 'No heads taken in yet.';
  return data.heads
    .map((head) => {
      const found = FACE_FEATURES.filter((feature) => featureShapes(head, feature).length > 0).length;
      const swapped = FACE_FEATURES.filter((feature) => settingOf(head, feature).swap).length;
      const hidden = FACE_FEATURES.filter((feature) => settingOf(head, feature).hidden).length;
      return `${head.name}: ${found} of ${FACE_FEATURES.length} features${swapped ? `, ${swapped} swapped` : ''}${hidden ? `, ${hidden} hidden` : ''}`;
    })
    .join(' · ');
}
