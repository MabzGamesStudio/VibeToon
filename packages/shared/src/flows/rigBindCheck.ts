import { bindNodes, imageOfBinding, nodeKey, nodesOf, type BindFlowData } from './rigBind';
import { allPoints, holesOf, type VectorPoint, type VectorShape } from './vector';

/**
 * Checking a binding: the nodes nobody has put in a part, and the nodes two
 * parts both lay claim to.
 *
 * A node follows one bone. But it is also a point of every shape drawn through
 * it, and each of those shapes is mostly in one part or another — so a node on
 * the boundary between an arm and a chest is in the arm as far as the arm
 * polygon is concerned and in the chest as far as the chest's is. Wherever the
 * node goes, the other shape's outline is pulled with it when the rig moves.
 * That is sometimes what is wanted (a sleeve stretching across a shoulder) and
 * sometimes a mistake, so it is found and shown rather than fixed by guessing.
 */

/** Nodes that follow nothing, by key. */
export function unboundNodeKeys(data: BindFlowData): string[] {
  return nodesOf(imageOfBinding(data))
    .filter((node) => !(node.key in data.nodes))
    .map((node) => node.key);
}

/** How many of a shape's nodes each bone carries. */
function countsOf(data: BindFlowData, shape: VectorShape): Map<string, number> {
  const counts = new Map<string, number>();
  for (const point of allPoints(shape)) {
    const bone = data.nodes[nodeKey(point)];
    if (bone) counts.set(bone, (counts.get(bone) ?? 0) + 1);
  }
  return counts;
}

/** The part a shape is in: the bone carrying most of its nodes, or none if none is bound. */
export function partOfShape(data: BindFlowData, shape: VectorShape): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [bone, count] of countsOf(data, shape)) {
    if (count > most) {
      best = bone;
      most = count;
    }
  }
  return best;
}

/** Every shape each node is a point of, by node key. */
function shapesByNode(data: BindFlowData): Map<string, VectorShape[]> {
  const out = new Map<string, VectorShape[]>();
  for (const shape of imageOfBinding(data).shapes) {
    for (const key of new Set(allPoints(shape).map(nodeKey))) {
      const list = out.get(key) ?? [];
      list.push(shape);
      out.set(key, list);
    }
  }
  return out;
}

/**
 * Put each unbound node in the part of the shapes it is drawn through — the
 * part most of their nodes are in. A node in shapes that have no part yet is
 * left for you.
 */
export function bindUnboundByShape(data: BindFlowData): { data: BindFlowData; bound: number } {
  const byNode = shapesByNode(data);
  const byBone = new Map<string, string[]>();
  for (const key of unboundNodeKeys(data)) {
    const votes = new Map<string, number>();
    for (const shape of byNode.get(key) ?? []) {
      for (const [bone, count] of countsOf(data, shape)) votes.set(bone, (votes.get(bone) ?? 0) + count);
    }
    let best: string | null = null;
    let most = 0;
    for (const [bone, count] of votes) {
      if (count > most) {
        best = bone;
        most = count;
      }
    }
    if (best) byBone.set(best, [...(byBone.get(best) ?? []), key]);
  }
  let next = data;
  let bound = 0;
  for (const [bone, keys] of byBone) {
    next = bindNodes(next, keys, bone);
    bound += keys.length;
  }
  // One edit, however many parts it touched.
  if (bound > 0) next = { ...next, edits: data.edits + 1, selected: [...byBone.values()].flat() };
  return { data: next, bound };
}

/**
 * A set of nodes claimed by more than one part.
 *
 * - `shared`: nodes on the boundary between shapes that are in different parts.
 *   The node follows one bone, and the other part's shape is pulled along.
 * - `near`: nodes so close together they look like one, bound to different
 *   bones. They tear apart the moment the rig moves.
 *
 * Found nodes are grouped by which parts are involved, so a shoulder with thirty
 * boundary nodes is one thing to decide, not thirty.
 */
export interface SplitGroup {
  id: string;
  kind: 'shared' | 'near';
  /** The parts involved, the one carrying most of these nodes first. */
  bones: string[];
  keys: string[];
  /** Where they are, on average, in the drawing's own coordinates. */
  at: VectorPoint;
}

function keyPoint(key: string): VectorPoint {
  const [x, y] = key.split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

function groupOf(kind: SplitGroup['kind'], parts: Set<string>, keys: string[], data: BindFlowData): SplitGroup {
  const carried = new Map<string, number>();
  for (const key of keys) {
    const bone = data.nodes[key];
    if (bone) carried.set(bone, (carried.get(bone) ?? 0) + 1);
  }
  const bones = [...parts].sort((a, b) => (carried.get(b) ?? 0) - (carried.get(a) ?? 0) || a.localeCompare(b));
  const points = keys.map(keyPoint);
  return {
    id: `${kind}:${[...parts].sort().join('+')}`,
    kind,
    bones,
    keys,
    at: {
      x: points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length),
      y: points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length),
    },
  };
}

/** Find the nodes claimed by more than one part. `near` is how close, in drawing pixels, counts as the same place. */
export function splitNodes(data: BindFlowData, near = 0.75): SplitGroup[] {
  const groups = new Map<string, { kind: SplitGroup['kind']; parts: Set<string>; keys: Set<string> }>();
  const add = (kind: SplitGroup['kind'], parts: Set<string>, keys: string[]) => {
    const id = `${kind}:${[...parts].sort().join('+')}`;
    const group = groups.get(id) ?? { kind, parts, keys: new Set<string>() };
    for (const key of keys) group.keys.add(key);
    groups.set(id, group);
  };

  // Shared boundaries.
  const parts = new Map<VectorShape, string | null>();
  for (const [key, shapes] of shapesByNode(data)) {
    if (shapes.length < 2) continue;
    const claimed = new Set<string>();
    for (const shape of shapes) {
      if (!parts.has(shape)) parts.set(shape, partOfShape(data, shape));
      const part = parts.get(shape);
      if (part) claimed.add(part);
    }
    if (claimed.size > 1) add('shared', claimed, [key]);
  }

  // Nodes as good as on top of each other, bound apart.
  if (near > 0) {
    const cell = near;
    const grid = new Map<string, Array<{ key: string; x: number; y: number; bone: string }>>();
    for (const [key, bone] of Object.entries(data.nodes)) {
      const { x, y } = keyPoint(key);
      const at = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      grid.set(at, [...(grid.get(at) ?? []), { key, x, y, bone }]);
    }
    const seen = new Set<string>();
    const apart = new Set(data.apart ?? []);
    for (const key of Object.keys(data.nodes)) {
      if (seen.has(key)) continue;
      const { x, y } = keyPoint(key);
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const close: Array<{ key: string; bone: string }> = [];
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const other of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (Math.hypot(other.x - x, other.y - y) <= near) close.push(other);
          }
        }
      }
      const bones = new Set(close.map((other) => other.bone));
      if (bones.size < 2) continue;
      // Separated on purpose: meant to come apart.
      if (close.every((other) => apart.has(other.key))) continue;
      for (const other of close) seen.add(other.key);
      add('near', bones, close.map((other) => other.key));
    }
  }

  return [...groups.values()]
    .map((group) => groupOf(group.kind, group.parts, [...group.keys], data))
    .sort((a, b) => b.keys.length - a.keys.length || a.id.localeCompare(b.id));
}

/** Settle a group one way: every node in it follows this bone. */
export function putInPart(data: BindFlowData, group: SplitGroup, boneId: string): BindFlowData {
  return bindNodes(data, group.keys, boneId);
}

/**
 * Settle a shared group by separating it: each part's shapes get their own copy
 * of each node, a hair's breadth apart and bound to that part, so each part's
 * outline follows its own bone. The node itself stays with the bone it had (or
 * the first part, if it had none).
 *
 * This changes the drawing — its shapes no longer share those points — and so
 * the parts can open a gap between them when the rig moves. That is what
 * separating means; putting them in one part is the way to keep them joined.
 */
export function separateNodes(data: BindFlowData, group: SplitGroup): BindFlowData {
  const image = imageOfBinding(data);
  if (group.kind !== 'shared' || image.shapes.length === 0) return data;
  const partOf = new Map(image.shapes.map((shape) => [shape, partOfShape(data, shape)] as const));
  const nodes = { ...data.nodes };
  /** For each shape, the nodes it is to be given a copy of: old key → new point. */
  const moves = new Map<string, Map<string, VectorPoint>>();
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const taken = new Set(nodesOf(image).map((node) => node.key));
  const apart = new Set(data.apart ?? []);

  for (const key of group.keys) {
    const at = keyPoint(key);
    const holders = image.shapes.filter((shape) => allPoints(shape).some((point) => nodeKey(point) === key));
    const byPart = new Map<string, VectorShape[]>();
    for (const shape of holders) {
      const part = partOf.get(shape);
      if (part) byPart.set(part, [...(byPart.get(part) ?? []), shape]);
    }
    const keeper = nodes[key] && byPart.has(nodes[key]!) ? nodes[key]! : [...byPart.keys()][0];
    if (!keeper) continue;
    nodes[key] = keeper;
    for (const [part, shapes] of byPart) {
      if (part === keeper) continue;
      // A hair's breadth towards the middle of that part's shapes, so the copy
      // sits on its own side of the boundary.
      let mx = 0;
      let my = 0;
      let count = 0;
      for (const shape of shapes) {
        for (const point of allPoints(shape)) {
          mx += point.x;
          my += point.y;
          count += 1;
        }
      }
      let dx = mx / Math.max(1, count) - at.x;
      let dy = my / Math.max(1, count) - at.y;
      const length = Math.hypot(dx, dy) || 1;
      dx /= length;
      dy /= length;
      let step = 0.02;
      let copy = { x: round(at.x + dx * step), y: round(at.y + dy * step) };
      while (taken.has(nodeKey(copy)) && step < 1) {
        step += 0.02;
        copy = { x: round(at.x + dx * step), y: round(at.y + dy * step) };
      }
      taken.add(nodeKey(copy));
      nodes[nodeKey(copy)] = part;
      apart.add(key);
      apart.add(nodeKey(copy));
      for (const shape of shapes) {
        const list = moves.get(shape.id) ?? new Map<string, VectorPoint>();
        list.set(key, copy);
        moves.set(shape.id, list);
      }
    }
  }
  if (moves.size === 0) return data;

  const move = (points: VectorPoint[], list: Map<string, VectorPoint>) =>
    points.map((point) => {
      const to = list.get(nodeKey(point));
      return to ? { ...point, x: to.x, y: to.y } : point;
    });
  const shapes = image.shapes.map((shape) => {
    const list = moves.get(shape.id);
    if (!list) return shape;
    const points = move(shape.points, list);
    if (shape.kind === 'polygon') {
      const holes = holesOf(shape);
      return holes.length > 0 ? { ...shape, points, holes: holes.map((hole) => move(hole, list)) } : { ...shape, points };
    }
    return { ...shape, points };
  });
  return { ...data, image: { ...image, shapes }, nodes, apart: [...apart], edits: data.edits + 1 };
}
