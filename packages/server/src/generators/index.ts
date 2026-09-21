import { generateAnimatic } from './animatic';
import { generateAssembly } from './assembly';
import { generateBrief } from './brief';
import { generateCorpus } from './corpus';
import { generateCutout } from './cutout';
import { generateDesign } from './design';
import { generateDictionary } from './dictionary';
import { generateGrammar } from './grammar';
import { generateImage } from './image';
import { generateLexicon } from './lexicon';
import { generatePalette } from './palette';
import { generatePaletteFilter } from './paletteFilter';
import { generateRig } from './rig';
import { generateDialog } from './dialog';
import { generateStoryboard } from './storyboard';
import { generateText } from './text';
import { generateVectorEdit } from './vectorEdit';
import { generateVectorize } from './vectorize';
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
  'animation.rig': generateRig,
  'art.palette': generatePalette,
  'art.palette.filter': generatePaletteFilter,
  'art.image': generateImage,
  'art.cutout': generateCutout,
  'art.vectorize': generateVectorize,
  'art.vector.edit': generateVectorEdit,
  'production.edit': generateAssembly,
  'production.render': generateAssembly,
};

export function generatorFor(kind: string): Generator {
  return GENERATORS[kind] ?? generateBrief;
}

export * from './types';
