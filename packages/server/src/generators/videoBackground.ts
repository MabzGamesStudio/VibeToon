import { backgroundReport, pngSize, videoSourceOf, type VideoBackgroundFlowData } from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The background of a video clip.
 *
 * The frames are read, compared and marked in the editor, where a video can be
 * decoded; it sends the background it made along with the run. An uploaded
 * video on the flow's own port is left as it is.
 */
export async function generateVideoBackground(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VideoBackgroundFlowData;
  if (!videoSourceOf(ctx.project, ctx.node)) {
    ctx.warn('No video — wire one into the Video input, or upload one in the editor.');
    return { outputs: [] };
  }
  const image = ctx.attachments.find((attachment) => attachment.name === 'background.png');
  if (!image) {
    ctx.warn('The background is worked out in the editor, where the video can be read: open this flow, read the frames, and press Generate there.');
    return { outputs: [] };
  }
  const report = ctx.attachments.find((attachment) => attachment.name === 'background.md');
  const size = pngSize(image.bytes);
  if (size) ctx.log(`Background, ${size.width} × ${size.height}, each pixel's commonest colour where it is in at least ${data.agreement}% of the frames, and ${data.marks.length} mark(s).`);
  return {
    outputs: [
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'image', kind: 'image', fileName: 'background.png', content: image.bytes }),
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'report',
        kind: 'markdown',
        fileName: 'background.md',
        content: report ? report.bytes : backgroundReport(data, null),
      }),
    ],
  };
}
