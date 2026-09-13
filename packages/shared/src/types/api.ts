import type { ArtifactKind, ArtifactRef } from './artifacts';
import type { FlowCategory, FlowKindDef } from './flow';
import type { Project } from './project';
import type { RuleDirectiveSpec } from '../rules/parseRules';
import type { SyncPlan } from '../flows/storyboard';

/** What one generate run did, as reported back to the editor. */
export interface GenerationRun {
  flowId: string;
  flowName: string;
  ok: boolean;
  log: string[];
  warnings: string[];
  outputs: ArtifactRef[];
  error?: string;
  startedAt: string;
  ms: number;
}

export interface GenerateResponse {
  project: Project;
  runs: GenerationRun[];
}

export interface RegistryResponse {
  flowKinds: FlowKindDef[];
  categories: FlowCategory[];
  ruleDirectives: RuleDirectiveSpec[];
  artifactKinds: ArtifactKind[];
  /** Whether the server can render video itself. */
  ffmpeg: boolean;
}

export interface SyncResponse {
  plan: SyncPlan;
  connectionId: string;
  sourceFlowId: string;
  sourceFlowName: string;
}

export interface ErrorResponse {
  error: string;
  details?: Record<string, unknown>;
}
