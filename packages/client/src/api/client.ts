import type {
  ArtifactRef,
  WordMeaning,
  GenerateResponse,
  Project,
  ProjectSummary,
  RegistryResponse,
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
  clearArtifacts: (id: string, flowId: string) =>
    request<Project>('DELETE', `/api/projects/${id}/flows/${flowId}/artifacts`),

  fetchCorpus: (url: string) =>
    request<{ name: string; text: string; bytes: number; truncated: boolean; url: string }>(
      'POST',
      '/api/text/corpus',
      { url },
    ),
  lookupWords: (words: string[]) =>
    request<{
      meanings: Record<string, WordMeaning>;
      found: string[];
      missing: string[];
      failed: string[];
      unreachable?: string;
      cached: number;
    }>('POST', '/api/text/dictionary', { words }),

  artifactUrl: (projectId: string, artifactPath: string) =>
    `/api/projects/${projectId}/files/${artifactPath}`,
  artifactText: async (projectId: string, artifactPath: string) => {
    const response = await fetch(`/api/projects/${projectId}/files/${artifactPath}`);
    if (!response.ok) throw new ApiError(response.status, `Could not read ${artifactPath}`);
    return response.text();
  },
};
