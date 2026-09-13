import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSignature,
  createsCycle,
  flowStatus,
  missingRequiredInputs,
  staleNodes,
  topoOrder,
  validateConnection,
} from '../src/graph/graph';
import { createConnection, createNode } from '../src/project/factory';
import { createStarterProject } from '../src/project/seed';
import { formatDialogText, DEFAULT_DURATION_OPTIONS } from '../src/flows/dialog';
import type { DialogFlowData, Project } from '../src/types/project';

function starter(): { project: Project; dialogId: string; boardId: string } {
  const project = createStarterProject('test');
  return { project, dialogId: project.nodes[0]!.id, boardId: project.nodes[1]!.id };
}

test('the starter project is a dialog flow wired to a storyboard flow', () => {
  const { project } = starter();
  assert.equal(project.nodes.length, 2);
  assert.equal(project.nodes[0]!.kind, 'story.dialog');
  assert.equal(project.nodes[1]!.kind, 'animation.storyboard');
  assert.equal(project.connections.length, 1);
  assert.equal(project.connections[0]!.from.portId, 'dialog');
  assert.equal(project.connections[0]!.to.portId, 'dialog');
  assert.match(project.connections[0]!.rules, /panel per: beat/);
});

test('port types are checked when connecting', () => {
  const { project, dialogId, boardId } = starter();
  const ok = validateConnection(
    project,
    { nodeId: dialogId, portId: 'scenes' },
    { nodeId: boardId, portId: 'dialog' },
  );
  assert.equal(ok.ok, true);

  const wrongKind = validateConnection(
    project,
    { nodeId: dialogId, portId: 'dialog' },
    { nodeId: boardId, portId: 'sets' },
  );
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.reason ?? '', /accepts/);

  const duplicate = validateConnection(
    project,
    { nodeId: dialogId, portId: 'dialog' },
    { nodeId: boardId, portId: 'dialog' },
  );
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason ?? '', /already exists/);

  const selfEdge = validateConnection(
    project,
    { nodeId: dialogId, portId: 'dialog' },
    { nodeId: dialogId, portId: 'outline' },
  );
  assert.equal(selfEdge.ok, false);
});

test('cycles are refused', () => {
  const { project, dialogId, boardId } = starter();
  assert.equal(createsCycle(project, dialogId, boardId), false);
  const back = validateConnection(
    project,
    { nodeId: boardId, portId: 'storyboard' },
    { nodeId: dialogId, portId: 'outline' },
  );
  assert.equal(back.ok, false);
  assert.match(back.reason ?? '', /loop/);
});

test('topological order puts upstream flows first', () => {
  const { project, dialogId, boardId } = starter();
  const outline = createNode('story.outline', { x: 0, y: 0 });
  project.nodes.push(outline);
  project.connections.push(
    createConnection({ nodeId: outline.id, portId: 'outline' }, { nodeId: dialogId, portId: 'outline' }),
  );
  const { order, cyclic } = topoOrder(project);
  assert.deepEqual(cyclic, []);
  assert.ok(order.indexOf(outline.id) < order.indexOf(dialogId));
  assert.ok(order.indexOf(dialogId) < order.indexOf(boardId));
});

test('required inputs are reported when nothing is wired in', () => {
  const { project, boardId } = starter();
  const board = project.nodes.find((n) => n.id === boardId)!;
  assert.deepEqual(missingRequiredInputs(project, board), []);

  project.connections = [];
  assert.deepEqual(
    missingRequiredInputs(project, board).map((p) => p.id),
    ['dialog'],
  );
});

test('a flow goes stale when its own data or an upstream artifact changes', () => {
  const { project, dialogId, boardId } = starter();
  const dialogNode = project.nodes.find((n) => n.id === dialogId)!;
  const board = project.nodes.find((n) => n.id === boardId)!;

  assert.equal(flowStatus(project, dialogNode), 'empty');

  // Pretend both flows just generated.
  const text = formatDialogText(dialogNode.data as DialogFlowData, 'test');
  dialogNode.outputs = [
    {
      port: 'dialog',
      kind: 'text',
      fileName: 'dialog.txt',
      path: `artifacts/${dialogId}/dialog.txt`,
      hash: 'aaaa1111',
      bytes: text.length,
      generatedAt: new Date().toISOString(),
    },
  ];
  dialogNode.lastRun = { at: new Date().toISOString(), signature: computeSignature(project, dialogNode), log: [] };
  board.outputs = [];
  board.lastRun = { at: new Date().toISOString(), signature: computeSignature(project, board), log: [] };
  assert.equal(flowStatus(project, dialogNode), 'ready');
  assert.equal(flowStatus(project, board), 'empty', 'no outputs yet means empty, not ready');

  board.outputs = [
    {
      port: 'storyboard',
      kind: 'json',
      fileName: 'storyboard.json',
      path: `artifacts/${boardId}/storyboard.json`,
      hash: 'bbbb2222',
      bytes: 2,
      generatedAt: new Date().toISOString(),
    },
  ];
  board.lastRun = { at: new Date().toISOString(), signature: computeSignature(project, board), log: [] };
  assert.equal(flowStatus(project, board), 'ready');

  // Editing the dialog invalidates the dialog flow, and regenerating it (new
  // artifact hash) invalidates the storyboard downstream.
  (dialogNode.data as DialogFlowData).logline = 'changed';
  assert.equal(flowStatus(project, dialogNode), 'stale');
  assert.equal(flowStatus(project, board), 'ready', 'downstream only moves when the artifact changes');

  dialogNode.outputs[0]!.hash = 'cccc3333';
  assert.equal(flowStatus(project, board), 'stale');

  // Changing the rules on the wire is enough on its own.
  board.lastRun = { at: new Date().toISOString(), signature: computeSignature(project, board), log: [] };
  assert.equal(flowStatus(project, board), 'ready');
  project.connections[0]!.rules = 'panel per: line';
  assert.equal(flowStatus(project, board), 'stale');

  assert.deepEqual(
    staleNodes(project).map((n) => n.id),
    [dialogId, boardId],
    'stale flows come back in dependency order',
  );
  void DEFAULT_DURATION_OPTIONS;
});
