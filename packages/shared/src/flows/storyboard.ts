import { hashValue, newId } from '../ids';
import {
  beatDuration,
  characterById,
  DEFAULT_DURATION_OPTIONS,
  setById,
  type DurationOptions,
} from './dialog';
import {
  parseRules,
  ruleFlagSet,
  ruleMap,
  ruleNumber,
  ruleSceneFilter,
  ruleValue,
  type ParsedRules,
} from '../rules/parseRules';
import type {
  DialogBeat,
  DialogFlowData,
  ProjectSettings,
  ShotSize,
  StoryboardFlowData,
  StoryboardPanel,
  StoryboardScene,
} from '../types/project';
import { SHOT_SIZES } from '../types/project';

export function emptyStoryboardData(): StoryboardFlowData {
  return { editor: 'storyboard', scenes: [] };
}

export function newPanel(overrides: Partial<StoryboardPanel> = {}): StoryboardPanel {
  return {
    id: newId('pnl'),
    sourceBeatIds: [],
    shot: 'MS',
    camera: '',
    action: '',
    dialog: '',
    sound: '',
    durationSec: 2,
    notes: '',
    sketch: null,
    pinned: false,
    ...overrides,
  };
}

export function newStoryboardScene(index: number): StoryboardScene {
  return {
    id: newId('sbs'),
    title: `Scene ${index + 1}`,
    setName: '',
    panels: [newPanel()],
  };
}

function asShot(value: string | undefined, fallback: ShotSize): ShotSize {
  if (!value) return fallback;
  const upper = value.trim().toUpperCase() as ShotSize;
  return SHOT_SIZES.includes(upper) ? upper : fallback;
}

/* ------------------------------------------------------------------ *
 * Deriving a board from dialog, through a connection's rules
 * ------------------------------------------------------------------ */

export type PanelGranularity = 'beat' | 'line' | 'scene' | 'action';

export interface DeriveConfig {
  granularity: PanelGranularity;
  mergeActions: boolean;
  shotDefault: ShotSize;
  shotForLine: ShotSize;
  shotForAction: ShotSize;
  shotForSound: ShotSize;
  ignore: Set<string>;
  carry: Record<string, string>;
  duration: DurationOptions;
  sceneAllowed: (oneBased: number) => boolean;
}

/** Turn the plain-text rules on a connection into the knobs the deriver uses. */
export function deriveConfigFromRules(
  rules: ParsedRules,
  settings: Pick<ProjectSettings, 'defaultShotSeconds'>,
): DeriveConfig {
  const granularityRaw = (ruleValue(rules, 'panel per') ?? 'beat').toLowerCase();
  const granularity: PanelGranularity = (['beat', 'line', 'scene', 'action'] as const).includes(
    granularityRaw as PanelGranularity,
  )
    ? (granularityRaw as PanelGranularity)
    : 'beat';

  const mergeRaw = (ruleValue(rules, 'merge') ?? '').toLowerCase();
  const mergeActions = mergeRaw.includes('action');

  return {
    granularity,
    mergeActions,
    shotDefault: asShot(ruleValue(rules, 'shot default'), 'MS'),
    shotForLine: asShot(ruleValue(rules, 'shot for line'), asShot(ruleValue(rules, 'shot default'), 'MS')),
    shotForAction: asShot(ruleValue(rules, 'shot for action'), asShot(ruleValue(rules, 'shot default'), 'WS')),
    shotForSound: asShot(ruleValue(rules, 'shot for sound'), 'INSERT'),
    ignore: ruleFlagSet(rules, 'ignore'),
    carry: ruleMap(rules, 'carry'),
    duration: {
      wordsPerSecond: ruleNumber(rules, 'words per second', DEFAULT_DURATION_OPTIONS.wordsPerSecond),
      defaultSeconds: settings.defaultShotSeconds || DEFAULT_DURATION_OPTIONS.defaultSeconds,
      minSeconds: ruleNumber(rules, 'min duration', DEFAULT_DURATION_OPTIONS.minSeconds),
      maxSeconds: ruleNumber(rules, 'max duration', DEFAULT_DURATION_OPTIONS.maxSeconds),
    },
    sceneAllowed: ruleSceneFilter(rules),
  };
}

interface BeatGroup {
  beats: DialogBeat[];
  /** The beat that decides the shot size for the group. */
  lead: DialogBeat;
}

function groupBeats(beats: DialogBeat[], config: DeriveConfig): BeatGroup[] {
  const kept = beats.filter((beat) => {
    if (config.ignore.has(beat.type)) return false;
    if (beat.type === 'direction' && config.ignore.has('camera')) return false;
    return true;
  });

  if (config.granularity === 'scene') {
    return kept.length > 0 ? [{ beats: kept, lead: kept[0]! }] : [];
  }

  const groups: BeatGroup[] = [];
  const anchorTypes: DialogBeat['type'][] =
    config.granularity === 'line' ? ['line'] : config.granularity === 'action' ? ['action'] : [];

  if (anchorTypes.length > 0) {
    // Non-anchor beats attach to the anchor that follows them, or to the last
    // anchor when they trail the scene, so nothing in the script is lost.
    let pending: DialogBeat[] = [];
    for (const beat of kept) {
      if (anchorTypes.includes(beat.type)) {
        groups.push({ beats: [...pending, beat], lead: beat });
        pending = [];
      } else {
        pending.push(beat);
      }
    }
    if (pending.length > 0) {
      const last = groups[groups.length - 1];
      if (last) last.beats.push(...pending);
      else groups.push({ beats: pending, lead: pending[0]! });
    }
    return groups;
  }

  for (const beat of kept) {
    const last = groups[groups.length - 1];
    const mergeable =
      config.mergeActions &&
      last !== undefined &&
      beat.type === 'action' &&
      last.lead.type === 'action';
    if (mergeable) last.beats.push(beat);
    else groups.push({ beats: [beat], lead: beat });
  }
  return groups;
}

function shotForGroup(group: BeatGroup, config: DeriveConfig): ShotSize {
  switch (group.lead.type) {
    case 'line':
      return config.shotForLine;
    case 'action':
      return config.shotForAction;
    case 'sound':
      return config.shotForSound;
    default:
      return config.shotDefault;
  }
}

function applyCarry(
  panel: StoryboardPanel,
  source: Record<string, string>,
  carry: Record<string, string>,
): void {
  const targets: Record<string, (value: string) => void> = {
    notes: (v) => {
      panel.notes = [panel.notes, v].filter(Boolean).join('\n');
    },
    sound: (v) => {
      panel.sound = [panel.sound, v].filter(Boolean).join('; ');
    },
    action: (v) => {
      panel.action = [panel.action, v].filter(Boolean).join(' ');
    },
    camera: (v) => {
      panel.camera = [panel.camera, v].filter(Boolean).join('; ');
    },
    dialog: (v) => {
      panel.dialog = [panel.dialog, v].filter(Boolean).join('\n');
    },
  };

  for (const [from, to] of Object.entries(carry)) {
    const value = source[from];
    if (!value) continue;
    const apply = targets[to];
    if (apply) apply(value);
  }
}

export interface DeriveResult {
  scenes: StoryboardScene[];
  /** Signature of the upstream data + rules that produced this. */
  signature: string;
  warnings: string[];
}

/**
 * Build board scenes from dialog. This is the whole point of the graph edge:
 * the rules text on the connection decides the breakdown, and the result is a
 * proposal the storyboard editor merges in without touching existing sketches.
 */
export function deriveBoardFromDialog(
  dialog: DialogFlowData,
  rulesText: string,
  settings: Pick<ProjectSettings, 'defaultShotSeconds'>,
): DeriveResult {
  const rules = parseRules(rulesText);
  const config = deriveConfigFromRules(rules, settings);
  const warnings: string[] = [];
  const scenes: StoryboardScene[] = [];

  dialog.scenes.forEach((scene, sceneIndex) => {
    if (!config.sceneAllowed(sceneIndex + 1)) return;
    const groups = groupBeats(scene.beats, config);
    if (groups.length === 0) {
      warnings.push(`Scene ${sceneIndex + 1} (${scene.slug}) has no beats to board.`);
      return;
    }

    const panels = groups.map((group) => {
      const dialogLines: string[] = [];
      const actionLines: string[] = [];
      const soundLines: string[] = [];
      const cameraLines: string[] = [];
      const noteLines: string[] = [];
      let seconds = 0;

      for (const beat of group.beats) {
        seconds += beatDuration(beat, config.duration);
        const cue = beat.sound?.trim();
        if (cue && !config.ignore.has('sound')) soundLines.push(cue);

        switch (beat.type) {
          case 'line': {
            const name = characterById(dialog, beat.characterId)?.name ?? 'UNASSIGNED';
            const parenthetical =
              beat.parenthetical?.trim() && !config.ignore.has('parenthetical')
                ? ` (${beat.parenthetical.trim()})`
                : '';
            dialogLines.push(`${name.toUpperCase()}${parenthetical}: ${beat.text.trim()}`);
            break;
          }
          case 'action':
            if (beat.text.trim()) actionLines.push(beat.text.trim());
            break;
          case 'sound':
            if (!cue && beat.text.trim()) soundLines.push(beat.text.trim());
            break;
          case 'direction':
            if (beat.text.trim()) cameraLines.push(beat.text.trim());
            break;
        }
      }

      const panel = newPanel({
        sourceSceneId: scene.id,
        sourceBeatIds: group.beats.map((b) => b.id),
        shot: shotForGroup(group, config),
        camera: cameraLines.join('; '),
        action: actionLines.join(' '),
        dialog: dialogLines.join('\n'),
        sound: soundLines.join('; '),
        durationSec:
          Math.round(
            Math.min(config.duration.maxSeconds, Math.max(config.duration.minSeconds, seconds)) * 10,
          ) / 10,
        notes: noteLines.join('\n'),
      });

      applyCarry(
        panel,
        {
          sound: soundLines.join('; '),
          dialog: dialogLines.join('\n'),
          action: actionLines.join(' '),
          camera: cameraLines.join('; '),
          summary: scene.summary,
        },
        config.carry,
      );

      return panel;
    });

    scenes.push({
      id: newId('sbs'),
      sourceSceneId: scene.id,
      title: `${sceneIndex + 1}. ${scene.slug}`,
      setName: setById(dialog, scene.setId)?.name ?? '',
      panels,
    });
  });

  return {
    scenes,
    signature: upstreamSignature(dialog, rulesText),
    warnings,
  };
}

/** Changes when either the dialog or the connection's rules change. */
export function upstreamSignature(dialog: DialogFlowData, rulesText: string): string {
  return hashValue({ dialog, rules: rulesText });
}

/* ------------------------------------------------------------------ *
 * Merging a derived board into the board you have been drawing on
 * ------------------------------------------------------------------ */

export type SyncChangeType = 'add' | 'update' | 'remove' | 'orphan' | 'unchanged' | 'pinned';

export interface SyncChange {
  type: SyncChangeType;
  sceneTitle: string;
  panelId: string;
  /** Short description of what the sync did, shown in the proposal list. */
  detail: string;
}

export interface SyncPlan {
  scenes: StoryboardScene[];
  changes: SyncChange[];
  counts: Record<SyncChangeType, number>;
  signature: string;
  warnings: string[];
}

const DERIVED_FIELDS = ['shot', 'camera', 'action', 'dialog', 'sound', 'durationSec'] as const;

function panelDiffers(existing: StoryboardPanel, derived: StoryboardPanel): string[] {
  return DERIVED_FIELDS.filter((f) => String(existing[f] ?? '') !== String(derived[f] ?? ''));
}

/**
 * Merge rules, in order of what matters most:
 * 1. Sketches are never lost. A panel whose beats disappeared upstream is kept
 *    and flagged as orphaned if it has artwork, and only dropped when empty.
 * 2. A panel you marked as pinned keeps its text.
 * 3. Panels you added by hand (no upstream beats) stay where they are.
 */
export function planSync(current: StoryboardScene[], derived: DeriveResult): SyncPlan {
  const changes: SyncChange[] = [];
  const counts: Record<SyncChangeType, number> = {
    add: 0,
    update: 0,
    remove: 0,
    orphan: 0,
    unchanged: 0,
    pinned: 0,
  };

  const record = (type: SyncChangeType, sceneTitle: string, panelId: string, detail: string) => {
    changes.push({ type, sceneTitle, panelId, detail });
    counts[type] += 1;
  };

  // Index every existing derived panel by the beats it covers.
  const byBeat = new Map<string, { panel: StoryboardPanel; sceneId: string }>();
  const handMade = new Map<string, StoryboardPanel[]>();
  for (const scene of current) {
    for (const panel of scene.panels) {
      if (panel.sourceBeatIds.length === 0) {
        const list = handMade.get(scene.sourceSceneId ?? scene.id) ?? [];
        list.push(panel);
        handMade.set(scene.sourceSceneId ?? scene.id, list);
        continue;
      }
      for (const beatId of panel.sourceBeatIds) {
        if (!byBeat.has(beatId)) byBeat.set(beatId, { panel, sceneId: scene.id });
      }
    }
  }

  const consumed = new Set<string>();
  const mergedScenes: StoryboardScene[] = derived.scenes.map((derivedScene) => {
    const existingScene = current.find(
      (s) => s.sourceSceneId && s.sourceSceneId === derivedScene.sourceSceneId,
    );

    const panels = derivedScene.panels.map((derivedPanel) => {
      const match = derivedPanel.sourceBeatIds
        .map((beatId) => byBeat.get(beatId))
        .find((hit) => hit !== undefined && !consumed.has(hit.panel.id));

      if (!match) {
        record('add', derivedScene.title, derivedPanel.id, `New panel: ${panelLabel(derivedPanel)}`);
        return derivedPanel;
      }

      consumed.add(match.panel.id);
      const existing = match.panel;

      if (existing.pinned) {
        record('pinned', derivedScene.title, existing.id, 'Pinned — text left alone.');
        return { ...existing, sourceBeatIds: derivedPanel.sourceBeatIds, sourceSceneId: derivedPanel.sourceSceneId };
      }

      const changed = panelDiffers(existing, derivedPanel);
      const merged: StoryboardPanel = {
        ...existing,
        sourceSceneId: derivedPanel.sourceSceneId,
        sourceBeatIds: derivedPanel.sourceBeatIds,
        shot: derivedPanel.shot,
        camera: derivedPanel.camera,
        action: derivedPanel.action,
        dialog: derivedPanel.dialog,
        sound: derivedPanel.sound,
        durationSec: derivedPanel.durationSec,
        // Notes and the sketch belong to the board, not to upstream.
        notes: existing.notes,
        sketch: existing.sketch,
      };

      if (changed.length === 0) {
        record('unchanged', derivedScene.title, existing.id, 'No change.');
      } else {
        record('update', derivedScene.title, existing.id, `Updated ${changed.join(', ')}.`);
      }
      return merged;
    });

    // Hand-made panels in this scene keep their place at the end of the scene.
    const extras = handMade.get(derivedScene.sourceSceneId ?? '') ?? [];
    for (const extra of extras) {
      consumed.add(extra.id);
      record('unchanged', derivedScene.title, extra.id, 'Hand-made panel kept.');
    }

    return {
      id: existingScene?.id ?? derivedScene.id,
      sourceSceneId: derivedScene.sourceSceneId,
      title: derivedScene.title,
      setName: derivedScene.setName || existingScene?.setName || '',
      panels: [...panels, ...extras],
    };
  });

  // Anything left over came from upstream but no longer has beats behind it.
  for (const scene of current) {
    const orphans = scene.panels.filter(
      (panel) => panel.sourceBeatIds.length > 0 && !consumed.has(panel.id),
    );
    const keep = orphans.filter((panel) => panel.sketch !== null || panel.pinned);
    for (const panel of orphans) {
      if (keep.includes(panel)) {
        record(
          'orphan',
          scene.title,
          panel.id,
          panel.pinned ? 'Pinned panel no longer in the script — kept.' : 'Sketch kept, source beat is gone.',
        );
      } else {
        record('remove', scene.title, panel.id, `Dropped: ${panelLabel(panel)}`);
      }
    }
    if (keep.length > 0) {
      mergedScenes.push({
        id: newId('sbs'),
        title: `${scene.title} (orphaned)`,
        setName: scene.setName,
        panels: keep.map((panel) => ({ ...panel, sourceBeatIds: [], pinned: true })),
      });
    }
  }

  return {
    scenes: mergedScenes,
    changes,
    counts,
    signature: derived.signature,
    warnings: derived.warnings,
  };
}

export function panelLabel(panel: StoryboardPanel): string {
  const text = panel.dialog || panel.action || panel.sound || panel.camera || 'empty panel';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/* ------------------------------------------------------------------ *
 * Board outputs
 * ------------------------------------------------------------------ */

export interface TimedPanel {
  sceneId: string;
  sceneTitle: string;
  panel: StoryboardPanel;
  index: number;
  startSec: number;
  endSec: number;
  startFrame: number;
  frames: number;
}

export function timePanels(
  scenes: StoryboardScene[],
  settings: Pick<ProjectSettings, 'fps' | 'defaultShotSeconds'>,
): TimedPanel[] {
  const fps = settings.fps > 0 ? settings.fps : 24;
  const out: TimedPanel[] = [];
  let cursor = 0;
  let index = 0;
  for (const scene of scenes) {
    for (const panel of scene.panels) {
      const duration = panel.durationSec > 0 ? panel.durationSec : settings.defaultShotSeconds || 2;
      const startFrame = Math.round(cursor * fps);
      const frames = Math.max(1, Math.round(duration * fps));
      out.push({
        sceneId: scene.id,
        sceneTitle: scene.title,
        panel,
        index,
        startSec: Math.round(cursor * 100) / 100,
        endSec: Math.round((cursor + duration) * 100) / 100,
        startFrame,
        frames,
      });
      cursor += duration;
      index += 1;
    }
  }
  return out;
}

export function boardDuration(
  scenes: StoryboardScene[],
  settings: Pick<ProjectSettings, 'fps' | 'defaultShotSeconds'>,
): number {
  const timed = timePanels(scenes, settings);
  const last = timed[timed.length - 1];
  return last ? last.endSec : 0;
}

function csvCell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The `shotlist.csv` artifact. */
export function formatShotlistCsv(
  scenes: StoryboardScene[],
  settings: Pick<ProjectSettings, 'fps' | 'defaultShotSeconds'>,
): string {
  const header = [
    'index',
    'scene',
    'shot',
    'start_sec',
    'duration_sec',
    'frames',
    'camera',
    'action',
    'dialog',
    'sound',
    'sketch',
    'notes',
  ];
  const rows = timePanels(scenes, settings).map((timed) =>
    [
      timed.index + 1,
      timed.sceneTitle,
      timed.panel.shot,
      timed.startSec,
      timed.panel.durationSec,
      timed.frames,
      timed.panel.camera,
      timed.panel.action,
      timed.panel.dialog.replace(/\n/g, ' / '),
      timed.panel.sound,
      timed.panel.sketch ? 'yes' : 'no',
      timed.panel.notes.replace(/\n/g, ' / '),
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

/** The `boards.md` artifact: the board as something you can read in a terminal. */
export function formatBoardsMarkdown(
  scenes: StoryboardScene[],
  settings: Pick<ProjectSettings, 'fps' | 'defaultShotSeconds'>,
): string {
  const lines: string[] = ['# Storyboard', ''];
  const timed = timePanels(scenes, settings);
  lines.push(`Total: ${boardDuration(scenes, settings).toFixed(1)}s across ${timed.length} panels.`, '');

  let currentScene = '';
  for (const entry of timed) {
    if (entry.sceneTitle !== currentScene) {
      currentScene = entry.sceneTitle;
      lines.push(`## ${currentScene}`, '');
    }
    lines.push(
      `### Panel ${entry.index + 1} — ${entry.panel.shot} — ${entry.startSec.toFixed(1)}s → ${entry.endSec.toFixed(1)}s`,
    );
    if (entry.panel.camera) lines.push(`- Camera: ${entry.panel.camera}`);
    if (entry.panel.action) lines.push(`- Action: ${entry.panel.action}`);
    if (entry.panel.dialog) {
      lines.push('- Dialog:');
      for (const line of entry.panel.dialog.split('\n')) lines.push(`  - ${line}`);
    }
    if (entry.panel.sound) lines.push(`- Sound: ${entry.panel.sound}`);
    if (entry.panel.notes) lines.push(`- Notes: ${entry.panel.notes.replace(/\n/g, ' / ')}`);
    lines.push(`- Sketch: ${entry.panel.sketch ? `${entry.panel.sketch.strokes.length} strokes` : 'none'}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The `storyboard.json` artifact, and the shape the animatic/edit flows read. */
export function storyboardPayload(
  scenes: StoryboardScene[],
  settings: Pick<ProjectSettings, 'fps' | 'width' | 'height' | 'defaultShotSeconds'>,
): Record<string, unknown> {
  const timed = timePanels(scenes, settings);
  return {
    fps: settings.fps,
    width: settings.width,
    height: settings.height,
    durationSec: boardDuration(scenes, settings),
    panelCount: timed.length,
    sketchedCount: timed.filter((t) => t.panel.sketch !== null).length,
    scenes: scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      setName: scene.setName,
      sourceSceneId: scene.sourceSceneId ?? null,
      panelIds: scene.panels.map((p) => p.id),
    })),
    panels: timed.map((timedPanel) => ({
      id: timedPanel.panel.id,
      index: timedPanel.index,
      scene: timedPanel.sceneTitle,
      shot: timedPanel.panel.shot,
      camera: timedPanel.panel.camera,
      action: timedPanel.panel.action,
      dialog: timedPanel.panel.dialog,
      sound: timedPanel.panel.sound,
      notes: timedPanel.panel.notes,
      startSec: timedPanel.startSec,
      endSec: timedPanel.endSec,
      startFrame: timedPanel.startFrame,
      frames: timedPanel.frames,
      durationSec: timedPanel.panel.durationSec,
      sourceBeatIds: timedPanel.panel.sourceBeatIds,
      sketch: timedPanel.panel.sketch
        ? { strokes: timedPanel.panel.sketch.strokes.length, width: timedPanel.panel.sketch.width, height: timedPanel.panel.sketch.height }
        : null,
      image: timedPanel.panel.sketch ? `panels/panel-${String(timedPanel.index + 1).padStart(3, '0')}.png` : null,
    })),
  };
}
