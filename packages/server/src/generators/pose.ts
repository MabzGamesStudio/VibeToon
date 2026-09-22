import {
  poseEffort,
  poseState,
  posedBones,
  posedImage,
  summarisePose,
  toSvg,
  type PoseFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A bound rig, moved.
 *
 * The pose is stored as one angle a joint, and both outputs are worked out from
 * that here: the drawing in the pose, and the numbers behind it. Angles rather
 * than positions, because angles survive the rig being edited underneath them
 * and cannot describe a skeleton that has come apart.
 */
export async function generatePose(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as PoseFlowData;

  const input = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'bound' && candidate.artifact !== undefined,
  );
  if (!input?.artifact) {
    ctx.warn('No bound rig wired in — connect a Rig Binding flow to the Bound rig input.');
    return { outputs: [] };
  }

  const state = poseState(data, input.artifact.hash);
  if (state === 'none') {
    ctx.warn(`Nothing taken in to pose yet. Open this flow's editor and press “Take it in”.`);
    return { outputs: [] };
  }
  if (state === 'stale') {
    ctx.warn(
      `${input.sourceNode.name} has changed since this pose was made. The angles are kept, and still apply to whichever bones still exist.`,
    );
  }

  const bound = data.bound!;
  const placed = posedBones(bound.rig, data.pose);
  const drawing = posedImage(bound, data.pose);

  if (poseEffort(data.pose) < 0.01) {
    ctx.log('Nothing is turned, so this is the rest pose.');
  }

  const missing = Object.keys(data.pose).filter((id) => !placed.has(id));
  if (missing.length > 0) {
    ctx.warn(`${missing.length} angle(s) refer to bones that are no longer in the rig, and were ignored.`);
  }

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'pose',
      kind: 'json',
      fileName: 'pose.json',
      content: `${JSON.stringify(
        {
          angles: data.pose,
          bones: [...placed.entries()].map(([id, place]) => ({
            id,
            name: bound.rig.bones.find((bone) => bone.id === id)?.name ?? id,
            own: Math.round(place.own * 100) / 100,
            angle: Math.round(place.angle * 100) / 100,
            from: { x: Math.round(place.from.x * 100) / 100, y: Math.round(place.from.y * 100) / 100 },
            to: { x: Math.round(place.to.x * 100) / 100, y: Math.round(place.to.y * 100) / 100 },
          })),
        },
        null,
        2,
      )}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'drawing',
      kind: 'image',
      fileName: 'pose.svg',
      content: toSvg(drawing),
    }),
  ];

  ctx.log(summarisePose(data));
  return { outputs };
}
