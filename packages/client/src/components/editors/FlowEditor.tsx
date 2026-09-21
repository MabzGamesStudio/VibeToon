import type { FlowNode } from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { AnimaticEditor } from './AnimaticEditor';
import { BriefEditor } from './BriefEditor';
import { DesignEditor } from './DesignEditor';
import { CorpusFlowEditor } from './CorpusFlowEditor';
import { CutoutFlowEditor } from './CutoutFlowEditor';
import { DictionaryFlowEditor } from './DictionaryFlowEditor';
import { GrammarFlowEditor } from './GrammarFlowEditor';
import { ImageFlowEditor } from './ImageFlowEditor';
import { LexiconFlowEditor } from './LexiconFlowEditor';
import { PaletteFlowEditor } from './PaletteFlowEditor';
import { PaletteFilterFlowEditor } from './PaletteFilterFlowEditor';
import { RigFlowEditor } from './RigFlowEditor';
import { DialogEditor } from './DialogEditor';
import { EditorShell } from './EditorShell';
import { StoryboardEditor } from './StoryboardEditor';
import { TextEditor } from './TextEditor';
import { VectorEditFlowEditor } from './VectorEditFlowEditor';
import { VectorizeFlowEditor } from './VectorizeFlowEditor';

/** Picks the editor a flow's data asks for. */
export function FlowEditor({ node }: { node: FlowNode }): JSX.Element {
  const { project } = useStudio();
  if (!project) return <></>;

  switch (node.data.editor) {
    case 'dialog':
      return (
        <EditorShell project={project} node={node}>
          <DialogEditor project={project} node={node} />
        </EditorShell>
      );
    case 'storyboard':
      return <StoryboardEditor project={project} node={node} />;
    case 'text':
      return <TextEditor project={project} node={node} />;
    case 'animatic':
      return <AnimaticEditor project={project} node={node} />;
    case 'design':
      return <DesignEditor project={project} node={node} />;
    case 'lexicon':
      return <LexiconFlowEditor project={project} node={node} />;
    case 'grammar':
      return <GrammarFlowEditor project={project} node={node} />;
    case 'corpus':
      return <CorpusFlowEditor project={project} node={node} />;
    case 'dictionary':
      return <DictionaryFlowEditor project={project} node={node} />;
    case 'palette':
      return <PaletteFlowEditor project={project} node={node} />;
    case 'paletteFilter':
      return <PaletteFilterFlowEditor project={project} node={node} />;
    case 'image':
      return <ImageFlowEditor project={project} node={node} />;
    case 'cutout':
      return <CutoutFlowEditor project={project} node={node} />;
    case 'vectorize':
      return <VectorizeFlowEditor project={project} node={node} />;
    case 'vectorEdit':
      return <VectorEditFlowEditor project={project} node={node} />;
    case 'rig':
      return <RigFlowEditor project={project} node={node} />;
    default:
      return <BriefEditor project={project} node={node} />;
  }
}
