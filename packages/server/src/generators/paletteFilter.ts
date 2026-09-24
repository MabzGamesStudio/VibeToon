import { inflateSync } from 'node:zlib';
import {
  FILTER_MODE_HINT,
  FILTER_MODE_LABEL,
  activePalette,
  decodePng,
  readPalette,
  type Bitmap,
  type PaletteFilterFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import { readsWhole, type GenerationContext, type GenerationResult } from './types';

/**
 * A palette is a few dozen colors. Reading more than this means the file is not
 * a palette, and a truncated read of JSON is a syntax error rather than a shorter
 * palette — so the limit is generous but finite, and a read that hits it is
 * reported instead of parsed.
 */
const PALETTE_LIMIT = 2_000_000;

/**
 * The palette filter flow.
 *
 * Like the cutout, the pixels are decided in the editor and arrive as an
 * attachment; this writes the file and explains what it did. The palette is read
 * here as well as there, so the notes can say which colors were actually in play
 * rather than trusting what the editor last saw.
 */
export async function generatePaletteFilter(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as PaletteFilterFlowData;

  const image = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined,
  );
  const paletteInput = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'palette' && candidate.artifact !== undefined,
  );

  if (!image?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }
  if (!paletteInput?.artifact) {
    ctx.warn('No palette wired in — connect a Color Palette flow to the Palette input.');
    return { outputs: [] };
  }

  const body = await ctx.readUpstream(paletteInput, PALETTE_LIMIT);
  if (!readsWhole(body)) {
    ctx.warn('The palette file was too long to read whole, so it cannot be trusted. Nothing was written.');
    return { outputs: [] };
  }

  let palette = readPalette(undefined);
  try {
    palette = readPalette(JSON.parse(body ?? 'null'));
  } catch {
    ctx.warn(`${paletteInput.sourceNode.name} did not produce readable JSON.`);
    return { outputs: [] };
  }
  if (palette.hexes.length === 0) {
    ctx.warn(
      `${paletteInput.sourceNode.name} has no colors in it. Generate it first, or check it wrote a palette.`,
    );
    return { outputs: [] };
  }

  const active = activePalette(palette, data.options);
  if (active.hexes.length === 0) {
    ctx.warn('Every palette color is switched off, so there is nothing to filter against.');
    return { outputs: [] };
  }

  const rendered = ctx.attachments.find((attachment) => attachment.name === 'filtered.png');
  if (!rendered) {
    const stale =
      (data.imageHash && data.imageHash !== image.artifact.hash) ||
      (data.paletteHash && data.paletteHash !== paletteInput.artifact.hash);
    ctx.warn(
      stale
        ? 'The image or the palette has changed since this was filtered. Open this flow’s editor to run it against the new one.'
        : 'Nothing has been filtered yet. Open this flow’s editor and press Generate from there.',
    );
    return { outputs: [] };
  }

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'image',
      kind: 'image',
      fileName: 'filtered.png',
      content: rendered.bytes,
    }),
  ];

  /*
   * Checked, not trusted. The pixels were decided in the editor; here the file is
   * decoded and counted, so the report can say what is actually in it — and a
   * snap that let a value through that is not a palette color, which is what a
   * canvas does to half-transparent pixels on the way out, is caught rather than
   * written up as exact.
   */
  const mode = data.options.mode;
  let written: Bitmap | null = null;
  try {
    written = await decodePng(new Uint8Array(rendered.bytes), (bytes) => new Uint8Array(inflateSync(bytes)));
  } catch (error) {
    ctx.warn(`The filtered picture could not be read back to check it: ${(error as Error).message}`);
  }
  const values = new Map<number, number>();
  if (written) {
    const { data: pixels } = written;
    for (let at = 0; at < pixels.length; at += 4) {
      const value = ((pixels[at]! << 16) | (pixels[at + 1]! << 8) | pixels[at + 2]!) * 256 + pixels[at + 3]!;
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }
  const allowed = new Set(active.colors.map(({ r, g, b, a }) => ((r << 16) | (g << 8) | b) * 256 + a));
  const strays = [...values.keys()].filter((value) => !allowed.has(value));
  if (written && mode === 'snap' && strays.length > 0) {
    ctx.warn(
      `The filtered picture holds ${strays.length} value(s) that are not palette colors, so it was not written exactly — open the editor and generate from there again.`,
    );
  }

  const lines = [
    `# ${ctx.node.name} — filtered against a palette`,
    '',
    `- Image: **${image.sourceNode.name}** (\`${image.artifact.fileName}\`)`,
    `- Palette: **${paletteInput.sourceNode.name}** (\`${paletteInput.artifact.fileName}\`)`,
    `- Mode: **${FILTER_MODE_LABEL[mode]}**`,
    ...(mode === 'snap'
      ? [
          (data.options.minChunk ?? 0) > 1
            ? `- Smallest chunk: ${data.options.minChunk}px — any smaller patch of one color took the closest color it touched`
            : '- Smallest chunk: any size — every pixel keeps the color it snapped to',
        ]
      : [
          `- Tolerance: ${data.options.tolerance}${
            data.options.tolerance <= 0 ? ' — an exact match and nothing else' : ''
          }`,
        ]),
    `- Colors in play: ${active.hexes.length} of ${palette.hexes.length}`,
    ...(written
      ? [
          `- The result holds **${values.size.toLocaleString()}** distinct RGBA value(s)${
            mode === 'snap'
              ? strays.length === 0
                ? ', every one of them a palette color'
                : `, **${strays.length} of them not palette colors**`
              : ''
          }`,
        ]
      : []),
    '',
    '## What the mode does',
    '',
    FILTER_MODE_HINT[mode],
    '',
    '## The palette it was filtered against',
    '',
    '| | Color | In play |',
    '| --- | --- | --- |',
    ...palette.hexes.map(
      (hex, index) => `| ${index + 1} | \`${hex}\` | ${active.hexes.includes(hex) ? 'yes' : 'switched off'} |`,
    ),
    '',
    '## How closeness is judged',
    '',
    'In OKLab, times 100, the same scale the palette’s own minimum distance uses:',
    'under about 2 is a difference you cannot see, 20 is navy against royal blue, 70',
    'and up is red against green. Plain RGB cannot do this job — navy against royal',
    'blue and two obviously different greens are the same distance apart in RGB, so',
    'one tolerance could not serve both.',
    '',
    'Opacity counts, measured apart from color: fully clear against solid is 50 on',
    'the same scale. So a half-faded red is not the solid red entry, a clear pixel is',
    'nowhere near black whatever color numbers it carries, and a soft edge is always',
    'nearest its own color — it becomes that color or clear, never a neighbour.',
    '',
  ];

  const clearInPlay = active.colors.some((color) => color.a === 0);
  if (mode === 'snap') {
    lines.push(
      'Snapping has no threshold: every pixel has a nearest palette color, and becomes',
      'exactly that — its four numbers, not a blend with what the pixel was. So the',
      'result holds no value that is not in the palette.',
      '',
      clearInPlay
        ? 'The palette has a transparent entry, so a pixel that was already transparent snaps to it and a cutout wired in keeps its shape.'
        : 'The palette has no transparent entry in play, so a pixel that was transparent had to become one of its colors. The Color Palette flow adds a transparent entry for a picture with transparent pixels.',
      '',
    );
  } else {
    lines.push(
      'Every pixel is written as one of two things: the source pixel exactly as it was,',
      'or fully transparent (0, 0, 0, 0). A pixel that was already transparent stays',
      'transparent, so cutting a subject out first and filtering it second does not',
      'undo the cutting.',
      '',
    );
  }

  outputs.push(
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'report',
      kind: 'markdown',
      fileName: 'filter.md',
      content: `${lines.join('\n')}\n`,
    }),
  );

  ctx.log(
    `${FILTER_MODE_LABEL[mode]} against ${active.hexes.length} color(s): ${active.hexes.join(' ')}.`,
  );
  return { outputs };
}
