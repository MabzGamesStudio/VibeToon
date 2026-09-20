import {
  describeSize,
  formatBytes,
  imageTypeLabel,
  imageWarnings,
  type ImageFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The image source flow.
 *
 * The bytes are already on the port before a run happens: uploading writes them,
 * and so does fetching a link. That is deliberate — a link that works today is
 * not a link that works when the project is opened next year, so the picture is
 * stored rather than re-fetched, and generating cannot fail for want of a network.
 *
 * What a run writes is the provenance: what the file is, where it came from, and
 * who to credit. Which is the part that is otherwise lost.
 */
export async function generateImage(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as ImageFlowData;
  const held = ctx.node.outputs.find((artifact) => artifact.port === 'image');

  if (!data.source || !held) {
    ctx.warn(
      data.source
        ? 'The image is recorded but its file is missing. Add it again in this flow’s editor.'
        : 'No image yet. Open this flow’s editor and either upload a file or fetch a link.',
    );
    return { outputs: [] };
  }

  const source = data.source;
  for (const warning of imageWarnings(source)) ctx.warn(warning);

  ctx.log(
    `${imageTypeLabel(source.contentType)} · ${formatBytes(source.bytes)} · ${describeSize(source)} · ${
      source.origin === 'link' ? `fetched from ${source.url}` : 'uploaded'
    }`,
  );

  const lines = [
    `# ${ctx.node.name}`,
    '',
    `- File: \`${source.fileName}\``,
    `- Format: ${imageTypeLabel(source.contentType)}`,
    `- Size on disk: ${formatBytes(source.bytes)}`,
    `- Dimensions: ${describeSize(source)}`,
    `- Added: ${source.addedAt.slice(0, 10)}`,
    source.origin === 'link' ? `- Fetched from: ${source.url}` : '- Uploaded from this machine.',
    '',
  ];

  if (data.description.trim()) {
    lines.push('## What it is', '', data.description.trim(), '');
  }
  if (data.credit.trim()) {
    lines.push('## Credit and terms', '', data.credit.trim(), '');
  } else if (source.origin === 'link') {
    // Worth a nudge rather than a warning: a fetched image belongs to someone,
    // and the flow is the only place that fact can be recorded.
    lines.push(
      '## Credit and terms',
      '',
      '> Not recorded. A picture fetched from a link belongs to someone — worth',
      '> noting who, and on what terms, while it is still easy to find out.',
      '',
    );
  }

  lines.push(
    '## Note',
    '',
    'The picture is stored in this project rather than fetched again on each run,',
    'so the flow keeps working when the address it came from stops.',
    '',
  );

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'source',
      kind: 'markdown',
      fileName: 'source.md',
      content: `${lines.join('\n')}\n`,
    }),
  ];
  return { outputs };
}
