import { generateAnimatic } from './animatic';
import { generateAssembly } from './assembly';
import { generateBrief } from './brief';
import { generateCorpus } from './corpus';
import { generateDesign } from './design';
import { generateDictionary } from './dictionary';
import { generateGrammar } from './grammar';
import { generateLexicon } from './lexicon';
import { generateDialog } from './dialog';
import { generateStoryboard } from './storyboard';
import { generateText } from './text';
import type { Generator } from './types';

/**
 * Flow kinds map to a generator. Everything without a bespoke one falls back to
 * the brief generator, which is what makes a newly added flow kind useful the
 * moment it appears in the catalogue.
 */
const GENERATORS: Record<string, Generator> = {
  'story.dialog': generateDialog,
  'animation.storyboard': generateStoryboard,
  'text.random': generateText,
  'text.corpus': generateCorpus,
  'text.lexicon': generateLexicon,
  'text.dictionary': generateDictionary,
  'text.grammar': generateGrammar,
  'animation.character.design': generateDesign,
  'animation.set.design': generateDesign,
  'animation.prop.design': generateDesign,
  'animation.animatic': generateAnimatic,
  'production.edit': generateAssembly,
  'production.render': generateAssembly,
};

export function generatorFor(kind: string): Generator {
  return GENERATORS[kind] ?? generateBrief;
}

export * from './types';
