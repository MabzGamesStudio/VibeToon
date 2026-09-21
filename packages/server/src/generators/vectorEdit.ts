import {
  editState,
  summariseVector,
  toSvg,
  type VectorEditFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The edited vector image.
 *
 * Unlike every other flow here, what this writes is not derived from its input —
 * it *is* its input, with the edits made on top. That is the whole point: a
 * decomposition is a starting guess and the edits are the work, so they are kept
 * rather than recomputed, and an upstream change is reported rather than allowed
 * to quietly throw them away.
 */
export async function generateVectorEdit(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VectorEditFlowData;

  const input = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'vector' && candidate.artifact !== undefined,
  );
  if (!input?.artifact) {
    ctx.warn('No vector wired in — connect a Polygon Decomposition flow to the Vector input.');
    return { outputs: [] };
  }

  const state = editState(data, input.artifact.hash);
  if (state === 'none') {
    ctx.warn(
      `Nothing has been taken in to edit yet. Open this flow's editor and press “Take it in”.`,
    );
    return { outputs: [] };
  }
  if (state === 'stale') {
    ctx.warn(
      `${input.sourceNode.name} has changed since these edits were made. They are kept — open this flow's editor to take the new one in, which replaces them, or generate anyway to keep what you have.`,
    );
  }

  const image = data.image!;
  const summary = summariseVector(image);

  ctx.log(
    `${summary.shapes} shape(s) after ${data.edits} edit(s): ${summary.polygons} polygon(s), ${summary.lines} line(s).`,
  );
  if (summary.concave > 0) {
    ctx.warn(
      `${summary.concave} polygon(s) are no longer convex. Dragging a point can do that, and anything downstream relying on convexity should know.`,
    );
  }
  if (summary.shapes === 0) {
    ctx.warn('Everything has been deleted, so the drawing is empty.');
  }

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'vector',
      kind: 'json',
      fileName: 'vector.json',
      content: `${JSON.stringify(image, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'svg',
      kind: 'image',
      fileName: 'vector.svg',
      content: toSvg(image),
    }),
  ];
  return { outputs };
}
