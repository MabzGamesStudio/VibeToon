import type { Sketch, Stroke } from '@vibetoon/shared';

/** Strokes are stored against this box; every canvas scales from it. */
export const SKETCH_WIDTH = 640;
export const SKETCH_HEIGHT = 360;

export const PAPER = '#f4f1ea';

export function emptySketch(width = SKETCH_WIDTH, height = SKETCH_HEIGHT): Sketch {
  return { width, height, strokes: [], updatedAt: new Date().toISOString() };
}

/**
 * Rasterise a drawing on its own — no placeholder, no frame. Used by the design
 * flows, where an empty plate should produce no file rather than a card saying
 * it is empty.
 */
export function rasterizeSketch(sketch: Sketch, targetHeight: number): string | null {
  if (sketch.strokes.length === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.height = Math.max(64, Math.round(targetHeight));
  canvas.width = Math.max(64, Math.round((targetHeight * sketch.width) / sketch.height));
  drawSketch(canvas, sketch);
  return canvas.toDataURL('image/png');
}

export interface DrawOptions {
  /** Fill the canvas with paper first. Off when compositing over something. */
  background?: string;
  /** Extra scale applied on top of fitting the sketch box, e.g. for hi-dpi. */
  pixelRatio?: number;
}

/**
 * Draw a sketch into a canvas of any size. The stroke coordinate space is the
 * sketch box, so the same strokes render identically in a 280px thumbnail, the
 * playblast, and a 1920px export.
 */
export function drawSketch(
  canvas: HTMLCanvasElement,
  sketch: Sketch | null,
  options: DrawOptions = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const scaleX = canvas.width / (sketch?.width ?? SKETCH_WIDTH);
  const scaleY = canvas.height / (sketch?.height ?? SKETCH_HEIGHT);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (options.background !== 'none') {
    ctx.fillStyle = options.background ?? PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (!sketch) return;

  ctx.scale(scaleX, scaleY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of sketch.strokes) drawStroke(ctx, stroke);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  if (stroke.points.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = stroke.erase ? 'rgba(0,0,0,1)' : stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(stroke.points[0]!, stroke.points[1]!);
  if (stroke.points.length === 2) {
    // A tap: a dot, so single clicks leave a mark.
    ctx.lineTo(stroke.points[0]! + 0.01, stroke.points[1]!);
  }
  for (let i = 2; i < stroke.points.length; i += 2) {
    ctx.lineTo(stroke.points[i]!, stroke.points[i + 1]!);
  }
  ctx.stroke();
  ctx.restore();
}

export interface PlaceholderLabel {
  index: number;
  shot: string;
  text: string;
}

/**
 * Rasterise a panel to a PNG data URL. An undrawn panel becomes a labelled
 * placeholder so the animatic still holds the beat for its full duration.
 */
export function rasterizePanel(
  sketch: Sketch | null,
  size: { width: number; height: number },
  label: PlaceholderLabel,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  if (sketch && sketch.strokes.length > 0) {
    drawSketch(canvas, sketch);
  } else {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const unit = canvas.height / 360;
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 2 * unit;
    ctx.strokeRect(12 * unit, 12 * unit, canvas.width - 24 * unit, canvas.height - 24 * unit);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.textAlign = 'center';
    ctx.font = `${20 * unit}px system-ui, sans-serif`;
    ctx.fillText(`Panel ${label.index + 1} — ${label.shot}`, canvas.width / 2, canvas.height / 2 - 6 * unit);
    ctx.font = `${13 * unit}px system-ui, sans-serif`;
    const line = label.text.replace(/\s+/g, ' ').slice(0, 90);
    ctx.fillText(line, canvas.width / 2, canvas.height / 2 + 18 * unit);
    ctx.font = `${11 * unit}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillText('not drawn yet', canvas.width / 2, canvas.height - 26 * unit);
  }

  return canvas.toDataURL('image/png');
}

/** Canvas pixel coordinates -> sketch box coordinates. */
export function toSketchSpace(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
  sketch: Sketch,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * sketch.width,
    y: ((event.clientY - rect.top) / rect.height) * sketch.height,
  };
}
