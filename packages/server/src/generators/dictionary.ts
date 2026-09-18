import {
  applyMeaningsToLexicon,
  lexiconStats,
  summariseDictionary,
  wordsToLookUp,
  type DictionaryFlowData,
  type Lexicon,
} from '@vibetoon/shared';
import { activeProvider } from '../text/dictionary';
import { morphologyStatus } from '../text/morphology';
import { writeArtifact } from '../storage';
import { readsWhole, type GenerationContext, type GenerationResult } from './types';

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
  const body = await ctx.readUpstream(input, READ_LIMIT);
  if (!readsWhole(body)) {
    ctx.warn(
      `The word database from ${input.sourceNode.name} is larger than this flow will read, so it was cut short and could not be used.`,
    );
    return { outputs: [] };
  }
  try {
    const parsed = JSON.parse(body ?? '') as Lexicon;
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
  const forms = await morphologyStatus(data.morphologyId);
  const stats = lexiconStats(applied.lexicon);

  if (summary.known === 0) {
    ctx.warn('Nothing has been looked up yet — press “Look up” in this flow’s editor.');
  } else if (outstanding.length > 0) {
    ctx.warn(
      `${outstanding.length} word(s) have never been asked about, so their type is “not looked up”.`,
    );
  }
  if (!forms.ready) {
    ctx.warn(
      `The ${forms.sources.find((source) => source.id === forms.activeId)?.label ?? 'forms'} dataset has not been built on this machine, so no word has its forms. Press “Get the forms dataset” in this flow’s editor.`,
    );
  } else if (applied.formless > 0) {
    ctx.warn(
      `${applied.formless} word(s) that should have other forms are not in the forms dataset, so theirs are unknown rather than guessed.`,
    );
  }

  const byType = new Map<string, number>();
  for (const lexeme of applied.lexicon.lexemes) {
    byType.set(lexeme.type, (byType.get(lexeme.type) ?? 0) + 1);
  }

  const report = [
    `# ${ctx.node.name} — dictionary`,
    '',
    `- Dictionary: **${service.provider.label}** (${service.reason})`,
    `- Forms: **${forms.sources.find((source) => source.id === forms.activeId)?.label ?? forms.activeId}** (${forms.reason}) — ${
      forms.ready
        ? `${forms.paradigms.toLocaleString()} paradigms indexed, ${forms.spellings.toLocaleString()} spellings`
        : '**not built on this machine**'
    }`,
    `- Words in: ${lexicon.lexemes.length}`,
    `- Words out: **${applied.lexicon.lexemes.length}**`,
    `- Answers held: ${summary.known} spelling(s), ${summary.senses} sense(s); ${summary.fromDictionary} from the dictionary, ${summary.absent} with no entry`,
    `- Extra entries from words with several meanings: **${applied.split}**`,
    `- Extra entries that are a form of another word: **${applied.variants}**`,
    `- Words already counted that were joined to their forms: ${applied.linkedVariants}`,
    `- Types changed by this run: ${applied.retyped}`,
    `- Descriptions filled in: ${applied.described}`,
    `- Should have forms but the dataset has none: ${applied.formless}`,
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
    `${applied.retyped} word(s) retyped, ${applied.described} described, ${applied.split} split by meaning, ${applied.variants} form(s) added, ${stats.total} out.`,
  );
  return { outputs };
}
