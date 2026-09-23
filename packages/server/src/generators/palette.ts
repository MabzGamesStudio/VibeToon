import {
  applyEdits,
  derivePalette,
  histogramState,
  summarisePalette,
  type PaletteFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * Colors out of an image.
 *
 * The counting happens in the editor, because that is where an image can be
 * decoded: the browser reads a PNG, a JPEG, a WebP or a GIF without this project
 * carrying a decoder for any of them. What lands here is the tally, which is kept
 * in the flow — so a run is instant, repeatable, and needs neither the image nor a
 * network.
 *
 * The consequence is that generating before the editor has been opened produces a
 * warning rather than a palette, which is the same shape as the Dictionary flow
 * and is said plainly rather than worked around.
 */
export async function generatePalette(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as PaletteFlowData;

  const input = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined,
  );
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }

  const state = histogramState(data, input.artifact.hash);
  if (state === 'none') {
    ctx.warn(
      `${input.sourceNode.name} has an image, but it has not been counted yet. Open this flow's editor and press “Read the image”.`,
    );
    return { outputs: [] };
  }
  if (state === 'stale') {
    ctx.warn(
      `The image on ${input.sourceNode.name} has changed since it was counted, so the palette would describe the old one. Open this flow's editor and read it again.`,
    );
    return { outputs: [] };
  }

  const histogram = data.histogram!;
  if (histogram.precision !== data.options.precision) {
    ctx.warn(
      `The image was counted at ${histogram.precision} bits a channel but the setting is now ${data.options.precision}. Read it again for the setting to take effect.`,
    );
  }

  const palette = applyEdits(derivePalette(histogram, data.options), data.edits);
  const summary = summarisePalette(palette, data);

  if (palette.shortfall) ctx.warn(palette.shortfall);
  if (palette.dropped > 0) {
    ctx.log(`${palette.dropped} color group(s) held too little of the image to keep.`);
  }

  ctx.log(
    `Read ${histogram.pixels.toLocaleString()} pixel(s) of ${histogram.width}×${histogram.height} as ${histogram.colors.length.toLocaleString()} distinct color(s).`,
  );

  const report = [
    `# ${ctx.node.name} — color palette`,
    '',
    `- Image: **${histogram.source}** (${histogram.width}×${histogram.height})`,
    `- Pixels counted: ${histogram.pixels.toLocaleString()}${
      histogram.transparent > 0 ? ` (${histogram.transparent.toLocaleString()} skipped as transparent)` : ''
    }`,
    `- Distinct colors at ${histogram.precision} bits a channel: ${histogram.colors.length.toLocaleString()}`,
    `- Colors asked for: ${data.options.count} · found: **${summary.colors}**`,
    `- Minimum distance asked for: ${data.options.minDistance} · closest pair: **${summary.closest.toFixed(1)}**`,
    `- Temperature: ${data.options.temperature} · seed: \`${data.options.seed}\``,
    `- Share of the image the palette accounts for: ${(summary.covered * 100).toFixed(1)}%`,
    ...(summary.changed + summary.removed + summary.added > 0
      ? [
          `- Edited by hand: ${[
            ...(summary.changed > 0 ? [`${summary.changed} changed`] : []),
            ...(summary.removed > 0 ? [`${summary.removed} removed`] : []),
            ...(summary.added > 0 ? [`${summary.added} added`] : []),
          ].join(', ')}`,
        ]
      : []),
    ...(summary.waiting > 0
      ? [
          `- Edits waiting on a bucket these settings do not produce: ${summary.waiting}. They are kept and come back if the settings do.`,
        ]
      : []),
    '',
    '## The palette',
    '',
    '| | Color | Opacity | Share | Pixels | Colors in its group | Mode of the group | Moved | Nearest other |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...palette.entries.map(
      (entry, index) =>
        `| ${index + 1} | \`${entry.hex}\`${entry.byHand ? ' *(by hand)*' : ''} | ${
          entry.a >= 255 ? 'solid' : `${Math.round((entry.a / 255) * 100)}%`
        } | ${(entry.share * 100).toFixed(1)}% | ${entry.count.toLocaleString()} | ${
          entry.members
        } | \`${entry.modeHex}\` | ${entry.shifted.toFixed(1)} | ${entry.nearest.toFixed(1)} |`,
    ),
    '',
    '## How it was worked out',
    '',
    'Every pixel was counted, the counts sorted, and the commonest colors taken in',
    'order. A color closer than the minimum distance to one already chosen joined',
    "that color's group rather than becoming an entry of its own, so a gradient",
    'counts once instead of filling the palette with near neighbours. Distance is',
    'measured in OKLab, where equal numbers look equally different, times 100 — two',
    'colors you would call the same are under about 2, navy and royal blue about 20.',
    '',
    ...(data.options.temperature > 0
      ? [
          `At temperature ${data.options.temperature} each entry moved that far from its`,
          "group's commonest color towards another member of the same group, so every",
          'color above is still a color the image contains.',
          '',
        ]
      : ['At temperature 0 every entry is its group’s commonest color exactly.', '']),
    '## Settings',
    '',
    '```json',
    JSON.stringify(data.options, null, 2),
    '```',
    '',
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'palette',
      kind: 'json',
      fileName: 'palette.json',
      content: `${JSON.stringify(
        {
          source: histogram.source,
          width: histogram.width,
          height: histogram.height,
          pixels: histogram.pixels,
          options: data.options,
          colors: palette.entries.map((entry) => ({
            // Eight digits when the color is see-through, six when it is not, so
            // a reader that knows nothing about opacity sees what it always saw.
            hex: entry.hex,
            rgb: [entry.r, entry.g, entry.b],
            alpha: entry.a,
            share: Math.round(entry.share * 10000) / 10000,
            count: entry.count,
            members: entry.members,
            mode: entry.modeHex,
          })),
        },
        null,
        2,
      )}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'report',
      kind: 'markdown',
      fileName: 'report.md',
      content: `${report.join('\n')}\n`,
    }),
  ];

  ctx.log(
    `${summary.colors} color(s): ${palette.entries.map((entry) => entry.hex).join(' ')} — closest pair ${summary.closest.toFixed(1)} apart.`,
  );
  return { outputs };
}
