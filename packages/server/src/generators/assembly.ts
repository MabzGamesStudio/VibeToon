import path from 'node:path';
import {
  briefPayload,
  type ArtifactRef,
  type BriefFlowData,
  type ResolvedInput,
} from '@vibetoon/shared';
import { ensureDir, flowArtifactsDir, projectDir } from '../paths';
import { artifactExists, listArtifactSet, readArtifactText, writeArtifact } from '../storage';
import { ffmpegCommand, hasFfmpeg, renderVideo, writeConcatFile, type VideoClip } from '../render/video';
import { generateBrief } from './brief';
import type { GenerationContext, GenerationResult } from './types';

interface BoardPanel {
  index: number;
  shot: string;
  dialog: string;
  sound: string;
  action: string;
  startSec: number;
  durationSec: number;
  frames: number;
  image: string | null;
}

interface BoardPayload {
  fps?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  panels?: BoardPanel[];
}

function findInput(ctx: GenerationContext, predicate: (input: ResolvedInput) => boolean) {
  return ctx.inputs.find((input) => input.artifact !== undefined && predicate(input));
}

/**
 * Turns a storyboard into something you can watch. The timeline (animatic.json /
 * edl.json) is always written, because it is the real deliverable other flows
 * read. The mp4 is written when ffmpeg is on the machine and the panels have
 * been rasterised; when it is not, the exact command is written to the render
 * plan so the same file can be produced later without guessing.
 */
export async function generateAssembly(ctx: GenerationContext): Promise<GenerationResult> {
  const timelinePorts = ctx.def.outputs.filter((port) => port.kinds.includes('timeline'));
  const videoPorts = ctx.def.outputs.filter((port) => port.kinds.includes('video'));
  const handled = new Set([...timelinePorts, ...videoPorts].map((port) => port.id));

  const base = await generateBrief(ctx, { skipPorts: handled });
  const outputs: ArtifactRef[] = [...base.outputs];

  const boardInput = findInput(
    ctx,
    (input) => input.artifact?.kind === 'json' || input.artifact?.kind === 'timeline',
  );
  const panelsInput = findInput(ctx, (input) => input.artifact?.kind === 'imageSet');
  const audioInput = findInput(
    ctx,
    (input) => input.artifact?.kind === 'audio' || input.artifact?.kind === 'audioSet',
  );

  let board: BoardPayload = {};
  if (boardInput?.artifact) {
    try {
      board = JSON.parse(await readArtifactText(ctx.project.id, boardInput.artifact.path)) as BoardPayload;
      ctx.log(`Read ${board.panels?.length ?? 0} panel(s) from ${boardInput.sourceNode.name}.`);
    } catch (error) {
      ctx.warn(`Could not read ${boardInput.artifact.fileName}: ${String(error)}`);
    }
  } else {
    ctx.warn('No storyboard or timeline wired in, so there is nothing to assemble yet.');
  }

  const fps = board.fps ?? ctx.project.settings.fps;
  const width = board.width ?? ctx.project.settings.width;
  const height = board.height ?? ctx.project.settings.height;
  const panels = board.panels ?? [];

  // Resolve each panel to a real image on disk where one exists.
  const panelDir = panelsInput?.artifact?.path;
  const available = panelDir ? await listArtifactSet(ctx.project.id, panelDir) : [];
  const clips: VideoClip[] = [];
  const timelineClips = [] as Array<Record<string, unknown>>;

  for (const panel of panels) {
    const fileName = panel.image ? path.posix.basename(panel.image) : null;
    const relative = fileName && available.includes(fileName) ? `${panelDir}/${fileName}` : null;
    if (relative) {
      clips.push({
        imagePath: path.join(projectDir(ctx.project.id), relative),
        durationSec: panel.durationSec,
      });
    }
    timelineClips.push({
      index: panel.index + 1,
      shot: panel.shot,
      startSec: panel.startSec,
      durationSec: panel.durationSec,
      frames: panel.frames,
      image: relative,
      dialog: panel.dialog,
      sound: panel.sound,
      action: panel.action,
    });
  }

  const audioPath = audioInput?.artifact
    ? path.join(projectDir(ctx.project.id), audioInput.artifact.path)
    : undefined;
  const audioUsable =
    audioInput?.artifact?.kind === 'audio' &&
    audioPath !== undefined &&
    (await artifactExists(ctx.project.id, audioInput.artifact.path));

  const timeline = {
    flow: ctx.def.kind,
    name: ctx.node.name,
    fps,
    width,
    height,
    durationSec: board.durationSec ?? clips.reduce((sum, clip) => sum + clip.durationSec, 0),
    source: boardInput?.artifact
      ? { flow: boardInput.sourceNode.name, artifact: boardInput.artifact.path }
      : null,
    audio: audioUsable ? { role: audioInput!.connection.to.portId, path: audioInput!.artifact!.path } : null,
    clipCount: timelineClips.length,
    renderableClipCount: clips.length,
    notes: briefPayload(ctx.def, ctx.node.data as BriefFlowData),
    clips: timelineClips,
  };

  for (const port of timelinePorts) {
    outputs.push(
      await writeArtifact({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: port.id,
        kind: 'timeline',
        fileName: port.fileName ?? `${port.id}.json`,
        content: `${JSON.stringify(timeline, null, 2)}\n`,
      }),
    );
  }

  if (videoPorts.length === 0) {
    return { outputs };
  }

  const dir = flowArtifactsDir(ctx.project.id, ctx.node.id);
  await ensureDir(dir);

  if (clips.length === 0) {
    ctx.warn(
      panels.length === 0
        ? 'No panels to render. Generate the storyboard flow first.'
        : 'The storyboard has panels but no rasterised images yet — open the board and generate it so `panels/` is written.',
    );
    return { outputs };
  }

  const concatPath = await writeConcatFile(dir, clips);
  const videoPort = videoPorts[0]!;
  const outName = videoPort.fileName ?? 'clip.mp4';
  const outPath = path.join(dir, outName);
  const request = { concatPath, outPath, fps, width, height, ...(audioUsable ? { audioPath } : {}) };

  const planLines = [
    `# ${ctx.node.name} — render plan`,
    '',
    `- Frame: ${width}x${height} at ${fps}fps`,
    `- Clips: ${clips.length} of ${panels.length} panel(s) have an image`,
    `- Length: ${timeline.durationSec.toFixed(1)}s`,
    `- Audio: ${audioUsable ? audioInput!.artifact!.path : 'none wired in'}`,
    '',
    '## Command',
    '',
    '```sh',
    ffmpegCommand(request),
    '```',
    '',
    'The clip list is in `concat.txt` next to this file, so the command above can be',
    're-run by hand at any time.',
    '',
  ];

  if (hasFfmpeg()) {
    const outcome = await renderVideo(request);
    if (outcome.ok) {
      const stat = await import('node:fs/promises').then((fs) => fs.stat(outPath));
      outputs.push({
        port: videoPort.id,
        kind: 'video',
        fileName: outName,
        path: path.posix.join('artifacts', ctx.node.id, outName),
        hash: `${stat.size.toString(16)}-${Math.round(timeline.durationSec * 1000).toString(16)}`,
        bytes: stat.size,
        generatedAt: new Date().toISOString(),
      });
      ctx.log(`Rendered ${outName} (${(stat.size / 1024).toFixed(0)} KB) with ffmpeg.`);
      planLines.push('## Result', '', `Rendered \`${outName}\`.`, '');
    } else {
      ctx.warn(`ffmpeg failed: ${outcome.output.split('\n').slice(-3).join(' ')}`);
      planLines.push('## Result', '', '```', outcome.output, '```', '');
    }
  } else {
    ctx.warn('ffmpeg is not installed, so no mp4 was written. The command is in the render plan.');
    planLines.push(
      '## Result',
      '',
      'ffmpeg was not found on this machine. Install it and run the command above, or',
      'use the play button in the storyboard editor to watch the board in the browser.',
      '',
    );
  }

  await writeArtifact({
    projectId: ctx.project.id,
    flowId: ctx.node.id,
    port: '_renderPlan',
    kind: 'markdown',
    fileName: 'render-plan.md',
    content: `${planLines.join('\n')}\n`,
  });

  return { outputs };
}
