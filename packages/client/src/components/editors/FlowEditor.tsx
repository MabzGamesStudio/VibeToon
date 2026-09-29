import type { FlowNode } from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { AnimaticEditor } from './AnimaticEditor';
import { BindFlowEditor } from './BindFlowEditor';
import { BriefEditor } from './BriefEditor';
import { DesignEditor } from './DesignEditor';
import { CorpusFlowEditor } from './CorpusFlowEditor';
import { CutoutFlowEditor } from './CutoutFlowEditor';
import { DictionaryFlowEditor } from './DictionaryFlowEditor';
import { GrammarFlowEditor } from './GrammarFlowEditor';
import { ImageFlowEditor } from './ImageFlowEditor';
import { LexiconFlowEditor } from './LexiconFlowEditor';
import { PaletteFlowEditor } from './PaletteFlowEditor';
import { PoseFlowEditor } from './PoseFlowEditor';
import { PaletteFilterFlowEditor } from './PaletteFilterFlowEditor';
import { RigFlowEditor } from './RigFlowEditor';
import { DialogEditor } from './DialogEditor';
import { EditorShell } from './EditorShell';
import { StoryboardEditor } from './StoryboardEditor';
import { TextEditor } from './TextEditor';
import { TimelineFlowEditor } from './TimelineFlowEditor';
import { MapFlowEditor } from './MapFlowEditor';
import { RigMatchFlowEditor } from './RigMatchFlowEditor';
import { CustomFlowEditor } from './CustomFlowEditor';
import { VideoMatchFlowEditor } from './VideoMatchFlowEditor';
import { ResizeFlowEditor } from './ResizeFlowEditor';
import { CropFlowEditor } from './CropFlowEditor';
import { LinesFlowEditor } from './LinesFlowEditor';
import { VideoBackgroundFlowEditor } from './VideoBackgroundFlowEditor';
import { ShotsFlowEditor } from './ShotsFlowEditor';
import { VideoSourceFlowEditor } from './VideoSourceFlowEditor';
import { VideoEditFlowEditor } from './VideoEditFlowEditor';
import { LineGraphFlowEditor } from './LineGraphFlowEditor';
import { PartsFlowEditor } from './PartsFlowEditor';
import { FaceFlowEditor } from './FaceFlowEditor';
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
    case 'bind':
      return <BindFlowEditor project={project} node={node} />;
    case 'pose':
      return <PoseFlowEditor project={project} node={node} />;
    case 'rig':
      return <RigFlowEditor project={project} node={node} />;
    case 'timeline':
      return <TimelineFlowEditor project={project} node={node} />;
    case 'map':
      return <MapFlowEditor project={project} node={node} />;
    case 'rigMatch':
      return <RigMatchFlowEditor project={project} node={node} />;
    case 'custom':
      return <CustomFlowEditor project={project} node={node} />;
    case 'videoMatch':
      return <VideoMatchFlowEditor project={project} node={node} />;
    case 'resize':
      return <ResizeFlowEditor project={project} node={node} />;
    case 'crop':
      return <CropFlowEditor project={project} node={node} />;
    case 'lines':
      return <LinesFlowEditor project={project} node={node} />;
    case 'videoBackground':
      return <VideoBackgroundFlowEditor project={project} node={node} />;
    case 'shots':
      return <ShotsFlowEditor project={project} node={node} />;
    case 'videoSource':
      return <VideoSourceFlowEditor project={project} node={node} />;
    case 'videoEdit':
      return <VideoEditFlowEditor project={project} node={node} />;
    case 'lineGraph':
      return <LineGraphFlowEditor project={project} node={node} />;
    case 'parts':
      return <PartsFlowEditor project={project} node={node} />;
    case 'face':
      return <FaceFlowEditor project={project} node={node} />;
    default:
      return <BriefEditor project={project} node={node} />;
  }
}
