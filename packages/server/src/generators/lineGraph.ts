import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import {
  buildLineGraph,
  decodePng,
  editedGraph,
  graphBasis,
  graphFile,
  graphReport,
  graphSvg,
  graphVector,
  isPng,
  summariseGraph,
  type LineGraphFlowData,
} from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The lines found in a picture, as a graph of vector lines. The lines picture
 * is always a PNG (a Line Detection writes one), so the graph is traced here,
 * and the hand edits laid on it when they were made on this same tracing.
 */
export async function generateLineGraph(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as LineGraphFlowData;
  const input = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'lines' && candidate.artifact !== undefined);
  if (!input?.artifact) {
    ctx.warn('No lines wired in — connect a Line Detection’s Lines to the Lines input.');
    return { outputs: [] };
  }
  const entry = input.artifact.entries?.[0];
  const path = entry ? `${input.artifact.path}/${entry}` : input.artifact.path;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolveInProject(ctx.project.id, path)));
  } catch {
    ctx.warn(`The lines from ${input.sourceNode.name} could not be read.`);
    return { outputs: [] };
  }
  if (!isPng(bytes)) {
    ctx.warn('The Lines input is not a PNG. Wire in the Lines picture a Line Detection writes.');
    return { outputs: [] };
  }

  const picture = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
  const graph = buildLineGraph(picture, data.options);
  // Hand edits are keyed to the tracing they were made on; on another, they
  // would land on the wrong lines.
  const basis = graphBasis(input.artifact.hash, data.options);
  const matches = !data.basis || data.basis === basis;
  if (!matches && (data.hidden.length > 0 || Object.keys(data.moved).length > 0)) {
    ctx.warn('The lines or the tracing settings have changed since the lines were edited by hand, so those edits are set aside. Open the editor to redo them.');
  }
  const edited = editedGraph(graph, matches ? data : { ...data, hidden: [], moved: {} });
  if (graph.edges.length === 0) ctx.warn('No lines were found in that picture at this confidence.');
  ctx.log(summariseGraph(graph, edited));

  const write = (port: string, kind: 'json' | 'image' | 'markdown', fileName: string, content: string) =>
    writeArtifact({ projectId: ctx.project.id, flowId: ctx.node.id, port, kind, fileName, content });
  return {
    outputs: [
      await write('graph', 'json', 'graph.json', graphFile(graph, edited)),
      await write('vector', 'json', 'vector.json', `${JSON.stringify(graphVector(graph, edited), null, 2)}\n`),
      await write('svg', 'image', 'lines.svg', graphSvg(graph, edited)),
      await write('report', 'markdown', 'graph.md', graphReport(graph, edited, matches ? data : { ...data, hidden: [], moved: {} }, input.sourceNode.name)),
    ],
  };
}
