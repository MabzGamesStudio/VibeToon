import {
  summariseVector,
  toSvg,
  vectorizeState,
  type VectorizeFlowData,
} from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * A picture, turned back into shapes.
 *
 * The decomposition runs in the editor, because that is where the pixels are —
 * the browser is what decodes a PNG, and this flow reads every one of them. What
 * lands here is the answer, which is a few hundred shapes rather than a few
 * million pixels, so a run is instant and needs neither the picture nor a network.
 */
export async function generateVectorize(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as VectorizeFlowData;

  const input = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined,
  );
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }

  const state = vectorizeState(data, input.artifact.hash);
  if (state === 'none') {
    ctx.warn(
      `${input.sourceNode.name} has an image, but it has not been decomposed yet. Open this flow's editor and press “Decompose”.`,
    );
    return { outputs: [] };
  }
  if (state === 'stale') {
    ctx.warn(
      `The image on ${input.sourceNode.name} has changed since it was decomposed, so these shapes describe the old one. Open this flow's editor and run it again.`,
    );
    return { outputs: [] };
  }

  const image = data.result!;
  const summary = summariseVector(image);
  if (summary.shapes === 0) {
    ctx.warn('The decomposition found no shapes. Check the image is not entirely transparent.');
  }

  const report = [
    `# ${ctx.node.name} — decomposition`,
    '',
    `- Image: **${input.sourceNode.name}** (\`${input.artifact.fileName}\`), ${image.width} × ${image.height}`,
    `- Shapes: **${summary.shapes}** — ${summary.polygons} polygon(s), ${summary.lines} line(s)`,
    `- Lines: ${summary.straightLines} straight, ${summary.curvedLines} curved`,
    `- Points in total: ${summary.points.toLocaleString()}`,
    `- Colors: ${summary.colors.length}`,
    `- Widest a stroke may be: ${data.options.lineWidth}px`,
    `- Same-color tolerance: ${data.options.tolerance}`,
    `- Simplified to within ${data.options.simplify}px`,
    ...(data.options.minArea > 0 ? [`- Regions under ${data.options.minArea}px dropped`] : []),
    '',
    '## What counts as a line',
    '',
    'A line is a region that is **thin** *and* has **different things on either',
    'side of it**. Both halves matter. A long thin shape on its own is a shape, not',
    'a stroke; and every region separates its neighbours from each other in some',
    'sense, so separating alone says nothing.',
    '',
    'A red box beside a blue box is two areas and no line, because neither is thin —',
    'the boundary between two colors is not a drawn mark. Put a black stroke between',
    'them and the black is thin with red one side and blue the other, so it becomes a',
    'line and the boxes are still areas.',
    '',
    'Which leaves one number to set: how wide a stroke may be. Below it a thin shape',
    'is a mark with a middle, above it the same shape is a long thin area with an',
    'inside. There is no right answer in general — it depends how the picture was',
    'drawn — so it is a number you turn while watching the result.',
    '',
    '## The colors',
    '',
    '| Color | Shapes |',
    '| --- | --- |',
    ...summary.colors.map((color) => {
      const count = image.shapes.filter((shape) => shape.color === color).length;
      return `| \`${color}\` | ${count} |`;
    }),
    '',
    '## What the shapes are',
    '',
    'A **polygon** is an area of one color, and is always convex: a traced region is',
    'any shape at all, and is cut into convex pieces because that is what everything',
    'downstream can rely on. A convex polygon is trivially triangulated, filled and',
    'point-tested, and never has the self-intersections that make a concave one a',
    'special case in every renderer that meets it.',
    '',
    'A **line** is a stroke, stored as the anchors along its middle plus whether the',
    'run between them curves. The drawing writes those as real cubic Béziers; the',
    'anchors are kept because they are what can be edited.',
    '',
    ...(summary.concave > 0
      ? [
          `> ${summary.concave} polygon(s) are not convex. Editing can do that, and`,
          '> anything relying on convexity should know.',
          '',
        ]
      : []),
  ];

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'vector',
      kind: 'json',
      fileName: 'vector.json',
      content: `${JSON.stringify(image, null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'svg',
      kind: 'image',
      fileName: 'vector.svg',
      content: toSvg(image),
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'report',
      kind: 'markdown',
      fileName: 'vector.md',
      content: `${report.join('\n')}\n`,
    }),
  ];

  ctx.log(
    `${summary.shapes} shape(s): ${summary.polygons} polygon(s) and ${summary.lines} line(s) in ${summary.colors.length} color(s).`,
  );
  return { outputs };
}
