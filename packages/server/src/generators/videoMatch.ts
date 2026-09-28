import {
  rigAnimationOf,
  segmentsOf,
  summariseVideoMatch,
  videoMatchReport,
  videoMatchState,
  videoSourceOf,
  type VideoMatchFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A bound rig, found through a video: the rig animation.
 *
 * The frames are read and matched in the editor, where the video can be
 * decoded; what is stored is each sampled frame's fit. This writes the
 * animation those make — one segment for each run of frames the body was found
 * in — and a report of it. An uploaded video on the flow's own port is left as
 * it is.
 */
export async function generateVideoMatch(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VideoMatchFlowData;
  const boundInput = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'bound' && candidate.artifact !== undefined);
  if (!boundInput?.artifact) {
    ctx.warn('No bound rig wired in — connect a Rig Binding flow to the Bound rig input.');
    return { outputs: [] };
  }
  const video = videoSourceOf(ctx.project, ctx.node);
  if (!video) {
    ctx.warn('No video — wire one into the Video input, or upload one in the editor.');
    return { outputs: [] };
  }

  const state = videoMatchState(data, boundInput.artifact.hash, video.artifact.hash);
  if (state === 'none') {
    ctx.warn('Nothing taken in yet. Open this flow’s editor and press “Take it in”.');
    return { outputs: [] };
  }
  if (state === 'unmatched') {
    ctx.warn('No frames matched yet. Open this flow’s editor and press “Match every frame”.');
    return { outputs: [] };
  }
  if (state === 'stale') {
    ctx.warn('The body, the video or the sampling has changed since the frames were matched. The animation is written as it is — match again in the editor.');
  }
  if (state === 'partial') {
    ctx.warn('Not every frame has been matched yet; the animation covers the ones that have.');
  }

  const animation = rigAnimationOf(data);
  if (!animation) {
    ctx.warn('There is nothing to write yet.');
    return { outputs: [] };
  }
  const segments = segmentsOf(data.frames, data.threshold);
  if (segments.length === 0) {
    ctx.warn(`The body was not found in any frame at ${Math.round(data.threshold * 100)}% confidence. Lower the threshold, or check it is the same character.`);
  }
  ctx.log(summariseVideoMatch(data));

  return {
    outputs: [
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'animation',
        kind: 'json',
        fileName: 'animation.json',
        content: `${JSON.stringify(animation, null, 2)}\n`,
      }),
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'report',
        kind: 'markdown',
        fileName: 'animation.md',
        content: videoMatchReport(data),
      }),
    ],
  };
}
