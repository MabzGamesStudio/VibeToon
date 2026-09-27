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
  emptyHistory,
  nextRedo,
  nextUndo,
  record,
  redo as redoStep,
  seal,
  undo as undoStep,
  validateConnection,
  type History,
  type ArtifactRef,
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

/** What undo and redo would do from where you are. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
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

  /**
   * Change the project's own fields — its name, settings, graph view. The draft
   * is a shallow copy: nodes and connections have their own methods below.
   */
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

  /**
   * Take back the last change. Inside a flow's editor that is the last change
   * to that flow; on the graph, the last change anywhere.
   */
  undo(): void;
  redo(): void;
  undoState: UndoState;

  generateFlow(nodeId: string, attachments?: AttachmentPayload[]): Promise<GenerationRun | null>;
  generateAll(): Promise<void>;
  acceptSync(nodeId: string, connectionId?: string): Promise<void>;
  uploadOutput(nodeId: string, portId: string, fileName: string, data: string): Promise<void>;
  /** Fetch an image onto a port; resolves with what arrived, or undefined on failure. */
  fetchOutput(
    nodeId: string,
    portId: string,
    url: string,
  ): Promise<
    | { project: Project; artifact: ArtifactRef; source: { url: string; contentType: string; bytes: number } }
    | undefined
  >;
  clearArtifacts(nodeId: string): Promise<void>;
  flushSave(): Promise<void>;
}

const flowName = (project: Project, nodeId: string) => project.nodes.find((node) => node.id === nodeId)?.name ?? 'a flow';

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
  // Undo history. Kept in a ref so recording a change never waits on a render;
  // `historyTick` re-renders what shows it.
  const historyRef = useRef<History>(emptyHistory());
  const gestureRef = useRef<number | null>(null);
  const gestureSeq = useRef(0);
  const [historyTick, setHistoryTick] = useState(0);
  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedFlowId;

  const setHistory = useCallback((next: History) => {
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistoryTick((tick) => tick + 1);
  }, []);

  const resetHistory = useCallback(() => {
    historyRef.current = emptyHistory();
    setHistoryTick((tick) => tick + 1);
  }, []);

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
        resetHistory();
        setSaveState('clean');
        return;
      }
      notify('error', `Could not save: ${(error as Error).message}`);
    }
  }, [applyProject, notify, resetHistory]);

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
      const current = projectRef.current;
      if (current) setHistory(record(historyRef.current, current, next, { now: Date.now(), gesture: gestureRef.current }));
      applyProject(next);
      scheduleSave();
    },
    [applyProject, scheduleSave, setHistory],
  );

  /**
   * Take a project the server made — after a generate, a sync, an upload. What
   * it changed in any flow's data (a sync writes into it) is a step of its own
   * that can be undone; the files and runs it made are not.
   */
  const adopt = useCallback(
    (next: Project, label: string) => {
      const current = projectRef.current;
      if (current && current.id === next.id) {
        setHistory(record(historyRef.current, current, next, { now: Date.now(), gesture: null, label, apart: true }));
      }
      applyProject(next);
    },
    [applyProject, setHistory],
  );

  const update = useCallback(
    (mutate: (draft: Project) => void) => {
      const current = projectRef.current;
      if (!current) return;
      // Shallow: copying every node's data to change the project's name would
      // make every flow look changed, to the undo history and to anything
      // else that compares by reference.
      const draft: Project = { ...current, settings: { ...current.settings }, view: { ...current.view } };
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

  /* ---------------- undo ---------------- */

  const step = useCallback(
    (direction: 'undo' | 'redo') => {
      const current = projectRef.current;
      if (!current) return;
      const scope = focusedRef.current;
      const result = (direction === 'undo' ? undoStep : redoStep)(historyRef.current, current, scope);
      if (!result) return;
      setHistory(result.history);
      applyProject(result.project);
      scheduleSave();
      // A step undone on the graph may be inside a flow, where it cannot be
      // seen from here; say what it was.
      if (scope === null && result.entry.scope !== 'graph') {
        notify('info', `${direction === 'undo' ? 'Undid' : 'Redid'} ${result.entry.label}`);
      }
    },
    [applyProject, notify, scheduleSave, setHistory],
  );

  const undo = useCallback(() => step('undo'), [step]);
  const redo = useCallback(() => step('redo'), [step]);

  const undoState = useMemo<UndoState>(() => {
    if (!project) return { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' };
    const back = nextUndo(historyRef.current, project, focusedFlowId);
    const forward = nextRedo(historyRef.current, project, focusedFlowId);
    return {
      canUndo: Boolean(back),
      canRedo: Boolean(forward),
      undoLabel: back?.label ?? '',
      redoLabel: forward?.label ?? '',
    };
    // historyTick stands for historyRef.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, focusedFlowId, historyTick]);

  /*
   * What counts as one step. A pointer held down is one gesture — a drag, a
   * slider, a brush stroke — however many changes it makes. Pressing it again,
   * pressing Enter or Tab, or moving to another field starts the next step.
   */
  useEffect(() => {
    const closeStep = () => setHistory(seal(historyRef.current));
    const onDown = () => {
      gestureSeq.current += 1;
      gestureRef.current = gestureSeq.current;
      closeStep();
    };
    const onUp = () => {
      // Handlers for mouseup and click run after pointerup, and some commit
      // there — the end of a drag, a button's click. They are still part of
      // the gesture, so it ends on the next task, not this one.
      const ending = gestureRef.current;
      window.setTimeout(() => {
        if (gestureRef.current !== ending) return;
        gestureRef.current = null;
        closeStep();
      }, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'Tab') closeStep();
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.defaultPrevented) return;
      // A dialog's fields are not the project; leave their undo to the browser.
      if (event.target instanceof Element && event.target.closest('.vt-modal')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        // Our own undo, even in a text field: the field's own history is
        // cleared by every re-render, and the project's is the one that
        // matters.
        event.preventDefault();
        if (key === 'y' || event.shiftKey) step('redo');
        else step('undo');
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('focusin', closeStep);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('focusin', closeStep);
      window.removeEventListener('keydown', onKey);
    };
  }, [setHistory, step]);

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
        resetHistory();
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
    [applyProject, flushSave, notify, resetHistory],
  );

  const newProject = useCallback(
    async (name: string, template: 'starter' | 'empty' = 'starter') => {
      setLoading(true);
      try {
        await flushSave();
        const created = await api.createProject(name, template);
        applyProject(created);
        resetHistory();
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
    [applyProject, flushSave, notify, refreshProjects, resetHistory],
  );

  const removeProject = useCallback(
    async (id: string) => {
      try {
        await api.deleteProject(id);
        if (projectRef.current?.id === id) {
          applyProject(null);
          resetHistory();
          window.localStorage.removeItem(LAST_PROJECT_KEY);
        }
        await refreshProjects();
        notify('info', 'Project deleted.');
      } catch (error) {
        notify('error', `Could not delete project: ${(error as Error).message}`);
      }
    },
    [applyProject, notify, refreshProjects, resetHistory],
  );

  const closeProject = useCallback(() => {
    void flushSave().then(() => {
      applyProject(null);
      resetHistory();
      window.localStorage.removeItem(LAST_PROJECT_KEY);
    });
  }, [applyProject, flushSave, resetHistory]);

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
          adopt(result.project, `Generate ${flowName(current, nodeId)}`);
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
    [adopt, flushSave, notify, recordRuns, withBusy],
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
          adopt(result.project, 'Generate stale flows');
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
  }, [adopt, flushSave, notify, recordRuns, withBusy]);

  const acceptSync = useCallback(
    async (nodeId: string, connectionId?: string) => {
      const current = projectRef.current;
      if (!current) return;
      await withBusy([nodeId], async () => {
        try {
          await flushSave();
          const result = await api.syncAccept(current.id, nodeId, connectionId);
          adopt(result.project, `Sync ${flowName(current, nodeId)} from ${result.sourceFlowName}`);
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
    [adopt, flushSave, notify, withBusy],
  );

  const uploadOutput = useCallback(
    async (nodeId: string, portId: string, fileName: string, data: string) => {
      const current = projectRef.current;
      if (!current) return;
      await withBusy([nodeId], async () => {
        try {
          await flushSave();
          const result = await api.uploadOutput(current.id, nodeId, portId, fileName, data);
          adopt(result.project, `Upload to ${flowName(current, nodeId)}`);
          setSaveState('clean');
          notify('success', `Uploaded ${result.artifact.fileName}.`);
        } catch (error) {
          notify('error', `Upload failed: ${(error as Error).message}`);
        }
      });
    },
    [adopt, flushSave, notify, withBusy],
  );

  /**
   * Fetch an image onto a port. Returns the artifact so the caller can record what
   * arrived — the image flow keeps the format, size and address in its own data,
   * and only the fetch knows them.
   */
  const fetchOutput = useCallback(
    async (nodeId: string, portId: string, url: string) => {
      const current = projectRef.current;
      if (!current) return undefined;
      return withBusy([nodeId], async () => {
        try {
          await flushSave();
          const result = await api.fetchOutput(current.id, nodeId, portId, url);
          adopt(result.project, `Fetch into ${flowName(current, nodeId)}`);
          setSaveState('clean');
          notify('success', `Fetched ${result.artifact.fileName}.`);
          return result;
        } catch (error) {
          notify('error', `Could not fetch that image: ${(error as Error).message}`);
          return undefined;
        }
      });
    },
    [adopt, flushSave, notify, withBusy],
  );

  const clearArtifacts = useCallback(
    async (nodeId: string) => {
      const current = projectRef.current;
      if (!current) return;
      await withBusy([nodeId], async () => {
        try {
          await flushSave();
          const next = await api.clearArtifacts(current.id, nodeId);
          adopt(next, `Clear ${flowName(current, nodeId)}`);
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
    [adopt, flushSave, notify, withBusy],
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
      undo,
      redo,
      undoState,
      generateFlow,
      generateAll,
      acceptSync,
      uploadOutput,
      fetchOutput,
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
      undo,
      redo,
      undoState,
      generateFlow,
      generateAll,
      acceptSync,
      uploadOutput,
      fetchOutput,
      clearArtifacts,
      flushSave,
    ],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
