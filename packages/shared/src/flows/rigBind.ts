import { newId } from '../ids';
import { boneById, childrenOf, restPose, type Bone, type RigFlowData } from './rig';
import {
  allPoints,
  containsPoint,
  emptyVectorImage,
  mapPoints,
  type VectorImage,
  type VectorPoint,
  type VectorShape,
} from './vector';

/**
 * Binding a drawing to a skeleton.
 *
 * A vectorized drawing is a pile of shapes and a rig is a hierarchy of bones;
 * neither knows about the other. Binding is the map between them: which parts of
 * the drawing move when which bone does.
 *
 * The parts are **nodes** — the points the shapes are drawn through — not whole
 * shapes. A shape is often bigger than a part of the body: once a decomposition
 * joins a region into one polygon, the whole of a skin-colored arm and hand can
 * be a single shape, and a shape can only go one way. Bound by its points, it
 * goes several: the points round the upper arm follow the upper arm, the ones
 * round the hand follow the hand, and the polygon between them bends at the
 * elbow instead of having to be cut there first.
 *
 * A node is a **position**, not a point of one shape. Neighbouring shapes share
 * the points along the boundary between them — that is how they fit — and two
 * points in the same place are one node, bound once. So a boundary cannot be
 * given two bones and torn apart when the rig moves.
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

/** How far the brush reaches, in screen pixels, until it is changed. */
export const DEFAULT_BRUSH = 14;

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

/**
 * A node's name: where it is. Two points in the same place are the same node,
 * whichever shapes they belong to.
 */
export function nodeKey(point: VectorPoint): string {
  return `${point.x},${point.y}`;
}

export interface BindNode {
  key: string;
  x: number;
  y: number;
  /** How many shape points sit here. More than one where shapes meet. */
  uses: number;
}

/** Every node of a drawing, once each, in the order the shapes first reach them. */
export function nodesOf(image: VectorImage): BindNode[] {
  const byKey = new Map<string, BindNode>();
  for (const shape of image.shapes) {
    for (const point of allPoints(shape)) {
      const key = nodeKey(point);
      const known = byKey.get(key);
      if (known) known.uses += 1;
      else byKey.set(key, { key, x: point.x, y: point.y, uses: 1 });
    }
  }
  return [...byKey.values()];
}

/** The nodes within `radius` of a point, nearest first. */
export function nodesNear(nodes: readonly BindNode[], at: VectorPoint, radius: number): string[] {
  const found: Array<[number, string]> = [];
  for (const node of nodes) {
    const distance = Math.hypot(node.x - at.x, node.y - at.y);
    if (distance <= radius) found.push([distance, node.key]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, key]) => key);
}

/**
 * Every node inside a drawn region.
 *
 * A node is a point, so it is inside or it is not — which is what makes a lasso
 * precise here in a way it could not be with whole shapes, where a shape half in
 * and half out had to be decided one way or the other.
 */
export function nodesInRegion(nodes: readonly BindNode[], region: VectorPoint[]): string[] {
  if (region.length < 3) return [];
  const asPolygon: VectorShape = { id: '', kind: 'polygon', color: '#000000', points: region };
  return nodes.filter((node) => containsPoint(asPolygon, node)).map((node) => node.key);
}

export interface BindFlowData {
  editor: 'bind';
  /** The skeleton, taken in from upstream and editable here. */
  rig: RigFlowData | null;
  /** The drawing, taken in from upstream. */
  image: VectorImage | null;
  /**
   * Which bone each node follows, by node key (see `nodeKey`), in the drawing's
   * own coordinates. A node not in here is unbound and stays where it was drawn.
   */
  nodes: Record<string, string>;
  /** The nodes touched last, which the editor marks. */
  selected: string[];
  /** How far the add and take-out brush reaches, in screen pixels. */
  brush: number;
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
    nodes: {},
    selected: [],
    brush: DEFAULT_BRUSH,
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
    ...mapPoints(shape, (point) => ({
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

export function bindNodes(data: BindFlowData, keys: readonly string[], boneId: string): BindFlowData {
  const changing = keys.filter((key) => data.nodes[key] !== boneId);
  if (changing.length === 0) return data;
  const nodes = { ...data.nodes };
  for (const key of changing) nodes[key] = boneId;
  return { ...data, nodes, selected: [...keys], edits: data.edits + 1 };
}

export function unbindNodes(data: BindFlowData, keys: readonly string[]): BindFlowData {
  const bound = keys.filter((key) => key in data.nodes);
  if (bound.length === 0) return data;
  const nodes = { ...data.nodes };
  for (const key of bound) delete nodes[key];
  return { ...data, nodes, selected: [...keys], edits: data.edits + 1 };
}

/** The nodes a bone carries. */
export function nodesFor(data: BindFlowData, boneId: string): string[] {
  return Object.keys(data.nodes).filter((key) => data.nodes[key] === boneId);
}

/**
 * How much of a shape a bone carries, 0..1 — by its points, so a shape that
 * bends across a joint is partly in each part.
 */
export function shareOf(data: BindFlowData, shape: VectorShape, boneId: string): number {
  const points = allPoints(shape);
  if (points.length === 0) return 0;
  let held = 0;
  for (const point of points) if (data.nodes[nodeKey(point)] === boneId) held += 1;
  return held / points.length;
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
 * onto the origin. Nodes bound to it move to the parent for the same reason:
 * they were drawn somewhere and they should stay with the body they are part of.
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

  const nodes = { ...data.nodes };
  for (const [key, held] of Object.entries(nodes)) {
    if (held !== boneId) continue;
    if (bone.parent) nodes[key] = bone.parent;
    else delete nodes[key];
  }

  return {
    ...data,
    rig: { ...data.rig, bones },
    nodes,
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
  /**
   * For each shape, the bone each of its points follows, in the shape's own
   * point order — the outline, then each hole's (`allPoints`). `null` is a point bound to nothing, which stays put. A shape
   * missing from here has no bound point at all.
   *
   * Per point of each shape rather than per node, so that nothing downstream has
   * to know how nodes are named or recompute them from coordinates that the
   * placement has already moved.
   */
  points: Record<string, Array<string | null>>;
}

export function boundRigOf(data: BindFlowData): BoundRig | null {
  if (!data.rig || !data.image) return null;
  const points: Record<string, Array<string | null>> = {};
  for (const shape of data.image.shapes) {
    const bones = allPoints(shape).map((point) => data.nodes[nodeKey(point)] ?? null);
    if (bones.some((bone) => bone !== null)) points[shape.id] = bones;
  }
  // The drawing goes out where it was put, so everything downstream sees the
  // picture that was lined up with the skeleton rather than the one that
  // arrived. Placing moves every point and keeps their order, so the bones read
  // by position in each shape still line up.
  return { rig: data.rig, image: placedImage(data), points };
}

/**
 * Read one back, dropping anything that does not refer to something real.
 *
 * A bound rig written before binding was by node has a `binding` of whole shapes
 * instead; each shape's points all follow the bone the shape did, which is what
 * posing it used to do.
 */
export function readBoundRig(json: unknown): BoundRig | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const rig = record.rig as RigFlowData | undefined;
  const image = record.image as VectorImage | undefined;
  if (!rig || !Array.isArray(rig.bones) || !image || !Array.isArray(image.shapes)) return null;

  const bones = new Set(rig.bones.map((bone) => bone.id));
  const real = (bone: unknown): string | null => (typeof bone === 'string' && bones.has(bone) ? bone : null);
  const points: Record<string, Array<string | null>> = {};

  const stored = record.points as Record<string, unknown> | undefined;
  const legacy = record.binding as Record<string, unknown> | undefined;
  for (const shape of image.shapes) {
    let read: Array<string | null> | null = null;
    const list = stored?.[shape.id];
    const every = allPoints(shape);
    if (Array.isArray(list) && list.length === every.length) read = list.map(real);
    else if (!stored && legacy && shape.id in legacy) {
      const bone = real(legacy[shape.id]);
      read = every.map(() => bone);
    }
    if (read && read.some((bone) => bone !== null)) points[shape.id] = read;
  }
  return { rig, image, points };
}

export interface BindSummary {
  bones: number;
  shapes: number;
  nodes: number;
  /** Nodes that follow a bone. */
  bound: number;
  /** Nodes that follow nothing and stay put. */
  unbound: number;
  /** Shapes whose points follow more than one bone, which bend when the rig moves. */
  bending: number;
  /** Shapes with some points bound and some not, which stretch towards where they were drawn. */
  stretching: number;
  /** Bones with nothing on them, which will move and take nothing with them. */
  empty: number;
  problems: string[];
}

export function summariseBinding(data: BindFlowData): BindSummary {
  const image = imageOfBinding(data);
  const bones = data.rig?.bones ?? [];
  const nodes = nodesOf(image);
  const bound = nodes.filter((node) => node.key in data.nodes).length;
  const used = new Set(Object.values(data.nodes));

  let bending = 0;
  let stretching = 0;
  for (const shape of image.shapes) {
    const held = new Set<string>();
    let loose = 0;
    for (const point of allPoints(shape)) {
      const bone = data.nodes[nodeKey(point)];
      if (bone) held.add(bone);
      else loose += 1;
    }
    if (held.size > 1) bending += 1;
    if (held.size > 0 && loose > 0) stretching += 1;
  }

  const problems: string[] = [];
  const unbound = nodes.length - bound;
  if (nodes.length > 0 && bound === 0) {
    problems.push('Nothing is bound yet, so posing the rig would move an empty skeleton.');
  } else if (unbound > 0) {
    problems.push(`${unbound} node(s) are bound to nothing and will stay put when the rig moves.`);
  }
  if (stretching > 0 && bound > 0) {
    problems.push(
      `${stretching} shape(s) have some points bound and some not, and will stretch between them when the rig moves.`,
    );
  }
  const empty = bones.filter((bone) => !used.has(bone.id)).length;
  if (empty > 0 && bound > 0) {
    problems.push(`${empty} bone(s) carry nothing.`);
  }

  return {
    bones: bones.length,
    shapes: image.shapes.length,
    nodes: nodes.length,
    bound,
    unbound,
    bending,
    stretching,
    empty,
    problems,
  };
}
