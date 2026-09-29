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
  | 'videoSet' // a folder of clips, e.g. clips/*.webm
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
  'videoSet',
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
  videoSet: 'Videos (folder)',
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
  videoSet: '',
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
  /** A set's files by name, each with the hash of its own bytes. */
  entryHashes?: Record<string, string>;
  /**
   * A batch: this port carries one artifact for each item of a batch flow, in
   * order. The ref stands for them all — its hash changes when any does — and
   * `entries` lists them relative to `path`, so it can also be read as a set.
   */
  items?: BatchItemRef[];
  /** Inline preview for small textual artifacts, so the UI can render without a second fetch. */
  preview?: string;
}

/** One item of a batch, as it arrives over a wire. */
export interface BatchItemRef {
  /** Stable across runs: the file name it came from, e.g. `shot-03.webm`. */
  key: string;
  label: string;
  /** Missing while that item has made nothing on this port. */
  artifact?: ArtifactRef;
}

/** What each kind of folder holds one of. */
export const SET_ITEM_KIND: Partial<Record<ArtifactKind, ArtifactKind>> = {
  imageSet: 'image',
  videoSet: 'video',
  audioSet: 'audio',
};

/** The folder kind for a kind of file, if there is one. */
export const ITEM_SET_KIND: Partial<Record<ArtifactKind, ArtifactKind>> = {
  image: 'imageSet',
  video: 'videoSet',
  audio: 'audioSet',
};
