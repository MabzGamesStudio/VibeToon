import type { Vec2 } from '../types/project';
import {
  DEFAULT_RIG_OPTIONS,
  chainById,
  effectiveAngles,
  effectiveStretch,
  restPose,
  type RigFlowData,
} from './rig';

/**
 * A rig, moving: what its limits and stiffnesses actually do to it.
 *
 * A range of motion and a stiffness are numbers until something pushes on the
 * joint. This puts the skeleton under forces — gravity, wind, a shove, the body
 * being carried about, a joint dragged by hand — so each setting can be watched
 * doing its job: a neck with a stiffness of 0.2 nods under its own weight, one
 * of 0.9 barely dips; a tentacle with high floppiness trails behind a swaying
 * body and whips when it stops.
 *
 * **Position-based dynamics.** Each joint is a particle with a mass, moved by
 * the forces and then corrected by the bones: every bone keeps its length inside
 * its stretch range, and every joint its angle inside its range of motion. Those
 * two are hard stops, applied in full every step. Stiffness is not a stop but a
 * pull back towards rest, and is given as a spring with a frequency — a joint
 * at stiffness 1 springs back about four times a second, at 0.5 twice, at 0 not
 * at all — using the compliance form of the method, so what a stiffness means
 * does not depend on how many steps the preview happens to take.
 *
 * It is a preview, not an animation system: nothing here is saved, and the rig
 * it runs on is never changed.
 */

export type SimMotion = 'still' | 'sway' | 'bounce' | 'circle';

export const SIM_MOTIONS: readonly SimMotion[] = ['still', 'sway', 'bounce', 'circle'];

export const SIM_MOTION_LABEL: Record<SimMotion, string> = {
  still: 'Held still',
  sway: 'Sway side to side',
  bounce: 'Bounce up and down',
  circle: 'Carry round in a circle',
};

export interface SimSettings {
  /** Gravity, in g: 1 is the pull a character this tall would feel on Earth. */
  gravity: number;
  /** A sideways push, in g like gravity. Negative blows to the left. */
  wind: number;
  /** 0..1 — how much the wind comes and goes. */
  gust: number;
  /** 0..1 — how much the air slows everything down. */
  damping: number;
  /** How the root of the skeleton is carried about. */
  motion: SimMotion;
  /** How far, as a share of the rig's height. */
  motionSize: number;
  /** How often, in cycles a second. */
  motionSpeed: number;
}

export const DEFAULT_SIM_SETTINGS: SimSettings = {
  gravity: 1,
  wind: 0,
  gust: 0.5,
  damping: 0.3,
  motion: 'still',
  motionSize: 0.15,
  motionSpeed: 1,
};

/** Each step of the simulation, in seconds. Small steps are what keep a stiff joint stable. */
const STEP = 1 / 240;
/** Constraint passes per step. */
const PASSES = 2;
/** A joint at stiffness 1 springs back this many times a second. */
const STIFFEST = 4;
/** The most a frame is allowed to advance, so a stalled tab does not explode on its return. */
const MOST_PER_CALL = 0.1;

interface Particle {
  x: number;
  y: number;
  /** Where it was a step ago — its velocity, in the Verlet form. */
  px: number;
  py: number;
  /** Inverse mass. 0 is held: the root, or a joint being dragged. */
  w: number;
}

interface SimBone {
  id: string;
  from: number;
  to: number;
  /** The bone above, for measuring this one's angle against. -1 for a root. */
  parent: number;
  length: number;
  /** Its direction at rest, in radians, in the picture's own frame. */
  restAngle: number;
  /** Its angle at rest relative to the bone above (or to the picture, for a root). */
  restTurn: number;
  minTurn: number;
  maxTurn: number;
  /** Radians per second, squared: how hard it springs back. 0 does not. */
  angleSpring: number;
  minLength: number;
  maxLength: number;
  lengthSpring: number;
  /**
   * What the joint carries: everything below it, as the turning weight about the
   * joint and as plain weight. A spring's strength is its frequency squared times
   * these, so a stiffness means the same on a spine holding up a torso as on a
   * finger — measured against only the two points either side of it, a spine
   * had the strength of a fingertip and the whole figure slumped.
   */
  inertia: number;
  load: number;
}

export interface RigSim {
  bones: SimBone[];
  /** Every bone's two ends as particles, the ones of no length included. */
  ends: Map<string, { from: number; to: number }>;
  particles: Particle[];
  /** Where the root stands when nothing is carrying it. */
  anchor: Vec2;
  /** Particles the roots hang from. */
  roots: number[];
  /** The rig's height at rest, which sets the scale of every force. */
  height: number;
  time: number;
  /** Where the root is being held by hand, overriding the motion. */
  heldRoot: Vec2 | null;
  /** A joint being dragged, and where to. */
  grabbed: { particle: number; to: Vec2 } | null;
  /** Bones whose joint was at a hard stop at the end of the last step. */
  atLimit: Set<string>;
  /** Bones at the end of their stretch range. */
  atStretch: Set<string>;
}

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Start a simulation of a rig, standing at rest. */
export function createSim(rig: RigFlowData): RigSim {
  const options = { ...DEFAULT_RIG_OPTIONS, ...rig.options };
  const rest = restPose(rig);
  const anchor = rig.origin ?? { x: 0, y: 0 };
  const particles: Particle[] = [];
  const add = (point: Vec2) => {
    particles.push({ x: point.x, y: point.y, px: point.x, py: point.y, w: 1 });
    return particles.length - 1;
  };

  /*
   * One particle for where the roots hang from, held, and one for each bone's
   * far end — except a bone of no length, which is a point, not a bone: its end
   * is where it starts, so it shares that particle and has no angle of its own.
   * The bones below it measure their angle against the nearest bone above that
   * has a length. Walked top down, so a bone's start is known before its end.
   */
  const root = add(anchor);
  particles[root]!.w = 0;
  const angleOf = (id: string) => {
    const place = rest.get(id)!;
    return Math.atan2(place.to.y - place.from.y, place.to.x - place.from.x);
  };
  const frequency = (stiffness: number) => (2 * Math.PI * STIFFEST * Math.max(0, Math.min(1, stiffness))) ** 2;

  const endOf = new Map<string, number>();
  const ends = new Map<string, { from: number; to: number }>();
  /** The nearest bone at or above this one with a length, by id. */
  const measuredBy = new Map<string, string | undefined>();
  const bones: SimBone[] = [];
  const index = new Map<string, number>();
  for (const id of rest.keys()) {
    const bone = rig.bones.find((entry) => entry.id === id)!;
    const place = rest.get(id)!;
    const from = bone.parent !== undefined && endOf.has(bone.parent) ? endOf.get(bone.parent)! : root;
    const length = Math.hypot(place.to.x - place.from.x, place.to.y - place.from.y);
    const above = bone.parent !== undefined ? measuredBy.get(bone.parent) : undefined;
    if (length < 1e-6) {
      endOf.set(id, from);
      measuredBy.set(id, above);
      ends.set(id, { from, to: from });
      continue;
    }
    endOf.set(id, add(place.to));
    ends.set(id, { from, to: endOf.get(id)! });
    measuredBy.set(id, id);

    const angles = effectiveAngles(bone, chainById(rig, bone.chain), options);
    const stretch = effectiveStretch(bone, options);
    const restAngle = angleOf(id);
    index.set(id, bones.length);
    bones.push({
      id,
      from,
      to: endOf.get(id)!,
      parent: above !== undefined ? index.get(above)! : -1,
      length,
      restAngle,
      restTurn: above !== undefined ? wrap(restAngle - angleOf(above)) : restAngle,
      minTurn: rad(Math.min(angles.min, angles.max)),
      maxTurn: rad(Math.max(angles.min, angles.max)),
      angleSpring: frequency(angles.stiffness),
      minLength: length * Math.min(stretch.min, 1),
      maxLength: length * Math.max(stretch.max, 1),
      lengthSpring: frequency(stretch.stiffness),
      inertia: 0,
      load: 0,
    });
  }

  // Heavier where more bone meets: each bone's weight is split between its ends.
  const mass = particles.map(() => 0);
  for (const bone of bones) {
    mass[bone.from]! += bone.length / 2;
    mass[bone.to]! += bone.length / 2;
  }
  particles.forEach((particle, at) => {
    if (particle.w !== 0) particle.w = 1 / Math.max(1e-3, mass[at]!);
  });

  // What each joint carries: its own end and every end below it.
  const below = new Map<number, number[]>();
  bones.forEach((bone, at) => {
    if (bone.parent >= 0) below.set(bone.parent, [...(below.get(bone.parent) ?? []), at]);
  });
  const carried = (at: number): number[] => [bones[at]!.to, ...(below.get(at) ?? []).flatMap(carried)];
  bones.forEach((bone, at) => {
    const pivot = particles[bone.from]!;
    for (const end of new Set(carried(at))) {
      const point = particles[end]!;
      bone.load += mass[end]!;
      bone.inertia += mass[end]! * ((point.x - pivot.x) ** 2 + (point.y - pivot.y) ** 2);
    }
  });

  const ys = [...rest.values()].flatMap((place) => [place.from.y, place.to.y]);
  const xs = [...rest.values()].flatMap((place) => [place.from.x, place.to.x]);
  const height = Math.max(1, Math.max(...ys) - Math.min(...ys), Math.max(...xs) - Math.min(...xs));

  return {
    bones,
    ends,
    particles,
    anchor,
    roots: [root],
    height,
    time: 0,
    heldRoot: null,
    grabbed: null,
    atLimit: new Set(),
    atStretch: new Set(),
  };
}

/** Where the root is carried to at a moment, by the chosen motion. */
export function motionAt(sim: RigSim, settings: SimSettings, time: number): Vec2 {
  if (sim.heldRoot) return sim.heldRoot;
  const size = settings.motionSize * sim.height;
  const turn = 2 * Math.PI * settings.motionSpeed * time;
  const { x, y } = sim.anchor;
  switch (settings.motion) {
    case 'sway':
      return { x: x + size * Math.sin(turn), y };
    case 'bounce':
      return { x, y: y - size * Math.abs(Math.sin(turn / 2)) };
    case 'circle':
      return { x: x + size * Math.sin(turn), y: y - size * (1 - Math.cos(turn)) };
    default:
      return { x, y };
  }
}

/**
 * Advance by `seconds`, in fixed steps.
 *
 * Fixed so that the same settings behave the same whatever the frame rate: a
 * spring stepped at 60 a second and one stepped at 144 must be the same spring.
 */
export function stepSim(sim: RigSim, seconds: number, settings: SimSettings): void {
  const steps = Math.max(0, Math.round(Math.min(seconds, MOST_PER_CALL) / STEP));
  for (let step = 0; step < steps; step += 1) substep(sim, settings);
}

function substep(sim: RigSim, settings: SimSettings): void {
  const h = STEP;
  sim.time += h;
  // One g is what a character this tall would feel: a person is 1.7 metres.
  const g = 9.8 * (sim.height / 1.7);
  const gust = 1 + settings.gust * (0.6 * Math.sin(1.7 * sim.time) + 0.4 * Math.sin(4.3 * sim.time + 1));
  const ax = g * settings.wind * gust;
  const ay = g * settings.gravity;
  const keep = Math.exp(-settings.damping * 6 * h);

  const carried = motionAt(sim, settings, sim.time);
  for (const root of sim.roots) {
    const particle = sim.particles[root]!;
    particle.px = particle.x;
    particle.py = particle.y;
    particle.x = carried.x;
    particle.y = carried.y;
  }

  for (const particle of sim.particles) {
    if (particle.w === 0) continue;
    const vx = (particle.x - particle.px) * keep;
    const vy = (particle.y - particle.py) * keep;
    particle.px = particle.x;
    particle.py = particle.y;
    particle.x += vx + ax * h * h;
    particle.y += vy + ay * h * h;
  }

  // A dragged joint goes where the hand is, and is held there for the step.
  const grabbed = sim.grabbed ? sim.particles[sim.grabbed.particle] : undefined;
  const heldWeight = grabbed?.w ?? 0;
  if (grabbed && sim.grabbed) {
    grabbed.x = sim.grabbed.to.x;
    grabbed.y = sim.grabbed.to.y;
    grabbed.w = 0;
  }

  const last = PASSES - 1;
  for (let pass = 0; pass < PASSES; pass += 1) {
    if (pass === last) {
      sim.atLimit.clear();
      sim.atStretch.clear();
    }
    for (const bone of sim.bones) lengthConstraint(sim, bone, h, pass === last);
    for (const bone of sim.bones) angleConstraint(sim, bone, h, pass === last);
  }
  // The stops again, on their own and last — the angles, then the stretches — so
  // a step never ends with a joint past its range or a bone past its length.
  for (const bone of sim.bones) angleConstraint(sim, bone, h, false, true);
  for (const bone of sim.bones) lengthConstraint(sim, bone, h, false, true);

  if (grabbed) grabbed.w = heldWeight;
}

/**
 * The fraction of the way back to rest a spring goes in one step: the compliance
 * form, for a spring of this strength against the weight that has to move.
 */
function pull(spring: number, h: number): number {
  const reach = spring * h * h;
  return reach / (1 + reach);
}

function lengthConstraint(sim: RigSim, bone: SimBone, h: number, record: boolean, stopsOnly = false): void {
  const a = sim.particles[bone.from]!;
  const b = sim.particles[bone.to]!;
  // The last pass moves only the lower end, walking down from the root: moving
  // both would let the next bone down pull this one long again.
  const aw = stopsOnly && b.w > 0 ? 0 : a.w;
  const total = aw + b.w;
  if (total === 0) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const now = Math.hypot(dx, dy);
  if (now < 1e-9) return;
  // Pulled back towards its rest length, then stopped at its range.
  let want = stopsOnly ? now : now + (bone.length - now) * pull(bone.lengthSpring * bone.load * total, h);
  if (want < bone.minLength) want = bone.minLength;
  if (want > bone.maxLength) want = bone.maxLength;
  if (record && (now <= bone.minLength + 1e-6 || now >= bone.maxLength - 1e-6) && bone.minLength < bone.maxLength) {
    sim.atStretch.add(bone.id);
  }
  if (want === now) return;
  const move = (now - want) / now;
  a.x += dx * move * (aw / total);
  a.y += dy * move * (aw / total);
  b.x -= dx * move * (b.w / total);
  b.y -= dy * move * (b.w / total);
}

/**
 * Keep a joint inside its range, and pull it back towards rest.
 *
 * The joint's angle is the child bone's direction less the parent's. It is
 * corrected by moving all three points — the parent's start, the joint, the
 * child's end — along the angle's own gradient, each in proportion to how
 * light it is and how much a move of it turns the angle. The three moves add
 * to nothing, so the correction pushes the skeleton round without pushing it
 * along; a correction that did (turning the two ends about the joint and
 * leaving the joint where it was) handed energy to the step after it, and the
 * skeleton shook itself apart within a second.
 */
function angleConstraint(sim: RigSim, bone: SimBone, h: number, record: boolean, stopsOnly = false): void {
  const pivot = sim.particles[bone.from]!;
  const tip = sim.particles[bone.to]!;
  const parent = bone.parent >= 0 ? sim.bones[bone.parent]! : null;
  const back = parent ? sim.particles[parent.from]! : null;

  const d2x = tip.x - pivot.x;
  const d2y = tip.y - pivot.y;
  const r2 = d2x * d2x + d2y * d2y;
  if (r2 < 1e-12) return;
  let d1x = 0;
  let d1y = 0;
  let r1 = 0;
  if (back) {
    d1x = pivot.x - back.x;
    d1y = pivot.y - back.y;
    r1 = d1x * d1x + d1y * d1y;
    if (r1 < 1e-12) return;
  }
  // Measured against the bone above; a root against the picture itself.
  const reference = back ? Math.atan2(d1y, d1x) : 0;
  const turn = wrap(Math.atan2(d2y, d2x) - reference - bone.restTurn);

  // How the angle changes as each point moves.
  const g2 = { x: -d2y / r2, y: d2x / r2 };
  const g0 = back ? { x: -d1y / r1, y: d1x / r1 } : { x: 0, y: 0 };
  const g1 = { x: -g2.x - g0.x, y: -g2.y - g0.y };
  const weight =
    tip.w * (g2.x * g2.x + g2.y * g2.y) +
    pivot.w * (g1.x * g1.x + g1.y * g1.y) +
    (back ? back.w * (g0.x * g0.x + g0.y * g0.y) : 0);
  if (weight < 1e-12) return;

  // Back towards rest by a spring as strong as what the joint carries, then
  // stopped at its range.
  let target = turn - turn * pull(bone.angleSpring * bone.inertia * weight, h);
  if (target < bone.minTurn) target = bone.minTurn;
  if (target > bone.maxTurn) target = bone.maxTurn;
  if (stopsOnly) target = Math.min(bone.maxTurn, Math.max(bone.minTurn, turn));
  if (record && (turn <= bone.minTurn + 1e-3 || turn >= bone.maxTurn - 1e-3) && bone.minTurn < bone.maxTurn) {
    sim.atLimit.add(bone.id);
  }
  const by = target - turn;
  if (Math.abs(by) < 1e-12) return;
  const lambda = by / weight;
  tip.x += lambda * tip.w * g2.x;
  tip.y += lambda * tip.w * g2.y;
  pivot.x += lambda * pivot.w * g1.x;
  pivot.y += lambda * pivot.w * g1.y;
  if (back) {
    back.x += lambda * back.w * g0.x;
    back.y += lambda * back.w * g0.y;
  }
}

/** Give everything that is free a push, in rig units a second. */
export function pushSim(sim: RigSim, velocity: Vec2): void {
  for (const particle of sim.particles) {
    if (particle.w === 0) continue;
    particle.px -= velocity.x * STEP;
    particle.py -= velocity.y * STEP;
  }
}

/** Take hold of the far end of a bone, or the root, and drag it to `to`. */
export function grabSim(sim: RigSim, boneId: string | 'root', to: Vec2): void {
  if (boneId === 'root') {
    sim.heldRoot = to;
    sim.grabbed = null;
    return;
  }
  const end = sim.ends.get(boneId);
  // A bone of no length ends on a held particle when it hangs off the root.
  if (end && sim.particles[end.to]!.w !== 0) sim.grabbed = { particle: end.to, to };
}

/** Let go. What was dragged keeps the speed it was moving at, so a flick throws. */
export function releaseSim(sim: RigSim): void {
  sim.grabbed = null;
  if (sim.heldRoot) {
    sim.anchor = sim.heldRoot;
    sim.heldRoot = null;
  }
}

/** Where every bone is now. */
export function simBones(sim: RigSim): Map<string, { from: Vec2; to: Vec2 }> {
  const out = new Map<string, { from: Vec2; to: Vec2 }>();
  for (const [id, end] of sim.ends) {
    const from = sim.particles[end.from]!;
    const to = sim.particles[end.to]!;
    out.set(id, { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
  }
  return out;
}

/** How far each joint has turned from rest, in degrees, and each bone's length as a multiple of rest. */
export function simReadout(sim: RigSim): Map<string, { turn: number; stretch: number }> {
  const out = new Map<string, { turn: number; stretch: number }>();
  for (const bone of sim.bones) {
    const pivot = sim.particles[bone.from]!;
    const tip = sim.particles[bone.to]!;
    const parent = bone.parent >= 0 ? sim.bones[bone.parent]! : null;
    const back = parent ? sim.particles[parent.from]! : null;
    const reference = back ? Math.atan2(pivot.y - back.y, pivot.x - back.x) : 0;
    const turn = wrap(Math.atan2(tip.y - pivot.y, tip.x - pivot.x) - reference - bone.restTurn);
    out.set(bone.id, {
      turn: (turn * 180) / Math.PI,
      stretch: bone.length > 0 ? Math.hypot(tip.x - pivot.x, tip.y - pivot.y) / bone.length : 1,
    });
  }
  return out;
}

/** How much the skeleton is moving, in rig units a second — for knowing when it has settled. */
export function simSpeed(sim: RigSim): number {
  let most = 0;
  for (const particle of sim.particles) {
    if (particle.w === 0) continue;
    most = Math.max(most, Math.hypot(particle.x - particle.px, particle.y - particle.py) / STEP);
  }
  return most;
}
