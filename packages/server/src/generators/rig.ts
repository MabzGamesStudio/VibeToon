import {
  RIG_KIND_LABEL,
  boneLength,
  chainById,
  effectiveAngles,
  effectiveStretch,
  restPose,
  rigProblems,
  summariseRig,
  type RigFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import { readsWhole, type GenerationContext, type GenerationResult } from './types';

const SPEC_READ_LIMIT = 200_000;

/**
 * The skeleton, written out for whatever has to pose it.
 *
 * Limits are resolved before they are written: a chain bone's angles live on its
 * chain, and nothing downstream should have to know that to find out how far a
 * tentacle's third joint bends. Both are in the file — the resolved numbers to
 * use, and the chain that produced them, so an animator can see where a number
 * came from and change it in the right place.
 */
export async function generateRig(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as RigFlowData;
  const posed = restPose(data);
  const problems = rigProblems(data);
  const summary = summariseRig(data);

  for (const problem of problems.slice(0, 8)) {
    const where = problem.boneId ?? problem.chainId;
    ctx.warn(where ? `${where}: ${problem.message}` : problem.message);
  }
  if (problems.length > 8) ctx.warn(`…and ${problems.length - 8} more problem(s) with this rig.`);

  // A spec wired in is context for whoever opens the file, not something the rig
  // is derived from — the skeleton comes from the character type.
  let spec = '';
  for (const input of ctx.inputs) {
    if (input.connection.to.portId !== 'spec') continue;
    const body = await ctx.readUpstream(input, SPEC_READ_LIMIT);
    if (!readsWhole(body)) {
      ctx.warn(`The spec from ${input.sourceNode.name} was too long to read, so it is not quoted below.`);
      continue;
    }
    if (body?.trim()) spec = body.trim();
  }

  const design = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'design' && candidate.artifact !== undefined,
  );
  if (!design) {
    ctx.log('No design wired in, so the skeleton is drawn against nothing. That is fine — it is still a rig.');
  }

  const bones = data.bones.map((bone) => {
    const chain = chainById(data, bone.chain);
    const angles = effectiveAngles(bone, chain, data.options);
    const stretch = effectiveStretch(bone, data.options);
    const place = posed.get(bone.id);
    return {
      id: bone.id,
      name: bone.name,
      ...(bone.parent ? { parent: bone.parent } : {}),
      ...(bone.side ? { side: bone.side } : {}),
      length: Math.round(boneLength(bone) * 100) / 100,
      offset: bone.offset,
      ...(place ? { rest: place } : {}),
      angles,
      stretch,
      ...(chain
        ? {
            chain: chain.id,
            // Where the number came from, so it is changed in the right place.
            anglesFrom: bone.angles ? 'this bone' : `the ${chain.name} chain`,
          }
        : {}),
    };
  });

  const report = [
    `# ${ctx.node.name} — skeletal rig`,
    '',
    `- Character type: **${RIG_KIND_LABEL[data.kind]}**`,
    `- Bones: **${summary.bones}** in ${summary.chains} chain(s), ${summary.chained} of them chained`,
    `- Rest pose: ${summary.height} units tall, ${summary.span} units of bone in total`,
    `- Joints that cannot move: ${summary.welded}`,
    `- Bones that can change length: ${summary.stretchy}`,
    `- Squash and stretch: ×${data.options.squashAndStretch} · Looseness: ×${data.options.looseness} · Mirroring: ${
      data.options.mirror ? 'on' : 'off'
    }`,
    `- Problems: ${problems.length}`,
    '',
    ...(problems.length > 0
      ? [
          '## Problems',
          '',
          ...problems.map((problem) => `- \`${problem.boneId ?? problem.chainId ?? 'rig'}\` — ${problem.message}`),
          '',
        ]
      : []),
    '## Bones',
    '',
    '| Bone | Parent | Length | Turns | Stiffness | Length range | Angles from |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...bones.map(
      (bone) =>
        `| \`${bone.id}\` | ${bone.parent ? `\`${bone.parent}\`` : '—' } | ${bone.length} | ${bone.angles.min}° to ${
          bone.angles.max
        }° | ${bone.angles.stiffness} | ×${bone.stretch.min} to ×${bone.stretch.max} | ${
          'anglesFrom' in bone ? bone.anglesFrom : 'this bone'
        } |`,
    ),
    '',
    ...(data.chains.length > 0
      ? [
          '## Chains',
          '',
          'A run of small bones is one behaviour rather than a set of joints, so it has',
          'one floppiness. `Taper` is how much looser the tip is than the base, which is',
          'what makes a tentacle read as a tentacle and not a hinge.',
          '',
          '| Chain | Bones | Floppiness | Taper | Span at full floppiness |',
          '| --- | --- | --- | --- | --- |',
          ...data.chains.map(
            (chain) =>
              `| ${chain.name} | ${chain.bones.length} | ${chain.floppiness} | ${chain.taper} | ±${chain.span}° |`,
          ),
          '',
        ]
      : []),
    '## What the numbers mean',
    '',
    '**Turns** is a hard stop measured from the rest pose: a knee at `-140° to 0°`',
    'bends one way and cannot go the other, which is what stops a rig looking broken.',
    '**Stiffness** is not a stop but a cost — how strongly the joint pulls back to',
    'rest — and it is most of the difference between a character who moves like a',
    'person and one who moves like a puppet. **Length range** multiplies the bone’s',
    'rest length, so `×0.85 to ×1.25` is a limb that can squash and stretch.',
    '',
    ...(spec
      ? [
          '## The spec this was rigged against',
          '',
          ...spec.split('\n').slice(0, 60).map((line) => `> ${line}`),
          '',
        ]
      : []),
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'rig',
      kind: 'json',
      fileName: 'rig.json',
      content: `${JSON.stringify(
        {
          kind: data.kind,
          units: 'rig units, y down, roughly 100 to a standing figure',
          options: data.options,
          chains: data.chains,
          bones,
        },
        null,
        2,
      )}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'doc',
      kind: 'markdown',
      fileName: 'rig.md',
      content: `${report.join('\n')}\n`,
    }),
  ];

  ctx.log(
    `${summary.bones} bone(s), ${summary.chains} chain(s), ${summary.welded} welded, ${problems.length} problem(s).`,
  );
  return { outputs };
}
