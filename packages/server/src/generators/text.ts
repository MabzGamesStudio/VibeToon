import {
  lexiconStats,
  resolveTextRun,
  runRandomText,
  type Lexicon,
  type TextFlowData,
  type TextRunSource,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

const INPUT_LIMIT = 200_000;

function percent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/**
 * Writes or rewrites text from the flow's word database. Everything is
 * deterministic given the seed, so the artifact only changes when the text, the
 * database, the options or the rules on a wire actually change.
 */
export async function generateText(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as TextFlowData;
  const sources: TextRunSource[] = [];

  for (const input of ctx.inputs) {
    const port = input.connection.to.portId;
    if (port !== 'text' && port !== 'lexicon') continue;
    const label = `${input.sourceNode.name} → ${input.targetPort?.label ?? port}`;
    const body = await ctx.readUpstream(input, INPUT_LIMIT);

    if (port === 'text') {
      sources.push({ port, label, rules: input.connection.rules, ...(body ? { text: body } : {}) });
      if (!body) ctx.warn(`${input.sourceNode.name} has not generated any text yet.`);
      continue;
    }

    if (!body) {
      ctx.warn(`${input.sourceNode.name} has not generated a word database yet.`);
      continue;
    }
    try {
      const parsed = JSON.parse(body) as Lexicon;
      if (!Array.isArray(parsed.lexemes)) throw new Error('no `lexemes` array');
      sources.push({ port, label, rules: input.connection.rules, lexicon: parsed });
    } catch (error) {
      ctx.warn(`Could not read the word database from ${input.sourceNode.name}: ${String(error)}`);
    }
  }

  const resolved = resolveTextRun(data, sources);
  for (const note of resolved.notes) ctx.log(note);

  const stats = lexiconStats(resolved.lexicon);
  if (stats.duplicateIds.length > 0) {
    ctx.warn(`${stats.duplicateIds.length} word(s) share an id — only one of each can be reached.`);
  }
  if (stats.danglingRefs.length > 0) {
    ctx.warn(`${stats.danglingRefs.length} context reference(s) point at words that are not in the database.`);
  }

  const result = runRandomText({
    input: resolved.input,
    options: resolved.options,
    lexicon: resolved.lexicon,
  });
  for (const warning of result.warnings) ctx.warn(warning);

  const plan = result.stats.plan;
  const report = [
    `# ${ctx.node.name} — run report`,
    '',
    `- Mode: **${result.stats.mode}** (seed \`${result.stats.seed}\`)`,
    `- Target: ${plan ? `${plan.target} ${plan.metric} ±${plan.tolerance}` : 'keep the length it came in at'}`,
    `- Words: ${result.stats.inputWords} → ${result.stats.outputWords} (${percent(result.stats.wordChangePercent)})`,
    `- Characters: ${result.stats.inputCharacters} → ${result.stats.outputCharacters} (${percent(result.stats.charChangePercent)})`,
    `- Changed: ${result.stats.replaced} replaced, ${result.stats.added} added, ${result.stats.removed} removed`,
    `- Database: ${stats.total} word(s), ${stats.contextEdges} context link(s)`,
    `- Landed ${result.stats.onTarget ? 'inside' : 'outside'} the tolerance band`,
    '',
  ];
  if (result.stats.unknownWords.length > 0) {
    report.push(
      '## Words not in the database',
      '',
      'These came in with the text and were kept as they are, but nothing could be read from them:',
      '',
      result.stats.unknownWords
        .slice(0, 60)
        .map((word) => `\`${word}\``)
        .join(', '),
      '',
    );
    ctx.log(`${result.stats.unknownWords.length} incoming word(s) are not in the database.`);
  }
  if (result.warnings.length > 0) {
    report.push('## Warnings', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }
  report.push('## Options used', '', '```json', JSON.stringify(resolved.options, null, 2), '```', '');

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'text',
      kind: 'text',
      fileName: 'text.txt',
      content: `${result.text}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'lexicon',
      kind: 'json',
      fileName: 'lexicon.json',
      content: `${JSON.stringify(resolved.lexicon, null, 2)}\n`,
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

  ctx.log(
    `${result.stats.outputWords} word(s), ${result.stats.outputCharacters} character(s) from ${stats.total} word database.`,
  );

  return { outputs, data: { ...data, output: result.text } };
}
