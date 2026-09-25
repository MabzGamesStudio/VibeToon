import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COALESCE_MS,
  GRAPH_SCOPE,
  diffProject,
  emptyHistory,
  nextRedo,
  nextUndo,
  record,
  redo,
  seal,
  undo,
  type History,
} from '../src/project/history';
import { createConnection, createNode, createProject } from '../src/project/factory';
import type { FlowNode, Project } from '../src/types/project';
import type { TimelineFlowData } from '../src/flows/timeline';
import type { WorldMapFlowData } from '../src/flows/worldMap';

function setup(): Project {
  const project = createProject('History');
  const timeline = createNode('story.timeline', { x: 0, y: 0 }, 'Timeline');
  const map = createNode('world.map', { x: 300, y: 0 }, 'Map');
  timeline.id = 'tl';
  map.id = 'map';
  return { ...project, nodes: [timeline, map] };
}

const node = (project: Project, id: string) => project.nodes.find((one) => one.id === id)!;

function setData<T>(project: Project, id: string, change: (data: T) => T): Project {
  return { ...project, nodes: project.nodes.map((one) => (one.id === id ? { ...one, data: change(one.data as T) as FlowNode['data'] } : one)) };
}

const addEvent = (title: string) => (data: TimelineFlowData): TimelineFlowData => ({
  ...data,
  events: [...data.events, { id: title, title, details: '', places: [], characters: [], tags: [], dialog: [] } as unknown as TimelineFlowData['events'][number]],
});

/** Apply changes one after another, recording each, as the studio does. */
function run(start: Project, steps: Array<{ change: (project: Project) => Project; now: number; gesture?: number | null }>): { project: Project; history: History } {
  let project = start;
  let history = emptyHistory();
  for (const step of steps) {
    const next = step.change(project);
    history = record(history, project, next, { now: step.now, gesture: step.gesture ?? null });
    project = next;
  }
  return { project, history };
}

test('an edit in a flow is a step in that flow, and undo puts it back', () => {
  const start = setup();
  const { project, history } = run(start, [{ change: (p) => setData(p, 'tl', addEvent('Heist')), now: 0 }]);
  assert.equal(history.done.length, 1);
  assert.equal(history.done[0]!.scope, 'tl');
  assert.equal(history.done[0]!.label, 'Timeline: events');
  const back = undo(history, project, 'tl')!;
  assert.equal((node(back.project, 'tl').data as TimelineFlowData).events.length, 0);
  const again = redo(back.history, back.project, 'tl')!;
  assert.equal((node(again.project, 'tl').data as TimelineFlowData).events[0]!.title, 'Heist');
});

test('undo inside a flow only walks back that flow; on the graph it is the last change anywhere', () => {
  const { project, history } = run(setup(), [
    { change: (p) => setData(p, 'tl', addEvent('One')), now: 0 },
    { change: (p) => setData<WorldMapFlowData>(p, 'map', (data) => ({ ...data, settings: { ...data.settings, seed: 'other' } })), now: 5000 },
  ]);
  assert.equal(nextUndo(history, project, 'tl')!.scope, 'tl');
  const inTimeline = undo(history, project, 'tl')!;
  assert.equal((node(inTimeline.project, 'map').data as WorldMapFlowData).settings.seed, 'other', 'the map edit is untouched');
  assert.equal((node(inTimeline.project, 'tl').data as TimelineFlowData).events.length, 0);
  const onGraph = undo(history, project, null)!;
  assert.equal(onGraph.entry.scope, 'map');
});

test('typing is one step, a pause makes a new one, and a drag is one step however long', () => {
  const typed = run(setup(), [
    { change: (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'tl' ? { ...n, notes: 'a' } : n)) }), now: 0 },
    { change: (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'tl' ? { ...n, notes: 'ab' } : n)) }), now: 200 },
    { change: (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'tl' ? { ...n, notes: 'abc' } : n)) }), now: 400 },
    { change: (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'tl' ? { ...n, notes: 'abcd' } : n)) }), now: 400 + COALESCE_MS + 1 },
  ]);
  assert.equal(typed.history.done.length, 2);
  assert.equal(node(undo(typed.history, typed.project, 'tl')!.project, 'tl').notes, 'abc');

  const moves = Array.from({ length: 30 }, (_, index) => ({
    change: (p: Project) => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'map' ? { ...n, position: { x: 300 + index, y: index } } : n)) }),
    now: index * 5000,
    gesture: 7,
  }));
  const dragged = run(setup(), moves);
  assert.equal(dragged.history.done.length, 1, 'one drag, one step, even over minutes');
  assert.equal(dragged.history.done[0]!.label, 'Move Map');
  assert.deepEqual(node(undo(dragged.history, dragged.project, null)!.project, 'map').position, { x: 300, y: 0 });
});

test('two clicks are two steps even in quick succession, once sealed between', () => {
  const start = setup();
  let history = emptyHistory();
  const one = setData(start, 'tl', addEvent('A'));
  history = record(history, start, one, { now: 0, gesture: 1 });
  history = seal(history);
  const two = setData(one, 'tl', addEvent('B'));
  history = record(history, one, two, { now: 100, gesture: 2 });
  assert.equal(history.done.length, 2);
});

test('selection is carried with a step and the view is left where it is', () => {
  const start = setup();
  const withEvent = setData(start, 'tl', addEvent('A'));
  let history = record(emptyHistory(), start, withEvent, { now: 0, gesture: null });
  // Selecting and scrolling are not steps.
  const selected = setData<TimelineFlowData>(withEvent, 'tl', (data) => ({ ...data, selected: 'A', view: { from: 1, to: 2 } }));
  history = record(history, withEvent, selected, { now: 5000, gesture: null });
  assert.equal(history.done.length, 1);
  const deleted = setData<TimelineFlowData>(selected, 'tl', (data) => ({ ...data, events: [], selected: undefined }));
  history = record(history, selected, deleted, { now: 9000, gesture: null });
  const scrolled = setData<TimelineFlowData>(deleted, 'tl', (data) => ({ ...data, view: { from: 5, to: 6 } }));
  history = record(history, deleted, scrolled, { now: 9500, gesture: null });
  const back = undo(history, scrolled, 'tl')!;
  const data = node(back.project, 'tl').data as TimelineFlowData;
  assert.equal(data.events.length, 1);
  assert.equal(data.selected, 'A', 'the undone delete comes back selected');
  assert.deepEqual(data.view, { from: 5, to: 6 }, 'the view stays where it was scrolled to');
});

test('removing a flow undoes with its data, files and wiring, and redoes', () => {
  let start = setup();
  const connection = createConnection({ nodeId: 'map', portId: 'locations' }, { nodeId: 'tl', portId: 'places' });
  start = { ...start, connections: [connection] };
  start = setData(start, 'tl', addEvent('Kept'));
  const removed: Project = { ...start, nodes: start.nodes.filter((n) => n.id !== 'tl'), connections: [] };
  const history = record(emptyHistory(), start, removed, { now: 0, gesture: 1 });
  assert.equal(history.done[0]!.scope, GRAPH_SCOPE);
  assert.equal(history.done[0]!.label, 'Remove Timeline');
  assert.equal(nextUndo(history, removed, 'tl'), undefined, 'not a step of the flow, which is gone');
  const back = undo(history, removed, null)!;
  assert.equal(back.project.nodes.length, 2);
  assert.equal((node(back.project, 'tl').data as TimelineFlowData).events[0]!.title, 'Kept');
  assert.equal(back.project.connections.length, 1);
  const again = redo(back.history, back.project, null)!;
  assert.equal(again.project.nodes.length, 1);
});

test('undoing a graph step leaves later edits inside flows alone', () => {
  const { project, history } = run(setup(), [
    { change: (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'map' ? { ...n, position: { x: 999, y: 9 } } : n)) }), now: 0, gesture: 1 },
    { change: (p) => setData(p, 'tl', addEvent('Later')), now: 5000 },
  ]);
  const graphStep = history.done.find((entry) => entry.scope === GRAPH_SCOPE)!;
  assert.ok(graphStep);
  // Walk back just the graph: the timeline's later event survives.
  const graphOnly = undo(history, project, GRAPH_SCOPE)!;
  assert.deepEqual(node(graphOnly.project, 'map').position, { x: 300, y: 0 });
  assert.equal((node(graphOnly.project, 'tl').data as TimelineFlowData).events.length, 1);
});

test('what the server keeps — the revision, files, last run — is never rolled back', () => {
  const start = setup();
  const edited = setData(start, 'tl', addEvent('A'));
  const history = record(emptyHistory(), start, edited, { now: 0, gesture: null });
  const saved: Project = {
    ...edited,
    revision: 42,
    nodes: edited.nodes.map((n) => (n.id === 'tl' ? { ...n, outputs: [{ portId: 'timeline' } as unknown as FlowNode['outputs'][number]], lastRun: { at: 'x', signature: 's', log: [] } } : n)),
  };
  const back = undo(history, saved, 'tl')!;
  assert.equal(back.project.revision, 42);
  assert.equal(node(back.project, 'tl').outputs.length, 1);
  assert.equal(node(back.project, 'tl').lastRun?.signature, 's');
});

test('a new change drops the redo of its own flow but not of another', () => {
  const { project, history } = run(setup(), [
    { change: (p) => setData(p, 'tl', addEvent('A')), now: 0 },
    { change: (p) => setData<WorldMapFlowData>(p, 'map', (data) => ({ ...data, settings: { ...data.settings, seed: 'x' } })), now: 5000 },
  ]);
  let step = undo(history, project, 'tl')!;
  step = undo(step.history, step.project, 'map')!;
  assert.equal(step.history.undone.length, 2);
  const after = setData(step.project, 'tl', addEvent('B'));
  const next = record(step.history, step.project, after, { now: 10000, gesture: null });
  assert.equal(nextRedo(next, after, 'tl'), undefined);
  assert.equal(nextRedo(next, after, 'map')!.scope, 'map');
});

test('a change to nothing but server bookkeeping, or to nothing at all, is not a step', () => {
  const start = setup();
  const same: Project = { ...start, revision: 9, nodes: start.nodes.map((n) => ({ ...n, data: structuredClone(n.data), outputs: [] })) };
  assert.equal(record(emptyHistory(), start, same, { now: 0, gesture: null }).done.length, 0);
  const change = diffProject(start, { ...start, view: { pan: { x: 5, y: 5 }, zoom: 2 } });
  assert.equal(change.graph.length + change.nodes.size, 0);
});

test('a generate or sync that changes data is a step of its own, under its own name', () => {
  const start = setup();
  const typed = setData(start, 'tl', addEvent('A'));
  let history = record(emptyHistory(), start, typed, { now: 0, gesture: null });
  const synced = setData(typed, 'tl', addEvent('From upstream'));
  history = record(history, typed, synced, { now: 10, gesture: null, label: 'Sync Timeline', apart: true });
  assert.equal(history.done.length, 2);
  assert.equal(history.done[1]!.label, 'Sync Timeline');
});

test('connections and project settings are graph steps with readable names', () => {
  const start = setup();
  const connection = createConnection({ nodeId: 'map', portId: 'locations' }, { nodeId: 'tl', portId: 'places' });
  const wired = { ...start, connections: [connection] };
  let history = record(emptyHistory(), start, wired, { now: 0, gesture: 1 });
  assert.equal(history.done[0]!.label, 'Connect Map → Timeline');
  const renamed = { ...wired, settings: { ...wired.settings, fps: 12 } };
  history = record(seal(history), wired, renamed, { now: 10, gesture: null });
  assert.equal(history.done[1]!.label, 'Project fps');
});
