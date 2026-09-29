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

/** Formats a browser can generally play, and the extension each is stored with. */
export const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
};

const LABEL: Record<string, string> = {
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
  'video/quicktime': 'QuickTime',
  'video/ogg': 'Ogg',
  'video/x-matroska': 'Matroska',
};

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
