import {
  DEFAULT_DURATION_OPTIONS,
  characterById,
  dialogDuration,
  dialogScenesPayload,
  formatDialogText,
  formatSoundCues,
  type DialogFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The dialog flow owns its content, so generation is a formatting step: the
 * editor state becomes a readable `dialog.txt`, a structured `scenes.json` and
 * a cue list the sound flows can work from.
 */
export async function generateDialog(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as DialogFlowData;
  const options = {
    ...DEFAULT_DURATION_OPTIONS,
    defaultSeconds: ctx.project.settings.defaultShotSeconds || DEFAULT_DURATION_OPTIONS.defaultSeconds,
  };

  const beatCount = data.scenes.reduce((sum, scene) => sum + scene.beats.length, 0);
  if (data.scenes.length === 0) ctx.warn('No scenes yet — the dialog artifacts will be empty.');

  for (const [index, scene] of data.scenes.entries()) {
    if (!scene.setId) ctx.warn(`Scene ${index + 1} (${scene.slug}) has no set.`);
    for (const beat of scene.beats) {
      if (beat.type === 'line' && !characterById(data, beat.characterId)) {
        ctx.warn(`Scene ${index + 1} has a line with no character assigned.`);
      }
      if (beat.type !== 'sound' && !beat.text.trim()) {
        ctx.warn(`Scene ${index + 1} has an empty ${beat.type} beat.`);
      }
    }
  }

  for (const input of ctx.inputs) {
    const excerpt = await ctx.readUpstream(input, 400);
    if (excerpt) {
      ctx.log(`Read ${input.sourceNode.name} → ${input.connection.to.portId} (${excerpt.length} chars of context).`);
    } else if (input.connection.settings.enabled) {
      ctx.log(`${input.sourceNode.name} is wired in but has not generated anything yet.`);
    }
  }

  const text = formatDialogText(data, ctx.node.name);
  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'dialog',
      kind: 'text',
      fileName: 'dialog.txt',
      content: text,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'scenes',
      kind: 'json',
      fileName: 'scenes.json',
      content: `${JSON.stringify(dialogScenesPayload(data, options), null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'soundcues',
      kind: 'text',
      fileName: 'soundcues.txt',
      content: formatSoundCues(data),
    }),
  ];

  ctx.log(
    `${data.scenes.length} scene(s), ${beatCount} beat(s), ~${dialogDuration(data, options).toFixed(1)}s of screen time.`,
  );
  return { outputs };
}
