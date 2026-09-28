import { fileNameOf, partsState, rigPartsFile, summariseParts, toSvg, type PartsFlowData, type VectorImage } from '@vibetoon/shared';
import { writeArtifact, writeArtifactSet } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/** Names that do not collide: a second "arm" becomes "arm-2". */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}-${count}`;
  });
}

/**
 * A bound drawing, in parts.
 *
 * The parts are made and edited in the editor; this writes them: every part
 * with its bone and shapes, all of them back together, and one drawing each.
 * Each part's drawing is the whole drawing's size, so they lie back over one
 * another exactly.
 */
export async function generateParts(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as PartsFlowData;
  const input = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'bound' && candidate.artifact !== undefined);
  if (!input?.artifact) {
    ctx.warn('No bound rig wired in — connect a Rig Binding flow to the Bound rig input.');
    return { outputs: [] };
  }
  const state = partsState(data, input.artifact.hash);
  const file = rigPartsFile(data);
  if (state === 'none' || !file || !data.bound) {
    ctx.warn('Nothing taken in yet. Open this flow’s editor and press “Take it in”.');
    return { outputs: [] };
  }
  if (state === 'stale') ctx.warn('The binding has changed since these parts were made. They are written as they are — take it in again to split it afresh.');

  const order = new Map(data.bound.image.shapes.map((shape, index) => [shape.id, index]));
  const together: VectorImage = {
    width: file.width,
    height: file.height,
    shapes: data.parts.flatMap((part) => part.image.shapes).sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)),
  };
  const names = uniqueNames(data.parts.map((part) => fileNameOf(part.name, part.id)));
  ctx.log(summariseParts(data));

  return {
    outputs: [
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'parts', kind: 'json', fileName: 'parts.json', content: `${JSON.stringify(file, null, 2)}\n` }),
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'drawing', kind: 'image', fileName: 'parts.svg', content: toSvg(together) }),
      await writeArtifactSet({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'images',
        kind: 'imageSet',
        dirName: 'parts',
        files: data.parts.map((part, index) => ({ name: `${names[index]}.svg`, content: toSvg(part.image) })),
      }),
    ],
  };
}
