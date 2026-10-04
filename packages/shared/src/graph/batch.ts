import { hashString } from '../ids';
import { findPort, getFlowKind } from '../registry/flowKinds';
import { ITEM_SET_KIND, SET_ITEM_KIND, type ArtifactKind, type ArtifactRef, type BatchItemRef } from '../types/artifacts';
import type { PortSpec } from '../types/flow';
import type { Connection, FlowNode, FlowStatus, Project } from '../types/project';
import { computeSignature, connectionsInto, flowStatus, nodeById } from './graph';

/**
 * Batches: many items going through the same flow side by side.
 *
 * A folder of files — the shots of a video as clips, the drawings of a rig's
 * parts — can go over a wire as a **batch**: one item per file. The wire is
 * one connection, drawn as a bundle. The flow it goes into becomes a **batch
 * flow**: it runs once for each item, as though that item alone were wired in,
 * and what it makes is itself a batch, one output per item, which goes on down
 * the graph the same way. So a video split into ten shots, wired into a Video
 * Background, gives ten backgrounds.
 *
 * - A folder wired into an input that takes one file is a batch. Into an input
 *   that takes the folder too, it is one only when the wire is set to be
 *   (`Connection.batch`).
 * - Anything out of a batch flow is a batch — unless the input takes a folder
 *   of that kind and not one file: then the items are **gathered** and arrive
 *   together, as one folder.
 * - A batch flow's `data` is what its items share. An item edited on its own
 *   keeps its own copy (`BatchItemState.data`) from then on.
 * - Items are known by a key that stays put from run to run — the file name
 *   each came from — so an item's own settings and outputs stay with it when
 *   the batch is made again.
 *
 * Nothing about a flow has to know it is in a batch. Each item is shown to the
 * flow's editor and generator as a **view** of the project (`itemView`): the
 * flow as that item — its settings, outputs and run — with the batch wire
 * carrying that item alone.
 */

export interface BatchItem {
  key: string;
  label: string;
  /** What arrives for this item over the wire that makes the batch, if anything has yet. */
  artifact?: ArtifactRef;
}

/* ---------------- what makes a batch ---------------- */

/** True when a folder on this output is split into a batch going into that input. */
export function splitsSet(sourcePort: PortSpec, targetPort: PortSpec, choice?: boolean): boolean {
  const sets = sourcePort.kinds.filter((kind) => SET_ITEM_KIND[kind] !== undefined);
  if (!sets.some((kind) => targetPort.kinds.includes(SET_ITEM_KIND[kind]!))) return false;
  // An input that takes the folder as well takes it whole unless the wire says otherwise.
  return sets.some((kind) => targetPort.kinds.includes(kind)) ? choice === true : true;
}

/** True when a batch on this output arrives at that input gathered into one folder. */
export function gathersBatch(sourcePort: PortSpec, targetPort: PortSpec): boolean {
  if (sourcePort.kinds.some((kind) => targetPort.kinds.includes(kind))) return false;
  return sourcePort.kinds.some((kind) => {
    const set = ITEM_SET_KIND[kind];
    return set !== undefined && targetPort.kinds.includes(set);
  });
}

/** Can a folder on this output be wired into that input only as a batch (so not by kind alone)? */
export function batchOnlyCompatible(sourcePort: PortSpec, targetPort: PortSpec): boolean {
  return !sourcePort.kinds.some((kind) => targetPort.kinds.includes(kind)) && splitsSet(sourcePort, targetPort);
}

/** Can a folder on this output be split into a batch for that input at all? */
export function canSplit(sourcePort: PortSpec, targetPort: PortSpec): boolean {
  return splitsSet(sourcePort, targetPort, true);
}

// A project is replaced, never changed, so what is worked out for one holds.
const batchCache = new WeakMap<Project, Map<string, boolean>>();

/** True when the flow runs as a batch: a batch is wired into it. */
export function isBatchNode(project: Project, node: FlowNode): boolean {
  if (node.itemOf !== undefined) return false;
  let cache = batchCache.get(project);
  if (!cache) {
    cache = new Map();
    batchCache.set(project, cache);
  }
  const known = cache.get(node.id);
  if (known !== undefined) return known;
  // Guard against a loop while it is being worked out.
  cache.set(node.id, false);
  const answer = batchConnectionsInto(project, node).length > 0;
  cache.set(node.id, answer);
  return answer;
}

/** How a wire treats a batch: split into items, gathered into a folder, or neither. */
export function connectionBatchMode(project: Project, connection: Connection): 'batch' | 'gather' | 'none' {
  if (!connection.settings.enabled) return 'none';
  const source = nodeById(project, connection.from.nodeId);
  const target = nodeById(project, connection.to.nodeId);
  if (!source || !target) return 'none';
  const sourcePort = findPort(source.kind, connection.from.portId, 'outputs');
  const targetPort = findPort(target.kind, connection.to.portId, 'inputs');
  if (!sourcePort || !targetPort) return 'none';
  if (isBatchNode(project, source)) return gathersBatch(sourcePort, targetPort) ? 'gather' : 'batch';
  return splitsSet(sourcePort, targetPort, connection.batch) ? 'batch' : 'none';
}

/** The wires that make a flow a batch, in the order of its inputs. */
export function batchConnectionsInto(project: Project, node: FlowNode): Connection[] {
  const def = getFlowKind(node.kind);
  const order = new Map((def?.inputs ?? []).map((port, index) => [port.id, index]));
  return connectionsInto(project, node.id)
    .filter((connection) => connectionBatchMode(project, connection) === 'batch')
    .sort((a, b) => (order.get(a.to.portId) ?? 1e9) - (order.get(b.to.portId) ?? 1e9));
}

/* ---------------- the items ---------------- */

const withoutExtension = (name: string) => name.replace(/\.[^./]+$/, '');

/** One file of a folder artifact, as an artifact of its own. */
export function setEntryArtifact(set: ArtifactRef, entry: string): ArtifactRef {
  const kind = SET_ITEM_KIND[set.kind] ?? set.kind;
  const own = set.entryHashes?.[entry];
  return {
    port: set.port,
    kind,
    fileName: entry,
    path: `${set.path}/${entry}`,
    hash: own ?? hashString(`${set.hash}/${entry}`),
    bytes: 0,
    generatedAt: set.generatedAt,
  };
}

/**
 * The files a folder output will hold, known before they are made — so a
 * batch has its items, and says which are still to come, as soon as there is
 * something to make them from: the shots a Shot Split has found, before each
 * is recorded; the segments of an edit written as clips; the frames a rig was
 * matched in.
 *
 * The names are those the flows write (`shotClipName`, `clipName`,
 * `matchFrameName`), repeated here so the graph does not import the flows that
 * import it; a test holds them together.
 */
export function plannedEntries(node: FlowNode, portId: string): string[] {
  const data = node.data as unknown as Record<string, unknown>;
  // As `clipExtension`, which lives with the flows.
  const extension = data.clipFormat === 'mp4-h264' ? 'mp4' : data.clipFormat === 'mkv-h264' ? 'mkv' : 'webm';
  const numbered = (count: number, name: (n: string) => string, width: number) =>
    Array.from({ length: Math.max(0, count) }, (_, index) => name(String(index + 1).padStart(width, '0')));
  if (node.kind === 'animation.video.shots' && portId === 'clips') {
    const video = data.video as { duration: number } | undefined;
    if (!video) return [];
    const cuts = new Set(((data.cuts as number[] | undefined) ?? []).filter((cut) => cut > 0 && cut < video.duration));
    return numbered(cuts.size + 1, (n) => `shot-${n}.${extension}`, 2);
  }
  if (node.kind === 'animation.video.edit' && portId === 'clips') {
    if (data.output !== 'clips' || !data.video) return [];
    const segments = (data.segments as Array<{ start: number; end: number; deleted: boolean }> | undefined) ?? [];
    const kept = segments.length === 0 ? 1 : segments.filter((segment) => !segment.deleted && segment.end > segment.start).length;
    return numbered(kept, (n) => `clip-${n}.${extension}`, 2);
  }
  if (node.kind === 'animation.video.match' && portId === 'frames') {
    return numbered(((data.frames as unknown[] | undefined) ?? []).length, (n) => `frame-${n}.png`, 3);
  }
  return [];
}

/** The items a wire carries, if it carries a batch. */
export function connectionItems(project: Project, connection: Connection): BatchItem[] {
  const source = nodeById(project, connection.from.nodeId);
  if (!source) return [];
  const ref = source.outputs.find((output) => output.port === connection.from.portId);
  if (isBatchNode(project, source)) {
    const made = new Map((ref?.items ?? []).map((item) => [item.key, item.artifact]));
    return batchItems(project, source).map((item) => ({ key: item.key, label: item.label, artifact: made.get(item.key) }));
  }
  if (ref?.items) return ref.items.map((item) => ({ key: item.key, label: item.label, artifact: item.artifact }));
  if (ref?.entries && ref.entries.length > 0) {
    return ref.entries.map((entry) => ({ key: entry, label: withoutExtension(entry), artifact: setEntryArtifact(ref, entry) }));
  }
  // Nothing made yet: the items it will hold, still to come.
  return plannedEntries(source, connection.from.portId).map((entry) => ({ key: entry, label: withoutExtension(entry) }));
}

/** A batch flow's items: those of the first batch wired into it. */
export function batchItems(project: Project, node: FlowNode): BatchItem[] {
  if (!isBatchNode(project, node)) return [];
  const first = batchConnectionsInto(project, node)[0];
  return first ? connectionItems(project, first) : [];
}

/** A key as a folder name: what an item's files are written under. */
export function itemFolder(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return safe.length > 0 ? safe : '_';
}

/* ---------------- one item as the flow sees it ---------------- */

/**
 * The project as one item of a batch flow sees it: the flow with that item's
 * settings, outputs and run, and each batch wired into it carrying only that
 * item (matched by key, or failing that by place).
 */
export function itemView(project: Project, node: FlowNode, key: string): { project: Project; node: FlowNode } {
  const primary = batchItems(project, node);
  const index = primary.findIndex((item) => item.key === key);
  const replaced = new Map<string, FlowNode>();
  for (const connection of batchConnectionsInto(project, node)) {
    const items = connectionItems(project, connection);
    const item = items.find((candidate) => candidate.key === key) ?? (index >= 0 ? items[index] : undefined);
    const source = replaced.get(connection.from.nodeId) ?? nodeById(project, connection.from.nodeId);
    if (!source) continue;
    const others = source.outputs.filter((ref) => ref.port !== connection.from.portId);
    const artifact = item?.artifact ? { ...item.artifact, port: connection.from.portId } : undefined;
    replaced.set(source.id, { ...source, outputs: artifact ? [...others, artifact] : others });
  }
  const state = node.batch?.items[key];
  const itemNode: FlowNode = {
    ...node,
    data: state?.data ?? node.data,
    outputs: state?.outputs ?? [],
    lastRun: state?.lastRun,
    batch: undefined,
    itemOf: key,
  };
  replaced.set(node.id, itemNode);
  return { project: { ...project, nodes: project.nodes.map((candidate) => replaced.get(candidate.id) ?? candidate) }, node: itemNode };
}

/** True when an item has been edited on its own, and so has settings of its own. */
export function itemHasOwnData(node: FlowNode, key: string): boolean {
  const state = node.batch?.items[key];
  return state?.data !== undefined && state.edited === true;
}

/** Each item's status, in order. */
export function batchItemStatuses(project: Project, node: FlowNode): Array<{ item: BatchItem; status: FlowStatus }> {
  return batchItems(project, node).map((item) => {
    const view = itemView(project, node, item.key);
    return { item, status: flowStatus(view.project, view.node) };
  });
}

/** A batch flow's status: empty until an item has run, an error if one failed, stale until all are ready. */
export function batchStatus(project: Project, node: FlowNode): FlowStatus {
  const statuses = batchItemStatuses(project, node).map((entry) => entry.status);
  if (statuses.length === 0 || statuses.every((status) => status === 'empty')) return 'empty';
  if (statuses.includes('error')) return 'error';
  return statuses.every((status) => status === 'ready') ? 'ready' : 'stale';
}

/** A batch flow's signature: its items', in order. */
export function batchSignature(project: Project, node: FlowNode): string {
  return hashString(
    batchItems(project, node)
      .map((item) => {
        const view = itemView(project, node, item.key);
        return `${item.key}=${computeSignature(view.project, view.node)}`;
      })
      .join('|'),
  );
}

/**
 * A batch flow's outputs, gathered from its items: for each port, one ref
 * standing for every item's file on it.
 */
export function batchOutputs(project: Project, node: FlowNode): ArtifactRef[] {
  const def = getFlowKind(node.kind);
  if (!def) return [];
  const items = batchItems(project, node);
  const out: ArtifactRef[] = [];
  for (const port of def.outputs) {
    const refs: BatchItemRef[] = items.map((item) => ({
      key: item.key,
      label: item.label,
      artifact: node.batch?.items[item.key]?.outputs.find((ref) => ref.port === port.id),
    }));
    const made = refs.filter((ref) => ref.artifact !== undefined);
    if (made.length === 0) continue;
    const base = `artifacts/${node.id}/items`;
    out.push({
      port: port.id,
      kind: made[0]!.artifact!.kind,
      fileName: port.fileName ?? port.id,
      path: base,
      hash: hashString(refs.map((ref) => `${ref.key}:${ref.artifact?.hash ?? '-'}`).join('|')),
      bytes: made.reduce((sum, ref) => sum + ref.artifact!.bytes, 0),
      generatedAt: made.map((ref) => ref.artifact!.generatedAt).sort().at(-1)!,
      entries: made.map((ref) => ref.artifact!.path.slice(base.length + 1)),
      items: refs,
    });
  }
  return out;
}

/** The kind a gathered batch arrives as: the folder of what each item is. */
export function gatheredKind(kind: ArtifactKind): ArtifactKind {
  return ITEM_SET_KIND[kind] ?? kind;
}

/* ---------------- editing items ---------------- */

type Json = unknown;
const isPlain = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What changed from `before` to `after`, laid onto `onto`: objects are gone
 * into key by key, anything else is taken whole. How an edit made to all the
 * items reaches one with settings of its own without undoing its others.
 */
export function carryChange<T>(before: T, after: T, onto: T): T {
  if (!isPlain(before) || !isPlain(after) || !isPlain(onto)) return (JSON.stringify(before) === JSON.stringify(after) ? onto : after) as T;
  const out: Record<string, Json> = { ...onto };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (!(key in after)) delete out[key];
    else out[key] = key in onto ? carryChange(before[key], after[key], onto[key]) : after[key];
  }
  return out as T;
}

/**
 * What each kind of flow finds out about, or makes from, the item in front of
 * it — the picture it read, the video's length, the cuts found in it, the
 * marks painted on its frames. These belong to the item shown, even when an
 * edit goes to every item: one video's length is not every video's.
 */
export const ITEM_FIELDS: Partial<Record<string, readonly string[]>> = {
  image: ['source'],
  videoSource: ['source'],
  crop: ['source', 'rect'],
  resize: ['source'],
  lines: ['source'],
  lineGraph: ['hidden', 'moved', 'basis', 'selected'],
  paletteFilter: ['imageHash', 'paletteHash'],
  palette: ['histogram', 'edits'],
  cutout: ['seeds', 'lines', 'regions', 'nextSeq', 'selected', 'imageHash', 'imageWidth', 'imageHeight'],
  vectorize: ['result', 'report', 'imageHash', 'readAt'],
  vectorEdit: ['image', 'selected', 'sourceHash', 'edits'],
  bind: ['rig', 'image', 'nodes', 'selected', 'rigHash', 'vectorHash', 'edits', 'apart'],
  parts: ['bound', 'boundHash', 'parts', 'current', 'selected', 'edits'],
  face: ['heads', 'current', 'selected', 'edits'],
  rigMatch: ['bound', 'boundHash', 'picture', 'imageHash', 'fit', 'report', 'selected'],
  videoMatch: ['bound', 'boundHash', 'video', 'frameSize', 'frames', 'matchedAt'],
  videoBackground: ['video', 'frameSize', 'marks', 'current'],
  shots: ['video', 'cuts', 'detected', 'edits', 'selected', 'recorded', 'frameRate', 'frameRateFor'],
  videoEdit: ['video', 'segments', 'selected', 'rendered', 'shots', 'fps', 'fpsFor'],
};

/**
 * Edit a batch flow's settings, from an editor showing one item.
 *
 * `before` is what the editor was showing — that item's settings — and `next`
 * the same after the edit. For one item, `next` becomes that item's own
 * settings. For every item, what changed is laid onto the shared settings and
 * onto each item that has its own, so an item's other differences are kept —
 * except for what belongs to the item shown (`ITEM_FIELDS`), which stays with
 * it.
 */
export function editBatchData(
  node: FlowNode,
  before: FlowNode['data'],
  next: FlowNode['data'],
  scope: { key: string; only: boolean; quiet?: boolean },
): FlowNode {
  const items = { ...(node.batch?.items ?? {}) };
  if (scope.only) {
    const state = items[scope.key] ?? { outputs: [] };
    // `quiet`: written by a run, not by hand — what it found out, not a choice.
    items[scope.key] = { ...state, data: next, ...(scope.quiet ? {} : { edited: true }) };
    return { ...node, batch: { items } };
  }
  const fields = ITEM_FIELDS[next.editor] ?? [];
  const was = before as unknown as Record<string, unknown>;
  const now = next as unknown as Record<string, unknown>;
  const itemChanges = fields.filter((field) => JSON.stringify(was[field]) !== JSON.stringify(now[field]));
  // What goes to everyone is the edit without the item's own findings.
  const forAll = { ...now };
  for (const field of itemChanges) {
    if (field in was) forAll[field] = was[field];
    else delete forAll[field];
  }
  const everyone = forAll as unknown as FlowNode['data'];
  for (const [key, state] of Object.entries(items)) {
    if (state.data !== undefined) items[key] = { ...state, data: carryChange(before, everyone, state.data) };
  }
  const shared = carryChange(before, everyone, node.data);
  if (itemChanges.length > 0) {
    const state = items[scope.key] ?? { outputs: [] };
    const base = (state.data ?? shared) as unknown as Record<string, unknown>;
    const own = { ...base };
    for (const field of itemChanges) {
      if (field in now) own[field] = now[field];
      else delete own[field];
    }
    items[scope.key] = { ...state, data: own as unknown as FlowNode['data'] };
  }
  return { ...node, data: shared, batch: { items } };
}

/** Let an item use the shared settings again. */
export function dropItemData(node: FlowNode, key: string): FlowNode {
  const state = node.batch?.items[key];
  if (!state || state.data === undefined) return node;
  const { data: _dropped, edited: _edited, ...rest } = state;
  return { ...node, batch: { items: { ...node.batch!.items, [key]: rest } } };
}
