import { useState } from 'react';
import { getFlowKind } from '@vibetoon/shared';
import { LogViewer } from './components/common/LogViewer';
import { SettingsDialog } from './components/common/SettingsDialog';
import { ViewMenu } from './components/common/ViewMenu';
import { Toasts } from './components/common/Toasts';
import { FlowEditor } from './components/editors/FlowEditor';
import { GraphView } from './components/graph/GraphView';
import { ProjectPicker } from './components/ProjectPicker';
import { useStudio } from './state/store';

const SAVE_LABEL: Record<string, string> = {
  clean: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
};

/** The modifier undo is under, as this machine writes it. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function App(): JSX.Element {
  const { project, focusedFlowId, focusFlow, saveState, generateAll, closeProject, busyFlows, loading, undo, redo, undoState } =
    useStudio();
  const [logsOpen, setLogsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (!project) {
    return (
      <div className="vt-app">
        <ProjectPicker />
        <Toasts />
      </div>
    );
  }

  const focused = focusedFlowId ? project.nodes.find((node) => node.id === focusedFlowId) : undefined;
  const focusedKind = focused ? getFlowKind(focused.kind) : undefined;

  return (
    <div className="vt-app">
      <header className="vt-header">
        <div className="vt-brand">
          VibeToon <small>flow studio</small>
        </div>
        <nav className="vt-crumbs">
          <button type="button" onClick={() => focusFlow(null)}>
            {project.name}
          </button>
          {focused ? (
            <>
              <span className="vt-faint">/</span>
              <span className="vt-crumb-current">
                {focused.name}
                <span className="vt-faint"> · {focusedKind?.label ?? focused.kind}</span>
              </span>
            </>
          ) : (
            <span className="vt-faint">· graph overview</span>
          )}
        </nav>
        <div className="vt-spacer" />
        <div className="vt-undo" role="group" aria-label="Undo and redo">
          <button
            type="button"
            className="vt-btn is-ghost is-small"
            onClick={undo}
            disabled={!undoState.canUndo}
            aria-label="Undo"
            title={
              undoState.canUndo
                ? `Undo ${undoState.undoLabel} (${MOD}Z)`
                : focused
                  ? `Nothing to undo in ${focused.name}`
                  : 'Nothing to undo'
            }
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="vt-btn is-ghost is-small"
            onClick={redo}
            disabled={!undoState.canRedo}
            aria-label="Redo"
            title={undoState.canRedo ? `Redo ${undoState.redoLabel} (${MOD}⇧Z)` : 'Nothing to redo'}
          >
            ↷ Redo
          </button>
        </div>
        <div className={`vt-save-state is-${saveState}`}>{SAVE_LABEL[saveState] ?? saveState}</div>
        <button
          type="button"
          className="vt-btn is-ghost is-small"
          onClick={() => setLogsOpen(true)}
          title="Every dictionary lookup and corpus download the studio has made"
        >
          Logs
        </button>
        <ViewMenu />
        <button
          type="button"
          className="vt-btn is-ghost is-small"
          onClick={() => setSettingsOpen(true)}
          title="How far every slider reaches, flow by flow"
        >
          Settings
        </button>
        <button
          type="button"
          className="vt-btn"
          onClick={() => void generateAll()}
          disabled={busyFlows.length > 0 || loading}
          title="Generate every flow that is empty or out of date, upstream first"
        >
          {busyFlows.length > 0 ? 'Generating…' : 'Generate stale'}
        </button>
        <button type="button" className="vt-btn is-ghost" onClick={closeProject}>
          Projects
        </button>
      </header>

      <div className="vt-main">
        {focused ? <FlowEditor node={focused} /> : <GraphView />}
      </div>

      {logsOpen ? <LogViewer onClose={() => setLogsOpen(false)} /> : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      <Toasts />
    </div>
  );
}
