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
 * An area of one color.
 *
 * Always **convex**. A region traced out of an image is any shape at all; it is
 * cut into convex pieces because that is what everything downstream can rely on
 * — a convex polygon is trivially triangulated, point-in-tested, offset and
 * filled, and never has the self-intersections that make a concave one a
 * special case in every renderer that meets it.
 */
export interface VectorPolygon {
  id: string;
  kind: 'polygon';
  color: string;
  points: VectorPoint[];
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
  const points = shape.points;
  if (points.length < 2) return null;
  const wraps = shape.kind === 'polygon' || shape.closed;
  const last = wraps ? points.length : points.length - 1;

  let index = 0;
  let distance = Infinity;
  for (let at = 0; at < last; at += 1) {
    const measured = distanceToSegment(point, points[at]!, points[(at + 1) % points.length]!);
    if (measured < distance) {
      distance = measured;
      index = at;
    }
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
  const points = shape.points;
  if (points.length < 3) return false;

  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const a = points[index]!;
    const b = points[previous]!;
    if (a.y > point.y === b.y > point.y) continue;
    if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
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
  shape.points.forEach((candidate, at) => {
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

  const body = points
    .slice(1)
    .map((point) => `L ${round(point.x)} ${round(point.y)}`)
    .join(' ');
  const closes = shape.kind === 'polygon' || shape.closed;
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
    ...polygons.map(
      (shape) => `  <path d="${shapePath(shape)}" fill="${shape.color}" stroke="none"/>`,
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

export function movePoint(
  image: VectorImage,
  id: string,
  index: number,
  to: VectorPoint,
): VectorImage {
  const shape = shapeById(image, id);
  if (!shape || index < 0 || index >= shape.points.length) return image;
  const points = shape.points.map((point, at) => (at === index ? { ...to } : point));
  return replace(image, id, { ...shape, points } as VectorShape);
}

/**
 * Add an anchor partway along a segment.
 *
 * Placed where you pointed rather than at the midpoint, because the reason to
 * add a point is almost always to pull the shape towards somewhere specific.
 */
export function addPoint(image: VectorImage, id: string, segment: number, at: VectorPoint): VectorImage {
  const shape = shapeById(image, id);
  if (!shape || segment < 0 || segment >= shape.points.length) return image;
  const points = [...shape.points];
  points.splice(segment + 1, 0, { ...at });
  return replace(image, id, { ...shape, points } as VectorShape);
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
  if (!shape || index < 0 || index >= shape.points.length) return image;
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
 * leave no gap. A cut that does not cross the polygon twice is not a cut, and
 * the polygon is left alone rather than being mangled into something unclosed.
 *
 * The halves are convex whenever the cut is a straight line through a convex
 * polygon, which is what the decomposition produces — so cutting keeps the
 * promise the shape makes about itself.
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
  if (hits.length !== 2) return image;

  hits.sort((one, two) => one.edge - two.edge || one.t - two.t);
  const [first, second] = hits as [(typeof hits)[0], (typeof hits)[0]];

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

  return replace(image, id, [
    { ...shape, id: makeId('poly'), points: one },
    { ...shape, id: makeId('poly'), points: two },
  ]);
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
      if (points.length >= 3) shapes.push({ id, kind: 'polygon', color, points });
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
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
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
    lines: lines.length,
    straightLines: lines.filter((line) => !line.curved).length,
    curvedLines: lines.filter((line) => line.curved).length,
    points: image.shapes.reduce((sum, shape) => sum + shape.points.length, 0),
    colors: [...new Set(image.shapes.map((shape) => shape.color))].sort(),
    // Editing can make one, and a consumer relying on convexity should be told.
    concave: polygons.filter((polygon) => !isConvex(polygon.points)).length,
  };
}

export function averageColor(colors: string[]): Rgb | undefined {
  const values = colors.map((hex) => fromHex(hex)).filter((rgb): rgb is Rgb => rgb !== undefined);
  if (values.length === 0) return undefined;
  return {
    r: Math.round(values.reduce((sum, rgb) => sum + rgb.r, 0) / values.length),
    g: Math.round(values.reduce((sum, rgb) => sum + rgb.g, 0) / values.length),
    b: Math.round(values.reduce((sum, rgb) => sum + rgb.b, 0) / values.length),
  };
}
