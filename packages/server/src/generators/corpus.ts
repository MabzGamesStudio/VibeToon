import {
  includedParts,
  localPartText,
  notePartRead,
  summariseCorpus,
  type CorpusFlowData,
  type CorpusPart,
} from '@vibetoon/shared';
import { fetchCorpus } from '../text/corpusFetch';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

const UPSTREAM_READ_LIMIT = 8_000_000;

function bytesLabel(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} kB`;
  return `${(count / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Gather every included part into one body of text.
 *
 * A part that carries its own text is used as it stands; a part that is an
 * address is fetched now, which is why a novel does not have to live in
 * `project.json`. A part that cannot be read does not stop the run: the rest is
 * still written, and the part records what went wrong so the editor can say so.
 */
export async function generateCorpus(ctx: GenerationContext): Promise<GenerationResult> {
  let data = ctx.node.data as CorpusFlowData;
  const pieces: Array<{ name: string; text: string; source: string }> = [];

  for (const part of includedParts(data)) {
    const local = localPartText(part);
    if (local !== null) {
      pieces.push({ name: part.name, text: local, source: part.kind === 'builtin' ? 'built in' : 'pasted' });
      data = notePartRead(data, part.id, { bytes: local.length });
      continue;
    }

    if (!part.url) {
      const error = 'No address to fetch.';
      ctx.warn(`${part.name}: ${error}`);
      data = notePartRead(data, part.id, { error });
      continue;
    }

    try {
      const fetched = await fetchCorpus(part.url);
      pieces.push({ name: part.name, text: fetched.text, source: part.url });
      data = notePartRead(data, part.id, { bytes: fetched.text.length });
      ctx.log(`Fetched ${part.name}: ${bytesLabel(fetched.text.length)}.`);
      if (fetched.truncated) ctx.warn(`${part.name} was very large, so only the first part was read.`);
    } catch (error) {
      const message = (error as Error).message;
      ctx.warn(`Could not fetch ${part.name}: ${message}`);
      data = notePartRead(data, part.id, { error: message });
    }
  }

  // Text arriving over a wire is a part too, counted fresh on every run rather
  // than stored, so a flow feeding this one is always read as it is now.
  for (const input of ctx.inputs) {
    if (input.connection.to.portId !== 'text') continue;
    const text = await ctx.readUpstream(input, UPSTREAM_READ_LIMIT);
    if (!text?.trim()) {
      ctx.warn(`${input.sourceNode.name} has not generated any text yet.`);
      continue;
    }
    pieces.push({ name: input.sourceNode.name, text, source: 'wired in' });
    ctx.log(`Read ${bytesLabel(text.length)} from ${input.sourceNode.name}.`);
  }

  const separator = data.separator ?? '\n\n';
  const corpus = pieces.map((piece) => piece.text.trim()).filter(Boolean).join(separator);

  if (pieces.length === 0) ctx.warn('Nothing is included, so the corpus is empty.');

  const summary = summariseCorpus(data);
  const report = [
    `# ${ctx.node.name} — corpus`,
    '',
    `- Parts written: **${pieces.length}** of ${data.parts.length} in the flow`,
    `- Size: ${bytesLabel(corpus.length)}`,
    ...(summary.errors > 0 ? [`- Could not be read: ${summary.errors}`] : []),
    '',
    '## What went into it',
    '',
    ...(pieces.length === 0
      ? ['Nothing.', '']
      : [
          '| Part | Size | Where from |',
          '| --- | --- | --- |',
          ...pieces.map((piece) => `| ${piece.name} | ${bytesLabel(piece.text.length)} | ${piece.source} |`),
          '',
        ]),
    ...(summary.errors > 0
      ? [
          '## What could not be read',
          '',
          ...includedParts(data)
            .filter((part: CorpusPart) => part.lastError)
            .map((part: CorpusPart) => `- **${part.name}** — ${part.lastError}`),
          '',
        ]
      : []),
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'corpus',
      kind: 'text',
      fileName: 'corpus.txt',
      content: corpus.endsWith('\n') ? corpus : `${corpus}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'report',
      kind: 'markdown',
      fileName: 'report.md',
      content: `${report.join('\n')}\n`,
    }),
  ];

  ctx.log(`${bytesLabel(corpus.length)} from ${pieces.length} part(s).`);
  return { outputs, data };
}
