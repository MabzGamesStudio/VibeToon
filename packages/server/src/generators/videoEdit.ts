import { editFile, editKey, keptSegments, summariseEdit, videoSourceOf, type VideoEditFlowData, noVideoMessage } from '@vibetoon/shared';
import { writeArtifact, writeArtifactSet } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A video, cropped, split and cut.
 *
 * The video is played through the crop and recorded in the editor, where it
 * can be decoded and encoded; the editor sends what it recorded with the run —
 * `edited.webm`, or a clip for each kept segment under `clips/`. The edit
 * itself is always written, so it can be redone elsewhere, from the source.
 */
export async function generateVideoEdit(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VideoEditFlowData;
  const source = videoSourceOf(ctx.project, ctx.node);
  if (!source) {
    ctx.warn(noVideoMessage(ctx.project, ctx.node));
    return { outputs: [] };
  }
  if (!data.video) {
    ctx.warn('The video has not been opened in the editor yet, so there is no edit. Open this flow’s editor.');
    return { outputs: [] };
  }
  if (data.video.hash && source.artifact.hash && data.video.hash !== source.artifact.hash) {
    ctx.warn('The video has changed since this edit was made. Open the editor to check the segments still fall where they should.');
  }
  if (keptSegments(data).length === 0) {
    ctx.warn('Every segment is deleted, so there is nothing to write but the edit.');
  }

  const outputs = [
    await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'edit', kind: 'json', fileName: 'edit.json', content: editFile(data) }),
  ];

  const joined = ctx.attachments.find((attachment) => /^edited\.(webm|mp4)$/.test(attachment.name));
  const clips = ctx.attachments.filter((attachment) => attachment.name.startsWith('clips/')).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (data.output === 'joined' && joined) {
    outputs.push(await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'video', kind: 'video', fileName: joined.name, content: joined.bytes }));
  } else if (data.output === 'clips' && clips.length > 0) {
    outputs.push(
      await writeArtifactSet({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'clips',
        kind: 'videoSet',
        dirName: 'clips',
        files: clips.map((clip) => ({ name: clip.name.slice('clips/'.length), content: clip.bytes })),
      }),
    );
  } else if (keptSegments(data).length > 0) {
    ctx.warn('The video is recorded in the editor, where it can be played: open this flow and press Generate there. The edit has been written.');
  } else {
    // Nothing kept: nothing to render, and nothing stale left behind either.
  }
  if (data.rendered && data.rendered !== editKey(data) && !joined && clips.length === 0) {
    ctx.warn('The edit has changed since the video was last recorded.');
  }
  ctx.log(summariseEdit(data));
  return { outputs };
}
