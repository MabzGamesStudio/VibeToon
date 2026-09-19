import { memo, useEffect, useRef } from 'react';
import { getFlowKind, type FlowNode } from '@vibetoon/shared';

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

/**
 * Everything about a card that has to be worked out from the whole project:
 * whether the flow is up to date, which of its required inputs are unwired, and
 * which ports have something on them.
 *
 * It is passed in rather than derived here because deriving it costs a walk of
 * every connection in the project, and a card is re-rendered whenever the graph
 * is panned. The canvas works it out once per project instead, which also means
 * this object keeps its identity across a pan and `memo` below actually holds.
 */
export interface NodeChrome {
  status: string;
  /** Required input ports with nothing wired in. */
  missing: readonly string[];
  /** Input ports with something wired in. */
  connected: readonly string[];
}

export interface NodeCardProps {
  node: FlowNode;
  chrome: NodeChrome;
  selected: boolean;
  busy: boolean;
  /** The input port on *this* node currently highlighted as a drop target. */
  dropPortId: string | null;
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
  node,
  chrome,
  selected,
  busy,
  compact,
  dropPortId,
  registerAnchor,
  onSelect,
  onOpen,
  onHeaderPointerDown,
  onPortPointerDown,
  onPortPointerEnter,
  onPortPointerLeave,
}: NodeCardProps): JSX.Element {
  const def = getFlowKind(node.kind);
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
      // A transform rather than `left`/`top`: moving a card then costs a
      // composite instead of a layout of everything on the canvas.
      style={{ transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)` }}
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
          <span className={`vt-pill is-${chrome.status}`} title={STATUS_LABEL[chrome.status]}>
            {chrome.status === 'ready'
              ? '●'
              : chrome.status === 'stale'
                ? '◐'
                : chrome.status === 'error'
                  ? '!'
                  : '○'}
          </span>
        </div>
      </div>

      {compact ? null : (
        <div className="vt-node-summary">{node.notes.trim() ? node.notes : def?.summary}</div>
      )}

      <div className="vt-node-ports">
        <div className="vt-port-col">
          {(def?.inputs ?? []).map((port) => (
            <button
              key={port.id}
              type="button"
              className={[
                'vt-port',
                chrome.connected.includes(port.id) ? 'is-connected' : '',
                port.required ? 'is-required' : '',
                chrome.missing.includes(port.id) ? 'is-missing' : '',
                dropPortId === port.id ? 'is-target' : '',
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
          ))}
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
