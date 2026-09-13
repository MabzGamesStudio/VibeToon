import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, i.e. two packages up from `packages/server/src`. */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

/**
 * Everything a project owns lives under one directory so a project is a folder
 * you can copy, zip or put in git. Override with VIBETOON_DATA.
 */
export const DATA_ROOT = process.env.VIBETOON_DATA
  ? path.resolve(process.env.VIBETOON_DATA)
  : path.join(REPO_ROOT, 'data');

export const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects');

export function projectDir(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId);
}

export function projectFile(projectId: string): string {
  return path.join(projectDir(projectId), 'project.json');
}

export function artifactsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'artifacts');
}

export function flowArtifactsDir(projectId: string, flowId: string): string {
  return path.join(artifactsDir(projectId), flowId);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Resolve a project-relative artifact path, refusing anything that climbs out
 * of the project directory.
 */
export function resolveInProject(projectId: string, relative: string): string {
  const root = projectDir(projectId);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the project directory: ${relative}`);
  }
  return resolved;
}

/** Project and flow ids come from the client, so keep them to safe characters. */
export function assertSafeId(id: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`Invalid ${label}: ${id}`);
  }
}
