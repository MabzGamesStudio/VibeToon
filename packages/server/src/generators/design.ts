import {
  drawnPlates,
  keyImagePort,
  plateSetPort,
  type ArtifactRef,
  type DesignFlowData,
} from '@vibetoon/shared';
import { writeArtifact, writeArtifactSet } from '../storage';
import { generateBrief } from './brief';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A design flow writes two things: the spec, from its written fields, and the
 * drawings, rasterised by the editor and sent with the run. The key image is the
 * first plate; the whole set becomes the model sheet, so a character's design and
 * its turnaround stay in step with each other.
 */
export async function generateDesign(ctx: GenerationContext): Promise<GenerationResult> {
  // Migration normalises stored projects, but a request can still post anything.
  const raw = ctx.node.data as Partial<DesignFlowData>;
  const data: DesignFlowData = {
    editor: 'design',
    fields: raw.fields ?? {},
    plates: Array.isArray(raw.plates) ? raw.plates : [],
  };
  const keyPort = keyImagePort(ctx.def);
  const setPort = plateSetPort(ctx.def);
  const handled = new Set([keyPort?.id, setPort?.id].filter((id): id is string => id !== undefined));

  // The written spec is exactly a brief; only the picture ports differ.
  const base = await generateBrief(ctx, { skipPorts: handled });
  const outputs: ArtifactRef[] = [...base.outputs];

  const key = ctx.attachments.find((attachment) => keyPort && attachment.name === `${keyPort.id}.png`);
  const plates = ctx.attachments
    .filter((attachment) => setPort && attachment.name.startsWith(`${setPort.id}/`))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  if (keyPort && key) {
    outputs.push(
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: keyPort.id,
        kind: 'image',
        fileName: keyPort.fileName ?? `${keyPort.id}.png`,
        content: key.bytes,
      }),
    );
  }

  if (setPort && plates.length > 0) {
    outputs.push(
      await writeArtifactSet({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: setPort.id,
        kind: 'imageSet',
        dirName: setPort.fileName ?? setPort.id,
        files: plates.map((plate) => ({
          name: plate.name.slice(`${setPort.id}/`.length),
          content: plate.bytes,
        })),
      }),
    );
  }

  const drawn = drawnPlates(data).length;
  if (drawn === 0) {
    ctx.warn('No plate has been drawn yet, so this flow has a spec but no picture.');
  } else if (ctx.attachments.length === 0) {
    ctx.warn(
      `${drawn} plate(s) are drawn, but no images were sent with this run — press Generate in the design editor to write them.`,
    );
  } else {
    ctx.log(`${drawn} plate(s) drawn, ${plates.length + (key ? 1 : 0)} image(s) written.`);
  }

  return { outputs };
}
