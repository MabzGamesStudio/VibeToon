/**
 * The image source flow: a picture from this machine or from a link, made into
 * an artifact the graph can track.
 *
 * Everything downstream of it — the palette, the cutout, the filter — needs an
 * image to start from, and before this flow the only way to get one was to find
 * a flow with a spare image output port and upload onto that. This is the door.
 */

/** Where the bytes came from. */
export type ImageOrigin = 'upload' | 'link';

export interface ImageSource {
  origin: ImageOrigin;
  /** The file as it sits in the flow's folder. */
  fileName: string;
  /** Sniffed from the bytes, not taken from a header. */
  contentType: string;
  bytes: number;
  /** The address it was fetched from, when it came from one. */
  url?: string;
  addedAt: string;
  /**
   * Measured by the editor once the browser has decoded it. Absent until then,
   * because nothing on the server decodes an image.
   */
  width?: number;
  height?: number;
}

export interface ImageFlowData {
  editor: 'image';
  source: ImageSource | null;
  /** What the picture is, for whoever reads the project later. */
  description: string;
  /** Who made it and under what terms — a real question for a fetched image. */
  credit: string;
}

export function emptyImageFlowData(): ImageFlowData {
  return { editor: 'image', source: null, description: '', credit: '' };
}

/** Image types the browser decodes, and therefore the only ones accepted. */
export const IMAGE_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
];

const TYPE_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'image/avif': 'AVIF',
  'image/bmp': 'BMP',
  'image/svg+xml': 'SVG',
};

export function imageTypeLabel(contentType: string): string {
  return TYPE_LABEL[contentType] ?? contentType;
}

/** `1.4 MB`, `812 kB`, `640 B` — sized so a number is readable at a glance. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A pixel count is the number that decides whether everything downstream will be
 * quick or slow, so it is worth saying out loud rather than leaving as two
 * dimensions to multiply in your head.
 */
export function describeSize(source: ImageSource): string {
  if (source.width === undefined || source.height === undefined) return 'not measured yet';
  const pixels = source.width * source.height;
  const scale =
    pixels >= 1_000_000 ? `${(pixels / 1_000_000).toFixed(1)}M pixels` : `${Math.round(pixels / 1000)}k pixels`;
  return `${source.width} × ${source.height} · ${scale}`;
}

/**
 * An SVG has no pixels of its own until something decides how big to draw it, so
 * the flows that count pixels will get whatever size the browser picked. Worth a
 * word to whoever wires one in rather than a surprising palette.
 */
export function imageWarnings(source: ImageSource | null): string[] {
  if (!source) return [];
  const problems: string[] = [];
  if (source.contentType === 'image/svg+xml') {
    problems.push(
      'An SVG has no fixed pixel grid, so anything counting pixels downstream reads whatever size it was drawn at.',
    );
  }
  if (source.contentType === 'image/gif') {
    problems.push('Only the first frame of a GIF is read.');
  }
  if (source.width !== undefined && source.height !== undefined) {
    const pixels = source.width * source.height;
    if (pixels > 8_000_000) {
      problems.push(
        `${Math.round(pixels / 1_000_000)}M pixels is large; flows that read every pixel will sample it rather than read it all.`,
      );
    }
  }
  return problems;
}

export function summariseImage(data: ImageFlowData): string {
  if (!data.source) return 'No image yet.';
  const source = data.source;
  const from = source.origin === 'link' ? `from ${hostOf(source.url)}` : 'uploaded';
  return `${imageTypeLabel(source.contentType)}, ${formatBytes(source.bytes)}, ${describeSize(source)} — ${from}.`;
}

/** Just the host, for a caption that has to fit. */
export function hostOf(url: string | undefined): string {
  if (!url) return 'a link';
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}
