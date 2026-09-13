import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  hashString,
  isTextualArtifact,
  type ArtifactKind,
  type ArtifactRef,
  type Project,
  type ProjectSummary,
} from '@vibetoon/shared';
import {
  artifactsDir,
  assertSafeId,
  ensureDir,
  flowArtifactsDir,
  projectDir,
  projectFile,
  PROJECTS_ROOT,
  resolveInProject,
} from './paths';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** One write at a time per project, so two saves cannot interleave. */
const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeLocks.set(
    projectId,
    next.catch(() => undefined),
  );
  return next;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureDir(PROJECTS_ROOT);
  const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
  const summaries: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await loadProject(entry.name);
      summaries.push({
        id: project.id,
        name: project.name,
        revision: project.revision,
        updatedAt: project.updatedAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
      });
    } catch {
      // A directory that is not a readable project is skipped rather than
      // breaking the whole listing.
    }
  }
  return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function loadProject(projectId: string): Promise<Project> {
  assertSafeId(projectId, 'project id');
  const file = projectFile(projectId);
  if (!(await exists(file))) throw new HttpError(404, `No project ${projectId}`);
  const raw = await readFile(file, 'utf8');
  const project = JSON.parse(raw) as Project;
  if (project.schema !== 1) {
    throw new HttpError(500, `Project ${projectId} uses schema ${project.schema}, this build reads 1.`);
  }
  return project;
}

async function writeProjectFile(project: Project): Promise<void> {
  await ensureDir(projectDir(project.id));
  const target = projectFile(project.id);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function createProjectOnDisk(project: Project): Promise<Project> {
  assertSafeId(project.id, 'project id');
  if (await exists(projectFile(project.id))) {
    throw new HttpError(409, `Project ${project.id} already exists`);
  }
  return withLock(project.id, async () => {
    await ensureDir(artifactsDir(project.id));
    await writeProjectFile(project);
    return project;
  });
}

/**
 * Save with optimistic concurrency: the incoming revision has to match what is
 * on disk, which stops a stale editor tab from overwriting newer work.
 */
export async function saveProject(incoming: Project): Promise<Project> {
  assertSafeId(incoming.id, 'project id');
  return withLock(incoming.id, async () => {
    const current = await loadProject(incoming.id);
    if (incoming.revision !== current.revision) {
      throw new HttpError(409, 'The project changed since you loaded it.', {
        expectedRevision: current.revision,
        yourRevision: incoming.revision,
      });
    }
    const next: Project = {
      ...incoming,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writeProjectFile(next);
    return next;
  });
}

/** Save without a revision check. Used by generation, which loads-then-writes under the lock. */
export async function saveProjectUnchecked(project: Project): Promise<Project> {
  return withLock(project.id, async () => {
    const next: Project = {
      ...project,
      revision: project.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeProjectFile(next);
    return next;
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  assertSafeId(projectId, 'project id');
  await withLock(projectId, async () => {
    await rm(projectDir(projectId), { recursive: true, force: true });
  });
}

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export interface WriteArtifactInput {
  projectId: string;
  flowId: string;
  port: string;
  kind: ArtifactKind;
  fileName: string;
  /** Text content, or bytes for images and audio. */
  content: string | Uint8Array;
}

const PREVIEW_LIMIT = 4000;

export async function writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef> {
  assertSafeId(input.projectId, 'project id');
  assertSafeId(input.flowId, 'flow id');
  const dir = flowArtifactsDir(input.projectId, input.flowId);
  await ensureDir(dir);

  const target = resolveInProject(
    input.projectId,
    path.join('artifacts', input.flowId, input.fileName),
  );
  await ensureDir(path.dirname(target));

  const isText = typeof input.content === 'string';
  await writeFile(target, isText ? (input.content as string) : Buffer.from(input.content as Uint8Array));

  const bytes = isText ? Buffer.byteLength(input.content as string) : (input.content as Uint8Array).byteLength;
  const hash = isText
    ? hashString(input.content as string)
    : hashString(Buffer.from(input.content as Uint8Array).toString('base64'));

  const ref: ArtifactRef = {
    port: input.port,
    kind: input.kind,
    fileName: input.fileName,
    path: path.posix.join('artifacts', input.flowId, ...input.fileName.split(path.sep)),
    hash,
    bytes,
    generatedAt: new Date().toISOString(),
  };
  if (isText && isTextualArtifact(input.kind)) {
    const text = input.content as string;
    ref.preview = text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n...` : text;
  }
  return ref;
}

/** Write a folder-shaped artifact (`imageSet` / `audioSet`) and record its entries. */
export async function writeArtifactSet(input: {
  projectId: string;
  flowId: string;
  port: string;
  kind: ArtifactKind;
  dirName: string;
  files: Array<{ name: string; content: Uint8Array | string }>;
}): Promise<ArtifactRef> {
  assertSafeId(input.projectId, 'project id');
  assertSafeId(input.flowId, 'flow id');
  const relativeDir = path.posix.join('artifacts', input.flowId, input.dirName);
  const absoluteDir = resolveInProject(input.projectId, relativeDir);
  await rm(absoluteDir, { recursive: true, force: true });
  await ensureDir(absoluteDir);

  let bytes = 0;
  const parts: string[] = [];
  const entries: string[] = [];
  for (const file of input.files) {
    if (path.basename(file.name) !== file.name) {
      throw new HttpError(400, `Artifact set entries cannot contain paths: ${file.name}`);
    }
    const buffer =
      typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
    await writeFile(path.join(absoluteDir, file.name), buffer);
    bytes += buffer.byteLength;
    parts.push(`${file.name}:${buffer.byteLength}`);
    entries.push(file.name);
  }

  return {
    port: input.port,
    kind: input.kind,
    fileName: input.dirName,
    path: relativeDir,
    hash: hashString(parts.join('|')),
    bytes,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

export async function readArtifactText(projectId: string, relativePath: string): Promise<string> {
  const target = resolveInProject(projectId, relativePath);
  return readFile(target, 'utf8');
}

export async function artifactExists(projectId: string, relativePath: string): Promise<boolean> {
  try {
    return await exists(resolveInProject(projectId, relativePath));
  } catch {
    return false;
  }
}

export async function listArtifactSet(projectId: string, relativePath: string): Promise<string[]> {
  const target = resolveInProject(projectId, relativePath);
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

export async function removeFlowArtifacts(projectId: string, flowId: string): Promise<void> {
  assertSafeId(projectId, 'project id');
  assertSafeId(flowId, 'flow id');
  await rm(flowArtifactsDir(projectId, flowId), { recursive: true, force: true });
}
