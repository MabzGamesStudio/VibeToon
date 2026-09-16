import path from 'node:path';
import { stat } from 'node:fs/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  ARTIFACT_KINDS,
  FLOW_CATEGORIES,
  FLOW_KINDS,
  RULE_DIRECTIVES,
  createStarterProject,
  createProject,
  nodeById,
  requireFlowKind,
  type ArtifactKind,
  type DictionaryProviders,
  type Project,
  type RegistryResponse,
  type StoryboardFlowData,
  type SyncResponse,
} from '@vibetoon/shared';
import { fetchCorpus } from './text/corpusFetch';
import {
  DEFAULT_LOOKUP_OPTIONS,
  activeProvider,
  hasDictionaryKey,
  lookupWords,
  DICTIONARY_URL_OVERRIDE,
} from './text/dictionary';
import { DICTIONARY_PROVIDERS, providerById } from './text/dictionaryProviders';
import { patchSettings } from './settings';
import { clearLogs, readLogFile, readLogs } from './logs';
import { hasFfmpeg } from './render/video';
import { assertSafeId, REPO_ROOT, resolveInProject } from './paths';
import { buildSyncPlan, syncSources } from './services/sync';
import { decodeAttachments, generateFlow, generateProject, type AttachmentInput } from './services/generate';
import {
  HttpError,
  createProjectOnDisk,
  deleteProject,
  listProjects,
  loadProject,
  removeFlowArtifacts,
  saveProject,
  saveProjectUnchecked,
  writeArtifact,
} from './storage';

const MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mid': 'audio/midi',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** `noUncheckedIndexedAccess` makes route params optional; a missing one is a 400. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `Missing ${name} in the request path.`);
  }
  return value;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** The provider list as the browser needs it: no keys, and why the active one won. */
function describeProviders(): DictionaryProviders {
  const active = activeProvider();
  return {
    providers: DICTIONARY_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      note: provider.note,
      needsKey: provider.needsKey,
      ...(provider.keyUrl ? { keyUrl: provider.keyUrl } : {}),
      available: !provider.needsKey || hasDictionaryKey(),
    })),
    activeId: active.provider.id,
    reason: active.reason,
    hasKey: hasDictionaryKey(),
    pinnedByEnvironment: DICTIONARY_URL_OVERRIDE.length > 0,
  };
}

export function createApp(): express.Express {
  const app = express();
  // Panel images are posted as base64 with the generate request, so the JSON
  // body limit has to be generous.
  app.use(express.json({ limit: '96mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ffmpeg: hasFfmpeg() });
  });

  app.get('/api/registry', (_req, res) => {
    const payload: RegistryResponse = {
      flowKinds: [...FLOW_KINDS],
      categories: [...FLOW_CATEGORIES],
      ruleDirectives: [...RULE_DIRECTIVES],
      artifactKinds: [...ARTIFACT_KINDS],
      ffmpeg: hasFfmpeg(),
    };
    res.json(payload);
  });

  /**
   * Fetch a corpus by URL. The browser cannot do this itself — the sites that
   * host public-domain books do not allow cross-origin reads — so the server
   * does it and hands back plain text for the editor to count.
   */
  app.post(
    '/api/text/corpus',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { url?: string };
      if (!body.url) throw new HttpError(400, 'No address to fetch.');
      res.json(await fetchCorpus(body.url));
    }),
  );

  /**
   * Look up word types and definitions, cached on disk between runs.
   *
   * One call is one batch: the caller says how many words it wants attempted,
   * and the answer says which ones were not got to, so a database of thousands
   * of words is worked through a few hundred at a time instead of in one
   * request the dictionary service would throttle.
   */
  app.post(
    '/api/text/dictionary',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { words?: string[]; limit?: number };
      const words = Array.isArray(body.words) ? body.words.slice(0, 2000) : [];
      if (words.length === 0) throw new HttpError(400, 'No words to look up.');
      const limit = Number.isFinite(body.limit)
        ? Math.max(1, Math.min(500, Math.floor(body.limit as number)))
        : DEFAULT_LOOKUP_OPTIONS.limit;
      res.json(await lookupWords(words, { limit }));
    }),
  );

  /** Which dictionary services exist, and which one is being asked. */
  app.get(
    '/api/text/dictionary/providers',
    asyncRoute(async (_req, res) => {
      res.json(describeProviders());
    }),
  );

  /** Point the studio at a different dictionary, and remember the choice. */
  app.post(
    '/api/text/dictionary/provider',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { id?: string };
      const provider = body.id ? providerById(body.id) : undefined;
      if (!provider) throw new HttpError(400, `No such dictionary: ${body.id ?? '(none)'}`);
      if (provider.needsKey && !hasDictionaryKey()) {
        throw new HttpError(
          400,
          `${provider.label} needs a key. Set VIBETOON_DICTIONARY_KEY and restart the server.`,
        );
      }
      await patchSettings({ dictionaryProvider: provider.id });
      res.json(describeProviders());
    }),
  );

  /**
   * What the studio has asked of the outside world: every dictionary lookup and
   * corpus download, with the status, the timing and the reason it failed. Held
   * in memory for the viewer and appended to a file so a server restart does not
   * throw away what you were reading.
   */
  app.get(
    '/api/logs',
    asyncRoute(async (req, res) => {
      const since = Number(req.query.since);
      const limit = Number(req.query.limit);
      const service = typeof req.query.service === 'string' ? req.query.service : undefined;
      res.json(
        readLogs({
          ...(Number.isFinite(since) ? { since } : {}),
          ...(Number.isFinite(limit) ? { limit } : {}),
          ...(service ? { service } : {}),
        }),
      );
    }),
  );

  /** What the file holds, including whatever a restart lost from memory. */
  app.get(
    '/api/logs/file',
    asyncRoute(async (req, res) => {
      const limit = Number(req.query.limit);
      res.json({ entries: await readLogFile(Number.isFinite(limit) ? limit : 300) });
    }),
  );

  app.delete(
    '/api/logs',
    asyncRoute(async (_req, res) => {
      clearLogs();
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/projects',
    asyncRoute(async (_req, res) => {
      res.json(await listProjects());
    }),
  );

  app.post(
    '/api/projects',
    asyncRoute(async (req, res) => {
      const body = req.body as { name?: string; template?: 'starter' | 'empty' };
      const name = (body.name ?? '').trim() || 'Untitled clip';
      const project = body.template === 'empty' ? createProject(name) : createStarterProject(name);
      res.status(201).json(await createProjectOnDisk(project));
    }),
  );

  app.get(
    '/api/projects/:id',
    asyncRoute(async (req, res) => {
      res.json(await loadProject(param(req, 'id')));
    }),
  );

  app.put(
    '/api/projects/:id',
    asyncRoute(async (req, res) => {
      const incoming = req.body as Project;
      if (!incoming || incoming.id !== param(req, 'id')) {
        throw new HttpError(400, 'Project id in the body does not match the URL.');
      }
      res.json(await saveProject(incoming));
    }),
  );

  app.delete(
    '/api/projects/:id',
    asyncRoute(async (req, res) => {
      await deleteProject(param(req, 'id'));
      res.status(204).end();
    }),
  );

  app.post(
    '/api/projects/:id/generate',
    asyncRoute(async (req, res) => {
      res.json(await generateProject(param(req, 'id')));
    }),
  );

  app.post(
    '/api/projects/:id/flows/:flowId/generate',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { attachments?: AttachmentInput[] };
      const attachments = decodeAttachments(body.attachments);
      res.json(await generateFlow(param(req, 'id'), param(req, 'flowId'), attachments));
    }),
  );

  /** The sync proposal for a storyboard flow: what pulling upstream in would do. */
  app.get(
    '/api/projects/:id/flows/:flowId/sync',
    asyncRoute(async (req, res) => {
      const project = await loadProject(param(req, 'id'));
      const node = nodeById(project, param(req, 'flowId'));
      if (!node) throw new HttpError(404, `No flow ${param(req, 'flowId')}`);
      const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
      const { plan, source } = buildSyncPlan(project, node, connectionId);
      const payload: SyncResponse = {
        plan,
        connectionId: source.connection.id,
        sourceFlowId: source.sourceNode.id,
        sourceFlowName: source.sourceNode.name,
      };
      res.json(payload);
    }),
  );

  /** Accept a sync: the proposal is recomputed server-side and written to the flow. */
  app.post(
    '/api/projects/:id/flows/:flowId/sync',
    asyncRoute(async (req, res) => {
      const project = await loadProject(param(req, 'id'));
      const node = nodeById(project, param(req, 'flowId'));
      if (!node) throw new HttpError(404, `No flow ${param(req, 'flowId')}`);
      if (node.data.editor !== 'storyboard') {
        throw new HttpError(400, 'Only storyboard flows can sync a board in.');
      }
      const body = (req.body ?? {}) as { connectionId?: string };
      const { plan, source } = buildSyncPlan(project, node, body.connectionId);
      const data: StoryboardFlowData = {
        ...(node.data as StoryboardFlowData),
        scenes: plan.scenes,
        syncSignature: plan.signature,
        syncedAt: new Date().toISOString(),
      };
      const updated: Project = {
        ...project,
        nodes: project.nodes.map((candidate) =>
          candidate.id === node.id ? { ...candidate, data } : candidate,
        ),
      };
      const saved = await saveProjectUnchecked(updated);
      const payload: SyncResponse & { project: Project } = {
        project: saved,
        plan,
        connectionId: source.connection.id,
        sourceFlowId: source.sourceNode.id,
        sourceFlowName: source.sourceNode.name,
      };
      res.json(payload);
    }),
  );

  /** Which connections a board could sync from. */
  app.get(
    '/api/projects/:id/flows/:flowId/sync-sources',
    asyncRoute(async (req, res) => {
      const project = await loadProject(param(req, 'id'));
      const node = nodeById(project, param(req, 'flowId'));
      if (!node) throw new HttpError(404, `No flow ${param(req, 'flowId')}`);
      res.json(
        syncSources(project, node).map((source) => ({
          connectionId: source.connection.id,
          sourceFlowId: source.sourceNode.id,
          sourceFlowName: source.sourceNode.name,
          mode: source.connection.settings.mode,
        })),
      );
    }),
  );

  /**
   * Upload a real file onto an output port. This is how image and audio ports
   * get filled on a machine with no model attached: make the file in any tool,
   * drop it on the port, and every downstream flow sees it with a hash.
   */
  app.post(
    '/api/projects/:id/flows/:flowId/outputs/:portId',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { fileName?: string; data?: string };
      if (!body.data) throw new HttpError(400, 'Nothing uploaded.');

      const project = await loadProject(param(req, 'id'));
      const node = nodeById(project, param(req, 'flowId'));
      if (!node) throw new HttpError(404, `No flow ${param(req, 'flowId')}`);
      const def = requireFlowKind(node.kind);
      const port = def.outputs.find((candidate) => candidate.id === param(req, 'portId'));
      if (!port) throw new HttpError(404, `No output port ${param(req, 'portId')} on ${def.label}`);

      const kind: ArtifactKind = port.kinds[0]!;
      const fileName = path.basename(body.fileName ?? port.fileName ?? `${port.id}.bin`);
      if (fileName.startsWith('.')) throw new HttpError(400, 'Invalid file name.');

      const comma = body.data.indexOf(',');
      const base64 = body.data.startsWith('data:') && comma >= 0 ? body.data.slice(comma + 1) : body.data;
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));

      const artifact = await writeArtifact({
        projectId: project.id,
        flowId: node.id,
        port: port.id,
        kind,
        fileName,
        content: bytes,
      });

      const updated: Project = {
        ...project,
        nodes: project.nodes.map((candidate) =>
          candidate.id === node.id
            ? {
                ...candidate,
                outputs: [...candidate.outputs.filter((ref) => ref.port !== port.id), artifact],
              }
            : candidate,
        ),
      };
      res.json({ project: await saveProjectUnchecked(updated), artifact });
    }),
  );

  app.delete(
    '/api/projects/:id/flows/:flowId/artifacts',
    asyncRoute(async (req, res) => {
      const project = await loadProject(param(req, 'id'));
      const node = nodeById(project, param(req, 'flowId'));
      if (!node) throw new HttpError(404, `No flow ${param(req, 'flowId')}`);
      await removeFlowArtifacts(project.id, node.id);
      const updated: Project = {
        ...project,
        nodes: project.nodes.map((candidate) =>
          candidate.id === node.id ? { ...candidate, outputs: [], lastRun: undefined } : candidate,
        ),
      };
      res.json(await saveProjectUnchecked(updated));
    }),
  );

  /** Serve artifact bytes straight out of the project folder. */
  app.get(
    '/api/projects/:id/files/*',
    asyncRoute(async (req, res) => {
      assertSafeId(param(req, 'id'), 'project id');
      const relative = (req.params as Record<string, string>)[0] ?? '';
      const absolute = resolveInProject(param(req, 'id'), relative);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) throw new HttpError(404, `No file ${relative}`);
      res.type(MIME[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream');
      res.sendFile(absolute);
    }),
  );

  // In a production build the client is served from the same origin; in dev the
  // Vite server proxies /api here instead.
  const clientDist = path.join(REPO_ROOT, 'packages', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res, next) => {
    res.sendFile(path.join(clientDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message, details: error.extra });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Path-escape and id validation failures are client errors, not crashes.
    const status = /Invalid |escapes the/.test(message) ? 400 : 500;
    if (status === 500) console.error('[vibetoon]', error);
    res.status(status).json({ error: message });
  });

  return app;
}
