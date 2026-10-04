import path from 'node:path';
import {
  batchItems,
  batchOutputs,
  batchSignature,
  computeSignature,
  flowStatus,
  isBatchNode,
  isCustomNode,
  itemFolder,
  itemView,
  type FlowNode,
  membersOf,
  topoOrder,
  missingRequiredInputs,
  nodeById,
  resolveInputs,
  staleNodes,
  requireFlowKind,
  type ArtifactRef,
  type GenerationRun,
  type Project,
  type ResolvedInput,
} from '@vibetoon/shared';
import { generatorFor } from '../generators';
import { TRUNCATION_MARK, type Attachment, type GenerationContext } from '../generators/types';
import { HttpError, inItemFolder, loadProject, readArtifactText, saveProjectUnchecked } from '../storage';

const UPSTREAM_READ_LIMIT = 8000;


/**
 * Outputs from ports this run did not write are kept. That matters for ports
 * whose file you uploaded by hand (a character design, a voice take): a
 * regenerate refreshes the text artifacts without dropping them.
 */
function mergeOutputs(previous: ArtifactRef[], next: ArtifactRef[]): ArtifactRef[] {
  const byPort = new Map(previous.map((ref) => [ref.port, ref]));
  for (const ref of next) byPort.set(ref.port, ref);
  return [...byPort.values()].sort((a, b) => (a.port < b.port ? -1 : a.port > b.port ? 1 : 0));
}

/**
 * Run a flow's generator on a project — the real one, or the view one item of
 * a batch flow sees — and give back the flow as it is after the run.
 */
async function runGenerator(
  project: Project,
  node: FlowNode,
  attachments: Attachment[],
): Promise<{ node: FlowNode; run: GenerationRun }> {
  const flowId = node.id;
  const def = requireFlowKind(node.kind);

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const log: string[] = [];
  const warnings: string[] = [];

  for (const port of missingRequiredInputs(project, node)) {
    warnings.push(`Required input "${port.label}" has nothing wired into it.`);
  }

  const inputs = resolveInputs(project, flowId).filter((input) => input.connection.settings.enabled);

  const ctx: GenerationContext = {
    project,
    node,
    def,
    inputs,
    attachments,
    log: (message) => log.push(message),
    warn: (message) => warnings.push(message),
    readUpstream: async (input: ResolvedInput, limit = UPSTREAM_READ_LIMIT) => {
      const artifact = input.artifact;
      if (!artifact) return undefined;
      if (artifact.kind === 'imageSet' || artifact.kind === 'audioSet' || artifact.kind === 'videoSet') {
        return `[${artifact.entries?.length ?? 0} file(s) in ${artifact.path}]`;
      }
      try {
        const text = await readArtifactText(project.id, artifact.path);
        return text.length > limit ? `${text.slice(0, limit)}\n${TRUNCATION_MARK}` : text;
      } catch {
        return undefined;
      }
    },
  };

  try {
    const result = await generatorFor(node.kind)(ctx);
    const nextNode: FlowNode = {
      ...node,
      data: result.data ?? node.data,
      outputs: mergeOutputs(node.outputs.filter((ref) => !result.cleared?.includes(ref.port)), result.outputs),
    };
    const withNode: Project = {
      ...project,
      nodes: project.nodes.map((candidate) => (candidate.id === flowId ? nextNode : candidate)),
    };
    nextNode.lastRun = {
      at: startedAt,
      signature: computeSignature(withNode, nextNode),
      log,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return {
      node: nextNode,
      run: { flowId, flowName: node.name, ok: true, log, warnings, outputs: nextNode.outputs, startedAt, ms: Date.now() - started },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      node: {
        ...node,
        lastRun: { at: startedAt, signature: '', log, ...(warnings.length > 0 ? { warnings } : {}), error: message },
      },
      run: { flowId, flowName: node.name, ok: false, log, warnings, outputs: node.outputs, error: message, startedAt, ms: Date.now() - started },
    };
  }
}

const replaceNode = (project: Project, node: FlowNode): Project => ({
  ...project,
  nodes: project.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)),
});

export interface RunOptions {
  /** For a batch flow: run this item alone. */
  item?: string;
  /** For a batch flow: run only the items that are not up to date. */
  onlyStale?: boolean;
}

async function runOne(
  project: Project,
  flowId: string,
  attachments: Attachment[],
  options: RunOptions = {},
): Promise<{ project: Project; runs: GenerationRun[] }> {
  const node = nodeById(project, flowId);
  if (!node) throw new HttpError(404, `No flow ${flowId} in this project`);
  if (isBatchNode(project, node)) return runBatch(project, node, attachments, options);
  const { node: done, run } = await runGenerator(project, node, attachments);
  return { project: replaceNode(project, done), runs: [run] };
}

/**
 * Run a batch flow: each item as though it alone were wired in, its files in a
 * folder of its own. Then the flow's outputs are gathered from its items.
 * Files sent with the request are for the one item named, the one the editor
 * made them for.
 */
async function runBatch(
  project: Project,
  node: FlowNode,
  attachments: Attachment[],
  options: RunOptions,
): Promise<{ project: Project; runs: GenerationRun[] }> {
  const items = batchItems(project, node);
  if (options.item !== undefined && !items.some((item) => item.key === options.item)) {
    throw new HttpError(404, `No item ${options.item} in ${node.name}'s batch.`);
  }
  const startedAt = new Date().toISOString();
  let current = project;
  let flow = node;
  const runs: GenerationRun[] = [];
  for (const item of items) {
    if (options.item !== undefined && item.key !== options.item) continue;
    const view = itemView(current, flow, item.key);
    if (options.onlyStale && flowStatus(view.project, view.node) === 'ready') continue;
    const { node: done, run } = await inItemFolder(node.id, itemFolder(item.key), () =>
      runGenerator(view.project, view.node, item.key === options.item ? attachments : []),
    );
    const before = flow.batch?.items[item.key];
    // Settings a generator changed become the item's own, unless they are the shared ones.
    const changed = done.data !== view.node.data && JSON.stringify(done.data) !== JSON.stringify(flow.data);
    const data = changed ? done.data : before?.data;
    flow = {
      ...flow,
      batch: {
        items: {
          ...(flow.batch?.items ?? {}),
          [item.key]: { ...(data !== undefined ? { data } : {}), outputs: done.outputs, ...(done.lastRun ? { lastRun: done.lastRun } : {}) },
        },
      },
    };
    current = replaceNode(current, flow);
    runs.push({ ...run, flowName: `${node.name} · ${item.label}`, item: item.key });
  }
  // A whole run lets go of items no longer in the batch.
  if (options.item === undefined && !options.onlyStale && flow.batch) {
    const keep = new Set(items.map((item) => item.key));
    flow = { ...flow, batch: { items: Object.fromEntries(Object.entries(flow.batch.items).filter(([key]) => keep.has(key))) } };
    current = replaceNode(current, flow);
  }
  flow = { ...flow, outputs: batchOutputs(current, flow) };
  current = replaceNode(current, flow);
  const failed = Object.values(flow.batch?.items ?? {}).filter((state) => state.lastRun?.error).length;
  const log = [
    items.length === 0
      ? 'Nothing in the batch yet: what is wired in has made no items.'
      : `${runs.length} of ${items.length} item(s) run${failed > 0 ? `; ${failed} failed` : ''}.`,
  ];
  flow = {
    ...flow,
    lastRun: {
      at: startedAt,
      signature: batchSignature(current, flow),
      log,
      ...(failed > 0 ? { error: `${failed} of ${items.length} item(s) failed. Open the flow to see which.` } : {}),
    },
  };
  current = replaceNode(current, flow);
  if (runs.length === 0) {
    runs.push({ flowId: node.id, flowName: node.name, ok: true, log, warnings: items.length === 0 ? log : [], outputs: flow.outputs, startedAt, ms: 0 });
  }
  return { project: current, runs };
}

export interface AttachmentInput {
  name: string;
  /** base64, with or without a `data:` prefix. */
  data: string;
}

export function decodeAttachments(inputs: AttachmentInput[] | undefined): Attachment[] {
  if (!inputs) return [];
  return inputs.map((input) => {
    const normalised = path.posix.normalize(input.name);
    if (normalised.startsWith('..') || path.posix.isAbsolute(normalised)) {
      throw new HttpError(400, `Attachment name escapes the flow directory: ${input.name}`);
    }
    const comma = input.data.indexOf(',');
    const base64 = input.data.startsWith('data:') && comma >= 0 ? input.data.slice(comma + 1) : input.data;
    return { name: normalised, bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
  });
}

/** Generate one flow and persist the result. */
export async function generateFlow(
  projectId: string,
  flowId: string,
  attachments: Attachment[] = [],
  options: RunOptions = {},
): Promise<{ project: Project; runs: GenerationRun[] }> {
  const project = await loadProject(projectId);
  const node = nodeById(project, flowId);
  if (node && isCustomNode(node)) return generateInstance(project, flowId);
  const { project: updated, runs } = await runOne(project, flowId, attachments, options);
  const saved = await saveProjectUnchecked(updated);
  return { project: saved, runs };
}

/**
 * Generate a custom flow instance: every flow behind it, upstream first, so
 * each reads what the one before it made in the same pass. The instance has no
 * files of its own; its ports are its members'.
 */
async function generateInstance(project: Project, groupId: string): Promise<{ project: Project; runs: GenerationRun[] }> {
  const members = new Set(membersOf(project, groupId).map((member) => member.id));
  if (members.size === 0) throw new HttpError(400, 'That custom flow has nothing behind it to generate.');
  const order = topoOrder(project).order.filter((id) => members.has(id));
  const runs: GenerationRun[] = [];
  let current = project;
  for (const id of order) {
    const result = await runOne(current, id, []);
    current = result.project;
    runs.push(...result.runs);
  }
  const saved = await saveProjectUnchecked(current);
  return { project: saved, runs };
}

/**
 * Generate everything that needs it, upstream first, so a flow reads the
 * artifacts its inputs produced in the same pass.
 */
export async function generateProject(
  projectId: string,
): Promise<{ project: Project; runs: GenerationRun[] }> {
  let project = await loadProject(projectId);
  const queue = staleNodes(project).map((node) => node.id);
  const runs: GenerationRun[] = [];
  for (const flowId of queue) {
    // A batch flow runs only the items that need it.
    const result = await runOne(project, flowId, [], { onlyStale: true });
    project = result.project;
    runs.push(...result.runs);
  }
  const saved = await saveProjectUnchecked(project);
  return { project: saved, runs };
}
