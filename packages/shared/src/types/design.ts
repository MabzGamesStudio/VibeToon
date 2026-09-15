import type { Sketch } from './project';

/**
 * A design flow's drawings. One plate is one sheet: the key image, a
 * three-quarter turn, a set of expressions. They are vector strokes like the
 * storyboard's panels, so they stay small in the project file and rasterise at
 * whatever size the frame needs.
 */
export interface DesignPlate {
  id: string;
  label: string;
  sketch: Sketch | null;
  note: string;
}

export interface DesignFlowData {
  editor: 'design';
  /** Same shape as a brief, so the written spec is generated the same way. */
  fields: Record<string, string>;
  plates: DesignPlate[];
}
