import type { FlowNode, Project } from '../types/project';

/**
 * Undo and redo for a whole project.
 *
 * Every change to a project passes through one place in the studio, so this
 * sees all of them: an edit in any flow's editor, a node moved or wired on the
 * graph, a project setting, and the data a generate or a sync writes back. Each
 * becomes an entry holding the project before and after it — the objects
 * themselves, not copies: edits replace what they change and share the rest,
 * so a hundred entries cost little more than the changes in them.
 *
 * Entries have a scope. A change to one flow's own things — its data, its name,
 * its notes — belongs to that flow, and undo inside its editor walks back that
 * flow alone: you never undo an edit you cannot see from where you are. The
 * graph — nodes added, removed and moved, connections, project settings — is
 * one more scope, and so is a change that touches several flows at once. On the
 * graph, undo is the last change anywhere.
 *
 * What only moves the eye — where a view is scrolled to, which thing is
 * selected, which tool is in hand — is not a change worth a step. It is carried
 * along, not recorded: undoing puts back the selection that went with the
 * change (so an undone delete comes back selected) and leaves the view and the
 * tool where they are.
 */

export interface HistoryEntry {
  id: number;
  /** A flow's node id, or `graph`. */
  scope: string;
  label: string;
  before: Project;
  after: Project;
  /** Nodes whose own things (data, name, notes) this changed. */
  touched: string[];
  /** What changed, to decide whether the next change continues this one. */
  signature: string;
  /** The pointer gesture it was made in, if any. */
  gesture: number | null;
  /** When it was last added to. */
  last: number;
  /** Closed: the next change starts a new entry, whatever it is. */
  sealed: boolean;
}

export interface History {
  /** Applied, oldest first. */
  done: HistoryEntry[];
  /** Undone, most recently undone last. */
  undone: HistoryEntry[];
  seq: number;
}

export const GRAPH_SCOPE = 'graph';

/** Entries kept. The oldest go first. */
export const HISTORY_LIMIT = 200;

/** Changes to the same thing this close together are one step: typing a word is one undo, not five. */
export const COALESCE_MS = 1000;

export function emptyHistory(): History {
  return { done: [], undone: [], seq: 0 };
}

/* ------------------------------------------------------------------ *
 * What is not a step
 * ------------------------------------------------------------------ */

/**
 * Keys of a flow's data that are where you are looking, not what you made —
 * or facts about a file rather than choices.
 *
 * `keep` stays as it is now when a step is undone or redone — the view you
 * scrolled to and the tool in your hand. `restore` comes back with the step —
 * the selection. Neither makes a step when it is all that changed.
 */
const PASSIVE: { keep: Record<string, string[]>; restore: Record<string, string[]> } = {
  keep: {
    '*': ['view'],
    timeline: ['filter'],
    bind: ['brush', 'boneId', 'hideOthers'],
    pose: ['mode'],
    // Facts about a file on the server, which undo does not reach: winding
    // them back would describe a picture that is not the one there, and the
    // editor would only measure it again.
    image: ['source'],
    cutout: ['imageWidth', 'imageHeight', 'imageHash'],
  },
  restore: {
    '*': ['selected'],
  },
};

function passiveKeys(editor: string, kind: 'keep' | 'restore'): string[] {
  return [...(PASSIVE[kind]['*'] ?? []), ...(PASSIVE[kind][editor] ?? [])];
}

function isPassive(editor: string, key: string): boolean {
  return passiveKeys(editor, 'keep').includes(key) || passiveKeys(editor, 'restore').includes(key);
}

const editorOf = (node: FlowNode | undefined): string => {
  const editor = (node?.data as { editor?: unknown } | undefined)?.editor;
  return typeof editor === 'string' ? editor : '';
};

/* ------------------------------------------------------------------ *
 * What changed
 * ------------------------------------------------------------------ */

/** Structural equality that is quick when the two share parts, as immutable edits do. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameValue(a[index], other[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (keys.length !== otherKeys.length) return false;
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

export interface ProjectChange {
  /** Changes to the graph and the project: `add:id`, `remove:id`, `move:id`, `connect:id`… */
  graph: string[];
  /** Per node, which of its own things changed: `name`, `notes`, `data.<key>`. */
  nodes: Map<string, string[]>;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>, skip: (key: string) => boolean): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (skip(key)) continue;
    if (before[key] !== after[key] && !sameValue(before[key], after[key])) changed.push(key);
  }
  return changed;
}

/** What differs between two versions of a project, leaving out what the server keeps and what only moves the eye. */
export function diffProject(before: Project, after: Project): ProjectChange {
  const graph: string[] = [];
  const nodes = new Map<string, string[]>();
  if (before.name !== after.name) graph.push('name');
  if (before.settings !== after.settings) {
    for (const key of changedKeys(before.settings as unknown as Record<string, unknown>, after.settings as unknown as Record<string, unknown>, () => false)) {
      graph.push(`settings.${key}`);
    }
  }

  if (before.connections !== after.connections) {
    const was = new Map(before.connections.map((connection) => [connection.id, connection]));
    const now = new Map(after.connections.map((connection) => [connection.id, connection]));
    for (const connection of after.connections) {
      const old = was.get(connection.id);
      if (!old) graph.push(`connect:${connection.id}`);
      else if (old !== connection && !sameValue(old, connection)) graph.push(`connection:${connection.id}`);
    }
    for (const connection of before.connections) if (!now.has(connection.id)) graph.push(`disconnect:${connection.id}`);
  }

  if (before.nodes !== after.nodes) {
    const was = new Map(before.nodes.map((node) => [node.id, node]));
    const now = new Map(after.nodes.map((node) => [node.id, node]));
    for (const node of after.nodes) {
      const old = was.get(node.id);
      if (!old) {
        graph.push(`add:${node.id}`);
        continue;
      }
      if (old === node) continue;
      if (old.kind !== node.kind) graph.push(`kind:${node.id}`);
      if (old.position !== node.position && !sameValue(old.position, node.position)) graph.push(`move:${node.id}`);
      const own: string[] = [];
      if (old.name !== node.name) own.push('name');
      if (old.notes !== node.notes) own.push('notes');
      if (old.data !== node.data) {
        const editor = editorOf(node);
        for (const key of changedKeys(old.data as unknown as Record<string, unknown>, node.data as unknown as Record<string, unknown>, (key) => isPassive(editor, key))) {
          own.push(`data.${key}`);
        }
      }
      if (own.length > 0) nodes.set(node.id, own);
    }
    for (const node of before.nodes) if (!now.has(node.id)) graph.push(`remove:${node.id}`);
    const order = (list: FlowNode[]) => list.filter((node) => was.has(node.id) && now.has(node.id)).map((node) => node.id).join(',');
    if (order(before.nodes) !== order(after.nodes)) graph.push('order');
  }
  return { graph, nodes };
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

const words = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

const nodeName = (project: Project, id: string) => project.nodes.find((node) => node.id === id)?.name ?? 'a flow';

function describe(before: Project, after: Project, change: ProjectChange, scope: string): string {
  if (scope !== GRAPH_SCOPE) {
    const fields = (change.nodes.get(scope) ?? []).map((field) => words(field.replace(/^data\./, '')));
    const shown = fields.slice(0, 3).join(', ') + (fields.length > 3 ? '…' : '');
    return `${nodeName(after, scope)}: ${shown || 'edit'}`;
  }
  // The biggest thing that happened names the step: removing a flow also
  // removes its wires, and "Remove Timeline" is the step, not "Disconnect".
  const priority = ['add', 'remove', 'connect', 'disconnect', 'connection', 'move', 'kind', 'order', 'name', 'settings'];
  const rank = (item: string) => {
    const at = priority.indexOf(item.split(/[:.]/)[0]!);
    return at < 0 ? priority.length : at;
  };
  const first = [...change.graph].sort((a, b) => rank(a) - rank(b))[0] ?? '';
  const [what = '', id = ''] = first.split(':');
  const count = (prefix: string) => change.graph.filter((item) => item.startsWith(`${prefix}:`)).length;
  const connectionEnds = (project: Project) => {
    const connection = project.connections.find((one) => one.id === id);
    return connection ? `${nodeName(project, connection.from.nodeId)} → ${nodeName(project, connection.to.nodeId)}` : '';
  };
  switch (what) {
    case 'add':
      return count('add') > 1 ? `Add ${count('add')} flows` : `Add ${nodeName(after, id)}`;
    case 'remove':
      return count('remove') > 1 ? `Remove ${count('remove')} flows` : `Remove ${nodeName(before, id)}`;
    case 'move':
      return count('move') > 1 ? `Move ${count('move')} flows` : `Move ${nodeName(after, id)}`;
    case 'connect':
      return `Connect ${connectionEnds(after)}`.trim();
    case 'disconnect':
      return `Disconnect ${connectionEnds(before)}`.trim();
    case 'connection':
      return `Connection ${connectionEnds(after)}`.trim();
    case 'name':
      return 'Rename the project';
    case 'order':
      return 'Reorder flows';
    default:
      if (what.startsWith('settings.')) return `Project ${words(what.slice('settings.'.length))}`;
      if (change.nodes.size > 0) return `Edit ${[...change.nodes.keys()].map((node) => nodeName(after, node)).join(', ')}`;
      return 'Edit the graph';
  }
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

export interface RecordContext {
  now: number;
  /** The pointer gesture under way, if the pointer is down. */
  gesture: number | null;
  /** A label to use instead of the one worked out from the change. */
  label?: string;
  /** Never merge into the entry before: a generate or a sync is always its own step. */
  apart?: boolean;
}

/**
 * Note a change from `before` to `after`.
 *
 * A change continues the last entry — rather than starting one — while the
 * pointer that began it is still down (a drag, a slider, a brush stroke), or
 * when it is to the same things within a second of the last (typing).
 */
export function record(history: History, before: Project, after: Project, context: RecordContext): History {
  if (before === after) return history;
  const change = diffProject(before, after);
  if (change.graph.length === 0 && change.nodes.size === 0) return history;
  const scope = change.graph.length === 0 && change.nodes.size === 1 ? [...change.nodes.keys()][0]! : GRAPH_SCOPE;
  const touched = [...change.nodes.keys()];
  const signature = `${scope}|${[...change.graph.map((item) => item.replace(/:.*/, '')), ...[...change.nodes.entries()].map(([id, fields]) => `${id}:${fields.join('+')}`)].sort().join(',')}`;

  const last = history.done[history.done.length - 1];
  const continues =
    !context.apart &&
    last !== undefined &&
    !last.sealed &&
    last.scope === scope &&
    ((context.gesture !== null && last.gesture === context.gesture) ||
      (context.gesture === null && last.gesture === null && last.signature === signature && context.now - last.last < COALESCE_MS));

  // A new change clears what was undone in its own scope — the branch it would
  // redo no longer follows — and anything undone on the graph, which a change
  // anywhere can leave not making sense.
  const undone = history.undone.filter((entry) => entry.scope !== scope && entry.scope !== GRAPH_SCOPE && scope !== GRAPH_SCOPE);

  if (continues) {
    const merged: HistoryEntry = {
      ...last,
      after,
      touched: [...new Set([...last.touched, ...touched])],
      last: context.now,
      label: context.label ?? describe(last.before, after, diffProject(last.before, after), scope),
    };
    return { ...history, done: [...history.done.slice(0, -1), merged], undone };
  }

  const entry: HistoryEntry = {
    id: history.seq + 1,
    scope,
    label: context.label ?? describe(before, after, change, scope),
    before,
    after,
    touched,
    signature,
    gesture: context.gesture,
    last: context.now,
    sealed: Boolean(context.apart),
  };
  const done = [...history.done.map((one, index) => (index === history.done.length - 1 && !one.sealed ? { ...one, sealed: true } : one)), entry];
  return { done: done.slice(-HISTORY_LIMIT), undone, seq: history.seq + 1 };
}

/** Close the last entry, so whatever comes next is a step of its own. */
export function seal(history: History): History {
  const last = history.done[history.done.length - 1];
  if (!last || last.sealed) return history;
  return { ...history, done: [...history.done.slice(0, -1), { ...last, sealed: true }] };
}

/* ------------------------------------------------------------------ *
 * Undoing
 * ------------------------------------------------------------------ */

function mergeData(snapshot: FlowNode['data'], current: FlowNode['data']): FlowNode['data'] {
  const editor = editorOf({ data: current } as FlowNode) || editorOf({ data: snapshot } as FlowNode);
  const result = { ...(snapshot as unknown as Record<string, unknown>) };
  const live = current as unknown as Record<string, unknown>;
  for (const key of passiveKeys(editor, 'keep')) {
    if (key in live) result[key] = live[key];
    else delete result[key];
  }
  return result as unknown as FlowNode['data'];
}

/** Put one flow's own things back as they were in `snapshot`, leaving everything else as it is now. */
function restoreNode(current: Project, snapshot: Project, nodeId: string): Project {
  const was = snapshot.nodes.find((node) => node.id === nodeId);
  if (!was) return current;
  return {
    ...current,
    nodes: current.nodes.map((node) =>
      node.id === nodeId ? { ...node, name: was.name, notes: was.notes, data: mergeData(was.data, node.data) } : node,
    ),
  };
}

/**
 * Put the graph back as it was in `snapshot`.
 *
 * Which nodes there are, where they sit, the connections and the project's
 * settings all come from the snapshot. A node that is here now keeps its own
 * things as they are now — they have their own steps — unless this step
 * changed them. What the server made (files, the last run) is always as it is
 * now; a node brought back brings its own.
 */
function restoreGraph(current: Project, snapshot: Project, touched: string[]): Project {
  const live = new Map(current.nodes.map((node) => [node.id, node]));
  return {
    ...current,
    name: snapshot.name,
    settings: snapshot.settings,
    connections: snapshot.connections,
    nodes: snapshot.nodes.map((was) => {
      const node = live.get(was.id);
      if (!node) return was;
      const own = touched.includes(was.id);
      return {
        ...node,
        kind: was.kind,
        position: was.position,
        ...(own ? { name: was.name, notes: was.notes, data: mergeData(was.data, node.data) } : {}),
      };
    }),
  };
}

function applicable(entry: HistoryEntry, current: Project): boolean {
  return entry.scope === GRAPH_SCOPE || current.nodes.some((node) => node.id === entry.scope);
}

/** The step undo would take back: the last in this scope, or the last of all with no scope. */
export function nextUndo(history: History, current: Project, scope: string | null): HistoryEntry | undefined {
  for (let index = history.done.length - 1; index >= 0; index -= 1) {
    const entry = history.done[index]!;
    if (scope !== null && entry.scope !== scope) continue;
    return applicable(entry, current) ? entry : undefined;
  }
  return undefined;
}

export function nextRedo(history: History, current: Project, scope: string | null): HistoryEntry | undefined {
  for (let index = history.undone.length - 1; index >= 0; index -= 1) {
    const entry = history.undone[index]!;
    if (scope !== null && entry.scope !== scope) continue;
    return applicable(entry, current) ? entry : undefined;
  }
  return undefined;
}

export interface Stepped {
  history: History;
  project: Project;
  entry: HistoryEntry;
}

export function undo(history: History, current: Project, scope: string | null): Stepped | null {
  const entry = nextUndo(history, current, scope);
  if (!entry) return null;
  const project = entry.scope === GRAPH_SCOPE ? restoreGraph(current, entry.before, entry.touched) : restoreNode(current, entry.before, entry.scope);
  return {
    entry,
    project,
    history: {
      ...history,
      done: history.done.filter((one) => one !== entry),
      undone: [...history.undone, { ...entry, sealed: true }],
    },
  };
}

export function redo(history: History, current: Project, scope: string | null): Stepped | null {
  const entry = nextRedo(history, current, scope);
  if (!entry) return null;
  const project = entry.scope === GRAPH_SCOPE ? restoreGraph(current, entry.after, entry.touched) : restoreNode(current, entry.after, entry.scope);
  const done = seal(history).done;
  return {
    entry,
    project,
    history: { ...history, done: [...done, { ...entry, sealed: true }], undone: history.undone.filter((one) => one !== entry) },
  };
}
