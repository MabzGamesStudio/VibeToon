import type { ArtifactKind } from './artifacts';

/** Top-level grouping used by the palette and the graph's colour coding. */
export type FlowCategory =
  | 'brainstorm'
  | 'story'
  | 'world'
  | 'animation'
  | 'art'
  | 'music'
  | 'sound'
  | 'production';

export const FLOW_CATEGORIES: readonly FlowCategory[] = [
  'brainstorm',
  'story',
  'world',
  'animation',
  'art',
  'music',
  'sound',
  'production',
];

export const FLOW_CATEGORY_LABEL: Record<FlowCategory, string> = {
  brainstorm: 'Brainstorm',
  story: 'Story',
  world: 'World',
  animation: 'Animation',
  art: 'Art',
  music: 'Music',
  sound: 'Sound',
  production: 'Production',
};

/** Which focused editor a flow opens when you double-click its node. */
export type EditorId = 'dialog' | 'storyboard' | 'brief';

/** How finished a flow kind is. `brief` flows are real but use the generic editor. */
export type FlowMaturity = 'editor' | 'brief';

export interface PortSpec {
  /** Stable id, referenced by connections. */
  id: string;
  label: string;
  /** Artifact kinds this port can carry. An input accepts any listed kind. */
  kinds: ArtifactKind[];
  /** File name a generator writes for an output port, e.g. `dialog.txt`. */
  fileName?: string;
  description: string;
  /** Inputs only: generation is blocked with a warning when a required input is missing. */
  required?: boolean;
  /** Inputs only: the port accepts more than one incoming connection. */
  multiple?: boolean;
}

/**
 * A field on the generic ("brief") editor. Flow kinds that do not have a
 * bespoke editor yet are still usable: they collect structured text that their
 * generator turns into a markdown brief for downstream flows.
 */
export interface BriefFieldSpec {
  id: string;
  label: string;
  hint: string;
  /** `line` renders a single-line input, `text` a textarea, `list` one item per line. */
  input: 'line' | 'text' | 'list';
}

export interface FlowKindDef {
  kind: string;
  category: FlowCategory;
  label: string;
  /** One line shown in the palette and on the node card. */
  summary: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  editor: EditorId;
  maturity: FlowMaturity;
  /** Fields for the brief editor; ignored by flows with a bespoke editor. */
  fields?: BriefFieldSpec[];
  /** Seed text for the rules box when this flow is the source of a new connection. */
  defaultOutgoingRules?: string;
}
