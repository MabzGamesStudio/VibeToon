import type { Vec2 } from '@vibetoon/shared';

/** Horizontal cubic so edges leave an output to the right and enter an input from the left. */
export function edgePath(from: Vec2, to: Vec2): string {
  const span = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + span} ${from.y}, ${to.x - span} ${to.y}, ${to.x} ${to.y}`;
}

export function edgeMidpoint(from: Vec2, to: Vec2): Vec2 {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

export interface ViewTransform {
  pan: Vec2;
  zoom: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(point: Vec2, view: ViewTransform): Vec2 {
  return { x: (point.x - view.pan.x) / view.zoom, y: (point.y - view.pan.y) / view.zoom };
}

/** Keep the point under the cursor fixed while zooming. */
export function zoomAround(view: ViewTransform, anchor: Vec2, nextZoom: number): ViewTransform {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(anchor, view);
  return {
    zoom,
    pan: { x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom },
  };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Vec2[], padding = 80): Bounds | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
  };
}

/** Fit the given bounds into a viewport of `size`. */
export function fitView(bounds: Bounds, size: { width: number; height: number }): ViewTransform {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clampZoom(Math.min(size.width / width, size.height / height, 1.2));
  return {
    zoom,
    pan: {
      x: (size.width - width * zoom) / 2 - bounds.minX * zoom,
      y: (size.height - height * zoom) / 2 - bounds.minY * zoom,
    },
  };
}
