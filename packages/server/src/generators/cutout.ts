import { labelOf, objectsOf, summariseCutout, type CutoutFlowData } from '@vibetoon/shared';
import { writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * The image extraction flow.
 *
 * The pixels are decided in the editor, for the same reason the palette flow
 * counts them there: the browser is what can decode a JPEG, and a canvas is what
 * can composite a mask. The editor rasterises the cutout and the mask and sends
 * them along with the run, exactly as the design flows send their plates.
 *
 * What is stored in the project is the *objects* — the seeds and the cut lines —
 * not the mask. So the file can always be rebuilt from what you did, and the
 * project file stays a few kilobytes rather than a bitmap.
 */
export async function generateCutout(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as CutoutFlowData;

  const input = ctx.inputs.find(
    (candidate) => candidate.connection.to.portId === 'image' && candidate.artifact !== undefined,
  );
  if (!input?.artifact) {
    ctx.warn('No image wired in — connect one to the Image input.');
    return { outputs: [] };
  }

  const cutout = ctx.attachments.find((attachment) => attachment.name === 'cutout.png');
  const mask = ctx.attachments.find((attachment) => attachment.name === 'mask.png');

  if (data.seeds.length === 0 && data.lines.length === 0) {
    ctx.warn(
      'Nothing has been selected yet. Open this flow’s editor and left-click the part of the image to keep.',
    );
    return { outputs: [] };
  }
  if (!cutout) {
    ctx.warn(
      data.imageHash && data.imageHash !== input.artifact.hash
        ? `The image on ${input.sourceNode.name} has changed since the cutout was made. Open this flow’s editor to redo it against the new one.`
        : 'The cutout has not been rendered yet. Open this flow’s editor and press Generate from there.',
    );
    return { outputs: [] };
  }

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'cutout',
      kind: 'image',
      fileName: 'cutout.png',
      content: cutout.bytes,
    }),
  ];
  if (mask) {
    outputs.push(
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'mask',
        kind: 'image',
        fileName: 'mask.png',
        content: mask.bytes,
      }),
    );
  }

  const includes = data.seeds.filter((seed) => seed.mode === 'include' && !seed.muted);
  const excludes = data.seeds.filter((seed) => seed.mode === 'exclude' && !seed.muted);
  const cuts = data.lines.filter((line) => !line.muted);
  const regions = (data.regions ?? []).filter((region) => !region.muted);

  const lines = [
    `# ${ctx.node.name} — cutout`,
    '',
    `- From: **${input.sourceNode.name}** (\`${input.artifact.fileName}\`)`,
    ...(data.imageWidth && data.imageHeight
      ? [`- Image: ${data.imageWidth} × ${data.imageHeight}`]
      : []),
    `- Included regions: ${includes.length}`,
    `- Excluded regions: ${excludes.length}`,
    `- Cut lines: ${cuts.length}`,
    ...(regions.length > 0 ? [`- Drawn regions: ${regions.length}`] : []),
    `- Edge: grow ${data.options.grow}px, feather ${data.options.feather}px`,
    `- Neighbours: ${data.options.diagonal ? 'including diagonals' : 'four-way'}`,
    ...(data.options.minIsland > 0 ? [`- Islands under ${data.options.minIsland}px dropped`] : []),
    '',
    '## What was selected',
    '',
    '| Object | What it does | Where | Tolerance |',
    '| --- | --- | --- | --- |',
    ...objectsOf(data).map((object) => {
      const name = labelOf(data, object);
      if (object.type === 'seed') {
        return `| ${name} | ${object.mode === 'include' ? 'fills a region in' : 'takes a region out'}${
          object.muted ? ' *(off)*' : ''
        } | ${Math.round(object.x)}, ${Math.round(object.y)} | ${object.tolerance} |`;
      }
      const points = object.points.length / 2;
      if (object.type === 'region') {
        return `| ${name} | ${
          object.mode === 'include' ? 'keeps everything inside it' : 'drops everything inside it'
        }${object.muted ? ' *(off)*' : ''} | ${points} point${points === 1 ? '' : 's'}, ${
          object.curved ? 'smoothed' : 'cornered'
        } | — |`;
      }
      return `| ${name} | ${
        object.mode === 'erase' ? 'clears what it covers' : 'blocks a fill from crossing'
      }${object.muted ? ' *(off)*' : ''} | ${points} point${points === 1 ? '' : 's'}, ${
        points === 2 ? 'straight' : 'curved'
      } | ${object.width}px wide |`;
    }),
    '',
    '## How it works',
    '',
    'A left click floods out from where it landed, taking every neighbouring pixel',
    'within its tolerance **of the pixel that was clicked** — not of each',
    "neighbour, which is how a magic wand ends up selecting a whole gradient one",
    'indistinguishable step at a time. A right click does the same and takes the',
    'region back out. A cut line is a barrier a fill cannot cross, which is what',
    'separates two regions the pixels think are the same: the shadow joining an arm',
    'to a body is the everyday case. Two points make it straight and more make it a',
    'curve, so there is no straight-or-curved to decide before drawing one.',
    '',
    'A drawn region ignores the pixels entirely and takes — or drops — everything',
    'inside its outline. That is the tool for a subject no tolerance can separate',
    'from its background, where every fill catches some of both.',
    '',
    'Distance is measured in OKLab, times 100 — under about 2 is a difference you',
    'cannot see, 20 is navy against royal blue.',
    '',
    'The objects are applied in the order they were made, so an exclude takes a bite',
    'out of what came before it and an include after that puts some back. The mask is',
    'rebuilt from that list every time, which is why deleting an object takes its',
    'region with it rather than leaving it painted on.',
    '',
  ];

  if (data.options.grow !== 0 || data.options.feather > 0) {
    lines.push(
      '## Edge',
      '',
      ...(data.options.grow > 0
        ? [
            `Grown by ${data.options.grow}px. A fill stops a pixel or two short of a`,
            'photographed edge, because the edge itself is blended; growing takes that',
            'halo back.',
            '',
          ]
        : []),
      ...(data.options.grow < 0
        ? [`Shrunk by ${Math.abs(data.options.grow)}px, which trims a halo of background off the edge.`, '']
        : []),
      ...(data.options.feather > 0
        ? [`Feathered by ${data.options.feather}px, so the edge is soft rather than cut with scissors.`, '']
        : []),
    );
  }

  outputs.push(
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'notes',
      kind: 'markdown',
      fileName: 'cutout.md',
      content: `${lines.join('\n')}\n`,
    }),
  );

  ctx.log(summariseCutout(data, null));
  if (!mask) ctx.log('The mask was not rendered; only the cutout was written.');
  return { outputs };
}
