import {
  boardDuration,
  formatBoardsMarkdown,
  formatShotlistCsv,
  storyboardPayload,
  timePanels,
  type StoryboardFlowData,
} from '@vibetoon/shared';
import { buildSyncPlan, syncSources } from '../services/sync';
import { writeArtifact, writeArtifactSet } from '../storage';
import type { GenerationContext, GenerationResult } from './types';

/**
 * Storyboard generation writes the board out four ways: structured JSON for the
 * flows downstream, a shot list to work from, a readable board document, and the
 * rasterised panel images the client sent along (which is what the animatic and
 * render flows turn into video).
 */
export async function generateStoryboard(ctx: GenerationContext): Promise<GenerationResult> {
  let data = ctx.node.data as StoryboardFlowData;

  // `apply` connections pull upstream changes in as part of generating; the
  // default `suggest` mode waits for you to accept the sync in the editor.
  const applySources = syncSources(ctx.project, ctx.node).filter(
    (source) => source.connection.settings.mode === 'apply' && source.connection.settings.enabled,
  );
  for (const source of applySources) {
    const { plan } = buildSyncPlan(ctx.project, { ...ctx.node, data }, source.connection.id);
    data = {
      ...data,
      scenes: plan.scenes,
      syncSignature: plan.signature,
      syncedAt: new Date().toISOString(),
    };
    ctx.log(
      `Applied ${source.sourceNode.name}: +${plan.counts.add} new, ${plan.counts.update} updated, ${plan.counts.remove} dropped, ${plan.counts.pinned} pinned left alone.`,
    );
    for (const warning of plan.warnings) ctx.warn(warning);
  }

  for (const source of syncSources(ctx.project, ctx.node)) {
    if (source.connection.settings.mode !== 'suggest' || !source.connection.settings.enabled) continue;
    const { plan } = buildSyncPlan(ctx.project, { ...ctx.node, data }, source.connection.id);
    const pending = plan.counts.add + plan.counts.update + plan.counts.remove;
    if (pending > 0) {
      ctx.warn(
        `${source.sourceNode.name} has ${pending} change(s) waiting — open the board and accept the sync to take them.`,
      );
    }
  }

  const timed = timePanels(data.scenes, ctx.project.settings);
  if (timed.length === 0) ctx.warn('No panels yet — sync from the dialog flow or add one by hand.');
  const undrawn = timed.filter((entry) => entry.panel.sketch === null).length;
  if (undrawn > 0) ctx.log(`${undrawn} of ${timed.length} panel(s) have no sketch yet.`);

  const outputs = [
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'storyboard',
      kind: 'json',
      fileName: 'storyboard.json',
      content: `${JSON.stringify(storyboardPayload(data.scenes, ctx.project.settings), null, 2)}\n`,
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'shotlist',
      kind: 'csv',
      fileName: 'shotlist.csv',
      content: formatShotlistCsv(data.scenes, ctx.project.settings),
    }),
    await writeArtifact({
      projectId: ctx.project.id,
      flowId: ctx.node.id,
      port: 'boards',
      kind: 'markdown',
      fileName: 'boards.md',
      content: formatBoardsMarkdown(data.scenes, ctx.project.settings),
    }),
  ];

  const panelImages = ctx.attachments.filter((a) => a.name.startsWith('panels/'));
  if (panelImages.length > 0) {
    outputs.push(
      await writeArtifactSet({
        projectId: ctx.project.id,
        flowId: ctx.node.id,
        port: 'panels',
        kind: 'imageSet',
        dirName: 'panels',
        files: panelImages.map((a) => ({
          name: a.name.slice('panels/'.length),
          content: a.bytes,
        })),
      }),
    );
    ctx.log(`Wrote ${panelImages.length} panel image(s).`);
  } else if (timed.some((entry) => entry.panel.sketch !== null)) {
    ctx.warn('Panel images were not sent with this run, so `panels/` was left as it was.');
  }

  ctx.log(
    `${data.scenes.length} scene(s), ${timed.length} panel(s), ${boardDuration(data.scenes, ctx.project.settings).toFixed(1)}s of board.`,
  );

  return { outputs, data };
}
