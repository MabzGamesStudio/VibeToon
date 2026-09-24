import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_SIM_SETTINGS,
  SIM_MOTIONS,
  SIM_MOTION_LABEL,
  boneById,
  createSim,
  grabSim,
  pushSim,
  releaseSim,
  restPose,
  simBones,
  stepSim,
  type RigFlowData,
  type RigSim,
  type SimMotion,
  type SimSettings,
} from '@vibetoon/shared';
import { Field } from '../common/Field';
import { Slider } from '../common/Slider';
import { onScreen } from '../common/handles';
import { Stage } from '../common/Stage';

/**
 * The rig, moving.
 *
 * Every limit and stiffness on the rig is a claim about how it will move, and
 * this is where the claim is tested: the skeleton is put under gravity, wind,
 * shoves and a body that sways or bounces, and any joint can be taken hold of
 * and dragged. Changing a setting while it runs changes it in place — the
 * skeleton carries on from where it was — so what a stiffness does is seen as
 * the difference it makes, not remembered from the last run.
 *
 * Nothing here is saved. The rig is only read.
 */
export function RigPreview({
  data,
  selectedId,
  onSelect,
  tools,
}: {
  data: RigFlowData;
  selectedId: string | null;
  onSelect(id: string | null): void;
  tools: ReactNode;
}): JSX.Element {
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SIM_SETTINGS);
  const [playing, setPlaying] = useState(true);
  const [, setFrame] = useState(0);
  const sim = useRef<RigSim | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const svg = useRef<SVGSVGElement | null>(null);
  const [holding, setHolding] = useState<string | null>(null);

  /*
   * A new rig is a new simulation — but one picking up where the last left off,
   * point for point, when the skeleton is the same shape. That is what makes a
   * slider worth moving while it runs: the arm already swinging swings on, and
   * only how it swings changes.
   */
  useEffect(() => {
    const next = createSim(data);
    const last = sim.current;
    if (last && last.particles.length === next.particles.length) {
      next.particles.forEach((particle, at) => {
        const was = last.particles[at]!;
        if (particle.w === 0) return;
        particle.x = was.x;
        particle.y = was.y;
        particle.px = was.px;
        particle.py = was.py;
      });
      next.time = last.time;
      next.anchor = last.anchor;
      next.heldRoot = last.heldRoot;
      next.grabbed = last.grabbed;
    }
    sim.current = next;
    setFrame((frame) => frame + 1);
  }, [data]);

  useEffect(() => {
    if (!playing) return undefined;
    let previous = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      const current = sim.current;
      if (current) {
        stepSim(current, (now - previous) / 1000, settingsRef.current);
        setFrame((frame) => frame + 1);
      }
      previous = now;
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing]);

  /*
   * The frame: the rest pose with room round it to swing, move and hang in.
   * Fixed while previewing, so the skeleton moves across the picture rather than
   * the picture chasing the skeleton.
   */
  const box = useMemo(() => {
    const places = [...restPose(data).values()];
    const xs = places.flatMap((place) => [place.from.x, place.to.x]);
    const ys = places.flatMap((place) => [place.from.y, place.to.y]);
    const size = Math.max(10, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const room = size * 0.45;
    return {
      minX: Math.min(...xs) - room,
      minY: Math.min(...ys) - room,
      width: Math.max(...xs) - Math.min(...xs) + room * 2,
      height: Math.max(...ys) - Math.min(...ys) + room * 2,
    };
    // Rebuilt when bones are added or taken away, not on every limit change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.kind, data.bones.length]);

  const current = sim.current;
  const places = current ? simBones(current) : new Map();
  const baseStroke = Math.max(box.width, box.height) / 220;
  const rootAt = current ? (current.heldRoot ?? current.particles[current.roots[0]!]!) : null;

  const rigPoint = (event: React.PointerEvent) => {
    const surface = svg.current;
    const matrix = surface?.getScreenCTM();
    if (!surface || !matrix) return null;
    const point = surface.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  };

  const take = (id: string, event: React.PointerEvent) => {
    if (event.button !== 0 || event.shiftKey || !current) return;
    // Claimed, or the drag selects the page's text instead of moving the joint.
    event.preventDefault();
    event.stopPropagation();
    svg.current?.setPointerCapture(event.pointerId);
    const at = rigPoint(event);
    if (!at) return;
    grabSim(current, id, at);
    setHolding(id);
    if (id !== 'root') onSelect(id);
  };

  const set = (over: Partial<SimSettings>) => setSettings((was) => ({ ...was, ...over }));
  const push = (x: number, y: number) => {
    if (current) pushSim(current, { x: x * current.height, y: y * current.height });
  };
  const atLimit = current ? [...current.atLimit] : [];
  const atStretch = current ? [...current.atStretch] : [];
  const nameOf = (id: string) => boneById(data, id)?.name ?? id;

  return (
    <>
      <Stage
        zoomable
        title="Preview"
        tools={
          <>
            <span className="vt-faint" style={{ fontSize: 11 }}>
              Drag any joint — or the root — and let go to throw it
            </span>
            {tools}
          </>
        }
      >
        {({ scale }) => {
          const stroke = onScreen(baseStroke, scale);
          return (
            <div className="vt-rig-stage is-preview">
              <svg
                ref={svg}
                className={`vt-rig is-preview${holding ? ' is-dragging' : ''}`}
                viewBox={`${box.minX} ${box.minY} ${box.width} ${box.height}`}
                role="group"
                aria-label="The rig, moving"
                onPointerMove={(event) => {
                  if (!holding || !current) return;
                  const at = rigPoint(event);
                  if (at) grabSim(current, holding, at);
                }}
                onPointerUp={() => {
                  if (current) releaseSim(current);
                  setHolding(null);
                }}
                onPointerCancel={() => {
                  if (current) releaseSim(current);
                  setHolding(null);
                }}
              >
                {[...places].map(([id, place]) => {
                  const bone = boneById(data, id);
                  return (
                    <line
                      key={id}
                      className={[
                        'vt-rig-bone',
                        bone?.chain ? 'is-chained' : '',
                        id === selectedId ? 'is-selected' : '',
                        current?.atStretch.has(id) ? 'is-stretched' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      x1={place.from.x}
                      y1={place.from.y}
                      x2={place.to.x}
                      y2={place.to.y}
                      strokeWidth={stroke * (id === selectedId ? 3 : 2)}
                    />
                  );
                })}
                {[...places].map(([id, place]) => (
                  <circle
                    key={`handle-${id}`}
                    className={`vt-rig-handle${holding === id ? ' is-held' : ''}${
                      current?.atLimit.has(id) ? ' is-at-limit' : ''
                    }`}
                    cx={place.to.x}
                    cy={place.to.y}
                    r={stroke * 2.6}
                    strokeWidth={stroke * 0.7}
                    onPointerDown={(event) => take(id, event)}
                  >
                    <title>{`${nameOf(id)} — drag it`}</title>
                  </circle>
                ))}
                {rootAt ? (
                  <rect
                    className={`vt-rig-root${holding === 'root' ? ' is-held' : ''}`}
                    x={rootAt.x - stroke * 3.5}
                    y={rootAt.y - stroke * 3.5}
                    width={stroke * 7}
                    height={stroke * 7}
                    strokeWidth={stroke * 0.8}
                    onPointerDown={(event) => take('root', event)}
                  >
                    <title>The root — drag it to carry the whole skeleton</title>
                  </rect>
                ) : null}
              </svg>
            </div>
          );
        }}
      </Stage>

      <div className="vt-section">
        <h3>
          <span>Forces</span>
          <span className="vt-row" style={{ gap: 4 }}>
            <button type="button" className="vt-btn is-small" onClick={() => setPlaying(!playing)}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="vt-btn is-small is-ghost"
              onClick={() => {
                sim.current = createSim(data);
                setFrame((frame) => frame + 1);
              }}
            >
              Back to rest
            </button>
          </span>
        </h3>
        <div className="vt-rig-preview-grid">
          <div>
            <Slider
              label="Gravity"
              tip="rigPreview.gravity"
              min={0}
              max={3}
              step={0.05}
              value={settings.gravity}
              format={(value) => (value === 0 ? 'none' : `${value.toFixed(2)} g`)}
              onChange={(gravity) => set({ gravity })}
            />
            <Slider
              label="Wind"
              tip="rigPreview.wind"
              min={-1.5}
              max={1.5}
              step={0.05}
              value={settings.wind}
              format={(value) => (value === 0 ? 'still air' : `${Math.abs(value).toFixed(2)} g ${value < 0 ? '←' : '→'}`)}
              onChange={(wind) => set({ wind })}
            />
            <Slider
              label="Gusts"
              tip="rigPreview.gust"
              value={settings.gust}
              format={(value) => (value === 0 ? 'steady' : `${Math.round(value * 100)}%`)}
              onChange={(gust) => set({ gust })}
            />
            <Slider
              label="Air"
              tip="rigPreview.damping"
              value={settings.damping}
              format={(value) => (value === 0 ? 'none — swings forever' : value.toFixed(2))}
              onChange={(damping) => set({ damping })}
            />
          </div>
          <div>
            <Field label="Movement" tip="rigPreview.motion">
              <select
                value={settings.motion}
                aria-label="Movement"
                onChange={(event) => set({ motion: event.target.value as SimMotion })}
              >
                {SIM_MOTIONS.map((motion) => (
                  <option key={motion} value={motion}>
                    {SIM_MOTION_LABEL[motion]}
                  </option>
                ))}
              </select>
            </Field>
            {settings.motion !== 'still' ? (
              <>
                <Slider
                  label="How far"
                  tip="rigPreview.motionSize"
                  min={0}
                  max={0.6}
                  step={0.01}
                  value={settings.motionSize}
                  format={(value) => `${Math.round(value * 100)}% of its height`}
                  onChange={(motionSize) => set({ motionSize })}
                />
                <Slider
                  label="How fast"
                  tip="rigPreview.motionSpeed"
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={settings.motionSpeed}
                  format={(value) => `${value.toFixed(2)} a second`}
                  onChange={(motionSpeed) => set({ motionSpeed })}
                />
              </>
            ) : null}
            <Field label="A shove">
              <div className="vt-row" style={{ gap: 4 }}>
                <button type="button" className="vt-btn is-small" onClick={() => push(-2, 0)}>
                  ← Left
                </button>
                <button type="button" className="vt-btn is-small" onClick={() => push(0, -2.5)}>
                  ↑ Up
                </button>
                <button type="button" className="vt-btn is-small" onClick={() => push(2, 0)}>
                  Right →
                </button>
              </div>
            </Field>
          </div>
        </div>
        <p className="vt-faint" style={{ fontSize: 11, lineHeight: 1.45, marginTop: 6 }}>
          {atLimit.length > 0
            ? `At a hard stop now (red): ${atLimit.map(nameOf).join(', ')}. `
            : 'No joint is at a hard stop. '}
          {atStretch.length > 0 ? `At the end of their stretch (orange): ${atStretch.map(nameOf).join(', ')}.` : ''}
        </p>
        <div className="vt-hint">
          The rig&rsquo;s own settings — on the left, and on any bone you select — change it while it moves.
          Stiffness is how fast a joint springs back: 1 is about four times a second, 0 not at all. The
          ranges are hard stops.
        </div>
      </div>
    </>
  );
}
