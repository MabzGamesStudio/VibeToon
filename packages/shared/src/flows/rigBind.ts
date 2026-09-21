import { newId } from '../ids';
import { boneById, childrenOf, restPose, type Bone, type RigFlowData } from './rig';
import { containsPoint, emptyVectorImage, type VectorImage, type VectorPoint, type VectorShape } from './vector';

/**
 * Binding a drawing to a skeleton.
 *
 * A vectorized drawing is a pile of shapes and a rig is a hierarchy of bones;
 * neither knows about the other. Binding is the map between them: which shapes
 * move when which bone does.
 *
 * Every shape belongs to at most one bone. A shape belonging to two would have
 * to be torn between them when they move apart, and tearing a shape is a thing
 * only a mesh can do — these are outlines, and an outline has to go somewhere
 * whole. Where a drawing really does need to bend across a joint, the answer is
 * to cut the shape in the vector editor and bind the halves separately.
 */

export interface BindFlowData {
  editor: 'bind';
  /** The skeleton, taken in from upstream and editable here. */
  rig: RigFlowData | null;
  /** The drawing, taken in from upstream. */
  image: VectorImage | null;
  /** Which bone each shape belongs to. A shape not in here is unbound. */
  binding: Record<string, string>;
  /** Shapes picked out in the editor. */
  selected: string[];
  /** The bone being assigned to. */
  boneId: string | null;
  rigHash?: string;
  vectorHash?: string;
  edits: number;
}

export function emptyBindFlowData(): BindFlowData {
  return {
    editor: 'bind',
    rig: null,
    image: null,
    binding: {},
    selected: [],
    boneId: null,
    edits: 0,
  };
}

export function imageOfBinding(data: BindFlowData): VectorImage {
  return data.image ?? emptyVectorImage();
}

/** Is what is held still describing what is wired in? */
export function bindState(
  data: BindFlowData,
  rigHash: string | undefined,
  vectorHash: string | undefined,
): 'none' | 'stale' | 'ready' {
  if (!data.rig || !data.image) return 'none';
  const rigMoved = rigHash !== undefined && data.rigHash !== undefined && data.rigHash !== rigHash;
  const drawingMoved =
    vectorHash !== undefined && data.vectorHash !== undefined && data.vectorHash !== vectorHash;
  return rigMoved || drawingMoved ? 'stale' : 'ready';
}

/**
 * Lay a skeleton over a drawing.
 *
 * The two were made in different spaces and neither knows it. A rig is about a
 * hundred rig units tall and hangs around the origin; a drawing is however many
 * pixels wide the picture was. Taken in as they are, the skeleton lands in the
 * corner as a thin sliver and there is no bone to aim at — which makes binding,
 * the entire job of this flow, impossible to do.
 *
 * So the rig is scaled and moved to sit inside the drawing: fitted by whichever
 * dimension is tighter, so it stays in proportion, and centred. The proportions
 * are the rig's own and are not touched; only where it sits and how big it is.
 */
export function fitRigTo(rig: RigFlowData, image: VectorImage, margin = 0.08): RigFlowData {
  const pose = restPose({ ...rig, origin: { x: 0, y: 0 } });
  if (pose.size === 0 || image.width === 0 || image.height === 0) return rig;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const place of pose.values()) {
    for (const point of [place.from, place.to]) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  const spread = { x: Math.max(1e-6, maxX - minX), y: Math.max(1e-6, maxY - minY) };
  const room = { x: image.width * (1 - margin * 2), y: image.height * (1 - margin * 2) };
  const scale = Math.min(room.x / spread.x, room.y / spread.y);

  // Every offset scales; where the root goes is then whatever puts the scaled
  // skeleton in the middle of the picture.
  const bones = rig.bones.map((bone) => ({
    ...bone,
    offset: { x: bone.offset.x * scale, y: bone.offset.y * scale },
  }));
  return {
    ...rig,
    bones,
    origin: {
      x: image.width / 2 - ((minX + maxX) / 2) * scale,
      y: image.height / 2 - ((minY + maxY) / 2) * scale,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Assigning
 * ------------------------------------------------------------------ */

export function bindShapes(data: BindFlowData, shapeIds: readonly string[], boneId: string): BindFlowData {
  if (shapeIds.length === 0) return data;
  const binding = { ...data.binding };
  for (const id of shapeIds) binding[id] = boneId;
  return { ...data, binding, edits: data.edits + 1 };
}

export function unbindShapes(data: BindFlowData, shapeIds: readonly string[]): BindFlowData {
  if (shapeIds.length === 0) return data;
  const binding = { ...data.binding };
  let changed = false;
  for (const id of shapeIds) {
    if (id in binding) {
      delete binding[id];
      changed = true;
    }
  }
  return changed ? { ...data, binding, edits: data.edits + 1 } : data;
}

export function shapesFor(data: BindFlowData, boneId: string): VectorShape[] {
  return imageOfBinding(data).shapes.filter((shape) => data.binding[shape.id] === boneId);
}

export function unboundShapes(data: BindFlowData): VectorShape[] {
  return imageOfBinding(data).shapes.filter((shape) => !(shape.id in data.binding));
}

/** The middle of a shape, for deciding which side of a line it falls. */
export function centroid(shape: VectorShape): VectorPoint {
  const points = shape.points;
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/**
 * Every shape inside a drawn region.
 *
 * By centre rather than by whole shape: a lasso round an arm would otherwise
 * miss every shape whose outline strays a pixel outside it, and asking someone
 * to enclose a shape exactly is asking them to do the binding twice.
 */
export function shapesInRegion(image: VectorImage, region: VectorPoint[]): string[] {
  if (region.length < 3) return [];
  const asPolygon: VectorShape = { id: '', kind: 'polygon', color: '#000000', points: region };
  return image.shapes.filter((shape) => containsPoint(asPolygon, centroid(shape))).map((shape) => shape.id);
}

/* ------------------------------------------------------------------ *
 * Editing the skeleton
 * ------------------------------------------------------------------ */

/**
 * Add a bone, hanging off another.
 *
 * `at` is where its far end goes, in rig units; the offset is worked out from
 * where the parent's far end already is, so a bone can be placed by pointing at
 * the drawing rather than by doing arithmetic about a hierarchy.
 */
export function addBone(
  data: BindFlowData,
  parentId: string | undefined,
  name: string,
  at: VectorPoint,
): BindFlowData {
  if (!data.rig) return data;
  const pose = restPose(data.rig);
  const origin = parentId ? pose.get(parentId)?.to : { x: 0, y: 0 };
  if (!origin) return data;

  const bone: Bone = {
    id: newId('bone'),
    name: name.trim() || 'New bone',
    ...(parentId ? { parent: parentId } : {}),
    offset: { x: at.x - origin.x, y: at.y - origin.y },
    stretch: { min: 1, max: 1, stiffness: 1 },
    angles: { min: -90, max: 90, stiffness: 0.5 },
  };
  return {
    ...data,
    rig: { ...data.rig, bones: [...data.rig.bones, bone] },
    boneId: bone.id,
    edits: data.edits + 1,
  };
}

/**
 * Remove a bone.
 *
 * Its children are re-hung on its parent, keeping where they are in the world —
 * deleting a bone should take that bone away, not collapse everything below it
 * onto the origin. Shapes bound to it move to the parent for the same reason:
 * they were drawn somewhere and they should stay there.
 */
export function deleteBone(data: BindFlowData, boneId: string): BindFlowData {
  if (!data.rig) return data;
  const bone = boneById(data.rig, boneId);
  if (!bone) return data;

  const children = childrenOf(data.rig, boneId);
  const bones = data.rig.bones
    .filter((candidate) => candidate.id !== boneId)
    .map((candidate) => {
      if (candidate.parent !== boneId) return candidate;
      return {
        ...candidate,
        ...(bone.parent ? { parent: bone.parent } : {}),
        // The child hung off this bone's far end; now it hangs off the parent's,
        // so it inherits the step this bone was making.
        offset: { x: candidate.offset.x + bone.offset.x, y: candidate.offset.y + bone.offset.y },
      } satisfies Bone;
    })
    .map((candidate) => (bone.parent ? candidate : stripParent(candidate, boneId)));

  const binding = { ...data.binding };
  for (const [shape, held] of Object.entries(binding)) {
    if (held !== boneId) continue;
    if (bone.parent) binding[shape] = bone.parent;
    else delete binding[shape];
  }

  return {
    ...data,
    rig: { ...data.rig, bones },
    binding,
    boneId: data.boneId === boneId ? (bone.parent ?? null) : data.boneId,
    selected: data.selected,
    edits: data.edits + 1,
    ...(children.length > 0 ? {} : {}),
  };
}

/** A child of a deleted root becomes a root itself rather than an orphan. */
function stripParent(bone: Bone, deleted: string): Bone {
  if (bone.parent !== deleted) return bone;
  const { parent: _parent, ...rest } = bone;
  return rest;
}

export function renameBone(data: BindFlowData, boneId: string, name: string): BindFlowData {
  if (!data.rig) return data;
  return {
    ...data,
    rig: {
      ...data.rig,
      bones: data.rig.bones.map((bone) => (bone.id === boneId ? { ...bone, name } : bone)),
    },
    edits: data.edits + 1,
  };
}

/* ------------------------------------------------------------------ *
 * What comes out
 * ------------------------------------------------------------------ */

/** The rig, the drawing and the map between them: what downstream flows read. */
export interface BoundRig {
  rig: RigFlowData;
  image: VectorImage;
  binding: Record<string, string>;
}

export function boundRigOf(data: BindFlowData): BoundRig | null {
  if (!data.rig || !data.image) return null;
  return { rig: data.rig, image: data.image, binding: data.binding };
}

/** Read one back, dropping anything that does not refer to something real. */
export function readBoundRig(json: unknown): BoundRig | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const rig = record.rig as RigFlowData | undefined;
  const image = record.image as VectorImage | undefined;
  if (!rig || !Array.isArray(rig.bones) || !image || !Array.isArray(image.shapes)) return null;

  const bones = new Set(rig.bones.map((bone) => bone.id));
  const shapes = new Set(image.shapes.map((shape) => shape.id));
  const binding: Record<string, string> = {};
  for (const [shape, bone] of Object.entries((record.binding ?? {}) as Record<string, string>)) {
    if (shapes.has(shape) && bones.has(bone)) binding[shape] = bone;
  }
  return { rig, image, binding };
}

export interface BindSummary {
  bones: number;
  shapes: number;
  bound: number;
  unbound: number;
  /** Bones with nothing on them, which will move and take nothing with them. */
  empty: number;
  problems: string[];
}

export function summariseBinding(data: BindFlowData): BindSummary {
  const image = imageOfBinding(data);
  const bones = data.rig?.bones ?? [];
  const bound = image.shapes.filter((shape) => shape.id in data.binding).length;
  const used = new Set(Object.values(data.binding));

  const problems: string[] = [];
  const unbound = image.shapes.length - bound;
  if (image.shapes.length > 0 && bound === 0) {
    problems.push('Nothing is bound yet, so posing the rig would move an empty skeleton.');
  } else if (unbound > 0) {
    problems.push(`${unbound} shape(s) are bound to nothing and will stay put when the rig moves.`);
  }
  const empty = bones.filter((bone) => !used.has(bone.id)).length;
  if (empty > 0 && bound > 0) {
    problems.push(`${empty} bone(s) carry nothing.`);
  }

  return { bones: bones.length, shapes: image.shapes.length, bound, unbound, empty, problems };
}
