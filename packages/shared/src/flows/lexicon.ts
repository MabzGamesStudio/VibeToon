import {
  DEFAULT_DERIVE_OPTIONS,
  DEFAULT_EXTRACT_OPTIONS,
  combineDatasets,
  deriveLexicon,
  extractCorpus,
  isLookupCandidate,
  meaningForToken,
  type CorpusDataset,
  type CorpusExtractOptions,
  type DeriveLexiconOptions,
  type WordMeaning,
} from '../text/corpus';
import { SAMPLE_CORPUS, SAMPLE_CORPUS_NAME } from '../text/sampleCorpus';
import type { Lexicon } from '../types/text';

/**
 * The word database flow's state. Datasets are kept as counts and never merged
 * destructively: the master is whatever the included ones add up to, so
 * unticking a book is a subtraction and nothing is lost by it.
 */
export interface LexiconFlowData {
  editor: 'lexicon';
  datasets: CorpusDataset[];
  /** Dataset ids that make up the master. */
  included: string[];
  /** Word type and description per spelling, from the dictionary or guessed. */
  meanings: Record<string, WordMeaning>;
  /** Applied when a corpus is added; a dataset keeps the counts it was pruned to. */
  extract: CorpusExtractOptions;
  /** Applied every time the master is derived, so it can be changed freely. */
  derive: DeriveLexiconOptions;
}

/** A small sample corpus so the flow does something before anything is fetched. */
export function sampleDataset(): CorpusDataset {
  return extractCorpus(
    SAMPLE_CORPUS,
    SAMPLE_CORPUS_NAME,
    { kind: 'builtin', reference: 'sample' },
    // The sample is short, so a pair seen once is still worth keeping.
    { ...DEFAULT_EXTRACT_OPTIONS, minPairCount: 1 },
  );
}

export function emptyLexiconFlowData(): LexiconFlowData {
  const sample = sampleDataset();
  return {
    editor: 'lexicon',
    datasets: [sample],
    included: [sample.id],
    meanings: {},
    extract: { ...DEFAULT_EXTRACT_OPTIONS },
    derive: { ...DEFAULT_DERIVE_OPTIONS },
  };
}

/**
 * The lexicon a Random Text flow starts with: the sample corpus, counted. It is
 * the same pipeline a database built from a book goes through, just with a
 * corpus small enough to bundle.
 */
export function starterLexicon(): Lexicon {
  const data = fillTokenMeanings(emptyLexiconFlowData());
  return masterLexicon(data);
}

export function includedDatasets(data: LexiconFlowData): CorpusDataset[] {
  return data.datasets.filter((dataset) => data.included.includes(dataset.id));
}

/** The master: every included dataset's counts added together. */
export function masterDataset(data: LexiconFlowData): CorpusDataset {
  return combineDatasets(includedDatasets(data), 'Master');
}

export function masterLexicon(data: LexiconFlowData, master = masterDataset(data)): Lexicon {
  return deriveLexicon(master, data.meanings, data.derive);
}

export function addDataset(data: LexiconFlowData, dataset: CorpusDataset, include = true): LexiconFlowData {
  return {
    ...data,
    datasets: [...data.datasets, dataset],
    included: include ? [...data.included, dataset.id] : data.included,
  };
}

export function removeDataset(data: LexiconFlowData, datasetId: string): LexiconFlowData {
  return {
    ...data,
    datasets: data.datasets.filter((dataset) => dataset.id !== datasetId),
    included: data.included.filter((id) => id !== datasetId),
  };
}

/** Tick or untick a dataset. Unticking is the subtraction. */
export function setIncluded(data: LexiconFlowData, datasetId: string, included: boolean): LexiconFlowData {
  const without = data.included.filter((id) => id !== datasetId);
  return { ...data, included: included ? [...without, datasetId] : without };
}

/** A dataset extracted from a wire replaces the previous one from that wire. */
export function replaceDatasetFor(
  data: LexiconFlowData,
  reference: string,
  dataset: CorpusDataset,
): LexiconFlowData {
  const previous = data.datasets.find(
    (candidate) => candidate.source.kind === 'flow' && candidate.source.reference === reference,
  );
  if (!previous) return addDataset(data, dataset);

  return {
    ...data,
    datasets: data.datasets.map((candidate) => (candidate.id === previous.id ? dataset : candidate)),
    included: data.included.map((id) => (id === previous.id ? dataset.id : id)),
  };
}

/** Spellings in the master that no dictionary lookup has covered yet. */
export function wordsNeedingLookup(data: LexiconFlowData, master = masterDataset(data)): string[] {
  return master.entries
    .map((entry) => entry.spelling)
    .filter((spelling) => isLookupCandidate(spelling) && !data.meanings[spelling]);
}

/** Punctuation and numbers get their meaning here rather than from a dictionary. */
export function fillTokenMeanings(data: LexiconFlowData, master = masterDataset(data)): LexiconFlowData {
  const meanings = { ...data.meanings };
  let changed = false;
  for (const entry of master.entries) {
    if (meanings[entry.spelling]) continue;
    const meaning = meaningForToken(entry.spelling);
    if (!meaning) continue;
    meanings[entry.spelling] = meaning;
    changed = true;
  }
  return changed ? { ...data, meanings } : data;
}

export interface LexiconSummary {
  datasets: number;
  included: number;
  words: number;
  tokens: number;
  links: number;
  /** Words whose type and description came from the dictionary. */
  defined: number;
  /** Words still waiting on a lookup. */
  undefined: number;
}

export function summarise(data: LexiconFlowData, lexicon: Lexicon, master: CorpusDataset): LexiconSummary {
  const defined = lexicon.lexemes.filter(
    (lexeme) => data.meanings[lexeme.spelling]?.source === 'dictionary',
  ).length;
  return {
    datasets: data.datasets.length,
    included: data.included.length,
    words: lexicon.lexemes.length,
    tokens: master.tokenCount,
    links: lexicon.lexemes.reduce((sum, lexeme) => sum + lexeme.contexts.length, 0),
    defined,
    undefined: wordsNeedingLookup(data, master).length,
  };
}
