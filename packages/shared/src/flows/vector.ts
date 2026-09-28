import { fromHex, toHex, type Rgb } from './palette';

/**
 * A vectorized image: what the decomposition flow writes and the vector editor
 * edits.
 *
 * Two shapes, because the picture has two kinds of thing in it. A **polygon** is
 * an area of one color. A **line** is a stroke — an outline, a crease, a drawn
 * mark — which has a width and a middle rather than an inside.
 */

export interface VectorPoint {
  x: number;
  y: number;
  /**
   * How curved the outline is through this node: 0 (or absent) is a corner and
   * the segments either side are straight; 1 is smooth, the curve passing
   * through with the handles a third of each segment long. Anything between
   * bows the segments less.
   */
  s?: number;
  /**
   * A turn of the curve's direction through this node, in degrees, from the
   * direction it would take on its own (along the line from the node before to
   * the node after). Relative, so it survives the drawing being moved, turned
   * or posed.
   */
  a?: number;
}

/**
 * A stroke.
 *
 * What is stored is the **anchors**, plus whether the run between them is
 * smoothed. The alternative — storing cubic control points directly — is what an
 * SVG holds, and it makes editing miserable: dragging one point means fixing up
 * four numbers on each side of it to keep the curve continuous, and adding a
 * point in the middle of a curve means solving for a split.
 *
 * So the anchors are the truth and the Béziers are derived from them when the
 * SVG is written. Nothing is lost: the fitting step decides which anchors to keep
 * and whether a run curves, which is the part that carries the information.
 */
export interface VectorLine {
  id: string;
  kind: 'line';
  /** Hex. The color of the stroke itself, not of what it separates. */
  color: string;
  /** How thick the stroke was, in image pixels. */
  width: number;
  points: VectorPoint[];
  /** Smoothed through the anchors, rather than joined corner to corner. */
  curved: boolean;
  /** The last point joins the first — an outline that goes all the way round. */
  closed: boolean;
}

/**
 * An area of one color, with holes where something else is.
 *
 * The outline is **simple** — one loop of points that never crosses or touches
 * itself — and so is each hole, which lies inside it. A hole is where the area
 * is not: another color drawn inside it (an eye in a face) or a transparent gap
 * in the picture. The decomposition makes one polygon per region of the picture,
 * so a region with something inside it is a polygon with a hole, and the shape
 * inside is its own polygon that fits the hole exactly — nothing overlaps.
 *
 * Filled even-odd: a point is inside when it is inside the outline and outside
 * every hole. `holes` is left off entirely when there are none, which is how
 * every polygon made before holes existed reads back.
 */
export interface VectorPolygon {
  id: string;
  kind: 'polygon';
  color: string;
  points: VectorPoint[];
  /** Loops inside the outline that are not part of the area. */
  holes?: VectorPoint[][];
}

/** A polygon's holes, none when it has none. */
export function holesOf(shape: VectorShape): VectorPoint[][] {
  return shape.kind === 'polygon' ? (shape.holes ?? []) : [];
}

/**
 * The same shape with every point moved, holes included, in `allPoints` order —
 * so an index into a per-point list (which bone each point follows) means the
 * same point here as there.
 */
export function mapPoints<T extends VectorShape>(shape: T, move: (point: VectorPoint, index: number) => VectorPoint): T {
  let index = 0;
  // A node's curve goes where the node goes: what it is, not where it is.
  const carry = (point: VectorPoint): VectorPoint => {
    const moved = move(point, index++);
    if (moved === point || (point.s === undefined && point.a === undefined)) return moved;
    return { ...moved, ...(point.s !== undefined && moved.s === undefined ? { s: point.s } : {}), ...(point.a !== undefined && moved.a === undefined ? { a: point.a } : {}) };
  };
  const points = shape.points.map(carry);
  if (shape.kind !== 'polygon' || !shape.holes) return { ...shape, points };
  const holes = shape.holes.map((hole) => hole.map(carry));
  return { ...shape, points, holes };
}

/** Every point of a shape: its outline or path, then its holes'. */
export function allPoints(shape: VectorShape): VectorPoint[] {
  const holes = holesOf(shape);
  return holes.length === 0 ? shape.points : [...shape.points, ...holes.flat()];
}

/**
 * Where an index into `allPoints` falls: which loop (-1 for the outline or
 * path, otherwise the hole's number) and where in it.
 */
export function ringOf(shape: VectorShape, index: number): { ring: number; at: number } | null {
  if (index < 0) return null;
  if (index < shape.points.length) return { ring: -1, at: index };
  let start = shape.points.length;
  const holes = holesOf(shape);
  for (let ring = 0; ring < holes.length; ring += 1) {
    if (index < start + holes[ring]!.length) return { ring, at: index - start };
    start += holes[ring]!.length;
  }
  return null;
}

/** The same shape with one loop replaced, or a hole removed with `null`. */
function withRing(shape: VectorShape, ring: number, points: VectorPoint[] | null): VectorShape {
  if (ring < 0) return { ...shape, points: points ?? [] } as VectorShape;
  if (shape.kind !== 'polygon') return shape;
  const holes = (shape.holes ?? []).flatMap((hole, at) => (at !== ring ? [hole] : points ? [points] : []));
  const { holes: _old, ...rest } = shape;
  return holes.length > 0 ? { ...rest, holes } : rest;
}

export type VectorShape = VectorLine | VectorPolygon;

export interface VectorImage {
  width: number;
  height: number;
  shapes: VectorShape[];
}

export function emptyVectorImage(width = 0, height = 0): VectorImage {
  return { width, height, shapes: [] };
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export function area(points: VectorPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/** Signed area, so the winding direction survives. */
export function isClockwise(points: VectorPoint[]): boolean {
  return area(points) < 0;
}

/**
 * Convex means every turn goes the same way.
 *
 * Collinear points are allowed: tracing pixels produces plenty of them, and a
 * straight run of three is not a dent.
 */
export function isConvex(points: VectorPoint[]): boolean {
  if (points.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const c = points[(index + 2) % points.length]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const turn = cross > 0 ? 1 : -1;
    if (sign === 0) sign = turn;
    else if (turn !== sign) return false;
  }
  return true;
}

export function boundsOf(points: VectorPoint[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function shapeBounds(shape: VectorShape): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return boundsOf(shape.points);
}

export function distanceToSegment(point: VectorPoint, a: VectorPoint, b: VectorPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Which segment of a shape a point is nearest, and how far. */
export function nearestSegment(
  shape: VectorShape,
  point: VectorPoint,
): { index: number; distance: number } | null {
  if (shape.points.length < 2) return null;
  const wraps = shape.kind === 'polygon' || shape.closed;

  // Indexed as `allPoints` is: a hole's segments come after the outline's, each
  // named by the point it starts from.
  let index = 0;
  let distance = Infinity;
  let start = 0;
  for (const points of [shape.points, ...holesOf(shape)]) {
    const last = wraps ? points.length : points.length - 1;
    for (let at = 0; at < last; at += 1) {
      const measured = distanceToSegment(point, points[at]!, points[(at + 1) % points.length]!);
      if (measured < distance) {
        distance = measured;
        index = start + at;
      }
    }
    start += points.length;
  }
  return { index, distance };
}

/**
 * Is this point inside a filled shape?
 *
 * Even-odd ray casting. Needed because a polygon is filled, and clicking the
 * middle of a filled shape is how anyone expects to select it — measuring to its
 * edge instead means a big shape can only be picked up by its outline, which is
 * a thin target around a large object.
 */
export function containsPoint(shape: VectorShape, point: VectorPoint): boolean {
  if (shape.kind !== 'polygon' && !shape.closed) return false;
  if (shape.points.length < 3) return false;

  // Even-odd over the outline and every hole: a click in a hole is a click on
  // whatever fills it, not on the shape round it.
  let inside = false;
  for (const points of [shape.points, ...holesOf(shape)]) {
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
      const a = points[index]!;
      const b = points[previous]!;
      if (a.y > point.y === b.y > point.y) continue;
      if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** The nearest anchor, for picking one up. */
export function nearestPoint(
  shape: VectorShape,
  point: VectorPoint,
): { index: number; distance: number } | null {
  if (shape.points.length === 0) return null;
  let index = 0;
  let distance = Infinity;
  allPoints(shape).forEach((candidate, at) => {
    const measured = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (measured < distance) {
      distance = measured;
      index = at;
    }
  });
  return { index, distance };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Anchors to cubic Béziers.
 *
 * The same centripetal Catmull-Rom the cutout flow draws with, converted to the
 * cubic form an SVG understands. Converted rather than approximated: a
 * Catmull-Rom segment *is* a cubic Bézier with control points at
 * `p1 ± (p2 - p0) / 6`, so the curve in the file is exactly the curve the editor
 * drew, not a fit to it.
 */
export function toCubics(
  points: VectorPoint[],
  closed: boolean,
): Array<{ c1: VectorPoint; c2: VectorPoint; to: VectorPoint }> {
  const out: Array<{ c1: VectorPoint; c2: VectorPoint; to: VectorPoint }> = [];
  if (points.length < 2) return out;

  const at = (index: number) => {
    if (closed) return points[((index % points.length) + points.length) % points.length]!;
    return points[Math.max(0, Math.min(points.length - 1, index))]!;
  };
  const last = closed ? points.length : points.length - 1;

  for (let index = 0; index < last; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    out.push({
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      to: { x: p2.x, y: p2.y },
    });
  }
  return out;
}

export function shapePath(shape: VectorShape): string {
  const points = shape.points;
  if (points.length === 0) return '';
  const head = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;

  if (shape.kind === 'line' && shape.curved && points.length > 2) {
    const cubics = toCubics(points, shape.closed);
    const body = cubics
      .map(
        (cubic) =>
          `C ${round(cubic.c1.x)} ${round(cubic.c1.y)} ${round(cubic.c2.x)} ${round(cubic.c2.y)} ${round(
            cubic.to.x,
          )} ${round(cubic.to.y)}`,
      )
      .join(' ');
    return `${head} ${body}${shape.closed ? ' Z' : ''}`;
  }

  const closes = shape.kind === 'polygon' || shape.closed;
  const outline = hasCurves(points) ? curvedRingPath(points, closes) : ringPath(points, closes);
  // Each hole is one more closed subpath; drawn with fill-rule evenodd, it is cut out.
  const holes = holesOf(shape)
    .filter((hole) => hole.length >= 3)
    .map((hole) => (hasCurves(hole) ? curvedRingPath(hole, true) : ringPath(hole, true)));
  return [outline, ...holes].join(' ');
}

/** Whether any node of a loop is curved. */
export function hasCurves(points: readonly VectorPoint[]): boolean {
  return points.some((point) => (point.s ?? 0) > 0);
}

export interface CurveSegment {
  from: VectorPoint;
  c1: VectorPoint;
  c2: VectorPoint;
  to: VectorPoint;
  /** False where both ends are corners: a straight segment. */
  curved: boolean;
}

/**
 * The direction the curve takes through node `index`: along the line from the
 * node before to the node after (the end nodes of an open line along their one
 * segment), turned by the node's own `a`.
 */
export function nodeTangent(points: readonly VectorPoint[], index: number, closed: boolean): VectorPoint {
  const n = points.length;
  const at = (k: number) => (closed ? points[((k % n) + n) % n]! : points[Math.max(0, Math.min(n - 1, k))]!);
  const before = at(index - 1);
  const after = at(index + 1);
  let dx = after.x - before.x;
  let dy = after.y - before.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { x: 0, y: 0 };
  dx /= length;
  dy /= length;
  const turn = ((points[index]?.a ?? 0) * Math.PI) / 180;
  if (turn === 0) return { x: dx, y: dy };
  return { x: dx * Math.cos(turn) - dy * Math.sin(turn), y: dx * Math.sin(turn) + dy * Math.cos(turn) };
}

/**
 * A loop as cubic segments, one between each pair of nodes. A segment's handles
 * are a third of its length times how curved each end is, along each end's
 * direction — so a corner at both ends is a straight segment, and two shapes
 * sharing a run of nodes draw exactly the same curve along it, each walking it
 * the other way.
 */
export function ringSegments(points: readonly VectorPoint[], closed: boolean): CurveSegment[] {
  const out: CurveSegment[] = [];
  const n = points.length;
  if (n < 2) return out;
  const last = closed ? n : n - 1;
  for (let index = 0; index < last; index += 1) {
    const from = points[index]!;
    const to = points[(index + 1) % n]!;
    const s1 = from.s ?? 0;
    const s2 = to.s ?? 0;
    if (s1 <= 0 && s2 <= 0) {
      out.push({ from, c1: from, c2: to, to, curved: false });
      continue;
    }
    const reach = Math.hypot(to.x - from.x, to.y - from.y) / 3;
    const t1 = nodeTangent(points, index, closed);
    const t2 = nodeTangent(points, (index + 1) % n, closed);
    out.push({
      from,
      c1: { x: from.x + t1.x * reach * s1, y: from.y + t1.y * reach * s1 },
      c2: { x: to.x - t2.x * reach * s2, y: to.y - t2.y * reach * s2 },
      to,
      curved: true,
    });
  }
  return out;
}

function curvedRingPath(points: VectorPoint[], closes: boolean): string {
  const head = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;
  const body = ringSegments(points, closes)
    .map((segment) =>
      segment.curved
        ? `C ${round(segment.c1.x)} ${round(segment.c1.y)} ${round(segment.c2.x)} ${round(segment.c2.y)} ${round(segment.to.x)} ${round(segment.to.y)}`
        : `L ${round(segment.to.x)} ${round(segment.to.y)}`,
    )
    .join(' ');
  return `${head}${body ? ` ${body}` : ''}${closes ? ' Z' : ''}`;
}

/**
 * A loop as straight steps, curves followed closely enough to paint: each
 * curved segment in steps no longer than `step`, at least four.
 */
export function flattenRing(points: readonly VectorPoint[], closed: boolean, legacyCurved = false, step = 2): VectorPoint[] {
  if (points.length < 2) return points.map((point) => ({ x: point.x, y: point.y }));
  const segments = legacyCurved && !hasCurves(points)
    ? toCubics([...points], closed).map((cubic, index) => ({ from: points[index]!, c1: cubic.c1, c2: cubic.c2, to: cubic.to, curved: true }))
    : ringSegments(points, closed);
  const out: VectorPoint[] = [{ x: points[0]!.x, y: points[0]!.y }];
  for (const segment of segments) {
    if (!segment.curved) {
      out.push({ x: segment.to.x, y: segment.to.y });
      continue;
    }
    const length = Math.hypot(segment.c1.x - segment.from.x, segment.c1.y - segment.from.y) + Math.hypot(segment.c2.x - segment.c1.x, segment.c2.y - segment.c1.y) + Math.hypot(segment.to.x - segment.c2.x, segment.to.y - segment.c2.y);
    const steps = Math.max(4, Math.min(64, Math.ceil(length / step)));
    for (let k = 1; k <= steps; k += 1) {
      const t = k / steps;
      const u = 1 - t;
      out.push({
        x: u * u * u * segment.from.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t * t * t * segment.to.x,
        y: u * u * u * segment.from.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t * t * t * segment.to.y,
      });
    }
  }
  // A closed loop came back round to its start; the start is already there.
  if (closed && out.length > 1) out.pop();
  return out;
}

/** A shape's outline and holes as straight steps, for painting into pixels. */
export function flattenShape(shape: VectorShape, step = 2): { points: VectorPoint[]; holes: VectorPoint[][] } {
  const closes = shape.kind === 'polygon' || shape.closed;
  const legacy = shape.kind === 'line' && shape.curved;
  return {
    points: flattenRing(shape.points, closes, legacy, step),
    holes: holesOf(shape).map((hole) => flattenRing(hole, true, false, step)),
  };
}

/**
 * How far an outline turns at a node, in degrees: 0 straight on, 180 doubling
 * back. The end nodes of an open line do not turn.
 */
export function nodeTurn(points: readonly VectorPoint[], index: number, closed: boolean): number {
  const n = points.length;
  if (!closed && (index === 0 || index === n - 1)) return 0;
  const before = points[(index - 1 + n) % n]!;
  const here = points[index]!;
  const after = points[(index + 1) % n]!;
  const ax = here.x - before.x;
  const ay = here.y - before.y;
  const bx = after.x - here.x;
  const by = after.y - here.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** A node's name: where it is. Two points in the same place are one node. */
export function pointKey(point: VectorPoint): string {
  return `${point.x},${point.y}`;
}

/**
 * Change nodes by where they are, in every shape that has them.
 *
 * Neighbouring shapes share the nodes along the boundary between them — that
 * is how they fit — so a node moved, deleted or curved in one shape has to be
 * the same in all of them, or the boundary opens. `change` is told each node
 * and returns what it becomes: itself, a changed node, or null to delete it. A
 * shape left with too few nodes to be a shape (a polygon under three, a line
 * under two) is dropped; a hole under three closes.
 */
export function changeNodes(image: VectorImage, change: (point: VectorPoint, key: string) => VectorPoint | null): VectorImage {
  const shapes: VectorShape[] = [];
  const ring = (points: VectorPoint[]) => {
    const out: VectorPoint[] = [];
    for (const point of points) {
      const next = change(point, pointKey(point));
      if (!next) continue;
      // Two nodes landing in the same place in a row are one.
      const previous = out[out.length - 1];
      if (previous && previous.x === next.x && previous.y === next.y) continue;
      out.push(next);
    }
    return out;
  };
  for (const shape of image.shapes) {
    const points = ring(shape.points);
    const closes = shape.kind === 'polygon' || shape.closed;
    if (closes && points.length > 1 && points[0]!.x === points[points.length - 1]!.x && points[0]!.y === points[points.length - 1]!.y) points.pop();
    if (points.length < (shape.kind === 'polygon' ? 3 : 2)) continue;
    if (shape.kind === 'polygon') {
      const holes = holesOf(shape).map(ring).filter((hole) => hole.length >= 3);
      const { holes: _old, ...rest } = shape;
      shapes.push(holes.length > 0 ? { ...rest, points, holes } : { ...rest, points });
    } else {
      shapes.push({ ...shape, points });
    }
  }
  return { ...image, shapes };
}

/** Delete one node from every shape that shares it. */
export function deleteNode(image: VectorImage, key: string): VectorImage {
  return changeNodes(image, (point, at) => (at === key ? null : point));
}

/** Set a node's curve — how curved, and its turn — in every shape that shares it. */
export function setNodeCurve(image: VectorImage, key: string, curve: { s?: number; a?: number }): VectorImage {
  return changeNodes(image, (point, at) => {
    if (at !== key) return point;
    const next: VectorPoint = { ...point };
    if (curve.s !== undefined) {
      if (curve.s <= 0) delete next.s;
      else next.s = Math.round(curve.s * 1000) / 1000;
    }
    if (curve.a !== undefined) {
      if (curve.a === 0) delete next.a;
      else next.a = Math.round(curve.a * 10) / 10;
    }
    return next;
  });
}

function ringPath(points: VectorPoint[], closes: boolean): string {
  const head = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;
  const body = points
    .slice(1)
    .map((point) => `L ${round(point.x)} ${round(point.y)}`)
    .join(' ');
  return `${head}${body ? ` ${body}` : ''}${closes ? ' Z' : ''}`;
}

/**
 * The image as an SVG.
 *
 * Polygons first and lines over them, because that is the order they were in
 * when the picture was a picture: a stroke sits on top of what it separates.
 */
export function toSvg(image: VectorImage): string {
  const polygons = image.shapes.filter((shape): shape is VectorPolygon => shape.kind === 'polygon');
  const lines = image.shapes.filter((shape): shape is VectorLine => shape.kind === 'line');

  const body = [
    /*
     * Each area is stroked in its own color, hairline thin.
     *
     * The areas tile the picture exactly — they share their boundaries point for
     * point — but a renderer antialiases each one on its own, so two shapes
     * meeting along an edge each cover about half of the pixels under it and the
     * background shows through as a hairline. A quarter-pixel of its own color
     * either side of the boundary closes that without moving anything.
     */
    ...polygons.map(
      (shape) =>
        `  <path d="${shapePath(shape)}" fill="${shape.color}" fill-rule="evenodd" stroke="${shape.color}" stroke-width="0.5"/>`,
    ),
    ...lines.map(
      (shape) =>
        `  <path d="${shapePath(shape)}" fill="none" stroke="${shape.color}" stroke-width="${round(
          shape.width,
        )}" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
  ].join('\n');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">`,
    body,
    '</svg>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

export function shapeById(image: VectorImage, id: string): VectorShape | undefined {
  return image.shapes.find((shape) => shape.id === id);
}

function replace(image: VectorImage, id: string, next: VectorShape | VectorShape[] | null): VectorImage {
  const shapes: VectorShape[] = [];
  for (const shape of image.shapes) {
    if (shape.id !== id) {
      shapes.push(shape);
      continue;
    }
    if (next === null) continue;
    if (Array.isArray(next)) shapes.push(...next);
    else shapes.push(next);
  }
  return { ...image, shapes };
}

export function deleteShape(image: VectorImage, id: string): VectorImage {
  return replace(image, id, null);
}

export function deleteShapes(image: VectorImage, ids: readonly string[]): VectorImage {
  const gone = new Set(ids);
  return { ...image, shapes: image.shapes.filter((shape) => !gone.has(shape.id)) };
}

/**
 * Move whole shapes, every point of them. A node they shared with a shape left
 * behind is no longer shared: moving a shape away is taking it away.
 */
export function translateShapes(image: VectorImage, ids: readonly string[], by: VectorPoint): VectorImage {
  const moving = new Set(ids);
  if (moving.size === 0 || (by.x === 0 && by.y === 0)) return image;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    ...image,
    shapes: image.shapes.map((shape) =>
      moving.has(shape.id) ? mapPoints(shape, (point) => ({ ...point, x: round(point.x + by.x), y: round(point.y + by.y) })) : shape,
    ),
  };
}

/**
 * Add a shape. A polygon goes after the last polygon and a line after
 * everything, the order a decomposition draws them in, so a new area never
 * covers the strokes drawn over it.
 */
export function addShape(image: VectorImage, shape: VectorShape): VectorImage {
  if (shape.kind === 'line') return { ...image, shapes: [...image.shapes, shape] };
  const lastPolygon = image.shapes.map((one) => one.kind).lastIndexOf('polygon');
  const shapes = [...image.shapes];
  shapes.splice(lastPolygon + 1, 0, shape);
  return { ...image, shapes };
}

/** Recolor shapes. */
export function setShapeColor(image: VectorImage, ids: readonly string[], color: string): VectorImage {
  const chosen = new Set(ids);
  return { ...image, shapes: image.shapes.map((shape) => (chosen.has(shape.id) ? { ...shape, color } : shape)) };
}

/** Change a line's width. */
export function setLineWidth(image: VectorImage, ids: readonly string[], width: number): VectorImage {
  const chosen = new Set(ids);
  return { ...image, shapes: image.shapes.map((shape) => (chosen.has(shape.id) && shape.kind === 'line' ? { ...shape, width: Math.max(0.25, width) } : shape)) };
}

export function movePoint(
  image: VectorImage,
  id: string,
  index: number,
  to: VectorPoint,
): VectorImage {
  const shape = shapeById(image, id);
  if (!shape || !ringOf(shape, index)) return image;
  return replace(image, id, mapPoints(shape, (point, at) => (at === index ? { ...point, x: to.x, y: to.y } : point)));
}

/**
 * Add an anchor partway along a segment.
 *
 * Placed where you pointed rather than at the midpoint, because the reason to
 * add a point is almost always to pull the shape towards somewhere specific.
 */
export function addPoint(image: VectorImage, id: string, segment: number, at: VectorPoint): VectorImage {
  const shape = shapeById(image, id);
  const where = shape ? ringOf(shape, segment) : null;
  if (!shape || !where) return image;
  const points = [...(where.ring < 0 ? shape.points : holesOf(shape)[where.ring]!)];
  points.splice(where.at + 1, 0, { ...at });
  return replace(image, id, withRing(shape, where.ring, points));
}

/**
 * Remove one anchor.
 *
 * A line needs two points and a polygon three; below that there is no shape
 * left, so the shape goes rather than becoming a degenerate one that draws as
 * nothing and cannot be selected to delete.
 */
export function deletePoint(image: VectorImage, id: string, index: number): VectorImage {
  const shape = shapeById(image, id);
  const where = shape ? ringOf(shape, index) : null;
  if (!shape || !where) return image;
  if (where.ring >= 0) {
    // A hole left with two points is no hole: it closes.
    const hole = holesOf(shape)[where.ring]!;
    return replace(image, id, withRing(shape, where.ring, hole.length <= 3 ? null : hole.filter((_, at) => at !== where.at)));
  }
  const minimum = shape.kind === 'polygon' ? 3 : 2;
  if (shape.points.length <= minimum) return deleteShape(image, id);
  const points = shape.points.filter((_, at) => at !== index);
  return replace(image, id, { ...shape, points } as VectorShape);
}

/**
 * Split a line at a segment, giving two lines.
 *
 * Both keep the anchor they were split at, so the pieces still meet — cutting a
 * line should divide it, not chip a gap out of it.
 */
export function splitLine(
  image: VectorImage,
  id: string,
  segment: number,
  at: VectorPoint,
  makeId: (prefix: string) => string,
): VectorImage {
  const shape = shapeById(image, id);
  if (!shape || shape.kind !== 'line') return image;

  if (shape.closed) {
    // Opening a loop is a cut too: it becomes one line, starting and ending at
    // the cut, rather than two.
    const points = [
      { ...at },
      ...shape.points.slice(segment + 1),
      ...shape.points.slice(0, segment + 1),
      { ...at },
    ];
    return replace(image, id, { ...shape, points, closed: false });
  }

  if (segment < 0 || segment >= shape.points.length - 1) return image;
  const head = [...shape.points.slice(0, segment + 1), { ...at }];
  const tail = [{ ...at }, ...shape.points.slice(segment + 1)];
  if (head.length < 2 || tail.length < 2) return image;

  return replace(image, id, [
    { ...shape, id: makeId('line'), points: head },
    { ...shape, id: makeId('line'), points: tail },
  ]);
}

/**
 * Cut a polygon in two along a line through it.
 *
 * Both halves keep the two crossing points, so they still share an edge and
 * leave no gap. A cut that does not cross the polygon is not a cut, and the
 * polygon is left alone rather than being mangled into something unclosed.
 *
 * A convex polygon is crossed twice by any line through it. A concave one — which
 * is what the decomposition hands back once it joins a region's pieces — can be
 * crossed four times or six: a straight line across a C goes in, out, and in
 * again. Then the cut is the stretch of the line **inside the shape nearest the
 * two clicks**, which is the stretch the person was pointing at. Any stretch
 * between two consecutive crossings that lies inside a simple polygon divides it
 * into exactly two simple polygons, so the halves are always shapes.
 */
export function splitPolygon(
  image: VectorImage,
  id: string,
  from: VectorPoint,
  to: VectorPoint,
  makeId: (prefix: string) => string,
): VectorImage {
  const shape = shapeById(image, id);
  if (!shape || shape.kind !== 'polygon') return image;

  const points = shape.points;

  /*
   * The cut is extended well past both ends before anything is intersected.
   *
   * Two clicks across a shape are almost never exactly on its outline: aiming at
   * the edge lands a pixel inside as often as a pixel outside, and a segment
   * lying wholly *inside* the polygon crosses none of its edges at all. Taken
   * literally that is "not a cut", so the shape would be left alone and the
   * gesture would appear to do nothing — for a reason invisible on screen.
   * Extending turns both clicks into a direction, which is what they were.
   */
  const span = boundsOf(points);
  const reach = Math.hypot(span.width, span.height) + 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return image;
  const step = { x: (dx / length) * reach, y: (dy / length) * reach };
  const start = { x: from.x - step.x, y: from.y - step.y };
  const end = { x: to.x + step.x, y: to.y + step.y };

  const found: Array<{ edge: number; t: number; point: VectorPoint }> = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const crossing = intersect(start, end, a, b);
    if (crossing) found.push({ edge: index, t: crossing.u, point: crossing.point });
  }

  /*
   * A cut through a corner is found on both edges that meet there, so cutting a
   * square from corner to corner reports four crossings and would be thrown out
   * as "not a cut" — which is a cut anyone would make, because a corner is what
   * the eye and the cursor both snap to. The same point counted twice is one
   * crossing.
   */
  const hits: typeof found = [];
  for (const hit of found) {
    if (hits.some((kept) => Math.hypot(kept.point.x - hit.point.x, kept.point.y - hit.point.y) < 1e-6)) {
      continue;
    }
    hits.push(hit);
  }
  if (hits.length < 2 || hits.length % 2 !== 0) return image;

  /*
   * Which two crossings. Along the line they alternate out-in-out, because the
   * line was extended past the polygon at both ends and so starts outside it:
   * crossings 0-1 are inside, 2-3 are inside, and so on. Of those stretches, the
   * one the clicks were aimed at is the one nearest the middle of them.
   */
  const along = (point: VectorPoint) => (point.x - start.x) * step.x + (point.y - start.y) * step.y;
  hits.sort((one, two) => along(one.point) - along(two.point));
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  let pick = 0;
  let nearest = Infinity;
  for (let index = 0; index + 1 < hits.length; index += 2) {
    const distance = distanceToSegment(middle, hits[index]!.point, hits[index + 1]!.point);
    if (distance < nearest) {
      nearest = distance;
      pick = index;
    }
  }
  const chosen = [hits[pick]!, hits[pick + 1]!];

  chosen.sort((one, two) => one.edge - two.edge || one.t - two.t);
  const [first, second] = chosen as [(typeof hits)[0], (typeof hits)[0]];
  // Two crossings on the same edge is a line that grazes along it, not one
  // through the shape — there is nothing between them to cut off.
  if (first.edge === second.edge) return image;

  const one: VectorPoint[] = [
    first.point,
    ...points.slice(first.edge + 1, second.edge + 1),
    second.point,
  ];
  const two: VectorPoint[] = [
    second.point,
    ...points.slice(second.edge + 1),
    ...points.slice(0, first.edge + 1),
    first.point,
  ];
  if (one.length < 3 || two.length < 3) return image;

  // Each hole goes with the half it is in. A cut straight through a hole leaves
  // it with whichever half holds the most of it.
  const { holes: _holes, ...plain } = shape;
  const halves: VectorPolygon[] = [
    { ...plain, id: makeId('poly'), points: one },
    { ...plain, id: makeId('poly'), points: two },
  ];
  for (const hole of shape.holes ?? []) {
    const inOne = hole.filter((point) => containsPoint(halves[0]!, point)).length;
    const half = halves[inOne * 2 >= hole.length ? 0 : 1]!;
    half.holes = [...(half.holes ?? []), hole];
  }
  return replace(image, id, halves);
}

/** Where two segments cross, if they do. `u` is how far along the second. */
function intersect(
  a1: VectorPoint,
  a2: VectorPoint,
  b1: VectorPoint,
  b2: VectorPoint,
): { point: VectorPoint; u: number } | null {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-12) return null;

  const t = ((b1.x - a1.x) * by - (b1.y - a1.y) * bx) / denominator;
  const u = ((b1.x - a1.x) * ay - (b1.y - a1.y) * ax) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: { x: b1.x + u * bx, y: b1.y + u * by }, u };
}

/**
 * Remove a run of anchors from a line — "delete this part of it".
 *
 * Taking a bite out of the middle leaves two pieces, so that is what it gives
 * back. Taking one off an end just shortens it.
 */
export function deleteRun(
  image: VectorImage,
  id: string,
  from: number,
  to: number,
  makeId: (prefix: string) => string,
): VectorImage {
  const shape = shapeById(image, id);
  if (!shape) return image;
  const one = ringOf(shape, from);
  const two = ringOf(shape, to);
  if (!one || !two || one.ring !== two.ring) return image;
  if (one.ring >= 0) {
    // A bite out of a hole makes the hole smaller, or closes it.
    const hole = holesOf(shape)[one.ring]!;
    const low = Math.min(one.at, two.at);
    const high = Math.max(one.at, two.at);
    const rest = hole.filter((_, at) => at < low || at > high);
    return replace(image, id, withRing(shape, one.ring, rest.length >= 3 ? rest : null));
  }
  const first = Math.max(0, Math.min(from, to));
  const last = Math.min(shape.points.length - 1, Math.max(from, to));

  const head = shape.points.slice(0, first);
  const tail = shape.points.slice(last + 1);
  const minimum = shape.kind === 'polygon' ? 3 : 2;

  if (shape.kind === 'polygon' || shape.closed) {
    // A loop with a bite out of it is a line, not a smaller loop.
    const rest = [...tail, ...head];
    if (rest.length < 2) return deleteShape(image, id);
    if (shape.kind === 'polygon') {
      return replace(image, id, {
        id: shape.id,
        kind: 'line',
        color: shape.color,
        width: 1,
        points: rest,
        curved: false,
        closed: false,
      });
    }
    return replace(image, id, { ...shape, points: rest, closed: false });
  }

  const pieces: VectorShape[] = [];
  if (head.length >= minimum) pieces.push({ ...shape, id: makeId('line'), points: head });
  if (tail.length >= minimum) pieces.push({ ...shape, id: makeId('line'), points: tail });
  if (pieces.length === 0) return deleteShape(image, id);
  return replace(image, id, pieces);
}

/* ------------------------------------------------------------------ *
 * Reading and reporting
 * ------------------------------------------------------------------ */

/** Read a vector image back, tolerantly, and drop anything that is not a shape. */
export function readVectorImage(json: unknown): VectorImage {
  if (!json || typeof json !== 'object') return emptyVectorImage();
  const record = json as Record<string, unknown>;
  const width = Number(record.width) || 0;
  const height = Number(record.height) || 0;
  const raw = Array.isArray(record.shapes) ? record.shapes : [];

  const shapes: VectorShape[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const shape = entry as Record<string, unknown>;
    const points = readPoints(shape.points);
    const color = readColor(shape.color);
    if (!color) continue;
    const id = typeof shape.id === 'string' ? shape.id : '';
    if (!id) continue;

    if (shape.kind === 'polygon') {
      if (points.length < 3) continue;
      const holes = (Array.isArray(shape.holes) ? shape.holes : [])
        .map(readPoints)
        .filter((hole) => hole.length >= 3);
      shapes.push(holes.length > 0 ? { id, kind: 'polygon', color, points, holes } : { id, kind: 'polygon', color, points });
      continue;
    }
    if (points.length >= 2) {
      shapes.push({
        id,
        kind: 'line',
        color,
        width: Math.max(0.1, Number(shape.width) || 1),
        points,
        curved: shape.curved === true,
        closed: shape.closed === true,
      });
    }
  }
  return { width, height, shapes };
}

function readPoints(value: unknown): VectorPoint[] {
  if (!Array.isArray(value)) return [];
  const out: VectorPoint[] = [];
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const x = Number(entry[0]);
      const y = Number(entry[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const point = entry as Record<string, unknown>;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const read: VectorPoint = { x, y };
      const curve = Number(point.s);
      const turn = Number(point.a);
      if (point.s !== undefined && Number.isFinite(curve) && curve > 0) read.s = Math.min(2, curve);
      if (point.a !== undefined && Number.isFinite(turn) && turn !== 0) read.a = Math.max(-180, Math.min(180, turn));
      out.push(read);
    }
  }
  return out;
}

function readColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const rgb = fromHex(value);
  return rgb ? toHex(rgb) : undefined;
}

export interface VectorSummary {
  shapes: number;
  polygons: number;
  /** Holes across every polygon. */
  holes: number;
  lines: number;
  straightLines: number;
  curvedLines: number;
  points: number;
  colors: string[];
  concave: number;
}

export function summariseVector(image: VectorImage): VectorSummary {
  const polygons = image.shapes.filter((shape): shape is VectorPolygon => shape.kind === 'polygon');
  const lines = image.shapes.filter((shape): shape is VectorLine => shape.kind === 'line');
  return {
    shapes: image.shapes.length,
    polygons: polygons.length,
    holes: polygons.reduce((sum, polygon) => sum + (polygon.holes?.length ?? 0), 0),
    lines: lines.length,
    straightLines: lines.filter((line) => !line.curved).length,
    curvedLines: lines.filter((line) => line.curved).length,
    points: image.shapes.reduce((sum, shape) => sum + allPoints(shape).length, 0),
    colors: [...new Set(image.shapes.map((shape) => shape.color))].sort(),
    // Editing can make one, and a consumer relying on convexity should be told.
    concave: polygons.filter((polygon) => !isConvex(polygon.points)).length,
  };
}

export function averageColor(colors: string[]): Rgb | undefined {
  const values = colors.map((hex) => fromHex(hex)).filter((rgb) => rgb !== undefined);
  if (values.length === 0) return undefined;
  return {
    r: Math.round(values.reduce((sum, rgb) => sum + rgb.r, 0) / values.length),
    g: Math.round(values.reduce((sum, rgb) => sum + rgb.g, 0) / values.length),
    b: Math.round(values.reduce((sum, rgb) => sum + rgb.b, 0) / values.length),
  };
}
