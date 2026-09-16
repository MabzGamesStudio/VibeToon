import {
  applyMeaningsToLexicon,
  lexiconStats,
  summariseDictionary,
  wordsToLookUp,
  type DictionaryFlowData,
  type Lexicon,
} from '@vibetoon/shared';
import { activeProvider } from '../text/dictionary';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

const READ_LIMIT = 16_000_000;

/**
 * Put what the dictionary said onto the word database coming in.
 *
 * The asking happens in the editor, where a long run has a progress bar and a
 * Stop button; this applies what has been learned. So generating is instant and
 * repeatable, and a lookup stopped half way is still worth generating.
 */
export async function generateDictionary(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as DictionaryFlowData;

  const input = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'lexicon' && candidate.artifact !== undefined,
  );
  if (!input?.artifact) {
    ctx.warn('No word database wired in — connect one to the Word database input.');
    return { outputs: [] };
  }

  let lexicon: Lexicon;
  try {
    const parsed = JSON.parse((await ctx.readUpstream(input, READ_LIMIT)) ?? '') as Lexicon;
    if (!Array.isArray(parsed.lexemes)) throw new Error('no `lexemes` array');
    lexicon = parsed;
  } catch (error) {
    ctx.warn(`Could not read the word database from ${input.sourceNode.name}: ${String(error)}`);
    return { outputs: [] };
  }

  ctx.log(`Read ${lexicon.lexemes.length} word(s) from ${input.sourceNode.name}.`);

  const applied = applyMeaningsToLexicon(lexicon, data);
  const summary = summariseDictionary(data);
  const outstanding = wordsToLookUp(applied.lexicon, data);
  const service = activeProvider(data.providerId);
  const stats = lexiconStats(applied.lexicon);

  if (summary.known === 0) {
    ctx.warn('Nothing has been looked up yet — press “Look up” in this flow’s editor.');
  } else if (outstanding.length > 0) {
    ctx.warn(
      `${outstanding.length} word(s) have never been asked about, so their type is still a guess.`,
    );
  }

  const byType = new Map<string, number>();
  for (const lexeme of applied.lexicon.lexemes) {
    byType.set(lexeme.type, (byType.get(lexeme.type) ?? 0) + 1);
  }

  const report = [
    `# ${ctx.node.name} — dictionary`,
    '',
    `- Service: **${service.provider.label}** (${service.reason})`,
    `- Words in: ${lexicon.lexemes.length}`,
    `- Answers held: ${summary.known} (${summary.fromDictionary} from the dictionary, ${summary.guessed} guessed)`,
    `- Types changed by this run: **${applied.retyped}**`,
    `- Descriptions filled in: ${applied.described}`,
    `- Still never asked about: ${outstanding.length}`,
    '',
    '## Word types now',
    '',
    '| Type | Words |',
    '| --- | --- |',
    ...[...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `| ${type} | ${count} |`),
    '',
    ...(outstanding.length > 0
      ? [
          '## The commonest words with no answer yet',
          '',
          ...outstanding.slice(0, 20).map((word) => `- \`${word}\``),
          '',
        ]
      : []),
    '## Settings',
    '',
    '```json',
    JSON.stringify(data.options, null, 2),
    '```',
    '',
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'lexicon',
      kind: 'json',
      fileName: 'lexicon.json',
      content: `${JSON.stringify(applied.lexicon, null, 2)}\n`,
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
    `${applied.retyped} word(s) retyped, ${applied.described} described, ${stats.total} out.`,
  );
  return { outputs };
}
