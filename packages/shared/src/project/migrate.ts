import { emptyAnimaticData, parseDuration } from '../flows/animatic';
import { emptyDesignData } from '../flows/design';
import { getFlowKind } from '../registry/flowKinds';
import type { BriefFlowData, FlowData, FlowNode, Project } from '../types/project';
import { defaultDataForKind } from './factory';

function isBrief(data: FlowData): data is BriefFlowData {
  return data.editor === 'brief';
}

/**
 * A flow kind can gain a bespoke editor after projects already exist — a design
 * flow that used to be a written brief now has plates to draw on. When that
 * happens the stored data no longer matches the editor the kind declares, so it
 * is converted here, keeping whatever still means the same thing.
 */
export function migrateFlowData(kind: string, data: FlowData): FlowData {
  const def = getFlowKind(kind);
  if (!def || data.editor === def.editor) return data;

  switch (def.editor) {
    case 'design':
      if (isBrief(data)) {
        // The written spec is the same in both; the plates are new.
        return { ...emptyDesignData(def), fields: { ...data.fields } };
      }
      break;
    case 'animatic':
      if (isBrief(data)) {
        const target = parseDuration(data.fields.target ?? '');
        return {
          ...emptyAnimaticData(),
          pacing: [data.fields.pacing, data.fields.holds].filter(Boolean).join('\n\n'),
          ...(target !== undefined ? { targetSeconds: target } : {}),
        };
      }
      break;
    case 'brief':
      // Going the other way keeps the fields and drops what has no home.
      if ('fields' in data) return { editor: 'brief', fields: { ...data.fields } };
      break;
    default:
      break;
  }

  return defaultDataForKind(kind);
}

export function migrateNode(node: FlowNode): FlowNode {
  const data = migrateFlowData(node.kind, node.data);
  return data === node.data ? node : { ...node, data };
}

/** Run every node through the migration; returns the same object when nothing moved. */
export function migrateProject(project: Project): Project {
  let changed = false;
  const nodes = project.nodes.map((node) => {
    const migrated = migrateNode(node);
    if (migrated !== node) changed = true;
    return migrated;
  });
  return changed ? { ...project, nodes } : project;
}
