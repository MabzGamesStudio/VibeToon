import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  findPort,
  getFlowKind,
  portsCompatible,
  type Connection,
  type PortRef,
  type Vec2,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import {
  boundsOf,
  clampZoom,
  edgeMidpoint,
  edgePath,
  fitView,
  screenToWorld,
  zoomAround,
  type ViewTransform,
} from './geometry';
import { anchorKey, NodeCard, type PortSide } from './NodeCard';

interface DragNode {
  nodeId: string;
  /** Pointer offset inside the node, in world units. */
  grab: Vec2;
  moved: boolean;
}

interface DragWire {
  from: PortRef;
  side: PortSide;
  cursor: Vec2;
}

const VIEW_SAVE_DELAY_MS = 900;

export interface GraphCanvasProps {
  /** Reports the world point at the centre of the viewport, so new flows land in view. */
  onViewportCentre?(point: Vec2): void;
}

export function GraphCanvas({ onViewportCentre }: GraphCanvasProps = {}): JSX.Element {
  const {
    project,
    selection,
    select,
    focusFlow,
    update,
    patchNode,
    connect,
    removeNode,
    removeConnection,
    busyFlows,
  } = useStudio();
  if (!project) throw new Error('GraphCanvas needs an open project');

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewTransform>({ pan: project.view.pan, zoom: project.view.zoom });
  const [panning, setPanning] = useState(false);
  const [dragNode, setDragNode] = useState<DragNode | null>(null);
  const [dragWire, setDragWire] = useState<DragWire | null>(null);
  const [hoverPort, setHoverPort] = useState<{ nodeId: string; portId: string; side: PortSide } | null>(
    null,
  );
  // Node positions while dragging, so a drag does not hit autosave on every move.
  const [localPositions, setLocalPositions] = useState<Record<string, Vec2>>({});

  const anchorElements = useRef(new Map<string, HTMLElement>());
  const [anchorVersion, setAnchorVersion] = useState(0);

  const registerAnchor = useCallback((key: string, element: HTMLElement | null) => {
    if (element) anchorElements.current.set(key, element);
    else anchorElements.current.delete(key);
    setAnchorVersion((current) => current + 1);
  }, []);

  const nodes = useMemo(
    () =>
      project.nodes.map((node) => ({
        ...node,
        position: localPositions[node.id] ?? node.position,
      })),
    [project.nodes, localPositions],
  );

  /**
   * Port anchors are read from layout: a dot's offset inside its node card plus
   * the node's world position. That keeps edges attached without hard-coding
   * card metrics, and it is independent of the canvas zoom.
   */
  const anchors = useMemo(() => {
    void anchorVersion;
    const result = new Map<string, Vec2>();
    for (const node of nodes) {
      const def = getFlowKind(node.kind);
      if (!def) continue;
      for (const [side, ports] of [
        ['in', def.inputs],
        ['out', def.outputs],
      ] as const) {
        for (const port of ports) {
          const key = anchorKey(node.id, port.id, side);
          const element = anchorElements.current.get(key);
          if (!element) continue;
          result.set(key, {
            x: node.position.x + element.offsetLeft + element.offsetWidth / 2,
            y: node.position.y + element.offsetTop + element.offsetHeight / 2,
          });
        }
      }
    }
    return result;
  }, [nodes, anchorVersion]);

  /* ---------------- view persistence ---------------- */

  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistView = useCallback(
    (next: ViewTransform) => {
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewTimer.current = setTimeout(() => {
        viewTimer.current = null;
        update((draft) => {
          draft.view = { pan: next.pan, zoom: next.zoom };
        });
      }, VIEW_SAVE_DELAY_MS);
    },
    [update],
  );

  useEffect(() => () => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
  }, []);

  const applyView = useCallback(
    (next: ViewTransform) => {
      setView(next);
      persistView(next);
    },
    [persistView],
  );

  const fitToContent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const points = nodes.flatMap((node) => [
      node.position,
      { x: node.position.x + 232, y: node.position.y + 190 },
    ]);
    const bounds = boundsOf(points);
    if (!bounds) return;
    applyView(fitView(bounds, { width: rect.width, height: rect.height }));
  }, [applyView, nodes]);

  // Keep the palette's drop point on the middle of what is actually on screen.
  useEffect(() => {
    if (!onViewportCentre) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const report = () => {
      const rect = canvas.getBoundingClientRect();
      const centre = screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, view);
      onViewportCentre({ x: Math.round(centre.x - 116), y: Math.round(centre.y - 90) });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [onViewportCentre, view]);

  /* ---------------- pointer handling ---------------- */

  const pointerWorld = useCallback(
    (event: { clientX: number; clientY: number }): Vec2 => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const local = {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      };
      return screenToWorld(local, view);
    },
    [view],
  );

  const onCanvasPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Panning starts on empty canvas only; nodes and edges handle their own drags.
      const target = event.target as HTMLElement;
      if (target.closest('.vt-node') || target.closest('.vt-edge')) return;
      if (event.button !== 0 && event.button !== 1) return;
      select({ type: 'none' });
      setPanning(true);
      const start = { x: event.clientX, y: event.clientY };
      const startPan = view.pan;
      const move = (moveEvent: PointerEvent) => {
        setView({
          zoom: view.zoom,
          pan: {
            x: startPan.x + (moveEvent.clientX - start.x),
            y: startPan.y + (moveEvent.clientY - start.y),
          },
        });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setPanning(false);
        setView((current) => {
          persistView(current);
          return current;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [persistView, select, view.pan, view.zoom],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      const anchor = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
      const factor = Math.exp(-event.deltaY * 0.0016);
      applyView(zoomAround(view, anchor, view.zoom * factor));
    },
    [applyView, view],
  );

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      const world = pointerWorld(event);
      const drag: DragNode = {
        nodeId,
        grab: { x: world.x - node.position.x, y: world.y - node.position.y },
        moved: false,
      };
      setDragNode(drag);
      select({ type: 'node', id: nodeId });

      const move = (moveEvent: PointerEvent) => {
        const next = pointerWorld(moveEvent);
        drag.moved = true;
        setLocalPositions((current) => ({
          ...current,
          [nodeId]: {
            x: Math.round(next.x - drag.grab.x),
            y: Math.round(next.y - drag.grab.y),
          },
        }));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setDragNode(null);
        setLocalPositions((current) => {
          const moved = current[nodeId];
          if (moved && drag.moved) patchNode(nodeId, { position: moved });
          const rest = { ...current };
          delete rest[nodeId];
          return rest;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [nodes, patchNode, pointerWorld, select],
  );

  const onPortPointerDown = useCallback(
    (event: React.PointerEvent, nodeId: string, portId: string, side: PortSide) => {
      event.stopPropagation();
      event.preventDefault();
      const start = pointerWorld(event);
      setDragWire({ from: { nodeId, portId }, side, cursor: start });

      const move = (moveEvent: PointerEvent) => {
        setDragWire((current) => (current ? { ...current, cursor: pointerWorld(moveEvent) } : current));
      };
      const up = (upEvent: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const dropped = document
          .elementFromPoint(upEvent.clientX, upEvent.clientY)
          ?.closest('.vt-port') as HTMLElement | null;
        const targetNodeId = dropped?.getAttribute('data-node') ?? undefined;
        const targetPortId = dropped?.getAttribute('data-port') ?? undefined;
        const targetSide = dropped?.getAttribute('data-side') as PortSide | undefined;
        setDragWire(null);
        setHoverPort(null);
        if (!targetNodeId || !targetPortId || !targetSide || targetSide === side) return;
        if (side === 'out') connect({ nodeId, portId }, { nodeId: targetNodeId, portId: targetPortId });
        else connect({ nodeId: targetNodeId, portId: targetPortId }, { nodeId, portId });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [connect, pointerWorld],
  );

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.type === 'node') {
          const node = project.nodes.find((candidate) => candidate.id === selection.id);
          if (node && window.confirm(`Remove “${node.name}” and its connections?`)) removeNode(node.id);
        } else if (selection.type === 'connection') {
          removeConnection(selection.id);
        }
      }
      if (event.key === 'Enter' && selection.type === 'node') focusFlow(selection.id);
      if (event.key === 'f') fitToContent();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fitToContent, focusFlow, project.nodes, removeConnection, removeNode, selection]);

  /* ---------------- edges ---------------- */

  const wireTargetValid = useMemo(() => {
    if (!dragWire || !hoverPort || hoverPort.side === dragWire.side) return false;
    const source = dragWire.side === 'out' ? dragWire.from : { nodeId: hoverPort.nodeId, portId: hoverPort.portId };
    const target = dragWire.side === 'out' ? { nodeId: hoverPort.nodeId, portId: hoverPort.portId } : dragWire.from;
    const sourceNode = project.nodes.find((node) => node.id === source.nodeId);
    const targetNode = project.nodes.find((node) => node.id === target.nodeId);
    if (!sourceNode || !targetNode) return false;
    const fromPort = findPort(sourceNode.kind, source.portId, 'outputs');
    const toPort = findPort(targetNode.kind, target.portId, 'inputs');
    return Boolean(fromPort && toPort && portsCompatible(fromPort, toPort));
  }, [dragWire, hoverPort, project.nodes]);

  const renderEdge = (connection: Connection) => {
    const from = anchors.get(anchorKey(connection.from.nodeId, connection.from.portId, 'out'));
    const to = anchors.get(anchorKey(connection.to.nodeId, connection.to.portId, 'in'));
    if (!from || !to) return null;
    const selected = selection.type === 'connection' && selection.id === connection.id;
    const classes = [
      'vt-edge',
      selected ? 'is-selected' : '',
      connection.settings.enabled ? '' : 'is-disabled',
      connection.settings.mode === 'apply' ? 'is-apply' : '',
      connection.settings.mode === 'reference' ? 'is-reference' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const mid = edgeMidpoint(from, to);
    const ruleCount = connection.rules
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length;

    return (
      <g key={connection.id}>
        <path className={classes} d={edgePath(from, to)} />
        <path
          className="vt-edge is-hit"
          d={edgePath(from, to)}
          onPointerDown={(event) => {
            event.stopPropagation();
            select({ type: 'connection', id: connection.id });
          }}
        >
          <title>
            {`${sourceLabel(project, connection)} → ${targetLabel(project, connection)}`}
          </title>
        </path>
        {ruleCount > 0 ? (
          <text className="vt-edge-label" x={mid.x} y={mid.y - 6} textAnchor="middle">
            {ruleCount} rule{ruleCount === 1 ? '' : 's'}
            {connection.settings.mode === 'apply' ? ' · auto' : ''}
            {connection.settings.enabled ? '' : ' · off'}
          </text>
        ) : null}
      </g>
    );
  };

  useLayoutEffect(() => {
    // The first paint has no anchors yet; nudge once so edges appear.
    setAnchorVersion((current) => current + 1);
  }, [project.nodes.length]);

  return (
    <div
      ref={canvasRef}
      className={[
        'vt-canvas',
        panning ? 'is-panning' : '',
        dragWire ? 'is-connecting' : '',
        dragNode ? 'is-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.pan.x}px ${view.pan.y}px` }}
      onPointerDown={onCanvasPointerDown}
      onWheel={onWheel}
    >
      <div
        className="vt-canvas-world"
        style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}
      >
        <svg className="vt-edges">
          {project.connections.map(renderEdge)}
          {dragWire
            ? (() => {
                const anchor = anchors.get(
                  anchorKey(dragWire.from.nodeId, dragWire.from.portId, dragWire.side),
                );
                if (!anchor) return null;
                const path =
                  dragWire.side === 'out'
                    ? edgePath(anchor, dragWire.cursor)
                    : edgePath(dragWire.cursor, anchor);
                return (
                  <path
                    className={`vt-edge is-pending${wireTargetValid ? ' is-apply' : ''}`}
                    d={path}
                  />
                );
              })()
            : null}
        </svg>

        {nodes.map((node) => (
          <div key={node.id} data-node-wrapper={node.id}>
            <NodeCard
              project={project}
              node={node}
              selected={selection.type === 'node' && selection.id === node.id}
              busy={busyFlows.includes(node.id)}
              dropTarget={
                dragWire && hoverPort && hoverPort.side === 'in'
                  ? { nodeId: hoverPort.nodeId, portId: hoverPort.portId }
                  : null
              }
              registerAnchor={registerAnchor}
              onSelect={(nodeId) => select({ type: 'node', id: nodeId })}
              onOpen={focusFlow}
              onHeaderPointerDown={onHeaderPointerDown}
              onPortPointerDown={onPortPointerDown}
              onPortPointerEnter={(nodeId, portId, side) => setHoverPort({ nodeId, portId, side })}
              onPortPointerLeave={() => setHoverPort(null)}
            />
          </div>
        ))}
      </div>

      <div className="vt-canvas-hint">
        drag a port to connect · double-click a flow to open its editor · wheel to zoom · F to fit
      </div>

      <div className="vt-zoom">
        <button
          type="button"
          className="vt-btn is-small"
          onClick={() => applyView(zoomAround(view, canvasCentre(canvasRef.current), view.zoom / 1.2))}
          aria-label="Zoom out"
        >
          −
        </button>
        <button type="button" className="vt-btn is-small" onClick={() => applyView({ pan: view.pan, zoom: 1 })}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          type="button"
          className="vt-btn is-small"
          onClick={() => applyView(zoomAround(view, canvasCentre(canvasRef.current), view.zoom * 1.2))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" className="vt-btn is-small" onClick={fitToContent}>
          Fit
        </button>
      </div>
    </div>
  );
}

function sourceLabel(project: { nodes: { id: string; name: string }[] }, connection: Connection): string {
  const node = project.nodes.find((candidate) => candidate.id === connection.from.nodeId);
  return `${node?.name ?? '?'}.${connection.from.portId}`;
}

function targetLabel(project: { nodes: { id: string; name: string }[] }, connection: Connection): string {
  const node = project.nodes.find((candidate) => candidate.id === connection.to.nodeId);
  return `${node?.name ?? '?'}.${connection.to.portId}`;
}

function canvasCentre(element: HTMLElement | null): Vec2 {
  const rect = element?.getBoundingClientRect();
  return { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
}

export { clampZoom };
