import {
  ARTIFACT_EXTENSION,
  formatBriefCsv,
  formatBriefMarkdown,
  formatBriefText,
  briefPayload,
  guidanceText,
  isTextualArtifact,
  parseRules,
  type ArtifactRef,
  type BriefFlowData,
  type BriefRenderInput,
  type UpstreamContext,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

const EXCERPT_LIMIT = 1200;

async function collectUpstream(ctx: GenerationContext): Promise<UpstreamContext[]> {
  const out: UpstreamContext[] = [];
  for (const input of ctx.inputs) {
    const excerpt = await ctx.readUpstream(input, EXCERPT_LIMIT);
    out.push({
      label: `${input.sourceNode.name} → ${input.targetPort?.label ?? input.connection.to.portId}`,
      rules: input.connection.rules,
      mode: input.connection.settings.mode,
      weight: input.connection.settings.weight,
      ...(excerpt ? { excerpt } : {}),
    });
    if (!excerpt) {
      ctx.log(`${input.sourceNode.name} has no generated artifact on ${input.connection.from.portId} yet.`);
    }
  }
  return out;
}

/**
 * The generic flow generator. Flow kinds without a bespoke editor still produce
 * real artifacts: their fields become a markdown brief (plus text/json/csv
 * flavours where a port asks for them), with the rules and content arriving over
 * each connection recorded underneath so nothing about how it was shaped is lost.
 *
 * Ports that carry pictures or sound cannot be written from text, so those are
 * left for you to upload — the generator writes a plan file saying what is
 * expected instead of inventing a file.
 */
export async function generateBrief(
  ctx: GenerationContext,
  options: { skipPorts?: ReadonlySet<string> } = {},
): Promise<GenerationResult> {
  const data = ctx.node.data as BriefFlowData;
  const upstream = await collectUpstream(ctx);

  const render: BriefRenderInput = {
    title: ctx.node.name,
    def: ctx.def,
    data,
    notes: ctx.node.notes,
    projectStyleNote: ctx.project.settings.styleNote,
    upstream,
  };

  const filled = (ctx.def.fields ?? []).filter((field) => (data.fields[field.id] ?? '').trim()).length;
  const total = (ctx.def.fields ?? []).length;
  if (filled === 0 && total > 0) ctx.warn('No fields filled in yet — the brief will be a stub.');

  const outputs: ArtifactRef[] = [];
  const pending: string[] = [];

  for (const port of ctx.def.outputs) {
    if (options.skipPorts?.has(port.id)) continue;
    const fileName = port.fileName ?? `${port.id}.${ARTIFACT_EXTENSION[port.kinds[0]!] || 'txt'}`;
    const kind = port.kinds[0]!;

    if (!isTextualArtifact(kind)) {
      pending.push(`- **${port.label}** (\`${fileName}\`, ${kind}) — ${port.description}`);
      continue;
    }

    let content: string;
    switch (kind) {
      case 'markdown':
        content = formatBriefMarkdown(render);
        break;
      case 'csv':
        content = formatBriefCsv(ctx.def, data);
        break;
      case 'json':
      case 'timeline':
        content = `${JSON.stringify(
          {
            flow: ctx.def.kind,
            name: ctx.node.name,
            fields: briefPayload(ctx.def, data),
            notes: ctx.node.notes,
            guidance: upstream.map((source) => ({
              from: source.label,
              mode: source.mode,
              weight: source.weight,
              rules: guidanceText(parseRules(source.rules)),
            })),
          },
          null,
          2,
        )}\n`;
        break;
      default:
        content = formatBriefText(render);
        break;
    }

    outputs.push(
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: port.id,
        kind,
        fileName,
        content,
      }),
    );
  }

  if (pending.length > 0) {
    const lines = [
      `# ${ctx.node.name} — files to make by hand`,
      '',
      'These outputs are pictures or sound, so this flow cannot write them from text.',
      'Make them in whatever tool you like and upload them onto the port, or wire in a',
      'flow that produces them. Everything downstream then sees a real file with a hash.',
      '',
      ...pending,
      '',
      '## What the brief says',
      '',
      formatBriefMarkdown(render),
    ];
    // A sidecar, not an artifact: it documents the gap rather than filling it.
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: '_pending',
      kind: 'markdown',
      fileName: 'pending-outputs.md',
      content: `${lines.join('\n')}\n`,
    });
    ctx.log(
      `${pending.length} output(s) need a file you make yourself — see pending-outputs.md. Uploaded files are kept.`,
    );
  }

  ctx.log(`${filled}/${total} field(s) filled, ${outputs.length} artifact(s) written.`);
  return { outputs };
}
