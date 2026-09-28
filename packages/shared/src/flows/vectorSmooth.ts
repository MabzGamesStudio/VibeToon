import {
  changeNodes,
  holesOf,
  nodeTangent,
  nodeTurn,
  pointKey,
  shapeById,
  type VectorImage,
  type VectorLine,
  type VectorPoint,
  type VectorShape,
} from './vector';

/**
 * The last two things a decomposition does to its shapes: turn flat polygons
 * into lines, and let shallow corners become curves.
 */

/* ------------------------------------------------------------------ *
 * Flat shapes are lines
 * ------------------------------------------------------------------ */

export interface Flatness {
  /** The direction the shape runs in, as a unit vector. */
  axis: VectorPoint;
  middle: VectorPoint;
  /** Its extent along the axis, and across it. */
  length: number;
  thickness: number;
  /** How much of its outline faces straight across the axis, 0..1 of the perimeter. */
  facingAcross: number;
  /** How much of its outline faces some other way — the ends, in a flat shape. */
  otherwise: number;
}

/**
 * How flat an outline is, from its points and its edges' normals.
 *
 * The axis is the direction the points spread furthest in. An edge whose normal
 * points straight across that axis (within `tolerance` degrees) is one of the
 * two long sides; anything else is an end, or a bump. A shape that is entirely
 * flat is all long sides and two short ends.
 */
export function flatness(points: readonly VectorPoint[], tolerance: number): Flatness | null {
  const n = points.length;
  if (n < 3) return null;
  let cx = 0;
  let cy = 0;
  for (const point of points) {
    cx += point.x;
    cy += point.y;
  }
  cx /= n;
  cy /= n;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point.x - cx;
    const dy = point.y - cy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const across = { x: -axis.y, y: axis.x };
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const point of points) {
    const along = (point.x - cx) * axis.x + (point.y - cy) * axis.y;
    const off = (point.x - cx) * across.x + (point.y - cy) * across.y;
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    minAcross = Math.min(minAcross, off);
    maxAcross = Math.max(maxAcross, off);
  }
  const limit = Math.cos((tolerance * Math.PI) / 180);
  let facing = 0;
  let other = 0;
  for (let index = 0; index < n; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % n]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    // The edge's normal, against the across direction.
    const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
    if (Math.abs(normal.x * across.x + normal.y * across.y) >= limit) facing += length;
    else other += length;
  }
  const perimeter = facing + other;
  const middleAlong = (minAlong + maxAlong) / 2;
  const middleAcross = (minAcross + maxAcross) / 2;
  return {
    axis,
    middle: { x: cx + axis.x * middleAlong + across.x * middleAcross, y: cy + axis.y * middleAlong + across.y * middleAcross },
    length: maxAlong - minAlong,
    thickness: maxAcross - minAcross,
    facingAcross: perimeter > 0 ? facing / perimeter : 0,
    otherwise: other,
  };
}

/**
 * Is this outline a line drawn as an area: no thicker than a stroke, and all
 * long sides facing straight across it bar two ends no wider than it is thick?
 */
export function isFlat(points: readonly VectorPoint[], tolerance: number, widest: number, shortest = 0): Flatness | null {
  const measured = flatness(points, tolerance);
  if (!measured) return null;
  // Flat is thinner than half the widest stroke: a small rectangle as wide as
  // a stroke is still an area, and is left one.
  if (measured.thickness > Math.max(1, widest / 2)) return null;
  if (measured.length < measured.thickness * 3 || measured.length < shortest) return null;
  // The ends: two of them, each about as wide as the shape is thick.
  if (measured.otherwise > measured.thickness * 2.5 + 1) return null;
  return measured;
}

/** Polygon area, by the shoelace. */
function areaOf(points: readonly VectorPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

/**
 * Replace every flat polygon with a line of its color, running down its middle
 * and as wide as it is on average. A polygon with holes is never flat.
 */
export function flatShapesToLines(
  image: VectorImage,
  tolerance: number,
  widest: number,
  makeId: (prefix: string) => string,
  shortest = 0,
): { image: VectorImage; flattened: number } {
  if (tolerance <= 0) return { image, flattened: 0 };
  let flattened = 0;
  const shapes: VectorShape[] = image.shapes.map((shape) => {
    if (shape.kind !== 'polygon' || holesOf(shape).length > 0) return shape;
    const flat = isFlat(shape.points, tolerance, widest, shortest);
    if (!flat) return shape;
    flattened += 1;
    const half = flat.length / 2;
    const round = (value: number) => Math.round(value * 100) / 100;
    const line: VectorLine = {
      id: makeId('line'),
      kind: 'line',
      color: shape.color,
      width: round(Math.max(1, areaOf(shape.points) / Math.max(1e-6, flat.length))),
      points: [
        { x: round(flat.middle.x - flat.axis.x * half), y: round(flat.middle.y - flat.axis.y * half) },
        { x: round(flat.middle.x + flat.axis.x * half), y: round(flat.middle.y + flat.axis.y * half) },
      ],
      curved: false,
      closed: false,
    };
    return line;
  });
  // Areas first, strokes over them, as a decomposition draws them.
  const ordered = [...shapes.filter((shape) => shape.kind === 'polygon'), ...shapes.filter((shape) => shape.kind === 'line')];
  return { image: { ...image, shapes: ordered }, flattened };
}

/* ------------------------------------------------------------------ *
 * Shallow corners are curves
 * ------------------------------------------------------------------ */

/**
 * Make every node that turns less than `angle` degrees smooth, and leave every
 * sharper one a corner — so an outline traced as short straight steps round a
 * cheek becomes one curve, and the corner of a mouth stays a corner.
 *
 * A node is smooth only if it is shallow in every shape that has it, and never
 * where more than two boundaries meet or a line ends: the curve through a node
 * is worked out from its neighbours, and a node with three sets of neighbours
 * would bend each shape's boundary a different way and open a gap between them.
 */
export function smoothShallowNodes(image: VectorImage, angle: number, amount = 1): { image: VectorImage; smoothed: number } {
  if (angle <= 0) return { image, smoothed: 0 };
  const neighbours = new Map<string, Set<string>>();
  const sharp = new Set<string>();
  const shallow = new Set<string>();
  const visit = (points: readonly VectorPoint[], closed: boolean) => {
    const n = points.length;
    points.forEach((point, index) => {
      const key = pointKey(point);
      const around = neighbours.get(key) ?? new Set<string>();
      if (closed || index > 0) around.add(pointKey(points[(index - 1 + n) % n]!));
      if (closed || index < n - 1) around.add(pointKey(points[(index + 1) % n]!));
      neighbours.set(key, around);
      if (!closed && (index === 0 || index === n - 1)) sharp.add(key);
      else if (nodeTurn(points, index, closed) < angle) shallow.add(key);
      else sharp.add(key);
    });
  };
  for (const shape of image.shapes) {
    const closed = shape.kind === 'polygon' || shape.closed;
    visit(shape.points, closed);
    for (const hole of holesOf(shape)) visit(hole, true);
  }
  const smooth = new Set([...shallow].filter((key) => !sharp.has(key) && (neighbours.get(key)?.size ?? 0) <= 2));
  if (smooth.size === 0) return { image, smoothed: 0 };
  return {
    image: changeNodes(image, (point, key) => (smooth.has(key) ? { ...point, s: amount } : point)),
    smoothed: smooth.size,
  };
}

/* ------------------------------------------------------------------ *
 * Brushing and handles, for the vector editor
 * ------------------------------------------------------------------ */

interface Ring {
  points: VectorPoint[];
  closed: boolean;
  /** The fewest nodes it may be left with. */
  fewest: number;
}

function ringsOf(shape: VectorShape): Ring[] {
  const closed = shape.kind === 'polygon' || shape.closed;
  return [
    { points: shape.points, closed, fewest: closed ? 3 : 2 },
    ...holesOf(shape).map((hole) => ({ points: hole, closed: true, fewest: 3 })),
  ];
}

/** The nodes of one shape within `radius` of a point, by key. */
export function shapeNodesNear(shape: VectorShape, point: VectorPoint, radius: number): string[] {
  const out: string[] = [];
  for (const ring of ringsOf(shape)) {
    for (const node of ring.points) {
      if (Math.hypot(node.x - point.x, node.y - point.y) <= radius) out.push(pointKey(node));
    }
  }
  return out;
}

/**
 * Smooth a shape by averaging its brushed nodes: each run of brushed nodes
 * along its outline is taken `window` at a time, and each group becomes one
 * node where they were on average. The rest of the group is deleted.
 *
 * The group's nodes all move to the same place in every shape that shares
 * them, so a neighbour's boundary follows and the two still meet. An open
 * line's ends stay where they are, and no outline is left with too few nodes
 * to be a shape.
 */
export function averageNodeRuns(
  image: VectorImage,
  shapeId: string,
  keys: ReadonlySet<string>,
  window: number,
): { image: VectorImage; removed: number } {
  const shape = shapeById(image, shapeId);
  const size = Math.round(window);
  if (!shape || size < 2 || keys.size === 0) return { image, removed: 0 };
  const replace = new Map<string, VectorPoint>();
  let removed = 0;
  for (const ring of ringsOf(shape)) {
    const n = ring.points.length;
    const brushed = ring.points.map(
      (point, index) => keys.has(pointKey(point)) && (ring.closed || (index > 0 && index < n - 1)),
    );
    // Walk a loop from a node outside the brush, so a run is never cut in two
    // where the loop happens to start.
    let start = ring.closed ? brushed.findIndex((inside) => !inside) : 0;
    if (start < 0) start = 0;
    const runs: number[][] = [];
    let run: number[] = [];
    for (let step = 0; step < n; step += 1) {
      const index = (start + step) % n;
      if (brushed[index]) run.push(index);
      else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
    let budget = n - ring.fewest;
    for (const whole of runs) {
      for (let at = 0; at < whole.length && budget > 0; at += size) {
        let group = whole.slice(at, at + size);
        if (group.length - 1 > budget) group = group.slice(0, budget + 1);
        if (group.length < 2) continue;
        budget -= group.length - 1;
        removed += group.length - 1;
        const nodes = group.map((index) => ring.points[index]!);
        const middle = nodes[Math.floor(nodes.length / 2)]!;
        const round = (value: number) => Math.round(value * 100) / 100;
        const average: VectorPoint = {
          x: round(nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length),
          y: round(nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length),
          ...(middle.s ? { s: middle.s } : {}),
          ...(middle.a ? { a: middle.a } : {}),
        };
        for (const node of nodes) {
          const key = pointKey(node);
          if (!replace.has(key)) replace.set(key, average);
        }
      }
    }
  }
  if (replace.size === 0) return { image, removed: 0 };
  return { image: changeNodes(image, (point, key) => replace.get(key) ?? point), removed };
}

/** Curve the given nodes by `amount` (0 makes them corners), in every shape that has them. */
export function curveNodes(image: VectorImage, keys: ReadonlySet<string>, amount: number): VectorImage {
  if (keys.size === 0) return image;
  const s = Math.round(Math.max(0, Math.min(2, amount)) * 1000) / 1000;
  return changeNodes(image, (point, key) => {
    if (!keys.has(key)) return point;
    const { s: _old, ...rest } = point;
    return s > 0 ? { ...rest, s } : rest;
  });
}

/** Where a node's two curve handles are, and what they are measured against. */
export interface NodeHandles {
  key: string;
  at: VectorPoint;
  shapeId: string;
  /** The direction the curve runs through the node with no turn, and with its turn. */
  straight: VectorPoint;
  tangent: VectorPoint;
  /** A handle at curve 1: a third of the segment ahead, and of the one behind. */
  ahead: number;
  behind: number;
  s: number;
  a: number;
}

/**
 * A node's handles, measured in the first shape that has it (`prefer` first).
 * A node is the same in every shape that shares it, so any of them will do.
 */
export function nodeHandles(image: VectorImage, key: string, prefer?: string): NodeHandles | null {
  const shapes = [...image.shapes].sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer));
  for (const shape of shapes) {
    for (const ring of ringsOf(shape)) {
      const index = ring.points.findIndex((point) => pointKey(point) === key);
      if (index < 0) continue;
      const n = ring.points.length;
      const at = ring.points[index]!;
      const plain = ring.points.map((point, k) => (k === index ? { x: point.x, y: point.y } : point));
      const next = ring.closed || index < n - 1 ? ring.points[(index + 1) % n]! : null;
      const previous = ring.closed || index > 0 ? ring.points[(index - 1 + n) % n]! : null;
      return {
        key,
        at,
        shapeId: shape.id,
        straight: nodeTangent(plain, index, ring.closed),
        tangent: nodeTangent(ring.points, index, ring.closed),
        ahead: next ? Math.hypot(next.x - at.x, next.y - at.y) / 3 : 0,
        behind: previous ? Math.hypot(at.x - previous.x, at.y - previous.y) / 3 : 0,
        s: at.s ?? 0,
        a: at.a ?? 0,
      };
    }
  }
  return null;
}

/** Where a handle is drawn: at the node's curve, or at `least` to be found at all. */
export function handlePosition(handles: NodeHandles, which: 'ahead' | 'behind', least = 0): VectorPoint {
  const reach = (which === 'ahead' ? handles.ahead : -handles.behind) * Math.max(handles.s, least);
  return { x: handles.at.x + handles.tangent.x * reach, y: handles.at.y + handles.tangent.y * reach };
}

/**
 * The curve and turn that put a handle at `to`: how far out it is against a
 * third of its segment, and how far it points away from the straight-through
 * direction. The handle behind is the one ahead mirrored through the node.
 */
export function curveFromHandle(handles: NodeHandles, which: 'ahead' | 'behind', to: VectorPoint): { s: number; a: number } {
  let dx = to.x - handles.at.x;
  let dy = to.y - handles.at.y;
  if (which === 'behind') {
    dx = -dx;
    dy = -dy;
  }
  const reach = which === 'ahead' ? handles.ahead : handles.behind;
  const length = Math.hypot(dx, dy);
  if (reach < 1e-9 || length < 1e-9) return { s: 0, a: handles.a };
  const { x, y } = handles.straight;
  const a = (Math.atan2(x * dy - y * dx, x * dx + y * dy) * 180) / Math.PI;
  return { s: Math.round(Math.min(2, length / reach) * 1000) / 1000, a: Math.round(a * 10) / 10 };
}
