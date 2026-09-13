import {
  flowStatus,
  getFlowKind,
  inputsForPort,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Field } from '../common/Field';
import { ArtifactView } from './ArtifactView';
import { RunLog } from './RunLog';

const STATUS_TEXT: Record<string, string> = {
  empty: 'Never generated',
  ready: 'Up to date',
  stale: 'Out of date — inputs or content changed since the last run',
  error: 'Last run failed',
};

export function NodeInspector({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { patchNode, removeNode, focusFlow, generateFlow, clearArtifacts, busyFlows, runs } = useStudio();
  const def = getFlowKind(node.kind);
  const status = flowStatus(project, node);
  const busy = busyFlows.includes(node.id);

  return (
    <>
      <div className="vt-section">
        <Field label="Name">
          <input value={node.name} onChange={(event) => patchNode(node.id, { name: event.target.value })} />
        </Field>
        <Field
          label="Notes"
          hint="Read by this flow's generator as guidance, and shown on the node."
        >
          <textarea
            rows={3}
            value={node.notes}
            onChange={(event) => patchNode(node.id, { notes: event.target.value })}
          />
        </Field>
        <div className="vt-row">
          <span className={`vt-pill is-${status}`}>{STATUS_TEXT[status]}</span>
        </div>
      </div>

      <div className="vt-section">
        <h3>
          <span>Flow kind</span>
          <code className="vt-faint">{node.kind}</code>
        </h3>
        <p className="vt-muted">{def?.summary}</p>
        <div className="vt-row" style={{ marginTop: 8, gap: 6 }}>
          <button type="button" className="vt-btn is-primary" onClick={() => focusFlow(node.id)}>
            Open editor
          </button>
          <button
            type="button"
            className="vt-btn"
            disabled={busy}
            onClick={() => void generateFlow(node.id)}
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>

      <div className="vt-section">
        <h3>Inputs</h3>
        {(def?.inputs ?? []).length === 0 ? (
          <div className="vt-empty">This flow starts from nothing.</div>
        ) : (
          (def?.inputs ?? []).map((port) => {
            const wired = inputsForPort(project, node.id, port.id);
            return (
              <div className="vt-port-row" key={port.id}>
                <span className="vt-port-name">{port.label}</span>
                <span className="vt-port-kinds">{port.kinds.join('/')}</span>
                <span className="vt-spacer" />
                <span className={wired.length === 0 && port.required ? 'vt-pill is-error' : 'vt-faint'}>
                  {wired.length > 0
                    ? wired.map((input) => input.sourceNode.name).join(', ')
                    : port.required
                      ? 'required'
                      : 'empty'}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="vt-section">
        <h3>Outputs</h3>
        {(def?.outputs ?? []).map((port) => {
          const artifact = node.outputs.find((ref) => ref.port === port.id);
          return (
            <div className="vt-port-row" key={port.id}>
              <span className="vt-port-name">{port.label}</span>
              <span className="vt-port-file">{port.fileName}</span>
              <span className="vt-spacer" />
              <span className={artifact ? 'vt-pill is-ready' : 'vt-faint'}>
                {artifact ? 'written' : 'not yet'}
              </span>
            </div>
          );
        })}
      </div>

      {node.outputs.length > 0 ? (
        <div className="vt-section">
          <h3>
            <span>Artifacts</span>
            <button
              type="button"
              className="vt-btn is-ghost is-small is-danger"
              onClick={() => {
                if (window.confirm('Delete the generated files for this flow?')) void clearArtifacts(node.id);
              }}
            >
              Clear
            </button>
          </h3>
          <div className="vt-artifacts">
            {node.outputs.map((artifact) => (
              <ArtifactView key={artifact.port} projectId={project.id} artifact={artifact} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="vt-section">
        <h3>Last run</h3>
        <RunLog node={node} run={runs[node.id]} />
      </div>

      <div className="vt-section">
        <button
          type="button"
          className="vt-btn is-danger"
          onClick={() => {
            if (window.confirm(`Remove “${node.name}” and its connections?`)) removeNode(node.id);
          }}
        >
          Remove flow
        </button>
      </div>
    </>
  );
}
