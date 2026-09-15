import path from 'node:path';
import { stat } from 'node:fs/promises';
import {
  animaticPayload,
  cutLimitsFromRules,
  formatDuration,
  resolveAnimaticCut,
  type AnimaticCut,
  type AnimaticFlowData,
  type ArtifactRef,
  type ResolvedInput,
  type StoryboardPayload,
} from '@vibetoon/shared';
import { ensureDir, flowArtifactsDir, projectDir } from '../paths';
import { ffmpegCommand, hasFfmpeg, renderVideo, writeConcatFile, type VideoClip } from '../render/video';
import { artifactExists, listArtifactSet, readArtifactText, writeArtifact } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

function findInput(ctx: GenerationContext, port: string, predicate: (input: ResolvedInput) => boolean) {
  return ctx.inputs.find((input) => input.connection.to.portId === port && predicate(input));
}

/**
 * The animatic: the board laid out in time. The cut list is always written,
 * because that is what the edit and the render flows read. The video is written
 * here when ffmpeg is installed; without it, the editor records the same cut in
 * the browser and uploads it to this flow's Preview port, so the file exists
 * either way.
 */
export async function generateAnimatic(ctx: GenerationContext): Promise<GenerationResult> {
  const data = ctx.node.data as AnimaticFlowData;

  const boardInput = findInput(ctx, 'storyboard', (input) => input.artifact !== undefined);
  const panelsInput = findInput(ctx, 'panels', (input) => input.artifact?.kind === 'imageSet');
  const audioInput = ctx.inputs.find(
    (input) => input.artifact?.kind === 'audio' && ['vo', 'music'].includes(input.connection.to.portId),
  );

  let board: StoryboardPayload | null = null;
  if (boardInput?.artifact) {
    try {
      board = JSON.parse(await readArtifactText(ctx.project.id, boardInput.artifact.path)) as StoryboardPayload;
      ctx.log(`Read ${board.panels?.length ?? 0} panel(s) from ${boardInput.sourceNode.name}.`);
    } catch (error) {
      ctx.warn(`Could not read ${boardInput.artifact.fileName}: ${String(error)}`);
    }
  } else {
    ctx.warn('No storyboard wired in, so there is no cut to lay out yet.');
  }

  const limits = boardInput ? cutLimitsFromRules(boardInput.connection.rules) : {};
  const effective: AnimaticFlowData =
    // A `target length` rule on the wire stands in for the flow's own target.
    limits.targetSeconds !== undefined && data.targetSeconds <= 0
      ? { ...data, targetSeconds: limits.targetSeconds }
      : data;

  const cut = resolveAnimaticCut(board, effective, ctx.project.settings, limits);

  // Panel images live in the board's folder; the cut list carries paths that
  // work from anywhere in the project.
  const panelDir = panelsInput?.artifact?.path ?? null;
  const available = panelDir ? await listArtifactSet(ctx.project.id, panelDir) : [];
  const resolveImage = (image: string | null): string | null => {
    if (!image || !panelDir) return null;
    const fileName = path.posix.basename(image);
    return available.includes(fileName) ? `${panelDir}/${fileName}` : null;
  };
  const placed: AnimaticCut = {
    ...cut,
    clips: cut.clips.map((clip) => ({ ...clip, image: resolveImage(clip.image) })),
  };

  if (cut.clips.length > 0 && placed.clips.every((clip) => clip.image === null)) {
    ctx.warn(
      panelDir
        ? 'The panel images wired in do not match the board — regenerate the storyboard.'
        : 'No panel images wired in, so the cut has timings but nothing to show.',
    );
  }
  if (cut.skipped.length > 0) ctx.log(`${cut.skipped.length} shot(s) cut out of the animatic.`);
  if (cut.adjustedCount > 0) ctx.log(`${cut.adjustedCount} shot(s) retimed away from the board.`);
  if (cut.targetSeconds > 0) {
    const off = cut.offTargetSec;
    ctx.log(
      `${formatDuration(cut.durationSec)} against a target of ${formatDuration(cut.targetSeconds)} (${
        off >= 0 ? '+' : ''
      }${off.toFixed(1)}s).`,
    );
  }

  const audioPath = audioInput?.artifact
    ? path.join(projectDir(ctx.project.id), audioInput.artifact.path)
    : undefined;
  const audioUsable =
    audioPath !== undefined &&
    audioInput?.artifact !== undefined &&
    (await artifactExists(ctx.project.id, audioInput.artifact.path));

  const outputs: ArtifactRef[] = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'animatic',
      kind: 'timeline',
      fileName: 'animatic.json',
      content: `${JSON.stringify(
        animaticPayload(placed, {
          name: ctx.node.name,
          pacing: data.pacing,
          source: boardInput?.artifact?.path ?? null,
          audio: audioUsable ? audioInput!.artifact!.path : null,
        }),
        null,
        2,
      )}\n`,
    }),
  ];

  const dir = flowArtifactsDir(ctx.project.id, ctx.node.id);
  await ensureDir(dir);

  const videoClips: VideoClip[] = placed.clips
    .filter((clip) => clip.image !== null)
    .map((clip) => ({
      imagePath: path.join(projectDir(ctx.project.id), clip.image!),
      durationSec: clip.durationSec,
    }));

  const planLines = [
    `# ${ctx.node.name} — animatic`,
    '',
    `- Frame: ${placed.width}x${placed.height} at ${placed.fps}fps`,
    `- Cut: ${placed.clips.length} shot(s), ${formatDuration(placed.durationSec)}`,
    `- Board: ${formatDuration(placed.boardDurationSec)}${
      placed.adjustedCount > 0 ? ` (${placed.adjustedCount} shot(s) retimed here)` : ''
    }`,
    `- Target: ${placed.targetSeconds > 0 ? formatDuration(placed.targetSeconds) : 'none set'}`,
    `- Audio: ${audioUsable ? audioInput!.artifact!.path : 'none wired in'}`,
    '',
  ];

  if (videoClips.length === 0) {
    ctx.warn('Nothing to render: generate the storyboard so its panels are rasterised.');
    planLines.push('Nothing to render yet — the board has no panel images.', '');
  } else {
    const concatPath = await writeConcatFile(dir, videoClips);
    const outName = 'animatic.mp4';
    const outPath = path.join(dir, outName);
    const request = {
      concatPath,
      outPath,
      fps: placed.fps,
      width: placed.width,
      height: placed.height,
      ...(audioUsable ? { audioPath } : {}),
    };

    planLines.push('## Command', '', '```sh', ffmpegCommand(request), '```', '');

    if (hasFfmpeg()) {
      const outcome = await renderVideo(request);
      if (outcome.ok) {
        const info = await stat(outPath);
        outputs.push({
          port: 'preview',
          kind: 'video',
          fileName: outName,
          path: path.posix.join('artifacts', ctx.node.id, outName),
          hash: `${info.size.toString(16)}-${Math.round(placed.durationSec * 1000).toString(16)}`,
          bytes: info.size,
          generatedAt: new Date().toISOString(),
        });
        ctx.log(`Rendered ${outName} (${(info.size / 1024).toFixed(0)} KB) with ffmpeg.`);
        planLines.push('## Result', '', `Rendered \`${outName}\`.`, '');
      } else {
        ctx.warn(`ffmpeg failed: ${outcome.output.split('\n').slice(-3).join(' ')}`);
        planLines.push('## Result', '', '```', outcome.output, '```', '');
      }
    } else {
      ctx.log(
        'ffmpeg is not installed here, so no file was rendered on the server. Use “Export video” in the animatic editor to record the cut in the browser.',
      );
      planLines.push(
        '## Result',
        '',
        'ffmpeg was not found on this machine. Either install it and run the command above,',
        'or press **Export video** in the animatic editor, which records the same cut in the',
        'browser and uploads it to this flow’s Preview port.',
        '',
      );
    }
  }

  await writeArtifact({
    projectId: ctx.project.id,
    flowId: ctx.node.id,
    port: '_animaticPlan',
    kind: 'markdown',
    fileName: 'animatic-plan.md',
    content: `${planLines.join('\n')}\n`,
  });

  return { outputs };
}
