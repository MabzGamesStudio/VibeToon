import { useCallback, useMemo, useState } from 'react';
import {
  customDataOf,
  exposeFromWiring,
  inputsForPort,
  instanceCounts,
  membersOf,
  openOutInstance,
  renameTemplate,
  saveInstanceAsTemplate,
  templateById,
  unexposePort,
  type CustomFlowData,
  type ExposedPort,
  type FlowNode,
  type Project,
  type Vec2,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { FlowPalette } from '../graph/FlowPalette';
import { GraphCanvas } from '../graph/GraphCanvas';
import { Inspector } from '../inspector/Inspector';
import { EditorShell } from './EditorShell';

/**
 * One custom flow, built on a graph of its own: the flows behind its card as
 * cards, wired as on the main graph, with what it takes and gives on two cards
 * of their own either side.
 *
 * The flows behind it are this instance's own. Opening one opens its ordinary
 * editor, and whatever is changed there is changed in this instance only —
 * the template it was made from, and every other instance of it, are not
 * touched unless you save this one over the template.
 */
export function CustomFlowEditor({ project, node }: { project: Project; node: FlowNode }): JSX.Element {
  const { focusFlow, patchNode, transform, notify, removeNode, selection } = useStudio();
  const [palette, setPalette] = useState(true);
  const [dropPoint, setDropPoint] = useState<Vec2>({ x: 0, y: 0 });
  const onViewportCentre = useCallback((point: Vec2) => setDropPoint(point), []);
  const data = customDataOf(node);
  const template = templateById(project, data.templateId);
  const members = useMemo(() => membersOf(project, node.id), [node.id, project]);
  const memberIds = new Set(members.map((member) => member.id));
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
        <button
          type="button"
          className="vt-btn is-ghost is-small"
          title="Stop showing this port on the card"
          onClick={() => transform((current) => unexposePort(current, node.id, side, port.id))}
        >
          Hide
        </button>
      </div>
    );
  };

  return (
    <EditorShell
      project={project}
      node={node}
      actions={
        <>
          <button
            type="button"
            className={`vt-btn is-small${palette ? ' is-active' : ''}`}
            onClick={() => setPalette((open) => !open)}
          >
            {palette ? '◀ Flows' : 'Flows ▶'}
          </button>
          <button
            type="button"
            className="vt-btn is-small"
            title="Put the flows behind this card back on the graph as ordinary flows"
            disabled={members.length === 0}
            onClick={() => {
              transform((current) => openOutInstance(current, node.id));
              focusFlow(null);
            }}
          >
            Open out
          </button>
        </>
      }
    >
      <aside className="vt-editor-side">
        <div className="vt-section">
          <h3>This custom flow</h3>
          <label className="vt-field">
            <span className="vt-label">Name on the graph</span>
            <input value={node.name} onChange={(event) => patchNode(node.id, { name: event.target.value })} />
          </label>
          {template ? (
            <label className="vt-field">
              <span className="vt-label">Name in the palette</span>
              <input
                value={template.name}
                onChange={(event) => transform((current) => renameTemplate(current, template.id, event.target.value))}
              />
            </label>
          ) : null}
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
            template to make new uses start from here. Double-click a flow on the graph to open it.
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

        <div className="vt-section">
          <h3>Takes ({data.inputs.length})</h3>
          {data.inputs.length === 0 ? <div className="vt-empty">Nothing yet.</div> : data.inputs.map((port) => portRow(port, 'inputs'))}
        </div>
        <div className="vt-section">
          <h3>Gives ({data.outputs.length})</h3>
          {data.outputs.length === 0 ? <div className="vt-empty">Nothing yet.</div> : data.outputs.map((port) => portRow(port, 'outputs'))}
          <button
            type="button"
            className="vt-btn is-small"
            style={{ marginTop: 6 }}
            title="Take every input nothing inside feeds, and give every output nothing inside reads"
            disabled={members.length === 0}
            onClick={() => transform((current) => exposeFromWiring(current, node.id))}
          >
            Show what the wiring leaves open
          </button>
        </div>
      </aside>

      <div className="vt-editor-main vt-custom-graph">
        {palette ? <FlowPalette dropPoint={dropPoint} group={node.id} /> : null}
        <GraphCanvas key={node.id} scope={node.id} onViewportCentre={onViewportCentre} />
        {/* A wire's rules are set in the inspector; a flow is opened instead. */}
        {selection.type === 'connection' ? <Inspector /> : null}
        {members.length === 0 ? (
          <div className="vt-custom-empty vt-faint">
            Nothing inside yet. Add flows from the palette, wire them, and drag a port onto Takes or Gives to show it
            on the card.
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
