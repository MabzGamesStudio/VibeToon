import {
  FILTER_MODE_HINT,
  FILTER_MODE_LABEL,
  activePalette,
  readPalette,
  type PaletteFilterFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import { readsWhole, type GenerationContext, type GenerationResult } from './types';

/**
 * A palette is a few dozen colours. Reading more than this means the file is not
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
 * here as well as there, so the notes can say which colours were actually in play
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
    ctx.warn('No palette wired in — connect a Colour Palette flow to the Palette input.');
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
      `${paletteInput.sourceNode.name} has no colours in it. Generate it first, or check it wrote a palette.`,
    );
    return { outputs: [] };
  }

  const active = activePalette(palette, data.options);
  if (active.hexes.length === 0) {
    ctx.warn('Every palette colour is switched off, so there is nothing to filter against.');
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

  const mode = data.options.mode;
  const lines = [
    `# ${ctx.node.name} — filtered against a palette`,
    '',
    `- Image: **${image.sourceNode.name}** (\`${image.artifact.fileName}\`)`,
    `- Palette: **${paletteInput.sourceNode.name}** (\`${paletteInput.artifact.fileName}\`)`,
    `- Mode: **${FILTER_MODE_LABEL[mode]}**`,
    ...(mode === 'snap'
      ? []
      : [
          `- Tolerance: ${data.options.tolerance}${
            data.options.softness > 0 ? ` · softened over ±${data.options.softness}` : ' · a hard threshold'
          }`,
        ]),
    ...(data.options.hardAlpha ? ['- Alpha: forced to fully on or fully off.'] : []),
    `- Colours in play: ${active.hexes.length} of ${palette.hexes.length}`,
    '',
    '## What the mode does',
    '',
    FILTER_MODE_HINT[mode],
    '',
    '## The palette it was filtered against',
    '',
    '| | Colour | In play |',
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
  ];

  if (mode === 'snap') {
    lines.push(
      'Snapping has no threshold: every pixel has a nearest palette colour, and gets',
      'it. A pixel that was already transparent stays transparent, so a cutout wired',
      'in keeps its shape.',
      '',
    );
  } else {
    lines.push(
      'A pixel that was already transparent is left alone, so cutting a subject out',
      'first and filtering it second does not undo the cutting.',
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
    `${FILTER_MODE_LABEL[mode]} against ${active.hexes.length} colour(s): ${active.hexes.join(' ')}.`,
  );
  return { outputs };
}
