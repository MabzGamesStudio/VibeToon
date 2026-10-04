import { readFile } from 'node:fs/promises';
import { folderKindOf, splitSelection, summariseSelection, type BatchSelectFlowData, type SelectableItem } from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact, writeArtifactSet } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * Write the items ticked as one folder, and the rest as another. Each item's
 * file is copied as it is, under a name unique across every wire, so the
 * folder goes on down the graph as one batch.
 */
export async function generateBatchSelect(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as BatchSelectFlowData;
  const split = splitSelection(ctx.project, ctx.node, data);
  if (!split.kind) {
    ctx.warn(split.waiting.length > 0 ? `None of the ${split.waiting.length} item(s) wired in has been made yet.` : 'Nothing is wired into Items yet.');
    return { outputs: [] };
  }
  const read = async (items: SelectableItem[]) =>
    Promise.all(items.map(async (item) => ({ name: item.fileName, content: new Uint8Array(await readFile(resolveInProject(ctx.project.id, item.artifact!.path))) })));
  const outputs = [];
  const cleared: string[] = [];
  const kind = folderKindOf(split.kind);
  if (split.selected.length > 0) {
    outputs.push(await writeArtifactSet({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'selected', kind, dirName: 'selected', files: await read(split.selected) }));
  } else {
    cleared.push('selected');
    ctx.warn('No item is ticked, so nothing goes out on Selected.');
  }
  if (split.rest.length > 0) {
    outputs.push(await writeArtifactSet({ projectId: ctx.project.id, flowId: ctx.node.id, port: 'rest', kind, dirName: 'rest', files: await read(split.rest) }));
  } else cleared.push('rest');
  if (split.waiting.length > 0) ctx.warn(`${split.waiting.length} ticked item(s) have not been made yet upstream, and are not in it: ${split.waiting.map((item) => item.label).join(', ')}.`);
  if (split.otherKind.length > 0) ctx.warn(`A folder holds one kind of file: ${split.otherKind.length} item(s) that are not ${split.kind}s were set aside.`);
  const list = (items: SelectableItem[]) => (items.length === 0 ? ['- none'] : items.map((item) => `- ${item.fileName}`));
  outputs.push(
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'report',
      kind: 'markdown',
      fileName: 'selection.md',
      content: ['# Selection', '', summariseSelection(split), '', '## Selected', '', ...list(split.selected), '', '## Left out', '', ...list(split.rest), ''].join('\n'),
    }),
  );
  ctx.log(summariseSelection(split));
  return { outputs, cleared };
}
