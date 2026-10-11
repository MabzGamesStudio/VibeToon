import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  decodePng,
  encodePng,
  isPng,
  readPalette,
  readVectorImage,
  readVoronoiNodes,
  summariseVoronoi,
  toSvg,
  voronoiImage,
  voronoiNodesFile,
  voronoiReport,
  voronoiVector,
  voronoiWork,
  type Rgba,
  type VoronoiFit,
  type VoronoiFlowData,
} from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact } from '../storage';
import { readsWhole, type GenerationContext, type GenerationResult } from './types';

/** A palette is a few dozen colors; a file longer than this is not one. */
const PALETTE_LIMIT = 2_000_000;

/** Run a fit, letting the server answer other requests every so often while it does. */
async function inTurns<T>(work: Generator<unknown, T>): Promise<T> {
  let began = Date.now();
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
    if (Date.now() - began > 50) {
      await new Promise((resolve) => setImmediate(resolve));
      began = Date.now();
    }
  }
}

/**
 * A picture as a Voronoi diagram.
 *
 * The editor fits the diagram in the browser, where the picture is decoded,
 * and sends what it made: the picture, the shapes and the nodes. Without that
 * — a run of the whole project, or an item of a batch with no editor open — a
 * PNG is fitted here with the flow's settings; another format needs the editor.
 *
 * Shapes sent from the editor are read and written again, and the SVG is made
 * here from them, so what lands on disk is always well formed.
 */
export async function generateVoronoi(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VoronoiFlowData;
  const input = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined);
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }
  const wantPicture = data.output !== 'vector';
  const wantShapes = data.output !== 'picture';
  // What this run does not write must not linger from an earlier one with other settings.
  const cleared = [...(wantPicture ? [] : ['image']), ...(wantShapes ? [] : ['vector', 'svg'])];
  const write = (port: string, kind: 'image' | 'json' | 'markdown', fileName: string, content: Uint8Array | string) =>
    writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port, kind, fileName, content });

  const sent = (name: string) => ctx.attachments.find((attachment) => attachment.name === name);
  const sentNodes = sent('nodes.json');
  if (sentNodes) {
    let nodes: ReturnType<typeof readVoronoiNodes> = null;
    try {
      nodes = readVoronoiNodes(JSON.parse(new TextDecoder().decode(sentNodes.bytes)));
    } catch {
      nodes = null;
    }
    if (!nodes) {
      ctx.warn('The editor sent nodes that could not be read. Fit again and press Generate.');
      return { outputs: [] };
    }
    const outputs = [];
    if (wantPicture) {
      const picture = sent('voronoi.png');
      if (!picture || !isPng(picture.bytes)) {
        ctx.warn('The editor sent no picture of the diagram. Fit again and press Generate.');
        return { outputs: [] };
      }
      outputs.push(await write('image', 'image', 'voronoi.png', picture.bytes));
    }
    if (wantShapes) {
      const shapes = sent('vector.json');
      let vector = null;
      try {
        vector = shapes ? readVectorImage(JSON.parse(new TextDecoder().decode(shapes.bytes))) : null;
      } catch {
        vector = null;
      }
      if (!vector || vector.width <= 0) {
        ctx.warn('The editor sent no shapes for the diagram. Fit again and press Generate.');
        return { outputs: [] };
      }
      outputs.push(await write('vector', 'json', 'vector.json', `${JSON.stringify(vector, null, 2)}\n`));
      outputs.push(await write('svg', 'image', 'voronoi.svg', toSvg(vector)));
    }
    outputs.push(await write('nodes', 'json', 'nodes.json', sentNodes.bytes));
    const report = sent('voronoi.md');
    if (report) outputs.push(await write('report', 'markdown', 'voronoi.md', report.bytes));
    ctx.log(`Fitted in the editor: ${nodes.nodes.length} node(s).`);
    return { outputs, cleared };
  }

  const entry = input.artifact.entries?.[0];
  const path = entry ? `${input.artifact.path}/${entry}` : input.artifact.path;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolveInProject(ctx.project.id, path)));
  } catch {
    ctx.warn(`The picture from ${input.sourceNode.name} could not be read.`);
    return { outputs: [] };
  }
  if (!isPng(bytes)) {
    ctx.warn('This picture is not a PNG, so the diagram is fitted in the editor: open this flow and press Generate there.');
    return { outputs: [] };
  }

  let palette: Rgba[] | null = null;
  const paletteInput = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'palette' && candidate.artifact !== undefined);
  if (data.usePalette && paletteInput) {
    const body = await ctx.readUpstream(paletteInput, PALETTE_LIMIT);
    if (!readsWhole(body)) {
      ctx.warn('The palette file was too long to read whole, so it cannot be trusted. Nothing was written.');
      return { outputs: [] };
    }
    try {
      palette = readPalette(JSON.parse(body ?? 'null')).colors;
    } catch {
      ctx.warn(`${paletteInput.sourceNode.name} did not produce readable JSON.`);
      return { outputs: [] };
    }
    if (palette.length === 0) {
      ctx.warn(`${paletteInput.sourceNode.name} has no colors in it, so each node takes its cell’s own average.`);
      palette = null;
    }
  }

  const source = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
  const fit: VoronoiFit = await inTurns(voronoiWork(source, { nodes: data.nodes, refine: data.refine, repel: data.repel }, palette));
  ctx.log(`Fitted here: ${summariseVoronoi(data)}; ${fit.error.mean.toFixed(2)} off a pixel on average.`);
  const vector = wantShapes ? voronoiVector(fit, data.merge) : null;
  const outputs = [];
  if (wantPicture) outputs.push(await write('image', 'image', 'voronoi.png', await encodePng(voronoiImage(fit), (raw) => new Uint8Array(deflateSync(raw)))));
  if (vector) {
    outputs.push(await write('vector', 'json', 'vector.json', `${JSON.stringify(vector, null, 2)}\n`));
    outputs.push(await write('svg', 'image', 'voronoi.svg', toSvg(vector)));
  }
  outputs.push(await write('nodes', 'json', 'nodes.json', voronoiNodesFile(data, fit, input.artifact.hash ?? null)));
  outputs.push(await write('report', 'markdown', 'voronoi.md', voronoiReport(data, fit, vector)));
  return { outputs, cleared };
}
