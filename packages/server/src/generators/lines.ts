import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng, detectLines, encodePng, isPng, lineImage, linesReport, summariseLines, type LinesFlowData } from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The lines in a picture, as a picture: black, with red where the lines are.
 *
 * A PNG is read here. Any other format is decoded by the browser, so the editor
 * finds the lines and sends the picture and report along with the run.
 */
export async function generateLines(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as LinesFlowData;
  const input = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined);
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }
  const entry = input.artifact.entries?.[0];
  const path = entry ? `${input.artifact.path}/${entry}` : input.artifact.path;
  const write = (port: 'image' | 'report', fileName: string, content: Uint8Array | string) =>
    writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port, kind: port === 'image' ? 'image' : 'markdown', fileName, content });

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolveInProject(ctx.project.id, path)));
  } catch {
    ctx.warn(`The picture from ${input.sourceNode.name} could not be read.`);
    return { outputs: [] };
  }

  if (!isPng(bytes)) {
    const rendered = ctx.attachments.find((attachment) => attachment.name === 'lines.png');
    const report = ctx.attachments.find((attachment) => attachment.name === 'lines.md');
    if (!rendered) {
      ctx.warn('This picture is not a PNG, so its lines are found in the editor: open this flow and press Generate there.');
      return { outputs: [] };
    }
    ctx.log('Lines found in the editor.');
    return { outputs: [await write('image', 'lines.png', rendered.bytes), ...(report ? [await write('report', 'lines.md', report.bytes)] : [])] };
  }

  const source = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
  const result = detectLines(source, data.options);
  ctx.log(summariseLines(result));
  const encoded = await encodePng(lineImage(result), (raw) => new Uint8Array(deflateSync(raw)));
  return {
    outputs: [await write('image', 'lines.png', encoded), await write('report', 'lines.md', linesReport(result, data.options, input.sourceNode.name))],
  };
}
