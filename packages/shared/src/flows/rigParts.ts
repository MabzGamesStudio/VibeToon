import { restPose } from './rig';
import type { BoundRig } from './rigBind';
import { allPoints, boundsOf, type VectorImage, type VectorPoint, type VectorShape } from './vector';
import type { VectorBrush } from './vectorEdit';

/**
 * A bound drawing, taken apart into its body parts.
 *
 * A binding says which bone each point of the drawing follows. This flow
 * turns that into parts you can pick up: every shape goes to the part that
 * carries most of its points, so the arm is its own drawing, the head its own,
 * and so on. A shape bound to nothing goes to **Not bound**.
 *
 * Each part can then be looked at on its own and edited like any drawing —
 * move, add and delete nodes, draw and delete shapes and lines — and a shape
 * that went to the wrong part can be moved to the right one. What is written is
 * every part as it is here.
 */

/** The part a shape with no bound points goes to. */
export const UNBOUND_PART = 'unbound';

export interface RigPart {
  /** The bone's id, or `UNBOUND_PART`. */
  id: string;
  name: string;
  /** The part's own shapes, in the drawing's coordinates and at its size. */
  image: VectorImage;
}

export interface PartsFlowData {
  editor: 'parts';
  /** The bound rig the parts were taken from. */
  bound: BoundRig | null;
  boundHash?: string;
  parts: RigPart[];
  /** The part in view. */
  current: string | null;
  /** Selected shapes, in the part in view. */
  selected: string[];
  /** Show the other parts faded behind the one in view, or the part alone. */
  showOthers: boolean;
  brush?: VectorBrush;
  edits: number;
}

export function emptyPartsFlowData(): PartsFlowData {
  return { editor: 'parts', bound: null, parts: [], current: null, selected: [], showOthers: true, edits: 0 };
}

/**
 * The bone that carries most of a shape's points, or null when none of them is
 * bound. A tie goes to the bone reached first along the outline.
 */
export function majorityBone(bound: BoundRig, shape: VectorShape): string | null {
  const bones = bound.points[shape.id] ?? [];
  const counts = new Map<string, number>();
  let best: string | null = null;
  let most = 0;
  for (const bone of bones) {
    if (!bone) continue;
    const count = (counts.get(bone) ?? 0) + 1;
    counts.set(bone, count);
    if (count > most) {
      most = count;
      best = bone;
    }
  }
  return best;
}

/**
 * Take a bound drawing apart: one part per bone that carries anything, in the
 * rig's own order, and one for what nothing carries. Each shape keeps its id and
 * its place in the drawing's order.
 */
export function splitIntoParts(bound: BoundRig): RigPart[] {
  const byBone = new Map<string, VectorShape[]>();
  for (const shape of bound.image.shapes) {
    const bone = majorityBone(bound, shape) ?? UNBOUND_PART;
    byBone.set(bone, [...(byBone.get(bone) ?? []), shape]);
  }
  const { width, height } = bound.image;
  const parts: RigPart[] = [];
  for (const bone of bound.rig.bones) {
    const shapes = byBone.get(bone.id);
    if (shapes) parts.push({ id: bone.id, name: bone.name, image: { width, height, shapes } });
  }
  const loose = byBone.get(UNBOUND_PART);
  if (loose) parts.push({ id: UNBOUND_PART, name: 'Not bound', image: { width, height, shapes: loose } });
  // Bones the drawing names but the rig no longer has.
  for (const [bone, shapes] of byBone) {
    if (bone !== UNBOUND_PART && !parts.some((part) => part.id === bone)) parts.push({ id: bone, name: bone, image: { width, height, shapes } });
  }
  return parts;
}

/** Take the bound rig in, splitting it afresh. */
export function adoptBound(data: PartsFlowData, bound: BoundRig, boundHash: string | undefined): PartsFlowData {
  const parts = splitIntoParts(bound);
  return {
    ...data,
    bound,
    ...(boundHash === undefined ? {} : { boundHash }),
    parts,
    current: parts[0]?.id ?? null,
    selected: [],
    edits: 0,
  };
}

export function partsState(data: PartsFlowData, boundHash: string | undefined): 'none' | 'stale' | 'ready' {
  if (!data.bound) return 'none';
  if (boundHash && data.boundHash && boundHash !== data.boundHash) return 'stale';
  return 'ready';
}

export function partById(data: PartsFlowData, id: string | null): RigPart | undefined {
  return id === null ? undefined : data.parts.find((part) => part.id === id);
}

/** A part's shapes replaced, as an edit to it. */
export function setPartImage(data: PartsFlowData, id: string, image: VectorImage): PartsFlowData {
  return { ...data, parts: data.parts.map((part) => (part.id === id ? { ...part, image } : part)) };
}

/**
 * Move shapes from one part to another. They keep their place in the drawing's
 * order: a shape that was drawn over another still is.
 */
export function moveShapesToPart(data: PartsFlowData, ids: readonly string[], from: string, to: string): PartsFlowData {
  if (from === to || ids.length === 0) return data;
  const source = partById(data, from);
  if (!source) return data;
  const moving = new Set(ids);
  const taken = source.image.shapes.filter((shape) => moving.has(shape.id));
  if (taken.length === 0) return data;
  const order = new Map((data.bound?.image.shapes ?? []).map((shape, index) => [shape.id, index]));
  const rank = (shape: VectorShape) => order.get(shape.id) ?? Number.MAX_SAFE_INTEGER;
  let parts = data.parts.map((part) =>
    part.id === from ? { ...part, image: { ...part.image, shapes: part.image.shapes.filter((shape) => !moving.has(shape.id)) } } : part,
  );
  const target = parts.find((part) => part.id === to);
  if (target) {
    const shapes = [...target.image.shapes, ...taken].sort((a, b) => rank(a) - rank(b));
    parts = parts.map((part) => (part.id === to ? { ...part, image: { ...part.image, shapes } } : part));
  } else {
    const bone = data.bound?.rig.bones.find((one) => one.id === to);
    parts = [...parts, { id: to, name: bone?.name ?? to, image: { ...source.image, shapes: taken } }];
  }
  return { ...data, parts, selected: [], edits: data.edits + 1 };
}

/** Where a part's shapes are, padded, for looking at it alone. Null for an empty part. */
export function partView(part: RigPart, pad = 0.12): { x: number; y: number; width: number; height: number } | null {
  const points: VectorPoint[] = part.image.shapes.flatMap((shape) => allPoints(shape));
  if (points.length === 0) return null;
  const box = boundsOf(points);
  const margin = Math.max(4, Math.max(box.width, box.height) * pad);
  return { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
}

/* ------------------------------------------------------------------ *
 * What it writes
 * ------------------------------------------------------------------ */

export interface RigPartsFile {
  kind: 'rigParts';
  version: 1;
  width: number;
  height: number;
  parts: Array<{
    id: string;
    name: string;
    /** The bone it hangs from, and where the bone is at rest, in the drawing's coordinates. */
    parent: string | null;
    joint: { from: VectorPoint; to: VectorPoint } | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
    image: VectorImage;
  }>;
}

export function rigPartsFile(data: PartsFlowData): RigPartsFile | null {
  if (!data.bound) return null;
  const rest = restPose(data.bound.rig);
  return {
    kind: 'rigParts',
    version: 1,
    width: data.bound.image.width,
    height: data.bound.image.height,
    parts: data.parts.map((part) => {
      const bone = data.bound!.rig.bones.find((one) => one.id === part.id);
      const at = rest.get(part.id);
      const points = part.image.shapes.flatMap((shape) => allPoints(shape));
      return {
        id: part.id,
        name: part.name,
        parent: bone?.parent ?? null,
        joint: at ? { from: at.from, to: at.to } : null,
        bounds: points.length > 0 ? boundsOf(points) : null,
        image: part.image,
      };
    }),
  };
}

/** Read a parts file back. */
export function readRigParts(json: unknown): RigPartsFile | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Partial<RigPartsFile>;
  if (record.kind !== 'rigParts' || !Array.isArray(record.parts)) return null;
  return record as RigPartsFile;
}

/** A name safe to write as a file name. */
export function fileNameOf(name: string, fallback: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

export function summariseParts(data: PartsFlowData): string {
  if (!data.bound) return 'Nothing taken in yet.';
  const shapes = data.parts.reduce((sum, part) => sum + part.image.shapes.length, 0);
  const loose = partById(data, UNBOUND_PART)?.image.shapes.length ?? 0;
  return `${data.parts.length} part(s), ${shapes} shape(s)${loose > 0 ? ` · ${loose} shape(s) not bound to any part` : ''}`;
}
