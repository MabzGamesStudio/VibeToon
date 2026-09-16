import { type ReactNode } from 'react';
import { flowStatus, getFlowKind, inputsForPort, type FlowNode, type Project } from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import { ArtifactView } from '../inspector/ArtifactView';
import { RunLog } from '../inspector/RunLog';

export interface EditorShellProps {
  project: Project;
  node: FlowNode;
  /** Extra buttons for this editor, shown after Generate. */
  actions?: ReactNode;
  /** A strip under the toolbar, e.g. the storyboard's sync state. */
  banner?: ReactNode;
  /** Replaces the default generate call, e.g. to attach rasterised panels. */
  onGenerate?(): void | Promise<void>;
  children: ReactNode;
}

/**
 * The frame every flow editor sits in: what this flow is, what is wired into it,
 * what it produced, and the button that produces it again.
 */
export function EditorShell({
  project,
  node,
  actions,
  banner,
  onGenerate,
  children,
}: EditorShellProps): JSX.Element {
  const { focusFlow, generateFlow, busyFlows, runs, select } = useStudio();
  const { view, toggle } = useView();
  const panelOpen = view.inspector;
  const def = getFlowKind(node.kind);
  const status = flowStatus(project, node);
  const busy = busyFlows.includes(node.id);

  const incoming = (def?.inputs ?? []).flatMap((port) =>
    inputsForPort(project, node.id, port.id).map((input) => ({ port, input })),
  );

  return (
    <div className={`vt-editor${view.sidebar ? '' : ' is-no-sidebar'}`}>
      <div className="vt-editor-bar">
        <button type="button" className="vt-btn is-small" onClick={() => focusFlow(null)}>
          ◀ Graph
        </button>
        <strong>{node.name}</strong>
        <span className="vt-faint">{def?.label}</span>
        <span className={`vt-pill is-${status}`}>{status}</span>
        <span className="vt-spacer" />
        {actions}
        <button
          type="button"
          className="vt-btn is-primary"
          disabled={busy}
          onClick={() => void (onGenerate ? onGenerate() : generateFlow(node.id))}
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
        <button
          type="button"
          className={`vt-btn is-small${panelOpen ? ' is-active' : ''}`}
          title="Inputs and generated files. Remembered across flows, in View."
          onClick={() => toggle('inspector')}
        >
          Files
        </button>
      </div>

      {banner}

      <div className="vt-editor-body">
        {children}

        {panelOpen ? (
          <aside className="vt-inspector">
            <header>
              <h2>Inputs &amp; files</h2>
            </header>
            <div className="vt-inspector-body">
              <div className="vt-section">
                <h3>Arriving here</h3>
                {incoming.length === 0 ? (
                  <div className="vt-empty">Nothing is wired into this flow.</div>
                ) : (
                  incoming.map(({ port, input }) => (
                    <div className="vt-upstream" key={input.connection.id}>
                      <div className="vt-upstream-head">
                        <span>{input.sourceNode.name}</span>
                        <span className="vt-faint">→ {port.label}</span>
                        <span className="vt-spacer" />
                        <button
                          type="button"
                          className="vt-btn is-ghost is-small"
                          title="Edit the rules on this connection"
                          onClick={() => {
                            select({ type: 'connection', id: input.connection.id });
                            focusFlow(null);
                          }}
                        >
                          rules
                        </button>
                      </div>
                      <div className="vt-faint" style={{ fontSize: 11 }}>
                        {input.connection.settings.mode}
                        {input.connection.settings.enabled ? '' : ' · disabled'}
                        {input.artifact ? ` · ${input.artifact.fileName}` : ' · not generated yet'}
                      </div>
                      {input.connection.rules.trim() ? <pre>{input.connection.rules.trim()}</pre> : null}
                    </div>
                  ))
                )}
              </div>

              <div className="vt-section">
                <h3>Files this flow wrote</h3>
                {node.outputs.length === 0 ? (
                  <div className="vt-empty">Nothing generated yet.</div>
                ) : (
                  <div className="vt-artifacts">
                    {node.outputs.map((artifact) =>
                      view.artifactPreviews ? (
                        <ArtifactView key={artifact.port} projectId={project.id} artifact={artifact} />
                      ) : (
                        <div key={artifact.port} className="vt-artifact-plain">
                          <code>{artifact.fileName}</code>
                          <span className="vt-faint">{artifact.kind}</span>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>

              <div className="vt-section">
                <h3>Last run</h3>
                <RunLog node={node} run={runs[node.id]} />
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
