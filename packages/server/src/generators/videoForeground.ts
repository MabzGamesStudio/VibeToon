import { foregroundReport, videoSourceOf, type VideoForegroundFlowData, noVideoMessage, inputsForPort } from '@vibetoon/shared';
import { writeArtifact, writeArtifactSet } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A video's frames with the background taken out.
 *
 * The frames are read and taken apart in the editor, where the video can be
 * decoded; it sends them with the run, as `frames/…png`, with the frame list
 * and the report. This writes them.
 */
export async function generateVideoForeground(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VideoForegroundFlowData;
  if (!videoSourceOf(ctx.project, ctx.node)) {
    ctx.warn(noVideoMessage(ctx.project, ctx.node));
    return { outputs: [] };
  }
  if (!inputsForPort(ctx.project, ctx.node.id, 'background').some((input) => input.artifact)) {
    ctx.warn('No background — wire one into the Background input (Video Background makes one from the same clip).');
    return { outputs: [] };
  }
  const frames = ctx.attachments.filter((attachment) => attachment.name.startsWith('frames/')).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (frames.length === 0) {
    ctx.warn('The frames are taken apart in the editor, where the video can be read: open this flow, read the frames, and press Generate there.');
    return { outputs: [] };
  }
  const json = ctx.attachments.find((attachment) => attachment.name === 'foreground.json');
  const report = ctx.attachments.find((attachment) => attachment.name === 'foreground.md');
  ctx.log(`${frames.length} frame(s) with only what is in front of the background kept: tolerance ${data.tolerance}, specks under ${data.speck} px dropped, holes up to ${data.holes} px filled.`);
  return {
    outputs: [
      await writeArtifactSet({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'frames',
        kind: 'imageSet',
        dirName: 'frames',
        files: frames.map((frame) => ({ name: frame.name.slice('frames/'.length), content: frame.bytes })),
      }),
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'data', kind: 'json', fileName: 'foreground.json', content: json ? json.bytes : '{}\n' }),
      await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'report', kind: 'markdown', fileName: 'foreground.md', content: report ? report.bytes : foregroundReport(data, []) }),
    ],
  };
}
