/**
 * Finding what is near something, without looking at everything.
 *
 * Cutting a region into convex pieces asks the same two questions thousands of
 * times — is any corner inside this triangle, does anything cross this cut — and
 * answering each by walking the whole outline made the cut cubic in the outline's
 * length. A photographed region has an outline hundreds of points long with holes
 * bridged into it, and one of 200 × 200 pixels took a minute. An index answers
 * each question from the few things nearby.
 *
 * A **quadtree** — the flat cousin of an octree — splitting a cell into four
 * where things crowd, so a detailed corner of a picture and an empty stretch are
 * both searched quickly. A flat grid of equal cells was measured against it and
 * came out the same speed on whole pictures and slower on the longest outlines
 * (3.8 s against 3.1 s for a 2,000-corner one), and it needs its cell size tuned
 * where the tree does not; see `docs/VECTOR-FLOWS.md`.
 */
export interface SpatialIndex {
  /** Put something in, by its bounding box. An id already in is moved. */
  insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void;
  remove(id: number): void;
  /** Every id whose box overlaps this one — each once, in no particular order. */
  query(minX: number, minY: number, maxX: number, maxY: number, visit: (id: number) => void): void;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/* ------------------------------------------------------------------ *
 * Quadtree
 * ------------------------------------------------------------------ */

interface QuadNode {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  depth: number;
  /** Things that fit no single child, or all of them while this is a leaf. */
  items: number[];
  children: QuadNode[] | null;
}

/**
 * A region quadtree. A thing sits in the smallest cell that holds its whole box,
 * so a long edge stays near the top and a corner goes all the way down; a leaf
 * splits into four once it holds more than `capacity` things.
 */
export class QuadIndex implements SpatialIndex {
  private readonly root: QuadNode;
  private readonly boxes = new Map<number, [number, number, number, number]>();
  private readonly home = new Map<number, QuadNode>();

  constructor(
    bounds: Bounds,
    private readonly capacity = 8,
    private readonly maxDepth = 12,
  ) {
    this.root = { ...bounds, depth: 0, items: [], children: null };
  }

  insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    if (this.boxes.has(id)) this.remove(id);
    this.boxes.set(id, [minX, minY, maxX, maxY]);
    this.place(this.root, id);
  }

  private place(start: QuadNode, id: number): void {
    const box = this.boxes.get(id)!;
    let node = start;
    for (;;) {
      if (!node.children) {
        node.items.push(id);
        this.home.set(id, node);
        if (node.items.length > this.capacity && node.depth < this.maxDepth) this.split(node);
        return;
      }
      const child = node.children.find(
        (candidate) =>
          box[0] >= candidate.minX && box[2] <= candidate.maxX && box[1] >= candidate.minY && box[3] <= candidate.maxY,
      );
      if (!child) {
        node.items.push(id);
        this.home.set(id, node);
        return;
      }
      node = child;
    }
  }

  private split(node: QuadNode): void {
    const midX = (node.minX + node.maxX) / 2;
    const midY = (node.minY + node.maxY) / 2;
    const depth = node.depth + 1;
    node.children = [
      { minX: node.minX, minY: node.minY, maxX: midX, maxY: midY, depth, items: [], children: null },
      { minX: midX, minY: node.minY, maxX: node.maxX, maxY: midY, depth, items: [], children: null },
      { minX: node.minX, minY: midY, maxX: midX, maxY: node.maxY, depth, items: [], children: null },
      { minX: midX, minY: midY, maxX: node.maxX, maxY: node.maxY, depth, items: [], children: null },
    ];
    const items = node.items;
    node.items = [];
    for (const id of items) this.place(node, id);
  }

  remove(id: number): void {
    const node = this.home.get(id);
    if (!node) return;
    const at = node.items.indexOf(id);
    if (at >= 0) {
      node.items[at] = node.items[node.items.length - 1]!;
      node.items.pop();
    }
    this.home.delete(id);
    this.boxes.delete(id);
  }

  query(minX: number, minY: number, maxX: number, maxY: number, visit: (id: number) => void): void {
    const stack: QuadNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.minX > maxX || node.maxX < minX || node.minY > maxY || node.maxY < minY) continue;
      for (const id of node.items) {
        const box = this.boxes.get(id)!;
        if (box[0] > maxX || box[2] < minX || box[1] > maxY || box[3] < minY) continue;
        visit(id);
      }
      if (node.children) stack.push(...node.children);
    }
  }
}
