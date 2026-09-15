import {
  extractCorpus,
  fillTokenMeanings,
  includedDatasets,
  masterDataset,
  masterLexicon,
  replaceDatasetFor,
  summarise,
  type LexiconFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

const CORPUS_READ_LIMIT = 4_000_000;

/**
 * Counts in, database out. Text wired into the Corpus input is counted as its
 * own dataset, so a flow can feed the database the way a book does — and it is
 * replaced rather than added to on every run, so generating twice does not count
 * the same text twice.
 */
export async function generateLexicon(ctx: GenerationContext): Promise<GenerationResult> {
  let data = ctx.node.data as LexiconFlowData;

  for (const input of ctx.inputs) {
    if (input.connection.to.portId !== 'corpus') continue;
    const text = await ctx.readUpstream(input, CORPUS_READ_LIMIT);
    if (!text?.trim()) {
      ctx.warn(`${input.sourceNode.name} has not generated any text to count yet.`);
      continue;
    }
    const dataset = extractCorpus(
      text,
      input.sourceNode.name,
      { kind: 'flow', reference: input.connection.id },
      data.extract,
    );
    data = replaceDatasetFor(data, input.connection.id, dataset);
    ctx.log(`Counted ${dataset.tokenCount} token(s) from ${input.sourceNode.name}.`);
  }

  data = fillTokenMeanings(data);

  const master = masterDataset(data);
  const lexicon = masterLexicon(data, master);
  const summary = summarise(data, lexicon, master);
  const included = includedDatasets(data);

  if (included.length === 0) ctx.warn('No corpus is included, so the database is empty.');
  if (summary.undefined > 0) {
    ctx.warn(
      `${summary.undefined} word(s) have no dictionary entry yet — their type is a guess. Use “Look up words” in the editor.`,
    );
  }

  const report = [
    `# ${ctx.node.name} — word database`,
    '',
    `- Words: **${summary.words}** from ${summary.tokens} counted token(s)`,
    `- Context links: ${summary.links}`,
    `- Corpora included: ${included.length} of ${data.datasets.length}`,
    `- Definitions: ${summary.defined} from the dictionary, ${summary.undefined} still guessed`,
    '',
    '## What went into it',
    '',
    ...(included.length === 0
      ? ['Nothing is included.', '']
      : [
          '| Corpus | Source | Tokens | Words kept |',
          '| --- | --- | --- | --- |',
          ...included.map(
            (dataset) =>
              `| ${dataset.name} | ${dataset.source.kind}${
                dataset.source.reference ? ` (${dataset.source.reference})` : ''
              } | ${dataset.tokenCount} | ${dataset.entries.length} |`,
          ),
          '',
        ]),
    ...(data.datasets.length > included.length
      ? [
          '## Held back',
          '',
          ...data.datasets
            .filter((dataset) => !data.included.includes(dataset.id))
            .map((dataset) => `- ${dataset.name} (${dataset.tokenCount} tokens) — not counted in this database`),
          '',
        ]
      : []),
    '## Settings',
    '',
    '```json',
    JSON.stringify({ extract: data.extract, derive: data.derive }, null, 2),
    '```',
    '',
    '## The most common words',
    '',
    '| Word | Type | Count | Frequency | Links |',
    '| --- | --- | --- | --- | --- |',
    ...lexicon.lexemes
      .slice()
      .sort((a, b) => (b.stats?.count ?? 0) - (a.stats?.count ?? 0))
      .slice(0, 25)
      .map(
        (lexeme) =>
          `| \`${lexeme.spelling}\` | ${lexeme.type} | ${lexeme.stats?.count ?? 0} | ${lexeme.frequency.toFixed(
            2,
          )} | ${lexeme.contexts.length} |`,
      ),
    '',
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'lexicon',
      kind: 'json',
      fileName: 'lexicon.json',
      content: `${JSON.stringify(lexicon, null, 2)}\n`,
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
    `${summary.words} word(s), ${summary.links} link(s), from ${included.length} corpus/corpora (${summary.tokens} tokens).`,
  );
  return { outputs, data };
}
