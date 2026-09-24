import { useEffect, useMemo, useRef, useState } from 'react';
import {
  eventColor,
  eventRange,
  formatPartialTime,
  layoutLanes,
  panView,
  ticksFor,
  zoomView,
  type ColorSetting,
  type TimelineEvent,
  type TimelineView,
  type TimePrecision,
} from '@vibetoon/shared';

const AXIS = 30;
const LANE = 26;
const OVERVIEW = 44;

/** Width of a container, kept up to date. */
function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setWidth(Math.max(200, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** The finest unit worth placing a new event at, for how far in the view is. */
export function precisionForView(view: TimelineView, width: number): TimePrecision {
  const perPixel = (view.to - view.from) / Math.max(1, width);
  if (perPixel > 20 * 86_400_000) return 'year';
  if (perPixel > 86_400_000) return 'month';
  if (perPixel > 3_600_000) return 'day';
  if (perPixel > 60_000) return 'hour';
  if (perPixel > 1000) return 'minute';
  return 'second';
}

/**
 * The whole span, small, with the part in view marked — the global preview.
 *
 * Drag the marked part to move the view, drag its edges to widen or narrow it,
 * click anywhere else to jump there. Every event is a tick in its color, so a
 * cluster of them far off to one side is visible without zooming out.
 */
export function TimelineOverview({
  span,
  view,
  events,
  color,
  onView,
}: {
  span: { from: number; to: number };
  view: TimelineView;
  events: TimelineEvent[];
  color: ColorSetting;
  onView(view: TimelineView): void;
}): JSX.Element {
  const [box, width] = useWidth();
  const full = Math.max(1, span.to - span.from);
  const x = (ms: number) => ((ms - span.from) / full) * width;
  const at = (px: number) => span.from + (px / width) * full;
  const drag = useRef<{ mode: 'move' | 'from' | 'to'; startX: number; view: TimelineView } | null>(null);
  const ticks = useMemo(() => ticksFor(span.from, span.to, width, 70), [span.from, span.to, width]);

  const local = (event: React.PointerEvent) => event.clientX - (event.currentTarget as SVGElement).getBoundingClientRect().left;

  return (
    <div className="vt-timeline-overview" ref={box}>
      <svg
        width={width}
        height={OVERVIEW}
        role="slider"
        aria-label="The whole span, with the part in view marked"
        aria-valuemin={span.from}
        aria-valuemax={span.to}
        aria-valuenow={view.from}
        onPointerDown={(event) => {
          const px = local(event);
          const x0 = x(view.from);
          const x1 = x(view.to);
          const mode = Math.abs(px - x0) < 6 ? 'from' : Math.abs(px - x1) < 6 ? 'to' : px > x0 && px < x1 ? 'move' : null;
          if (!mode) {
            // Somewhere else: centre the view there.
            const half = (view.to - view.from) / 2;
            onView(panView(view, at(px) - half - view.from, span));
            return;
          }
          (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
          drag.current = { mode, startX: px, view };
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          if (!held) return;
          const by = ((local(event) - held.startX) / width) * full;
          if (held.mode === 'move') onView(panView(held.view, by, span));
          else if (held.mode === 'from') onView({ from: Math.min(held.view.to - 60_000, Math.max(span.from, held.view.from + by)), to: held.view.to });
          else onView({ from: held.view.from, to: Math.max(held.view.from + 60_000, Math.min(span.to, held.view.to + by)) });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        {ticks.map((tick) => (
          <g key={tick.at}>
            <line className="vt-timeline-grid" x1={x(tick.at)} x2={x(tick.at)} y1={0} y2={OVERVIEW} />
            <text className="vt-timeline-overview-label" x={x(tick.at) + 3} y={OVERVIEW - 4}>
              {tick.label}
            </text>
          </g>
        ))}
        {events.map((event, index) => {
          const range = eventRange(event);
          if (!range) return null;
          const row = index % 3;
          return (
            <rect
              key={event.id}
              x={x(range.from)}
              y={6 + row * 8}
              width={Math.max(2, x(range.to) - x(range.from))}
              height={5}
              rx={1}
              fill={eventColor(event, color)}
              opacity={0.85}
            />
          );
        })}
        <rect
          className="vt-timeline-brush"
          x={x(view.from)}
          y={1}
          width={Math.max(4, x(view.to) - x(view.from))}
          height={OVERVIEW - 2}
        />
      </svg>
    </div>
  );
}

/**
 * The line itself: time across, events in lanes down.
 *
 * Wheel to zoom about the pointer, drag to move along, click an event to open
 * it, double-click an empty stretch to add one there. An event whose time is only
 * partly known is drawn as all the time it could be, faded, with the part it
 * certainly covers solid; one short enough to be a dot is a diamond with its
 * name beside it.
 */
export function TimelineCanvas({
  span,
  view,
  events,
  color,
  selected,
  onView,
  onSelect,
  onAdd,
}: {
  span: { from: number; to: number };
  view: TimelineView;
  events: TimelineEvent[];
  color: ColorSetting;
  selected?: string;
  onView(view: TimelineView): void;
  onSelect(id: string | undefined): void;
  onAdd(at: number, precision: TimePrecision): void;
}): JSX.Element {
  const [box, width] = useWidth();
  const svg = useRef<SVGSVGElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const spanRef = useRef(span);
  spanRef.current = span;
  const length = Math.max(1, view.to - view.from);
  const x = (ms: number) => ((ms - view.from) / length) * width;
  const at = (px: number) => view.from + (px / width) * length;

  // Wheel to zoom about the pointer. Not through React, whose wheel listener is
  // passive and so cannot stop the page scrolling underneath.
  useEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      const left = element.getBoundingClientRect().left;
      const pointer = current.from + ((event.clientX - left) / width) * (current.to - current.from);
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        onView(panView(current, (event.deltaX / width) * (current.to - current.from), spanRef.current));
      } else {
        onView(zoomView(current, event.deltaY < 0 ? 1 / 1.25 : 1.25, pointer, spanRef.current));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [width, onView]);

  const drag = useRef<{ x: number; view: TimelineView; moved: boolean } | null>(null);

  const placed = useMemo(() => {
    const items: Array<{
      event: TimelineEvent;
      x0: number;
      x1: number;
      sure: { x0: number; x1: number } | null;
      point: boolean;
      extent: { id: string; x0: number; x1: number };
    }> = [];
    for (const event of events) {
      const range = eventRange(event);
      if (!range || range.to < view.from - length || range.from > view.to + length) continue;
      const x0 = x(range.from);
      const x1 = x(range.to);
      const point = x1 - x0 < 10;
      const label = Math.min(220, 7 * event.title.length + 12);
      const extent = point
        ? { id: event.id, x0: (x0 + x1) / 2 - 7, x1: (x0 + x1) / 2 + 10 + label }
        : { id: event.id, x0, x1: Math.max(x1, x0 + label + 8) };
      items.push({
        event,
        x0,
        x1,
        sure: range.sure ? { x0: x(range.sure.from), x1: x(range.sure.to) } : null,
        point,
        extent,
      });
    }
    const lanes = layoutLanes(items.map((item) => item.extent));
    return { items, lanes, count: Math.max(1, ...[...lanes.values()].map((lane) => lane + 1)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, view.from, view.to, width]);

  const height = AXIS + placed.count * LANE + 16;
  const ticks = ticksFor(view.from, view.to, width);
  const now = Date.now();

  return (
    <div className="vt-timeline-canvas" ref={box}>
      <svg
        ref={svg}
        width={width}
        height={Math.max(220, height)}
        className={drag.current ? 'is-dragging' : ''}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, view, moved: false };
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          if (!held) return;
          const dx = event.clientX - held.x;
          if (Math.abs(dx) > 3) held.moved = true;
          if (held.moved) onView(panView(held.view, (-dx / width) * (held.view.to - held.view.from), span));
        }}
        onPointerUp={(event) => {
          const held = drag.current;
          drag.current = null;
          if (held && !held.moved && event.target === event.currentTarget) onSelect(undefined);
        }}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const left = (event.currentTarget as SVGElement).getBoundingClientRect().left;
          onAdd(at(event.clientX - left), precisionForView(view, width));
        }}
      >
        {ticks.map((tick) => (
          <g key={tick.at} pointerEvents="none">
            <line
              className={`vt-timeline-grid${tick.major ? ' is-major' : ''}`}
              x1={x(tick.at)}
              x2={x(tick.at)}
              y1={AXIS - 6}
              y2={Math.max(220, height)}
            />
            <text className={`vt-timeline-tick${tick.major ? ' is-major' : ''}`} x={x(tick.at) + 4} y={16}>
              {tick.label}
            </text>
          </g>
        ))}
        {now > view.from && now < view.to ? (
          <g pointerEvents="none">
            <line className="vt-timeline-now" x1={x(now)} x2={x(now)} y1={AXIS - 10} y2={Math.max(220, height)} />
            <text className="vt-timeline-now-label" x={x(now) + 4} y={AXIS - 2}>
              today
            </text>
          </g>
        ) : null}

        {placed.items.map(({ event, x0, x1, sure, point }) => {
          const lane = placed.lanes.get(event.id) ?? 0;
          const y = AXIS + lane * LANE + 4;
          const fill = eventColor(event, color);
          const isSelected = event.id === selected;
          const title = `${event.title} — ${event.end ? `${formatPartialTime(event.start)} – ${formatPartialTime(event.end)}` : formatPartialTime(event.start)}`;
          const select = (pointer: React.PointerEvent) => {
            pointer.stopPropagation();
            onSelect(event.id);
          };
          if (point) {
            const cx = (x0 + x1) / 2;
            return (
              <g key={event.id} className={`vt-timeline-event is-point${isSelected ? ' is-selected' : ''}`} onPointerDown={select}>
                <title>{title}</title>
                {x1 - x0 > 2 ? <rect x={x0} y={y + 3} width={x1 - x0} height={12} fill={fill} opacity={0.3} rx={2} /> : null}
                <path
                  d={`M ${cx} ${y + 2} L ${cx + 7} ${y + 9} L ${cx} ${y + 16} L ${cx - 7} ${y + 9} Z`}
                  fill={fill}
                  strokeDasharray={event.start.circa ? '2 2' : undefined}
                />
                <text x={cx + 11} y={y + 13}>
                  {event.title}
                </text>
              </g>
            );
          }
          return (
            <g key={event.id} className={`vt-timeline-event${isSelected ? ' is-selected' : ''}`} onPointerDown={select}>
              <title>{title}</title>
              {/* All the time it could cover, faded… */}
              <rect x={x0} y={y} width={Math.max(2, x1 - x0)} height={18} rx={4} fill={fill} opacity={sure ? 0.35 : 0.8} strokeDasharray={event.start.circa || event.end?.circa ? '3 2' : undefined} />
              {/* …and the part it certainly covers, solid. */}
              {sure ? <rect x={sure.x0} y={y} width={Math.max(1, sure.x1 - sure.x0)} height={18} rx={3} fill={fill} opacity={0.9} /> : null}
              <text x={Math.max(x0, 0) + 6} y={y + 13}>
                {event.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
