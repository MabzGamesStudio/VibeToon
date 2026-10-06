import { generateAnimatic } from './animatic';
import { generateAssembly } from './assembly';
import { generateBind } from './bind';
import { generateBrief } from './brief';
import { generateCorpus } from './corpus';
import { generateCutout } from './cutout';
import { generateDesign } from './design';
import { generateDictionary } from './dictionary';
import { generateGrammar } from './grammar';
import { generateImage } from './image';
import { generateLexicon } from './lexicon';
import { generateMap } from './map';
import { generatePalette } from './palette';
import { generatePose } from './pose';
import { generateRigMatch } from './rigMatch';
import { generateVideoMatch } from './videoMatch';
import { generateResize } from './resize';
import { generateCrop } from './crop';
import { generateLines } from './lines';
import { generateVideoBackground } from './videoBackground';
import { generateVideoForeground } from './videoForeground';
import { generateCharacterSplit } from './characterSplit';
import { generateBatchSelect } from './batchSelect';
import { generateShots } from './shots';
import { generateVideoSource } from './videoSource';
import { generateVideoEdit } from './videoEdit';
import { generateLineGraph } from './lineGraph';
import { generateParts } from './parts';
import { generateFace } from './face';
import { generatePaletteFilter } from './paletteFilter';
import { generateRig } from './rig';
import { generateDialog } from './dialog';
import { generateStoryboard } from './storyboard';
import { generateText } from './text';
import { generateTimeline } from './timeline';
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
  'story.timeline': generateTimeline,
  'world.map': generateMap,
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
  'animation.bind': generateBind,
  'animation.pose': generatePose,
  'animation.match': generateRigMatch,
  'animation.parts': generateParts,
  'animation.face': generateFace,
  'animation.video.match': generateVideoMatch,
  'art.palette': generatePalette,
  'art.palette.filter': generatePaletteFilter,
  'art.image': generateImage,
  'art.cutout': generateCutout,
  'art.resize': generateResize,
  'art.crop': generateCrop,
  'art.lines': generateLines,
  'art.video.background': generateVideoBackground,
  'art.video.foreground': generateVideoForeground,
  'art.video.characters': generateCharacterSplit,
  'production.batch.select': generateBatchSelect,
  'animation.video.shots': generateShots,
  'animation.video.source': generateVideoSource,
  'animation.video.edit': generateVideoEdit,
  'art.lines.graph': generateLineGraph,
  'art.vectorize': generateVectorize,
  'art.vector.edit': generateVectorEdit,
  'production.edit': generateAssembly,
  'production.render': generateAssembly,
};

export function generatorFor(kind: string): Generator {
  return GENERATORS[kind] ?? generateBrief;
}

export * from './types';
