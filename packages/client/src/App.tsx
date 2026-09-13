import { getFlowKind } from '@vibetoon/shared';
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

export function App(): JSX.Element {
  const { project, focusedFlowId, focusFlow, saveState, generateAll, closeProject, busyFlows, loading } =
    useStudio();

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
        <div className={`vt-save-state is-${saveState}`}>{SAVE_LABEL[saveState] ?? saveState}</div>
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

      <Toasts />
    </div>
  );
}
