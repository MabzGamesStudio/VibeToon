/**
 * Artifacts are the files a flow produces or consumes. Every port on a flow is
 * typed by the artifact kind it carries, which is what makes a connection
 * between two flows checkable before anything is generated.
 */
export type ArtifactKind =
  | 'text' // plain .txt, e.g. dialog.txt
  | 'markdown' // .md briefs, bibles, notes
  | 'json' // structured data, e.g. scenes.json / storyboard.json
  | 'csv' // tabular data, e.g. shotlist.csv
  | 'image' // .png/.jpg, e.g. character.png
  | 'imageSet' // a folder of images, e.g. panels/*.png
  | 'audio' // .wav/.mp3
  | 'audioSet' // a folder of audio files, e.g. vo/*.wav
  | 'midi' // .mid
  | 'video' // .mp4/.webm
  | 'timeline'; // edit decision list / timing data

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'text',
  'markdown',
  'json',
  'csv',
  'image',
  'imageSet',
  'audio',
  'audioSet',
  'midi',
  'video',
  'timeline',
];

/**
 * What to call an artifact kind in the studio. `imageSet` is a folder of images
 * and `image` is one file, and a filter that offers both has to say which is
 * which in words rather than in camel case.
 */
export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  text: 'Text',
  markdown: 'Markdown',
  json: 'JSON',
  csv: 'CSV',
  image: 'Image',
  imageSet: 'Images (folder)',
  audio: 'Audio',
  audioSet: 'Audio (folder)',
  midi: 'MIDI',
  video: 'Video',
  timeline: 'Timeline',
};

/** Extension used when a generator has to pick one for an artifact kind. */
export const ARTIFACT_EXTENSION: Record<ArtifactKind, string> = {
  text: 'txt',
  markdown: 'md',
  json: 'json',
  csv: 'csv',
  image: 'png',
  imageSet: '',
  audio: 'wav',
  audioSet: '',
  midi: 'mid',
  video: 'mp4',
  timeline: 'json',
};

/** Artifact kinds whose bytes are text and can be shown in an editor. */
export const TEXTUAL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'text',
  'markdown',
  'json',
  'csv',
  'timeline',
];

export function isTextualArtifact(kind: ArtifactKind): boolean {
  return TEXTUAL_ARTIFACT_KINDS.includes(kind);
}

/**
 * A generated artifact, recorded on the flow that produced it. `path` is
 * relative to the project's artifact root so a project folder stays portable.
 */
export interface ArtifactRef {
  /** Port id that produced this artifact. */
  port: string;
  kind: ArtifactKind;
  /** File name, e.g. `dialog.txt`. */
  fileName: string;
  /** Project-relative path, e.g. `artifacts/<flowId>/dialog.txt`. */
  path: string;
  /** Content hash of the bytes, used for staleness checks downstream. */
  hash: string;
  bytes: number;
  generatedAt: string;
  /** Files inside an `imageSet` artifact, relative to `path`. */
  entries?: string[];
  /** Inline preview for small textual artifacts, so the UI can render without a second fetch. */
  preview?: string;
}
