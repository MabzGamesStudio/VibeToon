import { DEFAULT_VECTORIZE_OPTIONS, type VectorizeOptions, type VectorizeReport } from './vectorize';
import { emptyVectorImage, type VectorImage } from './vector';

/**
 * The decomposition flow's own state.
 *
 * The picture is read in the editor, like every other image flow here, and what
 * is kept is the result rather than the pixels. So a run is instant, and a
 * changed picture upstream is stale rather than quietly described by an old
 * answer.
 */
export interface VectorizeFlowData {
  editor: 'vectorize';
  options: VectorizeOptions;
  /** What the last run found, or nothing if it has not been run. */
  result: VectorImage | null;
  /** How that run went, so the written report can say so without redoing it. */
  report?: VectorizeReport | null;
  /** The hash of the image it was found in. */
  imageHash?: string;
  readAt?: string;
}

export function emptyVectorizeFlowData(): VectorizeFlowData {
  return { editor: 'vectorize', options: { ...DEFAULT_VECTORIZE_OPTIONS }, result: null };
}

/** Is the stored decomposition still describing the picture that is wired in? */
export function vectorizeState(
  data: VectorizeFlowData,
  imageHash: string | undefined,
): 'none' | 'stale' | 'ready' {
  if (!data.result) return 'none';
  if (!imageHash || !data.imageHash) return 'ready';
  return data.imageHash === imageHash ? 'ready' : 'stale';
}

/* ------------------------------------------------------------------ */

/** What the editor is doing with a click. */
export type VectorTool = 'select' | 'add' | 'cut' | 'erase' | 'node' | 'curve' | 'smooth';

export const VECTOR_TOOLS: VectorTool[] = ['select', 'add', 'cut', 'erase', 'node', 'curve', 'smooth'];

export const VECTOR_TOOL_LABEL: Record<VectorTool, string> = {
  select: 'Move',
  add: 'Add point',
  cut: 'Cut',
  erase: 'Delete part',
  node: 'Delete node',
  curve: 'Curves',
  smooth: 'Smooth brush',
};

export const VECTOR_TOOL_HINT: Record<VectorTool, string> = {
  select:
    'Drag a point to move it. Click a shape to select it, Delete removes the selection, and right-click deletes a single point.',
  add: 'Click a shape’s edge to put a new point there.',
  cut: 'Click twice across a shape to cut it in two. A line is cut where you click once.',
  erase: 'Click two points on a line to delete the run between them.',
  node:
    'Click a node to delete just it. Every shape that shares it loses it too, so neighbours still meet; a shape left with too few nodes goes.',
  curve:
    'Click a node, then drag its handles or use the sliders: how far out a handle is sets how curved the node is, and which way it points turns the curve. A node with no curve is a sharp corner.',
  smooth:
    'Select a shape, then brush along its outline. Average merges the brushed nodes a few at a time into one; Curve makes them smooth Bézier nodes.',
};

/** What the smoothing brush does to the nodes it passes over. */
export type VectorBrushMode = 'average' | 'curve';

export interface VectorBrush {
  mode: VectorBrushMode;
  /** Its radius, in screen pixels, so it is the same size at any zoom. */
  size: number;
  /** Average: how many nodes in a row become one. */
  window: number;
  /** Curve: how curved the brushed nodes become. */
  amount: number;
}

export const DEFAULT_VECTOR_BRUSH: VectorBrush = { mode: 'average', size: 24, window: 3, amount: 1 };

export function brushOf(data: VectorEditFlowData): VectorBrush {
  return { ...DEFAULT_VECTOR_BRUSH, ...(data.brush ?? {}) };
}

/**
 * The vector editor's own state.
 *
 * The edited image lives here rather than being re-derived: the whole point of
 * the flow is that a decomposition is a starting guess and the edits are the
 * work. Losing them to a re-run upstream would make the flow pointless, so an
 * upstream change is reported and the edits are kept until you say otherwise.
 */
export interface VectorEditFlowData {
  editor: 'vectorEdit';
  /** Null until the upstream vector has been taken in. */
  image: VectorImage | null;
  selected: string[];
  /** The hash of the upstream file these edits were made against. */
  sourceHash?: string;
  /** How many edits have been made, so the flow can say whether it has done any. */
  edits: number;
  /** The smoothing brush's settings, kept with the flow. */
  brush?: VectorBrush;
}

export function emptyVectorEditFlowData(): VectorEditFlowData {
  return { editor: 'vectorEdit', image: null, selected: [], edits: 0 };
}

/** Has the upstream changed under the edits? */
export function editState(
  data: VectorEditFlowData,
  sourceHash: string | undefined,
): 'none' | 'stale' | 'ready' {
  if (!data.image) return 'none';
  if (!sourceHash || !data.sourceHash) return 'ready';
  return data.sourceHash === sourceHash ? 'ready' : 'stale';
}

/** Take the upstream image in, replacing whatever was being edited. */
export function adopt(
  data: VectorEditFlowData,
  image: VectorImage,
  sourceHash: string | undefined,
): VectorEditFlowData {
  return {
    ...data,
    image,
    selected: [],
    edits: 0,
    ...(sourceHash === undefined ? {} : { sourceHash }),
  };
}

export function imageOf(data: VectorEditFlowData): VectorImage {
  return data.image ?? emptyVectorImage();
}
