import { shotsFile, shotsOf, shotsReport, summariseShots, videoSourceOf, type ShotsFlowData } from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A video's shots, as time segments.
 *
 * The cuts are found in the editor, where the video can be decoded, and edited
 * there; they are stored on the flow, and this writes them out.
 */
export async function generateShots(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as ShotsFlowData;
  const video = videoSourceOf(ctx.project, ctx.node);
  if (!video) {
    ctx.warn('No video — wire one into the Video input, or upload one in the editor.');
    return { outputs: [] };
  }
  if (!data.video) {
    ctx.warn('The shots have not been found yet. Open this flow’s editor and press “Find the shots”.');
    return { outputs: [] };
  }
  if (data.video.hash && video.artifact.hash && data.video.hash !== video.artifact.hash) {
    ctx.warn('The video has changed since the shots were found. They are written as they are — find them again in the editor.');
  }
  const spans = shotsOf(data.cuts, data.video.duration).map((shot) => `${shot.start.toFixed(2)}–${shot.end.toFixed(2)}s`);
  ctx.log(`${summariseShots(data)}: ${spans.join(', ')}.`);
  return {
    outputs: [
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'shots', kind: 'json', fileName: 'shots.json', content: shotsFile(data) }),
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'report', kind: 'markdown', fileName: 'shots.md', content: shotsReport(data) }),
    ],
  };
}
