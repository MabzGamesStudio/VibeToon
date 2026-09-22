import { emptyAnimaticData, parseDuration } from '../flows/animatic';
import { emptyDesignData } from '../flows/design';
import { DEFAULT_DICTIONARY_OPTIONS } from '../flows/dictionary';
import { getFlowKind } from '../registry/flowKinds';
import { DEFAULT_DERIVE_OPTIONS, DEFAULT_EXTRACT_OPTIONS } from '../text/corpus';
import { DEFAULT_GRAMMAR_OPTIONS } from '../text/grammarDatabase';
import { normaliseMeanings } from '../text/senses';
import {
  DEFAULT_PALETTE_OPTIONS,
  derivePalette,
  type PaletteEdits,
  type PaletteFlowData,
  type PaletteOptions,
} from '../flows/palette';
import { DEFAULT_VECTORIZE_OPTIONS } from '../flows/vectorize';
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
      const meanings = normaliseMeanings(data.meanings);
      if (!extract.filled && !derive.filled && !meanings.changed) return data;
      return { ...data, extract: extract.value, derive: derive.value, meanings: meanings.meanings };
    }
    case 'grammar': {
      const options = fill(data.options, DEFAULT_GRAMMAR_OPTIONS);
      return options.filled ? { ...data, options: options.value } : data;
    }
    case 'vectorize': {
      /*
       * Every one of these settings was renamed when the decomposition was rebuilt
       * on edge detection, so a flow saved before that has none of them. Reading a
       * missing one is how `detail` arrives as `undefined` and a whole picture
       * comes back as one polygon with a thousand points.
       */
      const options = fill(data.options, DEFAULT_VECTORIZE_OPTIONS);
      return options.filled ? { ...data, options: options.value } : data;
    }
    case 'palette': {
      const options = fill(data.options, DEFAULT_PALETTE_OPTIONS);
      const edits = paletteEdits(data, options.value);
      if (!options.filled && !edits) return data;
      return { ...data, options: options.value, ...(edits ? { edits } : {}) };
    }
    case 'dictionary': {
      const options = fill(data.options, DEFAULT_DICTIONARY_OPTIONS);
      const meanings = normaliseMeanings(data.meanings);
      // `morphologyId` arrived with the forms dataset; older flows have no key.
      const morphologyId = data.morphologyId ?? '';
      if (!options.filled && !meanings.changed && data.morphologyId !== undefined) return data;
      return { ...data, options: options.value, meanings: meanings.meanings, morphologyId };
    }
    default:
      return data;
  }
}

/**
 * Palette edits, from a flow that stored pins by position.
 *
 * Pins used to be keyed by an entry's index in the list, which is not an
 * identity: ask for four colors instead of eight and index three is a different
 * color, so the pin lands on something nobody chose. They are keyed by the bucket
 * an entry came out of now.
 *
 * Converting the two needs the palette those indexes referred to, which means
 * deriving it here from the histogram the flow already carries. A palette flow
 * with no counted image has nothing to convert against, so its pins go — there
 * was no palette for them to have been applied to.
 */
function paletteEdits(data: PaletteFlowData, options: PaletteOptions): PaletteEdits | undefined {
  const legacy = (data as { pinned?: Record<string, string> }).pinned;
  if (data.edits && !legacy) return undefined;

  const edits: PaletteEdits = {
    changed: { ...(data.edits?.changed ?? {}) },
    removed: [...(data.edits?.removed ?? [])],
    added: [...(data.edits?.added ?? [])],
  };
  if (legacy && data.histogram) {
    const entries = derivePalette(data.histogram, options).entries;
    for (const [key, hex] of Object.entries(legacy)) {
      const entry = entries[Number(key)];
      if (entry && hex) edits.changed[entry.modeHex] = hex;
    }
  }
  return edits;
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
