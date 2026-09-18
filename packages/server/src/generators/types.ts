import type {
  ArtifactRef,
  FlowData,
  FlowKindDef,
  FlowNode,
  Project,
  ResolvedInput,
} from '@vibetoon/shared';

/** A file the client rasterised and sent along with a generate request. */
export interface Attachment {
  /** Path relative to the flow's artifact directory, e.g. `panels/panel-001.png`. */
  name: string;
  bytes: Uint8Array;
}

export interface GenerationContext {
  project: Project;
  node: FlowNode;
  def: FlowKindDef;
  /** Enabled incoming connections, nearest first. */
  inputs: ResolvedInput[];
  attachments: Attachment[];
  /** Read an upstream artifact off disk, truncated to `limit` characters. */
  readUpstream(input: ResolvedInput, limit?: number): Promise<string | undefined>;
  log(message: string): void;
  warn(message: string): void;
}

export interface GenerationResult {
  outputs: ArtifactRef[];
  /** Set when the generator also updated the flow's own editor state. */
  data?: FlowData;
}

export type Generator = (ctx: GenerationContext) => Promise<GenerationResult>;

/**
 * What a shortened upstream read ends with.
 *
 * It matters for anything reading JSON: half a database is not a smaller
 * database, it is a syntax error, and one that reads as though the file were
 * corrupt rather than merely long. `readsWhole` lets a generator say what
 * actually happened.
 */
export const TRUNCATION_MARK = '[truncated]';

/** True when a read returned the whole artifact rather than the front of it. */
export function readsWhole(body: string | undefined): boolean {
  return body === undefined || !body.endsWith(TRUNCATION_MARK);
}
