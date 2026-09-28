import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  decodePng,
  encodePng,
  isPng,
  pngSize,
  resizeBitmap,
  summariseResize,
  targetSize,
  type ResizeFlowData,
} from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A picture, resized.
 *
 * A PNG is read and resized here, so the flow regenerates with everything else.
 * Any other format is decoded by the browser, so the editor resizes it and sends
 * the result along with the run; without that, this says what to do.
 */
export async function generateResize(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as ResizeFlowData;
  const input = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined);
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }
  const entry = input.artifact.entries?.[0];
  const path = entry ? `${input.artifact.path}/${entry}` : input.artifact.path;

  const write = async (content: Uint8Array) =>
    writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'image', kind: 'image', fileName: 'resized.png', content });

  const rendered = ctx.attachments.find((attachment) => attachment.name === 'resized.png');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolveInProject(ctx.project.id, path)));
  } catch {
    ctx.warn(`The picture from ${input.sourceNode.name} could not be read.`);
    return { outputs: [] };
  }

  if (!isPng(bytes)) {
    if (!rendered) {
      ctx.warn('This picture is not a PNG, so it is resized in the editor: open this flow and press Generate there.');
      return { outputs: [] };
    }
    const size = pngSize(rendered.bytes);
    if (size) ctx.log(`Resized in the editor to ${size.width} × ${size.height}.`);
    return { outputs: [await write(rendered.bytes)] };
  }

  const source = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
  const size = targetSize(source, data.options);
  const started = Date.now();
  const resized = resizeBitmap(source, size.width, size.height, data.options.method);
  const encoded = await encodePng(resized, (raw) => new Uint8Array(deflateSync(raw)));
  ctx.log(`${summariseResize(source, data.options)} · ${Date.now() - started} ms.`);
  return { outputs: [await write(encoded)] };
}
