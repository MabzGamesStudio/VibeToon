import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  confidenceLabel,
  decodePng,
  encodePng,
  fittedBones,
  fittedBoundRig,
  fittedImage,
  isPng,
  paintVector,
  poseOfFit,
  reportIsCurrent,
  rigMatchState,
  summariseRigMatch,
  toSvg,
  type RigMatchFlowData,
  type VectorImage,
  type VectorShape,
} from '@vibetoon/shared';
import { resolveInProject } from '../paths';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * A bound rig, found in a picture.
 *
 * The matching is done in the editor, where it can be watched and adjusted;
 * what is stored is the fit it arrived at. This writes what that fit means:
 * the numbers, the rig moved into the picture ready to pose from, the drawing
 * where it now stands, and — when the picture is a PNG this side can read —
 * the picture with the body laid over it.
 */
export async function generateRigMatch(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as RigMatchFlowData;
  const boundInput = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'bound' && candidate.artifact !== undefined);
  const imageInput = ctx.inputs.find((candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined);

  if (!boundInput?.artifact) {
    ctx.warn('No bound rig wired in — connect a Rig Binding flow to the Bound rig input.');
    return { outputs: [] };
  }
  if (!imageInput?.artifact) {
    ctx.warn('No picture wired in — connect an image to the Picture input.');
    return { outputs: [] };
  }

  const state = rigMatchState(data, boundInput.artifact.hash, imageInput.artifact.hash);
  if (state === 'none') {
    ctx.warn('Nothing taken in yet. Open this flow’s editor and press “Take it in”.');
    return { outputs: [] };
  }
  if (state === 'unmatched' || !data.fit || !data.bound) {
    ctx.warn('Not matched yet. Open this flow’s editor and press “Match”.');
    return { outputs: [] };
  }
  if (state === 'stale') {
    ctx.warn(
      `The body or the picture has changed since this match was made. The fit is written as it is — match again in the editor to find the body afresh.`,
    );
  }

  const bound = data.bound;
  const fit = data.fit;
  const picture = data.picture ?? { width: Math.ceil(bound.image.width * fit.scale), height: Math.ceil(bound.image.height * fit.scale) };
  const bones = fittedBones(bound.rig, fit);
  const report = data.report;
  const current = reportIsCurrent(data);
  if (report && !current) ctx.log('The fit was adjusted by hand after it was matched, so the confidences describe the match, not these adjustments.');

  const match = {
    picture,
    placement: { x: round(fit.x), y: round(fit.y), scale: round(fit.scale, 4), rotation: round(fit.rotation), pivot: fit.pivot },
    pose: poseOfFit(fit),
    sizes: fit.sizes,
    confidence: report ? report.confidence : null,
    confidenceIsForThisFit: current,
    parts: bound.rig.bones.map((bone) => {
      const placed = bones.get(bone.id);
      const score = report?.parts[bone.id];
      return {
        id: bone.id,
        name: bone.name,
        angle: round(fit.angles[bone.id] ?? 0),
        size: round(fit.sizes[bone.id] ?? 1, 3),
        confidence: score?.confidence ?? null,
        similarity: score?.similarity ?? null,
        features: score?.features ?? 0,
        from: placed ? { x: round(placed.from.x), y: round(placed.from.y) } : null,
        to: placed ? { x: round(placed.to.x), y: round(placed.to.y) } : null,
      };
    }),
    matched: report ? { at: report.at, rigFeatures: report.rigFeatures, imageFeatures: report.imageFeatures, agreeing: report.agreeing, notes: report.notes } : null,
  };

  const drawing = fittedImage(bound, fit, picture);
  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'match',
      kind: 'json',
      fileName: 'match.json',
      content: `${JSON.stringify(match, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'fitted',
      kind: 'json',
      fileName: 'fitted.json',
      content: `${JSON.stringify(fittedBoundRig(bound, fit, picture), null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'drawing',
      kind: 'image',
      fileName: 'fitted.svg',
      content: toSvg(drawing),
    }),
  ];

  // The overlay needs the picture's pixels, and this side reads PNG only.
  try {
    const bytes = new Uint8Array(await readFile(resolveInProject(ctx.project.id, imageInput.artifact.path)));
    if (!isPng(bytes)) {
      ctx.warn('The overlay is only drawn over a PNG picture; this one is another format, so it was left out.');
    } else {
      const bitmap = await decodePng(bytes, (packed) => new Uint8Array(inflateSync(packed)));
      if (data.showBody) paintVector(bitmap, drawing, { opacity: data.bodyOpacity });
      paintVector(bitmap, skeletonDrawing(bones, bitmap.width), {});
      outputs.push(
        await writeArtifact({
          projectId: ctx.project.id,
          flowId: ctx.node.id,
          port: 'overlay',
          kind: 'image',
          fileName: 'overlay.png',
          content: await encodePng(bitmap, (raw) => new Uint8Array(deflateSync(raw))),
        }),
      );
    }
  } catch (error) {
    ctx.warn(`The overlay could not be drawn: ${(error as Error).message}`);
  }

  if (report) {
    const weak = bound.rig.bones.filter((bone) => {
      const confidence = report.parts[bone.id]?.confidence;
      return confidence !== null && confidence !== undefined && confidence < 0.2;
    });
    if (weak.length > 0) ctx.warn(`Not found with any confidence: ${weak.map((bone) => bone.name).join(', ')}. Adjust them by hand in the editor if they matter.`);
  }
  ctx.log(summariseRigMatch(data));
  if (report) ctx.log(`Confidence ${confidenceLabel(report.confidence)}.`);
  return { outputs };
}

/** The skeleton as strokes, to lay over a picture. */
function skeletonDrawing(bones: ReturnType<typeof fittedBones>, width: number): VectorImage {
  const weight = Math.max(1.5, Math.min(6, width / 240));
  const shapes: VectorShape[] = [];
  for (const [id, bone] of bones) {
    if (Math.hypot(bone.to.x - bone.from.x, bone.to.y - bone.from.y) < 0.5) continue;
    shapes.push({ id: `bone-${id}`, kind: 'line', color: '#ffffff', width: weight * 1.8, points: [bone.from, bone.to], curved: false, closed: false });
    shapes.push({ id: `core-${id}`, kind: 'line', color: '#1c7cf4', width: weight, points: [bone.from, bone.to], curved: false, closed: false });
  }
  return { width, height: 0, shapes };
}
