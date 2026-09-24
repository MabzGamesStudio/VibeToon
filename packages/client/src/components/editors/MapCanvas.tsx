import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  catalogueEntry,
  elementAt,
  elementVisibility,
  layerOfElement,
  tierOf,
  type KmRect,
  type MapElement,
  type MapLayer,
  type MapView,
  type PaintKind,
  type WorldMapFlowData,
} from '@vibetoon/shared';
import { MapTiles, TILE, levelFor, levelPixel } from './map/tiles';

export type MapTool = 'select' | 'place' | 'paint' | 'region';

/** What the pointer does, beyond the tool itself. */
export interface MapToolState {
  tool: MapTool;
  /** For `place`: the catalogue id. */
  placing?: string;
  /** For `paint`. */
  paint: PaintKind;
  /** Brush radius in screen pixels, so it feels the same at every zoom. */
  brush: number;
}

const LINE_COLOR: Partial<Record<MapLayer, string>> = {
  water: '#3f7fc4',
  transport: '#f1e6d2',
  structure: '#8d8f99',
  coast: '#d8c89a',
  landform: '#6b5a48',
};

const MARKER_COLOR: Record<MapLayer, string> = {
  settlement: '#2b2426',
  landform: '#5b4a3a',
  water: '#2f6bb0',
  coast: '#b59a58',
  vegetation: '#2f6b3a',
  landuse: '#7a6a3a',
  transport: '#6b5a4a',
  structure: '#4b4d57',
  site: '#8a3a6a',
};

/** Km a pixel, bounded: half a metre up close, and the whole world across 200 pixels far out. */
export function clampPixel(pixel: number, data: WorldMapFlowData): number {
  return Math.max(0.0005, Math.min(Math.max(data.settings.widthKm, data.settings.heightKm) / 200, pixel));
}

export function MapCanvas({
  data,
  view,
  tool,
  onView,
  onSelect,
  onPlace,
  onStroke,
  onRegion,
  onChangeElement,
  onInspect,
}: {
  data: WorldMapFlowData;
  view: MapView;
  tool: MapToolState;
  onView(view: MapView): void;
  onSelect(id: string | undefined): void;
  onPlace(type: string, x: number, y: number, points?: number[]): void;
  /** A paint stroke started or grew. */
  onStroke(stroke: { id?: string; points: number[] }): void;
  onRegion(bounds: KmRect): void;
  onChangeElement(id: string, change: Partial<MapElement>): void;
  onInspect(x: number, y: number): void;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [, setTick] = useState(0);
  const tiles = useRef<MapTiles | null>(null);

  useEffect(() => {
    tiles.current = new MapTiles(() => setTick((tick) => tick + 1));
    return () => tiles.current?.dispose();
  }, []);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: Math.max(200, element.clientWidth), height: Math.max(200, element.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The map as the tiles see it: only what changes the ground.
  useEffect(() => {
    tiles.current?.setSpec(data, data.layers);
  }, [data.settings, data.patches, data.strokes, data.elements, data.layers]);

  const x0 = view.cx - (size.width / 2) * view.pixel;
  const y0 = view.cy - (size.height / 2) * view.pixel;
  const toScreen = useCallback((x: number, y: number) => [(x - x0) / view.pixel, (y - y0) / view.pixel] as const, [x0, y0, view.pixel]);
  const toMap = useCallback((sx: number, sy: number) => ({ x: x0 + sx * view.pixel, y: y0 + sy * view.pixel }), [x0, y0, view.pixel]);

  /* ---------------- the ground ---------------- */

  useEffect(() => {
    const surface = canvas.current;
    const renderer = tiles.current;
    if (!surface || !renderer) return;
    surface.width = size.width;
    surface.height = size.height;
    const context = surface.getContext('2d')!;
    context.fillStyle = '#1b2331';
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingEnabled = true;

    const level = levelFor(view.pixel);
    const span = TILE * levelPixel(level);
    const tx0 = Math.floor(x0 / span);
    const ty0 = Math.floor(y0 / span);
    const tx1 = Math.floor((x0 + size.width * view.pixel) / span);
    const ty1 = Math.floor((y0 + size.height * view.pixel) / span);
    const wanted: Array<{ level: number; tx: number; ty: number; distance: number }> = [];
    const worldTiles = { x: Math.ceil(data.settings.widthKm / span), y: Math.ceil(data.settings.heightKm / span) };

    const drawTile = (tileLevel: number, tx: number, ty: number, crop?: { sx: number; sy: number; sw: number }) => {
      const entry = renderer.get(tileLevel, tx, ty);
      if (!entry) return false;
      const tileSpan = TILE * levelPixel(tileLevel);
      if (crop) {
        const [dx, dy] = toScreen(entry.box.x0 + crop.sx * levelPixel(tileLevel), entry.box.y0 + crop.sy * levelPixel(tileLevel));
        const drawn = (crop.sw * levelPixel(tileLevel)) / view.pixel;
        context.drawImage(entry.canvas, crop.sx, crop.sy, crop.sw, crop.sw, dx, dy, drawn + 0.5, drawn + 0.5);
      } else {
        const [dx, dy] = toScreen(entry.box.x0, entry.box.y0);
        const drawn = tileSpan / view.pixel;
        context.drawImage(entry.canvas, dx, dy, drawn + 0.5, drawn + 0.5);
      }
      return renderer.valid(entry);
    };

    for (let ty = Math.max(0, ty0); ty <= Math.min(ty1, worldTiles.y - 1); ty += 1) {
      for (let tx = Math.max(0, tx0); tx <= Math.min(tx1, worldTiles.x - 1); tx += 1) {
        // Until this tile arrives, the coarser one it sits in, stretched.
        let covered = false;
        for (let up = 1; up <= 5 && !covered; up += 1) {
          const factor = 2 ** up;
          const px = Math.floor(tx / factor);
          const py = Math.floor(ty / factor);
          const part = TILE / factor;
          covered = drawTile(level + up, px, py, { sx: (tx - px * factor) * part, sy: (ty - py * factor) * part, sw: part });
        }
        const fresh = drawTile(level, tx, ty);
        if (!fresh) {
          const cx = (tx + 0.5) * span - view.cx;
          const cy = (ty + 0.5) * span - view.cy;
          wanted.push({ level, tx, ty, distance: cx * cx + cy * cy });
        }
      }
    }
    // The world's edge.
    const [ex, ey] = toScreen(data.settings.widthKm, data.settings.heightKm);
    context.fillStyle = '#1b2331';
    if (ex < size.width) context.fillRect(ex, 0, size.width - ex, size.height);
    if (ey < size.height) context.fillRect(0, ey, size.width, size.height - ey);
    const [sx, sy] = toScreen(0, 0);
    if (sx > 0) context.fillRect(0, 0, sx, size.height);
    if (sy > 0) context.fillRect(0, 0, size.width, sy);

    wanted.sort((a, b) => a.distance - b.distance);
    renderer.want(wanted);
  });

  /* ---------------- pointer ---------------- */

  const [drag, setDrag] = useState<
    | null
    | { kind: 'pan'; sx: number; sy: number; view: MapView; moved: boolean }
    | { kind: 'move'; id: string; sx: number; sy: number; element: MapElement; moved: boolean }
    | { kind: 'resize'; id: string; element: MapElement }
    | { kind: 'rotate'; id: string; element: MapElement }
    | { kind: 'vertex'; id: string; index: number; element: MapElement }
    | { kind: 'paint'; id?: string; points: number[] }
    | { kind: 'region'; from: { x: number; y: number }; to: { x: number; y: number } }
  >(null);
  const [line, setLine] = useState<number[]>([]);
  const [hover, setHover] = useState<{ sx: number; sy: number } | null>(null);
  const placingEntry = tool.placing ? catalogueEntry(tool.placing) : undefined;
  const placingLine = tool.tool === 'place' && placingEntry?.shapes[0] === 'line';

  useEffect(() => {
    setLine([]);
  }, [tool.tool, tool.placing]);

  const local = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top };
  };

  // Wheel to zoom about the pointer, never scrolling the page behind.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const current = viewRef.current;
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const pixel = clampPixel(current.pixel * (event.deltaY < 0 ? 1 / 1.25 : 1.25), data);
      const mx = current.cx + (sx - rect.width / 2) * current.pixel;
      const my = current.cy + (sy - rect.height / 2) * current.pixel;
      onView({ pixel, cx: mx - (sx - rect.width / 2) * pixel, cy: my - (sy - rect.height / 2) * pixel });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [data, onView]);

  const selected = data.elements.find((element) => element.id === data.selected);

  const onDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      const { sx, sy } = local(event);
      setDrag({ kind: 'pan', sx, sy, view, moved: false });
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { sx, sy } = local(event);
    const at = toMap(sx, sy);
    const handle = (event.target as Element).getAttribute('data-handle');
    if (handle && selected) {
      if (handle === 'resize') setDrag({ kind: 'resize', id: selected.id, element: selected });
      else if (handle === 'rotate') setDrag({ kind: 'rotate', id: selected.id, element: selected });
      else if (handle.startsWith('vertex:')) setDrag({ kind: 'vertex', id: selected.id, index: Number(handle.slice(7)), element: selected });
      return;
    }
    if (tool.tool === 'paint') {
      const points = [at.x, at.y];
      setDrag({ kind: 'paint', points });
      onStroke({ points });
      return;
    }
    if (tool.tool === 'region') {
      setDrag({ kind: 'region', from: at, to: at });
      return;
    }
    if (tool.tool === 'place' && tool.placing) {
      if (placingLine) {
        setLine((points) => [...points, at.x, at.y]);
        return;
      }
      onPlace(tool.placing, at.x, at.y);
      return;
    }
    const hit = elementAt(data.elements, at.x, at.y, view.pixel);
    if (hit) {
      onSelect(hit.id);
      setDrag({ kind: 'move', id: hit.id, sx, sy, element: hit, moved: false });
      return;
    }
    setDrag({ kind: 'pan', sx, sy, view, moved: false });
  };

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = local(event);
    setHover(point);
    if (!drag) return;
    const at = toMap(point.sx, point.sy);
    switch (drag.kind) {
      case 'pan': {
        const dx = point.sx - drag.sx;
        const dy = point.sy - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3 && !drag.moved) setDrag({ ...drag, moved: true });
        onView({ ...drag.view, cx: drag.view.cx - dx * drag.view.pixel, cy: drag.view.cy - dy * drag.view.pixel });
        break;
      }
      case 'move': {
        const dx = (point.sx - drag.sx) * view.pixel;
        const dy = (point.sy - drag.sy) * view.pixel;
        if (Math.abs(point.sx - drag.sx) + Math.abs(point.sy - drag.sy) < 3 && !drag.moved) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        onChangeElement(drag.id, {
          x: drag.element.x + dx,
          y: drag.element.y + dy,
          ...(drag.element.points ? { points: drag.element.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) } : {}),
        });
        break;
      }
      case 'resize':
        onChangeElement(drag.id, { size: Math.max(1, Math.round(Math.hypot(at.x - drag.element.x, at.y - drag.element.y) * 2000)) });
        break;
      case 'rotate':
        onChangeElement(drag.id, { rotation: Math.round((Math.atan2(at.x - drag.element.x, -(at.y - drag.element.y)) * 180) / Math.PI) });
        break;
      case 'vertex': {
        const points = [...(drag.element.points ?? [])];
        points[drag.index * 2] = at.x;
        points[drag.index * 2 + 1] = at.y;
        const length = lineLength(points) * 1000;
        onChangeElement(drag.id, { points, x: points[0]!, y: points[1]!, size: Math.max(1, Math.round(length)) });
        break;
      }
      case 'paint': {
        const last = drag.points.length - 2;
        const spacing = tool.brush * view.pixel * 0.35;
        if (Math.hypot(at.x - drag.points[last]!, at.y - drag.points[last + 1]!) < spacing) return;
        const points = [...drag.points, at.x, at.y];
        setDrag({ ...drag, points });
        onStroke({ id: 'current', points });
        break;
      }
      case 'region':
        setDrag({ ...drag, to: at });
        break;
    }
  };

  const onUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    if (drag.kind === 'pan' && !drag.moved && tool.tool === 'select') {
      const { sx, sy } = local(event);
      const at = toMap(sx, sy);
      onSelect(undefined);
      onInspect(at.x, at.y);
    }
    if (drag.kind === 'region') {
      const bounds = {
        x0: Math.min(drag.from.x, drag.to.x),
        y0: Math.min(drag.from.y, drag.to.y),
        x1: Math.max(drag.from.x, drag.to.x),
        y1: Math.max(drag.from.y, drag.to.y),
      };
      if (bounds.x1 - bounds.x0 > view.pixel * 8 && bounds.y1 - bounds.y0 > view.pixel * 8) onRegion(bounds);
    }
    setDrag(null);
  };

  const finishLine = () => {
    if (tool.placing && line.length >= 4) onPlace(tool.placing, line[0]!, line[1]!, line);
    setLine([]);
  };

  useEffect(() => {
    if (!placingLine) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') finishLine();
      if (event.key === 'Escape') setLine([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------------- what is drawn over the ground ---------------- */

  const visible = useMemo(() => {
    const margin = 60 * view.pixel;
    const right = x0 + size.width * view.pixel;
    const bottom = y0 + size.height * view.pixel;
    return data.elements.filter((element) => {
      if (!data.layers.elements) return false;
      if (!elementVisibility(element, view.pixel).drawn && element.id !== data.selected) return false;
      const reach = element.size / 2000 + margin;
      if (element.points && element.points.length >= 4) {
        const xs = element.points.filter((_, index) => index % 2 === 0);
        const ys = element.points.filter((_, index) => index % 2 === 1);
        return Math.max(...xs) >= x0 - margin && Math.min(...xs) <= right + margin && Math.max(...ys) >= y0 - margin && Math.min(...ys) <= bottom + margin;
      }
      return element.x + reach >= x0 && element.x - reach <= right && element.y + reach >= y0 && element.y - reach <= bottom;
    });
  }, [data.elements, data.layers.elements, data.selected, view.pixel, x0, y0, size]);

  /*
   * Names, biggest first, each only where it does not cover one already placed:
   * a country's name wins over a village's, and a village's over a shed's, so
   * the map reads from the scale down whatever the zoom.
   */
  const labels = useMemo(() => {
    if (!data.layers.labels) return [];
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    const out: Array<{ element: MapElement; sx: number; sy: number; size: number; style: string }> = [];
    for (const element of [...visible].sort((a, b) => b.size - a.size)) {
      if (!elementVisibility(element, view.pixel).labelled) continue;
      const tier = tierOf(element.size);
      const layer = layerOfElement(element);
      const big = tier === 'continent' || tier === 'region';
      const fontSize = big ? 15 : layer === 'settlement' && (tier === 'area' || tier === 'district') ? 13 : 11;
      const style = big ? 'is-big' : layer === 'settlement' ? 'is-settlement' : `is-${layer}`;
      let [sx, sy] = toScreen(element.x, element.y);
      if (element.points && element.points.length >= 4) {
        const middle = Math.floor(element.points.length / 4) * 2;
        [sx, sy] = toScreen(element.points[middle]!, element.points[middle + 1]!);
      } else if (layer === 'settlement' || layer === 'structure' || layer === 'site' || catalogueEntry(element.type)?.shapes[0] === 'point') sy -= 9;
      const width = element.name!.length * fontSize * (big ? 0.72 : 0.58);
      const rect = { x0: sx - width / 2, y0: sy - fontSize, x1: sx + width / 2, y1: sy + 3 };
      if (placed.some((other) => rect.x0 < other.x1 && other.x0 < rect.x1 && rect.y0 < other.y1 && other.y0 < rect.y1)) continue;
      placed.push(rect);
      out.push({ element, sx, sy, size: fontSize, style });
    }
    return out;
  }, [visible, data.layers.labels, view.pixel, toScreen]);

  const [bx, by] = toScreen(0, 0);
  const brushRadius = tool.brush;

  return (
    <div className="vt-map-canvas" ref={box}>
      <canvas ref={canvas} />
      <svg
        width={size.width}
        height={size.height}
        className={`vt-map-overlay is-${tool.tool}${drag?.kind === 'pan' && drag.moved ? ' is-panning' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => placingLine && finishLine()}
        onContextMenu={(event) => {
          event.preventDefault();
          if (placingLine) finishLine();
        }}
      >
        {data.layers.regions
          ? data.patches.map((patch) => {
              const [px0, py0] = toScreen(patch.bounds.x0, patch.bounds.y0);
              const [px1, py1] = toScreen(patch.bounds.x1, patch.bounds.y1);
              return (
                <g key={patch.id} className="vt-map-patch">
                  <rect x={px0} y={py0} width={px1 - px0} height={py1 - py0} />
                  <text x={px0 + 4} y={py0 + 13}>
                    {patch.name ?? 'Region'}
                  </text>
                </g>
              );
            })
          : null}

        {visible.map((element) => (
          <ElementMark key={element.id} element={element} pixel={view.pixel} toScreen={toScreen} selected={element.id === data.selected} />
        ))}

        {labels.map(({ element, sx, sy, size: fontSize, style }) => (
          <text key={`label-${element.id}`} className={`vt-map-label ${style}`} x={sx} y={sy} fontSize={fontSize} textAnchor="middle">
            {element.name}
          </text>
        ))}

        {selected ? <Handles element={selected} toScreen={toScreen} pixel={view.pixel} /> : null}

        {line.length >= 2 ? (
          <polyline
            className="vt-map-drafting"
            points={[...chunk(line), ...(hover ? [[toMap(hover.sx, hover.sy).x, toMap(hover.sx, hover.sy).y]] : [])]
              .map(([x, y]) => toScreen(x!, y!).join(','))
              .join(' ')}
          />
        ) : null}

        {drag?.kind === 'region' ? (
          (() => {
            const [ax, ay] = toScreen(drag.from.x, drag.from.y);
            const [cx, cy] = toScreen(drag.to.x, drag.to.y);
            return <rect className="vt-map-region-draft" x={Math.min(ax, cx)} y={Math.min(ay, cy)} width={Math.abs(cx - ax)} height={Math.abs(cy - ay)} />;
          })()
        ) : null}

        {tool.tool === 'paint' && hover ? <circle className="vt-map-brush" cx={hover.sx} cy={hover.sy} r={brushRadius} /> : null}
        {tool.tool === 'place' && hover && placingEntry && !placingLine ? (
          <circle className="vt-map-brush" cx={hover.sx} cy={hover.sy} r={Math.max(4, placingEntry.size / 2000 / view.pixel)} />
        ) : null}

        {/* The world's corner, so it is clear where the map starts. */}
        {bx > 0 || by > 0 ? <rect className="vt-map-edge" x={bx} y={by} width={data.settings.widthKm / view.pixel} height={data.settings.heightKm / view.pixel} /> : null}
      </svg>
    </div>
  );
}

function chunk(points: number[]): number[][] {
  const out: number[][] = [];
  for (let index = 0; index + 1 < points.length; index += 2) out.push([points[index]!, points[index + 1]!]);
  return out;
}

function lineLength(points: number[]): number {
  let total = 0;
  for (let index = 0; index + 3 < points.length; index += 2) {
    total += Math.hypot(points[index + 2]! - points[index]!, points[index + 3]! - points[index + 1]!);
  }
  return total;
}

/** One element over the ground: a line, a footprint, or a marker, by what it is and how big it is on screen. */
function ElementMark({
  element,
  pixel,
  toScreen,
  selected,
}: {
  element: MapElement;
  pixel: number;
  toScreen(x: number, y: number): readonly [number, number];
  selected: boolean;
}): JSX.Element | null {
  const layer = layerOfElement(element);
  const entry = catalogueEntry(element.type);
  const across = element.size / 1000 / pixel;
  const className = `vt-map-element is-${layer}${selected ? ' is-selected' : ''}`;

  if (element.points && element.points.length >= 4) {
    const width = Math.max(layer === 'water' ? 1.2 : 1.5, (element.width ?? 2) / 1000 / pixel);
    const points = chunk(element.points)
      .map(([x, y]) => toScreen(x!, y!).join(','))
      .join(' ');
    return (
      <g className={className}>
        {layer === 'transport' ? <polyline points={points} stroke="#5a4a3a" strokeWidth={width + 2} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
        <polyline points={points} stroke={LINE_COLOR[layer] ?? '#777'} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
  }

  const [sx, sy] = toScreen(element.x, element.y);
  const shape = entry?.shapes[0] ?? 'point';
  // Big broad areas are the ground itself; they are named, not outlined, unless selected.
  if (shape === 'area' && ['water', 'landform', 'vegetation', 'settlement'].includes(layer) && !selected && element.generated !== false) return null;
  if (shape === 'area' && across > 6 && !['water', 'landform'].includes(layer)) {
    return (
      <ellipse
        className={className}
        cx={sx}
        cy={sy}
        rx={across / 2}
        ry={across / 2}
        fill={MARKER_COLOR[layer]}
        fillOpacity={0.18}
        stroke={MARKER_COLOR[layer]}
        strokeDasharray="4 3"
        transform={`rotate(${element.rotation} ${sx} ${sy})`}
      />
    );
  }
  // Close enough to see its footprint: drawn at its real size and angle.
  if ((layer === 'structure' || layer === 'site') && across > 10) {
    return (
      <rect
        className={className}
        x={sx - across / 2}
        y={sy - across / 2}
        width={across}
        height={across}
        rx={2}
        fill={MARKER_COLOR[layer]}
        fillOpacity={0.55}
        stroke="#f4efe6"
        transform={`rotate(${element.rotation} ${sx} ${sy})`}
      />
    );
  }
  if (element.type === 'natural/peak' || element.type === 'geo/mountain' || element.type === 'natural/volcano' || element.type === 'geo/hill') {
    const r = element.type === 'geo/hill' ? 4 : 6;
    return <path className={className} d={`M ${sx} ${sy - r} L ${sx + r} ${sy + r * 0.7} L ${sx - r} ${sy + r * 0.7} Z`} fill={MARKER_COLOR[layer]} stroke="#f4efe6" strokeWidth={1} />;
  }
  const r = layer === 'settlement' ? Math.max(2.5, Math.min(7, 2 + Math.log2(Math.max(1, element.size / 300)))) : 3.5;
  return <circle className={className} cx={sx} cy={sy} r={r} fill={layer === 'settlement' ? '#f8f4ea' : MARKER_COLOR[layer]} stroke={MARKER_COLOR[layer]} strokeWidth={layer === 'settlement' ? 1.8 : 1} />;
}

/** Handles on the selected element: its extent, a grip to resize it, one to turn it, and its points if it is a line. */
function Handles({
  element,
  toScreen,
  pixel,
}: {
  element: MapElement;
  toScreen(x: number, y: number): readonly [number, number];
  pixel: number;
}): JSX.Element {
  if (element.points && element.points.length >= 4) {
    return (
      <g>
        {chunk(element.points).map(([x, y], index) => {
          const [sx, sy] = toScreen(x!, y!);
          return <circle key={index} className="vt-map-handle" data-handle={`vertex:${index}`} cx={sx} cy={sy} r={5} />;
        })}
      </g>
    );
  }
  const [sx, sy] = toScreen(element.x, element.y);
  const radius = Math.max(8, element.size / 2000 / pixel);
  const turn = (element.rotation * Math.PI) / 180;
  return (
    <g>
      <circle className="vt-map-extent" cx={sx} cy={sy} r={radius} />
      <line className="vt-map-extent" x1={sx} y1={sy} x2={sx + Math.sin(turn) * (radius + 18)} y2={sy - Math.cos(turn) * (radius + 18)} />
      <circle className="vt-map-handle" data-handle="resize" cx={sx + radius} cy={sy} r={6}>
        <title>Drag to resize</title>
      </circle>
      <circle className="vt-map-handle is-rotate" data-handle="rotate" cx={sx + Math.sin(turn) * (radius + 18)} cy={sy - Math.cos(turn) * (radius + 18)} r={6}>
        <title>Drag to turn</title>
      </circle>
    </g>
  );
}
