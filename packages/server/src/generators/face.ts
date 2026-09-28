import {
  FACE_FEATURES,
  composeFeature,
  composeHead,
  facePartsFile,
  fileNameOf,
  summariseFace,
  toSvg,
  type FaceFlowData,
} from '@vibetoon/shared';
import { writeArtifact, writeArtifactSet } from '../storage';
import { uniqueNames } from './parts';
import type { GenerationContext, GenerationResult } from './types';

/**
 * Heads, taken apart into the features of a face.
 *
 * The features are found and adjusted in the editor; this writes them as set
 * there — hidden ones left out, swapped ones fitted in, nudges applied: every
 * feature's shapes, each head put back together, and one drawing per feature.
 */
export async function generateFace(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as FaceFlowData;
  const inputs = ctx.inputs.filter((candidate) => candidate.connection.to.portId === 'heads' && candidate.artifact !== undefined);
  if (inputs.length === 0) {
    ctx.warn('No heads wired in — connect a Rig Parts flow, or a vector drawing of a head, to the Heads input.');
    return { outputs: [] };
  }
  if (data.heads.length === 0) {
    ctx.warn('Nothing taken in yet. Open this flow’s editor and press “Take them in”.');
    return { outputs: [] };
  }
  const hashes = new Map(inputs.map((input) => [input.sourceNode.id, input.artifact!.hash]));
  const stale = data.heads.filter((head) => head.source.hash && hashes.has(head.source.node) && hashes.get(head.source.node) !== head.source.hash);
  if (stale.length > 0) ctx.warn(`${stale.map((head) => head.name).join(', ')} changed upstream since being taken in; written as they are here.`);

  const headNames = uniqueNames(data.heads.map((head) => fileNameOf(head.name, head.id)));
  const featureFiles: Array<{ name: string; content: string }> = [];
  data.heads.forEach((head, index) => {
    for (const feature of FACE_FEATURES) {
      const shapes = composeFeature(data, head, feature);
      if (shapes.length === 0) continue;
      featureFiles.push({ name: `${headNames[index]}-${feature}.svg`, content: toSvg({ width: head.image.width, height: head.image.height, shapes }) });
    }
  });
  ctx.log(summariseFace(data));

  return {
    outputs: [
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'features', kind: 'json', fileName: 'face.json', content: `${JSON.stringify(facePartsFile(data), null, 2)}\n` }),
      await writeArtifactSet({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'faces',
        kind: 'imageSet',
        dirName: 'faces',
        files: data.heads.map((head, index) => ({ name: `${headNames[index]}.svg`, content: toSvg(composeHead(data, head)) })),
      }),
      await writeArtifactSet({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'parts', kind: 'imageSet', dirName: 'features', files: featureFiles }),
    ],
  };
}
