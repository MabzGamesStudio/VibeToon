import type { FlowNode } from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { AnimaticEditor } from './AnimaticEditor';
import { BriefEditor } from './BriefEditor';
import { DesignEditor } from './DesignEditor';
import { CorpusFlowEditor } from './CorpusFlowEditor';
import { DictionaryFlowEditor } from './DictionaryFlowEditor';
import { GrammarFlowEditor } from './GrammarFlowEditor';
import { LexiconFlowEditor } from './LexiconFlowEditor';
import { DialogEditor } from './DialogEditor';
import { EditorShell } from './EditorShell';
import { StoryboardEditor } from './StoryboardEditor';
import { TextEditor } from './TextEditor';

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
    default:
      return <BriefEditor project={project} node={node} />;
  }
}
