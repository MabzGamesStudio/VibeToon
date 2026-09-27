import type {
  ApiLogEntry,
  ApiLogPage,
  ArtifactRef,
  DictionaryProviders,
  DictionaryResult,
  MorphologyStatus,
  GenerateResponse,
  Project,
  ProjectSummary,
  RegistryResponse,
  SliderRangeOverrides,
  SyncResponse,
} from '@vibetoon/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${method} ${url} failed (${response.status})`;
    let details: Record<string, unknown> | undefined;
    try {
      const payload = (await response.json()) as { error?: string; details?: Record<string, unknown> };
      if (payload.error) message = payload.error;
      details = payload.details;
    } catch {
      // Keep the generic message when the body is not JSON.
    }
    throw new ApiError(response.status, message, details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface AttachmentPayload {
  name: string;
  data: string;
}

export const api = {
  registry: () => request<RegistryResponse>('GET', '/api/registry'),
  listProjects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (name: string, template: 'starter' | 'empty' = 'starter') =>
    request<Project>('POST', '/api/projects', { name, template }),
  getProject: (id: string) => request<Project>('GET', `/api/projects/${id}`),
  saveProject: (project: Project) => request<Project>('PUT', `/api/projects/${project.id}`, project),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),

  generateProject: (id: string) => request<GenerateResponse>('POST', `/api/projects/${id}/generate`),
  generateFlow: (id: string, flowId: string, attachments: AttachmentPayload[] = []) =>
    request<GenerateResponse>('POST', `/api/projects/${id}/flows/${flowId}/generate`, { attachments }),

  syncPreview: (id: string, flowId: string, connectionId?: string) =>
    request<SyncResponse>(
      'GET',
      `/api/projects/${id}/flows/${flowId}/sync${connectionId ? `?connectionId=${connectionId}` : ''}`,
    ),
  syncAccept: (id: string, flowId: string, connectionId?: string) =>
    request<SyncResponse & { project: Project }>('POST', `/api/projects/${id}/flows/${flowId}/sync`, {
      connectionId,
    }),
  syncSources: (id: string, flowId: string) =>
    request<Array<{ connectionId: string; sourceFlowId: string; sourceFlowName: string; mode: string }>>(
      'GET',
      `/api/projects/${id}/flows/${flowId}/sync-sources`,
    ),

  uploadOutput: (id: string, flowId: string, portId: string, fileName: string, data: string) =>
    request<{ project: Project; artifact: ArtifactRef }>(
      'POST',
      `/api/projects/${id}/flows/${flowId}/outputs/${portId}`,
      { fileName, data },
    ),
  /**
   * Fetch an image onto an output port. The server does the download because a
   * site that serves an image usually refuses a cross-origin read of its bytes,
   * and because the bytes have to be written where the project keeps them.
   */
  fetchOutput: (id: string, flowId: string, portId: string, url: string) =>
    request<{
      project: Project;
      artifact: ArtifactRef;
      source: { url: string; contentType: string; bytes: number };
    }>('POST', `/api/projects/${id}/flows/${flowId}/outputs/${portId}/fetch`, { url }),

  clearArtifacts: (id: string, flowId: string) =>
    request<Project>('DELETE', `/api/projects/${id}/flows/${flowId}/artifacts`),

  fetchCorpus: (url: string) =>
    request<{ name: string; text: string; bytes: number; truncated: boolean; url: string }>(
      'POST',
      '/api/text/corpus',
      { url },
    ),
  /** One batch of a dictionary lookup. `remaining` says what to ask for next. */
  lookupWords: (words: string[], limit?: number, provider?: string, morphology?: string) =>
    request<DictionaryResult>('POST', '/api/text/dictionary', {
      words,
      ...(limit === undefined ? {} : { limit }),
      ...(provider ? { provider } : {}),
      ...(morphology ? { morphology } : {}),
    }),

  sliderRanges: () => request<{ overrides: SliderRangeOverrides }>('GET', '/api/settings/slider-ranges'),
  saveSliderRanges: (overrides: SliderRangeOverrides) =>
    request<{ overrides: SliderRangeOverrides }>('PUT', '/api/settings/slider-ranges', { overrides }),
  dictionaryProviders: () => request<DictionaryProviders>('GET', '/api/text/dictionary/providers'),
  setDictionaryKey: (id: string, key: string) =>
    request<DictionaryProviders>('POST', '/api/text/dictionary/key', { id, key }),
  setDictionaryProvider: (id: string) =>
    request<DictionaryProviders>('POST', '/api/text/dictionary/provider', { id }),

  /** Which forms datasets exist, and whether the active one is indexed here. */
  morphology: (source?: string) =>
    request<MorphologyStatus>(
      'GET',
      `/api/text/morphology${source ? `?source=${encodeURIComponent(source)}` : ''}`,
    ),
  /** Download and index the dataset. Seconds, once, and then it answers from disk. */
  buildMorphology: (id?: string) =>
    request<MorphologyStatus & { built: { meta: { paradigms: number; spellings: number; skipped: number }; bytes: number; ms: number } }>(
      'POST',
      '/api/text/morphology/build',
      id ? { id } : {},
    ),
  setMorphologySource: (id: string) =>
    request<MorphologyStatus>('POST', '/api/text/morphology/source', { id }),

  /** Calls the studio has made to the outside world. `since` asks for new ones only. */
  logs: (options: { since?: number; service?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.since !== undefined) query.set('since', String(options.since));
    if (options.service) query.set('service', options.service);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.toString();
    return request<ApiLogPage>('GET', `/api/logs${suffix ? `?${suffix}` : ''}`);
  },
  logFile: (limit = 300) => request<{ entries: ApiLogEntry[] }>('GET', `/api/logs/file?limit=${limit}`),
  clearLogs: () => request<{ ok: boolean }>('DELETE', '/api/logs'),

  artifactUrl: (projectId: string, artifactPath: string) =>
    `/api/projects/${projectId}/files/${artifactPath}`,
  artifactText: async (projectId: string, artifactPath: string) => {
    const response = await fetch(`/api/projects/${projectId}/files/${artifactPath}`);
    if (!response.ok) throw new ApiError(response.status, `Could not read ${artifactPath}`);
    return response.text();
  },
};
