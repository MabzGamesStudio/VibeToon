import type { ArtifactRef } from './artifacts';
import type { AnimaticFlowData } from './animatic';
import type { DesignFlowData } from './design';
import type { CorpusFlowData } from '../flows/corpusFlow';
import type { DictionaryFlowData } from '../flows/dictionary';
import type { GrammarFlowData } from '../flows/grammar';
import type { LexiconFlowData } from '../flows/lexicon';
import type { CutoutFlowData } from '../flows/cutout';
import type { PoseFlowData } from '../flows/pose';
import type { BindFlowData } from '../flows/rigBind';
import type { VectorEditFlowData, VectorizeFlowData } from '../flows/vectorEdit';
import type { ImageFlowData } from '../flows/image';
import type { PaletteFlowData } from '../flows/palette';
import type { PaletteFilterFlowData } from '../flows/paletteFilter';
import type { RigFlowData } from '../flows/rig';
import type { TextFlowData } from './text';

export interface Vec2 {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ *
 * Flow data: the state a flow's editor owns.
 * ------------------------------------------------------------------ */

export interface DialogCharacter {
  id: string;
  name: string;
  /** Short personality note; the full profile lives in a character flow. */
  personality: string;
  /** Casting / delivery note that the voice and lip-sync flows read. */
  voice: string;
  color: string;
}

export interface DialogSet {
  id: string;
  name: string;
  description: string;
  timeOfDay: string;
}

/**
 * A beat is one line of the script. Dialog, action, sound cues and camera
 * directions all live in the same ordered list so the editor reads like a
 * script and the storyboard can walk it in order.
 */
export type BeatType = 'line' | 'action' | 'sound' | 'direction';

export interface DialogBeat {
  id: string;
  type: BeatType;
  /** Set for `line` beats. */
  characterId?: string;
  /** Delivery note shown in parentheses under the character name. */
  parenthetical?: string;
  text: string;
  /** Sound cue carried alongside a beat, e.g. `door slams`. */
  sound?: string;
  /** Estimated screen time; feeds panel durations and the animatic. */
  durationSec?: number;
}

export interface DialogScene {
  id: string;
  /** Scene heading, e.g. `INT. WORKSHOP - NIGHT`. */
  slug: string;
  setId?: string;
  summary: string;
  beats: DialogBeat[];
}

export interface DialogFlowData {
  editor: 'dialog';
  logline: string;
  characters: DialogCharacter[];
  sets: DialogSet[];
  scenes: DialogScene[];
}

export type ShotSize =
  | 'EWS'
  | 'WS'
  | 'FS'
  | 'MS'
  | 'MCU'
  | 'CU'
  | 'ECU'
  | 'OTS'
  | 'POV'
  | 'INSERT';

export const SHOT_SIZES: readonly ShotSize[] = [
  'EWS',
  'WS',
  'FS',
  'MS',
  'MCU',
  'CU',
  'ECU',
  'OTS',
  'POV',
  'INSERT',
];

export const SHOT_SIZE_LABEL: Record<ShotSize, string> = {
  EWS: 'Extreme wide',
  WS: 'Wide',
  FS: 'Full',
  MS: 'Medium',
  MCU: 'Medium close-up',
  CU: 'Close-up',
  ECU: 'Extreme close-up',
  OTS: 'Over the shoulder',
  POV: 'Point of view',
  INSERT: 'Insert',
};

/** One pointer stroke of a panel sketch, stored as a flat [x,y,x,y,...] list. */
export interface Stroke {
  points: number[];
  width: number;
  color: string;
  /** Drawn with the eraser, i.e. composited as destination-out. */
  erase?: boolean;
}

export interface Sketch {
  /** Design-space size the strokes were drawn against. */
  width: number;
  height: number;
  strokes: Stroke[];
  updatedAt: string;
}

export interface StoryboardPanel {
  id: string;
  /** Scene the panel was derived from, when it came through a connection. */
  sourceSceneId?: string;
  /** Dialog beats this panel covers; used to re-sync without losing sketches. */
  sourceBeatIds: string[];
  shot: ShotSize;
  camera: string;
  action: string;
  dialog: string;
  sound: string;
  durationSec: number;
  notes: string;
  sketch: Sketch | null;
  /**
   * Hand-authored panel: a re-sync from upstream leaves its text alone.
   * Set automatically when you edit a derived field.
   */
  pinned: boolean;
}

export interface StoryboardScene {
  id: string;
  sourceSceneId?: string;
  title: string;
  setName: string;
  panels: StoryboardPanel[];
}

export interface StoryboardFlowData {
  editor: 'storyboard';
  scenes: StoryboardScene[];
  /** Signature of the upstream data at the last accepted sync. */
  syncSignature?: string;
  syncedAt?: string;
}

/** Data for flow kinds that use the generic brief editor. */
export interface BriefFlowData {
  editor: 'brief';
  fields: Record<string, string>;
}

export type FlowData =
  | DialogFlowData
  | StoryboardFlowData
  | BriefFlowData
  | TextFlowData
  | AnimaticFlowData
  | DesignFlowData
  | LexiconFlowData
  | GrammarFlowData
  | CorpusFlowData
  | DictionaryFlowData
  | PaletteFlowData
  | PaletteFilterFlowData
  | RigFlowData
  | ImageFlowData
  | CutoutFlowData
  | VectorizeFlowData
  | VectorEditFlowData
  | BindFlowData
  | PoseFlowData;

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

export type FlowStatus = 'empty' | 'ready' | 'stale' | 'error';

export interface FlowNode {
  id: string;
  kind: string;
  name: string;
  position: Vec2;
  /** Free notes shown on the node and passed to generators as guidance. */
  notes: string;
  data: FlowData;
  outputs: ArtifactRef[];
  /** Set by the last generate run; `signature` covers inputs + own data. */
  lastRun?: {
    at: string;
    signature: string;
    log: string[];
    warnings?: string[];
    error?: string;
  };
}

export interface PortRef {
  nodeId: string;
  portId: string;
}

/**
 * How the downstream flow treats what arrives over a connection.
 * - `suggest`  upstream changes become a proposal you accept in the editor.
 * - `apply`    upstream changes flow in automatically when you generate.
 * - `reference` upstream is context only; it never rewrites downstream data.
 */
export type ConnectionMode = 'suggest' | 'apply' | 'reference';

export interface ConnectionSettings {
  enabled: boolean;
  mode: ConnectionMode;
  /** 0..1 — how strongly the guidance should push the downstream result. */
  weight: number;
  notes: string;
}

export interface Connection {
  id: string;
  from: PortRef;
  to: PortRef;
  /** Plain-text rules that describe how to read the upstream artifact. */
  rules: string;
  settings: ConnectionSettings;
}

export interface ProjectSettings {
  fps: number;
  width: number;
  height: number;
  /** Default panel/shot length used when a beat has no duration. */
  defaultShotSeconds: number;
  /** Project-wide style note, prepended to every generator's guidance. */
  styleNote: string;
}

export interface ProjectView {
  pan: Vec2;
  zoom: number;
}

export interface Project {
  schema: 1;
  id: string;
  name: string;
  /** Bumped on every accepted write; used for optimistic concurrency. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  nodes: FlowNode[];
  connections: Connection[];
  view: ProjectView;
}

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
  connectionCount: number;
}
