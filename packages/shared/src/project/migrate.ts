import { emptyAnimaticData, parseDuration } from '../flows/animatic';
import { emptyDesignData } from '../flows/design';
import { DEFAULT_DICTIONARY_OPTIONS } from '../flows/dictionary';
import { getFlowKind } from '../registry/flowKinds';
import { DEFAULT_DERIVE_OPTIONS, DEFAULT_EXTRACT_OPTIONS } from '../text/corpus';
import { DEFAULT_GRAMMAR_OPTIONS } from '../text/grammarDatabase';
import { normaliseMeanings } from '../text/senses';
import {
  DEFAULT_PALETTE_FILTER_OPTIONS,
  type PaletteFilterOptions,
} from '../flows/paletteFilter';
import { DEFAULT_IK_OPTIONS } from '../flows/pose';
import { DEFAULT_RIG_OPTIONS, emptyRigFlowData } from '../flows/rig';
import { DEFAULT_BRUSH, nodeKey, readBoundRig } from '../flows/rigBind';
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
    case 'rig': {
      /*
       * A skeleton with no bones in it is not a skeleton.
       *
       * Everything in the rig editor walks `bones` and `chains`, so a flow whose
       * stored data is missing either takes the whole editor down with a blank
       * screen rather than showing an empty rig — which is the worst way to find
       * out, because there is nothing left on screen to find out *from*.
       */
      const kind = data.kind ?? 'human';
      const template = emptyRigFlowData(kind);
      const bones = Array.isArray(data.bones) && data.bones.length > 0 ? data.bones : template.bones;
      const chains = Array.isArray(data.chains) ? data.chains : template.chains;
      const options = fill(data.options, DEFAULT_RIG_OPTIONS);
      if (bones === data.bones && chains === data.chains && !options.filled && data.kind) return data;
      return { ...data, kind, bones, chains, options: options.value };
    }
    case 'bind': {
      /*
       * Everything a binding needs to be opened at all.
       *
       * The drawing and the skeleton gained places of their own, so a binding
       * made before that has none — and a placement read as `undefined` renders
       * the whole drawing at NaN. The rest is the same story one step further
       * back: `summariseBinding` walks the binding table on every render, so a
       * flow stored without one takes the editor down with a blank screen.
       */
      /*
       * Binding used to be by whole shape. A shape's points each follow the bone
       * the shape followed, which is what posing it did before — so a binding made
       * that way opens looking and moving exactly as it did. Where two shapes on
       * different bones met, their shared nodes go to whichever came last: a node
       * is one place and can follow one bone.
       */
      const legacy = (data as { binding?: Record<string, string> }).binding;
      let nodes = data.nodes;
      if (!nodes) {
        nodes = {};
        if (legacy && data.image) {
          for (const shape of data.image.shapes) {
            const bone = legacy[shape.id];
            if (!bone) continue;
            for (const point of shape.points) nodes[nodeKey(point)] = bone;
          }
        }
      }
      const { binding: _binding, ...rest } = data as typeof data & { binding?: unknown };
      const fixed = {
        ...rest,
        nodes,
        selected: Array.isArray(data.selected) ? data.selected : [],
        brush: typeof data.brush === 'number' && data.brush > 0 ? data.brush : DEFAULT_BRUSH,
        placement: data.placement ?? { x: 0, y: 0, scale: 1 },
        hideOthers: data.hideOthers ?? false,
        edits: typeof data.edits === 'number' ? data.edits : 0,
      };
      const same =
        legacy === undefined &&
        fixed.nodes === data.nodes &&
        fixed.selected === data.selected &&
        fixed.brush === data.brush &&
        fixed.placement === data.placement &&
        fixed.hideOthers === data.hideOthers &&
        fixed.edits === data.edits;
      return same ? data : fixed;
    }
    case 'pose': {
      /*
       * The same, for a pose.
       *
       * The angles are read on every render and so are the solver's settings, so
       * a pose flow stored without either — which is any pose flow made before
       * this flow had a solver — throws on `ik.respectLimits` the moment it is
       * opened, and the editor goes blank.
       */
      const ik = fill(data.ik, DEFAULT_IK_OPTIONS);
      // A bound rig taken in before binding was by node carries a table of whole
      // shapes; read back, each shape's points follow the bone it did.
      const bound = data.bound && !data.bound.points ? readBoundRig(data.bound) : data.bound;
      const fixed = {
        ...data,
        bound,
        pose: data.pose ?? {},
        mode: data.mode ?? 'forward',
        selected: data.selected ?? null,
        ik: ik.value,
      };
      const same =
        fixed.bound === data.bound &&
        fixed.pose === data.pose &&
        fixed.mode === data.mode &&
        fixed.selected === data.selected &&
        !ik.filled;
      return same ? data : fixed;
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
    case 'paletteFilter': {
      /*
       * The mode that removed the palette's colors is gone, and so are the two
       * settings that only existed to soften the edge it left. A flow saved with
       * either keeps working: removing is what you get by keeping the *other*
       * colors, so there is nothing to translate it into — it becomes a keep,
       * and the note in the flow's report says the picking is now the other way
       * round.
       */
      const options = fill(data.options, DEFAULT_PALETTE_FILTER_OPTIONS);
      const mode = options.value.mode === 'keep' || options.value.mode === 'snap' ? options.value.mode : 'keep';
      const clean: PaletteFilterOptions = {
        mode,
        tolerance: options.value.tolerance,
        only: Array.isArray(options.value.only) ? options.value.only : [],
        minChunk: Math.max(0, Number(options.value.minChunk) || 0),
      };
      const same =
        !options.filled &&
        Object.keys(data.options ?? {}).length === 4 &&
        clean.mode === data.options?.mode;
      return same ? data : { ...data, options: clean };
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
