import { memo, useEffect, useRef } from 'react';
import {
  flowStatus,
  getFlowKind,
  inputsForPort,
  missingRequiredInputs,
  type FlowNode,
  type Project,
} from '@vibetoon/shared';

export type PortSide = 'in' | 'out';

export function anchorKey(nodeId: string, portId: string, side: PortSide): string {
  return `${nodeId}|${portId}|${side}`;
}

const STATUS_LABEL: Record<string, string> = {
  empty: 'not generated',
  ready: 'up to date',
  stale: 'out of date',
  error: 'failed',
};

export interface NodeCardProps {
  project: Project;
  node: FlowNode;
  selected: boolean;
  busy: boolean;
  /** Port currently highlighted as a drop target. */
  dropTarget: { nodeId: string; portId: string } | null;
  /** Draw the name and ports only, for a graph too big to draw in full. */
  compact: boolean;
  registerAnchor(key: string, element: HTMLElement | null): void;
  onSelect(nodeId: string): void;
  onOpen(nodeId: string): void;
  onHeaderPointerDown(event: React.PointerEvent, nodeId: string): void;
  onPortPointerDown(event: React.PointerEvent, nodeId: string, portId: string, side: PortSide): void;
  onPortPointerEnter(nodeId: string, portId: string, side: PortSide): void;
  onPortPointerLeave(): void;
}

function PortDot({
  anchor,
  registerAnchor,
}: {
  anchor: string;
  registerAnchor(key: string, element: HTMLElement | null): void;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    registerAnchor(anchor, ref.current);
    return () => registerAnchor(anchor, null);
  }, [anchor, registerAnchor]);
  return <span className="vt-port-dot" ref={ref} />;
}

export const NodeCard = memo(function NodeCard({
  project,
  node,
  selected,
  busy,
  compact,
  dropTarget,
  registerAnchor,
  onSelect,
  onOpen,
  onHeaderPointerDown,
  onPortPointerDown,
  onPortPointerEnter,
  onPortPointerLeave,
}: NodeCardProps): JSX.Element {
  const def = getFlowKind(node.kind);
  const status = flowStatus(project, node);
  const missing = new Set(missingRequiredInputs(project, node).map((port) => port.id));
  const warnings = node.lastRun?.warnings?.length ?? 0;

  return (
    <div
      className={[
        'vt-node',
        `cat-${def?.category ?? 'story'}`,
        selected ? 'is-selected' : '',
        busy ? 'is-busy' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ left: node.position.x, top: node.position.y }}
      onPointerDown={() => onSelect(node.id)}
      onDoubleClick={() => onOpen(node.id)}
      role="group"
      aria-label={`${node.name} flow`}
    >
      <div className="vt-node-bar" />
      <div className="vt-node-head" onPointerDown={(event) => onHeaderPointerDown(event, node.id)}>
        <div className="vt-node-kind">{def?.label ?? node.kind}</div>
        <div className="vt-node-name">
          <span>{node.name}</span>
          <span className={`vt-pill is-${status}`} title={STATUS_LABEL[status]}>
            {status === 'ready' ? '●' : status === 'stale' ? '◐' : status === 'error' ? '!' : '○'}
          </span>
        </div>
      </div>

      {compact ? null : (
        <div className="vt-node-summary">{node.notes.trim() ? node.notes : def?.summary}</div>
      )}

      <div className="vt-node-ports">
        <div className="vt-port-col">
          {(def?.inputs ?? []).map((port) => {
            const connected = inputsForPort(project, node.id, port.id).length > 0;
            const isTarget = dropTarget?.nodeId === node.id && dropTarget.portId === port.id;
            return (
              <button
                key={port.id}
                type="button"
                className={[
                  'vt-port',
                  connected ? 'is-connected' : '',
                  port.required ? 'is-required' : '',
                  missing.has(port.id) ? 'is-missing' : '',
                  isTarget ? 'is-target' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-node={node.id}
                data-port={port.id}
                data-side="in"
                title={`${port.label} — accepts ${port.kinds.join(', ')}${port.required ? ' (required)' : ''}\n${port.description}`}
                onPointerDown={(event) => onPortPointerDown(event, node.id, port.id, 'in')}
                onPointerEnter={() => onPortPointerEnter(node.id, port.id, 'in')}
                onPointerLeave={onPortPointerLeave}
              >
                <PortDot anchor={anchorKey(node.id, port.id, 'in')} registerAnchor={registerAnchor} />
                <span>{port.label}</span>
              </button>
            );
          })}
        </div>

        <div className="vt-port-col is-out">
          {(def?.outputs ?? []).map((port) => {
            const artifact = node.outputs.find((ref) => ref.port === port.id);
            return (
              <button
                key={port.id}
                type="button"
                className={['vt-port', 'is-out', artifact ? 'is-connected' : ''].filter(Boolean).join(' ')}
                data-node={node.id}
                data-port={port.id}
                data-side="out"
                title={`${port.label} — ${port.fileName ?? port.kinds.join(', ')}\n${port.description}`}
                onPointerDown={(event) => onPortPointerDown(event, node.id, port.id, 'out')}
                onPointerEnter={() => onPortPointerEnter(node.id, port.id, 'out')}
                onPointerLeave={onPortPointerLeave}
              >
                <PortDot anchor={anchorKey(node.id, port.id, 'out')} registerAnchor={registerAnchor} />
                <span>{port.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {!compact && (node.outputs.length > 0 || warnings > 0 || node.lastRun?.error) && (
        <div className="vt-node-foot">
          {node.outputs.slice(0, 3).map((artifact) => (
            <span key={artifact.port} className="vt-artifact-chip" title={artifact.path}>
              {artifact.fileName}
            </span>
          ))}
          {node.outputs.length > 3 ? (
            <span className="vt-artifact-chip">+{node.outputs.length - 3}</span>
          ) : null}
          {node.lastRun?.error ? (
            <span className="vt-pill is-error">failed</span>
          ) : warnings > 0 ? (
            <span className="vt-pill is-stale" title={node.lastRun?.warnings?.join('\n')}>
              {warnings} warning{warnings === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
});
