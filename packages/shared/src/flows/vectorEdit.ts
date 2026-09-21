import { DEFAULT_VECTORIZE_OPTIONS, type VectorizeOptions } from './vectorize';
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
export type VectorTool = 'select' | 'add' | 'cut' | 'erase';

export const VECTOR_TOOL_LABEL: Record<VectorTool, string> = {
  select: 'Move',
  add: 'Add point',
  cut: 'Cut',
  erase: 'Delete part',
};

export const VECTOR_TOOL_HINT: Record<VectorTool, string> = {
  select:
    'Drag a point to move it. Click a shape to select it, Delete removes the selection, and right-click deletes a single point.',
  add: 'Click a shape’s edge to put a new point there.',
  cut: 'Click twice across a shape to cut it in two. A line is cut where you click once.',
  erase: 'Click two points on a line to delete the run between them.',
};

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
