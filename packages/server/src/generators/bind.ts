import {
  allPoints,
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

  // The skeleton drawn over the drawing, and every bound node as a dot in its
  // bone's color, so the binding can be looked at rather than read.
  const pose = restPose(bound.rig);
  const hue = new Map(bound.rig.bones.map((bone, index) => [bone.id, (index * 47) % 360]));
  const bones = [...pose.entries()]
    .map(
      ([id, place]) =>
        `  <line x1="${round(place.from.x)}" y1="${round(place.from.y)}" x2="${round(
          place.to.x,
        )}" y2="${round(place.to.y)}" stroke="#ff3b6b" stroke-width="0.8" stroke-linecap="round" data-bone="${id}"/>`,
    )
    .join('\n');
  const seen = new Set<string>();
  const dots: string[] = [];
  for (const shape of bound.image.shapes) {
    const held = bound.points[shape.id];
    if (!held) continue;
    allPoints(shape).forEach((point, index) => {
      const bone = held[index];
      const key = `${point.x},${point.y}`;
      if (!bone || seen.has(key)) return;
      seen.add(key);
      dots.push(
        `  <circle cx="${round(point.x)}" cy="${round(point.y)}" r="1.2" fill="hsl(${hue.get(bone) ?? 0} 75% 55%)" data-bone="${bone}"/>`,
      );
    });
  }
  const drawing = toSvg(bound.image).replace('</svg>', `${bones}\n${dots.join('\n')}\n</svg>`);

  // How many nodes each bone carries, and how many shapes it moves any of.
  const carried = new Map<string, { nodes: Set<string>; shapes: Set<string> }>();
  for (const shape of bound.image.shapes) {
    const held = bound.points[shape.id];
    if (!held) continue;
    allPoints(shape).forEach((point, index) => {
      const bone = held[index];
      if (!bone) return;
      const entry = carried.get(bone) ?? { nodes: new Set(), shapes: new Set() };
      entry.nodes.add(`${point.x},${point.y}`);
      entry.shapes.add(shape.id);
      carried.set(bone, entry);
    });
  }

  const lines = [
    `# ${ctx.node.name} — binding`,
    '',
    `- Rig: **${rigInput.sourceNode.name}** · ${summary.bones} bone(s)`,
    `- Drawing: **${vectorInput.sourceNode.name}** · ${summary.shapes} shape(s), ${summary.nodes} node(s)`,
    `- Nodes bound: **${summary.bound}** · unbound: ${summary.unbound}`,
    ...(summary.bending > 0 ? [`- Shapes that bend across a joint: ${summary.bending}`] : []),
    ...(summary.empty > 0 ? [`- Bones carrying nothing: ${summary.empty}`] : []),
    '',
    '## What moves with what',
    '',
    '| Bone | Nodes | Shapes it moves any of |',
    '| --- | --- | --- |',
    ...bound.rig.bones.map((bone) => {
      const held = carried.get(bone.id);
      return `| ${bone.name} | ${held?.nodes.size ?? 0} | ${held?.shapes.size ?? 0} |`;
    }),
    '',
    '## How binding works',
    '',
    'A drawing is bound by its **nodes** — the points its shapes are drawn through —',
    'not by whole shapes. A shape whose points follow two bones bends where they meet,',
    'so an arm drawn as one polygon folds at the elbow rather than having to be cut',
    'there first.',
    '',
    'A node is a place, not a point of one shape: neighbouring shapes share the points',
    'along the boundary between them, and those are one node, bound once. So posing',
    'can bend a boundary but cannot tear two shapes apart along it.',
    '',
    'A node bound to nothing stays where it was drawn when the rig moves, and a shape',
    'with some of each stretches between them. That is visible, and therefore',
    'fixable; dropping it silently would not be.',
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
    `${summary.bound} of ${summary.nodes} node(s) bound across ${summary.bones} bone(s), after ${data.edits} edit(s).`,
  );
  return { outputs };
}

const round = (value: number) => Math.round(value * 100) / 100;
