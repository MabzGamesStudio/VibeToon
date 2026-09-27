import { boneById, chainById, effectiveAngles, restPose, rootBones, type Bone, type RigFlowData } from './rig';
import type { BoundRig } from './rigBind';
import { allPoints, mapPoints, type VectorImage, type VectorPoint, type VectorShape } from './vector';

/**
 * Finding a bound rig in a picture.
 *
 * A rig bound to a drawing is a body: every point of the drawing follows a
 * bone. Given a picture with that body in it — another drawing of the same
 * character, a frame, a reference — this flow finds where the body is and how
 * it stands: where it sits, how big it is and how it is turned, and then how far
 * each part of it is turned and sized, with a confidence for every part.
 *
 * The answer is a **fit**: a placement for the whole body and, for each bone,
 * an angle (a pose, exactly as the Pose flow stores one) and a size. Stored as
 * those numbers rather than as positions, so it can be adjusted by hand
 * afterwards and still be a body — a joint dragged somewhere turns and sizes one
 * part, and cannot tear it away from the next.
 *
 * The matching itself is in `rigMatchSolve.ts`; this file is the fit, what it
 * does to the rig and the drawing, and the flow's state.
 */

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export interface RigMatchOptions {
  /**
   * How many small features each body part gives, before sizing by how big the
   * part is: a chest gives more than a hand. More is steadier and slower.
   */
  features: number;
  /**
   * How far the picture's features range in size: from 1/this to this times the
   * size the body was first guessed at. The same range, square-rooted, bounds how
   * much one part may grow or shrink against the others.
   */
  scaleRange: number;
  /**
   * How far the picture's features range in angle, degrees either way — and so
   * how far the body, and each part against its parent, may turn from rest.
   */
  angleRange: number;
  /** Keep every joint inside the rig's own range of motion. */
  keepLimits: boolean;
}

export const DEFAULT_RIG_MATCH_OPTIONS: RigMatchOptions = {
  features: 12,
  scaleRange: 1.6,
  angleRange: 90,
  keepLimits: true,
};

/* ------------------------------------------------------------------ *
 * The fit
 * ------------------------------------------------------------------ */

/**
 * Where the body is in the picture, and how it stands.
 *
 * The body is turned and sized about `pivot` — a point of the drawing, in the
 * bound rig's own space — and that point lands at (`x`, `y`) in the picture's
 * pixels. Then each bone turns by its own angle, as a pose does, and each part
 * is drawn `sizes` times as big about the joint it hangs from.
 */
export interface RigFit {
  pivot: VectorPoint;
  x: number;
  y: number;
  /** Picture pixels per unit of the bound rig. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** Each bone's own turn from rest, in degrees — a pose. */
  angles: Record<string, number>;
  /** Each part's size against its drawing; 1 as drawn. */
  sizes: Record<string, number>;
}

/** Sizes a part may be dragged to by hand, however the rig says it stretches. */
export const HAND_SIZE_LIMITS = { min: 0.25, max: 4 };

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** The short way round: an angle in (-180, 180]. */
export function wrapAngle(degrees: number): number {
  let angle = degrees % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

/** The shapes that move with the rig, and the bones' ends: what "the body" is. */
export function bodyBounds(bound: BoundRig): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (point: VectorPoint) => {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  };
  for (const shape of bound.image.shapes) {
    if (!bound.points[shape.id]) continue;
    for (const point of allPoints(shape)) take(point);
  }
  for (const place of restPose(bound.rig).values()) {
    take(place.from);
    take(place.to);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The middle of the body: what a fit turns and sizes it about. */
export function bodyPivot(bound: BoundRig): VectorPoint {
  const box = bodyBounds(bound);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The body as drawn, stood in the middle of a picture and sized to fill most of
 * it — the guess a match starts from when there is nothing better.
 */
export function restFit(bound: BoundRig, picture: { width: number; height: number }, margin = 0.08): RigFit {
  const box = bodyBounds(bound);
  const room = { x: picture.width * (1 - margin * 2), y: picture.height * (1 - margin * 2) };
  const scale =
    box.width > 0 && box.height > 0 ? Math.min(room.x / box.width, room.y / box.height) : box.width > 0 ? room.x / box.width : 1;
  return {
    pivot: bodyPivot(bound),
    x: picture.width / 2,
    y: picture.height / 2,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    rotation: 0,
    angles: {},
    sizes: {},
  };
}

/** Where a point of the bound rig's space lands in the picture, before any part turns. */
export function placeInPicture(fit: RigFit, point: VectorPoint): VectorPoint {
  const turn = rad(fit.rotation);
  const cos = Math.cos(turn) * fit.scale;
  const sin = Math.sin(turn) * fit.scale;
  const dx = point.x - fit.pivot.x;
  const dy = point.y - fit.pivot.y;
  return { x: fit.x + dx * cos - dy * sin, y: fit.y + dx * sin + dy * cos };
}

/** Back from the picture into the bound rig's space. */
export function outOfPicture(fit: RigFit, point: VectorPoint): VectorPoint {
  const turn = rad(-fit.rotation);
  const scale = fit.scale === 0 ? 1 : fit.scale;
  const cos = Math.cos(turn) / scale;
  const sin = Math.sin(turn) / scale;
  const dx = point.x - fit.x;
  const dy = point.y - fit.y;
  return { x: fit.pivot.x + dx * cos - dy * sin, y: fit.pivot.y + dx * sin + dy * cos };
}

export interface FittedBone {
  /** Ends in the picture's pixels. */
  from: VectorPoint;
  to: VectorPoint;
  /** Total turn in the picture, degrees, including the body's own rotation. */
  angle: number;
  /** This bone's own turn, which the fit stores. */
  own: number;
  /** This part's size. */
  size: number;
  /** Where the joint is in the bound rig's space, posed — before the placement. */
  posedFrom: VectorPoint;
  /** Where it was at rest, in the same space. */
  restFrom: VectorPoint;
  /** Total turn from rest in the bound rig's space, degrees. */
  posedAngle: number;
}

/**
 * Every bone, where the fit puts it.
 *
 * Forward kinematics, as a pose has, with each bone's offset first sized by
 * its part's size — so a part drawn bigger pushes everything below it out, and
 * a child is never torn from the joint it hangs off.
 */
export function fittedBones(rig: RigFlowData, fit: RigFit): Map<string, FittedBone> {
  const rest = restPose(rig);
  const out = new Map<string, FittedBone>();
  const byParent = new Map<string, Bone[]>();
  for (const bone of rig.bones) {
    const key = bone.parent ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), bone]);
  }
  const walk = (bone: Bone, origin: VectorPoint, inherited: number): void => {
    const own = fit.angles[bone.id] ?? 0;
    const size = fit.sizes[bone.id] ?? 1;
    const angle = inherited + own;
    const turn = rad(angle);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const ox = bone.offset.x * size;
    const oy = bone.offset.y * size;
    const to = { x: origin.x + ox * cos - oy * sin, y: origin.y + ox * sin + oy * cos };
    out.set(bone.id, {
      from: placeInPicture(fit, origin),
      to: placeInPicture(fit, to),
      angle: angle + fit.rotation,
      own,
      size,
      posedFrom: origin,
      restFrom: rest.get(bone.id)?.from ?? origin,
      posedAngle: angle,
    });
    for (const child of byParent.get(bone.id) ?? []) walk(child, to, angle);
  };
  const start = rig.origin ?? { x: 0, y: 0 };
  for (const root of rootBones(rig)) walk(root, start, 0);
  return out;
}

/**
 * How one point of the drawing moves with a bone: turned about the joint by the
 * bone's total angle, sized by its part's size, carried to where the joint went,
 * and then placed in the picture.
 */
export function pointMover(fit: RigFit, bone: FittedBone | undefined): (point: VectorPoint) => VectorPoint {
  if (!bone) return (point) => placeInPicture(fit, point);
  const turn = rad(bone.posedAngle);
  const cos = Math.cos(turn) * bone.size;
  const sin = Math.sin(turn) * bone.size;
  return (point) => {
    const dx = point.x - bone.restFrom.x;
    const dy = point.y - bone.restFrom.y;
    return placeInPicture(fit, { x: bone.posedFrom.x + dx * cos - dy * sin, y: bone.posedFrom.y + dx * sin + dy * cos });
  };
}

/**
 * The drawing, fitted into the picture: every point moved by the bone it
 * follows. A point bound to nothing moves with the body as a whole, so the
 * drawing arrives in one piece rather than leaving its loose ends behind.
 */
export function fittedImage(bound: BoundRig, fit: RigFit, picture?: { width: number; height: number }): VectorImage {
  const bones = fittedBones(bound.rig, fit);
  const movers = new Map<string, (point: VectorPoint) => VectorPoint>();
  const moverFor = (id: string | null) => {
    const key = id ?? '';
    let mover = movers.get(key);
    if (!mover) {
      mover = pointMover(fit, id ? bones.get(id) : undefined);
      movers.set(key, mover);
    }
    return mover;
  };
  const shapes = bound.image.shapes.map((shape) => {
    const list = bound.points[shape.id];
    const moved = mapPoints(shape, (point, index) => moverFor(list?.[index] ?? null)(point));
    return (shape.kind === 'line' ? { ...moved, width: shape.width * fit.scale } : moved) as VectorShape;
  });
  return {
    width: picture?.width ?? Math.ceil(bound.image.width * fit.scale),
    height: picture?.height ?? Math.ceil(bound.image.height * fit.scale),
    shapes,
  };
}

/**
 * The bound rig re-made where the fit put it: bones measured from the fitted
 * pose, the drawing moved into the picture, the binding as it was. Wired into a
 * Pose flow, its rest pose *is* the fitted pose, so posing carries on from the
 * match rather than from how the character was first drawn.
 */
export function fittedBoundRig(bound: BoundRig, fit: RigFit, picture: { width: number; height: number }): BoundRig {
  const bones = fittedBones(bound.rig, fit);
  const roots = rootBones(bound.rig);
  const root = roots[0] ? bones.get(roots[0].id) : undefined;
  const rig: RigFlowData = {
    ...bound.rig,
    bones: bound.rig.bones.map((bone) => {
      const placed = bones.get(bone.id);
      if (!placed) return bone;
      return { ...bone, offset: { x: placed.to.x - placed.from.x, y: placed.to.y - placed.from.y } };
    }),
    origin: root ? { ...root.from } : placeInPicture(fit, bound.rig.origin ?? { x: 0, y: 0 }),
  };
  return { rig, image: fittedImage(bound, fit, picture), points: bound.points };
}

/* ------------------------------------------------------------------ *
 * Adjusting by hand
 * ------------------------------------------------------------------ */

/** The range a joint may turn through, from the rig. */
export function jointLimits(rig: RigFlowData, bone: Bone): { min: number; max: number } {
  const limits = effectiveAngles(bone, bone.chain ? chainById(rig, bone.chain) : undefined, rig.options);
  return { min: limits.min, max: limits.max };
}

export function moveBody(fit: RigFit, by: VectorPoint): RigFit {
  return { ...fit, x: fit.x + by.x, y: fit.y + by.y };
}

/** Size the whole body about a point of the picture, which stays where it is. */
export function scaleBody(fit: RigFit, scale: number, about?: VectorPoint): RigFit {
  const next = Math.max(1e-4, scale);
  if (!about) return { ...fit, scale: next };
  const step = next / fit.scale;
  return { ...fit, scale: next, x: about.x - (about.x - fit.x) * step, y: about.y - (about.y - fit.y) * step };
}

/** Turn the whole body to an angle, about a point of the picture. */
export function rotateBody(fit: RigFit, rotation: number, about?: VectorPoint): RigFit {
  const next = wrapAngle(rotation);
  if (!about) return { ...fit, rotation: next };
  const turn = rad(next - fit.rotation);
  const dx = fit.x - about.x;
  const dy = fit.y - about.y;
  return {
    ...fit,
    rotation: next,
    x: about.x + dx * Math.cos(turn) - dy * Math.sin(turn),
    y: about.y + dx * Math.sin(turn) + dy * Math.cos(turn),
  };
}

export function turnPart(rig: RigFlowData, fit: RigFit, boneId: string, angle: number, keepLimits: boolean): RigFit {
  const bone = boneById(rig, boneId);
  if (!bone) return fit;
  let next = wrapAngle(angle);
  if (keepLimits) {
    const limits = jointLimits(rig, bone);
    next = Math.max(limits.min, Math.min(limits.max, next));
  }
  return { ...fit, angles: { ...fit.angles, [boneId]: next } };
}

export function sizePart(fit: RigFit, boneId: string, size: number): RigFit {
  const next = Math.max(HAND_SIZE_LIMITS.min, Math.min(HAND_SIZE_LIMITS.max, size));
  return { ...fit, sizes: { ...fit.sizes, [boneId]: next } };
}

/**
 * Drag a joint to a point of the picture.
 *
 * A bone's far end is its joint with the next part down: dragging it turns the
 * bone to point there and sizes the part so it reaches — the part changes, and
 * everything hanging off it comes along. A root has nothing above it to turn
 * about, so dragging one moves the whole body, which is the only thing it could
 * sensibly mean.
 */
export function dragJoint(
  rig: RigFlowData,
  fit: RigFit,
  boneId: string,
  to: VectorPoint,
  keepLimits: boolean,
): RigFit {
  const bone = boneById(rig, boneId);
  const placed = fittedBones(rig, fit).get(boneId);
  if (!bone || !placed) return fit;
  const length = Math.hypot(bone.offset.x, bone.offset.y);
  const isRoot = !bone.parent || !boneById(rig, bone.parent);
  if (isRoot || length < 1e-6) {
    return moveBody(fit, { x: to.x - placed.to.x, y: to.y - placed.to.y });
  }
  const reach = Math.hypot(to.x - placed.from.x, to.y - placed.from.y);
  if (reach < 1e-6) return fit;
  // The bone's direction is its rest direction, plus everything above it, plus its own turn.
  const inherited = placed.posedAngle - placed.own;
  const restDirection = deg(Math.atan2(bone.offset.y, bone.offset.x));
  const wanted = deg(Math.atan2(to.y - placed.from.y, to.x - placed.from.x));
  const own = wrapAngle(wanted - fit.rotation - inherited - restDirection);
  const turned = turnPart(rig, fit, boneId, own, keepLimits);
  return sizePart(turned, boneId, reach / (length * fit.scale));
}

/** Put one part back as drawn. */
export function resetPart(fit: RigFit, boneId: string): RigFit {
  const { [boneId]: _angle, ...angles } = fit.angles;
  const { [boneId]: _size, ...sizes } = fit.sizes;
  return { ...fit, angles, sizes };
}

/** A short fingerprint of a fit, to tell whether a report still describes it. */
export function fitSignature(fit: RigFit): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  const sorted = (record: Record<string, number>) =>
    Object.keys(record)
      .sort()
      .map((key) => `${key}:${round(record[key]!)}`)
      .join(',');
  return [round(fit.x), round(fit.y), round(fit.scale * 1000), round(fit.rotation), sorted(fit.angles), sorted(fit.sizes)].join('|');
}

/* ------------------------------------------------------------------ *
 * What a match found
 * ------------------------------------------------------------------ */

export interface PartScore {
  /** 0..1, or null when the part gave no features to judge it by. */
  confidence: number | null;
  /** How alike its features and the picture are where the fit puts them, 0..1. */
  similarity: number;
  features: number;
}

/** One of the body's features, where the fit puts it in the picture. */
export interface MatchFeature {
  bone: string;
  x: number;
  y: number;
  /** Radius in the picture's pixels. */
  r: number;
  similarity: number;
  confidence: number;
}

export interface MatchReport {
  /** The whole body, 0..1: the parts' confidences, weighted by how much of the body each is. */
  confidence: number;
  parts: Record<string, PartScore>;
  features: MatchFeature[];
  /** How many features were taken from the body and from the picture. */
  rigFeatures: number;
  imageFeatures: number;
  /** Body features whose best match in the picture agreed with the placement found. */
  agreeing: number;
  ms: number;
  at: string;
  /** The fit this scores, by `fitSignature` — a report for a fit since moved by hand is out of date. */
  forFit: string;
  /** Said once, when something about the match is worth knowing. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * The flow's state
 * ------------------------------------------------------------------ */

export interface RigMatchFlowData {
  editor: 'rigMatch';
  /** The body, taken in from upstream. */
  bound: BoundRig | null;
  boundHash?: string;
  /** The picture's size, noted when it was last matched against. */
  picture?: { width: number; height: number };
  imageHash?: string;
  options: RigMatchOptions;
  fit: RigFit | null;
  report: MatchReport | null;
  /** Draw the body over the picture. */
  showBody: boolean;
  showSkeleton: boolean;
  /** Mark the body's features, colored by how well each matched. */
  showFeatures: boolean;
  /** How solid the body is drawn, 0..1. */
  bodyOpacity: number;
  selected?: string;
}

export function emptyRigMatchFlowData(): RigMatchFlowData {
  return {
    editor: 'rigMatch',
    bound: null,
    options: { ...DEFAULT_RIG_MATCH_OPTIONS },
    fit: null,
    report: null,
    showBody: true,
    showSkeleton: true,
    showFeatures: false,
    bodyOpacity: 0.7,
  };
}

/** Is what is held still what is wired in? */
export function rigMatchState(
  data: RigMatchFlowData,
  boundHash: string | undefined,
  imageHash: string | undefined,
): 'none' | 'stale' | 'unmatched' | 'ready' {
  if (!data.bound) return 'none';
  if (boundHash && data.boundHash && boundHash !== data.boundHash) return 'stale';
  if (!data.fit) return 'unmatched';
  if (imageHash && data.imageHash && imageHash !== data.imageHash) return 'stale';
  return 'ready';
}

/** Has the fit been moved by hand since it was scored? */
export function reportIsCurrent(data: RigMatchFlowData): boolean {
  return Boolean(data.fit && data.report && data.report.forFit === fitSignature(data.fit));
}

/** A confidence as people say it. */
export function confidenceLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'no features';
  const percent = Math.round(value * 100);
  const word = value >= 0.7 ? 'strong' : value >= 0.45 ? 'fair' : value >= 0.2 ? 'weak' : 'not found';
  return `${percent}% · ${word}`;
}

export function summariseRigMatch(data: RigMatchFlowData): string {
  if (!data.bound) return 'Nothing taken in yet.';
  const bones = data.bound.rig.bones.length;
  if (!data.fit) return `${bones} bone(s) · not matched yet`;
  const turned = Object.values(data.fit.angles).filter((angle) => Math.abs(angle) > 0.5).length;
  const confidence = data.report && reportIsCurrent(data) ? ` · confidence ${confidenceLabel(data.report.confidence)}` : data.report ? ' · adjusted by hand since the match' : '';
  return `${bones} bone(s) · ${turned} turned · ×${data.fit.scale.toFixed(2)}, ${data.fit.rotation.toFixed(0)}°${confidence}`;
}

/** The fit as a pose: each bone's own turn, which is all a Pose flow keeps. */
export function poseOfFit(fit: RigFit): Record<string, number> {
  return Object.fromEntries(Object.entries(fit.angles).filter(([, angle]) => Math.abs(angle) > 1e-6));
}

/** The shapes of a drawing a bone moves, for drawing one part on its own. */
export function shapesOfBone(bound: BoundRig, boneId: string): string[] {
  return bound.image.shapes.filter((shape) => bound.points[shape.id]?.includes(boneId)).map((shape) => shape.id);
}
