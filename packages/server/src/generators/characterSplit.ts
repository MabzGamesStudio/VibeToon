import { charactersReport, inputsForPort, type CharacterSplitFlowData } from '@vibetoon/shared';
import { writeArtifact, writeArtifactSet } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The characters in a video's frames, each on its own.
 *
 * They are found and split in the editor, which reads the frames; it sends
 * each character's clip (`characters/…webm`), sheet (`sheets/…png`) and frames
 * (`frames/…png`) with the character list and the report. This writes them.
 */
export async function generateCharacterSplit(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as CharacterSplitFlowData;
  if (!inputsForPort(ctx.project, ctx.node.id, 'frames').some((input) => input.artifact)) {
    ctx.warn('No frames — wire a folder of frames with only the characters left (from Video Foreground) into Frames.');
    return { outputs: [] };
  }
  const under = (folder: string) =>
    ctx.attachments
      .filter((attachment) => attachment.name.startsWith(`${folder}/`))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((attachment) => ({ name: attachment.name.slice(folder.length + 1), content: attachment.bytes }));
  const clips = under('characters');
  const sheets = under('sheets');
  const frames = under('frames');
  const list = ctx.attachments.find((attachment) => attachment.name === 'characters.json');
  const report = ctx.attachments.find((attachment) => attachment.name === 'characters.md');
  if (!list) {
    ctx.warn('The characters are found in the editor, where the frames can be read: open this flow, read the frames, and press Generate there.');
    return { outputs: [] };
  }
  const set = (port: string, kind: 'videoSet' | 'imageSet', files: Array<{ name: string; content: Uint8Array }>) =>
    writeArtifactSet({ projectId: ctx.project.id, flowId: ctx.node.id, port, kind, dirName: port, files });
  const outputs = [
    await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'list', kind: 'json', fileName: 'characters.json', content: list.bytes }),
    await writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'report', kind: 'markdown', fileName: 'characters.md', content: report ? report.bytes : charactersReport(data, null) }),
  ];
  if (sheets.length > 0) outputs.push(await set('sheets', 'imageSet', sheets));
  if (frames.length > 0) outputs.push(await set('frames', 'imageSet', frames));
  if (clips.length > 0) outputs.push(await set('characters', 'videoSet', clips));
  else if (sheets.length > 0) ctx.warn('No clips came with the run: this browser could not write them. The sheets and frames are written.');
  ctx.log(`${sheets.length} character(s): ${frames.length} frame(s) in all${clips.length > 0 ? `, a clip each` : ''}.`);
  return { outputs };
}
