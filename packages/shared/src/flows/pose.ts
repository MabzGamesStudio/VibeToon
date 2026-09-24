import { boneById, chainById, effectiveAngles, restPose, type Bone, type RigFlowData } from './rig';
import type { BoundRig } from './rigBind';
import { mapPoints, type VectorImage, type VectorPoint, type VectorShape } from './vector';

/**
 * Moving a bound rig.
 *
 * A pose is one number a bone: how far it has turned from where it rests, in
 * degrees. Everything else — where each bone ends up, and where the drawing goes
 * with it — falls out of that and the hierarchy.
 *
 * Storing angles rather than positions is what makes a pose a pose. Positions
 * would be a drawing of one arrangement; angles are the arrangement itself, so
 * they survive the rig being edited underneath them, they interpolate between
 * two poses sensibly, and they cannot describe a skeleton that has come apart.
 */

export type Pose = Record<string, number>;

export interface PosedBone {
  from: VectorPoint;
  to: VectorPoint;
  /** Total turn from rest, including everything inherited from above. */
  angle: number;
  /** This bone's own turn, which is what the pose stores. */
  own: number;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Forward kinematics: every bone's place, given the angles.
 *
 * A bone's turn is added to everything its parents have already done, and its
 * rest offset is rotated by the total. That is the whole of it — which is why an
 * arm lifts when the shoulder turns without the elbow being told anything.
 */
export function posedBones(rig: RigFlowData, pose: Pose): Map<string, PosedBone> {
  const out = new Map<string, PosedBone>();
  const byParent = new Map<string, Bone[]>();
  for (const bone of rig.bones) {
    const key = bone.parent ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), bone]);
  }

  const walk = (bone: Bone, origin: VectorPoint, inherited: number): void => {
    const own = pose[bone.id] ?? 0;
    const angle = inherited + own;
    const turn = rad(angle);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const to = {
      x: origin.x + bone.offset.x * cos - bone.offset.y * sin,
      y: origin.y + bone.offset.x * sin + bone.offset.y * cos,
    };
    out.set(bone.id, { from: origin, to, angle, own });
    for (const child of byParent.get(bone.id) ?? []) walk(child, to, angle);
  };

  /*
   * From where the rig actually stands, not from the origin.
   *
   * A rig laid over a drawing has been moved there — `origin` is where its root
   * sits — and `restPose` has always read it. This did not, so posing a bound rig
   * moved the whole drawing by that offset before a single joint had been turned:
   * an empty pose, which should change nothing at all, threw the picture off the
   * top-left corner. The two have to walk from the same place or nothing they say
   * about each other means anything.
   */
  const start = rig.origin ?? { x: 0, y: 0 };
  for (const root of rig.bones.filter((bone) => !bone.parent || !boneById(rig, bone.parent))) {
    walk(root, start, 0);
  }
  return out;
}

/** The chain from a bone up to a root, nearest first. */
export function chainUp(rig: RigFlowData, boneId: string, length: number): Bone[] {
  const out: Bone[] = [];
  let current = boneById(rig, boneId);
  while (current && out.length < length) {
    out.push(current);
    current = current.parent ? boneById(rig, current.parent) : undefined;
  }
  return out;
}

/**
 * Keep an angle inside what the joint allows.
 *
 * Read through the chain, so a bone in a tentacle obeys the chain's floppiness
 * rather than nothing at all — the rig says a joint's limits live on its chain
 * when it has one, and a poser that ignored that would let a rig fold in ways
 * the rig itself says it cannot.
 */
function clampToLimits(rig: RigFlowData, bone: Bone, angle: number): number {
  const limits = effectiveAngles(bone, bone.chain ? chainById(rig, bone.chain) : undefined, rig.options);
  return Math.max(limits.min, Math.min(limits.max, angle));
}

export interface IkOptions {
  /** How many bones up the chain may move. */
  chainLength: number;
  /** How many times to go round. More is closer, and slower. */
  iterations: number;
  /** Close enough, in rig units. */
  tolerance: number;
  /** Obey each joint's range of motion. Off lets the rig reach anywhere. */
  respectLimits: boolean;
}

export const DEFAULT_IK_OPTIONS: IkOptions = {
  chainLength: 3,
  iterations: 24,
  tolerance: 0.4,
  respectLimits: true,
};

export interface IkResult {
  pose: Pose;
  /** How far the tip ended up from where it was asked to go. */
  distance: number;
  /** True when it got there; false when the target is out of reach or blocked. */
  reached: boolean;
  iterations: number;
}

/**
 * Inverse kinematics by cyclic coordinate descent.
 *
 * Work back down the chain from the joint nearest the tip: at each one, turn it
 * so the tip points as near the target as that joint alone can manage, clamp it
 * to what the joint allows, and move on. Go round again until it is close enough
 * or the rounds run out.
 *
 * CCD rather than a Jacobian: joint limits are a clamp rather than a constraint
 * to solve around, the arithmetic is a few dot products, and a chain that cannot
 * reach settles gracefully stretched towards the target instead of oscillating.
 * For a character's arm — three or four bones with hard stops — it is the right
 * tool, and it is one that can be read.
 */
/** How far the tip already is, so a solve can never return something worse. */
function startingDistance(rig: RigFlowData, pose: Pose, tipId: string, target: VectorPoint): number {
  const tip = posedBones(rig, pose).get(tipId)?.to;
  return tip ? Math.hypot(tip.x - target.x, tip.y - target.y) : Infinity;
}

export function solveIk(
  rig: RigFlowData,
  pose: Pose,
  tipId: string,
  target: VectorPoint,
  options: IkOptions = DEFAULT_IK_OPTIONS,
): IkResult {
  const chain = chainUp(rig, tipId, Math.max(1, options.chainLength));
  if (chain.length === 0) return { pose, distance: Infinity, reached: false, iterations: 0 };

  let current: Pose = { ...pose };
  let best = { pose: { ...pose }, distance: startingDistance(rig, pose, tipId, target) };
  let distance = best.distance;
  let previous = Infinity;
  let nudges = 0;
  let rounds = 0;

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    rounds = iteration + 1;

    /*
     * Break a stall before going round again.
     *
     * CCD's weak spot is a straight chain aimed at a target in line with it:
     * every joint's correction is then a fraction of a degree, because turning
     * about a pivot the tip is already pointing away from barely moves it. An arm
     * hanging straight down being asked to touch the shoulder is exactly that,
     * and the solver would sit there declaring it out of reach.
     *
     * A few degrees of bend puts the chain off the line and it converges from
     * there. Alternating and fixed rather than random, so the same drag always
     * gives the same pose.
     */
    if (distance > options.tolerance && previous - distance < options.tolerance / 10 && nudges < 3) {
      nudges += 1;
      chain.forEach((joint, index) => {
        const bend = (index % 2 === 0 ? 1 : -1) * 8 * nudges;
        const wanted = (current[joint.id] ?? 0) + bend;
        current[joint.id] = options.respectLimits ? clampToLimits(rig, joint, wanted) : wanted;
      });
    }
    previous = distance;

    for (const joint of chain) {
      const placed = posedBones(rig, current);
      const tip = placed.get(tipId)?.to;
      const pivot = placed.get(joint.id)?.from;
      if (!tip || !pivot) continue;

      const toTip = Math.atan2(tip.y - pivot.y, tip.x - pivot.x);
      const toTarget = Math.atan2(target.y - pivot.y, target.x - pivot.x);
      let turn = ((toTarget - toTip) * 180) / Math.PI;
      // The short way round, so a joint never takes the long path to the same place.
      while (turn > 180) turn -= 360;
      while (turn < -180) turn += 360;

      const wanted = (current[joint.id] ?? 0) + turn;
      current[joint.id] = options.respectLimits ? clampToLimits(rig, joint, wanted) : wanted;
    }

    const tip = posedBones(rig, current).get(tipId)?.to;
    if (!tip) break;
    const now = Math.hypot(tip.x - target.x, tip.y - target.y);
    // A nudge is a guess, and a guess that made things worse is kept only until
    // something better turns up — so the best pose seen is the one handed back.
    if (now < best.distance) best = { pose: { ...current }, distance: now };
    distance = now;
    if (distance <= options.tolerance) break;
  }

  return {
    pose: best.pose,
    distance: best.distance,
    reached: best.distance <= options.tolerance,
    iterations: rounds,
  };
}

/* ------------------------------------------------------------------ *
 * Moving the drawing with the bones
 * ------------------------------------------------------------------ */

/**
 * The drawing, in the pose.
 *
 * Every point is moved by the bone it is bound to: rotated about that bone's
 * origin by how far the bone has turned, and carried along by however far the
 * origin itself has moved. Point by point rather than shape by shape, so a shape
 * whose points follow two bones bends where they meet — an arm drawn as one
 * polygon folds at the elbow. A point bound to nothing stays where it was drawn,
 * which is visible and therefore fixable; silently dropping it would not be.
 */
export function posedImage(bound: BoundRig, pose: Pose): VectorImage {
  const rest = restPose(bound.rig);
  const placed = posedBones(bound.rig, pose);

  // Each bone's move, worked out once rather than once per point it carries.
  const moves = new Map<string, (point: VectorPoint) => VectorPoint>();
  for (const [boneId, from] of rest) {
    const to = placed.get(boneId);
    if (!to) continue;
    const turn = rad(to.angle);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    moves.set(boneId, (point) => {
      const dx = point.x - from.from.x;
      const dy = point.y - from.from.y;
      return { x: to.from.x + dx * cos - dy * sin, y: to.from.y + dx * sin + dy * cos };
    });
  }

  const shapes: VectorShape[] = bound.image.shapes.map((shape) => {
    const bones = bound.points[shape.id];
    if (!bones) return shape;
    return mapPoints(shape, (point, index) => {
      const bone = bones[index];
      const move = bone ? moves.get(bone) : undefined;
      return move ? move(point) : point;
    });
  });

  return { ...bound.image, shapes };
}

/** How many points of the drawing follow a bone. */
export function boundPointCount(bound: BoundRig): number {
  let count = 0;
  for (const bones of Object.values(bound.points)) for (const bone of bones) if (bone) count += 1;
  return count;
}

/* ------------------------------------------------------------------ *
 * The flow's state
 * ------------------------------------------------------------------ */

export type PoseMode = 'forward' | 'inverse';

export const POSE_MODE_LABEL: Record<PoseMode, string> = {
  forward: 'Turn a joint',
  inverse: 'Drag a tip',
};

export const POSE_MODE_HINT: Record<PoseMode, string> = {
  forward: 'Pick a bone and turn it. Everything below it comes along, which is what a skeleton is for.',
  inverse: 'Drag the end of a limb and the joints above it work out how to get there.',
};

export interface PoseFlowData {
  editor: 'pose';
  bound: BoundRig | null;
  pose: Pose;
  mode: PoseMode;
  selected: string | null;
  ik: IkOptions;
  sourceHash?: string;
}

export function emptyPoseFlowData(): PoseFlowData {
  return {
    editor: 'pose',
    bound: null,
    pose: {},
    mode: 'forward',
    selected: null,
    ik: { ...DEFAULT_IK_OPTIONS },
  };
}

export function poseState(data: PoseFlowData, sourceHash: string | undefined): 'none' | 'stale' | 'ready' {
  if (!data.bound) return 'none';
  if (!sourceHash || !data.sourceHash) return 'ready';
  return data.sourceHash === sourceHash ? 'ready' : 'stale';
}

/** Turn one joint, keeping it inside what it allows. */
export function turnBone(data: PoseFlowData, boneId: string, to: number): PoseFlowData {
  if (!data.bound) return data;
  const bone = boneById(data.bound.rig, boneId);
  if (!bone) return data;
  const angle = data.ik.respectLimits ? clampToLimits(data.bound.rig, bone, to) : to;
  return { ...data, pose: { ...data.pose, [boneId]: angle } };
}

export function clearPose(data: PoseFlowData): PoseFlowData {
  return { ...data, pose: {} };
}

/** How far from rest the whole rig is, for saying whether it is posed at all. */
export function poseEffort(pose: Pose): number {
  return Object.values(pose).reduce((sum, angle) => sum + Math.abs(angle), 0);
}

export function summarisePose(data: PoseFlowData): string {
  if (!data.bound) return 'Nothing to pose yet.';
  const moved = Object.values(data.pose).filter((angle) => Math.abs(angle) > 0.01).length;
  const bones = data.bound.rig.bones.length;
  return `${bones} bone(s), ${boundPointCount(data.bound)} point(s) bound · ${moved} joint(s) turned`;
}
