import { newId } from '../ids';
import { SAMPLE_CORPUS, SAMPLE_CORPUS_NAME } from '../text/sampleCorpus';

/**
 * A corpus flow: the text itself, kept in one place and handed to whatever needs
 * reading.
 *
 * Both the word database and the grammar database read a corpus, and before this
 * each kept its own copy of the arrangements for getting one. A corpus is a
 * thing in its own right, so it is a flow in its own right: gather the text
 * once, wire it into both, and the two are guaranteed to be reading the same
 * words — which is what makes their word types line up.
 *
 * A pasted part carries its text, because you typed it and nothing else has it.
 * A part with an address carries only the address, and is fetched when the flow
 * runs: a novel is a megabyte, and a project is a folder you copy around.
 */
export type CorpusPartKind = 'pasted' | 'url' | 'builtin';

export interface CorpusPart {
  id: string;
  name: string;
  kind: CorpusPartKind;
  /** For a `url` part: where to fetch it from, every time the flow runs. */
  url?: string;
  /** For a `pasted` part: the text itself. */
  text?: string;
  addedAt: string;
  /** What the last run read, so the editor can show a size without fetching. */
  lastBytes?: number;
  lastReadAt?: string;
  /** What went wrong last time it was fetched, if anything. */
  lastError?: string;
}

export interface CorpusFlowData {
  editor: 'corpus';
  parts: CorpusPart[];
  /** Part ids that make up the output, in this order. */
  included: string[];
  /** Written between parts, so a run of them does not read as one sentence. */
  separator: string;
}

export const DEFAULT_CORPUS_SEPARATOR = '\n\n';

export function samplePart(): CorpusPart {
  return {
    id: newId('part'),
    name: SAMPLE_CORPUS_NAME,
    kind: 'builtin',
    addedAt: new Date().toISOString(),
    lastBytes: SAMPLE_CORPUS.length,
  };
}

export function emptyCorpusFlowData(): CorpusFlowData {
  const sample = samplePart();
  return {
    editor: 'corpus',
    parts: [sample],
    included: [sample.id],
    separator: DEFAULT_CORPUS_SEPARATOR,
  };
}

export function addCorpusPart(data: CorpusFlowData, part: CorpusPart): CorpusFlowData {
  return { ...data, parts: [...data.parts, part], included: [...data.included, part.id] };
}

export function removeCorpusPart(data: CorpusFlowData, partId: string): CorpusFlowData {
  return {
    ...data,
    parts: data.parts.filter((part) => part.id !== partId),
    included: data.included.filter((id) => id !== partId),
  };
}

export function setCorpusIncluded(data: CorpusFlowData, partId: string, included: boolean): CorpusFlowData {
  if (included === data.included.includes(partId)) return data;
  return {
    ...data,
    included: included
      ? [...data.included, partId]
      : data.included.filter((id) => id !== partId),
  };
}

/** Move a part up or down, since the order is the order it is written in. */
export function moveCorpusPart(data: CorpusFlowData, partId: string, by: number): CorpusFlowData {
  const order = includedParts(data);
  const at = order.findIndex((part) => part.id === partId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return data;
  const ids = order.map((part) => part.id);
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return { ...data, included: ids };
}

/** The parts that make up the output, in the order they are written. */
export function includedParts(data: CorpusFlowData): CorpusPart[] {
  return data.included
    .map((id) => data.parts.find((part) => part.id === id))
    .filter((part): part is CorpusPart => part !== undefined);
}

/** Record what a run found, so the editor can show it without fetching again. */
export function notePartRead(
  data: CorpusFlowData,
  partId: string,
  result: { bytes?: number; error?: string },
): CorpusFlowData {
  return {
    ...data,
    parts: data.parts.map((part) =>
      part.id !== partId
        ? part
        : {
            ...part,
            lastReadAt: new Date().toISOString(),
            ...(result.bytes !== undefined ? { lastBytes: result.bytes } : {}),
            ...(result.error !== undefined ? { lastError: result.error } : { lastError: undefined }),
          },
    ),
  };
}

/** The text of a part that carries its own, or nothing when it has to be fetched. */
export function localPartText(part: CorpusPart): string | null {
  if (part.kind === 'builtin') return SAMPLE_CORPUS;
  if (part.kind === 'pasted') return part.text ?? '';
  return null;
}

export interface CorpusSummary {
  parts: number;
  included: number;
  /** Bytes the last run read, as far as anything is known. */
  bytes: number;
  /** Parts whose size is not known because they have never been fetched. */
  unknown: number;
  errors: number;
}

export function summariseCorpus(data: CorpusFlowData): CorpusSummary {
  const included = includedParts(data);
  let bytes = 0;
  let unknown = 0;
  for (const part of included) {
    const local = localPartText(part);
    if (local !== null) bytes += local.length;
    else if (part.lastBytes !== undefined) bytes += part.lastBytes;
    else unknown += 1;
  }
  return {
    parts: data.parts.length,
    included: included.length,
    bytes,
    unknown,
    errors: included.filter((part) => part.lastError).length,
  };
}
