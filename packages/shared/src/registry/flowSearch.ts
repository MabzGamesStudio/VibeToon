import { ARTIFACT_KIND_LABEL, ARTIFACT_KINDS, type ArtifactKind } from '../types/artifacts';
import { FLOW_CATEGORIES, FLOW_CATEGORY_LABEL, type FlowCategory } from '../types/flow';
import type { FlowKindDef } from '../types/flow';

/**
 * Narrowing the flow catalogue. Forty kinds is more than a list you read, so it
 * is a list you filter — by what a flow *takes*, what it *gives*, and where it
 * belongs.
 *
 * Filtering by port kind is the useful axis for a graph: the question is almost
 * never "what is in the art category", it is "what can I plug this image into".
 */
export interface FlowFilter {
  query: string;
  categories: FlowCategory[];
  /** Artifact kinds a flow must accept on some input port. */
  inputs: ArtifactKind[];
  /** Artifact kinds a flow must produce on some output port. */
  outputs: ArtifactKind[];
}

export const EMPTY_FLOW_FILTER: FlowFilter = { query: '', categories: [], inputs: [], outputs: [] };

/** True when the filter would let everything through, so the UI can say so. */
export function isFlowFilterEmpty(filter: FlowFilter): boolean {
  return (
    filter.query.trim() === '' &&
    filter.categories.length === 0 &&
    filter.inputs.length === 0 &&
    filter.outputs.length === 0
  );
}

/** How many facets are narrowing the list, for the badge on the Filters button. */
export function activeFacetCount(filter: FlowFilter): number {
  return filter.categories.length + filter.inputs.length + filter.outputs.length;
}

function haystack(def: FlowKindDef): string {
  const ports = [...def.inputs, ...def.outputs];
  return [
    def.label,
    def.kind,
    def.summary,
    FLOW_CATEGORY_LABEL[def.category],
    ...ports.map((port) => port.label),
    // A file name is what someone remembers a flow by — "the one that writes
    // palette.json" — so it is worth searching.
    ...def.outputs.map((port) => port.fileName ?? ''),
  ]
    .join(' ')
    .toLowerCase();
}

function portKinds(ports: FlowKindDef['inputs']): Set<ArtifactKind> {
  const kinds = new Set<ArtifactKind>();
  for (const port of ports) for (const kind of port.kinds) kinds.add(kind);
  return kinds;
}

/** The artifact kinds a flow accepts on any input port. */
export function inputKinds(def: FlowKindDef): Set<ArtifactKind> {
  return portKinds(def.inputs);
}

/** The artifact kinds a flow produces on any output port. */
export function outputKinds(def: FlowKindDef): Set<ArtifactKind> {
  return portKinds(def.outputs);
}

/**
 * Within one facet the chosen values are alternatives; across facets they all
 * have to hold. Ticking `image` and `json` under Takes means "either", because
 * ticking two things to get nothing back is a filter that feels broken.
 */
function matchesQuery(def: FlowKindDef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const target = haystack(def);
  // Every word has to appear somewhere, in any order, so "image palette" finds
  // the palette flow that takes an image.
  return needle.split(/\s+/).every((word) => target.includes(word));
}

function matchesFacets(def: FlowKindDef, filter: FlowFilter, skip?: keyof FlowFilter): boolean {
  if (skip !== 'categories' && filter.categories.length > 0) {
    if (!filter.categories.includes(def.category)) return false;
  }
  if (skip !== 'inputs' && filter.inputs.length > 0) {
    const kinds = inputKinds(def);
    if (!filter.inputs.some((kind) => kinds.has(kind))) return false;
  }
  if (skip !== 'outputs' && filter.outputs.length > 0) {
    const kinds = outputKinds(def);
    if (!filter.outputs.some((kind) => kinds.has(kind))) return false;
  }
  return true;
}

export function matchesFlowFilter(def: FlowKindDef, filter: FlowFilter): boolean {
  return matchesQuery(def, filter.query) && matchesFacets(def, filter);
}

export function filterFlowKinds(defs: readonly FlowKindDef[], filter: FlowFilter): FlowKindDef[] {
  return defs.filter((def) => matchesFlowFilter(def, filter));
}

export interface FacetOption<T extends string> {
  value: T;
  label: string;
  /**
   * How many flows this option would leave, with every *other* facet still
   * applied. An option at 0 is one that would empty the list, and the UI can
   * show that rather than letting someone click into nothing.
   */
  count: number;
}

export interface FlowFacets {
  categories: Array<FacetOption<FlowCategory>>;
  inputs: Array<FacetOption<ArtifactKind>>;
  outputs: Array<FacetOption<ArtifactKind>>;
}

/**
 * The options to offer, with counts.
 *
 * Two different questions, answered two different ways:
 *
 * - **Which options exist at all** is asked of the whole catalogue. A kind no
 *   flow has any port for is permanent noise and is never offered.
 * - **The count beside one** is taken with every *other* facet applied but not
 *   its own. That is the standard way round: ticking a second category should
 *   show what it would add, not what is left after it.
 *
 * So an option can be offered at a count of nought, and the UI shows it disabled
 * rather than removing it. Removing it would reshuffle the row under the cursor
 * as you tick things, and "Music: 0" is the useful answer to why music flows and
 * an image input cannot be combined — silence is not.
 */
export function flowFacets(defs: readonly FlowKindDef[], filter: FlowFilter): FlowFacets {
  const forFacet = (facet: keyof FlowFilter) =>
    defs.filter((def) => matchesQuery(def, filter.query) && matchesFacets(def, filter, facet));

  const byCategory = forFacet('categories');
  const byInput = forFacet('inputs');
  const byOutput = forFacet('outputs');

  const kindOptions = (
    pool: readonly FlowKindDef[],
    of: (def: FlowKindDef) => Set<ArtifactKind>,
    chosen: readonly ArtifactKind[],
  ): Array<FacetOption<ArtifactKind>> =>
    ARTIFACT_KINDS
      // Exists in the catalogue at all, or is ticked — so a filter can always be
      // undone even if the catalogue changed under it.
      .filter((kind) => defs.some((def) => of(def).has(kind)) || chosen.includes(kind))
      .map((kind) => ({
        value: kind,
        label: ARTIFACT_KIND_LABEL[kind],
        count: pool.filter((def) => of(def).has(kind)).length,
      }));

  return {
    categories: FLOW_CATEGORIES.filter(
      (category) => defs.some((def) => def.category === category) || filter.categories.includes(category),
    ).map((category) => ({
      value: category,
      label: FLOW_CATEGORY_LABEL[category],
      count: byCategory.filter((def) => def.category === category).length,
    })),
    inputs: kindOptions(byInput, inputKinds, filter.inputs),
    outputs: kindOptions(byOutput, outputKinds, filter.outputs),
  };
}

/** Tick or untick one value in a facet. */
export function toggleFacet<T extends string>(chosen: readonly T[], value: T): T[] {
  return chosen.includes(value) ? chosen.filter((candidate) => candidate !== value) : [...chosen, value];
}
