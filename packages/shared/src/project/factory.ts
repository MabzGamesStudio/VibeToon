import { emptyBriefData } from '../flows/brief';
import { emptyDialogData } from '../flows/dialog';
import { emptyStoryboardData } from '../flows/storyboard';
import { newId } from '../ids';
import { getFlowKind, requireFlowKind } from '../registry/flowKinds';
import type {
  Connection,
  ConnectionMode,
  FlowData,
  FlowNode,
  PortRef,
  Project,
  ProjectSettings,
  Vec2,
} from '../types/project';

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  fps: 24,
  width: 1920,
  height: 1080,
  defaultShotSeconds: 2,
  styleNote: '',
};

export function defaultDataForKind(kind: string): FlowData {
  const def = requireFlowKind(kind);
  switch (def.editor) {
    case 'dialog':
      return emptyDialogData();
    case 'storyboard':
      return emptyStoryboardData();
    default:
      return emptyBriefData(def);
  }
}

export function createNode(kind: string, position: Vec2, name?: string): FlowNode {
  const def = requireFlowKind(kind);
  return {
    id: newId('flow'),
    kind,
    name: name ?? def.label,
    position,
    notes: '',
    data: defaultDataForKind(kind),
    outputs: [],
  };
}

export function createConnection(
  from: PortRef,
  to: PortRef,
  options: { rules?: string; mode?: ConnectionMode } = {},
): Connection {
  return {
    id: newId('conn'),
    from,
    to,
    rules: options.rules ?? '',
    settings: { enabled: true, mode: options.mode ?? 'suggest', weight: 1, notes: '' },
  };
}

/**
 * Seed rules for a new connection: whatever the source flow kind suggests for
 * its outgoing edges, so a fresh wire already does something sensible.
 */
export function defaultRulesForSource(sourceKind: string): string {
  return getFlowKind(sourceKind)?.defaultOutgoingRules ?? '';
}

export function createProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    schema: 1,
    id: newId('prj'),
    name,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_PROJECT_SETTINGS },
    nodes: [],
    connections: [],
    view: { pan: { x: 0, y: 0 }, zoom: 1 },
  };
}

export function connectionModeLabel(mode: ConnectionMode): string {
  switch (mode) {
    case 'apply':
      return 'Apply — pulled in on every generate';
    case 'suggest':
      return 'Suggest — offered as a sync you accept';
    default:
      return 'Reference — context only';
  }
}
