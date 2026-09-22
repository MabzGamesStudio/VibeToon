import {
  boundRigOf,
  restPose,
  summariseBinding,
  toSvg,
  type BindFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A drawing bound to a skeleton.
 *
 * What is written is what the flow holds, not something derived from its inputs
 * — the binding *is* the work, the same way the vector editor's edits are. An
 * upstream change is reported and the binding kept, because redoing it is an
 * afternoon and nobody would thank a flow that threw it away on a re-run.
 */
export async function generateBind(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as BindFlowData;

  const rigInput = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'rig' && candidate.artifact !== undefined,
  );
  const vectorInput = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'vector' && candidate.artifact !== undefined,
  );

  if (!rigInput?.artifact) {
    ctx.warn('No rig wired in — connect a Skeletal Rig flow to the Rig input.');
    return { outputs: [] };
  }
  if (!vectorInput?.artifact) {
    ctx.warn('No drawing wired in — connect a vectorized image to the Vector input.');
    return { outputs: [] };
  }

  const bound = boundRigOf(data);
  if (!bound) {
    ctx.warn(`Nothing taken in to bind yet. Open this flow's editor and press “Take them in”.`);
    return { outputs: [] };
  }

  const summary = summariseBinding(data);
  for (const problem of summary.problems) ctx.warn(problem);

  const stale =
    (data.rigHash && data.rigHash !== rigInput.artifact.hash) ||
    (data.vectorHash && data.vectorHash !== vectorInput.artifact.hash);
  if (stale) {
    ctx.warn(
      'The rig or the drawing has changed since this was bound. The binding is kept — take them in again to start from the new one.',
    );
  }

  // The skeleton drawn over the drawing, so the binding can be looked at rather
  // than read.
  const pose = restPose(bound.rig);
  const bones = [...pose.entries()]
    .map(
      ([id, place]) =>
        `  <line x1="${round(place.from.x)}" y1="${round(place.from.y)}" x2="${round(
          place.to.x,
        )}" y2="${round(place.to.y)}" stroke="#ff3b6b" stroke-width="0.8" stroke-linecap="round" data-bone="${id}"/>`,
    )
    .join('\n');
  const drawing = toSvg(bound.image).replace('</svg>', `${bones}\n</svg>`);

  const lines = [
    `# ${ctx.node.name} — binding`,
    '',
    `- Rig: **${rigInput.sourceNode.name}** · ${summary.bones} bone(s)`,
    `- Drawing: **${vectorInput.sourceNode.name}** · ${summary.shapes} shape(s)`,
    `- Bound: **${summary.bound}** · unbound: ${summary.unbound}`,
    ...(summary.empty > 0 ? [`- Bones carrying nothing: ${summary.empty}`] : []),
    '',
    '## What moves with what',
    '',
    '| Bone | Shapes |',
    '| --- | --- |',
    ...bound.rig.bones.map((bone) => {
      const held = Object.entries(bound.binding).filter(([, id]) => id === bone.id).length;
      return `| ${bone.name} | ${held} |`;
    }),
    '',
    '## How binding works',
    '',
    'Every shape belongs to at most one bone. A shape belonging to two would have',
    'to be torn between them when they move apart, and tearing is something only a',
    'mesh can do — these are outlines, and an outline has to go somewhere whole.',
    'Where a drawing really does need to bend across a joint, cut the shape in the',
    'vector editor and bind the halves separately.',
    '',
    'A shape bound to nothing stays where it was drawn when the rig moves. That is',
    'visible, and therefore fixable; dropping it silently would not be.',
    '',
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'bound',
      kind: 'json',
      fileName: 'bound.json',
      content: `${JSON.stringify(bound, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'preview',
      kind: 'image',
      fileName: 'bound.svg',
      content: drawing,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'report',
      kind: 'markdown',
      fileName: 'bound.md',
      content: `${lines.join('\n')}\n`,
    }),
  ];

  ctx.log(
    `${summary.bound} of ${summary.shapes} shape(s) bound across ${summary.bones} bone(s), after ${data.edits} edit(s).`,
  );
  return { outputs };
}

const round = (value: number) => Math.round(value * 100) / 100;
