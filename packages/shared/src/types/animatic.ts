/**
 * The animatic flow's own state. It does not own any panels — the board does —
 * so all it keeps is what it changes about the cut: how long a shot is held,
 * whether it is in at all, and what the runtime is aiming for.
 */
export interface AnimaticShotOverride {
  /** Held for this long instead of what the board said. */
  durationSec?: number;
  /** Cut out of the animatic without touching the board. */
  skip?: boolean;
  /** Why it was changed, carried into the cut list. */
  note?: string;
}

export interface AnimaticFlowData {
  editor: 'animatic';
  /** Keyed by the panel id from the upstream storyboard. */
  overrides: Record<string, AnimaticShotOverride>;
  /** Runtime the cut is aiming for, in seconds. 0 means no target. */
  targetSeconds: number;
  /** Free notes on pacing, written into the cut list. */
  pacing: string;
}

/** One shot in the cut, after the animatic's adjustments. */
export interface AnimaticClip {
  panelId: string;
  /** Position in the cut. */
  index: number;
  /** Position on the board it came from. */
  boardIndex: number;
  scene: string;
  shot: string;
  action: string;
  dialog: string;
  sound: string;
  /** Project-relative path of the panel image, when the board has rasterised one. */
  image: string | null;
  boardDurationSec: number;
  durationSec: number;
  startSec: number;
  endSec: number;
  startFrame: number;
  frames: number;
  /** The animatic changed this shot's length. */
  adjusted: boolean;
  note: string;
}

export interface AnimaticCut {
  fps: number;
  width: number;
  height: number;
  clips: AnimaticClip[];
  /** Shots that are in the board but cut out of the animatic. */
  skipped: Array<{ panelId: string; boardIndex: number; shot: string; dialog: string }>;
  durationSec: number;
  /** What the board alone would have run to. */
  boardDurationSec: number;
  targetSeconds: number;
  /** Positive when the cut is longer than the target. */
  offTargetSec: number;
  adjustedCount: number;
}
