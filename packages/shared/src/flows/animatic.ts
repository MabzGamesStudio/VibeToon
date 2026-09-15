import type { StoryboardPayload } from './storyboard';
import { parseRules, ruleNumber, ruleValue } from '../rules/parseRules';
import type { ProjectSettings } from '../types/project';
import type {
  AnimaticClip,
  AnimaticCut,
  AnimaticFlowData,
  AnimaticShotOverride,
} from '../types/animatic';

export function emptyAnimaticData(): AnimaticFlowData {
  return { editor: 'animatic', overrides: {}, targetSeconds: 0, pacing: '' };
}

export interface CutLimits {
  /** Clamp every shot to at least this long. */
  minDuration?: number;
  /** Clamp every shot to at most this long. */
  maxDuration?: number;
}

/** `min duration`, `max duration` and `target length` off a connection's rules. */
export function cutLimitsFromRules(rulesText: string): CutLimits & { targetSeconds?: number } {
  const rules = parseRules(rulesText);
  const limits: CutLimits & { targetSeconds?: number } = {};
  if (ruleValue(rules, 'min duration') !== undefined) {
    limits.minDuration = Math.max(0.1, ruleNumber(rules, 'min duration', 0.1));
  }
  if (ruleValue(rules, 'max duration') !== undefined) {
    limits.maxDuration = Math.max(0.1, ruleNumber(rules, 'max duration', 60));
  }
  const target = ruleValue(rules, 'target length');
  if (target !== undefined) {
    const parsed = parseDuration(target);
    if (parsed !== undefined) limits.targetSeconds = parsed;
  }
  return limits;
}

/** `90s`, `1m30`, `1:30` or a bare number of seconds. */
export function parseDuration(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  const clock = text.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const minutes = text.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\s*(\d+(?:\.\d+)?)?\s*s?$/);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2] ?? 0);
  const seconds = text.match(/^(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?)?$/);
  if (seconds) return Number(seconds[1]);
  return undefined;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return minutes > 0 ? `${minutes}m ${rest.toFixed(1)}s` : `${rest.toFixed(1)}s`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Lay the board out as a cut. The board decides what the shots are; the animatic
 * decides how long they are held and which ones are in, which is the whole point
 * of having it as a separate flow — retiming here never touches the drawings.
 */
export function resolveAnimaticCut(
  board: StoryboardPayload | null,
  data: AnimaticFlowData,
  settings: Pick<ProjectSettings, 'fps' | 'width' | 'height'>,
  limits: CutLimits = {},
): AnimaticCut {
  const fps = board?.fps || settings.fps || 24;
  const width = board?.width || settings.width;
  const height = board?.height || settings.height;

  const clips: AnimaticClip[] = [];
  const skipped: AnimaticCut['skipped'] = [];
  let cursor = 0;
  let boardDuration = 0;
  let adjustedCount = 0;

  for (const panel of board?.panels ?? []) {
    boardDuration += panel.durationSec;
    const override: AnimaticShotOverride = data.overrides[panel.id] ?? {};

    if (override.skip) {
      skipped.push({
        panelId: panel.id,
        boardIndex: panel.index,
        shot: panel.shot,
        dialog: panel.dialog,
      });
      continue;
    }

    const requested = override.durationSec ?? panel.durationSec;
    const clamped = Math.min(
      limits.maxDuration ?? Number.POSITIVE_INFINITY,
      Math.max(limits.minDuration ?? 0.1, requested),
    );
    const durationSec = round(Math.max(0.1, clamped));
    const adjusted = Math.abs(durationSec - panel.durationSec) > 0.001;
    if (adjusted) adjustedCount += 1;

    clips.push({
      panelId: panel.id,
      index: clips.length,
      boardIndex: panel.index,
      scene: panel.scene,
      shot: panel.shot,
      action: panel.action,
      dialog: panel.dialog,
      sound: panel.sound,
      image: panel.image ?? null,
      boardDurationSec: panel.durationSec,
      durationSec,
      startSec: round(cursor),
      endSec: round(cursor + durationSec),
      startFrame: Math.round(cursor * fps),
      frames: Math.max(1, Math.round(durationSec * fps)),
      adjusted,
      note: override.note ?? '',
    });
    cursor += durationSec;
  }

  const targetSeconds = data.targetSeconds > 0 ? data.targetSeconds : 0;
  return {
    fps,
    width,
    height,
    clips,
    skipped,
    durationSec: round(cursor),
    boardDurationSec: round(boardDuration),
    targetSeconds,
    offTargetSec: targetSeconds > 0 ? round(cursor - targetSeconds) : 0,
    adjustedCount,
  };
}

/* ------------------------------------------------------------------ *
 * Editing helpers
 * ------------------------------------------------------------------ */

export function withOverride(
  data: AnimaticFlowData,
  panelId: string,
  patch: AnimaticShotOverride,
): AnimaticFlowData {
  const next: AnimaticShotOverride = { ...(data.overrides[panelId] ?? {}), ...patch };
  // An override that says nothing is removed, so a reset leaves no trace in the
  // project file and the shot goes back to following the board.
  for (const key of Object.keys(next) as Array<keyof AnimaticShotOverride>) {
    const value = next[key];
    if (value === undefined || value === '' || value === false) delete next[key];
  }

  const overrides = { ...data.overrides };
  if (Object.keys(next).length === 0) delete overrides[panelId];
  else overrides[panelId] = next;
  return { ...data, overrides };
}

export function clearOverrides(data: AnimaticFlowData): AnimaticFlowData {
  return { ...data, overrides: {} };
}

/**
 * Scale every shot so the cut lands on its target, keeping their relative
 * lengths. The quickest way to answer "it has to be 60 seconds".
 */
export function fitCutToTarget(data: AnimaticFlowData, cut: AnimaticCut): AnimaticFlowData {
  if (cut.targetSeconds <= 0 || cut.durationSec <= 0 || cut.clips.length === 0) return data;
  const scale = cut.targetSeconds / cut.durationSec;
  let next = data;
  for (const clip of cut.clips) {
    next = withOverride(next, clip.panelId, {
      durationSec: Math.max(0.1, round(clip.durationSec * scale)),
    });
  }
  return next;
}

/** The `animatic.json` artifact. */
export function animaticPayload(
  cut: AnimaticCut,
  extra: { name: string; pacing: string; source: string | null; audio: string | null },
): Record<string, unknown> {
  return {
    flow: 'animation.animatic',
    name: extra.name,
    fps: cut.fps,
    width: cut.width,
    height: cut.height,
    durationSec: cut.durationSec,
    boardDurationSec: cut.boardDurationSec,
    targetSeconds: cut.targetSeconds,
    offTargetSec: cut.offTargetSec,
    clipCount: cut.clips.length,
    renderableClipCount: cut.clips.filter((clip) => clip.image !== null).length,
    skipped: cut.skipped,
    adjustedCount: cut.adjustedCount,
    pacing: extra.pacing,
    source: extra.source,
    audio: extra.audio,
    clips: cut.clips.map((clip) => ({
      index: clip.index + 1,
      panelId: clip.panelId,
      boardIndex: clip.boardIndex + 1,
      scene: clip.scene,
      shot: clip.shot,
      startSec: clip.startSec,
      endSec: clip.endSec,
      durationSec: clip.durationSec,
      boardDurationSec: clip.boardDurationSec,
      frames: clip.frames,
      startFrame: clip.startFrame,
      image: clip.image,
      dialog: clip.dialog,
      sound: clip.sound,
      action: clip.action,
      adjusted: clip.adjusted,
      note: clip.note,
    })),
  };
}
