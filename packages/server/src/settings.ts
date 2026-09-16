import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT } from './paths';

/**
 * Settings that belong to this installation rather than to a project: which
 * dictionary to ask, and nothing else so far. A project is a folder you can
 * copy to another machine, and the dictionary you happen to have a key for
 * should not travel with it.
 *
 * A key itself is never stored here. It comes from the environment, where a
 * secret belongs, and is never written to disk or handed to the browser.
 */
export interface Settings {
  dictionaryProvider?: string;
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
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}
