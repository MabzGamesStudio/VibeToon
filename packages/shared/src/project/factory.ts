import { emptyBriefData } from '../flows/brief';
import { emptyDialogData } from '../flows/dialog';
import { emptyStoryboardData } from '../flows/storyboard';
import { emptyAnimaticData } from '../flows/animatic';
import { emptyDesignData } from '../flows/design';
import { emptyTextData } from '../flows/text';
import { newId } from '../ids';
import { getFlowKind, requireFlowKind } from '../registry/flowKinds';
import { parseRules, RULE_DIRECTIVES } from '../rules/parseRules';
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
    case 'text':
      return emptyTextData();
    case 'animatic':
      return emptyAnimaticData();
    case 'design':
      return emptyDesignData(def);
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

/** True when `rules` contains a directive aimed at this kind of flow in particular. */
function rulesTarget(rules: string, targetKind: string): boolean {
  return parseRules(rules).directives.some((directive) =>
    RULE_DIRECTIVES.some(
      (spec) => spec.key === directive.key && spec.appliesTo.includes(targetKind),
    ),
  );
}

/**
 * Seed rules for a new connection. A flow that suggests rules for wires landing
 * on a particular input keeps them, unless the source has advice aimed
 * specifically at this kind of target: `panel per: beat` is good advice for a
 * storyboard and noise on the way into anything else.
 */
export interface ConnectionEnd {
  kind: string;
  portId: string;
}

export function defaultRulesForConnection(from: ConnectionEnd, to: ConnectionEnd): string {
  const outgoing = getFlowKind(from.kind)?.defaultOutgoingRules?.[from.portId];
  const incoming = getFlowKind(to.kind)?.defaultIncomingRules?.[to.portId];
  if (!incoming) return outgoing ?? '';
  if (outgoing && rulesTarget(outgoing, to.kind)) return outgoing;
  return incoming;
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
