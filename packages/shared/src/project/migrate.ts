import { emptyAnimaticData, parseDuration } from '../flows/animatic';
import { emptyDesignData } from '../flows/design';
import { DEFAULT_DICTIONARY_OPTIONS } from '../flows/dictionary';
import { getFlowKind } from '../registry/flowKinds';
import { DEFAULT_DERIVE_OPTIONS, DEFAULT_EXTRACT_OPTIONS } from '../text/corpus';
import { DEFAULT_GRAMMAR_OPTIONS } from '../text/grammarDatabase';
import type { BriefFlowData, FlowData, FlowNode, Project } from '../types/project';
import { DEFAULT_RANDOM_TEXT_OPTIONS } from '../types/text';
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

/**
 * Fill in the settings a stored project predates.
 *
 * A flow gains a setting — a grammar weight, a new counting limit — and every
 * project saved before that has a gap where its value should be. Reading that
 * gap is how a slider gets handed `undefined`, and `undefined.toFixed(2)` takes
 * the whole editor down. So defaults are merged in on the way out of storage,
 * once, rather than guarded at each of the hundred places a setting is read.
 *
 * Only missing keys are filled: a value that was saved is never overwritten.
 */
function fill<T extends object>(stored: T | undefined, defaults: T): { value: T; filled: boolean } {
  if (!stored) return { value: { ...defaults }, filled: true };
  const missing = (Object.keys(defaults) as Array<keyof T>).filter((key) => stored[key] === undefined);
  return missing.length === 0 ? { value: stored, filled: false } : { value: { ...defaults, ...stored }, filled: true };
}

export function normaliseFlowData(data: FlowData): FlowData {
  switch (data.editor) {
    case 'text': {
      const options = fill(data.options, DEFAULT_RANDOM_TEXT_OPTIONS);
      const length = fill(data.options?.length, DEFAULT_RANDOM_TEXT_OPTIONS.length);
      if (!options.filled && !length.filled) return data;
      return { ...data, options: { ...options.value, length: length.value } };
    }
    case 'lexicon': {
      const extract = fill(data.extract, DEFAULT_EXTRACT_OPTIONS);
      const derive = fill(data.derive, DEFAULT_DERIVE_OPTIONS);
      if (!extract.filled && !derive.filled) return data;
      return { ...data, extract: extract.value, derive: derive.value };
    }
    case 'grammar': {
      const options = fill(data.options, DEFAULT_GRAMMAR_OPTIONS);
      return options.filled ? { ...data, options: options.value } : data;
    }
    case 'dictionary': {
      const options = fill(data.options, DEFAULT_DICTIONARY_OPTIONS);
      return options.filled ? { ...data, options: options.value } : data;
    }
    default:
      return data;
  }
}

export function migrateNode(node: FlowNode): FlowNode {
  const data = normaliseFlowData(migrateFlowData(node.kind, node.data));
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
