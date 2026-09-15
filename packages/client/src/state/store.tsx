import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createConnection,
  createNode,
  defaultRulesForConnection,
  validateConnection,
  type Connection,
  type FlowData,
  type FlowNode,
  type GenerationRun,
  type PortRef,
  type Project,
  type ProjectSummary,
  type RegistryResponse,
  type Vec2,
} from '@vibetoon/shared';
import { api, ApiError, type AttachmentPayload } from '../api/client';

const AUTOSAVE_DELAY_MS = 700;
const LAST_PROJECT_KEY = 'vibetoon.lastProject';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'error';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export type Selection =
  | { type: 'none' }
  | { type: 'node'; id: string }
  | { type: 'connection'; id: string };

interface StudioValue {
  registry: RegistryResponse | null;
  projects: ProjectSummary[];
  project: Project | null;
  loading: boolean;
  saveState: SaveState;
  runs: Record<string, GenerationRun>;
  busyFlows: string[];
  toasts: Toast[];
  selection: Selection;
  /** Flow the editor view is focused on, or null for the graph overview. */
  focusedFlowId: string | null;

  notify(kind: Toast['kind'], message: string): void;
  dismissToast(id: number): void;

  refreshProjects(): Promise<void>;
  openProject(id: string): Promise<void>;
  newProject(name: string, template?: 'starter' | 'empty'): Promise<void>;
  removeProject(id: string): Promise<void>;
  closeProject(): void;

  update(mutate: (draft: Project) => void): void;
  patchNode(nodeId: string, patch: Partial<FlowNode>): void;
  setFlowData(nodeId: string, data: FlowData): void;
  addNode(kind: string, position: Vec2): FlowNode | null;
  removeNode(nodeId: string): void;
  connect(from: PortRef, to: PortRef): boolean;
  patchConnection(connectionId: string, patch: Partial<Connection>): void;
  removeConnection(connectionId: string): void;

  select(selection: Selection): void;
  focusFlow(nodeId: string | null): void;

  generateFlow(nodeId: string, attachments?: AttachmentPayload[]): Promise<GenerationRun | null>;
  generateAll(): Promise<void>;
  acceptSync(nodeId: string, connectionId?: string): Promise<void>;
  uploadOutput(nodeId: string, portId: string, fileName: string, data: string): Promise<void>;
  clearArtifacts(nodeId: string): Promise<void>;
  flushSave(): Promise<void>;
}

const StudioContext = createContext<StudioValue | null>(null);

export function useStudio(): StudioValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error('useStudio must be used inside <StudioProvider>');
  return value;
}

export function useProject(): Project {
  const { project } = useStudio();
  if (!project) throw new Error('No project is open');
  return project;
}

export function StudioProvider({ children }: { children: ReactNode }): JSX.Element {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [runs, setRuns] = useState<Record<string, GenerationRun>>({});
  const [busyFlows, setBusyFlows] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selection, setSelection] = useState<Selection>({ type: 'none' });
  const [focusedFlowId, setFocusedFlowId] = useState<string | null>(null);

  // The live project is kept in a ref as well, so save and generate always read
  // the newest state without being re-created on every keystroke.
  const projectRef = useRef<Project | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef(0);

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = (toastId.current += 1);
    setToasts((current) => [...current, { id, kind, message }]);
    const ttl = kind === 'error' ? 9000 : 4500;
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), ttl);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const applyProject = useCallback((next: Project | null) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  /* ---------------- saving ---------------- */

  const saveNow = useCallback(async (): Promise<void> => {
    const current = projectRef.current;
    if (!current) return;
    dirtyRef.current = false;
    setSaveState('saving');
    try {
      const saved = await api.saveProject(current);
      // Adopt the server's revision; keep local edits made while saving.
      const live = projectRef.current;
      if (live && dirtyRef.current) {
        applyProject({ ...live, revision: saved.revision, updatedAt: saved.updatedAt });
        setSaveState('dirty');
      } else {
        applyProject(saved);
        setSaveState('clean');
      }
      setProjects((list) =>
        list.map((summary) =>
          summary.id === saved.id
            ? { ...summary, revision: saved.revision, updatedAt: saved.updatedAt, name: saved.name }
            : summary,
        ),
      );
    } catch (error) {
      setSaveState('error');
      if (error instanceof ApiError && error.status === 409) {
        notify('error', 'This project changed elsewhere. Reloading the saved version.');
        const fresh = await api.getProject(current.id);
        applyProject(fresh);
        setSaveState('clean');
        return;
      }
      notify('error', `Could not save: ${(error as Error).message}`);
    }
  }, [applyProject, notify]);

  const flushSave = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return;
    const run = saveNow();
    savingRef.current = run.finally(() => {
      savingRef.current = null;
    });
    await savingRef.current;
  }, [saveNow]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState('dirty');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (savingRef.current) {
        // A save is in flight; queue another pass right after it.
        savingRef.current.then(() => scheduleSave());
        return;
      }
      const run = saveNow();
      savingRef.current = run.finally(() => {
        savingRef.current = null;
      });
    }, AUTOSAVE_DELAY_MS);
  }, [saveNow]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /* ---------------- mutations ---------------- */

  const commit = useCallback(
    (next: Project) => {
      applyProject(next);
      scheduleSave();
    },
    [applyProject, scheduleSave],
  );

  const update = useCallback(
    (mutate: (draft: Project) => void) => {
      const current = projectRef.current;
      if (!current) return;
      const draft = structuredClone(current);
      mutate(draft);
      commit(draft);
    },
    [commit],
  );

  const patchNode = useCallback(
    (nodeId: string, patch: Partial<FlowNode>) => {
      const current = projectRef.current;
      if (!current) return;
      commit({
        ...current,
        nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      });
    },
    [commit],
  );

  const setFlowData = useCallback(
    (nodeId: string, data: FlowData) => {
      patchNode(nodeId, { data });
    },
    [patchNode],
  );

  const addNode = useCallback(
    (kind: string, position: Vec2): FlowNode | null => {
      const current = projectRef.current;
      if (!current) return null;
      const node = createNode(kind, position);
      commit({ ...current, nodes: [...current.nodes, node] });
      setSelection({ type: 'node', id: node.id });
      return node;
    },
    [commit],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      const current = projectRef.current;
      if (!current) return;
      commit({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== nodeId),
        connections: current.connections.filter(
          (connection) => connection.from.nodeId !== nodeId && connection.to.nodeId !== nodeId,
        ),
      });
      setSelection({ type: 'none' });
      setFocusedFlowId((focused) => (focused === nodeId ? null : focused));
    },
    [commit],
  );

  const connect = useCallback(
    (from: PortRef, to: PortRef): boolean => {
      const current = projectRef.current;
      if (!current) return false;
      const check = validateConnection(current, from, to);
      if (!check.ok) {
        notify('warn', check.reason ?? 'That connection is not allowed.');
        return false;
      }
      const sourceNode = current.nodes.find((node) => node.id === from.nodeId);
      const targetNode = current.nodes.find((node) => node.id === to.nodeId);
      const connection = createConnection(from, to, {
        rules:
          sourceNode && targetNode
            ? defaultRulesForConnection(
                { kind: sourceNode.kind, portId: from.portId },
                { kind: targetNode.kind, portId: to.portId },
              )
            : '',
      });
      commit({ ...current, connections: [...current.connections, connection] });
      setSelection({ type: 'connection', id: connection.id });
      return true;
    },
    [commit, notify],
  );

  const patchConnection = useCallback(
    (connectionId: string, patch: Partial<Connection>) => {
      const current = projectRef.current;
      if (!current) return;
      commit({
        ...current,
        connections: current.connections.map((connection) =>
          connection.id === connectionId ? { ...connection, ...patch } : connection,
        ),
      });
    },
    [commit],
  );

  const removeConnection = useCallback(
    (connectionId: string) => {
      const current = projectRef.current;
      if (!current) return;
      commit({
        ...current,
        connections: current.connections.filter((connection) => connection.id !== connectionId),
      });
      setSelection({ type: 'none' });
    },
    [commit],
  );

  /* ---------------- project lifecycle ---------------- */

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (error) {
      notify('error', `Could not list projects: ${(error as Error).message}`);
    }
  }, [notify]);

  const openProject = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        await flushSave();
        const next = await api.getProject(id);
        applyProject(next);
        setRuns({});
        setSelection({ type: 'none' });
        setFocusedFlowId(null);
        setSaveState('clean');
        window.localStorage.setItem(LAST_PROJECT_KEY, id);
      } catch (error) {
        notify('error', `Could not open project: ${(error as Error).message}`);
        window.localStorage.removeItem(LAST_PROJECT_KEY);
      } finally {
        setLoading(false);
      }
    },
    [applyProject, flushSave, notify],
  );

  const newProject = useCallback(
    async (name: string, template: 'starter' | 'empty' = 'starter') => {
      setLoading(true);
      try {
        await flushSave();
        const created = await api.createProject(name, template);
        applyProject(created);
        setRuns({});
        setSelection({ type: 'none' });
        setFocusedFlowId(null);
        setSaveState('clean');
        window.localStorage.setItem(LAST_PROJECT_KEY, created.id);
        await refreshProjects();
        notify('success', `Created “${created.name}”.`);
      } catch (error) {
        notify('error', `Could not create project: ${(error as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [applyProject, flushSave, notify, refreshProjects],
  );

  const removeProject = useCallback(
    async (id: string) => {
      try {
        await api.deleteProject(id);
        if (projectRef.current?.id === id) {
          applyProject(null);
          window.localStorage.removeItem(LAST_PROJECT_KEY);
        }
        await refreshProjects();
        notify('info', 'Project deleted.');
      } catch (error) {
        notify('error', `Could not delete project: ${(error as Error).message}`);
      }
    },
    [applyProject, notify, refreshProjects],
  );

  const closeProject = useCallback(() => {
    void flushSave().then(() => {
      applyProject(null);
      window.localStorage.removeItem(LAST_PROJECT_KEY);
    });
  }, [applyProject, flushSave]);

  /* ---------------- generation ---------------- */

  const withBusy = useCallback(async <T,>(flowIds: string[], work: () => Promise<T>): Promise<T> => {
    setBusyFlows((current) => [...current, ...flowIds]);
    try {
      return await work();
    } finally {
      setBusyFlows((current) => current.filter((id) => !flowIds.includes(id)));
    }
  }, []);

  const recordRuns = useCallback((incoming: GenerationRun[]) => {
    setRuns((current) => {
      const next = { ...current };
      for (const run of incoming) next[run.flowId] = run;
      return next;
    });
  }, []);

  const generateFlow = useCallback(
    async (nodeId: string, attachments: AttachmentPayload[] = []): Promise<GenerationRun | null> => {
      const current = projectRef.current;
      if (!current) return null;
      return withBusy([nodeId], async () => {
        try {
          await flushSave();
          const result = await api.generateFlow(current.id, nodeId, attachments);
          applyProject(result.project);
          setSaveState('clean');
          recordRuns(result.runs);
          const run = result.runs[0];
          if (run?.ok) {
            notify(
              run.warnings.length > 0 ? 'warn' : 'success',
              `${run.flowName}: ${run.outputs.length} artifact(s)${
                run.warnings.length > 0 ? `, ${run.warnings.length} warning(s)` : ''
              }.`,
            );
          } else if (run) {
            notify('error', `${run.flowName} failed: ${run.error}`);
          }
          return run ?? null;
        } catch (error) {
          notify('error', `Generate failed: ${(error as Error).message}`);
          return null;
        }
      });
    },
    [applyProject, flushSave, notify, recordRuns, withBusy],
  );

  const generateAll = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    await withBusy(
      current.nodes.map((node) => node.id),
      async () => {
        try {
          await flushSave();
          const result = await api.generateProject(current.id);
          applyProject(result.project);
          setSaveState('clean');
          recordRuns(result.runs);
          const failed = result.runs.filter((run) => !run.ok);
          if (result.runs.length === 0) notify('info', 'Everything is already up to date.');
          else if (failed.length > 0) notify('error', `${failed.length} of ${result.runs.length} flow(s) failed.`);
          else notify('success', `Generated ${result.runs.length} flow(s).`);
        } catch (error) {
          notify('error', `Generate failed: ${(error as Error).message}`);
        }
      },
    );
  }, [applyProject, flushSave, notify, recordRuns, withBusy]);

  const acceptSync = useCallback(
    async (nodeId: string, connectionId?: string) => {
      const current = projectRef.current;
      if (!current) return;
      await withBusy([nodeId], async () => {
        try {
          await flushSave();
          const result = await api.syncAccept(current.id, nodeId, connectionId);
          applyProject(result.project);
          setSaveState('clean');
          const counts = result.plan.counts;
          notify(
            'success',
            `Synced from ${result.sourceFlowName}: ${counts.add} added, ${counts.update} updated, ${counts.remove} dropped, ${counts.pinned} pinned kept.`,
          );
        } catch (error) {
          notify('error', `Sync failed: ${(error as Error).message}`);
        }
      });
    },
    [applyProject, flushSave, notify, withBusy],
  );

  const uploadOutput = useCallback(
    async (nodeId: string, portId: string, fileName: string, data: string) => {
      const current = projectRef.current;
      if (!current) return;
      await withBusy([nodeId], async () => {
        try {
          await flushSave();
          const result = await api.uploadOutput(current.id, nodeId, portId, fileName, data);
          applyProject(result.project);
          setSaveState('clean');
          notify('success', `Uploaded ${result.artifact.fileName}.`);
        } catch (error) {
          notify('error', `Upload failed: ${(error as Error).message}`);
        }
      });
    },
    [applyProject, flushSave, notify, withBusy],
  );

  const clearArtifacts = useCallback(
    async (nodeId: string) => {
      const current = projectRef.current;
      if (!current) return;
      await withBusy([nodeId], async () => {
        try {
          await flushSave();
          const next = await api.clearArtifacts(current.id, nodeId);
          applyProject(next);
          setSaveState('clean');
          setRuns((runsByFlow) => {
            const copy = { ...runsByFlow };
            delete copy[nodeId];
            return copy;
          });
          notify('info', 'Artifacts cleared.');
        } catch (error) {
          notify('error', `Could not clear artifacts: ${(error as Error).message}`);
        }
      });
    },
    [applyProject, flushSave, notify, withBusy],
  );

  /* ---------------- boot ---------------- */

  useEffect(() => {
    void (async () => {
      try {
        setRegistry(await api.registry());
      } catch (error) {
        notify('error', `Could not load the flow catalogue: ${(error as Error).message}`);
      }
      await refreshProjects();
      const last = window.localStorage.getItem(LAST_PROJECT_KEY);
      if (last) await openProject(last);
    })();
    // Boot once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<StudioValue>(
    () => ({
      registry,
      projects,
      project,
      loading,
      saveState,
      runs,
      busyFlows,
      toasts,
      selection,
      focusedFlowId,
      notify,
      dismissToast,
      refreshProjects,
      openProject,
      newProject,
      removeProject,
      closeProject,
      update,
      patchNode,
      setFlowData,
      addNode,
      removeNode,
      connect,
      patchConnection,
      removeConnection,
      select: setSelection,
      focusFlow: setFocusedFlowId,
      generateFlow,
      generateAll,
      acceptSync,
      uploadOutput,
      clearArtifacts,
      flushSave,
    }),
    [
      registry,
      projects,
      project,
      loading,
      saveState,
      runs,
      busyFlows,
      toasts,
      selection,
      focusedFlowId,
      notify,
      dismissToast,
      refreshProjects,
      openProject,
      newProject,
      removeProject,
      closeProject,
      update,
      patchNode,
      setFlowData,
      addNode,
      removeNode,
      connect,
      patchConnection,
      removeConnection,
      generateFlow,
      generateAll,
      acceptSync,
      uploadOutput,
      clearArtifacts,
      flushSave,
    ],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
