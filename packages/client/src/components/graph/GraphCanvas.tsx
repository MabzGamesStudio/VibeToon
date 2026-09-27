import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  findPort,
  flowStatus,
  getFlowKind,
  inputsForPort,
  missingRequiredInputs,
  portsCompatible,
  type Connection,
  type PortRef,
  type Project,
  type Vec2,
} from '@vibetoon/shared';
import { useStudio } from '../../state/store';
import { useView } from '../../state/view';
import {
  boundsOf,
  edgeMidpoint,
  edgePath,
  fitView,
  screenToWorld,
  zoomAround,
  type ViewTransform,
} from './geometry';
import { anchorKey, NodeCard, type NodeChrome, type PortSide } from './NodeCard';

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

/** Card metrics, for fitting the view and for deciding what is on screen. */
const CARD_WIDTH = 232;
const CARD_HEIGHT = 190;

/**
 * Below this many flows everything is drawn, on screen or not: the bookkeeping
 * culling costs is not worth it, and a small graph is never the one that is slow.
 */
const CULL_FROM_NODES = 24;

/**
 * How far outside the viewport a card is still drawn. A whole viewport of slack
 * means a gesture has to travel a screen's width before anything can pop in,
 * and the pan commits below refresh it long before that.
 */
const CULL_MARGIN = 1;

/** How often a gesture tells React where it has got to, for culling only. */
const PAN_COMMIT_MS = 100;

export interface GraphCanvasProps {
  /** Reports the world point at the centre of the viewport, so new flows land in view. */
  onViewportCentre?(point: Vec2): void;
}

/** Everything a card needs to know that costs a walk of the whole project. */
function chromeFor(project: Project): Map<string, NodeChrome> {
  const result = new Map<string, NodeChrome>();
  for (const node of project.nodes) {
    const def = getFlowKind(node.kind);
    result.set(node.id, {
      status: flowStatus(project, node),
      missing: missingRequiredInputs(project, node).map((port) => port.id),
      connected: (def?.inputs ?? [])
        .filter((port) => inputsForPort(project, node.id, port.id).length > 0)
        .map((port) => port.id),
    });
  }
  return result;
}

const EMPTY_CHROME: NodeChrome = { status: 'empty', missing: [], connected: [] };

function offsetKey(kind: string, compact: boolean, portId: string, side: PortSide): string {
  return `${kind}|${compact ? 'c' : 'f'}|${portId}|${side}`;
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
  const { view: prefs } = useView();
  if (!project) throw new Error('GraphCanvas needs an open project');

  const compact = prefs.nodeDetail === 'compact';

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewTransform>({ pan: project.view.pan, zoom: project.view.zoom });
  const [panning, setPanning] = useState(false);
  const [dragNode, setDragNode] = useState<DragNode | null>(null);
  const [dragWire, setDragWire] = useState<DragWire | null>(null);
  const [hoverPort, setHoverPort] = useState<{ nodeId: string; portId: string; side: PortSide } | null>(
    null,
  );
  // Node positions while dragging, so a drag does not hit autosave on every move.
  const [localPositions, setLocalPositions] = useState<Record<string, Vec2>>({});
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  /**
   * The live view, which during a pan or a zoom is ahead of the state above:
   * the gesture writes the transform straight onto the two elements that carry
   * it and only tells React where it ended up. Putting React in that loop meant
   * re-rendering every card on every frame of every pan.
   */
  const viewRef = useRef(view);

  const nodes = useMemo(
    () =>
      project.nodes.map((node) => ({
        ...node,
        position: localPositions[node.id] ?? node.position,
      })),
    [project.nodes, localPositions],
  );
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const chrome = useMemo(() => chromeFor(project), [project]);

  /* ---------------- port anchors ---------------- */

  /**
   * Where a port sits inside its card, by flow kind.
   *
   * Every `Random text` card puts its ports in the same places, so this is a
   * property of the kind and not of the node — worth saying because the obvious
   * version, reading each dot's offset out of the DOM when an edge is drawn,
   * forces the browser to lay the page out again on every frame of a drag. It is
   * measured once per kind instead, and a card's anchors are then arithmetic.
   */
  const portOffsets = useRef(new Map<string, Vec2>());
  const anchorElements = useRef(new Map<string, { element: HTMLElement; kind: string }>());
  const [offsetVersion, setOffsetVersion] = useState(0);
  const measureQueued = useRef(false);

  const measureOffsets = useCallback((): boolean => {
    let learned = false;
    for (const [key, { element, kind }] of anchorElements.current) {
      const [, portId, side] = key.split('|') as [string, string, PortSide];
      const target = offsetKey(kind, compact, portId, side);
      if (portOffsets.current.has(target)) continue;
      // A dot that has not been laid out yet has no size; leave it for the next pass.
      if (element.offsetWidth === 0 && element.offsetHeight === 0) continue;
      portOffsets.current.set(target, {
        x: element.offsetLeft + element.offsetWidth / 2,
        y: element.offsetTop + element.offsetHeight / 2,
      });
      learned = true;
    }
    return learned;
  }, [compact]);

  /**
   * One pass after the frame settles rather than one per dot: a fresh project
   * mounts a few hundred dots, and measuring on each of them was a few hundred
   * renders of the whole canvas.
   */
  const queueMeasure = useCallback(() => {
    if (measureQueued.current) return;
    measureQueued.current = true;
    requestAnimationFrame(() => {
      measureQueued.current = false;
      if (measureOffsets()) setOffsetVersion((current) => current + 1);
    });
  }, [measureOffsets]);

  const registerAnchor = useCallback(
    (key: string, element: HTMLElement | null) => {
      if (element) {
        const nodeId = key.slice(0, key.indexOf('|'));
        const kind = nodesRef.current.find((node) => node.id === nodeId)?.kind;
        if (!kind) return;
        anchorElements.current.set(key, { element, kind });
        const [, portId, side] = key.split('|') as [string, string, PortSide];
        if (!portOffsets.current.has(offsetKey(kind, compact, portId, side))) queueMeasure();
      } else {
        anchorElements.current.delete(key);
      }
    },
    [compact, queueMeasure],
  );

  // A different amount of detail is a different card, so the offsets are stale.
  useEffect(() => {
    portOffsets.current.clear();
    queueMeasure();
  }, [compact, queueMeasure]);

  const anchors = useMemo(() => {
    void offsetVersion;
    const result = new Map<string, Vec2>();
    for (const node of nodes) {
      const def = getFlowKind(node.kind);
      if (!def) continue;
      for (const [side, ports] of [
        ['in', def.inputs],
        ['out', def.outputs],
      ] as const) {
        for (const port of ports) {
          const offset = portOffsets.current.get(offsetKey(node.kind, compact, port.id, side));
          if (!offset) continue;
          result.set(anchorKey(node.id, port.id, side), {
            x: node.position.x + offset.x,
            y: node.position.y + offset.y,
          });
        }
      }
    }
    return result;
  }, [nodes, offsetVersion, compact]);

  /* ---------------- view ---------------- */

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

  /** Write a transform straight onto the DOM, without going through React. */
  const paintView = useCallback((next: ViewTransform) => {
    viewRef.current = next;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate3d(${next.pan.x}px, ${next.pan.y}px, 0) scale(${next.zoom})`;
    }
    if (canvasRef.current) {
      canvasRef.current.style.backgroundSize = `${24 * next.zoom}px ${24 * next.zoom}px`;
      canvasRef.current.style.backgroundPosition = `${next.pan.x}px ${next.pan.y}px`;
    }
  }, []);

  /** Move the view and remember it: for the discrete moves, not for a gesture. */
  const applyView = useCallback(
    (next: ViewTransform) => {
      paintView(next);
      setView(next);
      persistView(next);
    },
    [paintView, persistView],
  );

  /**
   * The transform is painted here after every commit rather than written as an
   * inline style in the markup below. During a gesture the ref is a few frames
   * ahead of the state, and a React commit that wrote the state's value would
   * drag the canvas back to where it was when the last commit was queued.
   */
  useLayoutEffect(() => {
    paintView(viewRef.current);
  });

  const fitToContent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const points = nodesRef.current.flatMap((node) => [
      node.position,
      { x: node.position.x + CARD_WIDTH, y: node.position.y + CARD_HEIGHT },
    ]);
    const bounds = boundsOf(points);
    if (!bounds) return;
    applyView(fitView(bounds, { width: rect.width, height: rect.height }));
  }, [applyView]);

  // Keep the palette's drop point on the middle of what is actually on screen,
  // and the viewport size current for culling. Both read the live view out of
  // the ref, so this is set up once rather than on every frame of a pan.
  const centreRef = useRef(onViewportCentre);
  centreRef.current = onViewportCentre;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const report = () => {
      const rect = canvas.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
      const centre = screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, viewRef.current);
      centreRef.current?.({
        x: Math.round(centre.x - CARD_WIDTH / 2),
        y: Math.round(centre.y - CARD_HEIGHT / 2),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // And again whenever the view settles, so a new flow lands in view after a pan.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onViewportCentre) return;
    const rect = canvas.getBoundingClientRect();
    const centre = screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, view);
    onViewportCentre({
      x: Math.round(centre.x - CARD_WIDTH / 2),
      y: Math.round(centre.y - CARD_HEIGHT / 2),
    });
  }, [onViewportCentre, view]);

  /* ---------------- pointer handling ---------------- */

  const pointerWorld = useCallback((event: { clientX: number; clientY: number }): Vec2 => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return screenToWorld(
      { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) },
      viewRef.current,
    );
  }, []);

  const onCanvasPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Panning starts on empty canvas only; nodes and edges handle their own drags.
      const target = event.target as HTMLElement;
      if (target.closest('.vt-node') || target.closest('.vt-edge')) return;
      if (event.button !== 0 && event.button !== 1) return;
      select({ type: 'none' });
      setPanning(true);
      const start = { x: event.clientX, y: event.clientY };
      const startPan = viewRef.current.pan;
      const zoom = viewRef.current.zoom;
      let lastCommit = 0;

      const move = (moveEvent: PointerEvent) => {
        const next = {
          zoom,
          pan: {
            x: startPan.x + (moveEvent.clientX - start.x),
            y: startPan.y + (moveEvent.clientY - start.y),
          },
        };
        paintView(next);
        // React hears about the pan only often enough to keep culling honest.
        const now = Date.now();
        if (now - lastCommit > PAN_COMMIT_MS) {
          lastCommit = now;
          setView(next);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setPanning(false);
        setView(viewRef.current);
        persistView(viewRef.current);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [paintView, persistView, select],
  );

  /**
   * Wheel zoom paints every notch and tells React on the next frame, so a long
   * scroll is one re-render rather than thirty.
   */
  const zoomCommit = useRef<number | null>(null);
  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      const anchor = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
      const factor = Math.exp(-event.deltaY * 0.0016);
      const next = zoomAround(viewRef.current, anchor, viewRef.current.zoom * factor);
      paintView(next);
      if (zoomCommit.current === null) {
        zoomCommit.current = requestAnimationFrame(() => {
          zoomCommit.current = null;
          setView(viewRef.current);
          persistView(viewRef.current);
        });
      }
    },
    [paintView, persistView],
  );

  useEffect(() => () => {
    if (zoomCommit.current !== null) cancelAnimationFrame(zoomCommit.current);
  }, []);

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      const world = pointerWorld(event);
      const drag: DragNode = {
        nodeId,
        grab: { x: world.x - node.position.x, y: world.y - node.position.y },
        moved: false,
      };
      setDragNode(drag);
      select({ type: 'node', id: nodeId });

      let last: Vec2 | null = null;
      const move = (moveEvent: PointerEvent) => {
        const next = pointerWorld(moveEvent);
        drag.moved = true;
        last = { x: Math.round(next.x - drag.grab.x), y: Math.round(next.y - drag.grab.y) };
        const at = last;
        setLocalPositions((current) => ({ ...current, [nodeId]: at }));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setDragNode(null);
        // Committed here, not inside the state update below: an updater runs
        // during a render, and a project change is another component's state.
        if (last && drag.moved) patchNode(nodeId, { position: last });
        setLocalPositions((current) => {
          const rest = { ...current };
          delete rest[nodeId];
          return rest;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [patchNode, pointerWorld, select],
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

  // Stable so that hovering a port does not re-render every card on the canvas.
  const onSelectNode = useCallback((nodeId: string) => select({ type: 'node', id: nodeId }), [select]);
  const onPortEnter = useCallback(
    (nodeId: string, portId: string, side: PortSide) => setHoverPort({ nodeId, portId, side }),
    [],
  );
  const onPortLeave = useCallback(() => setHoverPort(null), []);

  /* ---------------- keyboard ---------------- */

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const current = selectionRef.current;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (current.type === 'node') {
          const node = projectRef.current?.nodes.find((candidate) => candidate.id === current.id);
          if (node && window.confirm(`Remove “${node.name}” and its connections?`)) removeNode(node.id);
        } else if (current.type === 'connection') {
          removeConnection(current.id);
        }
      }
      if (event.key === 'Enter' && current.type === 'node') focusFlow(current.id);
      if (event.key === 'f') fitToContent();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fitToContent, focusFlow, removeConnection, removeNode]);

  /* ---------------- what to draw ---------------- */

  /**
   * The world rectangle currently on screen, grown by a margin. Only cards and
   * edges that reach into it are drawn, which is what makes a large graph cost
   * the same to pan as a small one.
   */
  const visibleWorld = useMemo(() => {
    if (nodes.length < CULL_FROM_NODES || viewport.width === 0) return null;
    const topLeft = screenToWorld({ x: 0, y: 0 }, view);
    const bottomRight = screenToWorld({ x: viewport.width, y: viewport.height }, view);
    const padX = (bottomRight.x - topLeft.x) * CULL_MARGIN;
    const padY = (bottomRight.y - topLeft.y) * CULL_MARGIN;
    return {
      minX: topLeft.x - padX,
      minY: topLeft.y - padY,
      maxX: bottomRight.x + padX,
      maxY: bottomRight.y + padY,
    };
  }, [nodes.length, view, viewport]);

  const visibleNodes = useMemo(() => {
    if (!visibleWorld) return nodes;
    return nodes.filter(
      (node) =>
        node.position.x + CARD_WIDTH >= visibleWorld.minX &&
        node.position.x <= visibleWorld.maxX &&
        node.position.y + CARD_HEIGHT >= visibleWorld.minY &&
        node.position.y <= visibleWorld.maxY,
    );
  }, [nodes, visibleWorld]);

  const hidden = nodes.length - visibleNodes.length;

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

  const nodeNames = useMemo(
    () => new Map(project.nodes.map((node) => [node.id, node.name])),
    [project.nodes],
  );

  const renderEdge = (connection: Connection): JSX.Element | null => {
    const from = anchors.get(anchorKey(connection.from.nodeId, connection.from.portId, 'out'));
    const to = anchors.get(anchorKey(connection.to.nodeId, connection.to.portId, 'in'));
    if (!from || !to) return null;
    if (
      visibleWorld &&
      (Math.max(from.x, to.x) < visibleWorld.minX ||
        Math.min(from.x, to.x) > visibleWorld.maxX ||
        Math.max(from.y, to.y) < visibleWorld.minY ||
        Math.min(from.y, to.y) > visibleWorld.maxY)
    ) {
      return null;
    }
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
    const path = edgePath(from, to);
    const mid = edgeMidpoint(from, to);
    const ruleCount = connection.rules
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length;

    return (
      <g key={connection.id}>
        <path className={classes} d={path} />
        <path
          className="vt-edge is-hit"
          d={path}
          onPointerDown={(event) => {
            event.stopPropagation();
            select({ type: 'connection', id: connection.id });
          }}
        >
          <title>
            {`${nodeNames.get(connection.from.nodeId) ?? '?'}.${connection.from.portId} → ${
              nodeNames.get(connection.to.nodeId) ?? '?'
            }.${connection.to.portId}`}
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
      onPointerDown={onCanvasPointerDown}
      onWheel={onWheel}
    >
      <div
        ref={worldRef}
        className="vt-canvas-world"
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

        {visibleNodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            chrome={chrome.get(node.id) ?? EMPTY_CHROME}
            selected={selection.type === 'node' && selection.id === node.id}
            busy={busyFlows.includes(node.id)}
            compact={compact}
            dropPortId={
              dragWire && hoverPort && hoverPort.side === 'in' && hoverPort.nodeId === node.id
                ? hoverPort.portId
                : null
            }
            registerAnchor={registerAnchor}
            onSelect={onSelectNode}
            onOpen={focusFlow}
            onHeaderPointerDown={onHeaderPointerDown}
            onPortPointerDown={onPortPointerDown}
            onPortPointerEnter={onPortEnter}
            onPortPointerLeave={onPortLeave}
          />
        ))}
      </div>

      <div className="vt-canvas-hint">
        drag a port to connect · double-click a flow to open its editor · wheel to zoom · F to fit
        {hidden > 0 ? ` · ${hidden} off screen, not drawn` : ''}
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

function canvasCentre(element: HTMLElement | null): Vec2 {
  const rect = element?.getBoundingClientRect();
  return { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
}
