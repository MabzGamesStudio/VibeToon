import { connectionItems } from '../graph/batch';
import { connectionsInto, nodeById } from '../graph/graph';
import { ITEM_SET_KIND, SET_ITEM_KIND, type ArtifactKind, type ArtifactRef } from '../types/artifacts';
import type { Connection, FlowNode, Project } from '../types/project';

/**
 * Batch Select: any number of batches in, the items you pick out.
 *
 * Wire in as many folders or batches as you like — a Shot Split's clips, the
 * backgrounds a Video Background made of each shot, a folder of drawings —
 * and every item of every one is listed together. Untick the ones you do not
 * want; what is ticked goes out on **Selected**, as one folder, and so on down
 * the graph as one batch, and the rest go out on **The rest**.
 *
 * An item is known by the flow and port it came from and its own key, so a
 * choice stays with the item when the batch is made again, and an item that
 * was not there before arrives ticked: it is the unticked ones that are kept.
 */
export interface BatchSelectFlowData {
  editor: 'batchSelect';
  /** Items left out, by `selectKey`. */
  excluded: string[];
  /** Only items whose name holds this are listed (it does not change what is chosen). */
  filter: string;
}

export function emptyBatchSelectFlowData(): BatchSelectFlowData {
  return { editor: 'batchSelect', excluded: [], filter: '' };
}

export interface SelectableItem {
  /** Stable: the source flow, its port, and the item's own key. */
  key: string;
  label: string;
  /** The file name it is written under, unique across everything selected. */
  fileName: string;
  /** What it is (`image`, `video`, `audio`); missing while it has not been made. */
  kind?: ArtifactKind;
  artifact?: ArtifactRef;
}

export interface SelectSource {
  connection: Connection;
  source: FlowNode;
  items: SelectableItem[];
}

export function selectKey(connection: Pick<Connection, 'from'>, itemKey: string): string {
  return `${connection.from.nodeId}:${connection.from.portId}/${itemKey}`;
}

/** Every wire into Items, and its items, in the order the wires were made. */
export function selectSources(project: Project, node: FlowNode): SelectSource[] {
  const sources: SelectSource[] = [];
  const taken = new Set<string>();
  for (const connection of connectionsInto(project, node.id)) {
    if (connection.to.portId !== 'items' || !connection.settings.enabled) continue;
    const source = nodeById(project, connection.from.nodeId);
    if (!source) continue;
    const items = connectionItems(project, connection).map((item): SelectableItem => {
      const kind = item.artifact ? (SET_ITEM_KIND[item.artifact.kind] ?? item.artifact.kind) : undefined;
      // Two wires may each have a shot-01.webm: the second is named for where it came from.
      // An item of a batch is named for the item it is, with its own file's
      // extension: each of a Video Background's backgrounds is background.png,
      // but they are the backgrounds of shot-01, shot-02, ….
      const own = item.artifact?.fileName;
      const extension = own?.match(/\.[^.]+$/)?.[0] ?? '';
      const base = !own || own === item.key ? item.key : `${item.key.replace(/\.[^.]+$/, '')}${extension}`;
      let fileName = base;
      if (taken.has(fileName)) fileName = `${source.name.replace(/[^A-Za-z0-9._-]+/g, '-')}-${base}`;
      for (let n = 2; taken.has(fileName); n += 1) fileName = base.replace(/(\.[^.]+)?$/, `-${n}$1`);
      taken.add(fileName);
      return { key: selectKey(connection, item.key), label: item.label, fileName, ...(kind ? { kind } : {}), ...(item.artifact ? { artifact: item.artifact } : {}) };
    });
    sources.push({ connection, source, items });
  }
  return sources;
}

export function isSelected(data: BatchSelectFlowData, key: string): boolean {
  return !data.excluded.includes(key);
}

/** Tick or untick some items. */
export function setSelected(data: BatchSelectFlowData, keys: readonly string[], selected: boolean): BatchSelectFlowData {
  const excluded = new Set(data.excluded);
  for (const key of keys) {
    if (selected) excluded.delete(key);
    else excluded.add(key);
  }
  return { ...data, excluded: [...excluded] };
}

/** Flip every item listed. */
export function invertSelected(data: BatchSelectFlowData, keys: readonly string[]): BatchSelectFlowData {
  const excluded = new Set(data.excluded);
  for (const key of keys) {
    if (excluded.has(key)) excluded.delete(key);
    else excluded.add(key);
  }
  return { ...data, excluded: [...excluded] };
}

/** Items whose name holds the filter, ignoring case. */
export function itemMatchesFilter(item: SelectableItem, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  return !wanted || item.label.toLowerCase().includes(wanted) || item.fileName.toLowerCase().includes(wanted);
}

export interface SelectSplit {
  selected: SelectableItem[];
  rest: SelectableItem[];
  /** Ticked, but not made yet upstream, so not written. */
  waiting: SelectableItem[];
  /** The kind the folders are written as: that of the first item made. */
  kind?: ArtifactKind;
  /** Made, but of another kind than the first, so not written. */
  otherKind: SelectableItem[];
}

/** What goes out on each port. A folder holds one kind of file, so other kinds are set aside. */
export function splitSelection(project: Project, node: FlowNode, data: BatchSelectFlowData): SelectSplit {
  const all = selectSources(project, node).flatMap((source) => source.items);
  const kind = all.find((item) => item.kind)?.kind;
  const split: SelectSplit = { selected: [], rest: [], waiting: [], otherKind: [], ...(kind ? { kind } : {}) };
  for (const item of all) {
    if (!item.artifact) {
      if (isSelected(data, item.key)) split.waiting.push(item);
      continue;
    }
    if (item.kind !== kind) {
      split.otherKind.push(item);
      continue;
    }
    (isSelected(data, item.key) ? split.selected : split.rest).push(item);
  }
  return split;
}

/** The folder kind a set of items of this kind goes out as. */
export function folderKindOf(kind: ArtifactKind): ArtifactKind {
  return ITEM_SET_KIND[kind] ?? kind;
}

export function summariseSelection(split: SelectSplit): string {
  const parts = [`${split.selected.length} selected`, `${split.rest.length} left out`];
  if (split.waiting.length > 0) parts.push(`${split.waiting.length} not made yet`);
  if (split.otherKind.length > 0) parts.push(`${split.otherKind.length} of another kind set aside`);
  return parts.join(' · ');
}
