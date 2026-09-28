import { useMemo, useState } from 'react';
import {
  createCustomFlow,
  getFlowKind,
  isCustomNode,
  proposePorts,
  upstreamNodes,
  type ExposedPort,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { Modal } from '../common/Modal';

/**
 * Save an arrangement of flows as a custom flow.
 *
 * Pick the flows; the ports it would show are worked out from how they are
 * wired, and any can be left inside. Making it saves the template to the
 * project and puts the chosen flows behind one card in their place.
 */
export function CustomFlowDialog({ onClose }: { onClose(): void }): JSX.Element {
  const { project, selection, transform, select, notify } = useStudio();
  const candidates = useMemo(
    () => (project?.nodes ?? []).filter((node) => !node.group && !isCustomNode(node)),
    [project],
  );
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(selection.type === 'node' && candidates.some((node) => node.id === selection.id) ? [selection.id] : []),
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  /** Ports left inside, by id. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const ports = useMemo(
    () => (project && chosen.size > 0 ? proposePorts(project, [...chosen]) : { inputs: [], outputs: [] }),
    [chosen, project],
  );
  if (!project) return <></>;

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addUpstream = () =>
    setChosen((current) => {
      const next = new Set(current);
      for (const id of current) {
        for (const node of upstreamNodes(project, id)) if (!node.group && !isCustomNode(node)) next.add(node.id);
      }
      return next;
    });

  const flip = (id: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = () => {
    let made: string | null = null;
    try {
      transform((current) => {
        const result = createCustomFlow(current, {
          name,
          description,
          memberIds: [...chosen],
          inputs: ports.inputs.filter((port) => !hidden.has(port.id)),
          outputs: ports.outputs.filter((port) => !hidden.has(port.id)),
        });
        made = result.nodeId;
        return result.project;
      });
    } catch (error) {
      notify('error', (error as Error).message);
      return;
    }
    if (made) select({ type: 'node', id: made });
    notify('success', `Saved “${name.trim() || 'Custom flow'}”. It is in the palette under Custom flows.`);
    onClose();
  };

  const portList = (title: string, list: ExposedPort[]) => (
    <div className="vt-section">
      <h3>
        {title} ({list.filter((port) => !hidden.has(port.id)).length} of {list.length})
      </h3>
      {list.length === 0 ? (
        <div className="vt-empty">None.</div>
      ) : (
        list.map((port) => (
          <label key={port.id} className="vt-row" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!hidden.has(port.id)} onChange={() => flip(port.id)} />
            <span>{port.label}</span>
            <span className="vt-faint">{port.kinds.join('/')}</span>
          </label>
        ))
      )}
    </div>
  );

  return (
    <Modal
      title="Make a custom flow"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="vt-faint" style={{ flex: 1, fontSize: 11 }}>
            The flows chosen go behind one card, keeping their settings, files and wires.
          </span>
          <button type="button" className="vt-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="vt-btn is-primary" disabled={chosen.size === 0} onClick={create}>
            Make it
          </button>
        </>
      }
    >
      <div className="vt-custom-dialog">
        <div>
          <label className="vt-field">
            <span className="vt-label">Name</span>
            <input value={name} placeholder="e.g. Trace a character" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="vt-field">
            <span className="vt-label">What it does</span>
            <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="vt-section">
            <h3>
              Flows in it ({chosen.size})
              <button type="button" className="vt-btn is-ghost is-small" style={{ marginLeft: 8 }} disabled={chosen.size === 0} onClick={addUpstream}>
                + everything upstream
              </button>
            </h3>
            <div className="vt-custom-pick">
              {candidates.map((node) => (
                <label key={node.id} className="vt-row" style={{ gap: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={chosen.has(node.id)} onChange={() => toggle(node.id)} />
                  <strong>{node.name}</strong>
                  <span className="vt-faint">{getFlowKind(node.kind)?.label ?? node.kind}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div>
          {portList('Takes', ports.inputs)}
          {portList('Gives', ports.outputs)}
          <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            An input fed by another flow in the arrangement stays inside; so does an output only the
            arrangement reads. Untick any other to keep it inside too.
          </p>
        </div>
      </div>
    </Modal>
  );
}
