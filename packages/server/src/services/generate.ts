import path from 'node:path';
import {
  computeSignature,
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
import { HttpError, loadProject, readArtifactText, saveProjectUnchecked } from '../storage';

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

async function runOne(
  project: Project,
  flowId: string,
  attachments: Attachment[],
): Promise<{ project: Project; run: GenerationRun }> {
  const node = nodeById(project, flowId);
  if (!node) throw new HttpError(404, `No flow ${flowId} in this project`);
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
      if (artifact.kind === 'imageSet' || artifact.kind === 'audioSet') {
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

  let run: GenerationRun;
  let updated = project;

  try {
    const result = await generatorFor(node.kind)(ctx);
    const nextNode = {
      ...node,
      data: result.data ?? node.data,
      outputs: mergeOutputs(node.outputs, result.outputs),
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
    updated = withNode;
    run = {
      flowId,
      flowName: node.name,
      ok: true,
      log,
      warnings,
      outputs: nextNode.outputs,
      startedAt,
      ms: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const nextNode = {
      ...node,
      lastRun: {
        at: startedAt,
        signature: '',
        log,
        ...(warnings.length > 0 ? { warnings } : {}),
        error: message,
      },
    };
    updated = {
      ...project,
      nodes: project.nodes.map((candidate) => (candidate.id === flowId ? nextNode : candidate)),
    };
    run = {
      flowId,
      flowName: node.name,
      ok: false,
      log,
      warnings,
      outputs: node.outputs,
      error: message,
      startedAt,
      ms: Date.now() - started,
    };
  }

  return { project: updated, run };
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
): Promise<{ project: Project; runs: GenerationRun[] }> {
  const project = await loadProject(projectId);
  const { project: updated, run } = await runOne(project, flowId, attachments);
  const saved = await saveProjectUnchecked(updated);
  return { project: saved, runs: [run] };
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
    const result = await runOne(project, flowId, []);
    project = result.project;
    runs.push(result.run);
  }
  const saved = await saveProjectUnchecked(project);
  return { project: saved, runs };
}
