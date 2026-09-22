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

/**
 * Where a thing sits and how big it is drawn.
 *
 * The drawing and the skeleton arrive in different spaces and neither is right.
 * Fitting the rig to the picture gets them roughly on top of each other, and
 * roughly is where the useful work starts: a skeleton has to be lined up with
 * the shoulders and hips of *this* drawing, and no automatic fit knows where
 * those are. So each is placed by hand, and independently — moving the drawing
 * under a skeleton you have already positioned is a different thing from moving
 * the skeleton over a drawing you have already framed, and wanting one is not
 * wanting the other.
 */
export interface Placement {
  /** Where the thing's own origin lands, in the picture's pixels. */
  x: number;
  y: number;
  /** How much bigger it is drawn than it is. */
  scale: number;
}

export const AS_IS: Placement = { x: 0, y: 0, scale: 1 };

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
  /** Where the drawing sits under the skeleton. */
  placement: Placement;
  /** Hide shapes another bone has already claimed, rather than fading them. */
  hideOthers: boolean;
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
    placement: { ...AS_IS },
    hideOthers: false,
    edits: 0,
  };
}

/** The drawing as taken in, before it was placed. */
export function imageOfBinding(data: BindFlowData): VectorImage {
  return data.image ?? emptyVectorImage();
}

/**
 * The drawing where it has been put.
 *
 * Kept as a transform of the original rather than written into the shapes,
 * because a placement is a thing you adjust: baking each nudge into the points
 * would round them a little every time, and after an afternoon of lining a
 * skeleton up the drawing would have quietly drifted.
 */
export function placedImage(data: BindFlowData): VectorImage {
  const image = imageOfBinding(data);
  const place = data.placement ?? AS_IS;
  if (place.x === 0 && place.y === 0 && place.scale === 1) return image;

  const shapes = image.shapes.map((shape) => ({
    ...shape,
    points: shape.points.map((point) => ({
      x: point.x * place.scale + place.x,
      y: point.y * place.scale + place.y,
    })),
    // A stroke's width is a width, so it scales with everything else.
    ...(shape.kind === 'line' ? { width: shape.width * place.scale } : {}),
  })) as VectorShape[];

  /*
   * The frame grows to hold what was put in it.
   *
   * Zooming a drawing up to meet a big skeleton pushes it past the edge of the
   * picture it came from, and a frame left at the old size clips it everywhere
   * downstream — the pose flow would show three quarters of a character and no
   * reason why. Growing rather than re-centring, because re-centring would move
   * the drawing out from under the skeleton it was just lined up with.
   */
  let right = image.width;
  let bottom = image.height;
  for (const shape of shapes) {
    for (const point of shape.points) {
      if (point.x > right) right = point.x;
      if (point.y > bottom) bottom = point.y;
    }
  }
  return { width: Math.ceil(right), height: Math.ceil(bottom), shapes };
}

/** A point in the picture, read back into the drawing's own coordinates. */
export function intoDrawing(data: BindFlowData, point: VectorPoint): VectorPoint {
  const place = data.placement ?? AS_IS;
  const scale = place.scale === 0 ? 1 : place.scale;
  return { x: (point.x - place.x) / scale, y: (point.y - place.y) / scale };
}

/* ------------------------------------------------------------------ *
 * Placing the two of them
 * ------------------------------------------------------------------ */

export function moveImage(data: BindFlowData, by: VectorPoint): BindFlowData {
  const place = data.placement ?? AS_IS;
  return {
    ...data,
    placement: { ...place, x: place.x + by.x, y: place.y + by.y },
    edits: data.edits + 1,
  };
}

/** Zoom the drawing about a point, so what is under the pointer stays under it. */
export function zoomImage(data: BindFlowData, by: number, about: VectorPoint): BindFlowData {
  const place = data.placement ?? AS_IS;
  const scale = Math.max(0.05, Math.min(40, place.scale * by));
  const step = scale / place.scale;
  return {
    ...data,
    placement: {
      scale,
      x: about.x - (about.x - place.x) * step,
      y: about.y - (about.y - place.y) * step,
    },
    edits: data.edits + 1,
  };
}

export function moveRig(data: BindFlowData, by: VectorPoint): BindFlowData {
  if (!data.rig) return data;
  const origin = data.rig.origin ?? { x: 0, y: 0 };
  return {
    ...data,
    rig: { ...data.rig, origin: { x: origin.x + by.x, y: origin.y + by.y } },
    edits: data.edits + 1,
  };
}

/**
 * Zoom the whole skeleton about a point.
 *
 * Every bone's offset is scaled, which is what makes the rig bigger rather than
 * making one bone longer — the proportions are the rig's own and are not
 * touched. The origin moves so the point you zoomed about stays where it was.
 */
export function zoomRig(data: BindFlowData, by: number, about: VectorPoint): BindFlowData {
  if (!data.rig) return data;
  const origin = data.rig.origin ?? { x: 0, y: 0 };
  const step = Math.max(0.05, Math.min(40, by));
  return {
    ...data,
    rig: {
      ...data.rig,
      bones: data.rig.bones.map((bone) => ({
        ...bone,
        offset: { x: bone.offset.x * step, y: bone.offset.y * step },
      })),
      origin: {
        x: about.x - (about.x - origin.x) * step,
        y: about.y - (about.y - origin.y) * step,
      },
    },
    edits: data.edits + 1,
  };
}

/**
 * Put a joint somewhere.
 *
 * A bone is stored as a step from where its parent ends, so moving its far end
 * is a matter of working out the step that lands it there. Everything hanging
 * off it comes along, which is what a joint is: pulling a wrist takes the hand
 * with it and leaves the elbow alone.
 *
 * Dragging a *root's* near end has nothing above it to step from, so it moves
 * the whole skeleton instead — which is the only thing it could sensibly mean.
 */
export function moveJoint(data: BindFlowData, boneId: string, to: VectorPoint): BindFlowData {
  if (!data.rig) return data;
  const bone = boneById(data.rig, boneId);
  if (!bone) return data;

  const pose = restPose(data.rig);
  const start = pose.get(boneId)?.from;
  if (!start) return data;

  return {
    ...data,
    rig: {
      ...data.rig,
      bones: data.rig.bones.map((candidate) =>
        candidate.id === boneId
          ? { ...candidate, offset: { x: to.x - start.x, y: to.y - start.y } }
          : candidate,
      ),
    },
    edits: data.edits + 1,
  };
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
  // The drawing goes out where it was put, so everything downstream sees the
  // picture that was lined up with the skeleton rather than the one that
  // arrived.
  return { rig: data.rig, image: placedImage(data), binding: data.binding };
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
