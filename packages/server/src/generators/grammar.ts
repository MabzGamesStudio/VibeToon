import {
  describePattern,
  extractGrammar,
  includedGrammarDatasets,
  masterGrammar,
  replaceGrammarDatasetFor,
  summariseGrammar,
  type GrammarFlowData,
  type Lexicon,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import { readsWhole, type GenerationContext, type GenerationResult } from './types';

const CORPUS_READ_LIMIT = 4_000_000;

/**
 * A word database is data and is read whole: with a row per form of every word
 * and a paradigm on each, it is several times the size of the text it came from.
 */
const DATABASE_READ_LIMIT = 64_000_000;

/**
 * Reads corpora against a word database and counts the shapes their sentences
 * make. The word database is what makes this possible: it supplies the type and
 * form of each token, so `the lamp hangs` becomes a shape rather than a phrase.
 */
export async function generateGrammar(ctx: GenerationContext): Promise<GenerationResult> {
  let data = ctx.node.data as GrammarFlowData;

  const lexiconInput = ctx.inputs.find(
    (input) => input.connection.to.portId === 'lexicon' && input.artifact !== undefined,
  );
  let lexicon: Lexicon | null = null;
  if (lexiconInput?.artifact) {
    const body = await ctx.readUpstream(lexiconInput, DATABASE_READ_LIMIT);
    if (!readsWhole(body)) {
      ctx.warn(
        `The word database from ${lexiconInput.sourceNode.name} is larger than this flow will read, so it was cut short and could not be used.`,
      );
    } else {
      try {
        const parsed = JSON.parse(body ?? '') as Lexicon;
        if (!Array.isArray(parsed.lexemes)) throw new Error('no `lexemes` array');
        lexicon = parsed;
        ctx.log(`Read ${parsed.lexemes.length} word(s) from ${lexiconInput.sourceNode.name}.`);
      } catch (error) {
        ctx.warn(`Could not read the word database from ${lexiconInput.sourceNode.name}: ${String(error)}`);
      }
    }
  } else {
    ctx.warn(
      'No word database wired in, so no word has a type — wire one into the Word database input.',
    );
  }

  if (lexicon) {
    for (const input of ctx.inputs) {
      if (input.connection.to.portId !== 'corpus') continue;
      const text = await ctx.readUpstream(input, CORPUS_READ_LIMIT);
      if (!text?.trim()) {
        ctx.warn(`${input.sourceNode.name} has not generated any text to read yet.`);
        continue;
      }
      const dataset = extractGrammar(
        text,
        lexicon,
        input.sourceNode.name,
        { kind: 'flow', reference: input.connection.id },
        data.options,
      );
      data = replaceGrammarDatasetFor(data, input.connection.id, dataset);
      ctx.log(
        `Read ${dataset.stats.sentences} sentence(s) from ${input.sourceNode.name}: ${dataset.sentences.length} shape(s).`,
      );
    }
  }

  const master = masterGrammar(data);
  const summary = summariseGrammar(data, master);
  const included = includedGrammarDatasets(data);

  if (included.length === 0) ctx.warn('No corpus is included, so the grammar database is empty.');
  if (summary.coverage < 0.9 && summary.wordsRead > 0) {
    ctx.warn(
      `The word database has an entry for only ${Math.round(summary.coverage * 100)}% of the words read — the rest were typed by guess.`,
    );
  }

  const report = [
    `# ${ctx.node.name} — grammar database`,
    '',
    `- Sentence shapes: **${summary.sentencePatterns}** from ${summary.sentencesRead} sentence(s) read`,
    `- Fragment shapes: ${summary.fragmentPatterns}`,
    `- Phrase shapes: ${summary.phrasePatterns}`,
    `- Words found in the database: ${Math.round(summary.coverage * 100)}% of ${summary.wordsRead}`,
    `- Corpora included: ${included.length} of ${data.datasets.length}`,
    '',
    '## What went into it',
    '',
    ...(included.length === 0
      ? ['Nothing is included.', '']
      : [
          '| Corpus | Sentences | Shapes | Phrases |',
          '| --- | --- | --- | --- |',
          ...included.map(
            (dataset) =>
              `| ${dataset.name} | ${dataset.stats.sentences} | ${dataset.sentences.length} | ${dataset.phrases.length} |`,
          ),
          '',
        ]),
    '## The commonest sentence shapes',
    '',
    ...master.sentences.slice(0, 15).map(([signature, count]) => `- ${count}× \`${describePattern(signature)}\``),
    '',
    '## The commonest phrases',
    '',
    ...master.phrases.slice(0, 15).map(([signature, count]) => `- ${count}× \`${describePattern(signature)}\``),
    '',
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
      port: 'grammar',
      kind: 'json',
      fileName: 'grammar.json',
      content: `${JSON.stringify(master, null, 2)}\n`,
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
    `${summary.sentencePatterns} sentence shape(s), ${summary.phrasePatterns} phrase(s), from ${included.length} corpus/corpora.`,
  );

  return { outputs, data };
}
