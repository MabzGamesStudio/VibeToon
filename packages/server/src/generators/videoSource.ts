import { summariseVideoSource, videoSourceReport, type VideoSourceFlowData } from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The video source flow.
 *
 * The video is already on the port before a run: uploading writes it, and so
 * does fetching a link, so a run never needs the network. What a run writes is
 * the provenance: what the file is, where it came from, and who to credit.
 */
export async function generateVideoSource(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VideoSourceFlowData;
  const held = ctx.node.outputs.find((artifact) => artifact.port === 'video');
  if (!data.source || !held) {
    ctx.warn(
      data.source
        ? 'The video is recorded but its file is missing. Add it again in this flow’s editor.'
        : 'No video yet. Open this flow’s editor and either upload a file or fetch a link.',
    );
    return { outputs: [] };
  }
  ctx.log(summariseVideoSource(data.source));
  if (data.source.duration === undefined) ctx.warn('Its length and size are not known yet: open the editor to play it once.');
  return {
    outputs: [
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'source',
        kind: 'markdown',
        fileName: 'source.md',
        content: videoSourceReport(ctx.node.name, data),
      }),
    ],
  };
}
