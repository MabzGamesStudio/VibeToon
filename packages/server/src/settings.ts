import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SliderRangeOverrides } from '@vibetoon/shared';
import { DATA_ROOT } from './paths';

/**
 * Settings that belong to this installation rather than to a project: which
 * dictionary to ask, and how far each slider reaches. A project is a folder you can
 * copy to another machine, and the dictionary you happen to have a key for
 * should not travel with it.
 *
 * A key itself is never stored here. It comes from the environment, where a
 * secret belongs, and is never written to disk or handed to the browser.
 */
export interface Settings {
  dictionaryProvider?: string;
  /** Which morphology dataset the forms of a word come from. No key needed. */
  morphologySource?: string;
  /**
   * A key per dictionary service, entered in the studio.
   *
   * These live here rather than in a project because a project is a folder you
   * copy, zip and put in git, and a key must not travel with it. `data/` is
   * gitignored for the same reason. They are stored in plain text on this
   * machine, exactly as a `.env` would be, and are never sent to the browser,
   * written into an artifact, or recorded in the API log.
   */
  dictionaryKeys?: Record<string, string>;
  /**
   * The ends of the studio's sliders, where they have been changed from the
   * defaults. Keyed by slider (see `SLIDER_RANGES`); nothing secret, and the
   * only part of this file the browser is ever sent.
   */
  sliderRanges?: SliderRangeOverrides;
}

const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');

function load(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

let settings: Settings = load();

export function getSettings(): Settings {
  return settings;
}

export async function patchSettings(change: Settings): Promise<Settings> {
  settings = { ...settings, ...change };
  await save();
  return settings;
}

async function save(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  // 0600: a file holding API keys should not be world-readable on a shared box.
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** The key stored for a service, or nothing. Never leaves the server. */
export function dictionaryKeyFor(providerId: string): string {
  return settings.dictionaryKeys?.[providerId] ?? '';
}

/** Store a key for a service, or clear it by passing an empty string. */
export async function setDictionaryKey(providerId: string, key: string): Promise<void> {
  const keys = { ...settings.dictionaryKeys };
  if (key.trim()) keys[providerId] = key.trim();
  else delete keys[providerId];
  settings = { ...settings, dictionaryKeys: keys };
  await save();
}
