import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  cropBitmap,
  cropBoxFile,
  cropRectFor,
  decodePng,
  encodePng,
  isPng,
  pngSize,
  summariseCrop,
  type CropFlowData,
} from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A picture, cropped.
 *
 * A PNG is read and cropped here, so the flow regenerates with everything else.
 * Any other format is decoded by the browser, so the editor crops it and sends
 * the result along with the run.
 */
export async function generateCrop(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as CropFlowData;
  const input = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined);
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }
  const entry = input.artifact.entries?.[0];
  const path = entry ? `${input.artifact.path}/${entry}` : input.artifact.path;
  const write = (port: 'image' | 'box', fileName: string, content: Uint8Array | string) =>
    writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port, kind: port === 'image' ? 'image' : 'json', fileName, content });

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolveInProject(ctx.project.id, path)));
  } catch {
    ctx.warn(`The picture from ${input.sourceNode.name} could not be read.`);
    return { outputs: [] };
  }

  if (!isPng(bytes)) {
    const rendered = ctx.attachments.find((attachment) => attachment.name === 'cropped.png');
    const box = ctx.attachments.find((attachment) => attachment.name === 'crop.json');
    if (!rendered) {
      ctx.warn('This picture is not a PNG, so it is cropped in the editor: open this flow and press Generate there.');
      return { outputs: [] };
    }
    const size = pngSize(rendered.bytes);
    if (size) ctx.log(`Cropped in the editor to ${size.width} × ${size.height}.`);
    return { outputs: [await write('image', 'cropped.png', rendered.bytes), ...(box ? [await write('box', 'crop.json', box.bytes)] : [])] };
  }

  const source = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
  const rect = cropRectFor(data, source);
  if (data.mode === 'opaque' && rect.x === 0 && rect.y === 0 && rect.width === source.width && rect.height === source.height) {
    ctx.log('There were no clear pixels round the edges to crop away.');
  }
  const encoded = await encodePng(cropBitmap(source, rect), (raw) => new Uint8Array(deflateSync(raw)));
  ctx.log(summariseCrop(source, rect, data.mode));
  return {
    outputs: [await write('image', 'cropped.png', encoded), await write('box', 'crop.json', cropBoxFile(source, rect, data.mode))],
  };
}
