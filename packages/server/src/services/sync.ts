import {
  deriveBoardFromDialog,
  inputsForPort,
  planSync,
  type Connection,
  type DialogFlowData,
  type FlowNode,
  type Project,
  type StoryboardFlowData,
  type SyncPlan,
} from '@vibetoon/shared';
import { HttpError } from '../storage';

export interface SyncSource {
  connection: Connection;
  sourceNode: FlowNode;
}

/** Incoming dialog connections that a board can actually be derived from. */
export function syncSources(project: Project, node: FlowNode): SyncSource[] {
  return inputsForPort(project, node.id, 'dialog')
    .filter((input) => input.sourceNode.data.editor === 'dialog')
    .map((input) => ({ connection: input.connection, sourceNode: input.sourceNode }));
}

/**
 * Build the proposal for pulling a dialog flow into a storyboard flow. The rules
 * text on the connection decides the breakdown; the merge keeps sketches, notes
 * and pinned panels that already exist on the board.
 */
export function buildSyncPlan(
  project: Project,
  node: FlowNode,
  connectionId?: string,
): { plan: SyncPlan; source: SyncSource } {
  const sources = syncSources(project, node);
  if (sources.length === 0) {
    throw new HttpError(
      400,
      'Nothing to sync from: wire a dialog flow into this board’s Dialog input first.',
    );
  }
  const source = connectionId
    ? sources.find((s) => s.connection.id === connectionId)
    : sources[0];
  if (!source) throw new HttpError(404, `No dialog connection ${connectionId} on this flow.`);

  const board = node.data as StoryboardFlowData;
  const derived = deriveBoardFromDialog(
    source.sourceNode.data as DialogFlowData,
    source.connection.rules,
    project.settings,
  );
  return { plan: planSync(board.scenes, derived), source };
}
