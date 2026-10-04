/**
 * A video brought into the project: uploaded from this machine, or fetched
 * from a link.
 *
 * Like a picture, the file is stored with the project rather than fetched
 * again on each run, so the flow keeps working when the address stops. What
 * the flow itself keeps is where the video came from and what it is — its
 * format and size, and, once the editor has played it, its length and
 * dimensions.
 */

export type VideoOrigin = 'upload' | 'link';

export interface VideoSourceInfo {
  origin: VideoOrigin;
  fileName: string;
  /** Sniffed from the bytes, not taken from a header. */
  contentType: string;
  bytes: number;
  url?: string;
  addedAt: string;
  /** Measured by the editor once the browser has read it. */
  duration?: number;
  width?: number;
  height?: number;
}

export interface VideoSourceFlowData {
  editor: 'videoSource';
  source: VideoSourceInfo | null;
  description: string;
  credit: string;
}

export function emptyVideoSourceFlowData(): VideoSourceFlowData {
  return { editor: 'videoSource', source: null, description: '', credit: '' };
}

/** Every video format a file can be recognised as, and the extension each is stored with. */
export const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-ms-asf': 'wmv',
  'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  'video/mpeg': 'mpg',
};

const LABEL: Record<string, string> = {
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
  'video/quicktime': 'QuickTime',
  'video/ogg': 'Ogg',
  'video/x-matroska': 'Matroska',
  'video/x-msvideo': 'AVI',
  'video/x-ms-asf': 'Windows Media',
  'video/x-flv': 'Flash Video',
  'video/mp2t': 'MPEG transport stream',
  'video/mpeg': 'MPEG',
};

/**
 * Formats a browser can play (what is inside still has to be a codec it
 * knows). Anything else is converted to MP4 when it arrives, where ffmpeg is
 * installed, so every flow that reads a video can read it.
 */
export const BROWSER_VIDEO_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-matroska']);

/** True for a format a browser cannot open at all, which is converted on arrival. */
export function videoNeedsConversion(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType in VIDEO_TYPES && !BROWSER_VIDEO_TYPES.has(contentType);
}

/** The file extensions a video can come in, for a file picker. */
export const VIDEO_FILE_ACCEPT = ['video/*', '.mp4', '.m4v', '.mov', '.qt', '.webm', '.mkv', '.ogv', '.ogg', '.avi', '.wmv', '.asf', '.flv', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.3g2'].join(',');

/**
 * Formats a clip can be recorded in, in the browser. Each lists the types to
 * ask the browser's recorder for, best first; one the browser cannot record
 * is offered greyed out.
 */
export interface ClipFormat {
  id: ClipFormatId;
  label: string;
  extension: string;
  /** The type the file is labelled with. */
  contentType: string;
  /** What to ask the recorder for, best first. */
  recorderTypes: readonly string[];
}

export type ClipFormatId = 'webm-vp9' | 'webm-vp8' | 'webm-av1' | 'mp4-h264' | 'mkv-h264';

export const CLIP_FORMATS: readonly ClipFormat[] = [
  { id: 'webm-vp9', label: 'WebM (VP9)', extension: 'webm', contentType: 'video/webm', recorderTypes: ['video/webm;codecs=vp9'] },
  { id: 'webm-vp8', label: 'WebM (VP8)', extension: 'webm', contentType: 'video/webm', recorderTypes: ['video/webm;codecs=vp8', 'video/webm'] },
  { id: 'webm-av1', label: 'WebM (AV1)', extension: 'webm', contentType: 'video/webm', recorderTypes: ['video/webm;codecs=av01', 'video/webm;codecs=av1'] },
  { id: 'mp4-h264', label: 'MP4 (H.264)', extension: 'mp4', contentType: 'video/mp4', recorderTypes: ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'] },
  { id: 'mkv-h264', label: 'Matroska (H.264)', extension: 'mkv', contentType: 'video/x-matroska', recorderTypes: ['video/x-matroska;codecs=avc1', 'video/x-matroska'] },
];

/** The extension a clip in this format is written with. */
export function clipExtension(id: string | undefined): string {
  return clipFormat(id).extension;
}

export function clipFormat(id: string | undefined): ClipFormat {
  return CLIP_FORMATS.find((format) => format.id === id) ?? CLIP_FORMATS[0]!;
}

export function videoTypeLabel(contentType: string): string {
  return LABEL[contentType] ?? contentType;
}

/**
 * What a video file is, from its first bytes. WebM and Matroska share a
 * header and are told apart by the document type written in it.
 */
export function sniffVideoType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...expected: number[]) => expected.every((byte, index) => bytes[offset + index] === byte);
  // ....ftyp: the ISO family, told apart by the brand after it.
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand === 'avif' || brand === 'avis' || brand === 'heic' || brand === 'mif1') return undefined;
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  // EBML: WebM or Matroska.
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) {
    const head = String.fromCharCode(...bytes.slice(0, Math.min(bytes.length, 64)));
    return head.includes('webm') ? 'video/webm' : 'video/x-matroska';
  }
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return 'video/ogg';
  // RIFF....AVI
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x41, 0x56, 0x49, 0x20)) return 'video/x-msvideo';
  // ASF, which WMV is.
  if (at(0, 0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11)) return 'video/x-ms-asf';
  if (at(0, 0x46, 0x4c, 0x56, 0x01)) return 'video/x-flv';
  // MPEG program stream; a transport stream syncs on 0x47 every 188 bytes.
  if (at(0, 0x00, 0x00, 0x01, 0xba)) return 'video/mpeg';
  if (bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return 'video/mp2t';
  // An old QuickTime file can start with a moov or mdat atom.
  if (at(4, 0x6d, 0x6f, 0x6f, 0x76) || at(4, 0x6d, 0x64, 0x61, 0x74) || at(4, 0x77, 0x69, 0x64, 0x65)) return 'video/quicktime';
  return undefined;
}

/** A file name for a video, from its address, keeping the extension its bytes earned. */
export function videoNameFrom(url: URL | string, contentType: string): string {
  const extension = VIDEO_TYPES[contentType] ?? 'bin';
  const pathname = typeof url === 'string' ? url : url.pathname;
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  const stem = last
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return `${stem || 'video'}.${extension}`;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

/** The video in one line. */
export function summariseVideoSource(source: VideoSourceInfo | null): string {
  if (!source) return 'No video yet.';
  const parts = [videoTypeLabel(source.contentType), formatMegabytes(source.bytes)];
  if (source.duration !== undefined) parts.push(clock(source.duration));
  if (source.width && source.height) parts.push(`${source.width} × ${source.height}`);
  parts.push(source.origin === 'link' ? `from ${hostOf(source.url)}` : 'uploaded');
  return parts.join(' · ');
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : 'a link';
  } catch {
    return 'a link';
  }
}

export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `source.md`: where the video came from, what it is, and who to credit. */
export function videoSourceReport(name: string, data: VideoSourceFlowData): string {
  const source = data.source;
  if (!source) return `# ${name}\n\nNo video yet.\n`;
  const lines = [
    `# ${name}`,
    '',
    `- File: \`${source.fileName}\``,
    `- Format: ${videoTypeLabel(source.contentType)}`,
    `- Size on disk: ${formatMegabytes(source.bytes)}`,
    source.duration !== undefined ? `- Length: ${clock(source.duration)}` : '- Length: not measured yet (open the editor to play it)',
    source.width && source.height ? `- Dimensions: ${source.width} × ${source.height}` : '',
    `- Added: ${source.addedAt.slice(0, 10)}`,
    source.origin === 'link' ? `- Fetched from: ${source.url}` : '- Uploaded from this machine.',
    '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
  if (data.description.trim()) lines.push('## What it is', '', data.description.trim(), '');
  if (data.credit.trim()) lines.push('## Credit and terms', '', data.credit.trim(), '');
  else if (source.origin === 'link') {
    lines.push('## Credit and terms', '', '> Not recorded. A video fetched from a link belongs to someone — worth', '> noting who, and on what terms.', '');
  }
  lines.push('The video is stored in this project rather than fetched again on each run.', '');
  return lines.join('\n');
}
