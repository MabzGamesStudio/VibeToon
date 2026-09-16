import {
  DEFAULT_GRAMMAR_OPTIONS,
  combineGrammar,
  extractGrammar,
  parsePattern,
  type GrammarDataset,
  type GrammarExtractOptions,
} from '../text/grammarDatabase';
import { SAMPLE_CORPUS, SAMPLE_CORPUS_NAME } from '../text/sampleCorpus';
import type { Lexicon } from '../types/text';
import { starterLexicon } from './lexicon';

/**
 * The grammar flow's state. Like the word database it keeps one dataset per
 * corpus and combines the ticked ones, so the same add-and-remove arithmetic
 * applies: patterns are counts, and taking a corpus out subtracts exactly what
 * it put in.
 */
export interface GrammarFlowData {
  editor: 'grammar';
  datasets: GrammarDataset[];
  included: string[];
  options: GrammarExtractOptions;
}

export function sampleGrammarDataset(lexicon: Lexicon = starterLexicon()): GrammarDataset {
  return extractGrammar(
    SAMPLE_CORPUS,
    lexicon,
    SAMPLE_CORPUS_NAME,
    { kind: 'builtin', reference: 'sample' },
    // The sample is short, so a shape seen twice is already worth keeping.
    { ...DEFAULT_GRAMMAR_OPTIONS, minCount: 2 },
  );
}

export function emptyGrammarFlowData(): GrammarFlowData {
  const sample = sampleGrammarDataset();
  return {
    editor: 'grammar',
    datasets: [sample],
    included: [sample.id],
    options: { ...DEFAULT_GRAMMAR_OPTIONS },
  };
}

export function includedGrammarDatasets(data: GrammarFlowData): GrammarDataset[] {
  return data.datasets.filter((dataset) => data.included.includes(dataset.id));
}

export function masterGrammar(data: GrammarFlowData): GrammarDataset {
  return combineGrammar(includedGrammarDatasets(data), 'Master');
}

export function addGrammarDataset(
  data: GrammarFlowData,
  dataset: GrammarDataset,
  include = true,
): GrammarFlowData {
  return {
    ...data,
    datasets: [...data.datasets, dataset],
    included: include ? [...data.included, dataset.id] : data.included,
  };
}

export function removeGrammarDataset(data: GrammarFlowData, datasetId: string): GrammarFlowData {
  return {
    ...data,
    datasets: data.datasets.filter((dataset) => dataset.id !== datasetId),
    included: data.included.filter((id) => id !== datasetId),
  };
}

export function setGrammarIncluded(
  data: GrammarFlowData,
  datasetId: string,
  included: boolean,
): GrammarFlowData {
  const without = data.included.filter((id) => id !== datasetId);
  return { ...data, included: included ? [...without, datasetId] : without };
}

/** A dataset counted from a wire replaces the previous one from that wire. */
export function replaceGrammarDatasetFor(
  data: GrammarFlowData,
  reference: string,
  dataset: GrammarDataset,
): GrammarFlowData {
  const previous = data.datasets.find(
    (candidate) => candidate.source.kind === 'flow' && candidate.source.reference === reference,
  );
  if (!previous) return addGrammarDataset(data, dataset);
  return {
    ...data,
    datasets: data.datasets.map((candidate) => (candidate.id === previous.id ? dataset : candidate)),
    included: data.included.map((id) => (id === previous.id ? dataset.id : id)),
  };
}

export interface GrammarSummary {
  datasets: number;
  included: number;
  sentencePatterns: number;
  fragmentPatterns: number;
  phrasePatterns: number;
  sentencesRead: number;
  tokensRead: number;
  /** Tokens that are words rather than marks — what coverage is measured against. */
  wordsRead: number;
  /** Share of words the word database could type, 0..1. */
  coverage: number;
}

export function summariseGrammar(data: GrammarFlowData, master: GrammarDataset): GrammarSummary {
  const words = master.stats.tagged + master.stats.unknown;
  return {
    datasets: data.datasets.length,
    included: data.included.length,
    sentencePatterns: master.sentences.length,
    fragmentPatterns: master.fragments.length,
    phrasePatterns: master.phrases.length,
    sentencesRead: master.stats.sentences,
    tokensRead: master.stats.tokens,
    wordsRead: words,
    coverage: words > 0 ? master.stats.tagged / words : 0,
  };
}

/** A pattern written out for a person to read: `the (adjective) noun verb.` */
export function describePattern(signature: string): string {
  return parsePattern(signature)
    .map((slot) =>
      slot.type === 'punctuation'
        ? slot.mark ?? '.'
        : slot.form
          ? `${slot.type}·${slot.form.replace(/_/g, ' ')}`
          : slot.type,
    )
    .join(' ');
}
