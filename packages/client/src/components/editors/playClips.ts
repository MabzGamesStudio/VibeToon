import type { Sketch, TimedPanel } from '@vibetoon/shared';
import { PAPER, drawSketch } from './sketch';

/**
 * One thing held on screen for a while: a sketch straight from the board, or an
 * image the board rasterised. The player and the recorder both work in these, so
 * what you watch and what gets written to a file are the same cut.
 */
export interface PlayClip {
  id: string;
  /** Short label for the scrubber, e.g. `3 · MCU`. */
  label: string;
  /** Burned in under the picture while it plays. */
  caption: string;
  durationSec: number;
  render(canvas: HTMLCanvasElement): void;
}

export function totalDuration(clips: readonly PlayClip[]): number {
  return clips.reduce((sum, clip) => sum + clip.durationSec, 0);
}

/** The clip playing at `time`, and where it started. */
export function clipAt(clips: readonly PlayClip[], time: number): { clip: PlayClip; index: number } | null {
  let cursor = 0;
  for (const [index, clip] of clips.entries()) {
    if (time < cursor + clip.durationSec) return { clip, index };
    cursor += clip.durationSec;
  }
  const last = clips[clips.length - 1];
  return last ? { clip: last, index: clips.length - 1 } : null;
}

function placeholder(canvas: HTMLCanvasElement, title: string, subtitle: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const unit = canvas.height / 360;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.textAlign = 'center';
  ctx.font = `${22 * unit}px system-ui, sans-serif`;
  ctx.fillText(title, canvas.width / 2, canvas.height / 2 - 4 * unit);
  ctx.font = `${13 * unit}px system-ui, sans-serif`;
  ctx.fillText(subtitle.replace(/\s+/g, ' ').slice(0, 90), canvas.width / 2, canvas.height / 2 + 20 * unit);
}

/** Clips drawn from the board's own strokes — no files needed. */
export function clipsFromPanels(panels: readonly TimedPanel[]): PlayClip[] {
  return panels.map((entry) => ({
    id: entry.panel.id,
    label: `${entry.index + 1} · ${entry.panel.shot}`,
    caption: [entry.panel.dialog, entry.panel.sound ? `(${entry.panel.sound})` : '']
      .filter(Boolean)
      .join('\n'),
    durationSec: entry.panel.durationSec,
    render(canvas) {
      const sketch: Sketch | null = entry.panel.sketch;
      if (sketch && sketch.strokes.length > 0) drawSketch(canvas, sketch);
      else {
        placeholder(
          canvas,
          `Panel ${entry.index + 1} — ${entry.panel.shot}`,
          entry.panel.action || entry.panel.dialog || 'not drawn yet',
        );
      }
    },
  }));
}

/** Draw an image to fill the frame without distorting it. */
export function drawImageContained(canvas: HTMLCanvasElement, image: HTMLImageElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

export interface ImageClipSource {
  id: string;
  label: string;
  caption: string;
  durationSec: number;
  /** Already-decoded panel image, or null when the board has not rasterised one. */
  image: HTMLImageElement | null;
  placeholderTitle: string;
  placeholderSubtitle: string;
}

export function clipsFromImages(sources: readonly ImageClipSource[]): PlayClip[] {
  return sources.map((source) => ({
    id: source.id,
    label: source.label,
    caption: source.caption,
    durationSec: source.durationSec,
    render(canvas) {
      if (source.image) drawImageContained(canvas, source.image);
      else placeholder(canvas, source.placeholderTitle, source.placeholderSubtitle);
    },
  }));
}

/** Decode an image so it can be drawn synchronously while recording. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}
