import { newId } from '../ids';
import type {
  DialogBeat,
  DialogCharacter,
  DialogFlowData,
  DialogScene,
  DialogSet,
} from '../types/project';

export const BEAT_TYPE_LABEL: Record<DialogBeat['type'], string> = {
  line: 'Dialog',
  action: 'Action',
  sound: 'Sound',
  direction: 'Camera',
};

export const CHARACTER_COLORS = [
  '#e8705a',
  '#5ab0e8',
  '#f0b23f',
  '#7bc96f',
  '#b98ce8',
  '#e88cc0',
  '#4fc4b0',
  '#d1d15a',
];

export function emptyDialogData(): DialogFlowData {
  return { editor: 'dialog', logline: '', characters: [], sets: [], scenes: [] };
}

export function newCharacter(index: number): DialogCharacter {
  return {
    id: newId('chr'),
    name: `Character ${index + 1}`,
    personality: '',
    voice: '',
    color: CHARACTER_COLORS[index % CHARACTER_COLORS.length]!,
  };
}

export function newSet(index: number): DialogSet {
  return { id: newId('set'), name: `Set ${index + 1}`, description: '', timeOfDay: '' };
}

export function newBeat(type: DialogBeat['type'] = 'line'): DialogBeat {
  return { id: newId('bt'), type, text: '' };
}

export function newScene(): DialogScene {
  return {
    id: newId('scn'),
    slug: 'INT. LOCATION - DAY',
    summary: '',
    beats: [newBeat('action')],
  };
}

export function characterById(
  data: DialogFlowData,
  id: string | undefined,
): DialogCharacter | undefined {
  if (!id) return undefined;
  return data.characters.find((c) => c.id === id);
}

export function setById(data: DialogFlowData, id: string | undefined): DialogSet | undefined {
  if (!id) return undefined;
  return data.sets.find((s) => s.id === id);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export interface DurationOptions {
  wordsPerSecond: number;
  defaultSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_DURATION_OPTIONS: DurationOptions = {
  wordsPerSecond: 2.6,
  defaultSeconds: 2,
  minSeconds: 0.8,
  maxSeconds: 8,
};

/**
 * An explicit duration on the beat always wins. Otherwise a dialog beat is
 * timed from its word count and everything else gets the default, then the
 * result is clamped.
 */
export function beatDuration(beat: DialogBeat, options: DurationOptions): number {
  const raw =
    beat.durationSec && beat.durationSec > 0
      ? beat.durationSec
      : beat.type === 'line'
        ? countWords(beat.text) / Math.max(0.1, options.wordsPerSecond)
        : options.defaultSeconds;
  const clamped = Math.min(options.maxSeconds, Math.max(options.minSeconds, raw));
  return Math.round(clamped * 10) / 10;
}

export function sceneDuration(scene: DialogScene, options: DurationOptions): number {
  const total = scene.beats.reduce((sum, beat) => sum + beatDuration(beat, options), 0);
  return Math.round(total * 10) / 10;
}

export function dialogDuration(data: DialogFlowData, options: DurationOptions): number {
  const total = data.scenes.reduce((sum, scene) => sum + sceneDuration(scene, options), 0);
  return Math.round(total * 10) / 10;
}

function upper(value: string): string {
  return value.trim().toUpperCase();
}

/** The `dialog.txt` artifact: readable on its own, stable enough to diff. */
export function formatDialogText(data: DialogFlowData, title: string): string {
  const lines: string[] = [];
  lines.push(upper(title) || 'UNTITLED');
  lines.push('='.repeat(Math.max(8, (title || 'untitled').length)));
  if (data.logline.trim()) {
    lines.push('');
    lines.push(`Logline: ${data.logline.trim()}`);
  }

  if (data.characters.length > 0) {
    lines.push('');
    lines.push('CHARACTERS');
    for (const character of data.characters) {
      const bits = [character.personality.trim(), character.voice.trim() ? `voice: ${character.voice.trim()}` : '']
        .filter(Boolean)
        .join(' — ');
      lines.push(`  ${upper(character.name)}${bits ? ` — ${bits}` : ''}`);
    }
  }

  if (data.sets.length > 0) {
    lines.push('');
    lines.push('SETS');
    for (const set of data.sets) {
      const bits = [set.description.trim(), set.timeOfDay.trim()].filter(Boolean).join(' — ');
      lines.push(`  ${set.name}${bits ? ` — ${bits}` : ''}`);
    }
  }

  data.scenes.forEach((scene, index) => {
    lines.push('');
    lines.push(`SCENE ${index + 1} — ${upper(scene.slug)}`);
    const set = setById(data, scene.setId);
    if (set) {
      lines.push(`  Set: ${set.name}${set.timeOfDay ? ` (${set.timeOfDay})` : ''}`);
    }
    if (scene.summary.trim()) lines.push(`  Summary: ${scene.summary.trim()}`);
    lines.push('');

    for (const beat of scene.beats) {
      switch (beat.type) {
        case 'line': {
          const character = characterById(data, beat.characterId);
          lines.push(`  ${upper(character?.name ?? 'UNASSIGNED')}`);
          if (beat.parenthetical?.trim()) lines.push(`    (${beat.parenthetical.trim()})`);
          lines.push(`    ${beat.text.trim() || '...'}`);
          if (beat.sound?.trim()) lines.push(`    SFX: ${beat.sound.trim()}`);
          lines.push('');
          break;
        }
        case 'action': {
          lines.push(`  ${beat.text.trim()}`);
          if (beat.sound?.trim()) lines.push(`  SFX: ${beat.sound.trim()}`);
          lines.push('');
          break;
        }
        case 'sound': {
          lines.push(`  SFX: ${beat.sound?.trim() || beat.text.trim()}`);
          lines.push('');
          break;
        }
        case 'direction': {
          lines.push(`  CAMERA: ${beat.text.trim()}`);
          lines.push('');
          break;
        }
      }
    }
  });

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The `soundcues.txt` artifact: every cue in script order, for the sound flows. */
export function formatSoundCues(data: DialogFlowData): string {
  const lines: string[] = ['SOUND CUES', ''];
  let count = 0;
  data.scenes.forEach((scene, sceneIndex) => {
    scene.beats.forEach((beat, beatIndex) => {
      const cue = beat.type === 'sound' ? beat.sound?.trim() || beat.text.trim() : beat.sound?.trim();
      if (!cue) return;
      count += 1;
      lines.push(`${sceneIndex + 1}.${beatIndex + 1}\t${cue}\t(${scene.slug})`);
    });
  });
  if (count === 0) lines.push('(no cues yet)');
  return `${lines.join('\n')}\n`;
}

/** The `scenes.json` artifact: the structured form downstream flows read. */
export function dialogScenesPayload(
  data: DialogFlowData,
  options: DurationOptions,
): Record<string, unknown> {
  return {
    logline: data.logline,
    characters: data.characters.map((c) => ({
      id: c.id,
      name: c.name,
      personality: c.personality,
      voice: c.voice,
    })),
    sets: data.sets,
    scenes: data.scenes.map((scene, index) => ({
      id: scene.id,
      number: index + 1,
      slug: scene.slug,
      set: setById(data, scene.setId)?.name ?? null,
      summary: scene.summary,
      durationSec: sceneDuration(scene, options),
      beats: scene.beats.map((beat) => ({
        id: beat.id,
        type: beat.type,
        character: characterById(data, beat.characterId)?.name ?? null,
        parenthetical: beat.parenthetical ?? null,
        text: beat.text,
        sound: beat.sound ?? null,
        durationSec: beatDuration(beat, options),
      })),
    })),
    totalDurationSec: dialogDuration(data, options),
  };
}
