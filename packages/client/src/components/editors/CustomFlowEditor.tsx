import { useMemo } from 'react';
import {
  customDataOf,
  flowStatus,
  getFlowKind,
  inputsForPort,
  instanceCounts,
  membersOf,
  openOutInstance,
  saveInstanceAsTemplate,
  templateById,
  topoOrder,
  type CustomFlowData,
  type ExposedPort,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { EditorShell } from './EditorShell';

/**
 * One custom flow: the flows behind its card, its ports, and its template.
 *
 * The flows behind it are this instance's own. Opening one opens its ordinary
 * editor, and whatever is changed there is changed in this instance only —
 * the template it was made from, and every other instance of it, are not
 * touched unless you save this one over the template.
 */
export function CustomFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { focusFlow, patchNode, transform, notify, removeNode } = useStudio();
  const data = customDataOf(node);
  const template = templateById(project, data.templateId);
  const members = useMemo(() => {
    const order = topoOrder(project).order;
    return membersOf(project, node.id).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [node.id, project]);
  const memberIds = new Set(members.map((member) => member.id));
  const wires = project.connections.filter((c) => memberIds.has(c.from.nodeId) && memberIds.has(c.to.nodeId));
  const count = instanceCounts(project).get(data.templateId) ?? 0;
  const nameOf = (id: string) => project.nodes.find((one) => one.id === id)?.name ?? '?';

  const relabel = (side: 'inputs' | 'outputs', id: string, label: string) => {
    const next: CustomFlowData = {
      ...data,
      [side]: data[side].map((port) => (port.id === id ? { ...port, label } : port)),
    };
    patchNode(node.id, { data: next });
  };

  const portRow = (port: ExposedPort, side: 'inputs' | 'outputs') => {
    const member = project.nodes.find((one) => one.id === port.node);
    const wired =
      side === 'inputs'
        ? inputsForPort(project, port.node, port.port).map((input) => input.sourceNode.name)
        : project.connections.filter((c) => c.from.nodeId === port.node && c.from.portId === port.port && !memberIds.has(c.to.nodeId)).map((c) => nameOf(c.to.nodeId));
    return (
      <div key={port.id} className="vt-custom-port">
        <input
          value={port.label}
          aria-label={`Name of the ${side === 'inputs' ? 'input' : 'output'} ${port.label}`}
          onChange={(event) => relabel(side, port.id, event.target.value)}
        />
        <span className="vt-faint">
          {member?.name ?? '?'} · {port.port} · {port.kinds.join('/')}
          {port.required ? ' · required' : ''}
        </span>
        <span className="vt-faint">
          {wired.length > 0 ? `${side === 'inputs' ? 'from' : 'to'} ${wired.join(', ')}` : 'not wired'}
        </span>
      </div>
    );
  };

  return (
    <EditorShell
      project={project}
      node={node}
      actions={
        <button
          type="button"
          className="vt-btn is-small"
          title="Put the flows behind this card back on the graph as ordinary flows"
          onClick={() => {
            transform((current) => openOutInstance(current, node.id));
            focusFlow(null);
          }}
        >
          Open out
        </button>
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>This custom flow</h3>
          <label className="vt-field">
            <span className="vt-label">Name on the graph</span>
            <input value={node.name} onChange={(event) => patchNode(node.id, { name: event.target.value })} />
          </label>
          <dl className="vt-kv">
            <dt>Made from</dt>
            <dd>{template ? template.name : `${data.templateName} (no longer saved)`}</dd>
            <dt>Uses on the graph</dt>
            <dd>{count}</dd>
            <dt>Flows inside</dt>
            <dd>{members.length}</dd>
          </dl>
          {template?.description ? (
            <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
              {template.description}
            </p>
          ) : null}
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            The flows inside are this one’s own: changing them changes this use only. Save it over the
            template to make new uses start from here.
          </p>
          <div className="vt-row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="vt-btn is-small"
              disabled={!template}
              onClick={() => {
                transform((current) => saveInstanceAsTemplate(current, node.id));
                notify('success', `Saved over “${template?.name}”. Uses already on the graph keep their own settings.`);
              }}
            >
              Save over the template
            </button>
            <button
              type="button"
              className="vt-btn is-small is-danger"
              onClick={() => {
                if (window.confirm(`Remove “${node.name}” and the ${members.length} flow(s) inside it?`)) removeNode(node.id);
              }}
            >
              Remove
            </button>
          </div>
        </div>
      </aside>

      <div className="vt-editor-main">
        <div className="vt-section">
          <h3>Flows inside ({members.length})</h3>
          <div className="vt-custom-members">
            {members.map((member, index) => {
              const status = flowStatus(project, member);
              return (
                <button
                  key={member.id}
                  type="button"
                  className="vt-custom-member"
                  title="Open this flow’s editor"
                  onClick={() => focusFlow(member.id)}
                >
                  <span className="vt-faint">{index + 1}</span>
                  <strong>{member.name}</strong>
                  <span className="vt-faint">{getFlowKind(member.kind)?.label ?? member.kind}</span>
                  <span className={`vt-pill is-${status}`}>{status}</span>
                  <span className="vt-spacer" />
                  <span className="vt-btn is-small">Open ▸</span>
                </button>
              );
            })}
          </div>
          {wires.length > 0 ? (
            <ul className="vt-custom-wires">
              {wires.map((wire) => (
                <li key={wire.id}>
                  {nameOf(wire.from.nodeId)}.{wire.from.portId} → {nameOf(wire.to.nodeId)}.{wire.to.portId}
                  {wire.settings.enabled ? '' : ' (off)'}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="vt-section">
          <h3>Takes ({data.inputs.length})</h3>
          {data.inputs.length === 0 ? <div className="vt-empty">Nothing: it makes everything itself.</div> : data.inputs.map((port) => portRow(port, 'inputs'))}
        </div>
        <div className="vt-section">
          <h3>Gives ({data.outputs.length})</h3>
          {data.outputs.length === 0 ? <div className="vt-empty">Nothing is shown outside.</div> : data.outputs.map((port) => portRow(port, 'outputs'))}
        </div>
      </div>
    </EditorShell>
  );
}
